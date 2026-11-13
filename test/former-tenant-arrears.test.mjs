/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A new tenant never inherits the last tenant's rent debt, and never their credit.
 *
 * Rent is raised against the villa and the account balance adds up every open rent
 * charge on it, applying payments oldest first. Two faults followed from that:
 *
 *  - A tenant who left owing kept that rent open, where it was counted as the next
 *    tenant's arrears and paid off with the next tenant's own money. Eviction wrote
 *    its rent off; an ordinary changeover did not.
 *  - Eviction wrote off EVERY open rent charge, paid months included. A tenant who
 *    paid a month and owed a month was written off at twice what they owed, leaving
 *    the surplus on the villa as a credit for whoever came next.
 *
 * The test reads each villa's balance from the raw ledger, not from the code that
 * wrote the debt off.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, localToday } from './harness.mjs';

export const title = 'Former tenant arrears and credit never reach the next tenant';

function monthsAgo(n) {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - n, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}
const cents = v => Math.round(v * 100);

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Former-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Former-1234!', 'FormerNew-9876!');
    const unitBody = (n, over = {}) => ({
      number: String(n), ownerName: 'Owner', tenantName: 'Old Tenant', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000,
      currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, ...over
    });
    const put = (n, over = {}) => c.put(`/api/units/unit-${n}`, unitBody(n, over));
    const db = async () => (await c.get('/api/db')).body;
    /** Open rent charged to `who` minus rent received on the villa, straight from the rows: what the former tenant's account now shows. */
    const rentBalance = async (n, who) => {
      const d = await db();
      const owed = d.charges.filter(x => x.unitId === `unit-${n}` && x.category === 'Rent' && x.status === 'open' && x.currency === 'JMD' && (!who || x.payerName === who)).reduce((a, x) => a + cents(x.amount), 0);
      const paid = d.payments.filter(x => x.unitId === `unit-${n}` && x.category === 'Rent' && x.status === 'completed' && x.currency === 'JMD').reduce((a, x) => a + cents(x.amount) - cents(x.refundedAmount || 0), 0);
      return (owed - paid) / 100;
    };
    const pay = (n, amount, who) =>
      c.post('/api/payments', { unitId: `unit-${n}`, category: 'Rent', amount, currency: 'JMD', payerName: who, method: 'Cash', receivedNow: true, confirmAlreadySettled: true });
    const villa = async (n, tenant, months, paid) => {
      await makeLongTermUnit(c, `unit-${n}`, { number: String(n), tenantName: tenant });
      for (const m of months) await c.post('/api/charges/post-month', { monthString: monthsAgo(m) });
      if (paid) await pay(n, paid, tenant);
    };

    /* ---------------- 1. owes two months, nothing paid ---------------- */

    await villa(1, 'Old Tenant', [2, 1]);
    const refused = await put(1, { tenantName: 'New Tenant', tenantChangeIntent: 'changeover' });
    T.check('a changeover while the old tenant owes is refused', refused.status === 400 && refused.body?.code === 'former-tenant-owes', `${refused.status} ${refused.body?.code}`);
    T.check('the refusal says who owes what', /Old Tenant/.test(refused.body?.error) && /JMD 100000/.test(refused.body?.error), String(refused.body?.error).slice(0, 160));
    let d = await db();
    T.check('nothing changed', d.tenancies.filter(t => t.status === 'active').every(t => t.tenantName === 'Old Tenant') && !d.tenancies.some(t => t.tenantName === 'New Tenant'));

    const done = await put(1, { tenantName: 'New Tenant', tenantChangeIntent: 'changeover', formerArrears: 'write-off' });
    T.check('with the write-off stated, the changeover goes through', done.status === 200, String(done.body?.error || ''));
    d = await db();
    T.check('the old tenant\'s rent is void, not deleted, with a reason', d.charges.filter(x => x.unitId === 'unit-1' && x.payerName === 'Old Tenant' && x.category === 'Rent').every(x => x.status === 'void' && /Written off/.test(x.voidReason || '')));
    T.check('every remaining open rent charge is the new tenant\'s', d.charges.filter(x => x.unitId === 'unit-1' && x.category === 'Rent' && x.status === 'open').every(x => x.payerName === 'New Tenant'));
    T.check('the figure is kept on the former tenancy', d.tenancies.find(t => t.tenantName === 'Old Tenant')?.writeOffAmount === 100000, String(d.tenancies.find(t => t.tenantName === 'Old Tenant')?.writeOffAmount));
    T.check('and it is in the audit trail', d.auditLogs.some(a => /Wrote off JMD 100000/.test(a.action)));

    /* ---------------- 2. paid one month, owes one: only the unpaid month is the debt ---------------- */

    await villa(2, 'Half Tenant', [2, 1], 50000);
    const r2 = await put(2, { tenantName: 'Next Tenant', tenantChangeIntent: 'changeover' });
    T.check('only what is unpaid is named: JMD 50000, not JMD 100000', r2.status === 400 && /JMD 50000\b/.test(r2.body?.error) && !/JMD 100000/.test(r2.body?.error), String(r2.body?.error).slice(0, 140));
    const w2 = await put(2, { tenantName: 'Next Tenant', tenantChangeIntent: 'changeover', formerArrears: 'write-off' });
    T.check('written off', w2.status === 200, String(w2.body?.error || ''));
    d = await db();
    const mine2 = d.charges.filter(x => x.unitId === 'unit-2' && x.category === 'Rent' && x.payerName === 'Half Tenant');
    T.check('the month they paid is left open and settled, the month they owed is void', mine2.filter(x => x.status === 'open').length === 1 && mine2.filter(x => x.status === 'void').length === 1);
    T.check('so the villa carries NO credit from the old tenant to the new one', (await rentBalance(2, 'Half Tenant')) === 0, String(await rentBalance(2, 'Half Tenant')));
    T.check('and the write-off is JMD 50000', d.tenancies.find(t => t.tenantName === 'Half Tenant')?.writeOffAmount === 50000);

    /* ---------------- 3. a part payment ---------------- */

    await villa(3, 'Part Tenant', [1], 20000);
    const w3 = await put(3, { tenantName: 'Part Successor', tenantChangeIntent: 'changeover', formerArrears: 'write-off' });
    T.check('a part-paid month can be written off', w3.status === 200, String(w3.body?.error || ''));
    d = await db();
    T.check('the part that was paid stays as its own settled charge', d.charges.some(x => x.unitId === 'unit-3' && x.status === 'open' && x.amount === 20000 && x.payerName === 'Part Tenant'));
    T.check('and the villa nets to zero: no credit and no debt carried forward', (await rentBalance(3, 'Part Tenant')) === 0, String(await rentBalance(3, 'Part Tenant')));
    T.check('only the unpaid JMD 30000 is written off', d.tenancies.find(t => t.tenantName === 'Part Tenant')?.writeOffAmount === 30000, String(d.tenancies.find(t => t.tenantName === 'Part Tenant')?.writeOffAmount));
    const integ = (await c.get('/api/integrity')).body;
    T.check('the books stay consistent after the split', !integ.findings.some(f => ['rent-split-does-not-add-up', 'month-billed-twice', 'balance-does-not-reconcile'].includes(f.code)), JSON.stringify(integ.findings.map(f => f.code)));

    /* ---------------- 4. paid in full: nothing to write off, nothing blocks ---------------- */

    await villa(4, 'Tidy Tenant', [2, 1], 100000);
    const t4 = await put(4, { tenantName: 'Tidy Successor', tenantChangeIntent: 'changeover' });
    T.check('a changeover after a tenant who paid in full needs no write-off', t4.status === 200, `${t4.status} ${t4.body?.error || ''}`);
    T.check('and leaves their paid months alone', (await db()).charges.filter(x => x.unitId === 'unit-4' && x.payerName === 'Tidy Tenant' && x.status === 'open').length === 2);

    /* ---------------- 5. eviction: writes off what is owed, not what was paid ---------------- */

    await villa(5, 'Evicted Tenant', [2, 1], 50000);
    const ten = (await db()).tenancies.find(t => t.unitId === 'unit-5' && t.status === 'active');
    const ev = await c.post(`/api/tenancies/${ten.id}/evict`, { reason: 'Non payment of rent', effectiveDate: localToday() });
    T.check('eviction writes off only the JMD 50000 actually owed', ev.status === 200 && ev.body?.writtenOff === 50000, `${ev.status} ${ev.body?.writtenOff} ${ev.body?.error || ''}`);
    T.check('the month the tenant paid is not voided', (await db()).charges.filter(x => x.unitId === 'unit-5' && x.category === 'Rent' && x.status === 'open').length === 1);
    T.check('so no credit is left on the villa for the next tenant', (await rentBalance(5, 'Evicted Tenant')) === 0, String(await rentBalance(5, 'Evicted Tenant')));
    const nxt = await put(5, { tenantName: 'After Eviction', tenantChangeIntent: 'changeover' });
    T.check('and the next tenant is recorded with nothing to confirm', nxt.status === 200, `${nxt.status} ${nxt.body?.error || ''}`);

    /* ---------------- 6. leaving owing, then a new tenant later ---------------- */

    await villa(6, 'Leaver', [1]);
    const left = await put(6, { tenantName: '', status: 'owner-occupied', tenantChangeIntent: 'moved-out' });
    T.check('setup: the tenant moves out owing', left.status === 200, String(left.body?.error || ''));
    const later = await put(6, { tenantName: 'Late Arrival', status: 'long-term', tenantChangeIntent: 'changeover' });
    T.check('a new tenant arriving later is refused while that rent stands', later.status === 400 && later.body?.code === 'former-tenant-owes', `${later.status} ${later.body?.code}`);
    const back = await put(6, { tenantName: 'Leaver', status: 'long-term', tenantChangeIntent: 'changeover' });
    T.check('control: the same person returning owes only their own debt and is not refused', back.status === 200, `${back.status} ${back.body?.error || ''}`);
  } finally {
    await srv.stop();
  }
  return T.done();
}
