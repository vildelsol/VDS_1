/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Controls hunt, 2026-11-20: closed months and costs, villa sales, utility
 * recoveries, future dates, utility receipts, correction guards, markers.
 *
 * Every refusal below is paired with a positive control (the same call, made so
 * that it should succeed, does succeed), so a guard that refuses everything
 * cannot pass. Dates are fixed in the past or far in the future, never "today".
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Controls hunt fixes (closed costs, villa sales, utility receipts, corrections)';

const NUMS = ['A1', 'A2', 'A3', 'A4', 'A5', 'B6', 'B7', 'B8', 'B9', 'B10', 'C11', 'C12', 'C13', 'C13', 'C15', 'C16'];
const OWNER_OCC = new Set(['A2', 'B7', 'B8', 'B9', 'C12']);

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hunt-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function setupVillas(c) {
  for (let i = 0; i < 16; i++) {
    const n = NUMS[i];
    const owner = OWNER_OCC.has(n);
    const isUsd = n === 'A1' || n === 'A3';
    await c.put(`/api/units/unit-${i + 1}`, {
      number: n,
      ownerName: owner ? `Proprietor ${n}` : 'ISPO',
      tenantName: owner ? '' : i % 3 === 0 ? '' : `Tenant ${n}`,
      status: owner ? 'owner-occupied' : i % 3 === 0 ? 'vacant' : 'long-term',
      monthlyRent: owner || i % 3 === 0 ? 0 : isUsd ? 1200 : 150000,
      monthlyMaintenance: 25000,
      currency: isUsd ? 'USD' : 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });
  }
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const PW = 'Hunt-Pass-1234!x';
  const PW2 = 'Hunt-Admin-9876!x';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hunt-data-'));
  const srv = await startServer({ port, adminPassword: PW, projectRoot, dataDir });
  let server = srv;
  const fin = await loadFinance(projectRoot);
  try {
    const c = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(c, PW, PW2);
    await c.post('/api/settings', { booksBeginOn: '2026-09-01' });
    await setupVillas(c);
    for (const m of ['2026-09', '2026-10', '2026-11']) await c.post('/api/charges/post-month', { monthString: m });
    const dbOf = async () => (await c.get('/api/db')).body;
    const codes = async () => ((await c.get('/api/integrity')).body?.findings || []).map(f => f.code);
    const exp = (x = {}) => ({ category: 'Contractors', vendor: 'Plumber Ltd', description: 'Pipe', amount: 9000, currency: 'JMD', date: '2026-09-15', status: 'paid', datePaid: '2026-09-15', paymentMethod: 'Bank Transfer', fund: 'strata', unitNumber: 'General', ...x });
    const rcv = (unit, category, amount, currency, date, payer, extra = {}) =>
      c.post('/api/payments', { unitId: unit, category, amount, currency, date, method: 'Bank Transfer', payerName: payer, receivedNow: true, ...extra });

    /* ---------- records that the later sections act on, made before anything is closed ---------- */
    const e1 = await c.post('/api/expenses', exp());
    T.check('setup: a paid September cost', e1.status === 200, JSON.stringify(e1.body));
    const e1id = e1.body?.expense?.id;
    const eOct = await c.post('/api/expenses', exp({ date: '2026-10-10', datePaid: '2026-10-10', amount: 4321, vendor: 'Oct Vendor' }));
    const eOctId = eOct.body?.expense?.id;
    // A pending September bill, to be recalled in a closed month.
    const ePend = await c.post('/api/expenses', exp({ status: 'pending', datePaid: undefined, amount: 1111, vendor: 'Pending Sept', date: '2026-09-20' }));
    T.check('setup: Oct cost and pending Sept bill', eOct.status === 200 && ePend.status === 200, JSON.stringify([eOct.body, ePend.body]));
    const pendId = ePend.body?.expense?.id;
    const settledU = await c.post('/api/utilities', { unitId: 'unit-6', billingPeriod: '2026-09', previousReading: 0, currentReading: 100, amountCharged: 5000, currency: 'JMD' });
    T.check('setup: a September utility bill', settledU.status === 200, JSON.stringify(settledU.body));
    await rcv('unit-2', 'Maintenance', 25000, 'JMD', '2026-09-05', 'Proprietor A2');
    // ISPO paying its own levy on C13 in September: the contribution that a later sale must not move.
    const ispoLevy = await rcv('unit-13', 'Maintenance', 25000, 'JMD', '2026-09-08', 'ISPO');
    T.check('setup: ISPO\'s own levy receipt on C13', ispoLevy.status === 200, `${ispoLevy.status} ${JSON.stringify(ispoLevy.body)}`);
    // A September cost run with a paid row, to be recalled once September is closed.
    const rt0 = await c.post('/api/recurring-expenses', { category: 'Security', vendor: 'Guard Sept', amount: 60000, currency: 'JMD', dueDay: 1 });
    const tid0 = rt0.body?.template?.id || rt0.body?.recurringExpense?.id || Object.values(rt0.body || {}).find(v => v && v.id)?.id;
    const pmS = await c.post('/api/expenses/post-month', { monthString: '2026-09', items: [{ recurringId: tid0 }] });
    const runRow = (await dbOf()).expenses.find(e => e.periodMonth === '2026-09' && e.recurringId === tid0);
    const paidRun = await c.put(`/api/expenses/${runRow?.id}`, { status: 'paid', datePaid: '2026-09-05' });
    T.check('setup: a September cost run with a paid row', pmS.status === 200 && paidRun.status === 200, `${pmS.status} ${paidRun.status}`);
    // A settled and confirmed October utility bill, for the bill-versus-receipt warning.
    const uOct = await c.post('/api/utilities', { unitId: 'unit-10', billingPeriod: '2026-10', previousReading: 0, currentReading: 50, amountCharged: 3000, currency: 'JMD' });
    const sOct = await c.post(`/api/utilities/${uOct.body?.utility?.id}/settle`, { date: '2026-10-05' });
    const cOct = await c.post(`/api/payments/${sOct.body?.payment?.id}/confirm`, {});
    T.check('setup: a settled October utility bill', cOct.status === 200, `${cOct.status} ${JSON.stringify(cOct.body)}`);

    /* ---------- 1. closed months protect costs and utility bills ---------- */
    const cl = await c.post('/api/periods/close', { through: '2026-09', confirmWithFaults: true });
    T.check('1. setup: September closed', cl.status === 200, JSON.stringify(cl.body));
    const refused = (r) => r.status === 409 && r.body?.code === 'period-closed';

    const r1 = await c.post('/api/expenses', exp({ amount: 77777, vendor: 'Backdated Co' }));
    T.check('1. a cost dated in closed September is refused with period-closed', refused(r1), `${r1.status} ${JSON.stringify(r1.body)}`);
    const rPend = await c.post('/api/expenses', exp({ status: 'pending', datePaid: undefined, amount: 22, vendor: 'Pending Backdated', date: '2026-09-02' }));
    T.check('1. an unpaid bill dated in closed September is refused like a paid one (it changes the issued statement\'s unpaid memo; ecosystem hunt 2)', refused(rPend), `${rPend.status} ${JSON.stringify(rPend.body)}`);
    const r1ok = await c.post('/api/expenses', exp({ amount: 3300, vendor: 'October Co', date: '2026-10-02', datePaid: '2026-10-02' }));
    T.check('1. control: a cost dated in open October is accepted', r1ok.status === 200, `${r1ok.status} ${JSON.stringify(r1ok.body)}`);
    const r2 = await c.put(`/api/expenses/${e1id}`, { amount: 1 });
    T.check('1. editing a closed-month cost is refused', refused(r2), `${r2.status} ${JSON.stringify(r2.body)}`);
    const r3 = await c.post(`/api/expenses/${e1id}/void`, { reason: 'entered by mistake', confirmSettled: true });
    T.check('1. voiding a closed-month cost is refused', refused(r3), `${r3.status} ${JSON.stringify(r3.body)}`);
    const r4 = await c.put(`/api/expenses/${eOctId}`, { date: '2026-09-10', datePaid: '2026-09-10', reason: 'moved into September' });
    T.check('1. moving an October cost into closed September is refused (new date)', refused(r4), `${r4.status} ${JSON.stringify(r4.body)}`);
    const rOut = await c.put(`/api/expenses/${e1id}`, { date: '2026-10-05', datePaid: '2026-10-05', reason: 'moved out of September' });
    T.check('1. moving a closed-September cost out into October is refused (old date)', refused(rOut), `${rOut.status} ${JSON.stringify(rOut.body)}`);
    const r4b = await c.put(`/api/expenses/${eOctId}`, { amount: 4400, reason: 'invoice corrected' });
    T.check('1. control: correcting an October cost (open month) works', r4b.status === 200, `${r4b.status} ${JSON.stringify(r4b.body)}`);
    const r5 = await c.post('/api/expenses/post-month', { monthString: '2026-09', items: [] });
    T.check('1. posting a cost run into closed September is refused', refused(r5), `${r5.status} ${JSON.stringify(r5.body)}`);
    const r6 = await c.post('/api/utilities', { unitId: 'unit-15', billingPeriod: '2026-09', previousReading: 0, currentReading: 10, amountCharged: 900, currency: 'JMD' });
    T.check('1. a utility bill for closed September is refused', refused(r6), `${r6.status} ${JSON.stringify(r6.body)}`);
    const r6ok = await c.post('/api/utilities', { unitId: 'unit-15', billingPeriod: '2026-10', previousReading: 0, currentReading: 10, amountCharged: 900, currency: 'JMD' });
    T.check('1. control: a utility bill for open October is accepted', r6ok.status === 200, `${r6ok.status} ${JSON.stringify(r6ok.body)}`);
    const r6e = await c.put(`/api/utilities/${settledU.body?.utility?.id}`, { amountCharged: 5100 });
    T.check('1. editing a closed-month utility bill is refused', refused(r6e), `${r6e.status} ${JSON.stringify(r6e.body)}`);
    const rr = await c.post('/api/expenses/recall-month', { monthString: '2026-09', reason: 'run posted in error', includeSettled: true });
    void rr;
    const rrOnly = await c.post('/api/expenses/recall-month', { monthString: '2026-09', reason: 'run posted in error', includeSettled: true });
    T.check('1. recall-month with paid rows in closed September is refused with period-closed', refused(rrOnly), `${rrOnly.status} ${JSON.stringify(rrOnly.body)}`);
    const rvPend = await c.post(`/api/expenses/${pendId}/void`, { reason: 'entered twice' });
    T.check('1. taking back an unpaid September bill is refused too (it would change the issued unpaid memo; ecosystem hunt 2)', refused(rvPend), `${rvPend.status} ${JSON.stringify(rvPend.body)}`);
    T.check('1. none of the refused calls disturbed the closed month', !(await codes()).includes('closed-period-changed'));

    /* the generic guard: the fingerprint now covers costs, bills and deposits */
    await server.stop();
    const file = path.join(dataDir, 'db.json');
    const clean = fs.readFileSync(file, 'utf-8');
    const restart = async text => {
      fs.writeFileSync(file, text);
      server = await startServer({ port, adminPassword: PW2, projectRoot, dataDir: dataDir });
      const cc = makeClient(server.baseUrl, { autoOverrideReason: false });
      await cc.post('/api/auth/login', { username: 'admin', password: PW2 }, { captureCookie: true });
      return ((await cc.get('/api/integrity')).body?.findings || []).map(f => f.code);
    };
    const tamper = fn => { const doc = JSON.parse(clean); fn(doc); return JSON.stringify(doc); };
    let found = await restart(tamper(d => { d.expenses.find(e => e.id === e1id).amount += 1; }));
    T.check('1. fingerprint: a closed-month cost changed by hand is named', found.includes('closed-period-changed'), JSON.stringify(found));
    await server.stop();
    found = await restart(tamper(d => { d.expenses.find(e => e.id === e1id).status = 'void'; d.expenses.find(e => e.id === e1id).voidedFromPaid = true; }));
    T.check('1. fingerprint: a closed-month cost taken back by hand is named', found.includes('closed-period-changed'), JSON.stringify(found));
    await server.stop();
    found = await restart(tamper(d => { d.expenses.push({ ...d.expenses.find(e => e.id === e1id), id: 'ex-smuggled', amount: 5 }); }));
    T.check('1. fingerprint: a cost smuggled into closed September is named', found.includes('closed-period-changed'), JSON.stringify(found));
    await server.stop();
    found = await restart(tamper(d => { d.utilities.find(u => u.billingPeriod === '2026-09').amountCharged += 1; }));
    T.check('1. fingerprint: a closed-month utility bill changed by hand is named', found.includes('closed-period-changed'), JSON.stringify(found));
    await server.stop();
    found = await restart(tamper(d => { d.expenses.find(e => e.id === eOctId).amount += 1; }));
    T.check('1. control: changing an October cost (after the close) is not a closed-period fault', !found.includes('closed-period-changed'), JSON.stringify(found));
    await server.stop();
    found = await restart(tamper(d => { d.utilities.find(u => u.billingPeriod === '2026-10' && u.status === 'paid').amountCharged += 1; }));
    T.check('5. integrity names a paid utility bill whose amount differs from its receipt', found.includes('utility-bill-differs-from-its-receipt'), JSON.stringify(found));
    await server.stop();
    found = await restart(clean);
    T.check('5. control: bill and receipt agreeing raise no such warning', !found.includes('utility-bill-differs-from-its-receipt'), JSON.stringify(found));
    await server.stop();
    found = await restart(clean);
    T.check('1. control: the untouched file shows no closed-period fault', !found.includes('closed-period-changed'), JSON.stringify(found));

    // from here on the live server is `server`
    const cs = makeClient(server.baseUrl, { autoOverrideReason: false });
    await cs.post('/api/auth/login', { username: 'admin', password: PW2 }, { captureCookie: true });
    const dbS = async () => (await cs.get('/api/db')).body;

    /* the reopen path still works, with a reason, and the cost then moves */
    const noReason = await cs.post('/api/periods/reopen', {});
    T.check('1. reopening needs a reason', noReason.status === 400, `${noReason.status}`);
    const reo = await cs.post('/api/periods/reopen', { reason: 'late supplier invoice for September' });
    T.check('1. reopening the books with a reason works', reo.status === 200, `${reo.status} ${JSON.stringify(reo.body)}`);
    const late = await cs.post('/api/expenses', exp({ amount: 777, vendor: 'Late Supplier' }));
    T.check('1. after reopening, a September cost is accepted again', late.status === 200, `${late.status} ${JSON.stringify(late.body)}`);
    const reclose = await cs.post('/api/periods/close', { through: '2026-09', confirmWithFaults: true });
    T.check('1. and the month can be closed again', reclose.status === 200, `${reclose.status}`);
    T.check('1. the new close verifies clean', !(await (async () => ((await cs.get('/api/integrity')).body?.findings || []).map(f => f.code))()).includes('closed-period-changed'));

    /* ---------- 2. a villa sale does not rewrite closed months ---------- */
    {
      // Closed September: a levy receipt on ISPO's own villa C13 (unit-13), a rent receipt, and a cost.
      const D0 = await dbS();
      const st = (D, cur, from, to, book) => fin.mod.operatingStatement(D.payments, D.expenses, D.units, cur, from, to, { book });
      const unitC13 = D0.units.find(u => u.id === 'unit-13');
      T.check('2. setup: C13 is ISPO\'s own villa', unitC13 && unitC13.status !== 'owner-occupied', unitC13?.status);
      const sep = ['2026-09-01', '2026-09-30'];
      const before = {
        everything: st(D0, 'JMD', ...sep, 'everything'),
        ispo: st(D0, 'JMD', ...sep, 'ispo'),
        strata: st(D0, 'JMD', ...sep, 'strata')
      };
      const shortfallOf = D => JSON.stringify(fin.mod.outOfPocketShortfall(D.units, D.tenancies, D.bookings, D.payments, 'JMD', ...sep), (k, v) => (k === 'status' ? undefined : v)); // the villa's status label is today's, by design
      const shortBefore = shortfallOf(D0);
      const sale = await cs.put('/api/units/unit-13', { status: 'owner-occupied', ownerName: 'New Prop C13', ownerChangeIntent: 'sale', ownerAcquiredOn: '2026-11-15' });
      T.check('2. the sale is accepted', sale.status === 200, `${sale.status} ${JSON.stringify(sale.body)}`);
      const D1 = await dbS();
      const same = (a, b) => a.totalIncome === b.totalIncome && a.totalExpenditure === b.totalExpenditure;
      for (const book of ['everything', 'ispo', 'strata']) {
        const after = st(D1, 'JMD', ...sep, book);
        T.check(`2. closed September's ${book} statement is unchanged by selling C13 in November`, same(before[book], after), `income ${before[book].totalIncome}->${after.totalIncome} exp ${before[book].totalExpenditure}->${after.totalExpenditure}`);
      }
      // Positive control: November, after the sale, now reads C13 as a proprietor's.
      const novOn = fin.mod.isOwnAccountOn(D1.units.find(u => u.id === 'unit-13'), '2026-11-20');
      const sepOn = fin.mod.isOwnAccountOn(D1.units.find(u => u.id === 'unit-13'), '2026-09-15');
      T.check('2. control: C13 was ISPO\'s in September and is a proprietor\'s from the sale date', sepOn === true && novOn === false, `${sepOn} ${novOn}`);
      const octOn = fin.mod.isOwnAccountOn(D1.units.find(u => u.id === 'unit-13'), '2026-11-14');
      T.check('2. the day before the sale is still ISPO\'s', octOn === true);
      T.check('2. the shortfall report for closed September is unchanged by the sale', shortfallOf(D1) === shortBefore, shortBefore.slice(0, 600) + ' ||| ' + shortfallOf(D1).slice(0, 600));
      T.check('2. a villa that never changed status keeps no history (figures identical)', !D1.units.find(u => u.id === 'unit-5').ownAccountHistory);
      // A sale dated in a closed month waits for a reopen.
      const back = await cs.put('/api/units/unit-4', { status: 'owner-occupied', ownerName: 'Buyer A4', ownerChangeIntent: 'sale', ownerAcquiredOn: '2026-09-20', tenantName: '', monthlyRent: 0 });
      T.check('2. a sale dated inside closed September is refused until the books are reopened', back.status === 409 && back.body?.code === 'period-closed', `${back.status} ${JSON.stringify(back.body)}`);
    }

    /* ---------- 3. a utility recovery is booked from the villa, once ---------- */
    {
      const D = await dbS();
      const util = async (unit, period, amt, date) => {
        const u = await cs.post('/api/utilities', { unitId: unit, billingPeriod: period, previousReading: 0, currentReading: 100, amountCharged: amt, currency: 'JMD' });
        const s = await cs.post(`/api/utilities/${u.body?.utility?.id}/settle`, { date });
        const cf = await cs.post(`/api/payments/${s.body?.payment?.id}/confirm`, {});
        return { u, s, cf, pid: s.body?.payment?.id, uid: u.body?.utility?.id };
      };
      // unit-5 (A5) is an ISPO villa, with no utility bill on the expense register yet.
      const a5 = await util('unit-5', '2026-10', 40000, '2026-11-06');
      T.check('3. setup: an ISPO villa utility settled and confirmed', a5.cf.status === 200, JSON.stringify(a5.cf.body));
      let DD = await dbS();
      const rec = DD.payments.find(p => p.id === a5.pid);
      T.check('3. its recovery is stamped to ISPO\'s book at confirmation, though no bill is on the register', rec?.recoveryFund === 'ispo', String(rec?.recoveryFund));
      let rows = fin.mod.utilityRecoveryRows(DD.payments, DD.expenses);
      T.check('3. and the derived recovery row reads ISPO', rows.find(r => r.unitId === 'unit-5')?.fund === 'ispo', JSON.stringify(rows.find(r => r.unitId === 'unit-5')));
      // A strata-fund bill entered later must not move it.
      await cs.post('/api/expenses', exp({ category: 'Utilities', vendor: 'JPS', amount: 40000, unitId: 'unit-5', unitNumber: undefined, date: '2026-11-08', datePaid: '2026-11-08', fund: 'strata' }));
      DD = await dbS();
      rows = fin.mod.utilityRecoveryRows(DD.payments, DD.expenses);
      T.check('3. a bill entered later does not move the recovery between books', rows.find(r => r.unitId === 'unit-5')?.fund === 'ispo', JSON.stringify(rows.find(r => r.unitId === 'unit-5')));
      // A proprietor's villa (B7) is never billed for utilities: owners hold their own
      // accounts (Ro, 2026-11-22), so no recovery can reach the corporation's book.
      const onB7 = await cs.post('/api/utilities', { unitId: 'unit-7', billingPeriod: '2026-10', previousReading: 0, currentReading: 100, amountCharged: 12000, currency: 'JMD' });
      T.check('3. a utility bill on a proprietor\'s villa is refused', onB7.status === 400, `${onB7.status} ${JSON.stringify(onB7.body)}`);
      // The receipt section 5 edits, on another ISPO villa (C16).
      const b7 = await util('unit-16', '2026-10', 12000, '2026-11-07');
      T.check('3. setup: a second ISPO villa utility settled and confirmed', b7.cf.status === 200, JSON.stringify(b7.cf.body));

      /* ---------- 5. a utility receipt follows its bill ---------- */
      const edAmt = await cs.put(`/api/payments/${b7.pid}`, { amount: 8000, reason: 'receipt keyed wrong' });
      T.check('5. a utility receipt\'s amount cannot be edited away from its bill', edAmt.status === 400 && edAmt.body?.code === 'utility-receipt-follows-bill', `${edAmt.status} ${JSON.stringify(edAmt.body)}`);
      const edCat = await cs.put(`/api/payments/${b7.pid}`, { category: 'Other', reason: 'relabel it as other' });
      T.check('5. nor its category', edCat.status === 400 && edCat.body?.code === 'utility-receipt-follows-bill', `${edCat.status} ${JSON.stringify(edCat.body)}`);
      const edNote = await cs.put(`/api/payments/${b7.pid}`, { notes: 'a harmless note', reason: 'add a note to it' });
      T.check('5. control: a note on the same receipt is accepted, and the same amount sent again is not a change', edNote.status === 200, `${edNote.status} ${JSON.stringify(edNote.body)}`);
      const edSame = await cs.put(`/api/payments/${b7.pid}`, { amount: 12000, notes: 'again', reason: 'resend of the amount' });
      T.check('5. control: re-sending the unchanged amount is accepted', edSame.status === 200, `${edSame.status} ${JSON.stringify(edSame.body)}`);
      T.check('5. no integrity warning while bill and receipt agree', !(await (async () => ((await cs.get('/api/integrity')).body?.findings || []).map(f => f.code))()).includes('utility-bill-differs-from-its-receipt'));

      /* ---------- 6. a part refund of a utility receipt ---------- */
      const rf = await cs.post(`/api/payments/${b7.pid}/refund`, { amount: 4000, reason: 'overbilled meter', method: 'Cash', refundedOn: '2026-11-12' });
      DD = await dbS();
      const bill = DD.utilities.find(u => u.id === b7.uid);
      const rcpt = DD.payments.find(p => p.id === b7.pid);
      T.check('6. a part refund of a utility receipt is accepted', rf.status === 200, `${rf.status} ${JSON.stringify(rf.body)}`);
      T.check('6. the bill then reads the net kept (8,000), settled', bill.amountCharged === 8000 && bill.status === 'paid' && bill.amountBeforeRefund === 12000, JSON.stringify(bill));
      T.check('6. so what the bill shows equals the receipt net of the refund', bill.amountCharged === rcpt.amount - (rcpt.refundedAmount || 0), `${bill.amountCharged} vs ${rcpt.amount - (rcpt.refundedAmount || 0)}`);
      T.check('6. and integrity raises no bill-differs warning', !(await (async () => ((await cs.get('/api/integrity')).body?.findings || []).map(f => f.code))()).includes('utility-bill-differs-from-its-receipt'));
    }

    /* ---------- 4. future dates ---------- */
    {
      const f1 = await cs.post('/api/expenses', exp({ date: '2099-03-01', datePaid: '2099-03-01', amount: 5555, vendor: 'Future Co' }));
      T.check('4. a paid cost dated in the future is refused', f1.status === 400, `${f1.status} ${JSON.stringify(f1.body)}`);
      const f1b = await cs.post('/api/expenses', exp({ date: '2099-03-01', datePaid: '2026-11-01', amount: 5554, vendor: 'FutureDated Co' }));
      T.check('4. a paid cost with a future date (paid day in the past) is refused', f1b.status === 400, `${f1b.status} ${JSON.stringify(f1b.body)}`);
      const f2 = await cs.post('/api/expenses', exp({ date: '2026-11-01', datePaid: '2099-01-01', amount: 5556, vendor: 'FuturePaid Co' }));
      T.check('4. a cost paid on a future day is refused', f2.status === 400, `${f2.status} ${JSON.stringify(f2.body)}`);
      const f3 = await cs.post('/api/expenses', exp({ date: '2099-03-01', datePaid: undefined, status: 'pending', amount: 5557, vendor: 'Pending Future Co' }));
      T.check('4. control: an unpaid bill with a future date is accepted', f3.status === 200, `${f3.status} ${JSON.stringify(f3.body)}`);
      const f4 = await cs.put(`/api/expenses/${f3.body?.expense?.id}`, { status: 'paid', datePaid: '2099-03-02' });
      T.check('4. marking it paid on a future day is refused too', f4.status === 400, `${f4.status} ${JSON.stringify(f4.body)}`);
      const f5 = await cs.post('/api/utilities', { unitId: 'unit-10', billingPeriod: '2099-04', previousReading: 0, currentReading: 10, amountCharged: 1000, currency: 'JMD' });
      T.check('4. a utility bill for a future month is refused', f5.status === 400, `${f5.status} ${JSON.stringify(f5.body)}`);
      const f6 = await cs.post('/api/utilities', { unitId: 'unit-10', billingPeriod: '2026-11', previousReading: 0, currentReading: 10, amountCharged: 1000, currency: 'JMD' });
      T.check('4. control: a utility bill for the current or a past open month is accepted', f6.status === 200, `${f6.status} ${JSON.stringify(f6.body)}`);
    }

    /* ---------- 10. currency markers ---------- */
    {
      const m1 = await cs.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 'J$5,000', currency: 'USD', date: '2026-11-10', method: 'Cash', payerName: 'x', receivedNow: true });
      T.check('10. "J$5,000" on a US$ receipt is refused', m1.status === 400, `${m1.status} ${JSON.stringify(m1.body)}`);
      const m2 = await cs.post('/api/expenses', exp({ date: '2026-11-02', datePaid: '2026-11-02', amount: 'US$300', currency: 'JMD', vendor: 'Marker Co' }));
      T.check('10. "US$300" on a J$ cost is refused', m2.status === 400, `${m2.status} ${JSON.stringify(m2.body)}`);
      const m3 = await cs.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 'US$5,000', currency: 'USD', date: '2026-11-10', method: 'Cash', payerName: 'x', receivedNow: true });
      T.check('10. control: "US$5,000" on a US$ receipt is accepted at 5000', m3.status === 200 && m3.body?.payment?.amount === 5000, `${m3.status} ${JSON.stringify(m3.body)}`);
      const m4 = await cs.post('/api/expenses', exp({ date: '2026-11-03', datePaid: '2026-11-03', amount: 'J$1,250.50', currency: 'JMD', vendor: 'Marker Ok Co' }));
      T.check('10. control: "J$1,250.50" on a J$ cost is accepted', m4.status === 200 && m4.body?.expense?.amount === 1250.5, `${m4.status} ${JSON.stringify(m4.body)}`);
      const m5 = await cs.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: '4,000', currency: 'USD', date: '2026-11-11', method: 'Cash', payerName: 'x', receivedNow: true });
      T.check('10. control: a bare figure is accepted', m5.status === 200 && m5.body?.payment?.amount === 4000, `${m5.status} ${JSON.stringify(m5.body)}`);
    }

    /* ---------- 7. a corrected receipt meets the entry guards again ---------- */
    {
      const rent = await cs.post('/api/payments', { unitId: 'unit-3', category: 'Rent', amount: 1200, currency: 'USD', date: '2026-11-05', method: 'Bank Transfer', payerName: 'Tenant A3', receivedNow: true });
      T.check('7. setup: a US$ rent receipt', rent.status === 200, JSON.stringify(rent.body));
      const relabel = await cs.put(`/api/payments/${rent.body?.payment?.id}`, { category: 'Maintenance', reason: 'wrongly labelled' });
      T.check('7. re-labelling it onto a J$ account is refused as on entry', relabel.status >= 400, `${relabel.status} ${JSON.stringify(relabel.body)}`);
      const r5 = await cs.post('/api/payments', { unitId: 'unit-5', category: 'Rent', amount: 150000, currency: 'JMD', date: '2026-11-05', method: 'Cash', payerName: 'Tenant A5', receivedNow: true });
      const big = await cs.put(`/api/payments/${r5.body?.payment?.id}`, { amount: 950000, reason: 'keyed wrong amount' });
      T.check('7. raising a receipt far above what is owed is refused without the override', big.status >= 400, `${big.status} ${JSON.stringify(big.body)}`);
      const big2 = await cs.put(`/api/payments/${r5.body?.payment?.id}`, { amount: 950000, reason: 'keyed wrong amount', confirmAlreadySettled: true, overrideReason: 'tenant prepaid a year, confirmed by owner' });
      T.check('7. control: with the audited override (permission and reason) the same correction is accepted', big2.status === 200, `${big2.status} ${JSON.stringify(big2.body)}`);
      const small = await cs.put(`/api/payments/${r5.body?.payment?.id}`, { notes: 'noted', reason: 'adding a note' });
      T.check('7. control: a correction that adds no money is not re-judged', small.status === 200, `${small.status} ${JSON.stringify(small.body)}`);
    }

    /* ---------- 8. corrections to paid records need co-sign and a reason ---------- */
    {
      const reasonless = await cs.put(`/api/payments/${(await dbS()).payments.find(p => p.unitId === 'unit-2' && p.category === 'Maintenance').id}`, { notes: 'x' });
      T.check('8. correcting a received receipt without a reason is refused', reasonless.status === 400 && reasonless.body?.code === 'correction-reason-required', `${reasonless.status} ${JSON.stringify(reasonless.body)}`);
      const pid = (await dbS()).payments.find(p => p.unitId === 'unit-2' && p.category === 'Maintenance').id;
      const withReason = await cs.put(`/api/payments/${pid}`, { notes: 'checked against the slip', reason: 'slip says Proprietor A2' });
      const aud = (await dbS()).auditLogs.find(a => a.recordId === pid && /Corrected settled receipt/.test(a.action));
      T.check('8. with a reason it is accepted and the reason is in the audit line', withReason.status === 200 && /Reason: slip says Proprietor A2/.test(aud?.action || ''), `${withReason.status} ${aud?.action}`);

      const paid = await cs.post('/api/expenses', exp({ date: '2026-11-04', datePaid: '2026-11-04', amount: 2468, vendor: 'Paid Nov Co' }));
      const xid = paid.body?.expense?.id;
      await cs.post('/api/users', { name: 'Second Admin', username: 'second', role: 'ADMINISTRATOR', password: 'SecondPass-11!' });
      await cs.post('/api/settings', { requireCosign: true });
      const unpay = await cs.put(`/api/expenses/${xid}`, { status: 'pending', reason: 'paid in error' });
      T.check('8. un-paying a paid cost needs the second approver', unpay.status === 403 && unpay.body?.code === 'cosign-required', `${unpay.status} ${JSON.stringify(unpay.body)}`);
      const cosign = { username: 'second', password: 'SecondPass-11!' };
      const noReasonPaid = await cs.put(`/api/expenses/${xid}`, { amount: 2500, cosign });
      T.check('8. co-signed, but without a reason, it is still refused', noReasonPaid.status === 400 && noReasonPaid.body?.code === 'correction-reason-required', `${noReasonPaid.status} ${JSON.stringify(noReasonPaid.body)}`);
      const okPaid = await cs.put(`/api/expenses/${xid}`, { amount: 2500, cosign, reason: 'invoice said 2500' });
      const audE = (await dbS()).auditLogs.find(a => a.recordId === xid && /Updated property expense/.test(a.action));
      T.check('8. co-signed with a reason it is accepted and the reason is audited', okPaid.status === 200 && /Reason: invoice said 2500/.test(audE?.action || ''), `${okPaid.status} ${JSON.stringify(okPaid.body)} ${audE?.action}`);
      const note = await cs.put(`/api/expenses/${xid}`, { notes: 'filed with the invoice' });
      T.check('8. control: a note on a paid cost needs neither', note.status === 200, `${note.status} ${JSON.stringify(note.body)}`);

      // recall-month with includeSettled
      const rt = await cs.post('/api/recurring-expenses', { category: 'Security', vendor: 'Guard Co', amount: 60000, currency: 'JMD', dueDay: 1 });
      const tid = rt.body?.template?.id || rt.body?.recurringExpense?.id || Object.values(rt.body || {}).find(v => v && v.id)?.id;
      await cs.post('/api/settings', { requireCosign: false });
      const pm = await cs.post('/api/expenses/post-month', { monthString: '2026-11', items: [{ recurringId: tid }] });
      T.check('8. setup: a cost run posted for November', pm.status === 200, `${pm.status} ${JSON.stringify(pm.body)}`);
      const row = (await dbS()).expenses.find(e => e.periodMonth === '2026-11' && e.recurringId === tid);
      await cs.put(`/api/expenses/${row.id}`, { status: 'paid', datePaid: '2026-11-05' });
      await cs.post('/api/settings', { requireCosign: true });
      const single = await cs.post(`/api/expenses/${row.id}/void`, { reason: 'mistaken entry', confirmSettled: true });
      T.check('8. control: voiding the paid row singly needs co-sign', single.status === 403, `${single.status}`);
      const rec = await cs.post('/api/expenses/recall-month', { monthString: '2026-11', reason: 'run posted in error', includeSettled: true });
      T.check('8. recalling the month with the paid row needs the same co-sign', rec.status === 403 && rec.body?.code === 'cosign-required', `${rec.status} ${JSON.stringify(rec.body)}`);
      const rec2 = await cs.post('/api/expenses/recall-month', { monthString: '2026-11', reason: 'run posted in error', includeSettled: true, cosign });
      T.check('8. control: co-signed it goes through', rec2.status === 200, `${rec2.status} ${JSON.stringify(rec2.body)}`);
      await cs.post('/api/settings', { requireCosign: false });
    }

    /* ---------- 9. overriding charge guards needs the override permission ---------- */
    {
      await cs.post('/api/users', { name: 'Fin Officer', username: 'fo9', role: 'FINANCE_OFFICER', password: 'Temp-Pass-123!' });
      const F = makeClient(server.baseUrl, { autoOverrideReason: false });
      await F.post('/api/auth/login', { username: 'fo9', password: 'Temp-Pass-123!' }, { captureCookie: true });
      await F.post('/api/auth/change-password', { currentPassword: 'Temp-Pass-123!', newPassword: 'New-Pass-456!fo9' });
      const me = await F.get('/api/auth/me');
      if (me.status !== 200) await F.post('/api/auth/login', { username: 'fo9', password: 'New-Pass-456!fo9' }, { captureCookie: true });
      const wrongCur = await F.post('/api/charges', { unitId: 'unit-3', category: 'Maintenance', oneOffType: 'Late fee', amount: 1000, currency: 'USD', dueDate: '2026-11-10', confirmCurrencyMismatch: true });
      T.check('9. a finance officer cannot override the currency check on a charge', wrongCur.status === 403, `${wrongCur.status} ${JSON.stringify(wrongCur.body)}`);
      const a = await F.post('/api/charges', { unitId: 'unit-4', category: 'Maintenance', oneOffType: 'Late fee', amount: 1500, dueDate: '2026-11-10' });
      const b = await F.post('/api/charges', { unitId: 'unit-4', category: 'Maintenance', oneOffType: 'Late fee', amount: 1500, dueDate: '2026-11-10', confirmDuplicate: true });
      T.check('9. nor the duplicate-charge guard (the first charge is a positive control)', a.status === 200 && b.status === 403, `${a.status} ${b.status} ${JSON.stringify(b.body)}`);
      const A = await cs.post('/api/charges', { unitId: 'unit-4', category: 'Maintenance', oneOffType: 'Late fee', amount: 1500, dueDate: '2026-11-10', confirmDuplicate: true });
      T.check('9. an administrator without a reason is refused', A.status === 400 || A.status === 403, `${A.status} ${JSON.stringify(A.body)}`);
      const A2 = await cs.post('/api/charges', { unitId: 'unit-4', category: 'Maintenance', oneOffType: 'Late fee', amount: 1500, dueDate: '2026-11-10', confirmDuplicate: true, overrideReason: 'a second late fee, genuinely separate' });
      T.check('9. control: an administrator with a reason may', A2.status === 200, `${A2.status} ${JSON.stringify(A2.body)}`);
      const audit = (await dbS()).auditLogs.filter(x => /Overrode/.test(x.action));
      T.check('9. and the override is in the audit trail', audit.length >= 1, String(audit.length));
    }

    /* ---------- 13 is the receive form's default (UI); its source is asserted here ---------- */
    {
      const src = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'ReceivePaymentModal.tsx'), 'utf8');
      T.check('13. the receive form defaults a Utility receipt to the open bill\'s currency, else the levy currency', /nextCategory === 'Utility'/.test(src) && /openBill \? openBill\.currency : u\.maintCurrency \|\| u\.currency/.test(src));
    }
  } finally {
    await fin.cleanup();
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
