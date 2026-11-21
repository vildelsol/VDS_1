/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The FINANCIAL group audited as one ecosystem (audit, 2026-11-18).
 *
 * One simulated property with every kind of money the books hold: let villas in
 * both currencies (the levy settled from rent), owner-occupied villas paying the
 * levy in cash, arrears, an advance, a refund, a voided receipt, costs on both
 * books including a voided one, a supplier credit and a pending bill, a utility
 * reading, and short-stay cash income.
 *
 * Each screen's figure is computed with the exact function call the screen makes
 * (read off the component), then held against an independent count from the raw
 * ledger and against the same figure on the other screens. books-ecosystem covers
 * the book split and the internal transfer; this covers what it does not:
 * Operating Statement vs the Reports summary on the combined book, Charts vs
 * Reports, Annual Report vs the ledger, owner statements per villa, the
 * reconciliation totals, and projections against the current register.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment, localToday } from './harness.mjs';

export const title = 'Audit: the financial group as one ecosystem';

const C = n => Math.round((Number(n) || 0) * 100);
const FROM = '2026-09-01';
const TO = '2026-11-30';
const CURS = ['JMD', 'USD'];
const within = (d, a, b) => !!d && d >= a && d <= b;

export default async function run({ port, projectRoot }) {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-auditfin-'));
  const F = {};
  for (const [name, entry] of [['finance', 'finance.ts'], ['projection', 'projection.ts']]) {
    const outfile = path.join(outdir, `${name}.mjs`);
    await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', entry)], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
    Object.assign(F, await import(pathToFileURL(outfile).href));
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-auditfin-db-'));
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Audit-1234!', projectRoot, dataDir });

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Audit-1234!', 'AuditNew-9876!');
    const ok = (r, what) => {
      if (!r || r.status >= 400) throw new Error(`${what} refused: ${r?.status} ${JSON.stringify(r?.body)}`);
      return r;
    };

    /* ---------------- the property ---------------- */
    // ISPO's let villas: JMD and USD, the levy inside the rent.
    ok(await makeLongTermUnit(c, 'unit-1', { monthlyRent: 75000, monthlyMaintenance: 20000, tenantName: 'Tenant One' }), 'unit-1');
    ok(await makeLongTermUnit(c, 'unit-2', { monthlyRent: 900, monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD', tenantName: 'Tenant Two' }), 'unit-2');
    // Owner-occupied (third-party) villas: JMD and USD levy paid in cash.
    ok(await c.put('/api/units/unit-3', { number: '3', ownerName: 'Owner Three', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 }), 'unit-3');
    ok(await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner Four', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD', maintDueDay: 1 }), 'unit-4');
    // ISPO's short-stay villa: guests pay cash.
    ok(await c.put('/api/units/unit-5', { number: '5', ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 }), 'unit-5');
    for (const m of ['2026-09', '2026-10', '2026-11']) ok(await c.post('/api/charges/post-month', { monthString: m }), `post ${m}`);

    const pay = (unitId, category, amount, date, currency = 'JMD', extra = {}) =>
      recordAndConfirmPayment(c, { unitId, category, amount, currency, payerName: 'Payer', method: 'Bank Transfer', date, ...extra });

    // unit-1: rent Sep and Oct, November in arrears.
    ok(await pay('unit-1', 'Rent', 75000, '2026-09-03'), 'u1 sep');
    ok(await pay('unit-1', 'Rent', 75000, '2026-10-03'), 'u1 oct');
    // unit-2: rent every month, plus a month in advance.
    for (const d of ['2026-09-04', '2026-10-04', '2026-11-04']) ok(await pay('unit-2', 'Rent', 900, d, 'USD'), `u2 ${d}`);
    const adv = ok(await c.post('/api/payments', { unitId: 'unit-2', category: 'Rent', amount: 900, currency: 'USD', payerName: 'Tenant Two', method: 'Bank Transfer', date: '2026-11-10', receivedNow: true, advancePayment: true }), 'u2 advance');
    // unit-3: levy Sep, Oct; a November receipt voided; then an overpayment refunded in part.
    ok(await pay('unit-3', 'Maintenance', 20000, '2026-09-02', 'JMD', { payerName: 'Owner Three' }), 'u3 sep');
    ok(await pay('unit-3', 'Maintenance', 20000, '2026-10-02', 'JMD', { payerName: 'Owner Three' }), 'u3 oct');
    const toVoid = ok(await pay('unit-3', 'Maintenance', 20000, '2026-11-02', 'JMD', { payerName: 'Owner Three' }), 'u3 nov');
    ok(await c.post(`/api/payments/${toVoid.body.payment.id}/reverse`, { reversalReason: 'Cheque returned unpaid' }), 'void');
    const over = ok(await c.post('/api/payments', { unitId: 'unit-3', category: 'Maintenance', amount: 30000, currency: 'JMD', payerName: 'Owner Three', method: 'Bank Transfer', date: '2026-11-06', receivedNow: true, advancePayment: true }), 'u3 over');
    ok(await c.post(`/api/payments/${over.body.payment.id}/refund`, { amount: 5000, refundedOn: '2026-11-12', method: 'Bank Transfer', reason: 'Overpaid, returned to owner' }), 'refund');
    // unit-4: September only, so it is in arrears.
    ok(await pay('unit-4', 'Maintenance', 125, '2026-09-05', 'USD', { payerName: 'Owner Four' }), 'u4 sep');
    // unit-5: short-stay cash.
    ok(await pay('unit-5', 'Booking', 90000, '2026-10-15', 'JMD', { method: 'Cash', payerName: 'A Guest' }), 'u5 booking');
    ok(await pay('unit-5', 'Booking', 250, '2026-11-08', 'USD', { method: 'Cash', payerName: 'A Guest' }), 'u5 booking usd');
    // A utility reading on the owner-occupied villa, settled.
    const ut = ok(await c.post('/api/utilities', { unitId: 'unit-3', billingPeriod: '2026-10', previousReading: 100, currentReading: 150, amountCharged: 6000, currency: 'JMD' }), 'utility');
    const settle = ok(await c.post(`/api/utilities/${ut.body.utility.id}/settle`, { date: '2026-11-03', method: 'Cash' }), 'settle utility');
    const utilPay = settle.body?.payment?.id;
    if (utilPay) ok(await c.post(`/api/payments/${utilPay}/confirm`, {}), 'confirm utility');

    // Costs: both books, a void, a supplier credit, a pending bill, USD.
    const cost = (b) => c.post('/api/expenses', { unitNumber: 'General', currency: 'JMD', status: 'paid', ...b });
    ok(await cost({ category: 'Security', vendor: 'Guardsman', amount: 96000, date: '2026-09-10', datePaid: '2026-09-10' }), 'security');
    ok(await cost({ category: 'Landscaping', vendor: 'Grounds', amount: 30000, date: '2026-10-10', datePaid: '2026-10-12' }), 'landscaping');
    ok(await cost({ category: 'Utilities', vendor: 'JPS', amount: 40000, date: '2026-10-20', datePaid: '2026-10-20' }), 'jps');
    ok(await cost({ category: 'Utilities', vendor: 'JPS', amount: -5000, date: '2026-11-05', datePaid: '2026-11-05', description: 'Supplier credit' }), 'credit');
    const voidMe = ok(await cost({ category: 'Contractors', vendor: 'Plumber', amount: 15000, date: '2026-11-01', datePaid: '2026-11-01' }), 'repairs');
    ok(await c.post(`/api/expenses/${voidMe.body.expense.id}/void`, { reason: 'Entered twice by mistake', confirmSettled: true }), 'void cost');
    ok(await cost({ category: 'Supplies', vendor: 'Pool Co', amount: 12000, status: 'pending', date: '2026-11-10', dueDate: '2026-11-25' }), 'pending');
    ok(await cost({ category: 'Other', vendor: 'Digicel', amount: 18000, fund: 'ispo', date: '2026-10-05', datePaid: '2026-10-05', description: 'Company phones' }), 'ispo phone');
    ok(await cost({ category: 'Security', vendor: 'Guardsman', amount: 300, currency: 'USD', date: '2026-10-11', datePaid: '2026-10-11' }), 'usd security');

    const db = (await c.get('/api/db')).body;
    const raw = db.payments;
    const settled = [...raw, ...F.settledFromRent(db.charges, raw)];
    const { units, charges, expenses, utilities } = db;
    T.check('the property was built: the voided cost is void and the voided receipt reversed',
      expenses.some(e => e.status === 'void') && raw.some(p => p.status === 'reversed'));
    T.check('the levy inside both let villas\' rent was settled from rent', settled.some(p => p.unitId === 'unit-1' && p.category === 'Maintenance') && settled.some(p => p.unitId === 'unit-2' && p.category === 'Maintenance'));

    // Utility recoveries are a pass-through (Ro, 2026-11-18): out of income on every
    // screen and netted from the utility cost. This used an `ownerBilledUnitIds` set
    // that dropped only owner-occupied and short-term villas' recoveries from the
    // summary while the operating statement counted all of them; that was the defect.
    const netted = F.withUtilityRecoveries(expenses, settled);

    for (const cur of CURS) {
      /* ---------- independent ledger counts ---------- */
      const cashIn = subtract(
        raw.filter(p => p.status === 'completed' && p.currency === cur && within(p.date, FROM, TO)).reduce((a, p) => a + C(p.amount), 0),
        raw.filter(p => p.status === 'completed' && p.currency === cur && within(p.refundedOn, FROM, TO)).reduce((a, p) => a + C(p.refundedAmount), 0)
      );
      // Every utility recovery is out of income (pass-through), net of refunds, whoever paid it.
      const utilRecovered = subtract(
        raw.filter(p => p.status === 'completed' && p.currency === cur && p.category === 'Utility' && within(p.date, FROM, TO)).reduce((a, p) => a + C(p.amount), 0),
        raw.filter(p => p.status === 'completed' && p.currency === cur && p.category === 'Utility' && within(p.refundedOn, FROM, TO)).reduce((a, p) => a + C(p.refundedAmount), 0)
      );
      // ...and netted from what was spent.
      const spentLedger = expenses.filter(e => e.status === 'paid' && e.currency === cur && within(e.datePaid || e.date, FROM, TO)).reduce((a, e) => a + C(e.amount), 0) - utilRecovered;

      /* ---------- Operational Reports summary, combined book (Reports.tsx summary) ---------- */
      const combined = F.consolidateEverything(charges, settled, units);
      const repPayments = F.paymentsInBook(combined.payments, 'everything');
      const repCollected = F.collectedInPeriod(repPayments, cur, FROM, TO);
      const repSpent = F.expensesInPeriod(F.expensesForBook(netted, units, 'everything', cur), cur, FROM, TO);
      T.check(`${cur}: Reports summary "received" is the cash that came in, less every utility recovery`,
        C(repCollected.total) === cashIn - utilRecovered, `${C(repCollected.total)} vs ${cashIn - utilRecovered}`);
      T.check(`${cur}: Reports summary "spent" is the paid costs, net of the supplier credit and the utility recoveries, without the void or the pending bill`,
        C(repSpent) === spentLedger, `${C(repSpent)} vs ${spentLedger}`);

      /* ---------- Operating Statement, combined book (OperatingStatement.tsx) ---------- */
      const op = F.operatingStatement(settled, expenses, units, cur, FROM, TO, { book: 'everything' });
      // Was `=== cashIn`: the statement counted utility recoveries as income, which
      // is the defect Ro's pass-through rule (2026-11-18) removes.
      T.check(`${cur}: the combined Operating Statement's income is the cash that came in less utility recoveries, the levy inside rent counted once`,
        C(op.totalIncome) === cashIn - utilRecovered, `statement ${C(op.totalIncome)} vs cash ${cashIn - utilRecovered}`);
      T.check(`${cur}: the combined Operating Statement's expenditure equals the Reports summary "spent"`,
        C(op.totalExpenditure) === C(repSpent), `${C(op.totalExpenditure)} vs ${C(repSpent)}`);

      /* ---------- Charts (Charts.tsx byCurrency) ---------- */
      const months = ['2026-09', '2026-10', '2026-11'];
      const chartRows = months.map(m => {
        const mFrom = `${m}-01`, mTo = F.monthEndOf ? F.monthEndOf(m) : endOf(m);
        return {
          received: F.collectedInPeriod(combined.payments, cur, mFrom, mTo).total,
          paidOut: F.expensesInPeriod(netted, cur, mFrom, mTo),
          billed: F.chargedInPeriod(combined.charges, cur, mFrom, mTo).total
        };
      });
      const chartReceived = chartRows.reduce((a, r) => a + C(r.received), 0);
      const chartPaidOut = chartRows.reduce((a, r) => a + C(r.paidOut), 0);
      const chartBreakdown = F.categoriesWithSpend(F.expenseBreakdown(netted, cur, FROM, TO)).reduce((a, b) => a + C(b.amount), 0);
      T.check(`${cur}: Charts "received" over the range equals the Reports summary`, chartReceived === C(repCollected.total), `${chartReceived} vs ${C(repCollected.total)}`);
      T.check(`${cur}: Charts "paid out" over the range equals the Reports summary`, chartPaidOut === C(repSpent), `${chartPaidOut} vs ${C(repSpent)}`);
      T.check(`${cur}: Charts' expenses-by-category total equals its "paid out"`, chartBreakdown === chartPaidOut, `${chartBreakdown} vs ${chartPaidOut}`);
      T.check(`${cur}: Charts "billed" equals the Reports summary "billed"`,
        chartRows.reduce((a, r) => a + C(r.billed), 0) === C(F.chargedInPeriod(F.chargesInBook(combined.charges, 'everything'), cur, FROM, TO).total));

      /* ---------- Bank reconciliation (Reconciliation.tsx) ---------- */
      const rec = F.reconciliation(raw, cur, FROM, TO);
      const grossIn = raw.filter(p => p.status === 'completed' && p.currency === cur && within(p.date, FROM, TO)).reduce((a, p) => a + C(p.amount), 0);
      T.check(`${cur}: Reconciliation "ledger says received" is every completed receipt, gross, and nothing voided`, C(rec.total) === grossIn && rec.receipts.every(p => p.status === 'completed'), `${C(rec.total)} vs ${grossIn}`);
      T.check(`${cur}: Reconciliation never offers a settled-from-rent credit to tick`, rec.receipts.every(p => !p.derived));
      T.check(`${cur}: matched plus not-yet-found is the whole`, C(rec.matchedTotal) + C(rec.unmatchedTotal) === C(rec.total));
    }

    /* ---------- Owners Statements, per villa (OwnerStatements.tsx) ---------- */
    const statements = F.ownerStatements(units, charges, settled, expenses, utilities, FROM, TO);
    for (const s of statements) {
      const cur = s.currency;
      const own = settled.filter(p => p.unitId === s.unit.id && p.currency === cur && p.status === 'completed');
      const levyCharges = charges.filter(x => x.unitId === s.unit.id && x.category === 'Maintenance' && x.status === 'open' && x.currency === cur);
      const billed = levyCharges.filter(x => within(x.dueDate, FROM, TO)).reduce((a, x) => a + C(x.amount), 0);
      const paidIn = own.filter(p => p.category === 'Maintenance' && within(p.date, FROM, TO)).reduce((a, p) => a + C(p.amount), 0)
        - own.filter(p => p.category === 'Maintenance' && within(p.refundedOn, FROM, TO)).reduce((a, p) => a + C(p.refundedAmount), 0);
      const balanceAtEnd = levyCharges.filter(x => x.dueDate <= TO).reduce((a, x) => a + C(x.amount), 0)
        - own.filter(p => p.category === 'Maintenance' && p.date <= TO).reduce((a, p) => a + C(p.amount) - (p.refundedOn && p.refundedOn <= TO ? C(p.refundedAmount) : 0), 0);
      const label = `${s.unit.number} ${cur}`;
      T.check(`owner statement ${label}: levy billed is the villa's levy charges in the period`, C(s.maintenanceBilled) === billed, `${C(s.maintenanceBilled)} vs ${billed}`);
      T.check(`owner statement ${label}: levy paid is the villa's receipts and settled-from-rent, net of refunds`, C(s.maintenancePaid) === paidIn, `${C(s.maintenancePaid)} vs ${paidIn}`);
      T.check(`owner statement ${label}: outstanding is the ledger balance at period end`, C(s.maintenanceOutstanding) === balanceAtEnd, `${C(s.maintenanceOutstanding)} vs ${balanceAtEnd}`);
      if (balanceAtEnd < 0 && s.utilityBilled === 0 && s.expenses === 0) {
        T.check(`owner statement ${label}: credit held is the credit on the account at period end`, C(s.net) === -balanceAtEnd, `${C(s.net)} vs ${-balanceAtEnd}`);
      }
    }
    const u3 = statements.find(s => s.unit.id === 'unit-3' && s.currency === 'JMD');
    T.check('owner statement 3: the voided receipt is not counted and the refund is', !!u3 && C(u3.maintenancePaid) === C(20000 + 20000 + 30000 - 5000), u3 && `${u3.maintenancePaid}`);

    /* ---------- Annual report (AnnualReport.tsx) ---------- */
    for (const cur of CURS) {
      const ar = F.annualOwnersReport(units, charges, settled, expenses, cur, 2026, { booksBeginOn: db.settings.booksBeginOn });
      const levy2026 = charges.filter(x => x.category === 'Maintenance' && x.status === 'open' && x.currency === cur && (x.periodMonth || x.dueDate || '').startsWith('2026')).reduce((a, x) => a + C(x.amount), 0);
      // Net of the corporation's utility recoveries (pass-through, Ro 2026-11-18); the gross register sum was the old definition.
      // Changed 2026-11-21 (owner's rule): the Annual Report presents common costs, so a villa-tied utility bill and the
      // recoveries from villas are the villa owner's own cost and are left out; the gross common bills stand.
      const strataSpent = F.strataExpenses(expenses.filter(e => !F.isVillaUtilityCost(e))).filter(e => e.status === 'paid' && e.currency === cur && within(e.datePaid || e.date, '2026-01-01', '2026-12-31')).reduce((a, e) => a + C(e.amount), 0);
      T.check(`${cur}: Annual Report contributions are the year's own levy charges`, C(ar.contributionsAnnual) === levy2026, `${C(ar.contributionsAnnual)} vs ${levy2026}`);
      T.check(`${cur}: Annual Report expenditure is the corporation's paid costs only`, C(ar.expenditure) === strataSpent, `${C(ar.expenditure)} vs ${strataSpent}`);
      const opStrata = F.operatingStatement(settled, expenses, units, cur, '2026-01-01', '2026-12-31', { book: 'strata' });
      const villaUtilityRows = F.strataExpenses(F.withUtilityRecoveries(expenses, settled))
        .filter(e => F.isVillaUtilityCost(e) && e.status === 'paid' && e.currency === cur && within(e.datePaid || e.date, '2026-01-01', '2026-12-31'))
        .reduce((a, e) => a + C(e.amount), 0);
      T.check(`${cur}: Annual Report expenditure equals the strata Operating Statement for the year less villa utilities and their recoveries`, C(ar.expenditure) === C(opStrata.totalExpenditure) - villaUtilityRows, `${C(ar.expenditure)} vs ${C(opStrata.totalExpenditure)} - ${villaUtilityRows}`);
      const statementsYear = F.ownerStatements(units, charges, settled, expenses, utilities, '2026-01-01', '2026-12-31');
      const receivedByStatements = statementsYear.filter(s => s.currency === cur).reduce((a, s) => a + C(s.maintenancePaid), 0);
      T.check(`${cur}: Annual Report "received" equals the owner statements' levy paid, added up`, C(ar.received) === receivedByStatements, `${C(ar.received)} vs ${receivedByStatements}`);
    }

    /* ---------- Projections (Projections.tsx) ---------- */
    const window = { from: FROM, to: TO, months: 3 };
    for (const cur of CURS) {
      const p = F.buildProjection(cur, units, charges, settled, expenses, window, 6);
      const register = units.filter(u => F.isBillable(u, 'Maintenance') && F.chargeCurrency(u, 'Maintenance') === cur).reduce((a, u) => a + C(u.monthlyMaintenance), 0);
      T.check(`${cur}: Projections' assessment is the current register`, C(p.contractedMonthly) === register, `${C(p.contractedMonthly)} vs ${register}`);
      // Net of utility recoveries, as above.
      const strataPaid = C(F.expensesInPeriod(F.strataExpenses(F.withUtilityRecoveries(expenses, settled)), cur, FROM, TO));
      T.check(`${cur}: Projections' expenditure is the corporation's own paid costs`, C(p.expensesPaid) === strataPaid, `${C(p.expensesPaid)} vs ${strataPaid}`);
      const opsLevy = F.collectedInPeriod(settled, cur, FROM, TO).maintenance;
      T.check(`${cur}: Projections' contributions received are the levy in cash plus the levy settled from rent`, C(p.maintReceived) === C(opsLevy));
    }

    /* ---------- the two books add up to the combined statement, both sides ---------- */
    for (const cur of CURS) {
      const st = book => F.operatingStatement(settled, expenses, units, cur, FROM, TO, { book });
      const [all, strata, ispo] = [st('everything'), st('strata'), st('ispo')];
      T.check(`${cur}: combined income is the corporation's plus ISPO's, less the levy ISPO paid over (counted once)`,
        C(strata.totalIncome) + C(ispo.totalIncome) - C(ispo.internalTransfer) === C(all.totalIncome),
        `${C(strata.totalIncome)} + ${C(ispo.totalIncome)} - ${C(ispo.internalTransfer)} vs ${C(all.totalIncome)}`);
      T.check(`${cur}: so the combined surplus is exactly the two books' surpluses added`,
        C(strata.surplus) + C(ispo.surplus) === C(all.surplus), `${C(strata.surplus)} + ${C(ispo.surplus)} vs ${C(all.surplus)}`);
      T.check(`${cur}: the levy left off the combined statement is named, with its amount`,
        all.excludedIncome.some(e => /ISPO paid the corporation/.test(e.label) && C(e.total) === C(ispo.internalTransfer)), JSON.stringify(all.excludedIncome));
      const io = F.ispoOperations(expenses, settled, units, cur, FROM, TO);
      T.check(`${cur}: ISPO Operations' net equals the ISPO Operating Statement's surplus`, C(io.net) === C(ispo.surplus), `${C(io.net)} vs ${C(ispo.surplus)}`);
    }

    /* ---------- owner statement credit is as at period END ---------- */
    const early = F.ownerStatements(units, charges, settled, expenses, utilities, FROM, '2026-10-31').find(s => s.unit.id === 'unit-3' && s.currency === 'JMD');
    T.check('owner statement 3 to 31 October: no credit from the November overpayment', !!early && early.net <= 0 && C(early.maintenanceOutstanding) === 0, early && `${early.net} / ${early.maintenanceOutstanding}`);
    const late = statements.find(s => s.unit.id === 'unit-3' && s.currency === 'JMD');
    // Billed 60,000; paid 20,000 + 20,000 + 30,000 - 5,000 refunded = 65,000; credit 5,000. Utility billed and paid net to 0.
    T.check('owner statement 3 to 30 November: credit held is the 5,000 left after the refund', !!late && C(late.net) === C(5000), late && `${late.net}`);

    /* ---------- Projections follow the register, never a stored figure ---------- */
    // The levy rise to J$27,000 is entered on the register; the projection must use it at once.
    ok(await c.put('/api/units/unit-3', { number: '3', ownerName: 'Owner Three', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 27000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 }), 'rise');
    const db2 = (await c.get('/api/db')).body;
    const p27 = F.buildProjection('JMD', db2.units, db2.charges, [...db2.payments, ...F.settledFromRent(db2.charges, db2.payments)], db2.expenses, window, 6);
    T.check('JMD: after the J$27,000 rise is entered, the projection assesses it (27,000 + 20,000 + 20,000)', C(p27.contractedMonthly) === C(67000), `${p27.contractedMonthly}`);
    const ar27 = F.annualOwnersReport(db2.units, db2.charges, [], db2.expenses, 'JMD', 2026, {});
    T.check('JMD: the Annual Report still states the year\'s levy from its own charges, not the new register', C(ar27.contributionsAnnual) === C(3 * 60000), `${ar27.contributionsAnnual}`);

    T.check('the books report no contradiction', (await c.get('/api/integrity')).body.serious === 0);
  } catch (err) {
    T.check('the audit ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
  }
  return T.done();
}

function subtract(a, b) { return a - b; }
function endOf(m) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(d).padStart(2, '0')}`;
}
