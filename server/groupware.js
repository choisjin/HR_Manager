// 회사 그룹웨어(Hanbiro) 클라이언트: 로그인 + 세션 쿠키 유지 + API 호출
const crypto = require('crypto');

const BASE = 'https://gw.linkgenesis.co.kr';

// 로그인 페이지 JS(login2.min.js)에 들어있는 RSA 공개키 (JSEncrypt, PKCS#1 v1.5)
const PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDlOJu6TyygqxfWT7eLtGDwajtN',
  'FOb9I5XRb6khyfD1Yt3YiCgQWMNW649887VGJiGr/L5i2osbl8C9+WJTeucF+S76',
  'xFxdU6jE0NQ+Z+zEdhUTooNRaY5nZiu5PgDB0ED/ZKBUSLKL7eibMxZtMlUDHjm4',
  'gwQco1KRMDSmXSMkDwIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');

function encrypt(text) {
  return crypto
    .publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(text, 'utf8'))
    .toString('base64');
}

// "1시간 7분" → 67, "59분" → 59, "0시간" → 0
function labelToMinutes(label) {
  const s = String(label || '');
  const h = /(\d+)\s*시간/.exec(s);
  const m = /(\d+)\s*분/.exec(s);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const currentMonth = () => ym(new Date().getFullYear(), new Date().getMonth() + 1);

// '2026-01' ~ '2026-03' → ['2026-01', '2026-02', '2026-03']
function monthRange(from, to) {
  const out = [];
  for (let [y, m] = from.split('-').map(Number); ; m++) {
    if (m > 12) { y++; m = 1; }
    const key = ym(y, m);
    if (key > to) break;
    out.push(key);
  }
  return out;
}

// 연장근무 한 건의 고유 키 (날짜 + 시간대)
const overtimeKey = (o) => `${o.date} ${o.range}`;

// 조퇴 사유 문구: "2026년 06월 29일 추가 근무 건에 대한 조퇴"
function earlyLeaveMemo(date) {
  const [y, m, d] = date.split('-');
  return `${y}년 ${m}월 ${d}일 추가 근무 건에 대한 조퇴`;
}

// 지각 사유 문구: "2026년 06월 29일 추가 근무 건에 대한 지각"
function lateMemo(date) {
  const [y, m, d] = date.split('-');
  return `${y}년 ${m}월 ${d}일 추가 근무 건에 대한 지각`;
}

// 조퇴 사유에서 연장근무 발생일 추출 → ['2026-06-29', ...]
function overtimeDatesInMemo(memo) {
  const out = [];
  for (const m of String(memo || '').matchAll(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(추가|연장)\s*근무/g)) {
    out.push(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  }
  return out;
}

// 메모 정리: 근태 정정 시 빈 값이 "[]" 같은 문자열로 저장되는 경우가 있어 빈 메모로 취급
function cleanMemo(memo) {
  const s = String(memo ?? '').trim();
  return /^(\[\s*\]|\{\s*\}|null|undefined)$/i.test(s) ? '' : s;
}

// 동시 요청 수 제한
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

class GroupwareClient {
  constructor() {
    this.cookies = new Map();
    this.dayCache = new Map(); // 지난 날짜의 출퇴근 상세
    this.monthCache = new Map(); // 지난 달 달력
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!value || value === 'deleted') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(path, { method = 'GET', form, multipart } = {}) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${BASE}/ngw/app/`,
      Cookie: this.cookieHeader(),
    };
    // HR 모듈(/nhr/api)은 verify-token 으로 받은 JWT 를 사용
    if (this.hrToken && path.startsWith('/nhr/api/')) headers.Authorization = `Bearer ${this.hrToken}`;
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=utf-8';
      body = new URLSearchParams(form).toString();
    }
    // multipart: [[name, value], ...] 순서 그대로 전송 (Content-Type 은 fetch 가 boundary 포함해 설정)
    if (multipart) {
      body = new FormData();
      for (const [k, v] of multipart) body.append(k, String(v));
    }
    const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
    this.storeCookies(res);
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: null, text };
    }
  }

  async login(id, password) {
    const { data: nonceRes } = await this.request('/ngw/sign/nonce');
    const nonce = nonceRes && nonceRes.nonce;
    const form = nonce
      ? { gw_id: encrypt(`${nonce}:${id}`), gw_pass: encrypt(`${nonce}:${password}`), use_nonce: 'true' }
      : { gw_id: encrypt(id), gw_pass: encrypt(password) };
    Object.assign(form, { keep_logged_in: 0, ip_security: 0, ver: 1 });

    const { data } = await this.request('/ngw/sign/auth', { method: 'POST', form });
    if (!data || !data.success) {
      return { success: false, message: (data && (data.msg || data.message)) || '로그인 실패' };
    }
    await this.verifyHrToken();
    return { success: true };
  }

  // HR 모듈 진입 시 그룹웨어가 호출하는 것과 동일하게 토큰 발급
  async verifyHrToken() {
    const { data } = await this.request('/nhr/api/verify-token', { method: 'POST', form: {} });
    const info = data && data.data;
    if (!info || !info.token) throw new Error('HR 토큰 발급 실패');
    this.hrToken = info.token;
    this.user = { id: info.user.id, no: info.user.no, name: info.user.name };
  }

  // HR API 호출, 토큰 만료(401) 시 재발급 후 1회 재시도
  async hr(path, opts) {
    let res = await this.request(`/nhr/api${path}`, opts);
    if (res.status === 401) {
      await this.verifyHrToken();
      res = await this.request(`/nhr/api${path}`, opts);
    }
    return res;
  }

  calendar(month) {
    return this.hr(`/timecard/user/schedule/calendar?day=${month}-01`);
  }

  // 하루 상세 (실제 출퇴근 시간 real_time, 지각/조퇴 사유 memo)
  async dayPunch(date) {
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
    if (date < today && this.dayCache.has(date)) return this.dayCache.get(date);
    const { data } = await this.hr(`/timecard/user/status/day?day=${date}`);
    const punch = data && data.data && data.data.punch;
    if (!punch) return null;
    const analysis = (data.data && data.data.analysis) || {};
    const pick = (p) =>
      p && p.id != null
        ? { time: p.time, real_time: p.real_time, status: p.status, status_name: p.status_name, status_color: p.status_color, memo: cleanMemo(p.memo) }
        : null;
    const result = { in: pick(punch.in), out: pick(punch.out) };
    // 근태 정정 처리 시 퇴근 real_time 이 정정한 시각(예: 다음날 09:08)으로 덮어써지는 경우가 있음
    // → 인정 퇴근 시간보다 이른 실제시간은 믿지 않고 인정 시간 사용 (정상이면 실제 ≥ 인정)
    if (result.out && result.out.real_time && result.out.time && result.out.real_time < result.out.time) result.out.real_time = result.out.time;
    // 연장근무(분), 조퇴로 부족한 시간(분) - 조퇴한 날만 부족 시간을 계산
    result.overtime = labelToMinutes(analysis.over_time_label);
    result.shortfall = result.out && result.out.status_name === '조퇴' ? labelToMinutes(analysis.work_time_remain_label) : 0;
    if (date < today) this.dayCache.set(date, result);
    return result;
  }

  // 달력 + 출퇴근이 있는 날짜의 상세를 붙여서 반환
  async calendarWithPunch(month) {
    const res = await this.calendar(month);
    const days = res.data && Array.isArray(res.data.data) ? res.data.data : [];
    const targets = days.filter((d) => (d.events || []).some((e) => e.type === 'process'));
    await mapLimit(targets, 6, async (d) => {
      try {
        d.punch = await this.dayPunch(d.date);
      } catch (e) {
        console.error(`day ${d.date} error:`, e.message); // 실패하면 달력 기본 표시 사용
      }
    });
    return res;
  }

  // 지난 달 달력은 바뀌지 않으므로 세션 동안 캐시
  async calendarCached(month) {
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (month < current && this.monthCache.has(month)) return this.monthCache.get(month);
    const res = await this.calendar(month);
    if (month < current && res.status === 200 && res.data) this.monthCache.set(month, res);
    return res;
  }

  // 입사월 (연장근무 내역 시작점). 실패하면 2020-01
  async joinMonth() {
    if (this._joinMonth) return this._joinMonth;
    try {
      const { data } = await this.vacationInfo();
      const join = data && data.vacation_information && data.vacation_information.user_join;
      if (/^\d{4}-\d{2}/.test(join || '')) this._joinMonth = join.slice(0, 7);
    } catch (e) {
      console.error('join month error:', e.message);
    }
    return this._joinMonth || '2020-01';
  }

  // 주어진 달들의 연장근무 + 조퇴 내역 (회사 데이터만)
  // items: 연장근무 { key, date, range, minutes, reason }
  // early: 조퇴 { date, time, minutes(부족 시간), memo, overtimeDates(사유에 적힌 연장근무 발생일) }
  // late: 지각 { date, time, memo, overtimeDates(출근 메모에 적힌 연장근무 발생일) }
  async overtimeMonths(months) {
    const overtimes = [];
    const earlyDays = [];
    const lateDays = [];
    let expired = false;
    await mapLimit(months, 4, async (month) => {
      const { status, data } = await this.calendarCached(month);
      if (status === 401 || !data) { expired = true; return; }
      for (const day of data.data || []) {
        for (const ev of day.events || []) {
          const ot = /^연장근무\s*신청\s*(.+?)\s*\((.+)\)\s*$/.exec(ev.title || '');
          if (ot) overtimes.push({ date: day.date, minutes: labelToMinutes(ot[1]), range: ot[2], reason: cleanMemo(ev.memo) });
          if (ev.type === 'process' && /^조퇴/.test(ev.title || '')) earlyDays.push(day.date);
          if (ev.type === 'process' && /^지각/.test(ev.title || '')) lateDays.push(day.date);
        }
      }
    });
    if (expired) return { expired: true };

    // 연장근무 사유: 달력 항목의 memo, 없으면 그날 퇴근 기록의 memo (퇴근하면서 연장근무를 신청할 때 입력하는 사유)
    await mapLimit(overtimes.filter((o) => !o.reason), 4, async (o) => {
      try {
        const p = await this.dayPunch(o.date);
        o.reason = cleanMemo(p && p.out && p.out.memo);
      } catch (e) {
        console.error(`day ${o.date} error:`, e.message);
      }
    });

    const early = [];
    await mapLimit(earlyDays, 4, async (date) => {
      try {
        const p = await this.dayPunch(date);
        const out = (p && p.out) || {};
        early.push({
          date,
          time: out.real_time || out.time || '',
          minutes: (p && p.shortfall) || 0,
          memo: out.memo || '',
          overtimeDates: overtimeDatesInMemo(out.memo),
        });
      } catch (e) {
        console.error(`day ${date} error:`, e.message);
      }
    });

    const late = [];
    await mapLimit(lateDays, 4, async (date) => {
      try {
        const p = await this.dayPunch(date);
        const inn = (p && p.in) || {};
        late.push({ date, time: inn.real_time || inn.time || '', memo: inn.memo || '', overtimeDates: overtimeDatesInMemo(inn.memo) });
      } catch (e) {
        console.error(`day ${date} error:`, e.message);
      }
    });

    const items = overtimes
      .sort((a, b) => a.date.localeCompare(b.date) || a.range.localeCompare(b.range))
      .map((o) => ({ key: overtimeKey(o), date: o.date, range: o.range, minutes: o.minutes, reason: o.reason }));
    early.sort((a, b) => a.date.localeCompare(b.date));
    late.sort((a, b) => a.date.localeCompare(b.date));
    return { items, early, late };
  }

  // 입사월(또는 fromMonth)부터 이번 달까지 전부
  async overtimeHistory(fromMonth) {
    const from = fromMonth || (await this.joinMonth());
    const months = monthRange(from, currentMonth());
    const res = await this.overtimeMonths(months);
    return res.expired ? res : { from, months, ...res };
  }

  // 최근 n개월만 (로그인·퇴근 때 빠르게 갱신)
  async overtimeRecent(n = 2) {
    const end = currentMonth();
    const [y, m] = end.split('-').map(Number);
    const start = new Date(y, m - n, 1);
    const months = monthRange(ym(start.getFullYear(), start.getMonth() + 1), end);
    const res = await this.overtimeMonths(months);
    return res.expired ? res : { months, ...res };
  }

  // 휴가 정보 (회사 휴가 화면의 합계/승인완료/잔여일수)
  vacationInfo() {
    return this.hr('/holiday/vacation/user_get_vacation');
  }

  punchStatus() {
    return this.hr('/timecard/punch/status');
  }

  // 그룹웨어 화면과 동일한 파라미터: { nightwork: 0 }
  clockIn() {
    return this.hr('/timecard/punch/in', { method: 'POST', form: { nightwork: 0 } });
  }

  // 출근/퇴근 기록에 사유 저장 (지각 사유 등)
  saveMemo(id, memo) {
    return this.hr('/timecard/punch/memo', { method: 'POST', form: { id, memo } });
  }

  // 일반 퇴근: { nightwork, id? } / 조퇴 확정: { id, memo, leaving_early: 1, confirm: 1 }
  clockOut({ id, memo, leavingEarly } = {}) {
    const form = leavingEarly ? { id, memo: memo || '', leaving_early: 1, confirm: 1 } : { nightwork: 0 };
    if (!leavingEarly && id) form.id = id;
    return this.hr('/timecard/punch/out', { method: 'POST', form });
  }

  async isAlive() {
    const { data } = await this.request(`/ngw/sign/session_status?_=${Date.now()}`);
    return !!(data && data.success);
  }

  async get(path) {
    return (await this.request(path)).data;
  }
}

module.exports = { GroupwareClient, earlyLeaveMemo, lateMemo, overtimeKey };
