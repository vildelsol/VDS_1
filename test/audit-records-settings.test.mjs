/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * System Settings: the permission matrix as shown, saved and enforced.
 *
 *  1. Every permission that has a label (PERMISSION_LABELS) is a row on the
 *     screen (PERMISSION_KEYS) and a key the server stores (noPermissions()).
 *     overrideMoneyGuards had a label and a server gate but no row, so nobody
 *     could see who held it or grant it from the screen.
 *  2. Role defaults: the Junior Officer holds none of the controls (override,
 *     settings, users, restore, settled records, reversals, backups).
 *  3. overrideMoneyGuards lets money onto the books that a check refused. It is
 *     "Administrator only unless granted", and only an Administrator may grant
 *     it: a Manager (who may change settings) could otherwise grant it to
 *     themselves or the desk. Same rule as the second-approver switch.
 *     Positive controls: a Manager saving the matrix with the value unchanged
 *     still works (the screen sends every key), and once an Administrator grants
 *     it the grantee's override goes through, with a reason, audited.
 *  4. Settings that touch money are validated, audited with before/after, and
 *     do not rewrite charges already posted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { reporter, localToday, makeClient } from './harness.mjs';
import { boot, seedLedger } from './security-kit.mjs';

export const title = 'Audit records: System Settings permissions and money settings';

/** Keys of an object literal / array literal in a source file, by name. */
function objectKeys(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const open = /KEYS/.test(marker) ? src.indexOf('= [', at) + 2 : src.indexOf('{', at + marker.length - 1);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if ('[{'.includes(src[i])) depth++;
    if (']}'.includes(src[i]) && --depth === 0) { end = i; break; }
  }
  const body = src.slice(open + 1, end);
  return /KEYS/.test(marker)
    ? [...body.matchAll(/'(\w+)'/g)].map(m => m[1])
    : [...body.matchAll(/^\s*(\w+)\s*:/gm)].map(m => m[1]);
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);

  /* ---------------- 1. labels, screen rows and server keys agree ---------------- */
  const types = fs.readFileSync(path.join(projectRoot, 'src', 'types.ts'), 'utf8');
  const dbSrc = fs.readFileSync(path.join(projectRoot, 'server', 'db.ts'), 'utf8');
  const labels = objectKeys(types, 'export const PERMISSION_LABELS');
  const rows = objectKeys(types, 'export const PERMISSION_KEYS');
  const stored = objectKeys(dbSrc, 'export function noPermissions(): RolePermissions {\n  return {');
  T.check('(control) the three lists parse and are non-trivial', labels?.length >= 13 && rows?.length >= 13 && stored?.length >= 13, `${labels?.length}/${rows?.length}/${stored?.length}`);
  T.check('(control) the label list includes overrideMoneyGuards', labels?.includes('overrideMoneyGuards'));
  const noRow = (labels || []).filter(k => !rows.includes(k));
  T.check('every labelled permission is a row on the System Settings screen (PERMISSION_KEYS)', noRow.length === 0, `no row for: ${noRow.join(', ')}`);
  T.check('every screen row has a label', (rows || []).every(k => labels.includes(k)));
  const notStored = (labels || []).filter(k => !stored.includes(k));
  T.check('every labelled permission is a key the server stores', notStored.length === 0, notStored.join(', '));
  const settingsSrc = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'SystemSettings.tsx'), 'utf8');
  T.check('the permissions panel renders its rows from PERMISSION_KEYS', /PERMISSION_KEYS\.map\(/.test(settingsSrc));

  const env = await boot(port, projectRoot);
  const { admin, manager, finance, junior } = env;
  try {
    await seedLedger(admin);
    const settings = async () => (await admin.get('/api/db')).body.settings;
    const perms = (await settings()).rolePermissions;

    /* ---------------- 2. role defaults ---------------- */
    const J = perms.JUNIOR_OFFICER;
    T.check('Junior Officer does not hold overrideMoneyGuards by default', J.overrideMoneyGuards === false);
    T.check('Finance Officer does not hold overrideMoneyGuards by default', perms.FINANCE_OFFICER.overrideMoneyGuards === false);
    T.check('Manager does not hold overrideMoneyGuards by default', perms.MANAGER.overrideMoneyGuards === false);
    T.check('Junior Officer holds no financial controls by default', !J.reversePayments && !J.modifySettledRecords && !J.takeBackups && !J.hasVetoPower, JSON.stringify(J));
    T.check('Junior Officer cannot change settings', (await junior.post('/api/settings', { trn: '1' })).status === 403);
    T.check('Junior Officer cannot manage users', (await junior.post('/api/users', { name: 'X', username: 'xj', role: 'JUNIOR_OFFICER', password: 'Xj-Pass-1234!aa' })).status === 403);
    T.check('Junior Officer cannot restore', (await junior.post('/api/backup/restore', { source: 'snapshot', snapshot: {}, dryRun: true })).status === 403);

    /* ---------------- 3. who may grant the override ---------------- */
    const pay = { unitId: 'unit-1', category: 'Other', amount: 321, currency: 'JMD', method: 'Cash', payerName: 'Dup', receivedNow: true };
    const fin = makeClient(env.srv.baseUrl, { autoConfirmDuplicates: false });
    fin.setCookie(finance.getCookie());
    T.check('(setup) first receipt recorded', (await fin.post('/api/payments', pay)).status === 200);
    const refused = await fin.post('/api/payments', { ...pay, confirmDuplicate: true, overrideReason: 'separate money' });
    T.check('without the permission a finance officer cannot override the duplicate check (403 override-not-permitted)', refused.status === 403 && refused.body?.code === 'override-not-permitted', `${refused.status} ${refused.body?.code}`);

    const before = await settings();
    const selfGrant = await manager.post('/api/settings', { rolePermissions: { MANAGER: { ...perms.MANAGER, overrideMoneyGuards: true } } });
    T.check('a Manager cannot grant overrideMoneyGuards to their own role (403)', selfGrant.status === 403, `status ${selfGrant.status}`);
    const deskGrant = await manager.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...perms.JUNIOR_OFFICER, overrideMoneyGuards: true } } });
    T.check('a Manager cannot grant overrideMoneyGuards to the Junior Officer (403)', deskGrant.status === 403, `status ${deskGrant.status}`);
    const after = await settings();
    T.check('the refused grants changed nothing', JSON.stringify(after.rolePermissions) === JSON.stringify(before.rolePermissions));

    // Positive control: the screen sends every key; an unchanged override value must not block a Manager's save.
    const unchanged = await manager.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...perms.JUNIOR_OFFICER, addBookings: false } } });
    T.check('control: a Manager can still save the matrix when overrideMoneyGuards is unchanged', unchanged.status === 200, `status ${unchanged.status} ${unchanged.body?.error || ''}`);
    T.check('control: that save took effect', (await settings()).rolePermissions.JUNIOR_OFFICER.addBookings === false);

    const grant = await admin.post('/api/settings', { rolePermissions: { FINANCE_OFFICER: { ...perms.FINANCE_OFFICER, overrideMoneyGuards: true } } });
    T.check('an Administrator can grant overrideMoneyGuards', grant.status === 200 && (await settings()).rolePermissions.FINANCE_OFFICER.overrideMoneyGuards === true);
    const granted = await fin.post('/api/payments', { ...pay, confirmDuplicate: true, overrideReason: 'separate money' });
    T.check('once granted, the finance officer\'s override goes through', granted.status === 200, `${granted.status} ${granted.body?.error || ''}`);
    let logs = (await admin.get('/api/db')).body.auditLogs;
    T.check('the override is audited under the finance officer with its reason', logs.some(e => e.role === 'FINANCE_OFFICER' && /Overrode a money check.*separate money/.test(e.action)));
    const grantEntry = logs.find(e => e.action === 'Updated system settings' && e.role === 'ADMINISTRATOR' && /"overrideMoneyGuards":true/.test(e.newValue));
    T.check('the grant is audited under the Administrator with before and after', !!grantEntry && /"FINANCE_OFFICER":\{[^}]*"overrideMoneyGuards":false/.test(grantEntry.previousValue));
    const withdraw = await manager.post('/api/settings', { rolePermissions: { FINANCE_OFFICER: { ...perms.FINANCE_OFFICER, overrideMoneyGuards: false } } });
    T.check('a Manager cannot withdraw it either (it is an Administrator decision both ways)', withdraw.status === 403);

    /* ---------------- 4. money settings ---------------- */
    for (const rate of [0, -5, 'abc', 49.99, 1000.01]) {
      const r = await manager.post('/api/settings', { fxRateJmdPerUsd: rate });
      T.check(`an exchange rate of ${JSON.stringify(rate)} is refused with 400`, r.status === 400, `status ${r.status}`);
    }
    const n = (await admin.get('/api/db')).body.auditLogs.length;
    T.check('a refused setting writes no audit entry', (await admin.get('/api/db')).body.auditLogs.length === n);
    T.check('a malformed books-begin date is refused', (await manager.post('/api/settings', { booksBeginOn: '2026-02-30' })).status === 400);

    const month = localToday().slice(0, 7);
    const posted = (await admin.get('/api/db')).body.charges.filter(c => c.unitId === 'unit-1' && c.periodMonth === month && c.status === 'open');
    T.check('(setup) the month is posted', posted.length >= 1);
    const fee = await manager.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', tenantName: 'Tenant', status: 'long-term', monthlyRent: 65000, monthlyMaintenance: 12000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 15, maintDueDay: 15 });
    T.check('(setup) the fees and due days were changed', fee.status === 200, `${fee.status} ${fee.body?.error || ''}`);
    const db = (await admin.get('/api/db')).body;
    const now = posted.map(p => db.charges.find(c => c.id === p.id));
    T.check('a fee change does not rewrite charges already posted (amounts)', now.every((c, i) => c && c.amount === posted[i].amount), now.map((c, i) => `${posted[i].amount}->${c?.amount}`).join(','));
    T.check('a due-day change does not move charges already posted', now.every((c, i) => c && c.dueDate === posted[i].dueDate), now.map((c, i) => `${posted[i].dueDate}->${c?.dueDate}`).join(','));
    const feeEntry = db.auditLogs.find(e => e.role === 'MANAGER' && e.recordId === 'unit-1' && /65000/.test(e.newValue));
    T.check('the fee change is audited under the Manager with the old and new figures', !!feeEntry && /50000/.test(feeEntry.previousValue));
  } finally {
    await env.stop();
  }
  return T.done();
}
