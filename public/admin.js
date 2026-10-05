// 관리자: 인증 / 해제 / 비밀번호 변경 / 사용자·관리자 모드 전환 / 엑셀 추출
// app.js 의 $, esc, api, state, applyMode, modal 사용

const adminDlg = $('#admin-dlg');

function adminMsg(text, ok) {
  const el = $('#admin-msg');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `vac-msg ${ok ? 'ok' : 'fail'}`;
}

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/admin/auth')) {
    showLogin(data.message);
    throw new Error('unauthorized');
  }
  return data;
}

// 관리자 인증 버튼: 인증 안 됐으면 비밀번호 창, 인증됐으면 해제
$('#btn-admin').addEventListener('click', async () => {
  if (state.isAdmin) {
    if (!(await modal({ title: '관리자 해제', text: '관리자 인증을 해제할까요?', okText: '해제' }))) return;
    await postJson('/api/admin/release').catch(() => {});
    state.isAdmin = false;
    state.adminMode = false;
    return applyMode();
  }
  adminMsg('');
  $('#admin-password').value = '';
  $('#admin-change-form').reset();
  adminDlg.querySelector('details').open = false;
  adminDlg.showModal();
  $('#admin-password').focus();
});

$('#admin-close').addEventListener('click', () => adminDlg.close());

$('#admin-auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await postJson('/api/admin/auth', { password: $('#admin-password').value });
    if (!data.success) return adminMsg(data.message || '인증하지 못했습니다.');
    state.isAdmin = true;
    adminDlg.close();
    applyMode(); // 관리자 모드 전환 버튼 표시 (화면은 사용자 모드 유지)
  } catch (err) {
    if (err.message !== 'unauthorized') adminMsg(err.message);
  }
});

// 비밀번호 변경 (현재 비밀번호 확인 후)
$('#admin-change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#admin-new').value !== $('#admin-new2').value) return adminMsg('새 비밀번호가 서로 다릅니다.');
  try {
    const data = await postJson('/api/admin/password', { current: $('#admin-cur').value, next: $('#admin-new').value });
    adminMsg(data.message || (data.success ? '변경했습니다.' : '변경하지 못했습니다.'), data.success);
    if (data.success) $('#admin-change-form').reset();
  } catch (err) {
    if (err.message !== 'unauthorized') adminMsg(err.message);
  }
});

// 사용자 ↔ 관리자 모드
$('#btn-mode').addEventListener('click', () => {
  if (!state.isAdmin) return;
  state.adminMode = !state.adminMode;
  applyMode();
});

/* ---------- 엑셀 추출 ---------- */

const exportDlg = $('#export-dlg');

$('#btn-export').addEventListener('click', async () => {
  $('#export-msg').hidden = true;
  $('#export-months').innerHTML = '<div class="muted">불러오는 중…</div>';
  exportDlg.showModal();
  try {
    const { months } = await api('/api/admin/months');
    if (!months.length) {
      $('#export-months').innerHTML = '<div class="muted">서버에 모인 연장근무·조퇴 내역이 없습니다.</div>';
      return;
    }
    // 년도별로 묶어서, 이번 달(있으면) 미리 체크
    const current = state.month;
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    $('#export-months').innerHTML = years
      .map(
        (y) =>
          `<label class="year"><input type="checkbox" data-year="${y}"> ${y}년</label>` +
          months
            .filter((m) => m.startsWith(y))
            .map((m) => `<label class="month"><input type="checkbox" value="${m}" data-y="${y}" ${m === current ? 'checked' : ''}> ${Number(m.slice(5))}월</label>`)
            .join('')
      )
      .join('');
    syncExportYears();
  } catch (e) {
    if (e.message !== 'unauthorized') $('#export-months').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
});

function syncExportYears() {
  for (const yc of $('#export-months').querySelectorAll('input[data-year]')) {
    const kids = [...$('#export-months').querySelectorAll(`input[data-y="${yc.dataset.year}"]`)];
    const n = kids.filter((k) => k.checked).length;
    yc.checked = n === kids.length;
    yc.indeterminate = n > 0 && n < kids.length;
  }
}

$('#export-months').addEventListener('change', (e) => {
  const y = e.target.dataset.year;
  if (y) $('#export-months').querySelectorAll(`input[data-y="${y}"]`).forEach((k) => (k.checked = e.target.checked));
  syncExportYears();
});

$('#export-close').addEventListener('click', () => exportDlg.close());

$('#export-run').addEventListener('click', async () => {
  const months = [...$('#export-months').querySelectorAll('input[data-y]:checked')].map((c) => c.value);
  const msg = $('#export-msg');
  const say = (text, ok) => {
    msg.hidden = false;
    msg.textContent = text;
    msg.className = `vac-msg ${ok ? 'ok' : 'fail'}`;
  };
  if (!months.length) return say('추출할 달을 선택하세요.');
  const btn = $('#export-run');
  btn.disabled = true;
  say('엑셀 파일을 만드는 중…', true);
  try {
    const res = await fetch(`/api/admin/export?months=${months.join(',')}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return showLogin(data.message);
      return say(data.message || `추출 실패 (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(cd) || [])[1] || 'overtime.xlsx');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    say(`${name} 을(를) 저장했습니다.`, true);
  } catch (e) {
    say(`추출 실패: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});
