/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The role permission matrix, and recordPayments as a permission that is granted
 * by default but can be withdrawn in System Settings.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Role permissions';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'PermTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'PermTest-1234!', 'PermNew-9876!');
    await makeLongTermUnit(admin);
    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });

    // Junior signs in and clears the forced password change, as they would on day one.
    const jr = makeClient(srv.baseUrl);
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });

    // Bill the month first, so the junior's payments settle a real charge rather
    // than tripping the "nothing has been billed yet" guard.
    await admin.post('/api/charges/post-month', { monthString: '2026-07' });

    const pay = () => jr.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 5000, currency: 'JMD', payerName: 'Walk-in', method: 'Cash' });

    // --- default: junior covers the desk ---
    T.check('junior has recordPayments by default', (await jr.get('/api/db')).body?.currentUser?.permissions?.recordPayments === true);
    T.check('junior can take a rent payment', (await pay()).status === 200);
    T.check('junior is still blocked from posting charges', (await jr.post('/api/charges/post-month', { monthString: '2026-06' })).status === 403);
    T.check('junior is still blocked from editing the unit register', (await jr.put('/api/units/unit-3', { number: '3', ownerName: 'X' })).status === 403);
    T.check('junior is still blocked from creating staff', (await jr.post('/api/users', { name: 'S', username: 's', role: 'ADMINISTRATOR', password: 'Sneak-1111!' })).status === 403);
    T.check('junior is still blocked from rewriting the permission matrix', (await jr.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { reversePayments: true } } })).status === 403);

    // The annual report is the document circulated to every proprietor and the
    // basis of the return to the Commission. It is gated on post_charges — the
    // person who runs the books — not on holding the desk.
    T.check(
      'junior is blocked from writing the annual report',
      (await jr.put('/api/annual-reports/2026', { narrative: { executiveSummary: 'Rewritten by the desk.' } })).status === 403
    );
    T.check(
      'and blocked from setting the contribution it proposes',
      (await jr.put('/api/annual-reports/2026', { proposedFee: 99000 })).status === 403
    );
    T.check(
      'and nothing of theirs was written even so',
      ((await admin.get('/api/db')).body.annualReports || []).length === 0,
      JSON.stringify((await admin.get('/api/db')).body.annualReports)
    );
    T.check(
      'while somebody who posts the charges can write it',
      (await admin.put('/api/annual-reports/2026', { narrative: { executiveSummary: 'Prepared by the office.' } })).status === 200
    );

    // --- withdraw it in Settings ---
    const off = await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { addBookings: true, recordPayments: false } } });
    T.check('the withdrawal is stored', off.body?.settings?.rolePermissions?.JUNIOR_OFFICER?.recordPayments === false);
    T.check('the change reaches the junior with no re-login', (await jr.get('/api/db')).body?.currentUser?.permissions?.recordPayments === false);
    T.check('junior can no longer take a payment', (await pay()).status === 403);

    // the utility settle side door is closed too
    const util = (await admin.post('/api/utilities', { unitId: 'unit-1', billingPeriod: '2026-07', previousReading: 0, currentReading: 50, amountCharged: 4000, currency: 'JMD' })).body.utility;
    await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { addBookings: true, enterUtilities: true, recordPayments: false } } });
    T.check('withdrawing payments also closes the utility-settle side door', (await jr.post(`/api/utilities/${util.id}/settle`, { method: 'Cash' })).status === 403);

    // --- grant it back ---
    await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { addBookings: true, recordPayments: true } } });
    T.check('junior can take payments again once granted', (await pay()).status === 200);

    // --- admin is never gated by the matrix ---
    T.check('an administrator is never blocked from recording a payment', (await admin.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 1000, currency: 'JMD', payerName: 'Admin', method: 'Cash' })).status === 200);

    // --- every settings change was audited ---
    // Three successful admin settings changes were made above (withdraw, add utilities, grant back);
    // the junior's rejected attempt writes nothing.
    const settingsAudits = (await admin.get('/api/db')).body.auditLogs.filter(a => a.recordType === 'Settings');
    T.check('every accepted permission change is audited, rejected ones are not', settingsAudits.length === 3, `${settingsAudits.length} recorded`);
  } finally {
    await srv.stop();
  }
  return T.done();
}
