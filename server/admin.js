// 관리자: 비밀번호(해시 저장) / 전체 사용자 연장근무·조퇴 달력·목록 / 엑셀 추출
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const overtimeStore = require('./overtime-store');

const FILE = path.join(process.env.HRM_DATA_DIR || path.join(__dirname, '..', 'data'), 'admin.json');
const DEFAULT_PASSWORD = 'admin';

/* ---------- 비밀번호 (scrypt 해시, 평문 저장 안 함) ---------- */

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null; // 아직 변경 안 함 → 기본 비밀번호
  }
}

function checkPassword(password) {
  const c = readConfig();
  if (!c) return String(password) === DEFAULT_PASSWORD;
  const got = Buffer.from(hash(password, c.salt), 'hex');
  const want = Buffer.from(c.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function changePassword(current, next) {
  if (!checkPassword(current)) return { success: false, message: '현재 비밀번호가 틀립니다.' };
  if (String(next || '').length < 4) return { success: false, message: '새 비밀번호는 4자 이상이어야 합니다.' };
  const salt = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ salt, hash: hash(next, salt), updatedAt: new Date().toISOString() }));
  return { success: true, message: '관리자 비밀번호를 변경했습니다.' };
}

/* ---------- 전체 사용자 내역 ---------- */

// 한 줄씩: 연장근무(type: 'ot') + 조퇴(type: 'early')
function allRecords() {
  const rows = [];
  for (const u of overtimeStore.allUsers()) {
    for (const o of u.items) {
      rows.push({ type: 'ot', userId: u.userId, name: u.name, key: `${u.userId}|${o.key}`, date: o.date, range: o.range, minutes: o.minutes, reason: o.reason, status: o.status, usedFor: o.usedFor, usedOn: o.usedOn, usedBy: o.usedBy, usedKind: o.usedKind });
    }
    for (const e of u.early) {
      rows.push({ type: 'early', userId: u.userId, name: u.name, key: `${u.userId}|early|${e.date}`, date: e.date, time: e.time, minutes: e.minutes, reason: e.memo, status: '조퇴', overtimeDates: e.overtimeDates || [] });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

// 내역이 있는 달 목록 (최근 먼저)
function months() {
  return [...new Set(allRecords().map((r) => r.date.slice(0, 7)))].sort().reverse();
}

const fmt = (min) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}` : `0:${String(m).padStart(2, '0')}`;
};

/* ---------- 엑셀: 달마다 시트, 세로 = 인원, 가로 = 날짜 ---------- */

async function exportExcel(monthList) {
  const records = allRecords();
  const people = [...new Map(overtimeStore.allUsers().map((u) => [u.userId, u.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HR Manager';

  for (const month of [...monthList].sort()) {
    const [y, m] = month.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const ws = wb.addWorksheet(month);
    const week = '일월화수목금토';

    // 머리글: 이름 | 1(목) 2(금) ... | 연장 합계 | 조퇴 합계
    const header = ['이름'];
    for (let d = 1; d <= days; d++) header.push(`${d}\n(${week[new Date(y, m - 1, d).getDay()]})`);
    header.push('연장 합계', '조퇴 합계');
    ws.addRow(header);

    for (const [userId, name] of people) {
      const mine = records.filter((r) => r.userId === userId && r.date.startsWith(month));
      const row = [name];
      let ot = 0;
      let early = 0;
      for (let d = 1; d <= days; d++) {
        const date = `${month}-${String(d).padStart(2, '0')}`;
        const lines = [];
        for (const r of mine.filter((x) => x.date === date)) {
          // 칸 내용: 상태(줄바꿈)시간 - 연장근무는 미사용/사용/지각분 + 시간, 조퇴는 조퇴 + 부족 시간
          if (r.type === 'ot') {
            ot += r.minutes;
            lines.push(`${r.usedKind === 'late' ? '지각분' : r.status}\n${fmt(r.minutes)}`);
          } else {
            early += r.minutes;
            lines.push(`조퇴\n${r.minutes ? `-${fmt(r.minutes)}` : r.time}`);
          }
        }
        row.push(lines.join('\n'));
      }
      row.push(ot ? fmt(ot) : '', early ? fmt(early) : '');
      ws.addRow(row);
    }

    // 서식: 칸 너비를 내용에 맞게 좁게
    ws.getColumn(1).width = 8;
    for (let c = 2; c <= days + 1; c++) ws.getColumn(c).width = 6.5;
    ws.getColumn(days + 2).width = 8;
    ws.getColumn(days + 3).width = 8;
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
    const border = { style: 'thin', color: { argb: 'FFD0D7E2' } };
    ws.eachRow((row, rowNo) => {
      row.eachCell({ includeEmpty: true }, (cell, colNo) => {
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.font = { size: 9, ...(cell.font || {}) };
        cell.border = { top: border, left: border, bottom: border, right: border };
        if (rowNo === 1) {
          cell.font = { bold: true, size: 9 };
          const dow = colNo >= 2 && colNo <= days + 1 ? new Date(y, m - 1, colNo - 1).getDay() : -1;
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dow === 0 ? 'FFFDE2E2' : dow === 6 ? 'FFE2ECFD' : 'FFF1F3F7' } };
        } else if (colNo >= 2 && colNo <= days + 1 && cell.value) {
          const text = String(cell.value);
          const argb = text.includes('조퇴') ? 'FFE6F6EE' : text.includes('미사용') ? 'FFFFF1E6' : text.includes('지각분') ? 'FFEEEBFE' : 'FFF1F3F7';
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
        }
      });
      // 한 칸에 여러 건이면 줄 수만큼 높이
      const maxLines = Math.max(1, ...row.values.slice(2, days + 2).map((v) => String(v || '').split('\n').length));
      row.height = rowNo === 1 ? 30 : Math.max(30, 13 * maxLines);
    });
  }
  if (!monthList.length) wb.addWorksheet('내역 없음');
  return wb.xlsx.writeBuffer();
}

module.exports = { checkPassword, changePassword, allRecords, months, exportExcel };
