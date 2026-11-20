/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The DAILY screens audited as one ecosystem (audit/daily, 2026-11-18).
 *
 * General Dashboard, the Notifications Hub and its sidebar badge, the Units
 * Register, the HOA & Tenants Ledger and Short-Term Bookings each compute their
 * own figures. The other ecosystem tests hold finance.ts functions against each
 * other; this one RENDERS the screens (react-dom/server, given exactly what
 * App.tsx gives them: stored receipts plus `settledFromRent`) and reads the
 * figures a person would read, so a screen that recomputes something its own way
 * is caught.
 *
 * One simulated property, built through the API with dates relative to today:
 * let villas in JMD and USD, owner-occupied villas, a tenant in arrears, a tenant
 * paid ahead, a voided receipt, a refunded overpayment, a mid-month move-out,
 * short-stay guests paying cash with part-payments, damage deposits held and
 * returned, and booking refunds. Every check is computable from the raw rows.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment, localToday } from './harness.mjs';

export const title = 'Daily screens: dashboard, hub, badge, units register, ledger and bookings tie to one another';

const cents = n => Math.round((Number(n) || 0) * 100);
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

function monthOffset(day, n) {
  const [y, m] = day.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

async function loadScreens(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-daily-'));
  const outfile = path.join(dir, 'screens.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export { default as Dashboard } from './src/components/Dashboard';
        export { default as NotificationsTab } from './src/components/NotificationsTab';
        export { default as Units, UnitDetail } from './src/components/Units';
        export { default as FinanceHub } from './src/components/FinanceHub';
        export { hubOpenItemCount } from './src/lib/notifications';
        export { formatMoney } from './src/lib/money';
        export * from './src/lib/finance';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod: M, cleanup } = await loadScreens(projectRoot);
  const srv = await startServer({ port, adminPassword: 'Daily-1234567!', projectRoot });
  const h = M.React.createElement;
  const noop = async () => ({});
  const fm = M.formatMoney;
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Daily-1234567!', 'DailyNew-98765432!');
    const failures = [];
    const ok = (label, r) => {
      if (!r || r.status >= 400) failures.push(`${label}: ${r?.status} ${JSON.stringify(r?.body).slice(0, 200)}`);
      return r;
    };

    const TODAY = localToday();
    const M0 = monthOffset(TODAY, 0);
    const M1 = monthOffset(TODAY, -1);
    const M2 = monthOffset(TODAY, -2);
    const day = Number(TODAY.slice(8, 10));
    // A levy due later this month, so the register must not call it outstanding today.
    const lateDue = Math.min(28, day + 5);

    const U = (n, o) =>
      c.put(`/api/units/unit-${n}`, {
        number: String(n), currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1,
        monthlyMaintenance: 25000, ownerName: 'ISPO', status: 'vacant', monthlyRent: 0, ...o
      });
    ok('let villa 1', await U(1, { tenantName: 'Tenant One', status: 'long-term', monthlyRent: 100000, tenantMovedInOn: `${M2}-01` }));
    ok('owner A2', await U(2, { ownerName: 'Owner A2', status: 'owner-occupied' }));
    ok('let villa 3 USD', await U(3, { tenantName: 'Tenant Three', status: 'long-term', monthlyRent: 1500, currency: 'USD', maintCurrency: 'USD', monthlyMaintenance: 200, tenantMovedInOn: `${M2}-01` }));
    ok('let villa 4', await U(4, { tenantName: 'Tenant Four', status: 'long-term', monthlyRent: 80000, tenantMovedInOn: `${M2}-01` }));
    ok('short-let 5', await U(5, { status: 'short-term', monthlyRent: 10000 }));
    ok('short-let 6 USD', await U(6, { status: 'short-term', monthlyRent: 150, currency: 'USD', maintCurrency: 'USD', monthlyMaintenance: 150 }));
    ok('owner B7 USD', await U(7, { ownerName: 'Owner B7', status: 'owner-occupied', currency: 'USD', maintCurrency: 'USD', monthlyMaintenance: 150 }));
    ok('owner B8', await U(8, { ownerName: 'Owner B8', status: 'owner-occupied' }));
    ok('owner B9', await U(9, { ownerName: 'Owner B9', status: 'owner-occupied' }));
    ok('owner C12', await U(12, { ownerName: 'Owner C12', status: 'owner-occupied', maintDueDay: lateDue }));
    for (const m of [M2, M1]) ok('post ' + m, await c.post('/api/charges/post-month', { monthString: m }));

    const pay = async (u, cat, amt, date, who, cur = 'JMD', extra = {}) =>
      ok(`pay ${u} ${cat}`, await recordAndConfirmPayment(c, { unitId: 'unit-' + u, category: cat, amount: amt, currency: cur, payerName: who, method: 'Cash', date, ...extra }));
    const d = n => (n <= day ? n : day); // a day this month that is not in the future
    await pay(1, 'Rent', 100000, `${M2}-03`, 'Tenant One');
    await pay(1, 'Rent', 200000, `${M0}-${String(d(2)).padStart(2, '0')}`, 'Tenant One'); // arrears catch-up this month
    for (const m of [M2, M1]) await pay(2, 'Maintenance', 25000, `${m}-04`, 'Owner A2');
    for (const m of [M2, M1]) await pay(3, 'Rent', 1500, `${m}-02`, 'Tenant Three', 'USD');
    await pay(4, 'Rent', 80000, `${M2}-03`, 'Tenant Four');
    for (const m of [M2, M1]) {
      await pay(8, 'Maintenance', 25000, `${m}-05`, 'Owner B8');
      await pay(9, 'Maintenance', 25000, `${m}-05`, 'Owner B9');
    }
    await pay(12, 'Maintenance', 25000, `${M2}-05`, 'Owner C12');
    // A refunded overpayment and a voided receipt.
    const over = await pay(8, 'Maintenance', 25000, TODAY, 'Owner B8', 'JMD', { advancePayment: true });
    const overId = over?.body?.payment?.id;
    ok('refund overpayment', await c.post(`/api/payments/${overId}/refund`, { amount: 25000, reason: 'Paid twice', method: 'Cash', refundedOn: TODAY }));
    const bounced = await pay(9, 'Maintenance', 25000, TODAY, 'Owner B9', 'JMD', { advancePayment: true });
    ok('void bounced cheque', await c.post(`/api/payments/${bounced?.body?.payment?.id}/reverse`, { reversalReason: 'Cheque bounced' }));
    // A tenant paid ahead: the advance stands against the month it pays for.
    await pay(3, 'Rent', 1500, TODAY, 'Tenant Three', 'USD', { advancePayment: true });

    let db = (await c.get('/api/db')).body;
    const t1 = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    ok('lease ending soon', await c.put(`/api/tenancies/${t1.id}`, { leaseEndsOn: addDays(TODAY, 20) }));

    // Short stays: cash guests, part-payments, damage deposits, refunds.
    const bk = async o => ok('booking ' + o.guestName, await c.post('/api/bookings', { currency: 'JMD', source: 'Direct', depositMethod: 'Cash', ...o }))?.body?.booking;
    const g1 = await bk({ unitId: 'unit-5', guestName: 'Guest Cash', checkIn: addDays(TODAY, -20), checkOut: addDays(TODAY, -16), amount: 40000, depositPaid: 40000, status: 'checked-out' });
    const g2 = await bk({ unitId: 'unit-5', guestName: 'Guest Part', checkIn: addDays(TODAY, -2), checkOut: addDays(TODAY, 4), amount: 60000, depositPaid: 20000 });
    const g3 = await bk({ unitId: 'unit-6', guestName: 'Guest USD', checkIn: addDays(TODAY, -6), checkOut: addDays(TODAY, 2), currency: 'USD', amount: 1200, depositPaid: 1200 });
    const g4 = await bk({ unitId: 'unit-6', guestName: 'Guest Refund', checkIn: addDays(TODAY, -30), checkOut: addDays(TODAY, -27), currency: 'USD', amount: 600, depositPaid: 600, status: 'checked-out' });
    const g5 = await bk({ unitId: 'unit-5', guestName: 'Guest Gone', checkIn: addDays(TODAY, 10), checkOut: addDays(TODAY, 12), amount: 20000, depositPaid: 20000 });
    ok('damage deposit held', await c.post(`/api/bookings/${g3.id}/damage-deposit`, { amount: 300, currency: 'USD', receivedOn: TODAY }));
    ok('damage deposit taken', await c.post(`/api/bookings/${g4.id}/damage-deposit`, { amount: 200, currency: 'USD', receivedOn: TODAY }));
    ok('damage deposit returned', await c.post(`/api/bookings/${g4.id}/damage-deposit/settle`, { withheldAmount: 50, withheldReason: 'Broken lamp', settledOn: TODAY }));
    db = (await c.get('/api/db')).body;
    const receiptOf = b => db.payments.find(p => p.bookingId === b.id && p.status !== 'reversed');
    ok('part refund of a stay', await c.post(`/api/payments/${receiptOf(g4).id}/refund`, { amount: 100, reason: 'Late check-in discount', method: 'Cash', refundedOn: TODAY }));
    ok('full refund of a stay', await c.post(`/api/payments/${receiptOf(g5).id}/refund`, { amount: 20000, reason: 'Guest cancelled in time', method: 'Cash', refundedOn: TODAY }));

    /* ---------- the refunded stay can still be put right and cancelled ---------- */
    const edit5 = await c.put(`/api/bookings/${g5.id}`, { editReason: 'Test correction', notes: 'Guest phoned to cancel' });
    T.check('a fully refunded reservation can still be edited (a note, a phone number)', edit5.status === 200, `${edit5.status} ${JSON.stringify(edit5.body).slice(0, 220)}`);
    const cancel5 = await c.put(`/api/bookings/${g5.id}`, { editReason: 'Test correction', status: 'cancelled' });
    T.check('and cancelled, so its nights stop counting as sold', cancel5.status === 200, `${cancel5.status} ${JSON.stringify(cancel5.body).slice(0, 220)}`);
    db = (await c.get('/api/db')).body;
    const r5 = db.payments.find(p => p.bookingId === g5.id);
    T.check('its receipt and refund both stand: money in and money back, netting to nothing', r5 && r5.status === 'completed' && cents(r5.amount) === cents(r5.refundedAmount), JSON.stringify(r5 && { s: r5.status, a: r5.amount, r: r5.refundedAmount }));
    // Hunt, 2026-11-20: a cancel with money held must say what happens to it; asking to void is still refused.
    const cancel4 = await c.put(`/api/bookings/${g4.id}`, { editReason: 'Test correction', status: 'cancelled', depositOutcome: 'void' });
    T.check('a part-refunded reservation still holding money is not voided by cancelling it', cancel4.status === 400 && cancel4.body?.code === 'deposit-receipt-already-refunded', `${cancel4.status} ${JSON.stringify(cancel4.body).slice(0, 220)}`);
    T.check('and the refusal says what to do: refund the rest first', /Refund the rest/.test(cancel4.body?.error || ''), cancel4.body?.error);
    db = (await c.get('/api/db')).body;
    T.check('control: the part-refunded receipt is untouched', db.payments.find(p => p.bookingId === g4.id)?.status === 'completed');

    // Mid-month move-out of tenant 4, owing two months.
    const t4 = db.tenancies.find(t => t.unitId === 'unit-4' && t.status === 'active');
    const beforeMove = M.delinquentAccounts(db.units, db.charges, [...db.payments, ...M.settledFromRent(db.charges, db.payments)], TODAY)
      .filter(a => a.unit.id === 'unit-4').reduce((s, a) => s + cents(a.balance), 0);

    /* ---------- Post month: the current month, and what the screens say before and after ---------- */
    const settled = x => [...x.payments, ...M.settledFromRent(x.charges, x.payments)];
    const hubText = x => text(M.renderToStaticMarkup(h(M.NotificationsTab, {
      units: x.units, settings: x.settings, charges: x.charges, payments: settled(x), utilities: x.utilities, expenses: x.expenses, bookings: x.bookings, tenancies: x.tenancies,
      session: x.currentUser, onNavigateToTab: () => {}, onRecordPayment: noop, onSettleUtility: noop, onUpdateExpense: noop, onPostMonth: noop
    })));
    const openItems = t => Number((t.match(/Open items (\d+)/) || [])[1]);
    const badgeOf = x => M.hubOpenItemCount({ ...x, payments: settled(x) }, TODAY);
    {
      const pre = hubText(db);
      T.check('before the month is posted the hub raises its levy as not yet billed', /Maintenance not yet billed/.test(pre));
      T.check('and the sidebar badge counts what the hub counts', badgeOf(db) === openItems(pre), `badge ${badgeOf(db)} vs hub ${openItems(pre)}`);
    }
    const posted = ok('post ' + M0, await c.post('/api/charges/post-month', { monthString: M0 }));
    T.check('Post month bills the property for this month', (posted?.body?.created || 0) > 0, JSON.stringify(posted?.body));
    // Now the move-out, after the month is billed.
    const endedOn = `${M0}-${String(d(10)).padStart(2, '0')}`;
    ok('move-out', await c.put(`/api/tenancies/${t4.id}`, { endedOn, endReason: 'Moved away' }));
    // An expense the property owes, so owed-to and owed-by both exist.
    ok('pending expense', await c.post('/api/expenses', { category: 'Contractors', vendor: 'GateTech', description: 'Gate motor', amount: 40000, currency: 'JMD', date: TODAY, dueDate: addDays(TODAY, 5), status: 'pending' }));

    db = (await c.get('/api/db')).body;
    if (!db.charges.some(x => x.unitId === 'unit-12' && x.category === 'Maintenance' && x.status === 'open' && x.dueDate > TODAY)) {
      // Late in the month no due day is still ahead; move this month's levy so the case is exercised every day.
      const ch = db.charges.find(x => x.unitId === 'unit-12' && x.category === 'Maintenance' && x.periodMonth === M0);
      if (ch) ch.dueDate = addDays(TODAY, 3);
    }
    T.check('setup completed without a refused call', failures.length === 0, failures.join(' | '));

    const S = settled(db);
    const common = { units: db.units, charges: db.charges, payments: S, settings: db.settings, session: db.currentUser, bookings: db.bookings, tenancies: db.tenancies, expenses: db.expenses };
    const dash = text(M.renderToStaticMarkup(h(M.Dashboard, { ...common, onRecordPayment: noop, onNavigateToTab: () => {} })));
    const hub = hubText(db);
    const ledgerScreen = text(M.renderToStaticMarkup(h(M.FinanceHub, {
      ...common, onRecordPayment: noop, onConfirmPayment: noop, onReversePayment: noop, onRefundPayment: noop, onUpdatePayment: noop, onPostMonth: noop,
      onRestateRent: noop, onPreviewRestateRent: noop, onPreviewMoveReceipts: noop, onRestateMaintenanceReceipts: noop, onVoidCharge: noop, onAddCharge: noop, onOpenReceipt: () => {}
    })));
    const register = text(M.renderToStaticMarkup(h(M.Units, {
      ...common, utilities: db.utilities, unitActivities: db.unitActivities || [], onUpdateUnit: noop, onUpdateTenancy: noop, onEvictTenancy: noop,
      onAddUnitActivity: noop, onUpdateUnitActivity: noop, onDeleteUnitActivity: noop, onRecordPayment: noop, onTakeDeposit: noop, onSettleDeposit: noop
    })));
    const detail = u => text(M.renderToStaticMarkup(h(M.UnitDetail, {
      unit: u, charges: db.charges, payments: S, units: db.units, tenancies: db.tenancies, expenses: db.expenses, unitActivities: db.unitActivities || [],
      settings: db.settings, canEdit: true, canEvict: true, onClose() {}, onEdit() {}, onPrint() {}, onEditTenancy() {}, onEvictTenancy() {}, onPrintTenancy() {},
      onLogActivity() {}, onDeleteActivity: noop, onManageWork() {}, onManageDeposit() {}, onReceivePayment() {}
    })));

    /* ---------- arrears: ledger rows -> dashboard -> hub -> badge ---------- */
    const del = M.delinquentAccounts(db.units, db.charges, S, TODAY);
    const delBy = cur => del.filter(a => a.currency === cur).reduce((s, a) => s + cents(a.balance), 0);
    // From the raw rows: every account's positive balance, less the levy that sits
    // inside the same villa's unpaid rent (rent charges carrying a levy share).
    const rawArrears = cur => {
      let total = 0;
      for (const u of db.units) {
        const rent = M.accountBalance(u, 'Rent', db.charges, S, TODAY, db.units);
        const maint = M.accountBalance(u, 'Maintenance', db.charges, S, TODAY, db.units);
        const carries = db.charges.some(x => x.unitId === u.id && x.category === 'Rent' && x.status === 'open' && (x.maintenancePortion || 0) > 0);
        if (rent.currency === cur && rent.balance > 0) total += cents(rent.balance);
        const inside = carries && rent.balance > 0 && maint.balance > 0 && maint.balance <= rent.balance;
        if (maint.currency === cur && maint.balance > 0 && !inside) total += cents(maint.balance);
      }
      return total;
    };
    for (const cur of ['JMD', 'USD']) T.check(`${cur}: dashboard arrears are the ledger's, each debt once`, delBy(cur) === rawArrears(cur), `${delBy(cur)} vs ${rawArrears(cur)}`);
    const v4 = del.filter(a => a.unit.id === 'unit-4');
    T.check('the moved-out tenant owes rent and the levy inside it is not listed as a second debt', v4.length === 1 && v4[0].category === 'Rent', v4.map(a => `${a.category} ${a.balance}`).join(', '));
    T.check('so moving out does not raise the arrears by the levy', v4.reduce((s, a) => s + cents(a.balance), 0) <= beforeMove, `${v4.reduce((s, a) => s + cents(a.balance), 0)} after vs ${beforeMove} before`);
    const aged = M.arrearsAgeing(db.units, db.charges, S, TODAY);
    for (const cur of ['JMD', 'USD']) T.check(`${cur}: the ageing (health grade) totals the dashboard arrears`, cents(aged.find(a => a.currency === cur)?.buckets.total || 0) === delBy(cur));

    const arrearsLine = (dash.match(/Accounts in arrears (\d+) (.*?) outstanding/) || []);
    const expectArrears = ['JMD', 'USD'].filter(cur => delBy(cur) > 0).map(cur => fm(delBy(cur) / 100, cur)).join(' + ');
    T.check('the dashboard card shows that count and those totals', Number(arrearsLine[1]) === del.length && arrearsLine[2] === expectArrears, `${arrearsLine[0]} vs ${del.length} ${expectArrears}`);
    for (const a of del) {
      T.check(`the hub lists ${a.unit.number} ${a.category} at the dashboard's balance`, hub.includes(`${a.category === 'Rent' ? 'Rent' : 'HOA maintenance'} outstanding, Villa Unit ${a.unit.number}`) && hub.includes(`Outstanding ${fm(a.balance, a.currency)} ${a.currency}`));
    }
    const unpaidUtil = cur => db.utilities.filter(u => u.status === 'unpaid' && u.currency === cur).reduce((s, u) => s + cents(u.amountCharged), 0);
    const totalLine = hub.match(/Total value (\S+) JMD (\S+) USD/) || [];
    T.check('the hub\'s total owed is the dashboard arrears plus unpaid utility bills — not the bills the property owes', totalLine[1] === fm((delBy('JMD') + unpaidUtil('JMD')) / 100, 'JMD') && totalLine[2] === fm((delBy('USD') + unpaidUtil('USD')) / 100, 'USD'), `${totalLine[0]} vs ${fm(delBy('JMD') / 100, 'JMD')} / ${fm(delBy('USD') / 100, 'USD')}`);
    T.check('and what the property owes is stated beside it, separately', hub.includes(`Owed by the property (expenses due): ${fm(40000, 'JMD')} JMD`));
    T.check('the scenario has a lease ending and a month posted not yet due, so the badge rule is exercised', /Lease ending soon/.test(hub) && /posted, not yet due/.test(hub));
    T.check('the sidebar badge equals the hub\'s open items', badgeOf(db) === openItems(hub), `badge ${badgeOf(db)} vs hub ${openItems(hub)}`);
    {
      // The badge is drawn by App.tsx, which cannot be rendered here: hold its source to the shared count.
      const app = fs.readFileSync(path.join(projectRoot, 'src', 'App.tsx'), 'utf8');
      const memo = (app.match(/const outstandingCount = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[/) || [])[1] || '';
      T.check('App.tsx draws the badge from hubOpenItemCount and nothing else', /badge: outstandingCount/.test(app) && /return hubOpenItemCount\(\{ \.\.\.data, payments: settledPayments, settings \}/.test(memo) && !/delinquentAccounts|countBookingOverlaps/.test(memo), memo.trim().slice(0, 200));
    }

    /* ---------- Post month flowed to the dashboard ---------- */
    const combined = M.consolidateEverything(db.charges, S, db.units);
    for (const cur of ['JMD', 'USD']) {
      const billed = M.chargedInPeriod(combined.charges, cur, M.monthStart ? M.monthStart(M0) : `${M0}-01`, `${M0}-31`);
      T.check(`${cur}: the month just posted is what the dashboard says was billed`, dash.includes(`Total billed ${fm(billed.total, cur)}`) && billed.total > 0, fm(billed.total, cur));
    }

    /* ---------- the health card and the ledger panel beside it read the same month the same way ---------- */
    const rates = [...dash.matchAll(/Collection rate ([\d.]+)%/g)].map(x => Number(x[1]));
    const healthRates = [...dash.matchAll(/Collection ([\d.]+)% of ([\d,.]+) billed is paid/g)].map(x => Number(x[1]));
    T.check('both currencies are graded and both panels show a rate', rates.length === 2 && healthRates.length === 2, `${rates} / ${healthRates}`);
    for (let i = 0; i < Math.min(rates.length, healthRates.length); i++) {
      T.check(`${['JMD', 'USD'][i]}: the health card's collection is the ledger panel's collection rate`, Math.abs(rates[i] - healthRates[i]) <= 0.05, `${healthRates[i]}% vs ${rates[i]}%`);
    }
    const received = [...dash.matchAll(/Total received (\S+)/g)].map(x => x[1]);
    const cashRx = [...dash.matchAll(/Cash position ([\d,.]+) received/g)].map(x => x[1]);
    for (let i = 0; i < Math.min(received.length, cashRx.length); i++) {
      T.check(`${['JMD', 'USD'][i]}: the health card's cash received is the panel's total received, each dollar once`, received[i].replace(/[^\d.]/g, '') === cashRx[i].replace(/[^\d.]/g, ''), `${cashRx[i]} vs ${received[i]}`);
    }
    const rentInMonth = db.payments.filter(p => p.status === 'completed' && p.category === 'Rent' && p.currency === 'JMD' && p.date.startsWith(M0)).reduce((s, p) => s + cents(p.amount), 0);
    const levyFromRentInMonth = S.filter(p => p.derived && p.currency === 'JMD' && p.date.startsWith(M0)).reduce((s, p) => s + cents(p.amount), 0);
    T.check('the scenario has rent received this month that settles a levy (else the double count cannot show)', rentInMonth > 0 && levyFromRentInMonth > 0, `${rentInMonth} / ${levyFromRentInMonth}`);

    /* ---------- the Units Register agrees with the ledger, villa by villa ---------- */
    const cardText = (t, from, to) => { const i = t.indexOf(from); if (i < 0) return ''; const j = t.indexOf(to, i + from.length); return t.slice(i, j < 0 ? undefined : j); };
    const statusText = a => (a.balance > 0 ? `${fm(a.balance, a.currency)} outstanding` : a.balance < 0 ? `${fm(-a.balance, a.currency)} in credit` : null);
    for (const u of db.units) {
      const t = detail(u);
      const rent = M.accountBalance(u, 'Rent', db.charges, S, TODAY, db.units);
      const maint = M.accountBalance(u, 'Maintenance', db.charges, S, TODAY, db.units);
      const rentCard = cardText(t, u.status === 'short-term' ? 'Nightly charge' : 'Agreed monthly rent', 'Monthly HOA maintenance');
      const maintCard = cardText(t, 'Monthly HOA maintenance', 'Receive payment') || cardText(t, 'Monthly HOA maintenance', 'Resident');
      if (rent.balance !== 0) T.check(`register ${u.number}: rent card shows the ledger's ${statusText(rent)}`, rentCard.includes(statusText(rent)), rentCard.slice(0, 200));
      if (maint.balance !== 0) T.check(`register ${u.number}: levy card shows the ledger's ${statusText(maint)}`, maintCard.includes(statusText(maint)), maintCard.slice(0, 200));
      if (maint.balance <= 0) T.check(`register ${u.number}: levy card claims nothing outstanding the ledger does not`, !/outstanding/.test(maintCard), maintCard.slice(0, 200));
    }
    const u4 = db.units.find(u => u.id === 'unit-4');
    T.check('the moved-out villa is vacant on the register with no sitting tenant', u4.status === 'vacant' && !u4.tenantName && register.includes('Vacant'));
    T.check('the ledger still names the former tenant as the debtor, as the dashboard does', ledgerScreen.includes('Tenant Four (former tenant)') && dash.includes('Payer: Tenant Four'));
    for (const t of db.tenancies.filter(x => x.status === 'active')) {
      T.check(`register shows ${t.tenantName} on ${t.unitNumber}, the tenant the rent account is billed to`, register.includes(`Tenant: ${t.tenantName}`) && db.charges.filter(x => x.unitId === t.unitId && x.category === 'Rent' && x.status === 'open' && x.periodMonth === M0).every(x => x.payerName === t.tenantName));
    }
    for (const a of del.filter(x => x.category === 'Rent')) T.check(`the HOA & Tenants Ledger shows ${a.unit.number}'s rent arrears`, ledgerScreen.includes(fm(a.balance, a.currency)));

    /* ---------- short stays: receipts, refunds and deposits ---------- */
    const live = db.bookings.filter(b => b.status !== 'cancelled');
    for (const cur of ['JMD', 'USD']) {
      const fromBookings = live.filter(b => b.currency === cur).reduce((s, b) => s + cents(b.depositPaid), 0);
      const fromReceipts = db.payments
        .filter(p => p.bookingId && p.status === 'completed' && p.currency === cur && live.some(b => b.id === p.bookingId))
        .reduce((s, p) => s + cents(p.amount) - cents(p.refundedAmount || 0), 0);
      T.check(`${cur}: paid toward live stays = their receipts net of refunds`, fromBookings === fromReceipts, `${fromBookings} vs ${fromReceipts}`);
      const panel = M.collectedInPeriod(combined.payments, cur, `${M0}-01`, `${M0}-31`).booking;
      const rawMonth = db.payments.filter(p => p.category === 'Booking' && p.status === 'completed' && p.currency === cur && p.date.startsWith(M0)).reduce((s, p) => s + cents(p.amount), 0)
        - db.payments.filter(p => p.category === 'Booking' && p.status === 'completed' && p.currency === cur && (p.refundedOn || '').startsWith(M0)).reduce((s, p) => s + cents(p.refundedAmount), 0);
      T.check(`${cur}: dashboard bookings received this month = booking receipts less refunds paid out this month`, cents(panel) === rawMonth && dash.includes(`Bookings ${fm(panel, cur)}`), `${panel} vs ${rawMonth / 100}`);
    }
    // Read from the receipts since QA 2026-11-19 (stayMoney): deposits and later payments, net of refunds.
    const depLine = dash.match(/Paid toward stays (\S+) USD (\S+) JMD/) || [];
    const dep = cur => live.filter(b => b.currency === cur).reduce((s, b) => s + cents(b.depositPaid), 0) / 100;
    T.check('the dashboard calls stay part-payments what they are, "Paid toward stays", and they equal the receipts', depLine[1] === fm(dep('USD'), 'USD') && depLine[2] === fm(dep('JMD'), 'JMD') && !/Deposits held/.test(dash), depLine[0]);
    const damageHeld = db.bookings.filter(b => b.damageDepositAmount && !b.damageDepositReturnedOn).reduce((s, b) => s + cents(b.damageDepositAmount), 0);
    T.check('a damage deposit is held, so the next check means something', damageHeld > 0);
    T.check('no damage deposit is ever a receipt', !db.payments.some(p => /damage/i.test(p.notes || '') && p.category === 'Booking' && !p.bookingId));

    const integ = (await c.get('/api/integrity')).body;
    T.check('the books report no contradiction', integ.ok === true && integ.serious === 0, JSON.stringify(integ.findings).slice(0, 300));
  } catch (err) {
    T.check('the daily-screens audit ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    cleanup();
  }
  return T.done();
}
