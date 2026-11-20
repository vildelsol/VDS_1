/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two entities, two bank accounts, and a separate permission to tick them.
 *
 * Ro, 2026-11-20: "Separate bank accounts yes as they are 2 completely different
 * entities." The corporation (strata) and ISPO each reconcile their own
 * statement: an item that moved through one entity's account is never listed
 * on, or ticked against, the other's, and the same bank reference on each
 * statement is two different lines.
 *
 * And: "By default ... allow that for a junior, but make the permission an
 * option in settings for system admin and manager." Ticking the bank is its own
 * permission, granted by default, which an Administrator or Manager can
 * withdraw from a role in System Settings.
 *
 * Positive controls throughout. Dates are fixed in October 2026.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Bank reconciliation: one account per entity, its own permission';

async function bundle(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-banks-'));
  const outfile = path.join(dir, 'mod.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'bankRec.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Banks-1234!', projectRoot });
  const T = reporter(title);
  const rec = await bundle(projectRoot);
  try {
    const admin = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(admin, 'Banks-1234!', 'BanksNew-9876!');
    await makeLongTermUnit(admin, 'unit-1');

    const strataIn = (await recordAndConfirmPayment(admin, { unitId: 'unit-1', category: 'Other', amount: 8000, currency: 'JMD', payerName: 'Owner', method: 'Bank Transfer', date: '2026-10-02' })).body?.payment;
    const strataIn2 = (await recordAndConfirmPayment(admin, { unitId: 'unit-1', category: 'Other', amount: 3000, currency: 'JMD', payerName: 'Owner', method: 'Bank Transfer', date: '2026-10-03' })).body?.payment;
    const ispoCost = (await admin.post('/api/expenses', { category: 'Contractors', vendor: 'ISPO Plumber', description: 'tap', amount: 12000, currency: 'JMD', date: '2026-10-05', datePaid: '2026-10-05', status: 'paid', paymentMethod: 'Bank Transfer', fund: 'ispo' })).body?.expense;
    let db = (await admin.get('/api/db')).body;
    const tenancy = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    await admin.post(`/api/tenancies/${tenancy.id}/deposit`, { amount: 50000, currency: 'JMD', receivedOn: '2026-10-01' });
    T.check('setup: two corporation receipts, an ISPO cost and a deposit', !!strataIn?.id && !!strataIn2?.id && !!ispoCost?.id, JSON.stringify([strataIn?.id, ispoCost?.id]));

    /* ---------------- one account per entity ---------------- */
    db = (await admin.get('/api/db')).body;
    const input = { payments: db.payments, expenses: db.expenses, tenancies: db.tenancies, bookings: db.bookings };
    const strata = rec.mod.bankReconciliation(input, 'JMD', '2026-10-01', '2026-10-31', 'strata');
    const ispo = rec.mod.bankReconciliation(input, 'JMD', '2026-10-01', '2026-10-31', 'ispo');
    const ids = r => [...r.moneyIn.items, ...r.moneyOut.items].map(i => i.key);
    T.check('the corporation’s statement lists its receipts only', ids(strata).sort().join() === [`receipt:${strataIn.id}`, `receipt:${strataIn2.id}`].sort().join(), ids(strata).join());
    T.check('ISPO’s statement lists its cost and the deposit it holds', ids(ispo).includes(`expense:${ispoCost.id}`) && ids(ispo).includes(`deposit-received:${tenancy.id}`) && ids(ispo).length === 2, ids(ispo).join());
    const both = rec.mod.bankReconciliation(input, 'JMD', '2026-10-01', '2026-10-31');
    T.check('control: together they are everything, each item once', ids(both).length === ids(strata).length + ids(ispo).length);

    const wrong = await admin.post(`/api/expenses/${ispoCost.id}/reconcile`, { reconciledOn: '2026-10-06', currency: 'JMD', book: 'strata' });
    T.check('ISPO’s cost cannot be ticked on the corporation’s statement', wrong.status === 400 && wrong.body?.code === 'bank-book-mismatch', `${wrong.status} ${wrong.body?.code}`);
    const right = await admin.post(`/api/expenses/${ispoCost.id}/reconcile`, { reconciledOn: '2026-10-06', currency: 'JMD', book: 'ispo', reference: 'LINE-1' });
    T.check('control: it is ticked on ISPO’s statement', right.status === 200 && right.body?.record?.bankMatch?.on === '2026-10-06', `${right.status}`);
    const rWrong = await admin.post(`/api/payments/${strataIn.id}/reconcile`, { reconciledOn: '2026-10-03', currency: 'JMD', book: 'ispo' });
    T.check('a corporation receipt cannot be ticked on ISPO’s statement', rWrong.status === 400 && rWrong.body?.code === 'bank-book-mismatch', `${rWrong.status} ${rWrong.body?.code}`);

    const sameRef = await admin.post(`/api/payments/${strataIn.id}/reconcile`, { reconciledOn: '2026-10-03', currency: 'JMD', book: 'strata', reference: 'LINE-1' });
    T.check('the same reference on the other entity’s statement is a different line: no override needed', sameRef.status === 200, `${sameRef.status} ${sameRef.body?.code}`);
    const twin = await admin.post(`/api/payments/${strataIn2.id}/reconcile`, { reconciledOn: '2026-10-04', currency: 'JMD', book: 'strata', reference: 'LINE-1' });
    T.check('control: the same reference twice on one entity’s statement is still refused', twin.status === 400 && twin.body?.code === 'bank-line-already-matched', `${twin.status} ${twin.body?.code}`);

    /* ---------------- its own permission ---------------- */
    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    await admin.post('/api/users', { name: 'Manager Mo', username: 'manager', role: 'MANAGER', password: 'ManagerPass-11!' });
    const jr = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });
    const mgr = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await mgr.post('/api/auth/login', { username: 'manager', password: 'ManagerPass-11!' }, { captureCookie: true });
    await mgr.post('/api/auth/change-password', { currentPassword: 'ManagerPass-11!', newPassword: 'ManagerOwn-22!' });

    const perms = (await admin.get('/api/db')).body.settings.rolePermissions.JUNIOR_OFFICER;
    T.check('a junior officer may tick the bank by default', perms.reconcileBank !== false, JSON.stringify(perms));
    const jrTick = await jr.post(`/api/tenancies/${tenancy.id}/deposit-received/reconcile`, { reconciledOn: '2026-10-02', currency: 'JMD', book: 'ispo' });
    T.check('and does', jrTick.status === 200, `${jrTick.status} ${jrTick.body?.error}`);

    const withdraw = await mgr.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...perms, reconcileBank: false } } });
    T.check('a Manager can withdraw it in System Settings', withdraw.status === 200, `${withdraw.status} ${JSON.stringify(withdraw.body).slice(0, 200)}`);
    const denied = await jr.post(`/api/payments/${strataIn2.id}/reconcile`, { reconciledOn: '2026-10-04', currency: 'JMD', book: 'strata' });
    T.check('then the junior cannot tick a receipt', denied.status === 403, `${denied.status}`);
    const deniedOut = await jr.post(`/api/tenancies/${tenancy.id}/deposit-received/reconcile`, { reconciled: false });
    T.check('nor un-tick money in or out', deniedOut.status === 403, `${deniedOut.status}`);
    const till = await recordAndConfirmPayment(jr, { unitId: 'unit-1', category: 'Other', amount: 500, currency: 'JMD', payerName: 'Owner', method: 'Cash', date: '2026-10-07' });
    T.check('control: the junior still takes money; only the bank tick is separated', till.status === 200, `${till.status} ${till.body?.error}`);

    const restore = await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...perms, reconcileBank: true } } });
    const again = await jr.post(`/api/payments/${strataIn2.id}/reconcile`, { reconciledOn: '2026-10-04', currency: 'JMD', book: 'strata' });
    T.check('an Administrator can give it back, and it works again', restore.status === 200 && again.status === 200, `${restore.status} ${again.status}`);

    const ui = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'Reconciliation.tsx'), 'utf8');
    T.check('the screen asks whose bank account and gates on the new permission', /rc-book/.test(ui) && /reconcileBank/.test(ui));
  } finally {
    rec.cleanup();
    await srv.stop();
  }
  return T.done();
}
