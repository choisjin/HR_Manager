// 사용자별 연장근무·조퇴 내역 저장소 + 소급 처리 반영
// data/overtime-cache.json: { "<사용자 id>": { name, fetchedAt, from, items: [연장근무], early: [조퇴], late: [지각] } }
// 연장근무는 30분 이상만 추가근무로 인정 (회사 기준)
const fs = require('fs');
const path = require('path');
const marks = require('./marks');

const MIN_OVERTIME = 30; // 분

const FILE = path.join(process.env.HRM_DATA_DIR || path.join(__dirname, '..', 'data'), 'overtime-cache.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(all) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, FILE);
}

function loadCache(userId) {
  return readAll()[userId] || null;
}

// 전체 새로 받은 내역으로 교체
function saveFull(userId, name, data) {
  const all = readAll();
  all[userId] = { name, fetchedAt: new Date().toISOString(), from: data.from, items: data.items, early: data.early || [], late: data.late || [] };
  writeAll(all);
  return all[userId];
}

// 일부 달만 새로 받은 경우: 그 달들의 내역만 교체
function mergeMonths(userId, name, data) {
  const all = readAll();
  const prev = all[userId];
  if (!prev) return null;
  const inMonths = (d) => data.months.includes(d.slice(0, 7));
  const byDate = (a, b) => a.date.localeCompare(b.date) || String(a.range || '').localeCompare(String(b.range || ''));
  all[userId] = {
    ...prev,
    name: name || prev.name,
    fetchedAt: new Date().toISOString(),
    items: [...prev.items.filter((o) => !inMonths(o.date)), ...data.items].sort(byDate),
    early: [...(prev.early || []).filter((e) => !inMonths(e.date)), ...(data.early || [])].sort(byDate),
    late: [...(prev.late || []).filter((e) => !inMonths(e.date)), ...(data.late || [])].sort(byDate),
  };
  writeAll(all);
  return all[userId];
}

// 상태 계산: 조퇴에 사용 / 지각에 사용 (사유에 발생일이 적힘) > 소급 처리 > 미사용
function withStatus(userId, cache) {
  const m = marks.getMarks(userId);
  const usedByEarly = new Map(); // 연장근무 날짜 → 조퇴 날짜
  for (const e of cache.early || []) for (const d of e.overtimeDates || []) usedByEarly.set(d, e.date);
  const usedByLate = new Map(); // 연장근무 날짜 → 지각 날짜
  for (const e of cache.late || []) for (const d of e.overtimeDates || []) usedByLate.set(d, e.date);
  const items = cache.items.filter((o) => o.minutes >= MIN_OVERTIME).map((o) => {
    const usedFor = usedByEarly.get(o.date) || usedByLate.get(o.date) || null;
    const mark = m.get(o.key);
    const usedBy = usedByEarly.has(o.date) ? 'early' : usedByLate.has(o.date) ? 'tardy' : mark ? 'manual' : null;
    return {
      ...o,
      usedFor,
      status: usedBy ? '사용' : '미사용',
      usedBy,
      usedKind: usedBy === 'manual' && mark.kind === 'late' ? 'late' : null, // 'late': 당일 지각분
      usedOn: usedFor || (mark && mark.usedOn) || null,
    };
  });
  const earned = items.reduce((s, o) => s + o.minutes, 0);
  const used = items.reduce((s, o) => s + (o.usedBy ? o.minutes : 0), 0);
  return { from: cache.from, fetchedAt: cache.fetchedAt, items, early: cache.early || [], late: cache.late || [], totals: { earned, used, remain: earned - used } };
}

// 관리자용: 모든 사용자의 내역 (상태 반영)
function allUsers() {
  return Object.entries(readAll()).map(([userId, cache]) => ({ userId, name: cache.name || userId, ...withStatus(userId, cache) }));
}

module.exports = { loadCache, saveFull, mergeMonths, withStatus, allUsers, MIN_OVERTIME };
