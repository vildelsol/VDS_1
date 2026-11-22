/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whole-system hunt, 2026-11-22: every defect the three-part audit reproduced
 * stays fixed. Each check names the defect it guards.
 *
 *   1. A levy ISPO pays after selling the villa is ISPO's own levy: ISPO's
 *      statement carries it, the combined book drops it as a transfer, the
 *      buyer's owner statement does not show it.
 *   2. A same-month tenant changeover bills the new tenant their own first and
 *      last month; the outgoing tenant's charges are never handed over.
 *   3. Rent, booking and utility receipts are refused on a proprietor's villa,
 *      whatever override is ticked.
 *   4. A utility recovery settled after the villa was sold stays on ISPO's book.
 *   5. Recalling a month never voids an unpaid cost in a closed month.
 *   6. A work-order cost follows the expense rules: ISPO's villa, ISPO's book;
 *      no paid cost on a future day.
 *   7. Damage deposits are never overwritten silently, never taken on blocked
 *      dates, never settled before they were received, and a stay holding one
 *      is not cancelled until it is settled.
 *   8. An unpaid meter reading entered in error can be taken back; a paid one cannot.
 *   9. The self-check names money on the wrong book.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Whole-system hunt 3: sales, changeovers, receipts, deposits and books';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hunt3-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export * as fin from './src/lib/finance';
        export * as obs from './src/lib/observations';
        export { checkIntegrity } from './server/integrity';
      `,
      resolveDir: projectRoot,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const NAMES = ['A1', 'A2', 'A3', 'A4', 'B5', 'B6', 'B7', 'B8'];
const OWNER_OCC = new Set(['A2', 'B7']);

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hunt3-data-'));
  const srv = await startServer({ port, adminPassword: 'Hunt-1234!', projectRoot, dataDir });
  const { mod, cleanup } = await loadModules(projectRoot);
  const { fin, obs, checkIntegrity } = mod;
  const ok = (label, r) => {
    if (!r || r.status >= 400) throw new Error(`setup ${label} refused: ${r?.status} ${JSON.stringify(r?.body).slice(0, 300)}`);
    return r;
  };
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Hunt-1234!', 'HuntNew-9876!');
    const settings = (await c.get('/api/db')).body.settings;
    ok('settings', await c.post('/api/settings', { ...settings, booksBeginOn: '2026-09-01' }));
    const U = {};
    const base = { ownerName: 'ISPO', currency: 'JMD', maintCurrency: 'JMD', monthlyMaintenance: 20000, rentDueDay: 1, maintDueDay: 1 };
    for (let i = 0; i < NAMES.length; i++) {
      const n = NAMES[i];
      U[n] = `unit-${i + 1}`;
      const body = { ...base, number: n, status: OWNER_OCC.has(n) ? 'owner-occupied' : n === 'A1' || n === 'A3' ? 'short-term' : 'vacant' };
      if (OWNER_OCC.has(n)) body.ownerName = `Prop ${n}`;
      ok(`unit ${n}`, await c.put(`/api/units/${U[n]}`, body));
    }
    ok('B5 let', await c.put(`/api/units/${U.B5}`, { ...base, number: 'B5', status: 'long-term', tenantName: 'Tenant Old', monthlyRent: 90000, tenantMovedInOn: '2026-09-01' }));
    for (const m of ['2026-09', '2026-10', '2026-11']) ok(`post ${m}`, await c.post('/api/charges/post-month', { monthString: m }));
    const pay = (n, category, amount, date, payerName, extra = {}) =>
      c.post('/api/payments', { unitId: U[n], category, amount, currency: 'JMD', date, method: 'Bank Transfer', payerName, receivedNow: true, ...extra });
    const db = async () => (await c.get('/api/db')).body;

    /* ---------- 1. ISPO's levy paid after the sale ---------- */
    let d = await db();
    ok('A4 sold', await c.put(`/api/units/${U.A4}`, { ...d.units.find(u => u.id === U.A4), status: 'owner-occupied', ownerName: 'Buyer A4', ownerChangeIntent: 'sale', ownerAcquiredOn: '2026-10-16' }));
    ok('A4 Sep levy', await pay('A4', 'Maintenance', 20000, '2026-09-05', 'ISPO'));
    ok('A4 Oct levy, ISPO paying after the sale', await pay('A4', 'Maintenance', 20000, '2026-10-20', 'ISPO'));
    ok('A4 Nov levy, the buyer', await pay('A4', 'Maintenance', 20000, '2026-11-05', 'Buyer A4'));
    d = await db();
    fin.setOwnershipRegistry(d.ownerships);
    const ops = fin.ispoOperations(d.expenses, d.payments, d.units, 'JMD', '2026-10-01', '2026-10-31');
    const a4Oct = d.payments.find(p => p.unitId === U.A4 && p.date === '2026-10-20');
    T.check('1. ISPO’s statement carries the October levy it paid after the sale', ops.maintenanceOnOwnVillas >= 20000 && fin.ownLevyReceiptTest(d.units)(a4Oct), String(ops.maintenanceOnOwnVillas));
    const combined = fin.consolidateEverything(d.charges, d.payments, d.units);
    T.check('1. the combined book drops it as money moving between the books', !combined.payments.some(p => p.id === a4Oct.id));
    const a4Nov = d.payments.find(p => p.unitId === U.A4 && p.date === '2026-11-05');
    T.check('1. control: the buyer’s own levy is real income on the combined book', combined.payments.some(p => p.id === a4Nov.id));
    const everythingOct = fin.operatingStatement(d.payments, d.expenses, d.units, 'JMD', '2026-10-01', '2026-10-31', { book: 'everything' });
    T.check('1. the combined statement names it as the transfer', everythingOct.internalTransfer >= 20000, String(everythingOct.internalTransfer));
    const statements = fin.ownerStatements(d.units, d.charges, d.payments, d.expenses, d.utilities, '2026-09-01', '2026-11-30', d.ownerships).filter(s => s.unit.id === U.A4);
    const buyer = statements.find(s => s.unit.ownerName === 'Buyer A4');
    const seller = statements.find(s => s.unit.ownerName === 'ISPO');
    T.check('1. the buyer’s statement shows only the buyer’s own payment', buyer?.maintenancePaid === 20000, JSON.stringify(buyer && { paid: buyer.maintenancePaid, billed: buyer.maintenanceBilled }));
    T.check('1. the seller’s statement carries the payment it made after the sale', seller?.maintenancePaid === 40000, JSON.stringify(seller && { paid: seller.maintenancePaid, billed: seller.maintenanceBilled }));
    const position = obs.ispoLevyPosition({ units: d.units, tenancies: d.tenancies, charges: d.charges, payments: d.payments, currency: 'JMD', from: '2026-09-01', to: '2026-10-31' });
    const a4Row = position.rows.find(r => r.unit.id === U.A4);
    T.check('1. ISPO’s levy position keeps the villa for the months ISPO owned it', !!a4Row && a4Row.billed === 40000 && a4Row.unpaid === 0, JSON.stringify(a4Row && { billed: a4Row.billed, unpaid: a4Row.unpaid }));

    /* ---------- 2. same-month changeover ---------- */
    ok('B5 Sep', await pay('B5', 'Rent', 180000, '2026-09-03', 'Tenant Old'));
    ok('B5 Oct', await pay('B5', 'Rent', 90000, '2026-10-03', 'Tenant Old'));
    d = await db();
    const old = d.tenancies.find(t => t.unitId === U.B5 && t.status === 'active');
    ok('move out', await c.put(`/api/tenancies/${old.id}`, { endedOn: '2026-11-12', endReason: 'left' }));
    d = await db();
    ok('changeover', await c.put(`/api/units/${U.B5}`, { ...d.units.find(u => u.id === U.B5), status: 'long-term', tenantName: 'Tenant New', monthlyRent: 95000, tenantChangeIntent: 'changeover', tenantMovedInOn: '2026-11-15' }));
    d = await db();
    const novNew = d.charges.filter(ch => ch.unitId === U.B5 && ch.category === 'Rent' && ch.periodMonth === '2026-11' && ch.status === 'open' && ch.payerName === 'Tenant New');
    T.check('2. the new tenant is billed their own first month and their own advance', novNew.length === 2 && novNew.every(ch => ch.amount === 95000), JSON.stringify(novNew.map(ch => [ch.kind, ch.amount])));
    const oldStill = d.charges.filter(ch => ch.unitId === U.B5 && ch.category === 'Rent' && ch.status === 'open' && ch.payerName === 'Tenant Old');
    T.check('2. the outgoing tenant’s charges stay theirs', oldStill.length >= 3, JSON.stringify(oldStill.map(ch => [ch.periodMonth, ch.kind])));

    /* ---------- 3. receipts on a proprietor's villa ---------- */
    const rentA2 = await pay('A2', 'Rent', 50000, '2026-11-05', 'Someone', { confirmNoOpenCharge: true });
    T.check('3. rent on a proprietor’s villa is refused, override or not', rentA2.status === 400, `${rentA2.status}`);
    const bookA2 = await pay('A2', 'Booking', 50000, '2026-11-05', 'A Guest');
    T.check('3. booking money on a proprietor’s villa is refused', bookA2.status === 400, `${bookA2.status}`);
    const utilA2 = await pay('A2', 'Utility', 5000, '2026-11-05', 'Prop A2');
    T.check('3. a utility receipt on a proprietor’s villa is refused', utilA2.status === 400, `${utilA2.status}`);
    const rentB5 = await pay('B5', 'Rent', 95000, '2026-11-16', 'Tenant New');
    T.check('3. control: rent on an ISPO villa is still taken', rentB5.status < 400, `${rentB5.status} ${JSON.stringify(rentB5.body).slice(0, 200)}`);

    /* ---------- 4. a utility recovery settled after the sale ---------- */
    const reading = ok('B8 reading', await c.post('/api/utilities', { unitId: U.B8, billingPeriod: '2026-10', previousReading: 0, currentReading: 40, amountCharged: 4000, currency: 'JMD' }));
    d = await db();
    ok('B8 sold', await c.put(`/api/units/${U.B8}`, { ...d.units.find(u => u.id === U.B8), status: 'owner-occupied', ownerName: 'Buyer B8', ownerChangeIntent: 'sale', ownerAcquiredOn: '2026-10-25' }));
    const settle = ok('settle', await c.post(`/api/utilities/${reading.body.utility.id}/settle`, { date: '2026-11-06', method: 'Cash' }));
    ok('confirm', await c.post(`/api/payments/${settle.body.payment.id}/confirm`, {}));
    d = await db();
    T.check('4. the recovery stays on ISPO’s book, which bore the bill', d.payments.find(p => p.id === settle.body.payment.id)?.recoveryFund === 'ispo', String(d.payments.find(p => p.id === settle.body.payment.id)?.recoveryFund));

    /* ---------- 6. work-order cost ---------- */
    const wo = ok('work order', await c.post('/api/unit-activities', { unitId: U.B6, residentName: 'ISPO', residentRole: 'Owner', activityType: 'Maintenance Request', dateCaptured: '2026-10-01', notes: 'AC leaking', assignedTo: 'Cool Air Ltd' }));
    const woId = wo.body?.activity?.id;
    const future = await c.put(`/api/unit-activities/${woId}`, { workStatus: 'Completed', completedOn: '2099-01-01', costAmount: 13000, costCurrency: 'JMD', raiseExpense: true });
    T.check('6. a job cost dated in the future is not booked as paid', future.status === 400, `${future.status}`);
    ok('complete', await c.put(`/api/unit-activities/${woId}`, { workStatus: 'Completed', completedOn: '2026-10-20', costAmount: 13000, costCurrency: 'JMD', raiseExpense: true }));
    d = await db();
    const woCost = d.expenses.find(e => e.id === d.unitActivities.find(a => a.id === woId)?.expenseId);
    T.check('6. a repair on ISPO’s villa is on ISPO’s book', woCost?.fund === 'ispo', JSON.stringify(woCost));

    /* ---------- 7. damage deposits and blocked dates ---------- */
    const stay = ok('stay', await c.post('/api/bookings', { unitId: U.A3, guestName: 'Guest A3', checkIn: '2026-11-01', checkOut: '2026-11-04', currency: 'JMD', amount: 30000, depositPaid: 0, source: 'Direct' }));
    const sid = stay.body.booking.id;
    ok('damage deposit', await c.post(`/api/bookings/${sid}/damage-deposit`, { amount: 10000, currency: 'JMD', receivedOn: '2026-11-01' }));
    const again = await c.post(`/api/bookings/${sid}/damage-deposit`, { amount: 1000, currency: 'JMD', receivedOn: '2026-11-01' });
    T.check('7. a held deposit is not overwritten silently', again.status === 409, `${again.status}`);
    const early = await c.post(`/api/bookings/${sid}/damage-deposit/settle`, { returnedAmount: 10000, withheldAmount: 0, settledOn: '2026-10-30' });
    T.check('7. a deposit cannot be settled before it was received', early.status === 400 && /received on/.test(JSON.stringify(early.body)), `${early.status} ${JSON.stringify(early.body).slice(0, 200)}`);
    const cancel = await c.put(`/api/bookings/${sid}`, { ...stay.body.booking, status: 'cancelled', editReason: 'guest cancelled', depositOutcome: 'refund' });
    T.check('7. a stay holding a deposit is not cancelled until the deposit is settled', cancel.status === 400, `${cancel.status} ${JSON.stringify(cancel.body).slice(0, 200)}`);
    const blocked = await c.post('/api/bookings', { unitId: U.A1, guestName: 'Owner block', checkIn: '2026-11-20', checkOut: '2026-11-22', currency: 'JMD', amount: 1000, depositPaid: 500, source: 'Blocked' });
    T.check('7. blocked dates take no value and no deposit', blocked.status === 400 && /not a stay/.test(JSON.stringify(blocked.body)), `${blocked.status} ${JSON.stringify(blocked.body).slice(0, 200)}`);

    /* ---------- 8. taking back a reading ---------- */
    const r8 = ok('reading', await c.post('/api/utilities', { unitId: U.A3, billingPeriod: '2026-11', previousReading: 0, currentReading: 5, amountCharged: 500, currency: 'JMD' }));
    const gone = await c.del(`/api/utilities/${r8.body.utility.id}`, { reason: 'entered on the wrong villa' });
    d = await db();
    T.check('8. an unpaid reading entered in error can be taken back', gone.status === 200 && !d.utilities.some(u => u.id === r8.body.utility.id), `${gone.status}`);
    const paidGone = await c.del(`/api/utilities/${reading.body.utility.id}`, { reason: 'try to remove a paid one' });
    T.check('8. a reading with a receipt cannot', paidGone.status === 409, `${paidGone.status}`);

    /* ---------- 5. recall in a closed month ---------- */
    const tmpl = ok('template', await c.post('/api/recurring-expenses', { currency: 'JMD', dueDay: 5, paymentMethod: 'Bank Transfer', vendor: 'Digicel', category: 'Other', amount: 8000, unitNumber: 'General', fund: 'ispo' }));
    ok('post Oct costs', await c.post('/api/expenses/post-month', { monthString: '2026-10', items: [{ recurringId: tmpl.body.template.id, amount: 8000 }] }));
    let close = await c.post('/api/periods/close', { through: '2026-10' });
    if (close.status >= 400) close = await c.post('/api/periods/close', { through: '2026-10', confirmWithFaults: true });
    ok('close', close);
    d = await db();
    const pendingOct = d.expenses.find(e => e.recurringId === tmpl.body.template.id && e.periodMonth === '2026-10');
    const recall = await c.post('/api/expenses/recall-month', { monthString: '2026-10', reason: 'posted in error', expenseIds: [pendingOct.id] });
    d = await db();
    T.check('5. recalling a closed month leaves its unpaid cost alone', recall.status === 409 && d.expenses.find(e => e.id === pendingOct.id)?.status !== 'void', `${recall.status}`);

    /* ---------- 9. the self-check ---------- */
    const stray = {
      ...d,
      expenses: [...d.expenses, { id: 'x-util', category: 'Utilities', vendor: 'JPS', unitId: U.A2, unitNumber: 'A2', amount: 100, currency: 'JMD', date: '2026-11-05', status: 'paid', fund: 'strata' }],
      payments: [...d.payments, { id: 'x-rent', receiptNo: 'X-1', category: 'Rent', unitId: U.A2, unitNumber: 'A2', amount: 100, currency: 'JMD', date: '2026-11-05', status: 'completed', payerName: 'x', method: 'Cash' }]
    };
    const codes = (checkIntegrity(stray).findings || []).map(f => f.code);
    T.check('9. the self-check names a proprietor’s utility in the books', codes.includes('proprietor-utility-in-the-books'), JSON.stringify(codes));
    T.check('9. and rent on a proprietor’s villa', codes.includes('rent-on-a-proprietors-villa'), JSON.stringify(codes));
    const clean = (checkIntegrity(d).findings || []).map(f => f.code);
    T.check('9. control: neither is raised on the clean books', !clean.includes('proprietor-utility-in-the-books') && !clean.includes('rent-on-a-proprietors-villa'), JSON.stringify(clean));
  } finally {
    await srv.stop();
    cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
