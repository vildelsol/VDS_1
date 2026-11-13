/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The screens must agree with each other.
 *
 * Every financial screen computes its own figures, and each can be right on its
 * own while the set contradicts itself: the dashboard says one thing is owed, the
 * annual return another. Money tests that look at one screen cannot see that.
 *
 * One scenario with known answers is built through the API. The same fact is then
 * read from every screen's own engine, with the payments passed exactly as the
 * application passes them (`settledFromRent` added), and the screens are held
 * against each other and against the raw records. Then one payment is recorded
 * and every screen has to move by exactly that amount, and move back when the
 * payment is voided. That is the wiring: a change at one end reaches all the others.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Every financial screen agrees with the ledger and with each other';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-wiring-'));
  const entry = path.join(dir, 'entry.ts');
  // JSON.stringify, not a bare interpolation: on Windows the project path has backslashes,
  // which a script reads as escapes ("D:\a\VDS_1" became "D:aVDS_1" and the build failed on CI).
  const lib = name => JSON.stringify(path.join(projectRoot, 'src', 'lib', name).split(path.sep).join('/'));
  fs.writeFileSync(entry, `export * from ${lib('finance')}; export * from ${lib('projection')};`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: path.join(dir, 'e.mjs'), logLevel: 'silent' });
  const F = await import(path.join(dir, 'e.mjs'));
  const srv = await startServer({ port, adminPassword: 'Wiring-1234567!', projectRoot });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Wiring-1234567!', 'WiringNew-98765432!');
    const U = (n, o) => c.put(`/api/units/unit-${n}`, { number: String(n), currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, monthlyMaintenance: 25000, ownerName: 'x', ...o });
    for (const n of [1, 2, 3, 4, 5]) await U(n, { ownerName: 'ISPO', status: 'short-term', monthlyRent: 0 });
    await U(6, { ownerName: 'ISPO', tenantName: 'Tenant 6', status: 'long-term', monthlyRent: 100000 });
    await U(7, { ownerName: 'ISPO', tenantName: 'Tenant 7', status: 'long-term', monthlyRent: 800, currency: 'USD', maintCurrency: 'USD', monthlyMaintenance: 150 });
    for (let n = 8; n <= 16; n++) await U(n, { ownerName: 'Owner ' + n, status: 'owner-occupied', monthlyRent: 0 });
    const M = ['2026-08', '2026-09', '2026-10'];
    for (const m of M) await c.post('/api/charges/post-month', { monthString: m });
    const pay = (u, cat, amt, date, who, cur = 'JMD') => recordAndConfirmPayment(c, { unitId: 'unit-' + u, category: cat, amount: amt, currency: cur, payerName: who, method: 'Cash', date });
    for (const m of M) {
      for (const n of [8, 9, 10]) await pay(n, 'Maintenance', 25000, m + '-07', 'Owner ' + n);
      for (const n of [1, 2]) await pay(n, 'Maintenance', 25000, m + '-08', 'ISPO');
    }
    await pay(11, 'Maintenance', 25000, '2026-08-07', 'Owner 11');
    await pay(6, 'Rent', 100000, '2026-08-05', 'Tenant 6');
    await pay(6, 'Rent', 100000, '2026-09-05', 'Tenant 6');
    await pay(6, 'Rent', 60000, '2026-10-05', 'Tenant 6');
    await pay(7, 'Rent', 800, '2026-08-05', 'Tenant 7', 'USD');
    await c.post('/api/expenses', { category: 'Landscaping', amount: 50000, currency: 'JMD', date: '2026-09-20', description: 'Gardening', vendor: 'g' });
    await c.post('/api/expenses', { category: 'Security', amount: 30000, currency: 'JMD', date: '2026-10-20', description: 'Guards', vendor: 'g' });
    await c.post('/api/expenses', { unitId: 'unit-1', category: 'Contractors', amount: 12000, currency: 'JMD', date: '2026-10-21', description: 'Repair', vendor: 'g' });

    const from = '2026-08-01', to = '2026-10-31', cur = 'JMD', asOf = '2026-10-31';
    const sum = xs => Math.round(xs.reduce((a, x) => a + x, 0) * 100) / 100;

    /** Every screen's reading of the same fact, from the records as the application passes them. */
    const read = async () => {
      const db = (await c.get('/api/db')).body;
      const S = [...db.payments, ...F.settledFromRent(db.charges, db.payments)];
      const ledger = db.units.map(u => F.accountBalance(u, 'Maintenance', db.charges, S, asOf, db.units)).filter(a => a.currency === cur);
      const ledgerRent = db.units.map(u => F.accountBalance(u, 'Rent', db.charges, S, asOf, db.units)).filter(a => a.currency === cur);
      const monthly = M.map(m => F.monthlyOwnersReport(db.units, db.charges, S, db.expenses, cur, m));
      const owners = F.ownerStatements(db.units, db.charges, S, db.expenses, db.utilities, from, to).filter(s => s.currency === cur);
      const ann = F.annualOwnersReport(db.units, db.charges, S, db.expenses, cur, 2026);
      const b13 = F.form13BContributions(db.units, db.charges, S, asOf).totalsByCurrency.find(t => t.currency === cur)?.buckets.total || 0;
      const proj = F.buildProjection(cur, db.units, db.charges, S, db.expenses, { from, to, months: 3 }, 6);
      const opSt = F.operatingStatement(S, db.expenses, db.units, cur, from, to);
      const ops = F.operationsStatement(db.expenses, S, cur, from, to);
      const ispo = F.ispoOperations(db.expenses, S, db.units, cur, from, to);
      const del = F.delinquentAccounts(db.units, db.charges, S, asOf).filter(a => a.currency === cur);
      const sf = F.outOfPocketShortfall(db.units, db.tenancies, db.bookings, S, cur, from, to);
      const col = F.collectedInPeriod(S, cur, from, to);
      const strata = F.collectedInPeriod(F.paymentsInBook(S, 'strata'), cur, from, to);
      const ispoBook = F.collectedInPeriod(F.paymentsInBook(S, 'ispo'), cur, from, to);
      return {
        db, S, sf, col, strata, ispoBook, opSt, ops, ispo, ann, proj, b13,
        ledgerArrears: sum(ledger.filter(a => a.balance > 0).map(a => a.balance)),
        ledgerRentArrears: sum(ledgerRent.filter(a => a.balance > 0).map(a => a.balance)),
        delinquent: sum(del.map(a => a.balance)),
        monthlyReceived: sum(monthly.map(r => r.contributionsReceived)),
        monthlyCosts: sum(monthly.map(r => r.costsPaid + r.villaRecharged)),
        monthlyOctArrears: monthly[2].arrearsOutstanding,
        ownersPaid: sum(owners.map(s => s.maintenancePaid)),
        ownersOutstanding: sum(owners.map(s => s.maintenanceOutstanding)),
        usdCol: F.collectedInPeriod(S, 'USD', from, to)
      };
    };
    const eq = (name, a, b) => T.check(name, Math.abs(a - b) < 0.005, `${a} vs ${b}`);

    const r = await read();
    const rawDone = r.db.payments.filter(p => p.status === 'completed' && p.currency === cur && p.date >= from && p.date <= to);
    const rawSum = cat => sum(rawDone.filter(p => p.category === cat).map(p => p.amount));
    const derivedMaint = sum(r.S.filter(p => p.derived && p.currency === cur && p.date >= from && p.date <= to).map(p => p.amount));
    const maintCash = rawSum('Maintenance');

    // ---- received: every screen reads the same money ----
    eq('collected maintenance = cash in the records + maintenance settled from rent', r.col.maintenance, maintCash + derivedMaint);
    eq('collected rent equals the rent in the records', r.col.rent, rawSum('Rent'));
    eq('the two books partition every receipt: strata + ISPO = all', r.strata.total + r.ispoBook.total, r.col.total);
    eq('owner statements: maintenance paid = what was collected', r.ownersPaid, r.col.maintenance);
    eq('the monthly owners reports add up to the same', r.monthlyReceived, r.col.maintenance);
    eq('annual return: received = what was collected', r.ann.received, r.col.maintenance);
    eq('projection: maintenance received = what was collected', r.proj.maintReceived, r.col.maintenance);
    eq('operations statement: maintenance collected = what was collected', r.ops.maintenanceCollected, r.strata.maintenance);
    eq('ISPO operations: rent received = rent in the records', r.ispo.rentReceived, rawSum('Rent'));

    // ---- owed: every screen reads the same arrears ----
    eq('annual return Form 13B arrears = the ledger', r.b13, r.ledgerArrears);
    eq('monthly report arrears (October) = the ledger', r.monthlyOctArrears, r.ledgerArrears);
    eq('projection arrears = the ledger', r.proj.arrears, r.ledgerArrears);
    eq('owner statements outstanding = the ledger', r.ownersOutstanding, r.ledgerArrears);
    // A let villa's levy is part of the rent its tenant owes: one debt, counted once.
    const insideRent = sum(r.db.units.filter(u => F.maintenanceFundedFromRent(u)).map(u => {
      const rent = F.accountBalance(u, 'Rent', r.db.charges, r.S, asOf, r.db.units);
      const maint = F.accountBalance(u, 'Maintenance', r.db.charges, r.S, asOf, r.db.units);
      return rent.currency === cur && rent.balance > 0 && maint.balance > 0 && maint.balance <= rent.balance ? maint.balance : 0;
    }));
    T.check('the scenario really has a levy inside unpaid rent (else this proves nothing)', insideRent > 0, String(insideRent));
    eq('dashboard arrears = ledger maintenance + ledger rent, minus the levy that sits inside unpaid rent', r.delinquent, r.ledgerArrears + r.ledgerRentArrears - insideRent);
    const v6 = F.delinquentAccounts(r.db.units, r.db.charges, r.S, asOf).filter(a => a.unit.id === 'unit-6');
    T.check('a tenant who owes rent is listed once, not once for rent and again for the levy inside it', v6.length === 1 && v6[0].category === 'Rent', v6.map(a => a.category).join(','));

    // The charts, the board pack and the health grade age the same debt the dashboard totals.
    const aged = F.arrearsAgeing(r.db.units, r.db.charges, r.S, asOf);
    const agedTotal = c2 => aged.find(a => a.currency === c2)?.buckets.total || 0;
    eq('arrears ageing (charts, board pack, health) = dashboard arrears, JMD', agedTotal('JMD'), r.delinquent);
    const delUsd = sum(F.delinquentAccounts(r.db.units, r.db.charges, r.S, asOf).filter(a => a.currency === 'USD').map(a => a.balance));
    eq('arrears ageing = dashboard arrears, USD', agedTotal('USD'), delUsd);
    eq('the ageing buckets add up to their own total', sum([aged.find(a => a.currency === 'JMD').buckets].map(b => b.d30 + b.d60 + b.d90 + b.over90)), agedTotal('JMD'));

    eq('the board pack receivable = the dashboard arrears (no credits in this scenario)', F.receivableAsOf(r.db.units, r.db.charges, r.S, asOf, 'JMD'), r.delinquent);
    eq('the board pack receivable in USD = the dashboard arrears in USD', F.receivableAsOf(r.db.units, r.db.charges, r.S, asOf, 'USD'), delUsd);

    // ---- spent: every screen reads the same costs ----
    const rawExp = sum(r.db.expenses.filter(e => e.currency === cur && !F.isVoidExpense(e) && e.date >= from && e.date <= to).map(e => e.amount));
    eq('expensesInPeriod = the expenses in the records', F.expensesInPeriod(r.db.expenses, cur, from, to), rawExp);
    eq('operating statement expenditure = the records', r.opSt.totalExpenditure, rawExp);
    eq('the two books partition every cost: strata + ISPO = all', r.opSt.strataExpenditure + r.opSt.ispoExpenditure, rawExp);
    eq('annual return expenditure = the records', r.ann.expenditure, rawExp);
    eq('projection expenses = the records', r.proj.expensesPaid, rawExp);
    eq('operations statement: costs paid + recharged to a villa = the records', r.ops.costsPaid + r.ops.villaRecharged, rawExp);
    eq('monthly reports: costs + recharged add up to the records', r.monthlyCosts, rawExp);
    eq('operating statement surplus = income - expenditure', r.opSt.surplus, r.opSt.totalIncome - r.opSt.totalExpenditure);
    eq('operating statement income lines add up to its total', sum(r.opSt.income.map(g => g.total)), r.opSt.totalIncome);

    // ---- the shortfall report reads the same money ----
    const own = new Set(F.ownAccountUnitIds(r.db.units));
    const ownCash = (cat, ps = r.S) => sum(ps.filter(p => p.status === 'completed' && p.currency === cur && p.category === cat && own.has(p.unitId) && p.date >= from && p.date <= to).map(p => p.amount));
    console.log('SHORTFALL', JSON.stringify({ rent: r.sf.totalRentReceived, stay: r.sf.totalShortStayReceived, earned: r.sf.totalEarned, maint: r.sf.totalMaintenancePaid, short: r.sf.totalShortfall, own: [...own], ownRent: ownCash('Rent'), ownMaint: ownCash('Maintenance'), noneFlagged: r.sf.noneFlagged, notes: r.sf.currencyNotes }));
    eq('shortfall: rent received = rent in the records on ISPO villas', r.sf.totalRentReceived, ownCash('Rent'));
    eq('shortfall: earnings = rent + short stay', r.sf.totalEarned, r.sf.totalRentReceived + r.sf.totalShortStayReceived);
    eq('shortfall: maintenance paid = maintenance received from ISPO villas (cash + settled from rent)', r.sf.totalMaintenancePaid, ownCash('Maintenance'));
    eq('shortfall: the total is the sum of its villas', r.sf.totalShortfall, sum(r.sf.byVilla.map(v => v.shortfall ?? v.total ?? 0)));
    eq('shortfall: the total is the sum of its months', r.sf.totalShortfall, sum(r.sf.byMonth.map(m => m.shortfall ?? m.total ?? 0)));

    // ---- the Reports screen feeds its internal reports the whole ledger ----
    // The Reports screen has a book selector and, by default, a combined view that
    // eliminates money sitting on both books. The corporation's operating statement
    // takes the raw arrays and applies the book itself. The three internal reports
    // below it were handed the *filtered* payments instead, so with the default view
    // the shortfall report read maintenance paid as nil and "funded by ISPO" as nil
    // while the ledger showed 150,000. Each must receive the unfiltered arrays.
    const reportsSource = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'Reports.tsx'), 'utf-8');
    const tagOf = name => (reportsSource.match(new RegExp(`<${name}\\b[^>]*?/>`, 's')) || [''])[0];
    for (const name of ['OperationsStatement', 'IspoOperations', 'ShortfallReport']) {
      const tag = tagOf(name);
      T.check(`Reports hands ${name} the unfiltered payments`, /payments=\{allPayments\}/.test(tag), tag.slice(0, 140));
    }
    for (const name of ['OperationsStatement', 'IspoOperations']) {
      T.check(`Reports hands ${name} the unfiltered expenses`, /expenses=\{allExpenses\}/.test(tagOf(name)));
    }

    // ---- the owner statement states what is owed to the corporation, never offset by rent ----
    const ownerSt = F.ownerStatements(r.db.units, r.db.charges, r.S, r.db.expenses, r.db.utilities, from, to).filter(x => x.currency === cur);
    const own6 = ownerSt.find(x => x.unit.id === 'unit-6');
    T.check('ISPO let villa 6 collected rent in the period (else this proves nothing)', own6 && own6.rentCollected > 0, JSON.stringify(own6 && own6.rentCollected));
    T.check('and its owner statement still owes the levy: not a credit built from ISPO\'s own rent', own6 && own6.net <= 0, String(own6 && own6.net));
    T.check('no owner statement anywhere shows the corporation owing a proprietor money', ownerSt.every(x => x.net <= 0), ownerSt.filter(x => x.net > 0).map(x => x.unit.number + ':' + x.net).join(','));
    eq('every statement: net = -(billed - paid) - expenses', sum(ownerSt.map(x => x.net)), -sum(ownerSt.map(x => x.maintenanceBilled - x.maintenancePaid + x.expenses)));

    // ---- the annual report states only what has been recorded ----
    // Recording began in September 2026. A year before that has no months, so it must
    // not print twelve months of fees as a "surplus" against no expenditure.
    const annualWith = (year, begin) => F.annualOwnersReport(r.db.units, r.db.charges, r.S, r.db.expenses, cur, year, { booksBeginOn: begin });
    const y2025 = annualWith(2025, '2026-09-01');
    eq('annual report for a year before recording began has no months', y2025.monthsRecorded, 0);
    eq('and no contributions', y2025.contributionsAnnual, 0);
    eq('and no surplus or deficit', y2025.annualCommunityPosition, 0);
    const noStart = annualWith(2025, undefined);
    eq('with no start date on file the full year is assumed, as before', noStart.monthsRecorded, 12);
    T.check('the budget ceiling still reads a full year of fees', y2025.expenditureCeiling === noStart.contributionsAnnual && y2025.expenditureCeiling > 0, `${y2025.expenditureCeiling} vs ${noStart.contributionsAnnual}`);

    // ---- currencies never meet ----
    eq('800 of USD rent is in the USD figures', r.usdCol.rent, 800);
    eq('and not one cent of it is in the JMD figures', r.col.rent, 260000);

    // ---- the wiring: one payment moves every screen by exactly its amount ----
    const before = await read();
    const pmt = await pay(11, 'Maintenance', 25000, '2026-10-12', 'Owner 11');
    const id = pmt.body.payment.id;
    const after = await read();
    const moves = (name, key, delta, pick = x => x) => eq(`a 25,000 receipt moves ${name} by ${delta}`, pick(after[key] ?? 0) - pick(before[key] ?? 0), delta);
    moves('the ledger arrears', 'ledgerArrears', -25000);
    moves('the dashboard arrears', 'delinquent', -25000);
    moves('Form 13B', 'b13', -25000);
    moves('the October report arrears', 'monthlyOctArrears', -25000);
    moves('the owner statements outstanding', 'ownersOutstanding', -25000);
    moves('the owner statements paid', 'ownersPaid', 25000);
    moves('the monthly reports received', 'monthlyReceived', 25000);
    eq('a 25,000 receipt moves the annual return by 25,000', after.ann.received - before.ann.received, 25000);
    eq('a 25,000 receipt moves the projection arrears by -25,000', after.proj.arrears - before.proj.arrears, -25000);
    eq('a 25,000 receipt moves the projection received by 25,000', after.proj.maintReceived - before.proj.maintReceived, 25000);
    eq('a 25,000 receipt moves the operating statement income by 25,000', after.opSt.totalIncome - before.opSt.totalIncome, 25000);
    eq('a 25,000 receipt moves the operations statement by 25,000', after.ops.maintenanceCollected - before.ops.maintenanceCollected, 25000);
    eq('a 25,000 receipt leaves every cost figure alone', after.opSt.totalExpenditure, before.opSt.totalExpenditure);

    await c.post(`/api/payments/${id}/reverse`, { reversalReason: 'Entered against the wrong villa' });
    const back = await read();
    eq('voiding it puts the ledger arrears back exactly', back.ledgerArrears, before.ledgerArrears);
    eq('voiding it puts the dashboard back exactly', back.delinquent, before.delinquent);
    eq('voiding it puts Form 13B back exactly', back.b13, before.b13);
    eq('voiding it puts the annual return back exactly', back.ann.received, before.ann.received);
    eq('voiding it puts the projection back exactly', back.proj.arrears, before.proj.arrears);
    eq('voiding it puts the operating statement back exactly', back.opSt.totalIncome, before.opSt.totalIncome);
    eq('voiding it puts the owner statements back exactly', back.ownersPaid, before.ownersPaid);
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return T.done();
}
