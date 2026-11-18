/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bank reconciliation covers money OUT as well as money in.
 *
 * Ro, 2026-11-18: until now only receipts could be ticked against the bank
 * statement. A cost the books say was paid, a refund handed back and a deposit
 * returned are movements on the same statement, and a ledger that can only
 * check one direction can hide the other: a supplier "paid" twice, a refund that
 * never left. The rules are the receipt's rules:
 *
 *   - only money that really moved: a paid cost, a refund paid, a deposit
 *     returned. Pending and voided costs are refused, each with its own code.
 *   - the statement date is never in the future and never before the movement.
 *   - each item is matched at most once; moving it is an un-match and a match.
 *   - one statement line settles one item, across every kind (a receipt and a
 *     cost cannot share a line); a second needs the money-check override:
 *     permission (403 for a junior), a reason (400 without), an audit line.
 *   - USD and JMD never combine.
 *   - a matched cost later voided or edited loses its tick, and integrity reports
 *     any tick left on money that did not move.
 *   - the screen's in / out / net totals agree with the raw ledger.
 *
 * Dates are fixed in October 2026; nothing here reads the clock (the one future
 * date is 2099, which is the future on any clock this will run under).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Bank reconciliation: money out (costs, refunds, returned deposits)';

async function bundle(projectRoot, entry, external = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-bankout-'));
  const outfile = path.join(dir, 'mod.mjs');
  await build({ entryPoints: [path.join(projectRoot, ...entry)], bundle: true, format: 'esm', platform: 'neutral', external, outfile, logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const C = n => Math.round(n * 100);

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'BankOut-1234!', projectRoot });
  const T = reporter(title);
  const rec = await bundle(projectRoot, ['src', 'lib', 'bankRec.ts']);
  const fin = await bundle(projectRoot, ['src', 'lib', 'finance.ts']);
  const integ = await bundle(projectRoot, ['server', 'integrity.ts'], ['crypto', 'fs', 'path']);
  try {
    // Sent exactly as given: no override reason is added behind the test's back.
    const admin = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(admin, 'BankOut-1234!', 'BankOutNew-9876!');
    await makeLongTermUnit(admin, 'unit-1');
    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });

    const expense = async (over) =>
      (await admin.post('/api/expenses', { category: 'Contractors', vendor: 'Acme Pumps', description: 'probe', amount: 12000, currency: 'JMD', date: '2026-10-05', datePaid: '2026-10-06', status: 'paid', paymentMethod: 'Bank Transfer', ...over })).body?.expense;
    const paid = await expense({});
    const pending = await expense({ vendor: 'Pending Co', amount: 3000, status: 'pending' });
    const toVoid = await expense({ vendor: 'Wrong Bill Ltd', amount: 4000 });
    const usd = await expense({ vendor: 'US Supplier', amount: 200, currency: 'USD' });
    const credit = await expense({ vendor: 'JPS Credit', amount: -1500, date: '2026-10-08', datePaid: '2026-10-08' });
    T.check('setup: paid, pending, to-void, USD and credit costs recorded', [paid, pending, toVoid, usd, credit].every(e => e?.id), JSON.stringify([paid, pending, toVoid, usd, credit].map(e => e?.status)));

    const receipt = (await recordAndConfirmPayment(admin, { unitId: 'unit-1', category: 'Other', amount: 8000, currency: 'JMD', payerName: 'Tenant', method: 'Bank Transfer', date: '2026-10-02' })).body?.payment;
    const refunded = await admin.post(`/api/payments/${receipt?.id}/refund`, { amount: 2000, refundedOn: '2026-10-09', reason: 'overpaid', method: 'Bank Transfer' });
    T.check('setup: a receipt with JMD 2,000 refunded on 2026-10-09', refunded.status === 200 && refunded.body?.payment?.refundedAmount === 2000, `${refunded.status} ${JSON.stringify(refunded.body).slice(0, 200)}`);

    let db = (await admin.get('/api/db')).body;
    const tenancy = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    await admin.post(`/api/tenancies/${tenancy.id}/deposit`, { amount: 50000, currency: 'JMD', method: 'Bank Transfer', receivedOn: '2026-10-01' });
    const settled = await admin.post(`/api/tenancies/${tenancy.id}/deposit/settle`, { returnedAmount: 45000, withheldAmount: 5000, withheldReason: 'broken window', settledOn: '2026-10-12' });
    T.check('setup: a deposit of 50,000 settled, 45,000 returned', settled.status === 200 && settled.body?.tenancy?.depositReturnedAmount === 45000, `${settled.status} ${JSON.stringify(settled.body).slice(0, 200)}`);

    const R = (kind, id) =>
      kind === 'expense' ? `/api/expenses/${id}/reconcile`
      : kind === 'refund' ? `/api/payments/${id}/refund/reconcile`
      : `/api/tenancies/${id}/deposit/reconcile`;
    const audit = async re => (await admin.get('/api/db')).body.auditLogs.find(l => re.test(l.action));

    /* ---------------- match a paid cost ---------------- */
    const m1 = await admin.post(R('expense', paid.id), { reconciledOn: '2026-10-07', reference: 'NCB OUT 1', currency: 'JMD' });
    T.check('a paid cost is matched to the statement', m1.status === 200 && m1.body?.record?.bankMatch?.on === '2026-10-07' && m1.body.record.bankMatch.reference === 'NCB OUT 1', `${m1.status} ${JSON.stringify(m1.body)}`);
    T.check('the match is audited with the item, amount and statement date', !!(await audit(/^Matched the payment to Acme Pumps \(JMD 12000\) to the bank statement of 2026-10-07/)));

    /* ---------------- refusals, each with its code ---------------- */
    const code = r => `${r.status} ${r.body?.code}`;
    const future = await admin.post(R('expense', toVoid.id), { reconciledOn: '2099-01-01' });
    T.check('a future statement date is refused (bank-date-in-future)', code(future) === '400 bank-date-in-future', code(future));
    const early = await admin.post(R('expense', toVoid.id), { reconciledOn: '2026-10-05' });
    T.check('a statement date before the cost was paid is refused (bank-date-before-item)', code(early) === '400 bank-date-before-item', code(early));
    const pend = await admin.post(R('expense', pending.id), { reconciledOn: '2026-10-07' });
    T.check('a pending cost is refused (bank-item-not-paid)', code(pend) === '400 bank-item-not-paid', code(pend));
    const again = await admin.post(R('expense', paid.id), { reconciledOn: '2026-10-08' });
    T.check('matching the same cost twice is refused (bank-item-already-matched)', code(again) === '400 bank-item-already-matched', code(again));
    db = (await admin.get('/api/db')).body;
    T.check('and the first match still stands, unmoved', db.expenses.find(e => e.id === paid.id).bankMatch?.on === '2026-10-07');
    const cur = await admin.post(R('expense', usd.id), { reconciledOn: '2026-10-07', currency: 'JMD' });
    T.check('a USD cost ticked on the JMD statement is refused (bank-currency-mismatch)', code(cur) === '400 bank-currency-mismatch', code(cur));
    const curOk = await admin.post(R('expense', usd.id), { reconciledOn: '2026-10-07', currency: 'USD' });
    T.check('the same USD cost on the USD statement is matched (positive control)', curOk.status === 200, code(curOk));
    const curRcpt = await admin.post(`/api/payments/${receipt.id}/reconcile`, { reconciledOn: '2026-10-03', currency: 'USD' });
    T.check('the receipt route refuses the other currency the same way', code(curRcpt) === '400 bank-currency-mismatch', code(curRcpt));

    /* ---------------- a matched cost later voided loses its tick ---------------- */
    const mv = await admin.post(R('expense', toVoid.id), { reconciledOn: '2026-10-07' });
    T.check('(setup) the soon-to-be-voided cost is matched', mv.status === 200, code(mv));
    const voided = await admin.post(`/api/expenses/${toVoid.id}/void`, { reason: 'bill entered twice', confirmSettled: true });
    T.check('(setup) the matched cost is voided', voided.status === 200, `${voided.status} ${JSON.stringify(voided.body).slice(0, 200)}`);
    T.check('voiding a matched cost clears its bank tick', voided.body?.expense && !voided.body.expense.bankMatch, JSON.stringify(voided.body?.expense?.bankMatch));
    const vm = await admin.post(R('expense', toVoid.id), { reconciledOn: '2026-10-07' });
    T.check('a voided cost cannot be matched (bank-item-voided)', code(vm) === '400 bank-item-voided', code(vm));

    /* ---------------- editing the money drops the tick ---------------- */
    const ed = await expense({ vendor: 'Edit Me Ltd', amount: 900 });
    await admin.post(R('expense', ed.id), { reconciledOn: '2026-10-07' });
    const same = await admin.put(`/api/expenses/${ed.id}`, { description: 'wording only' });
    T.check('an edit that leaves the money alone keeps the tick (positive control)', same.status === 200 && !!same.body?.expense?.bankMatch, code(same));
    const moved = await admin.put(`/api/expenses/${ed.id}`, { amount: 950 });
    T.check('changing the amount of a matched cost drops the tick', moved.status === 200 && !moved.body?.expense?.bankMatch, JSON.stringify(moved.body?.expense?.bankMatch));

    /* ---------------- one line, one item, across every kind ---------------- */
    const twin = await admin.post(R('refund', receipt.id), { reconciledOn: '2026-10-10', reference: 'ncb out 1' });
    T.check('a refund on a line already used by a cost is refused (bank-line-already-matched)', code(twin) === '400 bank-line-already-matched' && /payment to Acme Pumps/.test(twin.body?.error || twin.body?.message || ''), `${code(twin)} ${JSON.stringify(twin.body)}`);
    const rTwin = await admin.post(`/api/payments/${receipt.id}/reconcile`, { reconciledOn: '2026-10-03', reference: 'NCB OUT 1' });
    T.check('a receipt on that same line is refused too: the receipt route sees money-out lines', code(rTwin) === '400 bank-line-already-matched', code(rTwin));
    const jrOver = await jr.post(R('refund', receipt.id), { reconciledOn: '2026-10-10', reference: 'NCB OUT 1', confirmSameLine: true, overrideReason: 'two lines, one reference' });
    T.check('a junior cannot override it (403 override-not-permitted)', code(jrOver) === '403 override-not-permitted', code(jrOver));
    const noWhy = await admin.post(R('refund', receipt.id), { reconciledOn: '2026-10-10', reference: 'NCB OUT 1', confirmSameLine: true });
    T.check('an administrator overriding without a reason is refused (400 override-reason-required)', code(noWhy) === '400 override-reason-required', code(noWhy));
    db = (await admin.get('/api/db')).body;
    T.check('nothing was matched by the refused attempts', !db.payments.find(p => p.id === receipt.id).refundBankMatch && !db.payments.find(p => p.id === receipt.id).reconciledOn);
    const why = await admin.post(R('refund', receipt.id), { reconciledOn: '2026-10-10', reference: 'NCB OUT 1', confirmSameLine: true, overrideReason: 'Bank posted the cheque and the refund under one reference' });
    T.check('with a reason the administrator can match it', why.status === 200 && why.body?.record?.refundBankMatch?.on === '2026-10-10', code(why));
    const ov = await audit(/Overrode a money check: bank reference "NCB OUT 1"/);
    T.check('the override is in the audit log with who and why', !!ov && /one reference/.test(ov.action) && !!ov.user, JSON.stringify(ov));

    /* ---------------- refunds and deposits: the junior's ordinary tick ---------------- */
    const dep = await jr.post(R('deposit', tenancy.id), { reconciledOn: '2026-10-13' });
    T.check('a junior can match a returned deposit with no shared line (positive control)', dep.status === 200 && dep.body?.record?.depositReturnBankMatch?.on === '2026-10-13', code(dep));
    const depEarly = await admin.post(R('deposit', tenancy.id), { reconciledOn: '2026-10-11', reconciled: true });
    T.check('a matched deposit cannot be re-dated without un-matching (bank-item-already-matched)', code(depEarly) === '400 bank-item-already-matched', code(depEarly));

    /* ---------------- unmatch ---------------- */
    const un = await admin.post(R('refund', receipt.id), { reconciled: false });
    T.check('a matched refund can be un-matched', un.status === 200 && !un.body?.record?.refundBankMatch, code(un));
    T.check('the un-match is audited', !!(await audit(/^Un-matched the refund on receipt .* from the bank statement of 2026-10-10/)));
    const un2 = await admin.post(R('refund', receipt.id), { reconciled: false });
    T.check('un-matching what is not matched is refused (bank-item-not-matched)', code(un2) === '400 bank-item-not-matched', code(un2));
    const reMatch = await admin.post(R('refund', receipt.id), { reconciledOn: '2026-10-10', reference: 'NCB OUT 2' });
    T.check('and re-matched on its own line', reMatch.status === 200, code(reMatch));
    const nothing = await admin.post(R('refund', (await recordAndConfirmPayment(admin, { unitId: 'unit-1', category: 'Other', amount: 100, currency: 'JMD', payerName: 'X', method: 'Cash', date: '2026-10-02' })).body.payment.id), { reconciledOn: '2026-10-10' });
    T.check('a receipt with no refund has no refund to match (bank-nothing-to-match)', code(nothing) === '400 bank-nothing-to-match', code(nothing));
    const crd = await admin.post(R('expense', credit.id), { reconciledOn: '2026-10-09' });
    T.check('a paid supplier credit can be matched (money back in)', crd.status === 200, code(crd));

    /* ---------------- totals agree with the ledger ---------------- */
    db = (await admin.get('/api/db')).body;
    const input = { payments: db.payments, expenses: db.expenses, tenancies: db.tenancies, bookings: db.bookings };
    const br = rec.mod.bankReconciliation(input, 'JMD', '2026-10-01', '2026-10-31');
    const inOct = d => d >= '2026-10-01' && d <= '2026-10-31';
    const ledgerOut =
      db.expenses.filter(e => e.status === 'paid' && e.currency === 'JMD' && e.amount > 0 && inOct(e.datePaid || e.date)).reduce((s, e) => s + C(e.amount), 0) +
      db.payments.filter(p => p.status === 'completed' && p.currency === 'JMD' && p.refundedAmount && inOct(p.refundedOn)).reduce((s, p) => s + C(p.refundedAmount), 0) +
      db.tenancies.filter(t => (t.depositCurrency || t.currency) === 'JMD' && t.depositReturnedAmount > 0 && inOct(t.depositReturnedOn)).reduce((s, t) => s + C(t.depositReturnedAmount), 0);
    const ledgerIn =
      db.payments.filter(p => p.status === 'completed' && !p.derived && p.currency === 'JMD' && inOct(p.date)).reduce((s, p) => s + C(p.amount), 0) +
      db.expenses.filter(e => e.status === 'paid' && e.currency === 'JMD' && e.amount < 0 && inOct(e.datePaid || e.date)).reduce((s, e) => s - C(e.amount), 0);
    T.check('money out equals paid costs + refunds + returned deposits from the raw ledger', C(br.moneyOut.total) === ledgerOut, `${C(br.moneyOut.total)} vs ${ledgerOut}`);
    T.check('money out is 12,000 + 950 + 2,000 + 45,000 here (no pending, no void, no USD)', C(br.moneyOut.total) === C(12000 + 950 + 2000 + 45000), `${br.moneyOut.total}`);
    T.check('money in equals completed receipts gross + supplier credits', C(br.moneyIn.total) === ledgerIn, `${C(br.moneyIn.total)} vs ${ledgerIn}`);
    const receiptsOnly = fin.mod.reconciliation(db.payments, 'JMD', '2026-10-01', '2026-10-31');
    T.check('the receipts within money in are exactly the existing receipt reconciliation', C(br.moneyIn.items.filter(i => i.kind === 'receipt').reduce((s, i) => s + i.amount, 0)) === C(receiptsOnly.total), `${receiptsOnly.total}`);
    for (const [name, s] of [['in', br.moneyIn], ['out', br.moneyOut]]) {
      T.check(`money ${name}: matched + not found = ledger`, C(s.matchedTotal) + C(s.unmatchedTotal) === C(s.total));
    }
    T.check('net movement is in less out, on every line', C(br.net.total) === C(br.moneyIn.total) - C(br.moneyOut.total) && C(br.net.matched) === C(br.moneyIn.matchedTotal) - C(br.moneyOut.matchedTotal) && C(br.net.unmatched) === C(br.moneyIn.unmatchedTotal) - C(br.moneyOut.unmatchedTotal));
    T.check('matched out is the cost, the edited-then-unticked cost excluded, the refund and the deposit', C(br.moneyOut.matchedTotal) === C(12000 + 2000 + 45000), `${br.moneyOut.matchedTotal}`);
    T.check('USD never appears in the JMD reconciliation', [...br.moneyIn.items, ...br.moneyOut.items].every(i => i.currency === 'JMD'));
    const brUsd = rec.mod.bankReconciliation(input, 'USD', '2026-10-01', '2026-10-31');
    T.check('the USD cost is in the USD reconciliation, matched', brUsd.moneyOut.total === 200 && brUsd.moneyOut.matchedTotal === 200, JSON.stringify(brUsd.moneyOut.total));
    T.check('pending and voided costs are in neither list', ![...br.moneyOut.items, ...br.moneyIn.items].some(i => i.id === pending.id || i.id === toVoid.id));

    const live = (await admin.get('/api/integrity')).body;
    const liveCodes = (live.findings || []).map(f => f.code);
    T.check('the live records raise no bank-match finding after all of this', !liveCodes.some(c => ['unpaid-cost-reconciled', 'bank-match-without-money-out'].includes(c)), liveCodes.join(','));
    T.check('once the refund moved to its own line, no statement line is matched twice', !liveCodes.includes('bank-line-matched-twice'), liveCodes.join(','));

    /* ---------------- integrity: a tick on money that did not move ---------------- */
    const { checkIntegrity } = integ.mod;
    const base = () => ({
      schemaVersion: 3, units: [], tenancies: [], bookings: [], charges: [], utilities: [], recurringExpenses: [], annualReports: [], auditLogs: [], unitActivities: [], users: [], sessions: [],
      counters: { receiptYear: 2026, receiptSeq: 1 }, settings: {},
      payments: [{ id: 'p-1', unitId: '', unitNumber: 'General', category: 'Other', amount: 500, currency: 'JMD', date: '2026-10-02', status: 'completed', receiptNo: 'REC-2026-0001' }],
      expenses: [{ id: 'ex-1', category: 'Contractors', vendor: 'V', unitId: '', unitNumber: 'General', amount: 100, currency: 'JMD', date: '2026-10-01', datePaid: '2026-10-01', status: 'paid', reference: '', notes: '', bankMatch: { on: '2026-10-02', by: 'A', at: 'x' } }]
    });
    const codes = db2 => checkIntegrity(db2).findings.map(f => f.code);
    T.check('a matched paid cost raises nothing (positive control)', !codes(base()).includes('unpaid-cost-reconciled'), codes(base()).join(','));
    const v = base(); v.expenses[0].status = 'void';
    T.check('integrity reports a voided cost still ticked (unpaid-cost-reconciled)', codes(v).includes('unpaid-cost-reconciled'), codes(v).join(','));
    const p = base(); p.expenses[0].status = 'pending';
    T.check('integrity reports a pending cost ticked (unpaid-cost-reconciled)', codes(p).includes('unpaid-cost-reconciled'), codes(p).join(','));
    const rf = base(); rf.payments[0].refundBankMatch = { on: '2026-10-03', by: 'A', at: 'x' };
    T.check('integrity reports a refund tick with no refund (bank-match-without-money-out)', codes(rf).includes('bank-match-without-money-out'), codes(rf).join(','));
    const rfOk = base(); Object.assign(rfOk.payments[0], { refundedAmount: 100, refundedOn: '2026-10-03', refundBankMatch: { on: '2026-10-03', by: 'A', at: 'x' } });
    T.check('a refund tick on a real refund raises nothing (positive control)', !codes(rfOk).includes('bank-match-without-money-out'), codes(rfOk).join(','));
    const tw = base(); tw.expenses[0].bankMatch.reference = 'L1'; Object.assign(tw.payments[0], { reconciledOn: '2026-10-02', reconciledReference: 'l1' });
    T.check('integrity reports one line on a receipt and a cost (bank-line-matched-twice, across kinds)', codes(tw).includes('bank-line-matched-twice'), codes(tw).join(','));

    /* ---------------- the screen shows both directions ---------------- */
    const ui = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'Reconciliation.tsx'), 'utf8');
    T.check('the Reconciliation screen shows money in, money out and net movement', /Money in \(/.test(ui) && /Money out \(/.test(ui) && /Net movement/.test(ui) && /bankReconciliation\(/.test(ui));
    const app = fs.readFileSync(path.join(projectRoot, 'src', 'App.tsx'), 'utf8');
    T.check('App wires every money-out route to the screen', ['/api/expenses/${id}/reconcile', '/api/payments/${id}/refund/reconcile', '/api/tenancies/${id}/deposit/reconcile', '/api/bookings/${id}/damage-deposit/reconcile'].every(r => app.includes(r)));
  } finally {
    rec.cleanup();
    fin.cleanup();
    integ.cleanup();
    await srv.stop();
  }
  return T.done();
}
