/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every write reaches the audit trail, under the person who made it, and the
 * trail still verifies afterwards.
 *
 * The audit is only worth what it covers. A route that changes money or a record
 * and writes no entry is a hole nobody notices: the screens show the change, the
 * books add up, and the trail is silent about who did it. Counting `addAudit(` in
 * the source cannot see that (an entry inside a branch the request never takes
 * still counts), so this suite drives each write for real, as a named member of
 * staff, and compares the trail before and after.
 *
 * For each action it asserts:
 *   - the request succeeded (a refused request proves nothing: setup fails loudly);
 *   - at least one NEW entry appeared, attributed to the acting user and role
 *     (taken from the session, never the request);
 *   - the trail verifies in the keyed chain afterwards (no audit-trail-broken,
 *     no audit-key-missing).
 *
 * Positive control: a read (GET /api/db) adds no entry, so "a new entry
 * appeared" is not satisfied by background noise.
 *
 * It also pins the route list: every write route declared in server.ts must be
 * either exercised here or named in NOT_RECORDS with the reason, so a new write
 * route cannot arrive without its audit being looked at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { reporter, localToday, sleep, receiveOverpayment } from './harness.mjs';
import { boot } from './security-kit.mjs';

export const title = 'Audit records: every write is audited, attributed and sealed';

/** Write routes that change no record of the property, with the reason. */
const NOT_RECORDS = {
  'POST /api/backup/check-folder': 'writes and deletes a probe file in a folder; no record changes',
  'POST /api/auth/logout': 'covered: audited, but exercised separately because it ends the session',
  'POST /api/backup/restore': 'covered by security-audit-backup and audit-records-settings (restore keeps the trail)'
};

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const env = await boot(port, projectRoot);
  const { admin, manager, finance, users } = env;
  const nameOf = username => users.find(u => u.username === username)?.name;
  const exercised = new Set();
  const month = localToday().slice(0, 7);
  const today = localToday();

  const trail = async () => (await admin.get('/api/db')).body.auditLogs;

  /** Run one write and check it left an attributed entry. */
  async function audited(key, label, who, fn, { expectUser, expectRole } = {}) {
    exercised.add(key);
    const before = new Set((await trail()).map(e => e.id));
    const r = await fn();
    if (r.status >= 400) {
      T.check(`(setup) ${label} succeeded`, false, `${key} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      return r;
    }
    await sleep(60);
    const fresh = (await trail()).filter(e => !before.has(e.id));
    const user = expectUser || nameOf(who.username);
    const role = expectRole || who.role;
    const mine = fresh.filter(e => e.user === user && e.role === role);
    T.check(
      `${label}: writes an audit entry under ${user} (${role})`,
      mine.length >= 1,
      `${key}: ${fresh.length} new entries: ${fresh.map(e => `${e.user}/${e.role}: ${e.action}`).join(' | ') || 'none'}`
    );
    return r;
  }

  /** A write that changed nothing must not write an entry either. */
  async function quiet(key, label, fn, changedNothing) {
    exercised.add(key);
    const n = (await trail()).length;
    const r = await fn();
    T.check(`(setup) ${label} succeeded and changed nothing`, r.status < 400 && changedNothing(r), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    T.check(`${label}: no audit entry for a no-op`, (await trail()).length === n);
  }

  const M = { username: 'manager', role: 'MANAGER' };
  const F = { username: 'finance', role: 'FINANCE_OFFICER' };
  const A = { username: 'admin', role: 'ADMINISTRATOR' };

  try {
    /* positive control: a read writes nothing */
    const n0 = (await trail()).length;
    await manager.get('/api/db');
    await manager.get('/api/integrity');
    T.check('control: reading the records adds no audit entry', (await trail()).length === n0);

    /* ---------------- villas and tenancies ---------------- */
    await audited('PUT /api/units/:id', 'editing a villa', M, () =>
      manager.put('/api/units/unit-1', { number: '1', ownerName: 'Owner One', tenantName: 'Tenant One', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 })
    );
    {
      // Dated levy changes (feat-fee-schedule): a month after this one, so nothing posted is touched.
      const [fy, fm] = month.split('-').map(Number);
      const nextMonth = fm === 12 ? `${fy + 1}-01` : `${fy}-${String(fm + 1).padStart(2, '0')}`;
      await audited('POST /api/units/:id/fee-schedule', 'adding a dated levy change', M, () =>
        manager.post('/api/units/unit-1/fee-schedule', { effectiveFrom: nextMonth, amount: 12000, currency: 'JMD' })
      );
      await audited('DELETE /api/units/:id/fee-schedule/:month', 'removing a dated levy change', M, () =>
        manager.del(`/api/units/unit-1/fee-schedule/${nextMonth}`)
      );
      await audited('POST /api/fee-schedule', 'adding a property-wide levy change', M, () =>
        manager.post('/api/fee-schedule', { effectiveFrom: nextMonth, amount: 12000, currency: 'JMD' })
      );
    }
    let db = (await admin.get('/api/db')).body;
    const tenancy = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    T.check('(setup) unit-1 has an active tenancy', !!tenancy);
    await audited('PUT /api/tenancies/:id', 'editing a tenancy', M, () => manager.put(`/api/tenancies/${tenancy.id}`, { notes: 'audit probe' }));
    await audited('POST /api/tenancies/:id/deposit', 'taking a security deposit', F, () =>
      finance.post(`/api/tenancies/${tenancy.id}/deposit`, { amount: 50000, currency: 'JMD', method: 'Cash', receivedOn: today })
    );

    /* ---------------- charges ---------------- */
    await audited('POST /api/charges/post-month', 'posting a month', F, () => finance.post('/api/charges/post-month', { monthString: month }));
    const oneOff = await audited('POST /api/charges', 'raising a one-off charge', F, () =>
      finance.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Other', amount: 1234, description: 'audit probe' })
    );
    const oneOffId = oneOff.body?.charge?.id;
    await audited('POST /api/charges/:id/void', 'voiding a charge', M, () => manager.post(`/api/charges/${oneOffId}/void`, { reason: 'raised in error' }));
    // With nothing to restate these change nothing, so they must write nothing either;
    // the per-move audit lines are pinned by restate-rent and restate-receipts.
    await quiet('POST /api/charges/restate-rent', 'restating rent with nothing to restate', () => manager.post('/api/charges/restate-rent', { confirm: true }), r => r.body?.done === 0 || r.body?.restated === 0 || r.body?.count === 0);
    await quiet('POST /api/payments/restate-maintenance-receipts', 'restating receipts with nothing to move', () =>
      manager.post('/api/payments/restate-maintenance-receipts', { confirm: true }), r => r.body?.moved === 0);

    /* ---------------- payments ---------------- */
    const pay = await audited('POST /api/payments', 'recording a payment', F, () =>
      finance.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 5000, currency: 'JMD', method: 'Cash', payerName: 'Tenant One' })
    );
    const payId = pay.body?.payment?.id;
    await audited('PUT /api/payments/:id', 'correcting a payment', M, () => manager.put(`/api/payments/${payId}`, { reason: 'corrected in test', notes: 'audit probe' }));
    await audited('POST /api/payments/:id/confirm', 'confirming a payment', F, () => finance.post(`/api/payments/${payId}/confirm`, {}));
    await audited('POST /api/payments/:id/reconcile', 'reconciling a payment', F, () =>
      finance.post(`/api/payments/${payId}/reconcile`, { reconciledOn: today, reference: 'BNK-1' })
    );
    // The first print is the original receipt and is not an event; every copy after it is.
    await finance.post(`/api/payments/${payId}/mark-printed`, {});
    await audited('POST /api/payments/:id/mark-printed', 'reprinting a receipt', F, () => finance.post(`/api/payments/${payId}/mark-printed`, {}));
    const overPay = await receiveOverpayment(finance, 'unit-1', 'Rent', 5000);
    T.check('(setup) an overpayment was recorded', !!overPay);
    const over = { body: { payment: overPay } };
    await audited('POST /api/payments/:id/refund', 'refunding unspent credit', M, () =>
      manager.post(`/api/payments/${over.body?.payment?.id}/refund`, { amount: 1000, reason: 'overpaid', method: 'Cash' })
    );
    await audited('POST /api/payments/:id/refund/reconcile', 'matching a refund to the statement', F, () =>
      finance.post(`/api/payments/${over.body?.payment?.id}/refund/reconcile`, { reconciledOn: today, reference: 'BNK-OUT-1' })
    );
    const pay2 = await finance.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 700, currency: 'JMD', method: 'Cash', payerName: 'Tenant One', receivedNow: true });
    await audited('POST /api/payments/:id/reverse', 'reversing a payment', M, () =>
      manager.post(`/api/payments/${pay2.body?.payment?.id}/reverse`, { reversalReason: 'entered twice' })
    );

    /* ---------------- bookings ---------------- */
    await manager.put('/api/units/unit-2', { number: '2', ownerName: 'Owner Two', status: 'short-term', currency: 'USD', maintCurrency: 'JMD', monthlyMaintenance: 10000, maintDueDay: 1 });
    const dayAhead = n => { const d = new Date(); d.setDate(d.getDate() + n); const p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
    const bk = await audited('POST /api/bookings', 'creating a reservation', M, () =>
      manager.post('/api/bookings', { unitId: 'unit-2', guestName: 'Guest', checkIn: dayAhead(10), checkOut: dayAhead(13), amount: 900, depositPaid: 0, currency: 'USD', source: 'Direct' })
    );
    const bkId = bk.body?.booking?.id;
    await audited('PUT /api/bookings/:id', 'editing a reservation', M, () => manager.put(`/api/bookings/${bkId}`, { editReason: 'Test correction', guestName: 'Guest Edited' }));
    await audited('POST /api/bookings/:id/damage-deposit', 'taking a damage deposit', F, () =>
      manager.post(`/api/bookings/${bkId}/damage-deposit`, { amount: 200, currency: 'USD', method: 'Cash', receivedOn: today })
    , { expectUser: nameOf('manager'), expectRole: 'MANAGER' });
    await audited('POST /api/bookings/:id/damage-deposit-received/reconcile', 'matching a damage deposit received to the statement', F, () =>
      finance.post(`/api/bookings/${bkId}/damage-deposit-received/reconcile`, { reconciledOn: today })
    );
    await audited('POST /api/bookings/:id/damage-deposit/settle', 'settling a damage deposit', M, () =>
      manager.post(`/api/bookings/${bkId}/damage-deposit/settle`, { withheldAmount: 0, returnedAmount: 200 })
    );
    await audited('POST /api/bookings/:id/damage-deposit/reconcile', 'matching a returned damage deposit to the statement', F, () =>
      finance.post(`/api/bookings/${bkId}/damage-deposit/reconcile`, { reconciledOn: today })
    );

    /* ---------------- utilities and expenses ---------------- */
    const ut = await audited('POST /api/utilities', 'entering a utility bill', M, () =>
      manager.post('/api/utilities', { unitId: 'unit-1', type: 'Water', billingPeriod: month, amountCharged: 3000, currency: 'JMD', previousReading: 100, currentReading: 140 })
    );
    const utId = ut.body?.utility?.id || ut.body?.reading?.id;
    await audited('PUT /api/utilities/:id', 'correcting a utility bill', M, () => manager.put(`/api/utilities/${utId}`, { amountCharged: 3100 }));
    await audited('POST /api/utilities/:id/settle', 'settling a utility bill', M, () =>
      manager.post(`/api/utilities/${utId}/settle`, { method: 'Cash', payerName: 'Tenant One' })
    );
    const ex = await audited('POST /api/expenses', 'recording an expense', F, () =>
      finance.post('/api/expenses', { category: 'Landscaping', amount: 5000, currency: 'JMD', date: today, description: 'Gardening', vendor: 'A gardener' })
    );
    const exId = ex.body?.expense?.id;
    await audited('PUT /api/expenses/:id', 'correcting an expense', M, () => manager.put(`/api/expenses/${exId}`, { description: 'Gardening, front beds' }));
    await audited('POST /api/expenses/:id/reconcile', 'matching a paid cost to the statement', F, () =>
      finance.post(`/api/expenses/${exId}/reconcile`, { reconciledOn: today })
    );
    await audited('POST /api/expenses/:id/void', 'voiding an expense', M, () => manager.post(`/api/expenses/${exId}/void`, { reason: 'entered against the wrong month', confirmSettled: true }));
    const rec = await audited('POST /api/recurring-expenses', 'adding a monthly cost', F, () =>
      finance.post('/api/recurring-expenses', { category: 'Security', amount: 20000, currency: 'JMD', description: 'Guards', vendor: 'Atlas Security Jamaica', dayOfMonth: 1, active: true })
    );
    const recId = rec.body?.recurringExpense?.id || rec.body?.template?.id || rec.body?.recurring?.id;
    await audited('PUT /api/recurring-expenses/:id', 'changing a monthly cost', F, () => finance.put(`/api/recurring-expenses/${recId}`, { amount: 21000 }));
    await audited('POST /api/expenses/post-month', 'posting the monthly costs', F, () => finance.post('/api/expenses/post-month', { monthString: month }));
    await audited('POST /api/expenses/recall-month', 'recalling the monthly costs', M, () =>
      manager.post('/api/expenses/recall-month', { monthString: month, reason: 'posted too early' })
    );
    await audited('DELETE /api/recurring-expenses/:id', 'deleting a monthly cost', M, () => manager.del(`/api/recurring-expenses/${recId}`));

    /* ---------------- activities, reports, feeds ---------------- */
    const act = await audited('POST /api/unit-activities', 'logging a resident activity', F, () =>
      finance.post('/api/unit-activities', { unitId: 'unit-1', residentName: 'Tenant One', residentRole: 'Tenant', activityType: 'Maintenance Request', dateCaptured: today, notes: 'probe' })
    );
    const actId = act.body?.activity?.id;
    await audited('PUT /api/unit-activities/:id', 'editing a resident activity', F, () => finance.put(`/api/unit-activities/${actId}`, { notes: 'probe edited' }));
    await audited('DELETE /api/unit-activities/:id', 'deleting a resident activity', F, () => finance.del(`/api/unit-activities/${actId}`));
    await audited('PUT /api/annual-reports/:year', 'saving an annual report', F, () => finance.put(`/api/annual-reports/${month.slice(0, 4)}`, { notes: 'probe' }));
    const feed = await audited('POST /api/ical/feeds', 'linking a calendar feed', M, () =>
      manager.post('/api/ical/feeds', { unitId: 'unit-2', url: 'https://www.airbnb.com/calendar/ical/1.ics', source: 'Airbnb' })
    );
    const feedId = feed.body?.feed?.id;
    exercised.add('POST /api/ical/sync'); // needs a reachable feed; its audit lines are covered by calendar-sync
    await audited('DELETE /api/ical/feeds/:id', 'removing a calendar feed', M, () => manager.del(`/api/ical/feeds/${feedId}`));

    /* ---------------- tenancy end ---------------- */
    await audited('POST /api/tenancies/:id/deposit-received/reconcile', 'matching a deposit received to the statement', F, () =>
      finance.post(`/api/tenancies/${tenancy.id}/deposit-received/reconcile`, { reconciledOn: today })
    );
    await audited('POST /api/tenancies/:id/deposit/settle', 'settling a security deposit', M, () =>
      manager.post(`/api/tenancies/${tenancy.id}/deposit/settle`, { returnedAmount: 50000, withheldAmount: 0 })
    );
    await audited('POST /api/tenancies/:id/deposit/reconcile', 'matching a returned deposit to the statement', F, () =>
      finance.post(`/api/tenancies/${tenancy.id}/deposit/reconcile`, { reconciledOn: today })
    );
    await audited('POST /api/tenancies/:id/evict', 'ending a tenancy by eviction', M, () =>
      manager.post(`/api/tenancies/${tenancy.id}/evict`, { reason: 'Non payment of rent', effectiveDate: today })
    );

    /* ---------------- settings, periods, backups, users ---------------- */
    await audited('POST /api/settings', 'changing system settings', M, () => manager.post('/api/settings', { fxRateJmdPerUsd: 158 }));
    const prev = (() => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
    await audited('POST /api/periods/close', 'closing a month', M, () => manager.post('/api/periods/close', { through: prev, confirmFaults: true, reason: 'month end' }));
    await audited('POST /api/periods/reopen', 'reopening a month', M, () => manager.post('/api/periods/reopen', { reason: 'late cheque' }));
    await audited('POST /api/backup/run', 'taking a backup', M, () => manager.post('/api/backup/run', {}));
    const nu = await audited('POST /api/users', 'creating a staff account', A, () =>
      admin.post('/api/users', { name: 'Probe User', username: 'probe', role: 'JUNIOR_OFFICER', password: 'Probe-Pass-1234!' })
    );
    const nuId = nu.body?.user?.id || (await admin.get('/api/db')).body.users.find(u => u.username === 'probe')?.id;
    await audited('PUT /api/users/:id', 'changing a staff account', A, () => admin.put(`/api/users/${nuId}`, { name: 'Probe User Renamed' }));
    await audited('POST /api/users/:id/reset-password', 'resetting a password', A, () => admin.post(`/api/users/${nuId}/reset-password`, { password: 'Probe-Reset-1234!' }));
    await audited('POST /api/auth/throttles/clear', 'clearing a sign-in lockout', A, () => admin.post('/api/auth/throttles/clear', { username: 'probe' }));
    exercised.add('POST /api/auth/login');
    exercised.add('POST /api/auth/change-password'); // both exercised by boot(); asserted below
    db = (await admin.get('/api/db')).body;
    T.check('signing in is audited under the user', db.auditLogs.some(e => e.user === nameOf('finance') && /sign/i.test(e.action)));
    T.check('changing a password is audited under the user', db.auditLogs.some(e => e.user === nameOf('finance') && /password/i.test(e.action)));

    /* ---------------- the route list is complete ---------------- */
    const src = fs.readFileSync(path.join(projectRoot, 'server.ts'), 'utf8');
    const writes = [...src.matchAll(/\bapp\.(post|put|patch|delete)\(\s*['"`](\/api[^'"`]+)['"`]/g)].map(m => `${m[1].toUpperCase()} ${m[2]}`);
    T.check('(control) the write-route table parsed from server.ts is non-trivial', writes.length >= 50, `${writes.length}`);
    const unlooked = writes.filter(k => !exercised.has(k) && !(k in NOT_RECORDS));
    T.check('every write route is exercised for its audit entry or classified with a reason', unlooked.length === 0, unlooked.join('; '));

    /* ---------------- the chain verifies after all of it ---------------- */
    const integ = (await admin.get('/api/integrity')).body;
    const chain = integ.findings.filter(f => /^audit-/.test(f.code)).map(f => f.code);
    T.check('the trail verifies in the keyed chain after every write above', !chain.includes('audit-trail-broken') && !chain.includes('audit-key-missing'), chain.join(','));
    const all = (await trail());
    T.check('every entry is keyed (hmac-sha256) once the key exists', all.every(e => e.sealKind === 'hmac-sha256'), `${all.filter(e => e.sealKind !== 'hmac-sha256').length} unkeyed`);
    T.check('no entry is attributed to an empty user', all.every(e => typeof e.user === 'string' && e.user.trim() && typeof e.role === 'string' && e.role.trim()));
  } finally {
    await env.stop();
  }
  return T.done();
}
