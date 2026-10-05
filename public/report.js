// 보고 메일: 연장 근무 계획 보고 / 연장 근무 결과 보고 / 근무조정 보고
// app.js 의 $, esc, api, ymd, state, otState, fmtMinutes, punch, modal 과 vacation.js 의 setupSearch, who 사용
// 메일은 기본 메일 프로그램(Outlook 등)으로 작성 창을 띄우고, 제목·본문 복사도 지원

const REPORTS = {
  plan: { title: '연장 근무 계획 보고', kind: '계획' },
  result: { title: '연장 근무 결과 보고', kind: '결과' },
  adjust: { title: '근무조정 보고' },
};

const rpt = { type: null, rows: [] };
const rptDlg = $('#report-dlg');

/* ---------- 저장 / 불러오기 (보고별, 사용자별) ---------- */

const rptKey = (name) => `hrm.report.${name}.${state.user?.id || 'me'}`;
function rptLoad(name) {
  try {
    return JSON.parse(localStorage.getItem(rptKey(name)) || 'null');
  } catch {
    return null;
  }
}
function rptSave(name, data) {
  try {
    localStorage.setItem(rptKey(name), JSON.stringify(data));
  } catch {
    /* 저장 실패해도 메일 작성에는 영향 없음 */
  }
}

/* ---------- 메뉴 ---------- */

$('#btn-report').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#report-menu').hidden = !$('#report-menu').hidden;
});
$('#report-menu').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-report]');
  if (!b) return;
  $('#report-menu').hidden = true;
  openReport(b.dataset.report);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.report-wrap')) $('#report-menu').hidden = true;
});
$('#report-close').addEventListener('click', () => rptDlg.close());

/* ---------- 열기 ---------- */

function openReport(type) {
  rpt.type = type;
  const def = REPORTS[type];
  $('#report-title').textContent = def.title;
  rptDlg.querySelectorAll('[data-for]').forEach((el) => (el.hidden = !el.dataset.for.split(' ').includes(type)));
  // 숨긴 칸은 필수 검사에서 제외
  rptDlg.querySelectorAll('[data-for] [required], [data-for][required]').forEach((el) => (el.disabled = !!el.closest('[hidden]')));
  rptMsg('');

  const common = rptLoad('common') || {};
  const saved = rptLoad(type) || {};
  $('#r-to').value = saved.to ?? common.to ?? '';
  $('#r-cc').value = saved.cc ?? common.cc ?? '';
  $('#r-to-extra').value = saved.toExtra ?? '';

  const today = ymd(new Date());
  if (type === 'adjust') {
    const d = new Date();
    $('#report-desc').hidden = false;
    $('#report-desc').innerHTML = `금일(<b>${d.getFullYear()}년 ${String(d.getMonth() + 1).padStart(2, '0')}월 ${String(d.getDate()).padStart(2, '0')}일</b>) 기준 근무조정 보고 메일을 생성합니다. 구분·시간·사유·추가근무를 선택하세요.`;
    $('#r-adj-kind').value = saved.kind || '퇴근';
    $('#r-adj-time').value = d.toTimeString().slice(0, 5);
    $('#r-adj-reason').value = saved.reason || '';
    fillAdjustOvertime();
  } else {
    $('#report-desc').hidden = true;
    $('#r-projects').innerHTML = (common.projects || []).map((p) => `<option value="${esc(p)}"></option>`).join('');
    $('#r-project').value = saved.project || (common.projects || [])[0] || '';
    $('#r-date').value = today;
    const me = state.user?.name || '';
    rpt.rows = saved.rows?.length ? saved.rows.map((r) => ({ ...r })) : [{ name: me, reason: '', time: '' }];
    renderRows();
  }
  updateSubjectPreview();
  rptDlg.showModal();
  $('#r-rows').querySelectorAll('.r-reason').forEach(centerTextarea); // 화면에 보인 뒤 높이 계산
}

function rptMsg(text, ok) {
  const el = $('#report-msg');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `vac-msg ${ok ? 'ok' : 'fail'}`;
}

/* ---------- 담당자 행 (계획/결과) ---------- */

function renderRows() {
  const isResult = rpt.type === 'result';
  const me = state.user?.name;
  $('#r-rows').innerHTML = rpt.rows
    .map(
      (r, i) => `<tr data-i="${i}">
        <td class="fill"><div class="r-name vac-search">
          <input class="r-name-input" value="${esc(r.name)}" placeholder="이름 검색" title="${r.name && r.name === me ? '나' : ''}">
          <button type="button" class="mini r-pick" title="조직도에서 선택">👤</button>
          <ul class="vac-results" hidden></ul>
        </div></td>
        <td class="fill"><textarea class="r-reason" rows="2" placeholder="연장근무 사유 (줄바꿈 가능)">${esc(r.reason)}</textarea></td>
        ${isResult ? `<td class="fill"><input type="time" class="r-time" value="${esc(r.time || '')}"></td>` : ''}
        <td><button type="button" class="mini r-del" title="행 삭제" ${rpt.rows.length === 1 ? 'disabled' : ''}>✕</button></td>
      </tr>`
    )
    .join('');
  $('#r-rows').querySelectorAll('.r-reason').forEach(centerTextarea);
  // 이름 칸마다 검색(휴가 참조자와 같은 직원 검색)
  $('#r-rows').querySelectorAll('tr').forEach((tr) => {
    const i = Number(tr.dataset.i);
    setupSearch({
      input: tr.querySelector('.r-name-input'),
      results: tr.querySelector('.vac-results'),
      search: searchPeople,
      isAdded: () => false,
      onPick: (p) => {
        rpt.rows[i].name = p.name;
        renderRows();
      },
    });
  });
}

// 사유 칸 세로 가운데 정렬: 내용 높이를 재서 위아래 여백을 똑같이 (내용이 칸보다 길면 최소 여백 + 스크롤)
function centerTextarea(ta) {
  if (!ta.isConnected || !ta.offsetParent) return;
  ta.style.paddingTop = ta.style.paddingBottom = '0px';
  ta.style.minHeight = ta.style.height = '0px'; // 내용 높이만 재기 위해 잠시 최소 높이 해제
  const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  const content = ta.value ? ta.scrollHeight : lineH; // 비어 있으면 안내 문구 1줄 기준
  ta.style.minHeight = ta.style.height = '';
  const box = ta.parentElement.clientHeight; // 여백을 뺀 상태의 칸 높이
  const pad = Math.max(6, Math.floor((box - content) / 2));
  ta.style.paddingTop = ta.style.paddingBottom = `${pad}px`;
}

$('#r-rows').addEventListener('input', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = rpt.rows[Number(tr.dataset.i)];
  if (e.target.classList.contains('r-name-input')) r.name = e.target.value;
  if (e.target.classList.contains('r-reason')) {
    r.reason = e.target.value;
    centerTextarea(e.target);
  }
  if (e.target.classList.contains('r-time')) r.time = e.target.value;
});

$('#r-rows').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const i = Number(tr.dataset.i);
  if (e.target.closest('.r-del') && rpt.rows.length > 1) {
    rpt.rows.splice(i, 1);
    renderRows();
  }
  if (e.target.closest('.r-pick')) {
    const p = await pickPerson();
    if (p) {
      rpt.rows[i].name = p.name;
      renderRows();
    }
  }
});

$('#r-add-row').addEventListener('click', () => {
  rpt.rows.push({ name: '', reason: '', time: '' });
  renderRows();
  $('#r-rows tr:last-child .r-name-input').focus();
});

['#r-project', '#r-date'].forEach((s) => $(s).addEventListener('input', updateSubjectPreview));

/* ---------- 직원 검색 / 조직도 선택 ---------- */

const pickTree = { roots: null, nodes: new Map(), open: new Set() };

async function searchPeople(q) {
  if (!q) return [];
  try {
    return (await api(`/api/vacation/users?keyword=${encodeURIComponent(q)}`)).users || [];
  } catch (e) {
    if (e.message === 'unauthorized') throw e;
    // 검색 API 실패 시: 조직도에서 이미 불러온 직원 중에서
    const k = q.toLowerCase();
    const known = [...pickTree.nodes.values()].flatMap((n) => n.children?.users || []);
    return known.filter((p) => `${p.name} ${p.group}`.toLowerCase().includes(k));
  }
}

let personResolve = null;
const personDlg = $('#person-dlg');

function pickPerson() {
  $('#person-search').value = '';
  $('#person-results').hidden = true;
  personDlg.showModal();
  loadPickTree();
  return new Promise((resolve) => (personResolve = resolve));
}

function closePerson(p) {
  if (personDlg.open) personDlg.close();
  if (personResolve) personResolve(p || null);
  personResolve = null;
}
$('#person-cancel').addEventListener('click', () => closePerson(null));
personDlg.addEventListener('cancel', () => closePerson(null));

setupSearch({
  input: $('#person-search'),
  results: $('#person-results'),
  search: searchPeople,
  isAdded: () => false,
  onPick: (p) => closePerson(p),
});

async function pickTreeChildren(id) {
  const res = await api(`/api/org/children${id ? `?id=${encodeURIComponent(id)}` : ''}`);
  for (const g of res.groups || []) if (!pickTree.nodes.has(g.id)) pickTree.nodes.set(g.id, { ...g, children: null });
  return { groups: (res.groups || []).map((g) => g.id), users: res.users || [] };
}

async function loadPickTree() {
  if (!pickTree.roots) {
    $('#person-tree').innerHTML = '<div class="muted org-loading">조직도를 불러오는 중…</div>';
    try {
      pickTree.roots = (await pickTreeChildren('')).groups;
    } catch (e) {
      if (e.message !== 'unauthorized') $('#person-tree').innerHTML = `<div class="error org-loading">${esc(e.message)}</div>`;
      return;
    }
  }
  renderPickTree();
}

function renderPickTree() {
  const group = (id) => {
    const n = pickTree.nodes.get(id);
    const open = pickTree.open.has(id);
    let html = `<li><div class="org-node group"><button type="button" class="org-toggle" data-toggle="${esc(id)}">${open ? '▼' : '▶'}</button>
      <span class="nm" data-toggle="${esc(id)}" style="cursor:pointer">${esc(n.name)}</span></div>`;
    if (open) {
      if (!n.children) html += '<ul><li class="org-busy org-loading">불러오는 중…</li></ul>';
      else {
        html += '<ul>' + n.children.groups.map(group).join('');
        html += n.children.users
          .map((p) => `<li><div class="org-node"><span class="org-toggle leaf"></span><button type="button" class="pick" data-no="${p.no}">${esc(p.name)} <small>${esc(p.position)}</small></button></div></li>`)
          .join('');
        html += '</ul>';
      }
    }
    return html + '</li>';
  };
  $('#person-tree').innerHTML = `<ul>${pickTree.roots.map(group).join('')}</ul>`;
}

$('#person-tree').addEventListener('click', async (e) => {
  const pick = e.target.closest('.pick');
  if (pick) {
    const no = Number(pick.dataset.no);
    const p = [...pickTree.nodes.values()].flatMap((n) => n.children?.users || []).find((u) => u.no === no);
    return closePerson(p);
  }
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  const id = t.dataset.toggle;
  if (pickTree.open.has(id)) {
    pickTree.open.delete(id);
    return renderPickTree();
  }
  pickTree.open.add(id);
  const n = pickTree.nodes.get(id);
  renderPickTree();
  if (!n.children) {
    try {
      n.children = await pickTreeChildren(id);
    } catch {
      pickTree.open.delete(id);
    }
    renderPickTree();
  }
});

/* ---------- 근무조정: 내 추가근무 선택 ---------- */

function fillAdjustOvertime() {
  const items = (otState.items || [])
    .filter((o) => o.status === '미사용')
    .sort((a, b) => b.date.localeCompare(a.date));
  $('#r-adj-ot').innerHTML =
    '<option value="">선택 안 함</option>' +
    items
      .map((o) => `<option value="${esc(o.key)}">${o.date} · ${fmtMinutes(o.minutes)}${o.reason ? ` · ${esc(o.reason)}` : ''}</option>`)
      .join('');
  recommendAdjustOvertime();
}

// 퇴근 조정이면 (근무 종료 시간 - 조정 시간)과 가장 비슷한 추가근무를 미리 선택
function recommendAdjustOvertime() {
  if ($('#r-adj-kind').value !== '퇴근') return;
  const end = punch?.schedule?.end_time || '17:30';
  const short = toMin(end) - toMin($('#r-adj-time').value);
  if (!(short > 0)) return;
  const items = (otState.items || []).filter((o) => o.status === '미사용');
  let best = null;
  for (const o of items) {
    const d = Math.abs(o.minutes - short);
    if (!best || d < Math.abs(best.minutes - short) || (d === Math.abs(best.minutes - short) && o.minutes >= short && best.minutes < short)) best = o;
  }
  if (best) $('#r-adj-ot').value = best.key;
}
$('#r-adj-time').addEventListener('change', recommendAdjustOvertime);
$('#r-adj-kind').addEventListener('change', recommendAdjustOvertime);

/* ---------- 제목 / 본문 ---------- */

const slashDate = (ymdStr) => (ymdStr || '').replace(/-/g, '/');
const withTitle = (name) => (/프로$/.test(name.trim()) ? name.trim() : `${name.trim()} 프로`); // 회사 직급은 모두 "프로"

function reportSubject() {
  if (rpt.type === 'adjust') return `[보고] 근무조정 보고 - ${withTitle(state.user?.name || '')} (${slashDate(ymd(new Date()))})`;
  return `[보고] ${$('#r-project').value.trim()} 프로젝트 연장 근무 ${REPORTS[rpt.type].kind} 보고 (${slashDate($('#r-date').value)})`;
}

function updateSubjectPreview() {
  if (rpt.type !== 'adjust') $('#r-subject-preview').textContent = reportSubject();
}

function reportBody() {
  const lines = ['안녕하세요.'];
  if (rpt.type === 'adjust') {
    const d = new Date();
    const ot = (otState.items || []).find((o) => o.key === $('#r-adj-ot').value);
    lines.push(
      `금일(${d.getFullYear()}년 ${String(d.getMonth() + 1).padStart(2, '0')}월 ${String(d.getDate()).padStart(2, '0')}일) 근무조정 보고드립니다.`,
      '',
      `■ 조정 인원: ${withTitle(state.user?.name || '')}`,
      `■ 구분: ${$('#r-adj-kind').value}`,
      `■ 조정 시간: ${$('#r-adj-time').value}`,
      `■ 조정 사유: ${$('#r-adj-reason').value.trim()}`,
      `■ 사용 추가근무: ${ot ? `${ot.date} (${fmtMinutes(ot.minutes)}${ot.reason ? `, ${ot.reason}` : ''})` : '없음'}`
    );
  } else {
    const project = $('#r-project').value.trim();
    lines.push(`${project} 프로젝트 연장 근무 ${REPORTS[rpt.type].kind} 보고드립니다.`, '', `■ 일자: ${slashDate($('#r-date').value)}`, '■ 담당자별 연장근무 사유');
    rpt.rows
      .filter((r) => r.name.trim())
      .forEach((r, i) => {
        const time = rpt.type === 'result' && r.time ? ` (퇴근 ${r.time})` : '';
        lines.push(`${i + 1}. ${withTitle(r.name)}${time}`);
        const reasons = r.reason.split('\n').map((s) => s.trim()).filter(Boolean);
        (reasons.length ? reasons : ['-']).forEach((s) => lines.push(`   - ${s}`));
      });
  }
  lines.push('', '감사합니다.');
  return lines.join('\n');
}

// "a@x.com; b@y.com" → ["a@x.com", "b@y.com"]
const addrs = (s) => String(s || '').split(/[;,]/).map((a) => a.trim()).filter(Boolean);

// 기본 메일 프로그램 작성 창 주소 (받는 사람 = 고정 + 추가, 참조, 제목, 본문)
function reportMailto() {
  const to = [...addrs($('#r-to').value), ...addrs($('#r-to-extra').value)].map(encodeURIComponent).join(',');
  const params = [`cc=${addrs($('#r-cc').value).map(encodeURIComponent).join(',')}`, `subject=${encodeURIComponent(reportSubject())}`, `body=${encodeURIComponent(reportBody())}`];
  return `mailto:${to}?${params.join('&')}`;
}

/* ---------- 저장 + 메일 작성 / 복사 ---------- */

function validateReport() {
  if (rpt.type !== 'adjust' && !rpt.rows.some((r) => r.name.trim())) {
    rptMsg('담당자를 한 명 이상 입력하세요.');
    return false;
  }
  return true;
}

function saveReportInputs() {
  const common = rptLoad('common') || {};
  common.to = $('#r-to').value.trim();
  common.cc = $('#r-cc').value.trim();
  const data = { to: common.to, cc: common.cc, toExtra: $('#r-to-extra').value.trim() };
  if (rpt.type === 'adjust') {
    Object.assign(data, { kind: $('#r-adj-kind').value, reason: $('#r-adj-reason').value.trim() });
  } else {
    const project = $('#r-project').value.trim();
    common.projects = [project, ...(common.projects || []).filter((p) => p !== project)].slice(0, 20);
    Object.assign(data, { project, rows: rpt.rows.filter((r) => r.name.trim() || r.reason.trim()) });
  }
  rptSave('common', common);
  rptSave(rpt.type, data);
}

$('#report-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!validateReport()) return;
  saveReportInputs();
  window.location.href = reportMailto();
  rptMsg('메일 프로그램에서 작성 창을 열었습니다. 열리지 않으면 "제목·본문 복사"를 사용하세요.', true);
});

$('#r-copy').addEventListener('click', async () => {
  if (!$('#report-form').reportValidity() || !validateReport()) return;
  saveReportInputs();
  const text = `받는 사람: ${[...addrs($('#r-to').value), ...addrs($('#r-to-extra').value)].join('; ')}\n참조: ${addrs($('#r-cc').value).join('; ')}\n제목: ${reportSubject()}\n\n${reportBody()}`;
  try {
    await navigator.clipboard.writeText(text);
    rptMsg('받는 사람·참조·제목·본문을 클립보드에 복사했습니다.', true);
  } catch (err) {
    rptMsg(`복사 실패: ${err.message}`);
  }
});
