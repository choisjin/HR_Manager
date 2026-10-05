// 휴가 신청 / 신청 내역 / 신청 취소 (app.js 의 $, esc, api, ymd, loadVacation, loadMonth 사용)

const MEMO_TEMPLATE = '1. 사유 : \n2. 업무 대리자 : \n3. 연락처 : ';

const vac = {
  form: null, // 서버의 /api/vacation/form 결과
  approvers: [],
  cc: [],
};

const vacDlg = $('#vac-dialog');
const who = (p) => `${esc(p.name)} <small>${esc(p.position)}${p.group ? ' · ' + esc(p.group) : ''}</small>`;

function vacMsg(el, text, ok) {
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `vac-msg ${ok ? 'ok' : 'fail'}`;
}

/* ---------- 열기 / 탭 ---------- */

$('#btn-vacation-request').addEventListener('click', () => openVacation('form'));
$('#btn-vacation-history').addEventListener('click', () => openVacation('list'));
$('#vac-close').addEventListener('click', () => vacDlg.close());
$('#vac-cancel').addEventListener('click', () => vacDlg.close());
vacDlg.addEventListener('click', (e) => {
  if (e.target === vacDlg) vacDlg.close(); // 바깥(배경) 클릭
});
document.querySelectorAll('.vac-tab').forEach((t) => t.addEventListener('click', () => showVacTab(t.dataset.tab)));

function showVacTab(tab) {
  document.querySelectorAll('.vac-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  vacDlg.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === 'list') loadVacRequests();
}

async function openVacation(tab = 'form') {
  vacMsg($('#vac-msg'), '');
  vacMsg($('#vac-list-msg'), '');
  showVacTab(tab);
  vacDlg.showModal();
  if (!vac.form) {
    vacMsg($('#vac-msg'), '신청 정보를 불러오는 중…', true);
    try {
      vac.form = await api('/api/vacation/form');
    } catch (e) {
      if (e.message !== 'unauthorized') vacMsg($('#vac-msg'), `불러오기 실패: ${e.message}`);
      return;
    }
    vacMsg($('#vac-msg'), '');
  }
  resetVacForm();
}

// 처음 열 때(저장값 없음)는 참조자 비어 있음, 메일 알림은 항상 둘 다 체크, 사유는 항상 기본 틀

/* ---------- 마지막 신청 내용 저장 (기간·사용 제외) ---------- */

const savedKey = () => `hrm.vacation.last.${state.user?.id || 'me'}`;

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(savedKey()) || 'null');
  } catch {
    return null;
  }
}

function saveLast(data) {
  try {
    localStorage.setItem(savedKey(), JSON.stringify(data));
  } catch {
    /* 저장 실패해도 신청에는 영향 없음 */
  }
}

function resetVacForm() {
  const f = vac.form;
  const saved = loadSaved();
  $('#vac-type').innerHTML = f.types
    .map((t) => `<option value="${esc(t.seq)}">${esc(t.name)}${t.balance ? ` (잔여 ${esc(t.balance)})` : ''}</option>`)
    .join('');
  if (saved && f.types.some((t) => t.seq === saved.seq)) $('#vac-type').value = saved.seq;
  const today = ymd(new Date());
  $('#vac-start').value = today;
  $('#vac-end').value = today;
  vacDlg.querySelector('input[name=daytype][value="1"]').checked = true;
  const sequential = saved ? saved.sequential !== false : f.defaults.sequential;
  vacDlg.querySelector(`input[name=order][value=${sequential ? 'seq' : 'par'}]`).checked = true;
  vac.approvers = saved?.approvers?.length ? saved.approvers : [...f.defaults.approvers];
  vac.cc = saved?.cc ? saved.cc : [];
  $('#vac-memo').value = MEMO_TEMPLATE;
  $('#vac-mail-approver').checked = true;
  $('#vac-mail-cc').checked = true;
  vacMsg($('#vac-msg'), saved ? '지난번 신청 내용(휴가 종류, 결재자, 참조자)을 불러왔습니다.' : '', true);
  org.open.clear(); // 조직도는 항상 전부 접힌 상태로 시작
  updateDayType();
  renderApprovers();
  renderCc();
  initOrgTree();
}

/* ---------- 기간 / 종일·반차 ---------- */

function currentType() {
  return vac.form.types.find((t) => t.seq === $('#vac-type').value);
}

// 하루짜리 + 반차 가능한 휴가일 때만 반차 선택 가능
function updateDayType() {
  const single = $('#vac-start').value && $('#vac-start').value === $('#vac-end').value;
  const half = single && currentType()?.halfDay;
  vacDlg.querySelectorAll('input[name=daytype]').forEach((r) => {
    if (r.value === '1') return;
    r.disabled = !half;
    r.parentElement.classList.toggle('disabled', !half);
    if (!half && r.checked) vacDlg.querySelector('input[name=daytype][value="1"]').checked = true;
  });
}

$('#vac-type').addEventListener('change', updateDayType);
$('#vac-start').addEventListener('change', () => {
  if (!$('#vac-end').value || $('#vac-end').value < $('#vac-start').value) $('#vac-end').value = $('#vac-start').value;
  updateDayType();
});
$('#vac-end').addEventListener('change', updateDayType);

/* ---------- 결재자 (순서 지정) ---------- */

function renderApprovers() {
  const list = vac.approvers;
  $('#vac-approvers').innerHTML = list.length
    ? list
        .map(
          (p, i) => `<li>
            <span class="order">${i + 1}</span>
            <span class="who">${who(p)}</span>
            <button type="button" class="mini" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="위로">▲</button>
            <button type="button" class="mini" data-act="down" data-i="${i}" ${i === list.length - 1 ? 'disabled' : ''} title="아래로">▼</button>
            <button type="button" class="mini" data-act="del" data-i="${i}" title="빼기">✕</button>
          </li>`
        )
        .join('')
    : '<li class="empty">결재자를 검색해서 추가하세요</li>';
}

$('#vac-approvers').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const i = Number(b.dataset.i);
  const a = vac.approvers;
  if (b.dataset.act === 'up' && i > 0) [a[i - 1], a[i]] = [a[i], a[i - 1]];
  if (b.dataset.act === 'down' && i < a.length - 1) [a[i + 1], a[i]] = [a[i], a[i + 1]];
  if (b.dataset.act === 'del') a.splice(i, 1);
  renderApprovers();
});

// 결재자 후보는 회사가 지정한 목록(get_approvers)에서만 검색
setupSearch({
  input: $('#vac-approver-search'),
  results: $('#vac-approver-results'),
  search: async (q) => {
    const k = q.toLowerCase();
    return vac.form.approverCandidates.filter((p) => !k || `${p.name} ${p.group} ${p.position}`.toLowerCase().includes(k));
  },
  isAdded: (p) => vac.approvers.some((x) => x.no === p.no),
  onPick: (p) => {
    vac.approvers.push(p);
    renderApprovers();
  },
  showAllOnFocus: true,
});

/* ---------- 참조자 ---------- */

function renderCc() {
  $('#vac-cc-count').textContent = vac.cc.length ? `${vac.cc.length}명` : '';
  $('#vac-cc').innerHTML = vac.cc
    .map((p, i) => `<span class="chip" title="${esc(p.position)} · ${esc(p.group)}">${esc(p.name)}<button type="button" data-i="${i}" title="빼기">✕</button></span>`)
    .join('');
  renderTree();
}

/* ---------- 조직도 트리 (부서 체크 = 하위 부서 포함 전체 인원 추가/제거) ---------- */

const org = {
  roots: null, // 최상위 부서 id 목록
  nodes: new Map(), // id → { id, name, hasChild, children: { groups: [id], users: [person] } | null, members: [person] | null }
  open: new Set(),
  busy: new Set(),
};

async function loadOrgChildren(id) {
  const res = await api(`/api/org/children${id ? `?id=${encodeURIComponent(id)}` : ''}`);
  for (const g of res.groups || []) {
    if (!org.nodes.has(g.id)) org.nodes.set(g.id, { ...g, children: null, members: null });
  }
  return { groups: (res.groups || []).map((g) => g.id), users: res.users || [] };
}

async function initOrgTree() {
  if (org.roots) return renderTree();
  try {
    org.roots = (await loadOrgChildren('')).groups;
  } catch (e) {
    if (e.message !== 'unauthorized') $('#org-tree').innerHTML = `<div class="error org-loading">조직도를 불러오지 못했습니다: ${esc(e.message)}</div>`;
    return;
  }
  renderTree();
}

async function groupMembers(id) {
  const node = org.nodes.get(id);
  if (!node.members) node.members = (await api(`/api/org/members?id=${encodeURIComponent(id)}`)).users || [];
  return node.members;
}

const inCc = (no) => vac.cc.some((p) => p.no === no);

// 부서 체크 상태: 전체 인원을 알 때만 계산 (모름 → 미체크)
function groupState(node) {
  if (!node.members || !node.members.length) return 'none';
  const n = node.members.filter((p) => inCc(p.no)).length;
  return n === 0 ? 'none' : n === node.members.length ? 'all' : 'some';
}

function renderTree() {
  const box = $('#org-tree');
  if (!org.roots) return;
  const scroll = box.scrollTop;
  const renderGroup = (id) => {
    const node = org.nodes.get(id);
    const open = org.open.has(id);
    const st = groupState(node);
    let html = `<li><div class="org-node group">
      <button type="button" class="org-toggle ${node.hasChild || node.children?.users.length ? '' : 'leaf'}" data-toggle="${esc(id)}">${open ? '▼' : '▶'}</button>
      <label><input type="checkbox" data-group="${esc(id)}" ${st === 'all' ? 'checked' : ''} data-some="${st === 'some' ? 1 : 0}" ${org.busy.has(id) ? 'disabled' : ''}>
      <span class="nm">${esc(node.name)}</span>${node.members ? ` <small>${node.members.length}명</small>` : ''}
      ${org.busy.has(id) ? '<span class="org-busy">불러오는 중…</span>' : ''}</label></div>`;
    if (open) {
      if (!node.children) html += '<ul><li class="org-busy org-loading">불러오는 중…</li></ul>';
      else {
        html += '<ul>' + node.children.groups.map(renderGroup).join('');
        html += node.children.users
          .map(
            (p) => `<li><div class="org-node"><span class="org-toggle leaf"></span>
              <label><input type="checkbox" data-user="${p.no}" ${inCc(p.no) ? 'checked' : ''}>
              <span class="nm">${esc(p.name)} <small>${esc(p.position)}</small></span></label></div></li>`
          )
          .join('');
        html += '</ul>';
      }
    }
    return html + '</li>';
  };
  box.innerHTML = `<ul>${org.roots.map(renderGroup).join('')}</ul>`;
  box.querySelectorAll('input[data-some="1"]').forEach((c) => (c.indeterminate = true));
  box.scrollTop = scroll;
}

$('#org-tree').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  const id = t.dataset.toggle;
  if (org.open.has(id)) {
    org.open.delete(id);
    return renderTree();
  }
  org.open.add(id);
  const node = org.nodes.get(id);
  renderTree();
  if (!node.children) {
    try {
      node.children = await loadOrgChildren(id);
    } catch (err) {
      org.open.delete(id);
      if (err.message !== 'unauthorized') vacMsg($('#vac-msg'), `조직도 불러오기 실패: ${err.message}`);
    }
    renderTree();
  }
});

$('#org-tree').addEventListener('change', async (e) => {
  const c = e.target;
  if (c.dataset.user) {
    const no = Number(c.dataset.user);
    if (c.checked) {
      const p = [...org.nodes.values()].flatMap((n) => n.children?.users || []).find((u) => u.no === no);
      if (p && !inCc(no)) vac.cc.push(p);
    } else vac.cc = vac.cc.filter((p) => p.no !== no);
    return renderCc();
  }
  if (c.dataset.group) {
    const id = c.dataset.group;
    const add = c.checked; // 일부 선택(indeterminate) 상태에서 누르면 전체 추가
    org.busy.add(id);
    renderTree();
    try {
      const members = await groupMembers(id);
      if (add) members.forEach((p) => !inCc(p.no) && vac.cc.push(p));
      else {
        const drop = new Set(members.map((p) => p.no));
        vac.cc = vac.cc.filter((p) => !drop.has(p.no));
      }
    } catch (err) {
      if (err.message !== 'unauthorized') vacMsg($('#vac-msg'), `부서 인원 불러오기 실패: ${err.message}`);
    } finally {
      org.busy.delete(id);
    }
    renderCc();
  }
});

$('#vac-cc').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  vac.cc.splice(Number(b.dataset.i), 1);
  renderCc();
});
$('#vac-cc-clear').addEventListener('click', () => {
  vac.cc = [];
  renderCc();
});

// 참조자는 회사 직원 검색 API 사용 (실패하면 알고 있는 사람들 중에서 검색)
setupSearch({
  input: $('#vac-cc-search'),
  results: $('#vac-cc-results'),
  search: async (q) => {
    if (!q) return [];
    try {
      const res = await api(`/api/vacation/users?keyword=${encodeURIComponent(q)}`);
      return res.users || [];
    } catch (e) {
      if (e.message === 'unauthorized') throw e;
      const k = q.toLowerCase();
      const known = new Map([...vac.form.approverCandidates, ...vac.form.defaults.cc, ...vac.form.defaults.approvers].map((p) => [p.no, p]));
      return [...known.values()].filter((p) => `${p.name} ${p.group} ${p.position}`.toLowerCase().includes(k));
    }
  },
  isAdded: (p) => vac.cc.some((x) => x.no === p.no),
  onPick: (p) => {
    vac.cc.push(p);
    renderCc();
  },
});

// 검색 입력 + 결과 목록 (키보드 ↑↓ Enter 지원)
function setupSearch({ input, results, search, isAdded, onPick, showAllOnFocus }) {
  let items = [];
  let hl = -1;
  let seq = 0;
  let timer = null;

  const render = () => {
    results.hidden = false;
    results.innerHTML = items.length
      ? items.map((p, i) => `<li data-i="${i}" class="${isAdded(p) ? 'added' : ''} ${i === hl ? 'hl' : ''}">${who(p)}${isAdded(p) ? ' (추가됨)' : ''}</li>`).join('')
      : '<li class="none">검색 결과가 없습니다</li>';
  };
  const run = async () => {
    const q = input.value.trim();
    if (!q && !showAllOnFocus) return (results.hidden = true);
    const my = ++seq;
    try {
      const found = await search(q);
      if (my !== seq) return;
      items = found;
      hl = -1;
      render();
    } catch {
      results.hidden = true;
    }
  };
  const pick = (i) => {
    const p = items[i];
    if (!p || isAdded(p)) return;
    onPick(p);
    input.value = '';
    results.hidden = true;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener('focus', () => showAllOnFocus && run());
  input.addEventListener('keydown', (e) => {
    if (results.hidden) return;
    if (e.key === 'ArrowDown') hl = Math.min(items.length - 1, hl + 1);
    else if (e.key === 'ArrowUp') hl = Math.max(0, hl - 1);
    else if (e.key === 'Enter') {
      e.preventDefault(); // 폼 제출 방지
      pick(hl >= 0 ? hl : 0);
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      results.hidden = true;
      return;
    } else return;
    e.preventDefault();
    render();
  });
  results.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) {
      e.preventDefault();
      pick(Number(li.dataset.i));
    }
  });
  input.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 150));
}

/* ---------- 신청 ---------- */

$('#vac-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = currentType();
  const start = $('#vac-start').value;
  const end = $('#vac-end').value;
  const dayType = vacDlg.querySelector('input[name=daytype]:checked').value;
  const sequential = vacDlg.querySelector('input[name=order]:checked').value === 'seq';
  const msg = $('#vac-msg');

  if (!type) return vacMsg(msg, '휴가 종류를 선택하세요.');
  if (!start || !end || start > end) return vacMsg(msg, '기간을 확인하세요.');
  if (!vac.approvers.length) return vacMsg(msg, '결재자를 한 명 이상 추가하세요.');

  const dayLabel = start !== end ? '' : { 1: ' (종일)', 2: ' (오전반차)', 3: ' (오후반차)' }[dayType];
  const ok = await modal({
    title: '휴가 신청',
    text:
      `${type.name}\n${start === end ? start : `${start} ~ ${end}`}${dayLabel}\n` +
      `결재자(${sequential ? '순차' : '동시'}): ${vac.approvers.map((p) => p.name).join(' → ')}\n` +
      `참조자: ${vac.cc.length}명\n\n이대로 신청할까요?`,
    okText: '신청',
  });
  if (!ok) return;

  const btn = $('#vac-submit');
  btn.disabled = true;
  vacMsg(msg, '신청하는 중…', true);
  try {
    const res = await fetch('/api/vacation/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seq: type.seq,
        vsCn: type.vsCn,
        startDate: start,
        endDate: end,
        dayType,
        sequential,
        approvers: vac.approvers.map(({ no, cn }) => ({ no, cn })),
        cc: vac.cc.map(({ no, cn }) => ({ no, cn })),
        memo: $('#vac-memo').value,
        approverMail: $('#vac-mail-approver').checked,
        referrerMail: $('#vac-mail-cc').checked,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      vacDlg.close();
      return showLogin(data.message);
    }
    if (!data.success) return vacMsg(msg, data.message || '신청하지 못했습니다.');
    saveLast({ seq: type.seq, sequential, approvers: vac.approvers, cc: vac.cc });
    vacMsg(msg, '');
    showVacTab('list');
    vacMsg($('#vac-list-msg'), data.message || '신청되었습니다.', true);
    loadVacation();
    loadMonth();
  } catch (err) {
    vacMsg(msg, `신청 실패: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 신청 내역 / 취소 ---------- */

async function loadVacRequests() {
  const tbody = $('#vac-list-rows');
  tbody.innerHTML = '<tr><td colspan="5" class="muted">불러오는 중…</td></tr>';
  try {
    const res = await api('/api/vacation/requests');
    const items = res.items || [];
    tbody.innerHTML = items.length
      ? items
          .map(
            (r) => `<tr>
              <td>${esc(r.name)}</td>
              <td>${esc(r.date)}</td>
              <td>${esc(r.used || '')}</td>
              <td class="st">${esc(r.status || '')}</td>
              <td>${r.canCancel ? `<button class="btn-mini" data-id="${r.id}" data-cn="${r.cn}" data-label="${esc(`${r.name} ${r.date}`)}">신청취소</button>` : ''}</td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="muted">신청 내역이 없습니다.</td></tr>';
  } catch (e) {
    if (e.message !== 'unauthorized') tbody.innerHTML = `<tr><td colspan="5" class="error">${esc(e.message)}</td></tr>`;
  }
}

$('#vac-list-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  if (!(await modal({ title: '신청 취소', text: `${b.dataset.label}\n\n이 휴가 신청을 취소할까요?`, okText: '신청취소' }))) return;
  b.disabled = true;
  try {
    const res = await fetch('/api/vacation/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(b.dataset.id), cn: Number(b.dataset.cn) || 0 }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      vacDlg.close();
      return showLogin(data.message);
    }
    vacMsg($('#vac-list-msg'), data.message || (data.success ? '취소되었습니다.' : '취소하지 못했습니다.'), data.success);
    if (data.success) {
      loadVacation();
      loadMonth();
    }
  } catch (err) {
    vacMsg($('#vac-list-msg'), `취소 실패: ${err.message}`);
  }
  loadVacRequests();
});
