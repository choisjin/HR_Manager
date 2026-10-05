// HR Manager 프론트엔드
const $ = (sel) => document.querySelector(sel);

const state = {
  month: currentMonth(),
  user: null,
  isAdmin: false, // 관리자 인증됨 (세션 단위)
  adminMode: false, // 관리자 화면 (모든 사용자의 연장근무·조퇴)
};

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month, diff) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + diff, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "#0168FA" → "rgba(1,104,250,0.1)"
function tint(hex, alpha = 0.1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'rgba(134,134,134,0.1)';
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin(data.message);
    throw new Error('unauthorized');
  }
  if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// 로그인 / 세션 확인 응답으로 사용자·관리자 상태 설정 (관리자 모드는 항상 사용자 화면부터)
function setUser(data) {
  state.user = data.user;
  state.isAdmin = !!data.isAdmin;
  state.adminMode = false;
}

/* ---------- 화면 전환 ---------- */

function showLogin(message) {
  $('#calendar-view').hidden = true;
  $('#login-view').hidden = false;
  const err = $('#login-error');
  err.hidden = !message;
  err.textContent = message || '';
  const f = $('#login-form').elements;
  (f.id.value ? f.password : f.id).focus(); // ID가 채워져 있으면 비밀번호 칸으로
}

function showCalendar() {
  $('#login-view').hidden = true;
  $('#calendar-view').hidden = false;
  const u = state.user;
  $('#user-info').innerHTML = u ? `<b>${esc(u.name)}</b> (${esc(u.id)})` : '';
  applyMode();
}

// 사용자 / 관리자 화면 반영 후 데이터 다시 불러오기
function applyMode() {
  if (!state.isAdmin) state.adminMode = false;
  $('#calendar-view').classList.toggle('admin-mode', state.adminMode);
  $('#btn-admin').textContent = state.isAdmin ? '관리자 해제' : '관리자 인증';
  $('#btn-admin').classList.toggle('on', state.isAdmin);
  $('#btn-mode').hidden = !state.isAdmin;
  $('#btn-mode').textContent = state.adminMode ? '관리자 모드' : '사용자 모드';
  $('#btn-mode').classList.toggle('on', state.adminMode);
  $('#btn-export').hidden = !state.adminMode;
  $('#ot-refresh').title = state.adminMode ? '서버에 모인 모든 사용자의 내역을 다시 불러옵니다' : '회사 홈페이지에서 연장근무 내역을 새로 받아옵니다';
  // 화면이 바뀌면 목록 필터 초기화
  Object.assign(otState, { items: [], months: null, statuses: null, names: null, sort: 'date', dir: 'desc' });
  loadMonth();
  loadOvertime();
  if (!state.adminMode) {
    loadPunch();
    loadVacation();
  }
}

/* ---------- 로그인 ---------- */

let loginInfo = { id: '', hasPassword: false, remember: false, auto: false }; // 서버에 저장된 로그인 정보 (비밀번호 제외)
const NO_AUTO_KEY = 'hrm.noAutoLogin'; // 로그아웃한 탭에서는 자동 로그인 안 함

// 저장된 정보로 로그인 화면 채우기
function fillLoginForm() {
  const f = $('#login-form').elements;
  if (loginInfo.id) f.id.value = loginInfo.id;
  f.remember.checked = loginInfo.remember;
  f.auto.checked = loginInfo.auto;
  f.password.placeholder = loginInfo.hasPassword ? '저장된 비밀번호 사용 (바꾸려면 입력)' : '';
}

// 자동 로그인 체크 → 정보 저장도 체크 / 정보 저장 해제 → 자동 로그인도 해제
$('#login-form').elements.auto.addEventListener('change', (e) => e.target.checked && ($('#login-form').elements.remember.checked = true));
$('#login-form').elements.remember.addEventListener('change', (e) => !e.target.checked && ($('#login-form').elements.auto.checked = false));
$('#login-form').elements.id.addEventListener('input', (e) => {
  // 저장된 ID와 다르면 저장된 비밀번호 사용 불가
  $('#login-form').elements.password.placeholder = loginInfo.hasPassword && e.target.value.trim() === loginInfo.id ? '저장된 비밀번호 사용 (바꾸려면 입력)' : '';
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button');
  const id = form.elements.id.value.trim();
  const password = form.elements.password.value;
  const useSaved = !password && loginInfo.hasPassword && id === loginInfo.id;
  if (!id || (!password && !useSaved)) return showLogin('ID와 비밀번호를 입력하세요.');
  btn.disabled = true;
  btn.textContent = '로그인 중…';
  $('#login-error').hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, password, useSaved, remember: form.elements.remember.checked, auto: form.elements.auto.checked }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || '로그인 실패');
    form.elements.password.value = '';
    try {
      sessionStorage.removeItem(NO_AUTO_KEY);
    } catch {}
    setUser(data);
    showCalendar();
  } catch (err) {
    showLogin(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '로그인';
  }
});

$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  try {
    sessionStorage.setItem(NO_AUTO_KEY, '1');
  } catch {}
  state.user = null;
  await refreshLoginInfo();
  showLogin();
});

async function refreshLoginInfo() {
  try {
    const res = await fetch('/api/login-info');
    const data = await res.json();
    if (data.success) loginInfo = data;
  } catch {}
  fillLoginForm();
}

// 자동 로그인 시도 (켜져 있고, 이 탭에서 로그아웃하지 않았을 때)
async function tryAutoLogin() {
  let skip = false;
  try {
    skip = sessionStorage.getItem(NO_AUTO_KEY) === '1';
  } catch {}
  if (!loginInfo.auto || !loginInfo.hasPassword || skip) return false;
  showLogin();
  const btn = $('#login-form button[type=submit]');
  btn.disabled = true;
  btn.textContent = '자동 로그인 중…';
  try {
    const res = await fetch('/api/auto-login', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!data.success) {
      await refreshLoginInfo(); // 실패하면 서버가 자동 로그인을 꺼 둠
      showLogin(data.message || '자동 로그인에 실패했습니다.');
      return true;
    }
    setUser(data);
    showCalendar();
  } catch (e) {
    showLogin(`자동 로그인 실패: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '로그인';
  }
  return true;
}

/* ---------- 달력 ---------- */

$('#prev').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); loadMonth(); });
$('#next').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); loadMonth(); });
$('#today').addEventListener('click', () => { state.month = currentMonth(); loadMonth(); });
$('#refresh').addEventListener('click', () => { loadMonth(); loadPunch(); loadVacation(); loadOvertime(); });

/* ---------- 년월 휠 선택 ---------- */

const ITEM_H = 36;
const picker = { year: 0, month: 0 };

function buildWheel(el, values, fmt) {
  el.innerHTML = values.map((v) => `<div data-v="${v}">${fmt(v)}</div>`).join('');
}

function wheelValue(el) {
  const items = el.children;
  const idx = Math.min(items.length - 1, Math.max(0, Math.round(el.scrollTop / ITEM_H)));
  [...items].forEach((it, i) => it.classList.toggle('sel', i === idx));
  return Number(items[idx].dataset.v);
}

function scrollWheelTo(el, value, smooth) {
  const idx = [...el.children].findIndex((it) => Number(it.dataset.v) === value);
  if (idx >= 0) el.scrollTo({ top: idx * ITEM_H, behavior: smooth ? 'smooth' : 'auto' });
}

function setupWheel(el, key) {
  el.addEventListener('scroll', () => (picker[key] = wheelValue(el)));
  el.addEventListener('click', (e) => {
    const it = e.target.closest('[data-v]');
    if (it) scrollWheelTo(el, Number(it.dataset.v), true);
  });
}

function openPicker() {
  const [y, m] = state.month.split('-').map(Number);
  const nowY = new Date().getFullYear();
  const years = [];
  for (let v = Math.min(y, nowY) - 10; v <= Math.max(y, nowY) + 2; v++) years.push(v);
  buildWheel($('#wheel-year'), years, (v) => `${v}년`);
  buildWheel($('#wheel-month'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], (v) => `${v}월`);
  $('#month-picker').hidden = false;
  scrollWheelTo($('#wheel-year'), y);
  scrollWheelTo($('#wheel-month'), m);
  picker.year = wheelValue($('#wheel-year'));
  picker.month = wheelValue($('#wheel-month'));
}

function closePicker() {
  $('#month-picker').hidden = true;
}

function applyPicker() {
  closePicker();
  const next = `${picker.year}-${String(picker.month).padStart(2, '0')}`;
  if (next !== state.month) {
    state.month = next;
    loadMonth();
  }
}

setupWheel($('#wheel-year'), 'year');
setupWheel($('#wheel-month'), 'month');
$('#period-title').addEventListener('click', () => ($('#month-picker').hidden ? openPicker() : closePicker()));
$('#picker-ok').addEventListener('click', applyPicker);
$('#picker-cancel').addEventListener('click', closePicker);
$('#month-picker').addEventListener('dblclick', (e) => e.target.closest('[data-v]') && setTimeout(applyPicker, 250));
document.addEventListener('keydown', (e) => {
  if ($('#month-picker').hidden) return;
  if (e.key === 'Escape') closePicker();
  if (e.key === 'Enter') applyPicker();
});
document.addEventListener('mousedown', (e) => {
  if (!$('#month-picker').hidden && !e.target.closest('.period-wrap')) closePicker();
});

let loadSeq = 0;
async function loadMonth() {
  const seq = ++loadSeq;
  const month = state.month;
  $('#period-title').textContent = month.replace('-', '.');
  $('#loading').hidden = false;
  try {
    if (state.adminMode) {
      const data = await api(`/api/admin/calendar?month=${month}`);
      if (seq !== loadSeq) return;
      return renderGrid(month, adminDays(data.items || []));
    }
    const data = await api(`/api/calendar?month=${month}`);
    if (seq !== loadSeq) return; // 빠르게 넘긴 경우 마지막 요청만 반영
    renderGrid(month, data.data || []);
    if (data.attr?.period?.period_title) $('#period-title').textContent = data.attr.period.period_title;
  } catch (e) {
    if (e.message !== 'unauthorized') alertInGrid(e.message);
  } finally {
    if (seq === loadSeq) $('#loading').hidden = true;
  }
}

// 관리자 달력: 모든 사용자의 연장근무·조퇴만 (출근·퇴근 표시 없음) → 날짜별 칩
function adminDays(records) {
  const byDate = new Map();
  for (const r of records) {
    const chip =
      r.type === 'ot'
        ? {
            title: `${r.name} 연장 +${fmtMinutes(r.minutes)}`,
            color: '#FD7E14',
            tip: { label: r.name, real: `연장 ${fmtMinutes(r.minutes)}`, status: r.status, note: r.range ? `시간대 ${r.range}` : '', memo: r.reason },
          }
        : {
            title: `${r.name} 조퇴 ${r.time}`,
            color: '#10b759',
            tip: { label: r.name, real: `조퇴 ${r.time}`, note: r.minutes ? `부족 시간 ${fmtMinutes(r.minutes)}` : '', memo: r.reason },
          };
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(chip);
  }
  return [...byDate].map(([date, events]) => ({ date, events }));
}

function alertInGrid(msg) {
  $('#grid').innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center" class="error">${esc(msg)}</div>`;
}

// 근무제("08:30 (+8) - 고정출퇴근제")·근무지("Republic Of Korea (Asia/Seoul)") 항목은 달력에서 숨김
function isScheduleInfo(ev) {
  if (ev.type !== 'schedule') return false;
  return !!ev.raw?.is_schedule_workplace || /^\d{1,2}:\d{2} \(.*\) - /.test(ev.title || '');
}

// 67 → "1시간 7분", 59 → "59분"
function fmtMinutes(min) {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(Math.round(min));
  const h = Math.floor(a / 60);
  const m = a % 60;
  if (!h && !m) return '0분';
  return sign + [h ? `${h}시간` : '', m ? `${m}분` : ''].filter(Boolean).join(' ');
}

// 출퇴근 한 건 → 달력 칩 데이터 ("지각 08:45", "퇴근 17:52")
function punchChip(kind, p, shortfall = 0) {
  const label = kind === 'in' ? '출근' : '퇴근';
  const normal = !p.status_name || p.status_name === '정상';
  const real = p.real_time || p.time;
  const short = kind === 'out' && shortfall > 0 ? ` (-${fmtMinutes(shortfall)})` : '';
  return {
    title: `${normal ? label : p.status_name} ${real}${short}`,
    color: p.status_color || '#0168FA',
    tip: {
      label,
      status: p.status_name,
      real,
      time: p.time,
      memo: p.memo,
      note: short ? `부족 시간 ${fmtMinutes(shortfall)} (연장근무 시간 사용)` : '',
    },
  };
}

// "연장근무 신청 1시간 7분 (17:30~18:37)" → 칩 "연장 +1시간 7분", 툴팁에 시간대
function overtimeChip(ev) {
  const m = /^연장근무\s*신청\s*(.+?)\s*\((.+)\)\s*$/.exec(ev.title || '');
  if (!m) return null;
  return {
    title: `연장 +${m[1]}`,
    color: ev.color || '#FD7E14',
    tip: { label: '연장근무', real: m[1], note: `시간대 ${m[2]}` },
  };
}

function dayEvents(day) {
  const events = (day.events || []).filter((ev) => !isScheduleInfo(ev)).map((ev) => overtimeChip(ev) || ev);
  if (!day.punch) return events;
  // 상세 조회가 된 날은 달력의 보정 시간 대신 실제 시간으로 표시
  const chips = ['in', 'out']
    .filter((k) => day.punch[k])
    .map((k) => punchChip(k, day.punch[k], k === 'out' ? day.punch.shortfall : 0));
  return [...chips, ...events.filter((ev) => ev.type !== 'process')];
}

// "연차휴가 (오전반차)" 같은 휴가 항목 → "오전반차" / "오후반차" / "종일휴가"
function vacationLabel(title) {
  const t = String(title || '');
  if (!/연차|휴가|반차/.test(t)) return null;
  const m = t.replace(/\s+/g, '').match(/오전반차|오후반차|반반차|종일휴가|종일/);
  if (!m) return null;
  return m[0] === '종일' ? '종일휴가' : m[0];
}

// "공휴일 (대체공휴일(개천절))" → "대체공휴일(개천절)" (바깥 괄호 안의 값)
function holidayLabel(ev) {
  const m = /^공휴일\s*\((.*)\)\s*$/.exec(ev.title || '');
  return m ? ev.name || m[1] : null;
}

function renderGrid(month, days) {
  const byDate = new Map(days.map((d) => [d.date, dayEvents(d)]));
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - first.getDay()); // 그 주 일요일부터
  const lastDay = new Date(y, m, 0);
  const weeks = Math.ceil((first.getDay() + lastDay.getDate()) / 7);
  const today = ymd(new Date());

  let html = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = ymd(d);
    const cls = ['cell'];
    if (d.getMonth() !== m - 1) cls.push('other');
    if (d.getDay() === 0) cls.push('sun');
    if (key === today) cls.push('today');
    const events = (byDate.get(key) || [])
      .map((ev) => {
        const color = ev.color || '#868686';
        const style = `background:${tint(color)};border-color:${esc(color)};color:${esc(ev.txt_color || '#1b2e4b')}`;
        if (ev.tip) {
          const memo = ev.tip.memo ? '<span class="memo-dot" aria-label="사유 있음"></span>' : '';
          return `<div class="ev punch-ev" data-tip="${esc(JSON.stringify(ev.tip))}" style="${style}">${esc(ev.title)}${memo}</div>`;
        }
        // 휴가는 종류만 표시, 전체 이름은 마우스를 올리면 보임
        const label = vacationLabel(ev.title) || holidayLabel(ev) || ev.title;
        return `<div class="ev" title="${esc(ev.title)}" style="${style}">${esc(label)}</div>`;
      })
      .join('');
    html += `<div class="${cls.join(' ')}"><span class="date">${d.getDate()}</span>${events}</div>`;
  }
  $('#grid').innerHTML = html;
}

/* ---------- 출퇴근 툴팁 ---------- */

const tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.hidden = true;
document.body.appendChild(tipEl);

function tipHtml(t) {
  const lines = [`<b>${esc(t.label)}</b> ${esc(t.real)}${t.status ? ` <span class="tip-status">${esc(t.status)}</span>` : ''}`];
  if (t.time && t.time !== t.real) lines.push(`<span class="muted">인정 시간 ${esc(t.time)}</span>`);
  if (t.note) lines.push(`<span class="muted">${esc(t.note)}</span>`);
  if (t.memo) lines.push(`<div class="tip-memo">사유: ${esc(t.memo)}</div>`);
  return lines.join('<br>');
}

function showTip(target, tip) {
  tipEl.innerHTML = tipHtml(tip);
  tipEl.hidden = false;
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = r.top - h - 6;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return (tipEl.hidden = true);
  try {
    showTip(el, JSON.parse(el.dataset.tip));
  } catch {
    tipEl.hidden = true;
  }
});
document.addEventListener('scroll', () => (tipEl.hidden = true), true);

/* ---------- 휴가 패널 ---------- */

const row =(label, value, cls = 'c-work') => `<div class="row"><span>${label}</span><span class="${cls}">${esc(value ?? '-')}</span></div>`;

/* ---------- 연차 현황 ---------- */

let vacation = null; // { total, remain } (일 단위 문자열)

function vacationRows() {
  return `${row('전체 휴가', vacation ? vacation.total : '-', 'c-off')}${row('남은 휴가', vacation ? vacation.remain : '-', 'c-off')}`;
}

async function loadVacation() {
  try {
    const res = await api('/api/vacation');
    vacation = parseVacation(res);
  } catch (e) {
    if (e.message === 'unauthorized') return;
    vacation = null;
  }
  const el = $('#vacation-rows');
  if (el) el.innerHTML = vacationRows();
}

// 서버가 { total: "20일", used: "16일", remain: "4일" } 형태로 전달
function parseVacation(res) {
  if (res.total == null && res.remain == null) return null;
  return { total: res.total || '-', remain: res.remain || '-' };
}

/* ---------- 연장근무 내역 ---------- */

// months/statuses/names: 선택된 값의 Set, null 이면 전체 선택
const otState = { items: [], sort: 'date', dir: 'desc', months: null, statuses: null, names: null };
const otStatuses = () => (state.adminMode ? ['미사용', '사용', '조퇴'] : ['미사용', '사용']);
const otCols = () => (state.adminMode ? 4 : 3);
const otEmpty = (html, cls = 'muted') => `<tr><td colspan="${otCols()}" class="${cls} ot-empty">${html}</td></tr>`;

// refresh: 사용자 화면이면 회사 홈페이지에서 새로 받아옴 (입사월부터라 오래 걸림)
//          관리자 화면이면 서버에 모인 모든 사용자의 내역을 다시 불러옴
async function loadOvertime(refresh = false) {
  const btn = $('#ot-refresh');
  if (!otState.items.length) {
    $('#ot-rows').innerHTML = otEmpty(state.adminMode ? '모든 사용자의 내역을 불러오는 중…' : '연장근무 내역을 불러오는 중… (처음엔 시간이 걸립니다)');
  }
  if (refresh && !state.adminMode) {
    btn.disabled = true;
    btn.textContent = '받는 중…';
  }
  try {
    if (state.adminMode) {
      const res = await api('/api/admin/records');
      applyOvertime({ items: res.items, fetchedAt: null });
    } else {
      applyOvertime(await api(`/api/overtime${refresh ? '?refresh=1' : ''}`));
    }
  } catch (e) {
    if (e.message === 'unauthorized') return;
    otState.items = [];
    $('#ot-rows').innerHTML = otEmpty(esc(e.message), 'error');
    $('#ot-totals').innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '새로고침';
  }
}

function applyOvertime(res) {
  otState.items = res.items || [];
  const t = res.fetchedAt ? new Date(res.fetchedAt) : null;
  $('#ot-fetched').textContent = state.adminMode ? '(전체 사용자)' : t ? `${t.getMonth() + 1}/${t.getDate()} ${t.toTimeString().slice(0, 5)} 기준` : '';
  $('#ot-fetched').title = t ? `회사 홈페이지에서 받아온 시각: ${t.toLocaleString('ko-KR')}` : '';
  renderOvertime();
}

$('#ot-refresh').addEventListener('click', () => loadOvertime(true));

// 데이터에 있는 년월을 { 2026: ['2026-01', '2026-09', ...] } 형태로 (최근 년도 먼저)
function otYearMonths() {
  const map = new Map();
  for (const ym of [...new Set(otState.items.map((o) => o.date.slice(0, 7)))].sort()) {
    const y = ym.slice(0, 4);
    if (!map.has(y)) map.set(y, []);
    map.get(y).push(ym);
  }
  return [...map].sort((a, b) => b[0].localeCompare(a[0]));
}

const otNames = () => [...new Set(otState.items.map((o) => o.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));

function renderOvertime() {
  const filtered = otState.items.filter(
    (o) =>
      (!otState.months || otState.months.has(o.date.slice(0, 7))) &&
      (!otState.statuses || otState.statuses.has(o.status)) &&
      (!otState.names || otState.names.has(o.name))
  );

  // 합계는 필터된 목록의 연장근무 기준 (조퇴 줄 제외)
  const ots = filtered.filter((o) => o.type !== 'early');
  const earned = ots.reduce((s, o) => s + o.minutes, 0);
  const used = ots.reduce((s, o) => s + (o.status === '사용' ? o.minutes : 0), 0);
  $('#ot-totals').innerHTML = `
    <div><span>연장근무</span><b class="c-ot">${fmtMinutes(earned)}</b></div>
    <div><span>사용</span><b>${fmtMinutes(used)}</b></div>
    <div><span>잔여</span><b class="c-work">${fmtMinutes(earned - used)}</b></div>`;

  // 정렬/필터가 걸린 열은 ▾ 버튼 강조
  const arrow = otState.dir === 'asc' ? '▲' : '▼';
  document.querySelectorAll('.col-filter').forEach((b) => {
    const col = b.dataset.col;
    const sorted = otState.sort === col;
    const filteredCol = (col === 'date' && otState.months) || (col === 'status' && otState.statuses) || (col === 'name' && otState.names);
    b.classList.toggle('on', !!(sorted || filteredCol));
    b.textContent = sorted ? arrow : '▾';
  });

  const dir = otState.dir === 'asc' ? 1 : -1;
  const rows = filtered.sort((a, b) => {
    const primary =
      otState.sort === 'minutes' ? a.minutes - b.minutes : otState.sort === 'name' ? (a.name || '').localeCompare(b.name || '') : a.date.localeCompare(b.date);
    return (primary || a.date.localeCompare(b.date) || String(a.range || '').localeCompare(String(b.range || ''))) * dir;
  });

  if (!rows.length) {
    $('#ot-rows').innerHTML = otEmpty(otState.items.length ? '조건에 맞는 내역이 없습니다.' : '연장근무 내역이 없습니다.');
    return;
  }
  const cls = { 미사용: 'unused', 사용: 'used', 조퇴: 'early' };
  $('#ot-rows').innerHTML = rows
    .map((o) => {
      const d = new Date(`${o.date}T00:00:00`);
      const dateLabel = `${o.date.slice(2).replace(/-/g, '.')} (${'일월화수목금토'[d.getDay()]})`;
      const early = o.type === 'early';
      const timeLabel = early ? `조퇴 ${esc(o.time || '')}${o.minutes ? ` (-${fmtMinutes(o.minutes)})` : ''}` : fmtMinutes(o.minutes);
      const rowTip = early ? `조퇴${o.reason ? `\n사유: ${o.reason}` : ''}` : `${o.range || ''}${o.reason ? `\n사유: ${o.reason}` : ''}`;
      const badgeCls = `ot-badge ${cls[o.status] || ''}${o.usedBy === 'manual' ? ' manual' : ''}`;
      const label = `${esc(o.status)}${o.usedBy === 'manual' ? '*' : ''}`;
      // 관리자 화면은 보기 전용, 사용자 화면은 상태 버튼(소급 처리)
      const statusCell = state.adminMode
        ? `<span class="${badgeCls}" title="${esc(o.usedOn ? `${o.usedOn} 사용` : '')}">${label}</span>`
        : `<button class="${badgeCls}" data-key="${esc(o.key)}" title="${esc(statusTip(o))}">${label}</button>`;
      return `<tr title="${esc(rowTip)}">
        ${state.adminMode ? `<td>${esc(o.name)}</td>` : ''}
        <td class="num">${dateLabel}</td>
        <td class="num">${timeLabel}</td>
        <td>${statusCell}</td>
      </tr>`;
    })
    .join('');
}

function statusTip(o) {
  if (o.usedBy === 'early') return `${o.usedFor} 조퇴에 사용`;
  if (o.usedBy === 'manual') return `${o.usedOn ? `${o.usedOn} 사용 ` : ''}(소급 처리, 누르면 미사용으로)`;
  return '누르면 사용일을 정해 사용으로 변경 (소급)';
}

// 상태 버튼: 미사용 → 사용(소급), 사용(소급) → 미사용, 조퇴에 사용된 건은 안내만
$('#ot-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-key]');
  if (!btn) return;
  const item = otState.items.find((o) => o.key === btn.dataset.key);
  if (!item) return;
  if (item.usedBy === 'early') {
    return modal({
      title: '변경할 수 없음',
      text: `${item.usedFor} 조퇴에 사용된 연장근무입니다.\n조퇴에 사용되어 정정신청으로 변경하세요.`,
      alert: true,
    });
  }
  let body;
  if (item.usedBy === 'manual') {
    // 소급 처리 취소 → 소급 정보(사용일) 초기화
    const ok = await modal({
      title: '미사용으로 변경',
      text: `${item.date} 연장근무 ${fmtMinutes(item.minutes)}\n소급 정보${item.usedOn ? `(사용일 ${item.usedOn})` : ''}를 지우고 미사용으로 바꿀까요?`,
      okText: '미사용으로',
    });
    if (!ok) return;
    body = { key: item.key, used: false };
  } else {
    const usedOn = await askUsedOn(item);
    if (!usedOn) return;
    body = { key: item.key, used: true, usedOn };
  }
  btn.disabled = true;
  try {
    const res = await fetch('/api/overtime/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return showLogin(data.message);
    if (!data.success) return modal({ title: '변경할 수 없음', text: data.message || '변경하지 못했습니다.', alert: true });
    applyOvertime(data); // 서버가 바뀐 목록을 돌려줌
  } finally {
    btn.disabled = false;
  }
});

// 소급 사용일 선택 (연장근무 발생일 ~ 오늘)
function askUsedOn(item) {
  const dlg = $('#ot-mark');
  const input = $('#ot-mark-date');
  const today = ymd(new Date());
  $('#ot-mark-text').textContent = `${item.date} 연장근무 ${fmtMinutes(item.minutes)}을(를) 언제 사용했는지 선택하세요.`;
  input.min = item.date;
  input.max = today;
  input.value = today;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' && input.value ? input.value : null), { once: true });
  });
}

/* ---------- 엑셀식 열 메뉴 ---------- */

const colMenu = $('#col-menu');
let colMenuFor = null;

function sortItems(col) {
  const on = (d) => (otState.sort === col && otState.dir === d ? ' on' : '');
  const [asc, desc] = { date: ['오래된 날짜순', '최근 날짜순'], name: ['가나다순', '가나다 역순'] }[col] || ['짧은 시간순', '긴 시간순'];
  return `<button class="menu-item${on('asc')}" data-act="sort" data-dir="asc">▲ ${asc}</button>
          <button class="menu-item${on('desc')}" data-act="sort" data-dir="desc">▼ ${desc}</button>`;
}

function checkbox(value, label, checked, extra = '') {
  return `<label ${extra}><input type="checkbox" value="${esc(value)}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;
}

function openColMenu(btn) {
  const col = btn.dataset.col;
  if (colMenuFor === col && !colMenu.hidden) return closeColMenu();
  colMenuFor = col;

  let html = '';
  if (col === 'date' || col === 'minutes' || col === 'name') html += sortItems(col);
  if (col === 'name') {
    const sel = (n) => !otState.names || otState.names.has(n);
    html += '<hr><div class="checks">' + checkbox('__all', '(모두 선택)', !otState.names, 'class="all"');
    for (const n of otNames()) html += checkbox(n, n, sel(n), 'class="child"');
    html += '</div>';
  }
  if (col === 'date') {
    const groups = otYearMonths();
    const sel = (ym) => !otState.months || otState.months.has(ym);
    html += '<hr><div class="checks">' + checkbox('__all', '(모두 선택)', !otState.months, 'class="all"');
    for (const [y, yms] of groups) {
      html += checkbox(`y:${y}`, `${y}년`, yms.every(sel), `class="year" data-year="${y}"`);
      for (const ym of yms) html += checkbox(ym, `${Number(ym.slice(5))}월`, sel(ym), `class="child" data-year="${y}"`);
    }
    html += '</div>';
  }
  if (col === 'status') {
    const sel = (s) => !otState.statuses || otState.statuses.has(s);
    html += '<div class="checks">' + checkbox('__all', '(모두 선택)', !otState.statuses, 'class="all"');
    for (const s of otStatuses()) html += checkbox(s, s, sel(s), 'class="child"');
    html += '</div>';
  }
  if (col !== 'minutes') {
    html += `<div class="menu-buttons">
      <button class="btn-outline" data-act="cancel">취소</button>
      <button class="btn-primary" data-act="ok">확인</button></div>`;
  }
  colMenu.innerHTML = html;
  colMenu.hidden = false;
  syncChecks();

  const r = btn.getBoundingClientRect();
  const w = colMenu.offsetWidth;
  colMenu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  const top = r.bottom + 4;
  colMenu.style.top = `${Math.max(8, top + colMenu.offsetHeight > window.innerHeight - 8 ? r.top - colMenu.offsetHeight - 4 : top)}px`;
}

function closeColMenu() {
  colMenu.hidden = true;
  colMenuFor = null;
}

// 상위 체크박스(모두 선택, 년도) 상태를 하위 체크 상태에 맞춤
function syncChecks() {
  const children = [...colMenu.querySelectorAll('label.child input')];
  if (!children.length) return;
  for (const yl of colMenu.querySelectorAll('label.year')) {
    const kids = children.filter((c) => c.parentElement.dataset.year === yl.dataset.year);
    const n = kids.filter((c) => c.checked).length;
    const input = yl.querySelector('input');
    input.checked = n === kids.length;
    input.indeterminate = n > 0 && n < kids.length;
  }
  const n = children.filter((c) => c.checked).length;
  const all = colMenu.querySelector('label.all input');
  all.checked = n === children.length;
  all.indeterminate = n > 0 && n < children.length;
}

colMenu.addEventListener('change', (e) => {
  const input = e.target;
  const label = input.parentElement;
  const children = [...colMenu.querySelectorAll('label.child input')];
  if (label.classList.contains('all')) children.forEach((c) => (c.checked = input.checked));
  if (label.classList.contains('year'))
    children.filter((c) => c.parentElement.dataset.year === label.dataset.year).forEach((c) => (c.checked = input.checked));
  syncChecks();
});

colMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'sort') {
    otState.sort = colMenuFor;
    otState.dir = btn.dataset.dir;
    closeColMenu();
    renderOvertime();
  } else if (act === 'cancel') {
    closeColMenu();
  } else if (act === 'ok') {
    const children = [...colMenu.querySelectorAll('label.child input')];
    const checked = children.filter((c) => c.checked).map((c) => c.value);
    const sel = checked.length === children.length ? null : new Set(checked); // 전부 선택이면 필터 해제
    if (colMenuFor === 'date') otState.months = sel;
    if (colMenuFor === 'status') otState.statuses = sel;
    if (colMenuFor === 'name') otState.names = sel;
    closeColMenu();
    renderOvertime();
  }
});

document.querySelectorAll('.col-filter').forEach((btn) =>
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openColMenu(btn);
  })
);
document.addEventListener('mousedown', (e) => {
  if (!colMenu.hidden && !colMenu.contains(e.target) && !e.target.closest('.col-filter')) closeColMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !colMenu.hidden) closeColMenu();
});
$('.ot-table-wrap').addEventListener('scroll', closeColMenu);

/* ---------- 오늘 출퇴근 ---------- */

let punch = null; // punch/status 의 data

// alert: true 면 취소 버튼 없이 안내만
function modal({ title, text, input = false, okText = '확인', alert = false }) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-text').textContent = text || '';
  const area = $('#modal-input');
  area.hidden = !input;
  area.value = '';
  dlg.querySelector('button[value=ok]').textContent = okText;
  dlg.querySelector('button[value=cancel]').hidden = alert;
  dlg.showModal();
  if (input) area.focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? (input ? area.value.trim() : true) : null), { once: true });
  });
}

function punchMsg(text, ok) {
  const el = $('#punch-msg');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `punch-msg ${ok ? 'ok' : 'fail'}`;
}

const hasPunch = (p) => !!(p && p.id != null);

function renderPunch() {
  const d = new Date();
  $('#punch-date').textContent = `${d.getMonth() + 1}/${d.getDate()} (${'일월화수목금토'[d.getDay()]})`;
  const sc = punch?.schedule;
  $('#punch-schedule').textContent = sc
    ? sc.vacation
      ? `휴가: ${sc.vacation_name || ''}`
      : `${sc.work_type_name || ''} ${sc.start_time || ''} ~ ${sc.end_time || ''}`
    : '';
  for (const kind of ['in', 'out']) {
    const p = punch?.punch?.[kind];
    const timeEl = $(`#${kind}-time`);
    timeEl.textContent = hasPunch(p) ? p.real_time || p.time : '--:--';
    if (hasPunch(p)) timeEl.dataset.tip = JSON.stringify(punchChip(kind, p).tip);
    else delete timeEl.dataset.tip;
    const badge = $(`#${kind}-status`);
    badge.textContent = hasPunch(p) ? p.status_name || '' : '';
    badge.style.background = hasPunch(p) ? p.status_color || '' : '';
  }
  const clockedIn = hasPunch(punch?.punch?.in);
  $('#btn-in').disabled = !punch || clockedIn;
  $('#btn-out').disabled = !punch || !clockedIn;
}

async function loadPunch() {
  try {
    const res = await api('/api/punch/status');
    punch = res.data || null;
  } catch (e) {
    if (e.message === 'unauthorized') return;
    punch = null;
    punchMsg(`출퇴근 상태 조회 실패: ${e.message}`);
  }
  renderPunch();
}

// 회사 서버 응답 처리: 성공이면 상태 갱신, 특수 코드는 안내
async function afterPunch(res) {
  if (res.data && res.data.punch) {
    punch = { ...punch, ...res.data };
  }
  if (res.success) punchMsg(res.message || '완료되었습니다.', true);
  else punchMsg(res.message || '처리하지 못했습니다.');
  await loadPunch();
  loadMonth();
  loadOvertime();
}

// 버튼 잠금 + 요청
async function punchRequest(path, body) {
  $('#btn-in').disabled = $('#btn-out').disabled = true;
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showLogin(data.message);
      return null;
    }
    return data;
  } catch (e) {
    punchMsg(`요청 실패: ${e.message}`);
    return null;
  } finally {
    renderPunch();
  }
}

$('#btn-in').addEventListener('click', async () => {
  const now = new Date().toTimeString().slice(0, 5);
  if (!(await modal({ title: '출근', text: `지금(${now}) 출근 처리할까요?`, okText: '출근' }))) return;
  const res = await punchRequest('/api/punch/in');
  if (res) await afterPunch(res);
});

const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return h * 60 + (m || 0);
};

// 조퇴 시 사용할 연장근무 고르기 → { mode: 'cancel' | 'none' | 'use', item }
function pickOvertime(shortfall, endTime) {
  const candidates = otState.items
    .filter((o) => o.status === '미사용')
    .sort((a, b) => a.date.localeCompare(b.date) || a.range.localeCompare(b.range));
  // 부족 시간과 가장 비슷한 건 추천 (같으면 부족분을 채우는 건, 그다음 오래된 건)
  let best = null;
  for (const o of candidates) {
    const d = Math.abs(o.minutes - shortfall);
    const bd = best && Math.abs(best.minutes - shortfall);
    if (!best || d < bd || (d === bd && o.minutes >= shortfall && best.minutes < shortfall)) best = o;
  }

  const dlg = $('#ot-pick');
  $('#ot-pick-text').textContent = candidates.length
    ? `지금 퇴근하면 ${endTime}까지 ${fmtMinutes(shortfall)} 부족합니다. 사용할 연장근무를 고르세요.`
    : `지금 퇴근하면 ${endTime}까지 ${fmtMinutes(shortfall)} 부족합니다. 사용할 수 있는 미사용 연장근무가 없습니다.`;
  $('#ot-pick-list').innerHTML = candidates
    .map((o) => {
      const d = new Date(`${o.date}T00:00:00`);
      return `<li class="${o === best ? 'best' : ''}"><label>
        <input type="radio" name="ot-pick" value="${esc(o.key)}" ${o === best ? 'checked' : ''}>
        <span>${o.date.replace(/-/g, '.')} (${'일월화수목금토'[d.getDay()]})${o === best ? '<span class="rec">추천</span>' : ''}</span>
        <b>${fmtMinutes(o.minutes)}</b>
        <span class="reason">${esc(o.reason || '')}</span>
      </label></li>`;
    })
    .join('');
  $('#ot-pick-list').hidden = !candidates.length;
  dlg.querySelector('[data-act=use]').hidden = !candidates.length;
  dlg.showModal();
  dlg.querySelector('.best')?.scrollIntoView({ block: 'nearest' });

  return new Promise((resolve) => {
    const onClick = (e) => {
      const act = e.target.closest('button[data-act]')?.dataset.act;
      if (!act) return;
      const key = dlg.querySelector('input[name=ot-pick]:checked')?.value;
      if (act === 'use' && !key) return;
      done({ mode: act, item: candidates.find((o) => o.key === key) });
    };
    const onCancel = () => done({ mode: 'cancel' });
    const done = (result) => {
      dlg.removeEventListener('click', onClick);
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve(result);
    };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', onCancel); // Esc
  });
}

$('#btn-out').addEventListener('click', async () => {
  const now = new Date().toTimeString().slice(0, 5);
  const out = punch?.punch?.out;
  const endTime = punch?.schedule?.end_time || '17:30';
  const shortfall = toMin(endTime) - toMin(now);

  // 근무 종료 시간 전이면 사용할 연장근무부터 고름 (이 창이 확인 역할)
  let picked = null;
  if (shortfall > 0 && !punch?.schedule?.vacation) {
    const r = await pickOvertime(shortfall, endTime);
    if (r.mode === 'cancel') return;
    picked = r.mode === 'use' ? r.item : null;
  } else {
    const text = hasPunch(out)
      ? `이미 ${out.time}에 퇴근 기록이 있습니다.\n지금(${now})으로 퇴근 시간을 갱신할까요?`
      : `지금(${now}) 퇴근 처리할까요?`;
    if (!(await modal({ title: '퇴근', text, okText: '퇴근' }))) return;
  }

  let res = await punchRequest('/api/punch/out', { id: hasPunch(out) ? out.id : undefined });
  if (!res) return;

  // 조퇴: 그룹웨어와 동일하게 사유와 함께 확정
  const newOut = res.data?.punch?.out;
  const early = res.code === 'leaving_early' || (res.success && newOut && String(newOut.status) === '0');
  if (early) {
    // 연장근무를 골랐으면 사유는 "YYYY년 MM월 DD일 추가 근무 건에 대한 조퇴" (서버가 작성)
    const memo = picked
      ? ''
      : await modal({
          title: '조퇴 사유',
          text: res.message || '근무 종료 시간 전입니다. 사유를 입력하면 조퇴로 처리됩니다.',
          input: true,
          okText: '조퇴 처리',
        });
    if (memo === null) {
      punchMsg('조퇴 확정을 취소했습니다. 회사 시스템에서 상태를 확인하세요.');
      await loadPunch();
      return;
    }
    let id = newOut && newOut.id;
    if (id == null) {
      await loadPunch(); // 첫 퇴근 요청으로 생긴 퇴근 기록 id 확보
      id = punch?.punch?.out?.id;
    }
    res = await punchRequest('/api/punch/out', { id, memo, leavingEarly: true, overtimeDate: picked?.date });
    if (!res) return;
  } else if (res.code && !res.success) {
    // 초과근무 신청, 야간근무 확인 등은 회사 화면에서 처리
    res.message = `${res.message || res.code} (회사 그룹웨어에서 처리해 주세요)`;
  }
  await afterPunch(res);
});

/* ---------- 시작 ---------- */

(async function init() {
  try {
    const data = await api('/api/me');
    setUser(data);
    showCalendar();
  } catch {
    await refreshLoginInfo();
    if (!(await tryAutoLogin())) showLogin();
  }
})();
