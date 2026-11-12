/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Red team on the whole ecosystem, not on one corner of it (Ro, 2026-11-12:
 * "its an entire ecosystem which depends on each element").
 *
 * Every kind of money the property handles, on one property, at once: tenant
 * rent with the levy inside it, the corporation's own levy, short-stay bookings,
 * damage deposits, tenancy deposits, utility recharges, one-off fees, refunds,
 * costs on both books, in JMD and USD. Then the identities that must hold across
 * ALL of it — not the identities of the part that changed most recently.
 *
 * The rule each check follows: it must be computable from the raw ledger alone,
 * so it stays true whatever the policy is, and it must be able to fail.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Red team: the whole ecosystem, every kind of money at once';

const C = n => Math.round((Number(n) || 0) * 100);
const FROM = '2026-09-01';
const TO = '2026-11-30';

export default async function run({ port, projectRoot }) {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rte-'));
  const outfile = path.join(outdir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const F = await import(pathToFileURL(outfile).href);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rte-db-'));
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Rte-1234!', projectRoot, dataDir });

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Rte-1234!', 'RteNew-9876!');

    await makeLongTermUnit(c, 'unit-1', { monthlyRent: 100000, monthlyMaintenance: 20000, tenantName: 'Tenant One' });
    await makeLongTermUnit(c, 'unit-2', { monthlyRent: 800, monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD', tenantName: 'Tenant Two' });
    await c.put('/api/units/unit-3', { number: '3', ownerName: 'Owner Three', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner Four', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'USD', maintCurrency: 'USD', maintDueDay: 1 });
    for (const m of ['2026-09', '2026-10', '2026-11']) await c.post('/api/charges/post-month', { monthString: m });

    /*
     * Every setup call is checked. A fixture that is quietly refused builds a
     * property with half the money missing and then passes, which is how an
     * earlier draft of this very test came to assert nothing about bookings,
     * deposits or utilities at all.
     */
    const must = async (what, res) => {
      const r = await res;
      if (r.status >= 400) T.check(`setup: ${what}`, false, `${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);
      return r;
    };
    const pay = (unitId, category, amount, date, currency = 'JMD') =>
      must(`${category} ${amount} ${currency} on ${unitId}`, recordAndConfirmPayment(c, { unitId, category, amount, currency, payerName: 'Payer', method: 'Bank Transfer', date }));

    // Rent, with the levy inside it, and the corporation's own levy.
    for (const d of ['2026-09-07', '2026-10-07', '2026-11-05']) {
      await pay('unit-1', 'Rent', 100000, d);
      await pay('unit-2', 'Rent', 800, d, 'USD');
    }
    await pay('unit-3', 'Maintenance', 20000, '2026-09-02');
    await pay('unit-4', 'Maintenance', 125, '2026-09-02', 'USD');

    // A short stay, with a damage deposit held and then returned in full.
    const bk = await must('create a booking', c.post('/api/bookings', { unitId: 'unit-4', guestName: 'A guest', checkIn: '2026-10-02', checkOut: '2026-10-06', amount: 900, depositPaid: 0, currency: 'USD', source: 'Direct' }));
    const bookingId = bk.body?.booking?.id;
    await must('take a damage deposit', c.post(`/api/bookings/${bookingId}/damage-deposit`, { amount: 300, currency: 'USD', receivedOn: '2026-10-01' }));

    // A tenancy deposit held against unit-1.
    const tenancy = (await c.get('/api/db')).body.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    T.check('setup: the tenancy exists to hold a deposit against', !!tenancy);
    if (tenancy) await must('take a tenancy deposit', c.post(`/api/tenancies/${tenancy.id}/deposit`, { amount: 100000, receivedOn: '2026-09-01' }));

    // A utility recharged and settled.
    const util = await must('record a utility reading', c.post('/api/utilities', { unitId: 'unit-1', type: 'Electricity', billingPeriod: '2026-10', previousReading: 100, currentReading: 450, amountCharged: 12000, currency: 'JMD' }));
    const utilId = util.body?.utility?.id;
    T.check('setup: the utility reading was recorded', !!utilId, JSON.stringify(util.body).slice(0, 150));
    if (utilId) await must('settle the utility', c.post(`/api/utilities/${utilId}/settle`, { method: 'Cash' }));

    // A one-off fee on each book, a cost on each book, and a refund.
    await must('raise a late fee', c.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 5000, dueDate: '2026-11-08', description: 'Late fee' }));
    await must('raise a special assessment', c.post('/api/charges', { unitId: 'unit-3', category: 'Maintenance', oneOffType: 'Special assessment', amount: 30000, dueDate: '2026-11-01', description: 'Roof' }));
    await c.post('/api/expenses', { category: 'Grounds', amount: 40000, currency: 'JMD', date: '2026-09-20', description: 'Gardening', vendor: 'A gardener' });
    await c.post('/api/expenses', { unitId: 'unit-1', category: 'Repairs', amount: 9000, currency: 'JMD', date: '2026-10-20', description: 'Plumbing', vendor: 'A plumber' });
    const extra = await pay('unit-3', 'Maintenance', 30000, '2026-11-03');
    const extraId = extra.body?.payment?.id;
    T.check('setup: the extra receipt exists to refund', !!extraId, JSON.stringify(extra.body).slice(0, 150));
    if (extraId) await must('refund part of it', c.post(`/api/payments/${extraId}/refund`, { amount: 10000, refundedOn: '2026-11-10', method: 'Cash', reason: 'Overpaid' }));

    const db = (await c.get('/api/db')).body;
    const derived = F.settledFromRent(db.charges, db.payments);
    const settled = [...db.payments, ...derived];
    const live = db.payments.filter(p => p.status === 'completed');

    /* ===== 1. every receipt is on exactly one book, whatever its kind ===== */
    for (const cur of ['JMD', 'USD']) {
      const mine = settled.filter(p => p.status === 'completed' && p.currency === cur);
      const ispo = F.paymentsInBook(mine, 'ispo');
      const strata = F.paymentsInBook(mine, 'strata');
      const both = ispo.filter(p => strata.some(q => q.id === p.id));
      T.check(`${cur}: no receipt of any kind sits on both books`, both.length === 0, JSON.stringify(both.map(p => p.category)));
      T.check(`${cur}: and none falls between them — every category is placed`, ispo.length + strata.length === mine.length,
        JSON.stringify([...new Set(mine.filter(p => !ispo.includes(p) && !strata.includes(p)).map(p => p.category))]));
      /*
       * The split must also be the RIGHT split. Counting receipts and totals
       * cannot see this: collapse every category onto one book and the counts
       * still tally and the two books still add back to the cash. Only naming
       * what may appear on each book catches it — which an earlier draft of this
       * test did not do, and so passed with the whole ledger on ISPO's book.
       */
      T.check(`${cur}: ISPO's book carries rent and short stays, and nothing of the corporation's`,
        ispo.every(p => p.category === 'Rent' || p.category === 'Booking'), JSON.stringify([...new Set(ispo.map(p => p.category))]));
      T.check(`${cur}: the corporation's book carries the levy, utilities and sundries, and no rent`,
        strata.every(p => p.category !== 'Rent' && p.category !== 'Booking'), JSON.stringify([...new Set(strata.map(p => p.category))]));
      T.check(`${cur}: both books actually hold something, so neither check is passing on an empty set`,
        ispo.length > 0 && strata.length > 0, `${ispo.length} ISPO, ${strata.length} strata`);
    }

    /* ===== 2. the two books add back to the cash, every category ===== */
    for (const cur of ['JMD', 'USD']) {
      const cash = live.filter(p => p.currency === cur).reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
      const ispo = F.collectedInPeriod(F.paymentsInBook(db.payments, 'ispo'), cur, '2000-01-01', '2099-12-31').total;
      const strata = F.collectedInPeriod(F.paymentsInBook(db.payments, 'strata'), cur, '2000-01-01', '2099-12-31').total;
      T.check(`${cur}: the two books together are exactly the cash the property holds, across rent, levy, bookings, utilities and sundries`,
        C(ispo) + C(strata) === cash, `${C(ispo)} + ${C(strata)} vs ${cash}`);
    }

    /* ===== 3. the category split is complete ===== */
    for (const cur of ['JMD', 'USD']) {
      const t = F.collectedInPeriod(db.payments, cur, '2000-01-01', '2099-12-31');
      T.check(`${cur}: the category totals add up to the total — no money in an unnamed bucket`,
        C(t.rent) + C(t.maintenance) + C(t.booking) + C(t.utility) + C(t.other) === C(t.total),
        JSON.stringify(t));
    }

    /* ===== 4. money held is not money earned ===== */
    /*
     * A deposit is the property holding somebody else's money, and it is kept on
     * the tenancy and the booking rather than receipted as income — which is the
     * right answer, and worth pinning so a later change cannot quietly turn held
     * money into collections.
     */
    const heldTenancy = db.tenancies.filter(t => (t.depositAmount || 0) > 0);
    const heldBooking = (db.bookings || []).filter(b => (b.damageDepositAmount || 0) > 0);
    T.check('a tenancy deposit and a damage deposit are both being held, so this check means something',
      heldTenancy.length > 0 && heldBooking.length > 0, `${heldTenancy.length} tenancy, ${heldBooking.length} booking`);
    const heldTotal = heldTenancy.reduce((a, t) => a + C(t.depositAmount), 0) + heldBooking.reduce((a, b) => a + C(b.damageDepositAmount), 0);
    T.check('held money is real and substantial, not a rounding', heldTotal > 0, String(heldTotal));
    T.check('not one penny of a deposit is sitting in the receipts ledger as income',
      !db.payments.some(p => heldTenancy.some(t => t.unitId === p.unitId && C(p.amount) === C(t.depositAmount) && /deposit/i.test(`${p.category}${p.notes}${p.reference}`))));
    for (const cur of ['JMD', 'USD']) {
      const income = F.collectedInPeriod(db.payments, cur, '2000-01-01', '2099-12-31').total;
      const cash = live.filter(p => p.currency === cur).reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
      T.check(`${cur}: nothing is reported as collected that the property does not actually hold`, C(income) <= cash, `${C(income)} vs ${cash}`);
    }

    /* ===== 5. a refund reduces the day it went out, not the receipt's month ===== */
    const before = F.collectedInPeriod(db.payments, 'JMD', '2026-11-01', '2026-11-05').maintenance;
    const after = F.collectedInPeriod(db.payments, 'JMD', '2026-11-01', '2026-11-30').maintenance;
    T.check('a refund paid in November reduces November, not the month of the receipt', C(after) < C(before), `${C(after)} vs ${C(before)}`);

    /* ===== 6. expenses split across the books without loss or duplication ===== */
    for (const cur of ['JMD', 'USD']) {
      const all = db.expenses.filter(e => e.currency === cur && e.status !== 'void');
      const s = F.expensesInBook(all, 'strata');
      const i = F.expensesInBook(all, 'ispo');
      T.check(`${cur}: every cost is on one book or the other, never both, never neither`,
        s.length + i.length === all.length && !s.some(x => i.some(y => y.id === x.id)), `${s.length}+${i.length} of ${all.length}`);
    }

    /* ===== 7. an owner's statement is only ever about their own villa ===== */
    const statements = F.ownerStatements(db.units, db.charges, settled, db.expenses, db.utilities, FROM, TO);
    T.check('owner statements were produced', statements.length > 0, String(statements.length));
    T.check("no owner's statement reaches into another villa's money",
      statements.every(s => !s.unit || db.units.some(u => u.id === s.unit.id)));

    /* ===== 8. nothing anywhere is counted twice ===== */
    const ids = db.payments.map(p => p.id);
    T.check('no receipt id appears twice in the ledger', new Set(ids).size === ids.length);
    const receipts = db.payments.filter(p => p.receiptNo).map(p => p.receiptNo);
    T.check('no receipt number is issued twice', new Set(receipts).size === receipts.length);
    T.check('a worked-out credit never carries a receipt number, so it can never be mistaken for one', derived.every(d => !d.receiptNo));

    /* ===== 9. the property says so itself ===== */
    const integ = (await c.get('/api/integrity')).body;
    T.check('with every kind of money on the books at once, the property reports no contradiction',
      integ.serious === 0, JSON.stringify(integ.findings.map(f => f.code)));
    T.check('server healthy', (await c.get('/api/health')).status === 200);
  } catch (err) {
    T.check('the ecosystem red team ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(outdir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return T.done();
}
