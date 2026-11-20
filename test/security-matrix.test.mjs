/**
 * Route-by-permission matrix. Every /api route declared in server.ts is called with
 * no session and with each lower role, and the SERVER must refuse what the role may
 * not do. The route table is parsed from server.ts so a new route cannot be missed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { reporter } from './harness.mjs';
import { boot, makeClient } from './security-kit.mjs';

export const title = 'Security: route-by-permission matrix';
export const allowUnknownRoutes = true;

/** Permission each gated route demands (read off server.ts; an empty string means the handler checks none). */
const REQUIRES = {
  'GET /api/auth/throttles': 'manage_users', 'POST /api/auth/throttles/clear': 'manage_users',
  'POST /api/users': 'manage_users', 'PUT /api/users/:id': 'manage_users', 'POST /api/users/:id/reset-password': 'manage_users',
  'POST /api/periods/close': 'modify_settled', 'POST /api/periods/reopen': 'modify_settled',
  'GET /api/backup/status': 'take_backups', 'GET /api/backup/drives': 'manage_settings', 'POST /api/backup/check-folder': 'manage_settings',
  'POST /api/backup/run': 'take_backups', 'GET /api/backup/download': 'take_backups', 'POST /api/backup/restore': 'admin_only',
  'POST /api/settings': 'manage_settings',
  'POST /api/units/:id/fee-schedule': 'edit_unit', 'DELETE /api/units/:id/fee-schedule/:month': 'edit_unit', 'POST /api/fee-schedule': 'edit_unit',
  'PUT /api/tenancies/:id': 'edit_unit', 'POST /api/tenancies/:id/deposit': 'record_payment', 'POST /api/tenancies/:id/deposit/settle': 'reverse_payment',
  'POST /api/tenancies/:id/evict': 'reverse_payment', 'PUT /api/units/:id': 'edit_unit',
  'POST /api/charges/post-month': 'post_charges', 'POST /api/charges/restate-rent': 'modify_settled', 'POST /api/payments/restate-maintenance-receipts': 'modify_settled',
  'POST /api/charges': 'post_charges', 'POST /api/charges/:id/void': 'modify_settled',
  'POST /api/bookings': 'add_booking', 'POST /api/bookings/:id/damage-deposit': 'record_payment', 'POST /api/bookings/:id/damage-deposit/settle': 'reverse_payment',
  'POST /api/payments': 'record_payment', 'PUT /api/payments/:id': 'modify_settled', 'POST /api/payments/:id/confirm': 'record_payment',
  'POST /api/payments/:id/reverse': 'reverse_payment', 'POST /api/payments/:id/refund': 'reverse_payment', 'POST /api/payments/:id/reconcile': 'reconcile_bank',
  'POST /api/payments/:id/refund/reconcile': 'reconcile_bank', 'POST /api/expenses/:id/reconcile': 'reconcile_bank',
  'POST /api/tenancies/:id/deposit/reconcile': 'reconcile_bank', 'POST /api/bookings/:id/damage-deposit/reconcile': 'reconcile_bank',
  'POST /api/tenancies/:id/deposit-received/reconcile': 'reconcile_bank', 'POST /api/bookings/:id/damage-deposit-received/reconcile': 'reconcile_bank',
  'POST /api/utilities': 'enter_utility', 'PUT /api/utilities/:id': 'enter_utility', 'POST /api/utilities/:id/settle': 'enter_utility',
  'POST /api/expenses': 'record_expense', 'PUT /api/expenses/:id': 'record_expense', 'POST /api/expenses/:id/void': 'modify_settled', 'POST /api/expenses/recall-month': 'modify_settled',
  'POST /api/recurring-expenses': 'record_expense', 'PUT /api/recurring-expenses/:id': 'record_expense', 'DELETE /api/recurring-expenses/:id': 'record_expense',
  'PUT /api/annual-reports/:year': 'post_charges', 'POST /api/expenses/post-month': 'record_expense',
  'PUT /api/unit-activities/:id': 'edit_unit', 'DELETE /api/unit-activities/:id': 'edit_unit',
  'POST /api/ical/feeds': 'manage_settings', 'DELETE /api/ical/feeds/:id': 'manage_settings', 'POST /api/ical/sync': 'add_booking'
  // PUT /api/bookings/:id decides edit_booking / cancel_booking inside the handler, from the body; covered in the money test.
};
const PUBLIC = new Set(['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/logout']);
/** Reachable by every signed-in role on purpose or by omission; reported, not failed, by the role loop. */
const ALL_ROLES_NO_GATE = new Set(['POST /api/payments/:id/mark-printed', 'POST /api/unit-activities', 'GET /api/integrity', 'GET /api/db', 'GET /api/auth/me', 'POST /api/auth/change-password']);

function parseRoutes(projectRoot) {
  const src = fs.readFileSync(path.join(projectRoot, 'server.ts'), 'utf8');
  const re = /\bapp\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  const out = [];
  for (let m; (m = re.exec(src)); ) if (m[2].startsWith('/api')) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}
const allowedFor = (perms, role, req) => {
  if (role === 'ADMINISTRATOR') return true;
  if (req === 'admin_only' || req === 'manage_users') return false;
  if (req === 'manage_settings') return role === 'MANAGER' || !!perms.hasVetoPower;
  const key = { record_payment: 'recordPayments', add_booking: 'addBookings', edit_unit: 'editUnits', reverse_payment: 'reversePayments', enter_utility: 'enterUtilities', record_expense: 'recordExpenses', post_charges: 'postCharges', modify_settled: 'modifySettledRecords', take_backups: 'takeBackups', reconcile_bank: 'reconcileBank' }[req];
  return !!perms[key];
};

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const env = await boot(port, projectRoot);
  try {
    const routes = parseRoutes(projectRoot);
    // Real records, so a handler that looks the record up BEFORE checking permission cannot hide behind a 404.
    await env.admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'T', rentDueDay: 1, maintDueDay: 1 });
    const act = (await env.admin.post('/api/unit-activities', { unitId: 'unit-1', residentName: 'R', residentRole: 'Owner', activityType: 'Maintenance Request', dateCaptured: '2026-01-01', notes: 'seed' })).body.activity;
    const pay = (await env.admin.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 100, currency: 'JMD', method: 'Cash', payerName: 'P', receivedNow: true })).body.payment;
    const REAL = { 'PUT /api/unit-activities/:id': act.id, 'DELETE /api/unit-activities/:id': act.id, 'POST /api/payments/:id/mark-printed': pay.id };
    const concrete = (p, k) => (REAL[k] ? p.replace(':id', REAL[k]) : p.replace(':year', '2026').replace(/:[A-Za-z]+/g, 'no-such-id'));
    T.check('route table parsed from server.ts is non-trivial', routes.length > 55, `${routes.length} routes`);
    const unmapped = routes.filter(r => { const k = `${r.method} ${r.path}`; return !(k in REQUIRES) && !PUBLIC.has(k) && !ALL_ROLES_NO_GATE.has(k) && k !== 'PUT /api/bookings/:id'; });
    T.check('every route is accounted for in the matrix (a new route must be classified)', unmapped.length === 0, unmapped.map(r => `${r.method} ${r.path}`).join('; '));

    /* (A) no session */
    const anon = makeClient(env.srv.baseUrl);
    const leaks = [];
    for (const r of routes) {
      const k = `${r.method} ${r.path}`;
      if (PUBLIC.has(k)) continue;
      const res = await anon.call(r.method, concrete(r.path, k), r.method === 'GET' ? undefined : {});
      if (res.status !== 401) leaks.push(`${k} -> ${res.status}`);
    }
    T.check('no session: every non-public API route answers 401', leaks.length === 0, leaks.join('; '));
    T.check('no session: an unknown API path is 401 not 404 (no route enumeration)', (await anon.get('/api/zzz-nothing')).status === 401);

    /* (B) each lower role, default permissions: refused routes must be 403 from the server */
    const rolePerms = (await env.admin.get('/api/db')).body.settings.rolePermissions;
    const clients = { MANAGER: env.manager, FINANCE_OFFICER: env.finance, JUNIOR_OFFICER: env.junior };
    for (const [role, client] of Object.entries(clients)) {
      const wrong = [];
      for (const r of routes) {
        const k = `${r.method} ${r.path}`;
        const need = REQUIRES[k];
        if (!need) continue;
        if (allowedFor(rolePerms[role], role, need)) continue;
        const res = await client.call(r.method, concrete(r.path, k), r.method === 'GET' ? undefined : {});
        if (res.status !== 403) wrong.push(`${k} -> ${res.status}`);
      }
      T.check(`${role}: every route above its permissions is refused with 403 by the server`, wrong.length === 0, wrong.join('; '));
    }

    /* (C) a read-only role: JUNIOR_OFFICER with every permission withdrawn */
    const none = Object.fromEntries(Object.keys(rolePerms.JUNIOR_OFFICER).map(k => [k, false]));
    T.check('admin can withdraw every permission from the junior role', (await env.admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: none } })).status === 200);
    const ro = [];
    const reachable = [];
    for (const r of routes) {
      const k = `${r.method} ${r.path}`;
      if (PUBLIC.has(k) || k === 'POST /api/auth/change-password' || k === 'POST /api/auth/logout') continue;
      const res = await env.junior.call(r.method, concrete(r.path, k), r.method === 'GET' ? undefined : {});
      if (r.method !== 'GET' && res.status !== 403) reachable.push(`${k} -> ${res.status}`);
      if (REQUIRES[k] && res.status !== 403) ro.push(`${k} -> ${res.status}`);
    }
    T.check('read-only role: every permission-gated route is 403', ro.length === 0, ro.join('; '));
    // Ungated writes reachable by a role with no permissions at all.
    const before = (await env.junior.get('/api/db')).body.unitActivities.length;
    const wrote = await env.junior.post('/api/unit-activities', { unitId: 'unit-1', residentName: 'RO probe', residentRole: 'Owner', activityType: 'Other Activity', dateCaptured: '2026-01-01', notes: 'written by a role with no permissions' });
    T.check('read-only role cannot create a resident-activity log entry (POST /api/unit-activities has no permission check)', wrote.status === 403, `status ${wrote.status}; stored ${(await env.admin.get('/api/db')).body.unitActivities.length - before}`);
    const n0 = (await env.admin.get('/api/db')).body.payments.find(p => p.id === pay.id).printCount;
    await env.junior.post(`/api/payments/${pay.id}/mark-printed`, {});
    await env.junior.post(`/api/payments/${pay.id}/mark-printed`, {});
    const n1 = (await env.admin.get('/api/db')).body.payments.find(p => p.id === pay.id).printCount;
    T.check('read-only role cannot alter a receipt record (mark-printed has no permission check; it bumps printCount and writes audit lines)', n1 === n0, `printCount ${n0} -> ${n1}`);
    T.check('(info) ungated mutating routes reachable by a role with no permissions', true, reachable.join('; '));
    console.log('  info ungated writes reachable by read-only role:', reachable.join(' | '));

    /* (D) forged role claims never matter */
    const forged = await env.finance.post('/api/users', { name: 'Evil', username: 'evil', role: 'ADMINISTRATOR', password: 'Evil-Pass-1234!', userRole: 'ADMINISTRATOR' });
    T.check('a role claimed in the body is ignored', forged.status === 403);
    const forgedH = await env.finance.call('POST', '/api/users', { name: 'Evil', username: 'evil2', role: 'ADMINISTRATOR', password: 'Evil-Pass-1234!' }, { headers: { 'X-User-Role': 'ADMINISTRATOR', 'X-Role': 'ADMINISTRATOR', 'X-Forwarded-User': 'admin' } });
    T.check('a role claimed in a header is ignored', forgedH.status === 403);
    T.check('no account "evil" exists after the forged calls', !(await env.admin.get('/api/db')).body.users.some(u => /^evil/.test(u.username)));

    /* (E) a Manager (settings power) cannot lift anyone to manage users or restore */
    await env.admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...none, recordPayments: true, hasVetoPower: false } } });
    // Only an Administrator gives veto power (test/veto-power pins the refusal for a Manager).
    const grant = await env.admin.post('/api/settings', { rolePermissions: { FINANCE_OFFICER: { ...rolePerms.FINANCE_OFFICER, hasVetoPower: true } } });
    T.check('(setup) administrator can grant veto power to finance role', grant.status === 200);
    T.check('even with veto power a finance officer cannot manage users', (await env.finance.post('/api/users', { name: 'X', username: 'xx', role: 'JUNIOR_OFFICER', password: 'Sneaky-1111!a' })).status === 403);
    const restore = await env.finance.post('/api/backup/restore', { snapshot: {} });
    T.check('even with veto power a finance officer cannot restore a backup', restore.status === 403, `status ${restore.status}`);
    const cosignFlip = await env.finance.post('/api/settings', { requireCosign: false });
    T.check('even with veto power a finance officer cannot switch off the second-approver rule', cosignFlip.status === 403, `status ${cosignFlip.status}`);

    // Veto power carries settings power: a Manager cannot hand it to the junior desk.
    const juniorVeto = await env.manager.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...none, recordPayments: true, hasVetoPower: true } } });
    T.check('a manager cannot give the Junior Officer veto power', juniorVeto.status === 403 && /Only an administrator can give the Junior Officer veto power/.test(juniorVeto.body?.error || juniorVeto.body?.message || ''), `status ${juniorVeto.status}`);
    T.check('and the junior desk is left without it', !(await env.admin.get('/api/db')).body?.settings?.rolePermissions?.JUNIOR_OFFICER?.hasVetoPower);
    // A stale client that omits the key must not silently withdraw it.
    const { hasVetoPower: _omit, ...financeWithoutVeto } = { ...rolePerms.FINANCE_OFFICER, hasVetoPower: true };
    const stale = await env.manager.post('/api/settings', { rolePermissions: { FINANCE_OFFICER: financeWithoutVeto } });
    T.check('a save that omits veto power keeps it (stale client)', stale.status === 200 && (await env.admin.get('/api/db')).body?.settings?.rolePermissions?.FINANCE_OFFICER?.hasVetoPower === true);
    // Positive control: an administrator can grant it, then it is taken back.
    const adminVeto = await env.admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...none, recordPayments: true, hasVetoPower: true } } });
    T.check('an administrator can give the Junior Officer veto power', adminVeto.status === 200);
    await env.admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...none, recordPayments: true, hasVetoPower: false } } });

    /* (F) forced password change: the API itself refuses writes */
    await env.admin.post('/api/users', { name: 'Fresh', username: 'fresh', role: 'MANAGER', password: 'Fresh-1111!aa' });
    const fresh = makeClient(env.srv.baseUrl);
    await fresh.post('/api/auth/login', { username: 'fresh', password: 'Fresh-1111!aa' }, { captureCookie: true });
    const f1 = await fresh.post('/api/payments', {});
    const f2 = await fresh.post('/api/settings', { trn: '1' });
    T.check('an account still on its issued password cannot write', f1.status === 403 && f2.status === 403 && f1.body?.code === 'PASSWORD_CHANGE_REQUIRED', `${f1.status}/${f2.status}`);
    const f3 = await fresh.get('/api/backup/download');
    T.check('(finding probe) an account still on its issued password can download the full records snapshot', f3.status === 403, `status ${f3.status} (GETs are exempt from the forced-change gate)`);
  } finally {
    await env.stop();
  }
  return T.done();
}
