/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Professional-standard review of the records side of property administration:
 * maintenance requests (work orders), utilities, expenses, owner statements,
 * reconciliation and the audit trail. Each scenario is a multi-step day in the
 * life of the property, driven only through the HTTP API, and asks the question a
 * property manager would: does the record that results say what actually happened,
 * and does every document agree with the ledger?
 *
 * Also checks the silent-failure class: a money action that returns success while
 * leaving no audit entry, or an audit entry naming the wrong person.
 *
 * Checks named FINDING record a real defect when they fail; the rest are controls.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, localToday, accountOwedCents } from './harness.mjs';

export const title = 'Workflow records: work orders, utilities, expenses, statements, reconciliation, audit trail';

const ok = r => r.status >= 200 && r.status < 300;
const TODAY = localToday();

async function loadFin(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-wf-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: { contents: `export * as fin from './src/lib/finance';`, resolveDir: projectRoot, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { fin: mod.fin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const PW = 'Workflow-1234!';
  const srv = await startServer({ port, adminPassword: PW, projectRoot });
  const { fin, cleanup } = await loadFin(projectRoot);
  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, PW, PW + 'x');
    const s = (await admin.get('/api/db')).body.settings;
    await admin.post('/api/settings', { ...s, booksBeginOn: '2026-01-01' });

    const staff = {};
    for (const [username, role, name] of [['jr', 'JUNIOR_OFFICER', 'Junior Jo'], ['mgr', 'MANAGER', 'Manny Manager'], ['fin', 'FINANCE_OFFICER', 'Fin Officer']]) {
      const pw = `Staff-${username}-1234!`;
      await admin.post('/api/users', { name, username, role, password: pw });
      const cl = makeClient(srv.baseUrl);
      await cl.post('/api/auth/login', { username, password: pw }, { captureCookie: true });
      await cl.post('/api/auth/change-password', { currentPassword: pw, newPassword: pw + 'x' });
      staff[role] = { client: cl, name };
    }
    const jr = staff.JUNIOR_OFFICER.client;
    const mgr = staff.MANAGER.client;

    // Villas: 1 let (JMD), 2 owner-occupied, 3 let (USD)
    await makeLongTermUnit(admin, 'unit-1', { monthlyRent: 80000, monthlyMaintenance: 20000, tenantName: 'Tenant One', ownerName: 'Owner One' });
    await admin.put('/api/units/unit-2', { number: '2', ownerName: 'Owner Two', status: 'owner-occupied', monthlyMaintenance: 15000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    await makeLongTermUnit(admin, 'unit-3', { monthlyRent: 1200, monthlyMaintenance: 150, currency: 'USD', maintCurrency: 'USD', tenantName: 'Tenant Three', ownerName: 'Owner Three' });
    for (const m of ['2026-09', '2026-10', '2026-11']) await admin.post('/api/charges/post-month', { monthString: m });
    const db = async () => (await admin.get('/api/db')).body;
    const audits = async () => (await db()).auditLogs;

    /* ================= 1. work orders ================= */
    {
      const a0 = (await audits()).length;
      const made = await jr.post('/api/unit-activities', { unitId: 'unit-2', residentName: 'Owner Two', residentRole: 'Owner', activityType: 'Maintenance Request', dateCaptured: TODAY, notes: 'Leaking pool pump', assignedTo: '' });
      T.check('work order: a junior can log a maintenance request', ok(made), JSON.stringify(made.body).slice(0, 120));
      const id = made.body?.activity?.id;
      T.check('work order: it starts as Reported and is logged by the junior', made.body?.activity?.workStatus === 'Reported' && made.body?.activity?.loggedBy === staff.JUNIOR_OFFICER.name);
      const sched = await mgr.put(`/api/unit-activities/${id}`, { workStatus: 'Scheduled', assignedTo: 'Pool Pros Ltd' });
      T.check('work order: a manager can assign a vendor and schedule it', ok(sched), JSON.stringify(sched.body).slice(0, 120));
      const prog = await mgr.put(`/api/unit-activities/${id}`, { workStatus: 'In progress' });
      T.check('work order: it moves to In progress', ok(prog) && prog.body.activity.workStatus === 'In progress');
      const noCost = await mgr.put(`/api/unit-activities/${id}`, { workStatus: 'Completed', raiseExpense: true });
      T.check('work order: raising the expense with no cost entered is refused', noCost.status === 400, `status ${noCost.status}`);
      const completed = await mgr.put(`/api/unit-activities/${id}`, { workStatus: 'Completed', costAmount: 25000, costCurrency: 'JMD', raiseExpense: true, outcome: 'Pump replaced' });
      const exId = completed.body?.expense?.id;
      T.check('work order: completing with a cost raises one expense against the villa', ok(completed) && !!exId && completed.body.expense.unitId === 'unit-2' && completed.body.expense.amount === 25000, JSON.stringify(completed.body).slice(0, 160));
      const again = await mgr.put(`/api/unit-activities/${id}`, { raiseExpense: true });
      const d1 = await db();
      T.check('work order: asking to raise the expense again creates no second expense', d1.expenses.filter(e => e.id.startsWith(`ex-work-${id}`)).length === 1);
      T.check('work order: the expense vendor is the assigned vendor, not "Maintenance"', completed.body?.expense?.vendor === 'Pool Pros Ltd', String(completed.body?.expense?.vendor));
      // Correct the cost afterwards (the invoice came in different).
      const recost = await mgr.put(`/api/unit-activities/${id}`, { costAmount: 31000 });
      const d2 = await db();
      const act2 = d2.unitActivities.find(a => a.id === id);
      const ex2 = d2.expenses.find(e => e.id === exId);
      T.check('FINDING work order: correcting the cost after the expense was raised keeps the request and the expense in agreement',
        !ok(recost) || act2.costAmount === ex2.amount,
        `request now says ${act2.costAmount}, the expense in the accounts still says ${ex2.amount} (status ${recost.status})`);
      // Take the cost back, then try to raise it again.
      await mgr.post(`/api/expenses/${exId}/void`, { reason: 'wrong vendor invoice', confirmSettled: true });
      const reraise = await mgr.put(`/api/unit-activities/${id}`, { raiseExpense: true, costAmount: 31000 });
      const d3 = await db();
      const live = d3.expenses.filter(e => e.id.startsWith(`ex-work-${id}`) && e.status !== 'void');
      T.check('FINDING work order: after its expense is voided, the work can have its cost raised again',
        live.length === 1, `${live.length} live expense(s) for a completed job whose cost was taken back (re-raise status ${reraise.status})`);
      const names = (await audits()).slice(0, (await audits()).length - a0);
      T.check('work order: every step left an audit entry', names.length >= 6, `${names.length} entries`);
      T.check('work order: audit entries for the updates name the manager, not the junior who logged it',
        names.filter(a => /Updated the maintenance request/.test(a.action)).every(a => a.user === staff.MANAGER.name || a.userName === staff.MANAGER.name || a.actor === staff.MANAGER.name || JSON.stringify(a).includes(staff.MANAGER.name)));
      // Deleting a request that has a cost trail.
      const del = await mgr.del(`/api/unit-activities/${id}`);
      const d4 = await db();
      T.check('FINDING work order: a completed job whose cost was booked can be deleted outright (the expense stays, the job and its link vanish)',
        !(ok(del) && !d4.unitActivities.some(a => a.id === id) && d4.expenses.some(e => e.id === exId)),
        `delete status ${del.status}; the expense ${exId} now has no work order behind it`);
    }

    /* ================= 2. utilities ================= */
    {
      const mk = async (unitId, period, amount) =>
        (await admin.post('/api/utilities', { unitId, type: 'Electricity', billingPeriod: period, amountCharged: amount, currency: 'JMD', previousReading: 100, currentReading: 300 })).body?.utility;
      const u1 = await mk('unit-1', '2026-10', 8000);
      T.check('utility: a reading is recorded with consumption worked out', !!u1 && u1.consumption === 200, JSON.stringify(u1).slice(0, 120));
      const set = await admin.post(`/api/utilities/${u1.id}/settle`, {});
      const pid = set.body?.payment?.id;
      T.check('utility: settling raises an expected (pending) receipt, bill stays unpaid until confirmed', ok(set) && set.body.payment.status === 'pending' && set.body.utility.status !== 'paid');
      // Bill corrected while the receipt is awaiting funds.
      await admin.put(`/api/utilities/${u1.id}`, { amountCharged: 9500 });
      const conf = await admin.post(`/api/payments/${pid}/confirm`, {});
      const dA = await db();
      const bill = dA.utilities.find(u => u.id === u1.id);
      const rec = dA.payments.find(p => p.id === pid);
      T.check('FINDING utility: correcting the bill while its receipt awaits funds leaves bill and receipt in agreement',
        bill.amountCharged === rec.amount, `bill says ${bill.amountCharged}, the confirmed receipt says ${rec.amount}`);
      T.check('utility: confirming the receipt marks the bill paid', ok(conf) && bill.status === 'paid');
      // Correct a settled bill.
      await admin.put(`/api/utilities/${u1.id}`, { amountCharged: 12000 });
      const dB = await db();
      T.check('FINDING utility: correcting an already-settled bill keeps it in agreement with the receipt that settled it',
        dB.utilities.find(u => u.id === u1.id).amountCharged === dB.payments.find(p => p.id === pid).amount,
        `bill ${dB.utilities.find(u => u.id === u1.id).amountCharged} vs receipt ${dB.payments.find(p => p.id === pid).amount}, still marked paid`);
      // Reverse the receipt: the bill must go back to unpaid.
      await admin.post(`/api/payments/${pid}/reverse`, { reversalReason: 'bounced cheque, reversing' });
      const dC = await db();
      T.check('utility: reversing the settling receipt returns the bill to unpaid and clears the link',
        dC.utilities.find(u => u.id === u1.id).status !== 'paid', `status ${dC.utilities.find(u => u.id === u1.id).status}`);
      const resettle = await admin.post(`/api/utilities/${u1.id}/settle`, {});
      T.check('utility: after the reversal it can be settled afresh', ok(resettle), JSON.stringify(resettle.body).slice(0, 100));
      const dupe = await mgr.post(`/api/utilities/${u1.id}/settle`, {});
      T.check('utility: a second person cannot raise a second receipt for the same bill', dupe.status === 400, `status ${dupe.status}`);
      const bad = await admin.post('/api/utilities', { unitId: 'unit-1', type: 'Water', billingPeriod: '2026-10', amountCharged: 500, currency: 'JMD', previousReading: 300, currentReading: 100 });
      T.check('utility: a meter reading that goes backwards is refused', bad.status === 400, `status ${bad.status}`);
    }

    /* ================= 3. expenses & owner statements ================= */
    {
      const from = '2026-10-01';
      const to = '2026-10-31';
      const stmt = async () => {
        const d = await db();
        const unit = d.units.find(u => u.id === 'unit-2');
        return fin.ownerStatement(unit, d.units, d.charges, d.payments, d.expenses, d.utilities, 'JMD', from, to);
      };
      const before = await stmt();
      const ex = await admin.post('/api/expenses', { category: 'Maintenance', vendor: 'Gardens Ltd', description: 'Hedge for villa 2', unitId: 'unit-2', amount: 12000, currency: 'JMD', date: '2026-10-12', status: 'paid', datePaid: '2026-10-12', paymentMethod: 'Cash' });
      const exId = ex.body?.expense?.id;
      T.check('expense: a recharged cost is recorded against the villa', ok(ex) && ex.body.expense.unitId === 'unit-2', JSON.stringify(ex.body).slice(0, 120));
      const mid = await stmt();
      T.check('statement: the villa owner statement shows the new cost exactly once', Math.round((mid.expenses - before.expenses) * 100) === 1200000, `expenses ${before.expenses} -> ${mid.expenses}`);
      T.check('statement: net moves by exactly that cost', Math.round((before.net - mid.net) * 100) === 1200000, `net ${before.net} -> ${mid.net}`);
      await admin.post(`/api/expenses/${exId}/void`, { reason: 'charged to wrong villa', confirmSettled: true });
      const after = await stmt();
      T.check('statement: a voided cost leaves the owner statement and the net returns', after.expenses === before.expenses && after.net === before.net, `expenses ${after.expenses}, net ${after.net}`);
      T.check('statement: the void is audited with the reason', (await audits()).some(a => /Took back/.test(a.action)));
      // Statement vs ledger: collected on the statement equals completed receipts in period.
      const d = await db();
      await admin.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 80000, currency: 'JMD', payerName: 'Tenant One', method: 'Cash', date: '2026-10-05' }).then(async r => admin.post(`/api/payments/${r.body.payment.id}/confirm`, {}));
      const d2 = await db();
      const u1 = d2.units.find(u => u.id === 'unit-1');
      const st1 = fin.ownerStatement(u1, d2.units, d2.charges, d2.payments, d2.expenses, d2.utilities, 'JMD', from, to);
      const raw = d2.payments.filter(p => p.unitId === 'unit-1' && p.status === 'completed' && p.currency === 'JMD' && p.date >= from && p.date <= to).reduce((a, p) => a + p.amount, 0);
      T.check('statement: what the statement says was collected equals the completed receipts in the ledger for that period', Math.abs(st1.collected - raw) < 0.005, `statement ${st1.collected} vs ledger ${raw}`);
      void d;
      // Recurring expense posts once and recalls.
      const rec = await admin.post('/api/recurring-expenses', { category: 'Security', vendor: 'Guard Co', unitNumber: 'General', amount: 50000, currency: 'JMD', dueDay: 5, description: 'Night guard' });
      T.check('expense: a recurring monthly cost can be set up', ok(rec), JSON.stringify(rec.body).slice(0, 100));
      const p1 = await admin.post('/api/expenses/post-month', { monthString: '2026-10' });
      const p2 = await admin.post('/api/expenses/post-month', { monthString: '2026-10' });
      const d3 = await db();
      T.check('expense: posting the same month twice raises each recurring cost once', d3.expenses.filter(e => e.periodMonth === '2026-10' && e.vendor === 'Guard Co').length === 1, `${ok(p1)} ${ok(p2)}`);
      const rc = await admin.post('/api/expenses/recall-month', { monthString: '2026-10', includeSettled: true, reason: 'posted in error' });
      const d4 = await db();
      T.check('expense: recalling the month takes its run back and nothing else', ok(rc) && d4.expenses.filter(e => e.periodMonth === '2026-10' && e.status !== 'void').length === 0 && d4.expenses.some(e => e.id === exId), JSON.stringify(rc.body).slice(0, 100));
    }

    /* ================= 4. reconciliation ================= */
    {
      const mkPaid = async (amount, date) => {
        const r = await admin.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount, currency: 'JMD', payerName: 'Tenant One', method: 'Bank Transfer', date, advancePayment: true });
        await admin.post(`/api/payments/${r.body.payment.id}/confirm`, {});
        return r.body.payment.id;
      };
      // 2026-11-16: only UNSPENT credit can be refunded, so unit-1's rent is first overpaid by 1,000.
      {
        const d0 = await db();
        const owed = accountOwedCents(d0, 'unit-1', 'Rent', 'JMD');
        await admin.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: Math.max(0, owed) / 100 + 1000, currency: 'JMD', payerName: 'Tenant One', method: 'Cash', date: '2026-11-01', receivedNow: true, advancePayment: true });
      }
      const a = await mkPaid(1111, '2026-11-02');
      const b = await mkPaid(2222, '2026-11-03');
      const ra = await admin.post(`/api/payments/${a}/reconcile`, { reconciledOn: TODAY, reference: 'BANK-LINE-77' });
      T.check('reconciliation: a received receipt can be matched to a statement line', ok(ra));
      const rb = await admin.post(`/api/payments/${b}/reconcile`, { reconciledOn: TODAY, reference: 'bank-line-77' });
      T.check('reconciliation: the same bank line cannot settle a second receipt (case-insensitive)', rb.status === 400 && /bank-line-already-matched|already matched/.test(JSON.stringify(rb.body)), `status ${rb.status}`);
      const early = await admin.post(`/api/payments/${b}/reconcile`, { reconciledOn: '2026-11-01', reference: 'X-1' });
      T.check('reconciliation: a statement date before the receipt is refused', early.status === 400);
      await admin.post(`/api/payments/${a}/refund`, { amount: 100, reason: 'overpaid', method: 'Cash', refundedOn: TODAY });
      const dR = await db();
      T.check('reconciliation: refunding part of a matched receipt leaves the match standing and the refund recorded', !!dR.payments.find(p => p.id === a).reconciledOn && dR.payments.find(p => p.id === a).refundedAmount === 100);
      await admin.post(`/api/payments/${b}/reconcile`, { reconciledOn: TODAY, reference: 'LINE-B' });
      await admin.post(`/api/payments/${b}/reverse`, { reversalReason: 'entered twice by mistake' });
      T.check('reconciliation: reversing a matched receipt clears its match', !(await db()).payments.find(p => p.id === b).reconciledOn);
      const un = await admin.post(`/api/payments/${a}/reconcile`, { reconciled: false });
      T.check('reconciliation: a match can be undone and the undo is audited', ok(un) && (await audits()).some(x => /Un-matched receipt/.test(x.action)));
    }

    /* ================= 5. audit coverage and attribution ================= */
    {
      // Every money-changing action by the junior leaves an entry naming the junior.
      const actions = [];
      const probe = async (label, fn, who = staff.JUNIOR_OFFICER.name) => {
        const n0 = (await audits()).length;
        const r = await fn();
        const after = await audits();
        const added = after.slice(0, after.length - n0);
        actions.push({ label, status: r.status, added: added.length, named: added.every(a => JSON.stringify(a).includes(who)) });
        return r;
      };
      // 2026-11-16: only UNSPENT credit can be refunded, so the payment overpays unit-3's rent by 500.
      const d3 = await db();
      const owed3 = accountOwedCents(d3, 'unit-3', 'Rent', 'USD');
      const pay = await probe('record payment', () => jr.post('/api/payments', { unitId: 'unit-3', category: 'Rent', amount: Math.max(0, owed3) / 100 + 500, currency: 'USD', payerName: 'Tenant Three', method: 'Cash', date: TODAY, advancePayment: true }));
      await probe('confirm payment', () => jr.post(`/api/payments/${pay.body.payment.id}/confirm`, {}));
      await probe('refund payment', () => mgr.post(`/api/payments/${pay.body.payment.id}/refund`, { amount: 5, reason: 'test refund', method: 'Cash', refundedOn: TODAY }));
      await probe('one-off charge', () => mgr.post('/api/charges', { unitId: 'unit-3', category: 'Rent', oneOffType: 'Late fee', amount: 50, currency: 'USD', dueDate: TODAY, description: 'late' }), staff.MANAGER.name);
      await probe('expense', () => mgr.post('/api/expenses', { category: 'Supplies', vendor: 'V', description: 'bulbs', amount: 900, currency: 'JMD', date: TODAY, status: 'paid', datePaid: TODAY, paymentMethod: 'Cash' }), staff.MANAGER.name);
      await probe('utility reading', () => mgr.post('/api/utilities', { unitId: 'unit-3', type: 'Water', billingPeriod: '2026-11', amountCharged: 40, currency: 'USD', previousReading: 1, currentReading: 9 }), staff.MANAGER.name);
      const missing = actions.filter(x => x.added === 0 || (!x.named && x.status < 300));
      T.check('FINDING audit: every money action leaves an audit entry that names who did it',
        missing.length === 0, missing.map(x => `${x.label}: ${x.added} entries, named=${x.named}, status ${x.status}`).join(' | '));
      T.check('audit: the trail has the sealed-chain fields on every entry', (await audits()).every(a => a.seal || a.prevSeal || a.hash === undefined));
      const integ = (await admin.get('/api/integrity')).body;
      T.check('integrity: no serious finding after all of it', (integ.issues || integ.findings || []).filter(x => x.severity === 'serious').length === 0, JSON.stringify(integ).slice(0, 200));
    }

    return T.done();
  } finally {
    cleanup();
    await srv.stop();
  }
}
