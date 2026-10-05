// HR Manager 서버: 여러 사용자가 접속해 각자 회사 그룹웨어와 중계, 연장근무·조퇴 내역은 서버에 모아 관리자 화면에서 조회
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const tls = require('./tls');
const { GroupwareClient } = require('./groupware');
const vacation = require('./vacation');
const marks = require('./marks');
const credentials = require('./credentials');
const overtimeStore = require('./overtime-store');
const admin = require('./admin');
const { earlyLeaveMemo } = require('./groupware');

const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443); // 실제 서비스 (https)
const PORT = Number(process.env.PORT || 3000); // http: 인증서 설치 안내(/setup) + https 로 이동
const HOST = process.env.HOST || '0.0.0.0'; // 같은 네트워크의 다른 PC에서도 접속 (내 PC만: HOST=127.0.0.1)
const SESSION_COOKIE = 'hrm_sid';
const REMEMBER_COOKIE = 'hrm_remember'; // 이 브라우저의 로그인 정보 저장 토큰

// 세션은 서버 메모리에만 보관: sid → 회사 그룹웨어 클라이언트 (관리자 인증 여부는 client.isAdmin)
const sessions = new Map();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]+)`));
  return m && m[1];
}
const getSid = (req) => getCookie(req, SESSION_COOKIE);

function requireLogin(req, res, next) {
  const client = sessions.get(getSid(req));
  if (!client) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  req.gw = client;
  next();
}

function requireAdmin(req, res, next) {
  requireLogin(req, res, () => {
    if (!req.gw.isAdmin) return res.status(403).json({ success: false, message: '관리자 인증이 필요합니다.' });
    next();
  });
}

const cookies = (res, list) => res.setHeader('Set-Cookie', list);
// https 전용 쿠키 (Secure)
const sessionCookie = (sid) => `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/`;
const rememberCookie = (token) =>
  token ? `${REMEMBER_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000` : `${REMEMBER_COOKIE}=; Secure; Path=/; Max-Age=0`;

// 회사 로그인 → 성공하면 세션 발급 + 연장근무·조퇴 내역을 서버에 동기화(백그라운드)
async function startSession(id, password) {
  const client = new GroupwareClient();
  const result = await client.login(id, password);
  if (!result.success) return result;
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, client);
  syncOvertime(client).catch((e) => console.error(`[sync] ${id} 실패:`, e.message));
  return { success: true, sid, user: client.user };
}

// 로그인 화면용 저장 정보 (이 브라우저에 저장된 것만, 비밀번호는 보내지 않음)
app.get('/api/login-info', (req, res) => res.json({ success: true, ...credentials.info(getCookie(req, REMEMBER_COOKIE)) }));

// remember: 로그인 정보 저장, auto: 자동 로그인, useSaved: 비밀번호 칸이 비어 있으면 이 브라우저에 저장된 비밀번호 사용
app.post('/api/login', async (req, res) => {
  const { id, remember, auto, useSaved } = req.body || {};
  let { password } = req.body || {};
  const token = getCookie(req, REMEMBER_COOKIE);
  try {
    if (!password && useSaved) password = await credentials.savedPassword(token, id);
    if (!id || !password) return res.status(400).json({ success: false, message: 'ID와 비밀번호를 입력하세요.' });
    const result = await startSession(id, password);
    if (!result.success) return res.status(401).json(result);
    let remembered = null;
    if (remember || auto) remembered = await credentials.save(token, id, password, { auto: !!auto });
    else credentials.clear(token);
    cookies(res, [sessionCookie(result.sid), rememberCookie(remembered)]);
    res.json({ success: true, user: result.user, isAdmin: false });
  } catch (e) {
    console.error('login error:', e.message);
    res.status(502).json({ success: false, message: `로그인 실패: ${e.message}` });
  }
});

// 자동 로그인: 이 브라우저에 저장된 정보로 로그인 (자동 로그인이 켜져 있을 때만)
app.post('/api/auto-login', async (req, res) => {
  const token = getCookie(req, REMEMBER_COOKIE);
  const info = credentials.info(token);
  if (!info.auto || !info.hasPassword) return res.status(400).json({ success: false, message: '자동 로그인이 설정되어 있지 않습니다.' });
  try {
    const password = await credentials.savedPassword(token, info.id);
    const result = await startSession(info.id, password);
    if (!result.success) {
      // 비밀번호가 바뀐 경우 등: 자동 로그인 끄고 다시 입력 받기
      await credentials.save(token, info.id, password, { auto: false });
      return res.status(401).json({ ...result, message: `자동 로그인 실패: ${result.message || ''} 비밀번호를 다시 입력하세요.` });
    }
    cookies(res, [sessionCookie(result.sid)]);
    res.json({ success: true, user: result.user, isAdmin: false });
  } catch (e) {
    console.error('auto-login error:', e.message);
    res.status(502).json({ success: false, message: `자동 로그인 실패: ${e.message}` });
  }
});

app.post('/api/logout', (req, res) => {
  sessions.delete(getSid(req));
  cookies(res, [`${SESSION_COOKIE}=; Secure; Max-Age=0; Path=/`]);
  res.json({ success: true });
});

app.get('/api/me', requireLogin, async (req, res) => {
  if (!(await req.gw.isAlive())) {
    sessions.delete(getSid(req));
    return res.status(401).json({ success: false, message: '회사 세션이 만료되었습니다.' });
  }
  res.json({ success: true, user: req.gw.user, isAdmin: !!req.gw.isAdmin });
});

app.get('/api/calendar', requireLogin, async (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: 'month=YYYY-MM' });
  try {
    const { status, data } = await req.gw.calendarWithPunch(month);
    if (status === 401 || !data) {
      sessions.delete(getSid(req));
      return res.status(401).json({ success: false, message: '회사 세션이 만료되었습니다.' });
    }
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('calendar error:', e.message);
    res.status(502).json({ success: false, message: e.message });
  }
});

// 회사 응답을 그대로 전달 (success/code/message/data)
async function relay(req, res, call) {
  try {
    const { status, data } = await call();
    if (status === 401 || !data) {
      sessions.delete(getSid(req));
      return res.status(401).json({ success: false, message: '회사 세션이 만료되었습니다.' });
    }
    res.json(data);
  } catch (e) {
    console.error(`${req.path} error:`, e.message);
    res.status(502).json({ success: false, message: e.message });
  }
}

/* ---------- 연장근무·조퇴 내역 동기화 (사용자별로 서버에 저장) ---------- */

const syncing = new Map(); // 사용자 id → 진행 중인 동기화

// full: 입사월부터 전부 / 아니면 최근 2개월만 받아서 합침 (저장된 게 없거나 예전 형식이면 전부)
function syncOvertime(gw, full = false) {
  const userId = gw.user.id;
  const prev = syncing.get(userId) || Promise.resolve();
  const job = prev
    .catch(() => {})
    .then(async () => {
      const cache = overtimeStore.loadCache(userId);
      const needFull = full || !cache || !Array.isArray(cache.early);
      const fresh = needFull ? await gw.overtimeHistory() : await gw.overtimeRecent(2);
      if (fresh.expired) return fresh;
      const saved = needFull ? overtimeStore.saveFull(userId, gw.user.name, fresh) : overtimeStore.mergeMonths(userId, gw.user.name, fresh);
      console.log(`[sync] ${userId} ${needFull ? '전체' : '최근 2개월'} 연장근무 ${fresh.items.length}건, 조퇴 ${fresh.early.length}건`);
      return saved;
    })
    .finally(() => {
      if (syncing.get(userId) === job) syncing.delete(userId);
    });
  syncing.set(userId, job);
  return job;
}

// 저장된 내역 (동기화 중이면 끝날 때까지 기다림, refresh 면 회사에서 전부 새로) + 소급 처리 반영
async function overtimeData(req, refresh) {
  const userId = req.gw.user.id;
  if (refresh) {
    const r = await syncOvertime(req.gw, true);
    if (r && r.expired) return r;
  } else if (syncing.has(userId)) {
    await syncing.get(userId).catch(() => {});
  }
  let cache = overtimeStore.loadCache(userId);
  if (!cache) {
    const r = await syncOvertime(req.gw, true);
    if (r && r.expired) return r;
    cache = overtimeStore.loadCache(userId);
  }
  return overtimeStore.withStatus(userId, cache);
}

app.get('/api/overtime', requireLogin, (req, res) => handle(req, res, () => overtimeData(req, req.query.refresh === '1')));

// 연장근무 상태 직접 변경 (기록 없는 과거 사용분 소급)
// used=true + usedOn(사용일): 소급 처리 / used=false: 소급 정보 초기화 (조퇴에 사용된 건은 거절)
app.post('/api/overtime/mark', requireLogin, async (req, res) => {
  const key = String((req.body && req.body.key) || '');
  const used = !!(req.body && req.body.used);
  const usedOn = String((req.body && req.body.usedOn) || '');
  try {
    const data = await overtimeData(req, false);
    if (data.expired) {
      sessions.delete(getSid(req));
      return res.status(401).json({ success: false, message: '회사 세션이 만료되었습니다.' });
    }
    const item = data.items.find((o) => o.key === key);
    if (!item) return res.status(404).json({ success: false, message: '연장근무 항목을 찾을 수 없습니다.' });
    if (item.usedBy === 'early') {
      return res.status(409).json({
        success: false,
        code: 'used_by_early',
        message: `${item.usedFor} 조퇴에 사용된 연장근무입니다.\n조퇴에 사용되어 정정신청으로 변경하세요.`,
      });
    }
    if (used) {
      const today = new Date().toLocaleDateString('sv-SE');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(usedOn)) return res.status(400).json({ success: false, message: '사용일을 선택하세요.' });
      if (usedOn < item.date || usedOn > today)
        return res.status(400).json({ success: false, message: `사용일은 ${item.date} ~ ${today} 사이여야 합니다.` });
    }
    marks.setMark(req.gw.user.id, key, used ? usedOn : null);
    console.log(`[overtime] ${key} → ${used ? `사용(소급, ${usedOn})` : '미사용(소급 초기화)'}`);
    res.json({ success: true, ...overtimeStore.withStatus(req.gw.user.id, overtimeStore.loadCache(req.gw.user.id)) });
  } catch (e) {
    console.error('overtime mark error:', e.message);
    res.status(502).json({ success: false, message: e.message });
  }
});

/* ---------- 휴가 신청 ---------- */

// 결과에 expired 가 있으면 세션 만료 처리, 아니면 그대로 전달
async function handle(req, res, call) {
  try {
    const result = await call();
    if (result && result.expired) {
      sessions.delete(getSid(req));
      return res.status(401).json({ success: false, message: '회사 세션이 만료되었습니다.' });
    }
    res.json({ success: true, ...result });
  } catch (e) {
    console.error(`${req.path} error:`, e.message);
    res.status(502).json({ success: false, message: e.message });
  }
}

app.get('/api/vacation/form', requireLogin, (req, res) => handle(req, res, () => vacation.vacationForm(req.gw)));

app.get('/api/vacation/users', requireLogin, (req, res) =>
  handle(req, res, () => vacation.searchUsers(req.gw, String(req.query.keyword || '').slice(0, 50), Number(req.query.page) || 1))
);

// 조직도 (참조자 선택용)
const ORG_ID = /^\d+_\d+$/;
app.get('/api/org/children', requireLogin, (req, res) => {
  const id = String(req.query.id || '');
  if (id && !ORG_ID.test(id)) return res.status(400).json({ success: false, message: '잘못된 부서입니다.' });
  handle(req, res, () => vacation.orgChildren(req.gw, id));
});
app.get('/api/org/members', requireLogin, (req, res) => {
  const id = String(req.query.id || '');
  if (!ORG_ID.test(id)) return res.status(400).json({ success: false, message: '잘못된 부서입니다.' });
  handle(req, res, () => vacation.orgMembers(req.gw, id));
});

app.get('/api/vacation/requests', requireLogin, (req, res) =>
  handle(req, res, () => vacation.myRequests(req.gw, Number(req.query.page) || 1))
);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toPeople = (list) =>
  (Array.isArray(list) ? list : [])
    .map((p) => ({ no: Number(p.no), cn: Number(p.cn) || 0 }))
    .filter((p) => Number.isInteger(p.no) && p.no > 0);

app.post('/api/vacation/request', requireLogin, (req, res) => {
  const b = req.body || {};
  const body = {
    seq: String(b.seq || ''),
    vsCn: Number(b.vsCn) || 0,
    startDate: String(b.startDate || ''),
    endDate: String(b.endDate || ''),
    dayType: ['1', '2', '3'].includes(String(b.dayType)) ? String(b.dayType) : '1',
    approvers: toPeople(b.approvers),
    cc: toPeople(b.cc),
    sequential: b.sequential !== false,
    memo: String(b.memo || '').slice(0, 2000),
    approverMail: b.approverMail !== false,
    referrerMail: b.referrerMail !== false,
  };
  if (!/^\d+_\d+_\d+_\d+$/.test(body.seq)) return res.status(400).json({ success: false, message: '휴가 종류를 선택하세요.' });
  if (!DATE.test(body.startDate) || !DATE.test(body.endDate) || body.startDate > body.endDate)
    return res.status(400).json({ success: false, message: '기간을 확인하세요.' });
  if (!body.approvers.length) return res.status(400).json({ success: false, message: '결재자를 한 명 이상 선택하세요.' });

  console.log(`[vacation] 휴가 신청 ${body.startDate}~${body.endDate} type=${body.dayType} 결재 ${body.approvers.length}명 참조 ${body.cc.length}명`);
  relay(req, res, () => vacation.requestVacation(req.gw, body));
});

app.post('/api/vacation/cancel', requireLogin, (req, res) => {
  const id = Number(req.body && req.body.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
  console.log(`[vacation] 신청 취소 vr_id=${id}`);
  relay(req, res, () => vacation.cancelRequest(req.gw, id, Number(req.body.cn) || 0));
});

// 휴가 합계/사용/잔여만 추려서 전달
app.get('/api/vacation', requireLogin, (req, res) =>
  relay(req, res, async () => {
    const r = await req.gw.vacationInfo();
    const v = r.data && r.data.vacation_information;
    if (!v) return r;
    return {
      status: r.status,
      data: { success: true, total: v.total_day_txt, used: v.days_use_txt, remain: v.days_remaining_txt },
    };
  })
);

app.get('/api/punch/status', requireLogin, (req, res) => relay(req, res, () => req.gw.punchStatus()));

app.post('/api/punch/in', requireLogin, (req, res) => {
  console.log(`[punch] 출근 요청 ${new Date().toLocaleString('ko-KR')}`);
  relay(req, res, () => req.gw.clockIn());
});

app.post('/api/punch/out', requireLogin, (req, res) => {
  const { id, leavingEarly, overtimeDate } = req.body || {};
  let { memo } = req.body || {};
  // 연장근무를 골라 조퇴하면 사유를 정해진 문구로 ("2026년 06월 29일 추가 근무 건에 대한 조퇴")
  const useOvertime = leavingEarly && /^\d{4}-\d{2}-\d{2}$/.test(String(overtimeDate || ''));
  if (useOvertime) memo = earlyLeaveMemo(overtimeDate);
  console.log(`[punch] 퇴근 요청${leavingEarly ? `(조퇴 확정: ${memo})` : ''} ${new Date().toLocaleString('ko-KR')}`);
  relay(req, res, async () => {
    const r = await req.gw.clockOut({ id, memo, leavingEarly: !!leavingEarly });
    // 퇴근(조퇴·연장근무 발생 포함)하면 최근 내역을 서버에 다시 받아 둠
    if (r.data && r.data.success) syncOvertime(req.gw).catch((e) => console.error('[sync] 퇴근 후 실패:', e.message));
    return r;
  });
});

/* ---------- 관리자 ---------- */

// 관리자 인증 / 해제 (세션 단위)
app.post('/api/admin/auth', requireLogin, (req, res) => {
  if (!admin.checkPassword((req.body && req.body.password) || '')) return res.status(401).json({ success: false, message: '비밀번호가 틀립니다.' });
  req.gw.isAdmin = true;
  console.log(`[admin] ${req.gw.user.id} 관리자 인증`);
  res.json({ success: true, isAdmin: true });
});

app.post('/api/admin/release', requireLogin, (req, res) => {
  req.gw.isAdmin = false;
  res.json({ success: true, isAdmin: false });
});

// 비밀번호 변경 (현재 비밀번호 확인 → 인수인계용)
app.post('/api/admin/password', requireLogin, (req, res) => {
  const r = admin.changePassword((req.body && req.body.current) || '', (req.body && req.body.next) || '');
  if (r.success) console.log(`[admin] ${req.gw.user.id} 관리자 비밀번호 변경`);
  res.status(r.success ? 200 : 400).json(r);
});

// 모든 사용자의 연장근무·조퇴 내역 (목록용)
app.get('/api/admin/records', requireAdmin, (req, res) => res.json({ success: true, items: admin.allRecords() }));

// 달력용: 그 달의 연장근무·조퇴만
app.get('/api/admin/calendar', requireAdmin, (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: 'month=YYYY-MM' });
  res.json({ success: true, items: admin.allRecords().filter((r) => r.date.startsWith(month)) });
});

app.get('/api/admin/months', requireAdmin, (req, res) => res.json({ success: true, months: admin.months() }));

// 엑셀 추출: months=2026-09,2026-10 (달마다 시트)
app.get('/api/admin/export', requireAdmin, async (req, res) => {
  const months = String(req.query.months || '')
    .split(',')
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort();
  if (!months.length) return res.status(400).json({ success: false, message: '추출할 달을 선택하세요.' });
  try {
    const buf = await admin.exportExcel(months);
    const name = `연장근무_조퇴_${months.length > 1 ? `${months[0]}_외${months.length - 1}개월` : months[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('export error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---------- 서버 시작: https(서비스) + http(인증서 설치 안내 / https 로 이동) ---------- */

const certs = tls.ensureCerts();

// 다른 PC용 인증서 설치 스크립트 (현재 사용자 저장소에 등록 → 관리자 권한 불필요)
function installScript() {
  const pem = fs.readFileSync(certs.caPath, 'utf8').trim().split(/\r?\n/);
  return [
    '@echo off',
    'chcp 65001 >nul',
    'set "F=%TEMP%\\hr-manager-ca.crt"',
    '(',
    ...pem.map((l) => `echo ${l}`),
    ') > "%F%"',
    'echo HR Manager 사내 인증서를 이 PC에 등록합니다. 확인 창이 뜨면 [예]를 누르세요.',
    'certutil -user -addstore Root "%F%"',
    'del "%F%" >nul 2>nul',
    'echo.',
    'echo 등록이 끝났습니다. 브라우저를 모두 닫았다가 다시 열고 접속하세요.',
    'pause',
    '',
  ].join('\r\n');
}

const setupPage = (httpsUrl) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HR Manager 접속 준비</title><style>
body{font-family:"Malgun Gothic",system-ui,sans-serif;background:#f5f6fa;color:#1b2e4b;margin:0;padding:40px 16px}
.card{max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 4px 24px rgba(27,46,75,.08)}
h1{font-size:20px;margin:0 0 6px}p{line-height:1.7;margin:8px 0}ol{line-height:2;padding-left:20px}
a.btn{display:inline-block;margin:6px 6px 0 0;padding:10px 18px;border-radius:6px;background:#0168fa;color:#fff;text-decoration:none;font-weight:600}
a.btn.sub{background:#fff;color:#0168fa;border:1px solid #0168fa}.muted{color:#8392a5;font-size:13px}</style></head><body><div class="card">
<h1>HR Manager 접속 준비</h1>
<p>HR Manager 는 회사 비밀번호를 안전하게 보내기 위해 <b>https(암호화)</b>로 접속합니다.<br>처음 한 번만 이 PC에 사내 인증서를 등록하세요.</p>
<ol>
<li><a href="/install-ca.cmd">인증서 등록 파일</a>을 받아 실행 → 확인 창에서 <b>[예]</b></li>
<li>브라우저를 모두 닫았다가 다시 열기</li>
<li>아래 버튼으로 접속</li>
</ol>
<a class="btn" href="${httpsUrl}">HR Manager 접속 (https)</a>
<a class="btn sub" href="/ca.crt">인증서 파일만 받기</a>
<p class="muted">등록하지 않아도 접속은 되지만, 브라우저에 "안전하지 않음" 경고가 뜹니다.</p>
</div></body></html>`;

// http: 인증서 안내·다운로드만 직접 응답, 나머지는 https 로 이동
const httpApp = express();
httpApp.get('/ca.crt', (req, res) => res.type('application/x-x509-ca-cert').attachment('hr-manager-ca.crt').send(fs.readFileSync(certs.caPath)));
httpApp.get('/install-ca.cmd', (req, res) => res.type('application/octet-stream').attachment('HR-Manager-인증서-등록.cmd').send(installScript()));
const httpsUrlFor = (req) => `https://${String(req.headers.host || 'localhost').replace(/:\d+$/, '')}:${HTTPS_PORT}`;
httpApp.get('/setup', (req, res) => res.type('html').send(setupPage(httpsUrlFor(req))));
httpApp.use((req, res) => res.redirect(`${httpsUrlFor(req)}${req.originalUrl}`));

// https 에서도 같은 안내 페이지 제공
app.get('/setup', (req, res) => res.type('html').send(setupPage(`https://${req.headers.host}`)));
app.get('/ca.crt', (req, res) => res.type('application/x-x509-ca-cert').attachment('hr-manager-ca.crt').send(fs.readFileSync(certs.caPath)));
app.get('/install-ca.cmd', (req, res) => res.type('application/octet-stream').attachment('HR-Manager-인증서-등록.cmd').send(installScript()));

https.createServer({ key: certs.key, cert: certs.cert }, app).listen(HTTPS_PORT, HOST, () => {
  console.log(`HR Manager: https://localhost:${HTTPS_PORT}`);
  if (HOST === '0.0.0.0') {
    const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
    for (const n of ips) {
      console.log(`  다른 PC에서 접속: https://${n.address}:${HTTPS_PORT}`);
      console.log(`  처음 접속하는 PC는 인증서 등록: http://${n.address}:${PORT}/setup`);
    }
  }
});
http.createServer(httpApp).listen(PORT, HOST);
