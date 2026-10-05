// 연장근무 '사용' 소급 처리 저장소 (회사 기록이 없는 과거 사용분을 직접 표시)
// data/overtime-marks.json: { "<사용자 id>": { "<연장근무 키>": { "usedOn": "2026-07-02" } } }
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.HRM_DATA_DIR || path.join(__dirname, '..', 'data'), 'overtime-marks.json');

function readAll() {
  let all;
  try {
    all = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
  // 예전 형식(키 배열) → 사용일 없는 소급으로 변환
  for (const [user, v] of Object.entries(all)) {
    if (Array.isArray(v)) all[user] = Object.fromEntries(v.map((k) => [k, { usedOn: null }]));
  }
  return all;
}

function writeAll(all) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
  fs.renameSync(tmp, FILE);
}

// Map<키, { usedOn }>
function getMarks(userId) {
  return new Map(Object.entries(readAll()[userId] || {}));
}

// usedOn 이 있으면 소급 저장, null 이면 소급 정보 삭제(초기화)
function setMark(userId, key, usedOn) {
  const all = readAll();
  const mine = all[userId] || {};
  if (usedOn) mine[key] = { usedOn };
  else delete mine[key];
  all[userId] = mine;
  writeAll(all);
}

module.exports = { getMarks, setMark };
