/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rent is never billed on an owner-occupied villa (found 2026-11-16: the server took
 * a Rent charge on one, then its own integrity check called that SERIOUS).
 *
 *  1. A Rent charge on an owner-occupied villa is refused; a Maintenance one is not.
 *  2. A let villa that owes rent cannot become owner-occupied until the rent is
 *     collected or written off (manager/admin decision); nothing is lost silently.
 *  3. A fully paid villa switches freely, and paid history is not called "billed now".
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, localToday } from './harness.mjs';

export const title = 'Rent on an owner-occupied villa: refused, and the switch cannot strand unpaid rent';

async function signedIn(baseUrl, admin, username, role) {
  const pw = `Pw-${username}-1234!`;
  await admin.post('/api/users', { name: username, username, role, password: pw });
  const c = makeClient(baseUrl);
  await c.post('/api/auth/login', { username, password: pw }, { captureCookie: true });
  await c.post('/api/auth/change-password', { currentPassword: pw, newPassword: pw + 'x' });
  return c;
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Rov-1234!', projectRoot });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Rov-1234!', 'RovNew-9876!');
    const jr = await signedIn(srv.baseUrl, c, 'jr', 'JUNIOR_OFFICER');
    const today = localToday();
    const [y, m] = today.split('-').map(Number);
    const lastMonth = m === 1 ? `${y - 1}-12-05` : `${y}-${String(m - 1).padStart(2, '0')}-05`;
    const owner = { number: '1', ownerName: 'Owner', status: 'owner-occupied', monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 };
    const serious = async () => ((await c.get('/api/integrity')).body.findings || []).filter(f => f.severity === 'serious');
    const db = async () => (await c.get('/api/db')).body;

    /* ---- 1. refusing the entry ---- */
    await c.put('/api/units/unit-1', owner);
    const control = await c.post('/api/charges', { unitId: 'unit-1', category: 'Maintenance', oneOffType: 'Late fee', amount: 2000, currency: 'JMD', dueDate: lastMonth, description: 'control' });
    T.check('control: a maintenance one-off on an owner-occupied villa is accepted', control.status === 200, `status ${control.status}`);
    const rent = await c.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 5000, currency: 'JMD', dueDate: lastMonth, description: 'rent on an owner' });
    T.check('a rent one-off on an owner-occupied villa is refused with a reason', rent.status === 400 && /owner-occupied/i.test(rent.body?.error || ''), `status ${rent.status}`);
    T.check('the integrity check stays clean', (await serious()).length === 0);

    /* ---- 2. unpaid rent blocks the switch ---- */
    await makeLongTermUnit(c, 'unit-2', { monthlyRent: 50000, monthlyMaintenance: 10000 });
    const owed = await c.post('/api/charges', { unitId: 'unit-2', category: 'Rent', oneOffType: 'Late fee', amount: 7000, currency: 'JMD', dueDate: lastMonth, description: 'unpaid' });
    T.check('control: rent on a let villa is accepted', owed.status === 200, `status ${owed.status}`);
    const toOwner = { number: '2', ownerName: 'Owner', status: 'owner-occupied', monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1, tenantChangeIntent: 'moved-out' };
    const refused = await c.put('/api/units/unit-2', toOwner);
    T.check('switching a villa that owes rent to owner-occupied is refused with the collect-or-write-off code', refused.status === 400 && refused.body?.code === 'former-tenant-owes', `status ${refused.status} ${refused.body?.code}`);
    T.check('the villa is unchanged after the refusal', (await db()).units.find(u => u.id === 'unit-2').status === 'long-term');
    T.check('the unpaid charge is still there, untouched', (await db()).charges.some(x => x.id === owed.body.charge.id && x.status === 'open'));
    const juniorTry = await jr.put('/api/units/unit-2', { ...toOwner, formerArrears: 'write-off' });
    T.check('a junior cannot write the rent off (refused, nothing changed)', juniorTry.status >= 400 && (await db()).units.find(u => u.id === 'unit-2').status === 'long-term', `status ${juniorTry.status}`);
    const done = await c.put('/api/units/unit-2', { ...toOwner, formerArrears: 'write-off' });
    T.check('an administrator can write it off and the villa switches', done.status === 200, `status ${done.status} ${done.body?.error || ''}`);
    const after = await db();
    T.check('the unpaid rent is voided with a reason, kept as history', after.charges.find(x => x.id === owed.body.charge.id)?.status === 'void' && /owner-occupied/.test(after.charges.find(x => x.id === owed.body.charge.id)?.voidReason || ''));
    T.check('the write-off is in the audit trail', (after.auditLogs || []).some(a => /wrote off/i.test(a.action || '') && /owner-occupied/i.test(a.action || '')));
    T.check('the integrity check is clean after the write-off', (await serious()).length === 0);

    /* ---- 3. paid-up villa switches freely ---- */
    await makeLongTermUnit(c, 'unit-3', { monthlyRent: 50000, monthlyMaintenance: 10000 });
    await c.post('/api/charges', { unitId: 'unit-3', category: 'Rent', oneOffType: 'Late fee', amount: 3000, currency: 'JMD', dueDate: lastMonth, description: 'paid' });
    const pay = await c.post('/api/payments', { unitId: 'unit-3', category: 'Rent', amount: 3000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', date: today, receivedNow: true });
    T.check('control: the rent was received', pay.status === 200, `status ${pay.status}`);
    const free = await c.put('/api/units/unit-3', { ...owner, number: '3', tenantChangeIntent: 'moved-out' });
    T.check('a paid-up villa switches to owner-occupied with no prompt', free.status === 200, `status ${free.status} ${free.body?.error || ''}`);
    T.check('paid rent history is not reported as rent billed now', (await serious()).length === 0, (await serious()).map(f => f.code).join(','));

    return T.done();
  } finally {
    await srv.stop();
  }
}
