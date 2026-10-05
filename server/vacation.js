// 휴가 신청 / 신청 내역 / 신청 취소 (회사 휴가 신청 화면과 같은 API·파라미터 사용)

// 사람 정보를 화면에서 쓰는 형태로 통일
function person(u) {
  return {
    no: Number(u.user_no ?? u.no ?? u.user_id),
    cn: Number(u.user_cn ?? u.cn ?? 0),
    name: u.user_name ?? u.name ?? '',
    group: u.group_name ?? u.group ?? '',
    position: u.position_name ?? u.position ?? '',
  };
}

// 신청 화면에 필요한 정보: 휴가 종류, 결재자 후보, 기본 결재라인/참조자
async function vacationForm(gw) {
  const [vac, config, approvers] = await Promise.all([
    gw.hr('/holiday/vacation/user_get_vacation'),
    gw.hr('/holiday/user/get_holiday_config'),
    gw.hr('/holiday/user/get_approvers'),
  ]);
  if ([vac, config, approvers].some((r) => r.status === 401)) return { expired: true };

  const types = ((vac.data && vac.data.data) || [])
    .filter((v) => v.vacation_seq && v.enabled !== 'n')
    .map((v) => ({
      seq: v.vacation_seq, // vacation_type|vacation_id|vacation_cn|vs_id
      vsCn: Number(v.vs_cn ?? 0),
      name: v.name,
      balance: v.balance_txt && v.balance_txt !== '-' ? v.balance_txt : '',
      halfDay: v.use_half_day === 'y',
    }));

  const c = (config.data && config.data.data) || {};
  return {
    types,
    approverCandidates: ((approvers.data && approvers.data.data) || []).map(person),
    defaults: {
      approvers: (c.user_approvers || []).map(person),
      cc: (c.user_cc || []).map(person),
      sequential: Number(c.user_method ?? 2) === 2, // 2: 순차 결재, 1: 동시 결재
    },
  };
}

// 직원 검색 (참조자 추가용) - 회사 조직도 검색과 같은 API
async function searchUsers(gw, keyword, page = 1) {
  const q = new URLSearchParams({ page: String(page), keyword: keyword || '', group_no: '' });
  const r = await gw.hr(`/users?${q}`);
  if (r.status === 401) return { expired: true };
  const d = (r.data && r.data.data) || {};
  return { users: (d.rows || []).map(person), pagination: d.pagination || null };
}

/* ---------- 조직도 ---------- */

// 조직도 한 단계: id 가 없으면 최상위(회사들), 있으면 그 부서의 하위 부서 + 소속 직원
async function orgChildren(gw, id) {
  const q = new URLSearchParams({ user: '1', single: '1' });
  if (id) q.set('id', id);
  const r = await gw.hr(`/groups?${q}`);
  if (r.status === 401) return { expired: true };
  const rows = (r.data && r.data.data && r.data.data.rows) || [];
  const groups = [];
  const users = [];
  for (const row of rows) {
    if (row.user_no != null) {
      users.push(person({ ...row, user_name: row.user_name ?? row.name ?? row.text }));
    } else if (row.type === 'folder' || row.group_no != null) {
      groups.push({ id: row.id, name: row.name || row.group_name || row.text, hasChild: !!row.has_child });
    }
  }
  return { groups, users };
}

// 부서 전체 인원 (하위 부서 포함). 너무 큰 조직은 중간에 멈춤
async function orgMembers(gw, id, limit = 2000) {
  const seen = new Map();
  const queue = [id];
  const visited = new Set();
  while (queue.length && seen.size < limit && visited.size < 300) {
    const batch = queue.splice(0, 6).filter((g) => !visited.has(g));
    batch.forEach((g) => visited.add(g));
    const results = await Promise.all(batch.map((g) => orgChildren(gw, g)));
    for (const res of results) {
      if (res.expired) return res;
      res.users.forEach((u) => seen.set(u.no, u));
      res.groups.forEach((g) => queue.push(g.id));
    }
  }
  return { users: [...seen.values()] };
}

// type: 1 종일, 2 오전반차, 3 오후반차 (여러 날이면 항상 1)
async function requestVacation(gw, req) {
  const { seq, vsCn, startDate, endDate, dayType, approvers, cc, sequential, memo, approverMail, referrerMail } = req;
  const type = startDate !== endDate ? '1' : String(dayType || '1');
  const fields = [
    ['vacation_seq', seq],
    ['vr_cn', 0],
    ['vs_cn', vsCn || 0],
    ['order_method', sequential ? 2 : 1],
    ['type', type],
    ['start_date', startDate],
    ['end_date', endDate],
  ];
  approvers.forEach((p, i) => fields.push([`approver[${i}][cn]`, p.cn || 0], [`approver[${i}][no]`, p.no]));
  cc.forEach((p, i) => fields.push([`cc[${i}][cn]`, p.cn || 0], [`cc[${i}][no]`, p.no]));
  fields.push(
    ['memo', memo || ''],
    ['wp_cn', 0],
    ['wp_id', 1],
    ['vsg_cn', 0],
    ['vsg_id', 1],
    ['start_date_half', 0],
    ['end_date_half', 0],
    // 회사 화면이 종일/반차 신청 때 보내는 기본값과 동일
    ['start_time', '0830'],
    ['end_time', '0930'],
    ['hours_use', '0100'],
    ['use_working_hours', 0],
    ['approver_mail', approverMail === false ? 0 : 1],
    ['referrer_mail', referrerMail === false ? 0 : 1],
    ['is_all_approvers_mail', 0],
    ['auto_approved', 0]
  );
  return gw.hr('/holiday/request/save', { method: 'POST', multipart: fields });
}

// 내 휴가 신청 내역 (최근순)
async function myRequests(gw, page = 1) {
  const q = new URLSearchParams({
    mode: 'request', type: 'request', page: String(page), limit: '20', filter: 'all',
    target_type: '', target_id: '', filter_vs_type: '', filter_vacation: '', period: 'all',
  });
  const r = await gw.hr(`/holiday/request/list?${q}`);
  if (r.status === 401) return { expired: true };
  const rows = (r.data && r.data.data) || [];
  return {
    items: rows.map((x) => ({
      id: x.vr_id,
      cn: x.vr_cn,
      name: x.holiday_name,
      date: x.request_date || `${x.start_date} ~ ${x.end_date}`,
      start: x.start_date,
      used: x.used,
      status: x.my_status,
      canCancel: Array.isArray(x.my_action) && x.my_action.includes('request_cancel'),
    })),
    pagination: (r.data && r.data.attr) || null,
  };
}

function cancelRequest(gw, id, cn = 0) {
  return gw.hr('/holiday/request/cancel', { method: 'POST', multipart: [['vr_cn', cn], ['vr_id', id]] });
}

module.exports = { vacationForm, searchUsers, orgChildren, orgMembers, requestVacation, myRequests, cancelRequest };
