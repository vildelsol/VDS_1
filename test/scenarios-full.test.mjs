/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two hundred scenarios across the whole application, on a fully populated property.
 *
 * The `scenarios` run exercises the ledger hard but starts from bare
 * villas and touches roughly half the application. This one starts from a
 * property that looks like a real one on its first day of use — all sixteen villas
 * configured, a mix of long lets, short lets, an owner-occupied villa and one out
 * of service, rates in both currencies, staff in every role — and then drives the
 * parts the other simulation never reaches:
 *
 *   monthly cost templates and posting them, maintenance work orders through to
 *   the expense they create, resident activity records, damage deposits on short
 *   stays, security deposits held and returned, lease terms and renewals, bank
 *   reconciliation, receipt reprints, staff administration, permission changes,
 *   calendar feeds, backups, and the records export.
 *
 * The invariants are the ones that matter when all of it is running at once. Not
 * just "is the ledger coherent", but the cross-cutting statements a property
 * manager would assume without thinking: a work order's cost reaches the expense
 * register exactly once, a month's costs are not posted twice, a deposit that was
 * returned is not still held, and no villa is sold twice on the same night.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Two hundred scenarios across the whole application';

/**
 * Two hundred, not one hundred. At a hundred, the scenario list does not get
 * round often enough for its probabilistic branches to all fire — a dead route
 * sat in the expense scenario undetected because the `rand() > 0.7` arm that
 * called it was never reached. Raise this rather than lower it.
 *
 * Override for a deeper run: VDS_SCENARIOS_FULL=500 node test/run.mjs
 */
const SCENARIO_COUNT = Number(process.env.VDS_SCENARIOS_FULL) || 200;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const money = (rand, low, high) => Math.round((low + rand() * (high - low)) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
/**
 * The month a scenario acts in.
 *
 * Derived from how many times this scenario has already run, **not** from `i`
 * directly. A scenario only runs when `i % scenarios.length` selects it, so
 * `monthOf(i)` is *constant* for a given scenario whenever the scenario count is
 * a multiple of twelve — every run lands in the same month, records that dedupe
 * per period collapse to one, and the simulation quietly stops covering the
 * ground its assertions claim. Adding two scenarios took the count to 24 and cut
 * utility readings from dozens to ten, all settled.
 *
 * Taking the repetition number instead varies the month whatever the scenario
 * count is.
 */
const monthOf = n => `2026-${pad((n % 12) + 1)}`;
const dayIn = (month, day) => `${month}-${pad(Math.min(28, Math.max(1, day)))}`;
const isBad = v => typeof v === 'number' && !Number.isFinite(v);

/**
 * Everything that must hold across the whole application, not just the ledger.
 * Returns complaints; empty means the property's books make sense.
 */
function auditEverything(db) {
  const p = [];
  const { payments = [], charges = [], bookings = [], units = [], expenses = [], utilities = [], unitActivities = [], tenancies = [], recurringExpenses = [], auditLogs = [] } = db;

  // --- receipts and money ---
  if (new Set(payments.map(x => x.id)).size !== payments.length) p.push('two payments share an id');
  const receipts = payments.filter(x => x.receiptNo).map(x => x.receiptNo);
  if (new Set(receipts).size !== receipts.length) p.push('two receipts share a number');
  for (const x of payments) {
    if (x.status === 'pending' && x.receiptNo) p.push(`pending ${x.id} holds a receipt number`);
    if (x.status === 'completed' && !x.receiptNo) p.push(`received ${x.id} has no receipt number`);
    if (isBad(x.amount) || x.amount < 0) p.push(`payment ${x.id} has an impossible amount`);
    if (x.refundedAmount > x.amount + 1e-9) p.push(`payment ${x.id} refunded beyond its worth`);
    if (typeof x.printCount === 'number' && x.printCount < 0) p.push(`payment ${x.id} has a negative print count`);
  }

  // --- charges ---
  if (new Set(charges.map(x => x.id)).size !== charges.length) p.push('two charges share an id');
  const billed = new Map();
  // See scenarios-300: the advance charge for a final month shares the move-in
  // month's period legitimately and is not a double-billing.
  for (const c of charges.filter(x => x.status === 'open' && !x.oneOffType && x.kind !== 'advance-final-month')) {
    const key = `${c.unitId}|${c.category}|${c.periodMonth}`;
    if (billed.has(key)) p.push(`${key} billed twice`);
    else billed.set(key, c.id);
  }
  for (const c of charges) if (isBad(c.amount) || c.amount <= 0) p.push(`charge ${c.id} has an impossible amount`);

  // --- stays ---
  for (const b of bookings) {
    if (b.checkOut <= b.checkIn) p.push(`booking ${b.id} ends before it starts`);
    if (isBad(b.amount) || isBad(b.depositPaid)) p.push(`booking ${b.id} holds a non-finite figure`);
    if (b.damageDepositAmount && (b.damageDepositReturnedAmount || 0) + (b.damageDepositWithheldAmount || 0) > b.damageDepositAmount + 1e-9) {
      p.push(`booking ${b.id} settled more damage deposit than it held`);
    }
  }
  const perUnit = new Map();
  for (const b of bookings.filter(x => x.status === 'confirmed')) {
    const list = perUnit.get(b.unitId) || [];
    for (const o of list) if (b.checkIn < o.checkOut && o.checkIn < b.checkOut) p.push(`villa ${b.unitNumber} sold twice over ${b.checkIn}..${b.checkOut}`);
    list.push(b);
    perUnit.set(b.unitId, list);
  }

  // --- deposits held must not also be returned ---
  for (const t of tenancies) {
    if (isBad(t.depositAmount) || (typeof t.depositAmount === 'number' && t.depositAmount < 0)) p.push(`tenancy ${t.id} has an impossible deposit`);
    const handedBack = (t.depositReturnedAmount || 0) + (t.depositWithheldAmount || 0);
    if (t.depositReturnedOn && handedBack > (t.depositAmount || 0) + 1e-9) {
      p.push(`tenancy ${t.id} settled ${handedBack} of a ${t.depositAmount} deposit`);
    }
  }

  // --- a work order's cost reaches the register exactly once ---
  // The link runs from the work order to the expense it raised.
  for (const a of unitActivities.filter(x => x.expenseId)) {
    const linked = expenses.filter(e => e.id === a.expenseId);
    if (linked.length > 1) p.push(`work order ${a.id} raised ${linked.length} expenses`);
  }
  const raised = unitActivities.filter(x => x.expenseId).map(x => x.expenseId);
  if (new Set(raised).size !== raised.length) p.push('two work orders raised the same expense');
  for (const a of unitActivities) {
    if (isBad(a.costAmount) || (typeof a.costAmount === 'number' && a.costAmount < 0)) p.push(`activity ${a.id} has an impossible cost`);
  }

  // --- costs ---
  for (const e of expenses) if (isBad(e.amount) || e.amount < 0) p.push(`expense ${e.id} has an impossible amount`);
  // A monthly template must not post the same month twice.
  const postedTemplates = new Map();
  for (const e of expenses.filter(x => x.recurringId && x.periodMonth)) {
    const key = `${e.recurringId}|${e.periodMonth}`;
    if (postedTemplates.has(key)) p.push(`monthly cost ${key} posted twice`);
    else postedTemplates.set(key, e.id);
  }
  for (const t of recurringExpenses) {
    if (isBad(t.amount) || t.amount <= 0) p.push(`monthly cost ${t.id} has an impossible amount`);
    if (t.dueDay < 1 || t.dueDay > 28) p.push(`monthly cost ${t.id} is due on day ${t.dueDay}`);
  }

  // --- meters ---
  for (const u of utilities) {
    if (isBad(u.consumption) || u.consumption < 0) p.push(`utility ${u.id} consumed an impossible amount`);
    if (u.currentReading < u.previousReading) p.push(`utility ${u.id} went backwards`);
  }

  // --- villas ---
  for (const u of units) {
    if (isBad(u.monthlyRent) || u.monthlyRent < 0) p.push(`villa ${u.number} has an impossible rent`);
    if (u.status === 'unavailable' && charges.some(c => c.unitId === u.id && c.status === 'open' && c.periodMonth === '2026-12')) {
      p.push(`villa ${u.number} is out of service but was billed`);
    }
  }

  // --- the trail ---
  for (const a of auditLogs.slice(0, 200)) {
    if (!a.user || !a.dateTime || !a.action) p.push('an audit entry is missing who, when or what');
  }

  return p;
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'FullSuite-1234!', projectRoot });
  const T = reporter(title);

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'FullSuite-1234!', 'FullSuiteNew-9876!');

    /* ---------------------------------------------------------------- *
     * Day one: a property that looks like a real one
     * ---------------------------------------------------------------- */

    const unitIds = (await c.get('/api/db')).body.units.map(u => u.id);
    const setup = rng(7);
    const longLets = [];
    const shortLets = [];

    for (let i = 0; i < unitIds.length; i++) {
      const id = unitIds[i];
      const number = id.replace('unit-', '');
      let body;
      if (i % 4 === 3) {
        // A short let, priced in USD as the platforms do.
        body = { number, ownerName: `Owner ${i}`, status: 'short-term', monthlyMaintenance: money(setup, 150, 600), currency: 'USD', maintCurrency: 'USD' };
        shortLets.push(id);
      } else if (i === 14) {
        body = { number, ownerName: `Owner ${i}`, status: 'unavailable', currency: 'JMD', maintCurrency: 'JMD' };
      } else if (i === 13) {
        body = { number, ownerName: `Owner ${i}`, status: 'owner-occupied', monthlyMaintenance: money(setup, 8000, 18000), currency: 'JMD', maintCurrency: 'JMD' };
      } else {
        body = {
          number,
          ownerName: `Owner ${i}`,
          tenantName: `Tenant ${i}`,
          status: 'long-term',
          monthlyRent: money(setup, 45000, 140000),
          monthlyMaintenance: money(setup, 8000, 20000),
          currency: 'JMD',
          maintCurrency: 'JMD',
          rentDueDay: 1,
          maintDueDay: 1
        };
        longLets.push(id);
      }
      await c.put(`/api/units/${id}`, body);
    }

    T.check('all sixteen villas are configured', (await c.get('/api/db')).body.units.length === 16);
    T.check('the property has long lets, short lets and villas off the market', longLets.length > 5 && shortLets.length >= 3);

    // Staff in every role, as a real office has.
    for (const [name, username, role] of [
      ['Manny Manager', 'manager', 'MANAGER'],
      ['Fin Officer', 'finance', 'FINANCE_OFFICER'],
      ['Junior Jo', 'junior', 'JUNIOR_OFFICER']
    ]) {
      await c.post('/api/users', { name, username, role, password: 'StaffPass-11!' });
    }
    const junior = makeClient(srv.baseUrl);
    await junior.post('/api/auth/login', { username: 'junior', password: 'StaffPass-11!' }, { captureCookie: true });
    await junior.post('/api/auth/change-password', { currentPassword: 'StaffPass-11!', newPassword: 'JuniorOwn-22!' });

    // Monthly cost templates, the ones re-typed by hand before this existed.
    const templates = [];
    for (const [vendor, category, amount] of [
      ['Atlas Security Jamaica', 'Security', 180000],
      ['Jamaica Public Service Company', 'Utilities', 95000],
      ['Ocho Rios Garden Services', 'Landscaping', 60000],
      ['Payroll', 'Payroll', 420000]
    ]) {
      const t = await c.post('/api/recurring-expenses', { vendor, category, amount, currency: 'JMD', dueDay: 5, description: 'standing monthly cost' });
      if (t.body?.template?.id) templates.push(t.body.template.id);
    }
    T.check('the standing monthly costs are on file', templates.length === 4, `${templates.length} of 4`);

    /* ---------------------------------------------------------------- *
     * A hundred scenarios across the whole application
     * ---------------------------------------------------------------- */

    const scenarios = [
      // The month is billed and most tenants pay.
      async ({ month, rand }) => {
        await c.post('/api/charges/post-month', { monthString: month });
        for (const id of longLets.slice(0, 4)) {
          const due = (await c.get('/api/db')).body.charges.find(x => x.unitId === id && x.category === 'Rent' && x.periodMonth === month && x.status === 'open');
          if (!due) continue;
          const pay = await c.post('/api/payments', { unitId: id, category: 'Rent', amount: rand() > 0.25 ? due.amount : Math.round(due.amount * 0.4 * 100) / 100, currency: 'JMD', payerName: 'Tenant', method: pick(rand, ['Cash', 'Bank Transfer', 'Cheque']) });
          if (pay.body?.payment?.id) await c.post(`/api/payments/${pay.body.payment.id}/confirm`, {});
        }
      },

      // The standing costs are posted for the month.
      async ({ month, rand }) => {
        await c.post('/api/expenses/post-month', { monthString: month, items: templates.map(id => ({ recurringId: id, ...(rand() > 0.6 ? { amount: money(rand, 50000, 200000) } : {}) })) });
        // Posting the same month again must add nothing.
        await c.post('/api/expenses/post-month', { monthString: month, items: templates.map(id => ({ recurringId: id })) });
      },

      // A maintenance request, assigned, completed, and its cost recorded.
      async ({ month, rand }) => {
        const unitId = pick(rand, longLets);
        const raised = await c.post('/api/unit-activities', {
          unitId,
          residentName: 'Tenant',
          residentRole: 'Tenant',
          activityType: 'Maintenance Request',
          dateCaptured: dayIn(month, 3),
          notes: 'Water heater is not working.'
        });
        const id = raised.body?.activity?.id;
        if (!id) return;
        await c.put(`/api/unit-activities/${id}`, { workStatus: 'Scheduled', assignedTo: 'Jamaica Plumbers Ltd' });
        await c.put(`/api/unit-activities/${id}`, { workStatus: 'Completed', completedOn: dayIn(month, 12), outcome: 'Replaced the element.', costAmount: money(rand, 3000, 45000), costCurrency: 'JMD' });
        // The cost only reaches the register when someone raises it, deliberately.
        await c.put(`/api/unit-activities/${id}`, { raiseExpense: true });
        // Asking twice must not raise it twice.
        await c.put(`/api/unit-activities/${id}`, { raiseExpense: true });
      },

      // Ordinary resident records that are not work.
      async ({ month, rand }) => {
        await c.post('/api/unit-activities', {
          unitId: pick(rand, unitIds),
          residentName: 'Resident',
          residentRole: pick(rand, ['Owner', 'Tenant', 'Guest']),
          activityType: pick(rand, ['Construction Work', 'Pool Reservation', 'Noise / Event Notice', 'Amenity Access', 'Other Activity']),
          dateCaptured: dayIn(month, 1 + Math.floor(rand() * 27)),
          notes: 'Logged during the simulation.'
        });
      },

      // A short stay with a damage deposit, held and then settled.
      async ({ month, rand, i }) => {
        const unitId = shortLets[i % shortLets.length];
        const start = 1 + ((i * 7) % 24);
        const b = await c.post('/api/bookings', { unitId, guestName: `Guest ${i}`, checkIn: dayIn(month, start), checkOut: dayIn(month, start + 2), amount: money(rand, 300, 2500), depositPaid: money(rand, 50, 500), currency: 'USD', source: pick(rand, ['Direct', 'Airbnb', 'Booking.com']) });
        const id = b.body?.booking?.id;
        if (!id) return;
        const held = await c.post(`/api/bookings/${id}/damage-deposit`, { amount: money(rand, 100, 600), currency: 'USD', receivedOn: dayIn(month, start) });
        if (!held.status || held.status !== 200) return;
        if (rand() > 0.4) {
          await c.post(`/api/bookings/${id}/damage-deposit/settle`, { withheldAmount: rand() > 0.6 ? money(rand, 10, 80) : 0, reason: 'checked on departure' });
        }
      },

      // A tenant's security deposit taken and later returned with a deduction.
      async ({ rand }) => {
        const unitId = pick(rand, longLets);
        const tenancies = (await c.get('/api/db')).body.tenancies.filter(t => t.unitId === unitId && !t.depositReturnedOn && !t.depositAmount);
        if (!tenancies.length) return;
        const t = tenancies[tenancies.length - 1];
        const held = money(rand, 40000, 200000);
        const taken = await c.post(`/api/tenancies/${t.id}/deposit`, { amount: held, currency: 'JMD', method: 'Bank Transfer' });
        if (taken.status !== 200) return;
        if (rand() > 0.5) await c.post(`/api/tenancies/${t.id}/deposit/settle`, { withheldAmount: Math.round(held * 0.2 * 100) / 100, reason: 'cleaning and a broken blind' });
      },

      // Lease terms recorded and renewed.
      async ({ rand }) => {
        const unitId = pick(rand, longLets);
        const tenancies = (await c.get('/api/db')).body.tenancies.filter(t => t.unitId === unitId);
        if (!tenancies.length) return;
        const t = tenancies[tenancies.length - 1];
        await c.put(`/api/tenancies/${t.id}`, { leaseEndsOn: pick(rand, ['2026-09-30', '2026-12-31', '2027-06-30']) });
      },

      // Meters read and settled.
      async ({ month, rand }) => {
        const unitId = pick(rand, longLets);
        const prev = Math.floor(rand() * 800);
        const u = await c.post('/api/utilities', { unitId, billingPeriod: month, previousReading: prev, currentReading: prev + Math.floor(rand() * 300), amountCharged: money(rand, 2000, 30000), currency: 'JMD' });
        const id = u.body?.utility?.id;
        if (!id) return;
        if (rand() > 0.3) {
          const s = await c.post(`/api/utilities/${id}/settle`, { method: 'Cash' });
          if (s.body?.payment?.id) await c.post(`/api/payments/${s.body.payment.id}/confirm`, {});
        }
      },

      // Bank reconciliation, then un-matching one.
      async ({ rand }) => {
        const db = (await c.get('/api/db')).body;
        const bankPayments = db.payments.filter(x => x.status === 'completed' && x.method === 'Bank Transfer' && !x.reconciledOn).slice(0, 3);
        for (const x of bankPayments) await c.post(`/api/payments/${x.id}/reconcile`, { matched: true, statementRef: `STMT-${Math.floor(rand() * 9999)}` });
        if (bankPayments[0]) await c.post(`/api/payments/${bankPayments[0].id}/reconcile`, { matched: false });
      },

      // Receipts printed and reprinted.
      async ({ rand }) => {
        const db = (await c.get('/api/db')).body;
        const issued = db.payments.filter(x => x.receiptNo).slice(-3);
        for (const x of issued) {
          await c.post(`/api/payments/${x.id}/mark-printed`, {});
          if (rand() > 0.6) await c.post(`/api/payments/${x.id}/mark-printed`, {});
        }
      },

      // A late fee, then settled.
      async ({ month, rand }) => {
        const unitId = pick(rand, longLets);
        const amount = money(rand, 1000, 12000);
        const raised = await c.post('/api/charges', { unitId, category: 'Rent', oneOffType: pick(rand, ['Late fee', 'Repair recharge', 'Fine / breach', 'Legal costs', 'Special assessment']), amount, dueDate: dayIn(month, 20), description: 'raised in the simulation' });
        if (raised.status !== 200) return;
        const pay = await c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Tenant', method: 'Cash', confirmNoOpenCharge: true });
        if (pay.body?.payment?.id) await c.post(`/api/payments/${pay.body.payment.id}/confirm`, {});
      },

      // Money taken, voided, refunded — the awkward combinations together.
      async ({ rand }) => {
        const unitId = pick(rand, longLets);
        const amount = money(rand, 5000, 60000);
        const a = await c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Tenant', method: 'Cash', confirmNoOpenCharge: true });
        const id = a.body?.payment?.id;
        if (!id) return;
        await c.post(`/api/payments/${id}/confirm`, {});
        if (rand() > 0.5) {
          await c.post(`/api/payments/${id}/refund`, { amount: Math.round(amount * 0.5 * 100) / 100, reason: 'part refund' });
          await c.post(`/api/payments/${id}/reverse`, { reversalReason: 'attempted void after a refund' });
        } else {
          await c.post(`/api/payments/${id}/reverse`, { reversalReason: 'entered twice' });
          await c.post(`/api/payments/${id}/refund`, { amount, reason: 'attempted refund after a void' });
        }
      },

      // A junior working the desk under changing permissions.
      async ({ rand }) => {
        const unitId = pick(rand, longLets);
        await c.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: rand() > 0.4, addBookings: true } } });
        const attempt = await junior.post('/api/payments', { unitId, category: 'Rent', amount: money(rand, 500, 8000), currency: 'JMD', payerName: 'Walk-in', method: 'Cash', confirmNoOpenCharge: true });
        if (attempt.body?.payment?.id) await junior.post(`/api/payments/${attempt.body.payment.id}/confirm`, {});
        await c.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: true, addBookings: true } } });
      },

      // Settings, vendors and the rate.
      async ({ rand }) => {
        await c.post('/api/settings', { vendors: ['Atlas Security Jamaica', 'Jamaica Plumbers Ltd', `Vendor ${Math.floor(rand() * 50)}`], fxRateJmdPerUsd: money(rand, 140, 175) });
        await c.post('/api/settings', { fxRateJmdPerUsd: 0.5 });
        await c.post('/api/settings', { fxRateJmdPerUsd: 50000 });
      },

      // Calendar feeds added and removed.
      async ({ rand }) => {
        const unitId = pick(rand, shortLets);
        const added = await c.post('/api/ical/feeds', { unitId, url: `https://www.airbnb.com/calendar/ical/${Math.floor(rand() * 1e9)}.ics?s=token`, source: 'Airbnb' });
        await c.post('/api/ical/feeds', { unitId, url: 'http://127.0.0.1:9/evil.ics', source: 'Other' });
        if (added.body?.feed?.id && rand() > 0.5) await c.del(`/api/ical/feeds/${added.body.feed.id}`);
      },

      // Costs recorded and then corrected. There is no delete: an expense is an
      // audited record and the correction path is an edit, so a scenario that
      // reached for DELETE was calling a route that does not exist and proving
      // nothing. It re-dates and re-categorises instead, which is what the
      // office actually does to a cost entered wrongly.
      async ({ month, rand }) => {
        const e = await c.post('/api/expenses', { category: pick(rand, ['Maintenance', 'Security', 'Supplies', 'Contractors']), description: 'ad hoc cost', amount: money(rand, 500, 40000), currency: pick(rand, ['JMD', 'USD']), date: dayIn(month, 1 + Math.floor(rand() * 27)), vendor: 'Vendor' });
        const id = e.body?.expense?.id;
        if (!id) return;
        await c.put(`/api/expenses/${id}`, { amount: money(rand, 500, 40000) });
        if (rand() > 0.7) {
          await c.put(`/api/expenses/${id}`, {
            category: pick(rand, ['Maintenance', 'Security', 'Supplies', 'Contractors']),
            date: dayIn(month, 1 + Math.floor(rand() * 27))
          });
        }
      },

      // Backups and the records export, while everything else is running.
      async () => {
        await c.post('/api/backup/run', {});
        await c.get('/api/backup/status');
        await c.get('/api/backup/download');
      },

      // Staff administration mid-flight.
      async ({ rand, i }) => {
        const created = await c.post('/api/users', { name: `Temp ${i}`, username: `temp${i}`, role: pick(rand, ['JUNIOR_OFFICER', 'FINANCE_OFFICER']), password: 'TempPass-11!' });
        const id = created.body?.user?.id;
        if (!id) return;
        await c.post(`/api/users/${id}/reset-password`, { password: 'Reissued-1234!' });
        await c.put(`/api/users/${id}`, { active: false });
      },

      // Rubbish thrown at the whole surface at once.
      async ({ month, rand }) => {
        const unitId = pick(rand, unitIds);
        await c.post('/api/payments', { unitId, category: 'Rent', amount: '1.500.000', currency: 'JMD', payerName: 'Fat finger', method: 'Cash', confirmNoOpenCharge: true });
        await c.post('/api/expenses', { category: 'Maintenance', description: 'bad', amount: '1e999', currency: 'JMD', date: dayIn(month, 5), vendor: 'V' });
        await c.post('/api/utilities', { unitId, billingPeriod: month, previousReading: 500, currentReading: 100, amountCharged: 5000, currency: 'JMD' });
        await c.post('/api/bookings', { unitId, guestName: 'Backwards', checkIn: dayIn(month, 20), checkOut: dayIn(month, 10), amount: 100, currency: 'USD', source: 'Direct' });
        await c.post('/api/charges/post-month', { monthString: 'not-a-month' });
        await c.post('/api/recurring-expenses', { vendor: 'V', category: 'Security', amount: 1000, currency: 'JMD', dueDay: 31 });
        await c.put(`/api/units/${unitId}`, { number: unitId.replace('unit-', ''), ownerName: 'O', status: 'long-term', monthlyRent: '1.500.000', currency: 'JMD', maintCurrency: 'JMD' });
      },

      // The month closed off: everything looked at together.
      async ({ month }) => {
        await c.post('/api/charges/post-month', { monthString: month });
        await c.get('/api/db');
        await c.get('/api/auth/me');
        await c.get('/api/backup/status');
      }
    ];

    let ran = 0;
    const failures = [];

    // Only the scenario loop is under scrutiny; setup above may probe freely.
    c.clearNotFound();
    for (let i = 0; i < SCENARIO_COUNT; i++) {
      const seed = 5000 + i;
      const rand = rng(seed);
      const scenario = scenarios[i % scenarios.length];
      try {
        await scenario({ month: monthOf(Math.floor(i / scenarios.length)), rand, i, seed });
      } catch (err) {
        failures.push(`seed ${seed} threw ${err.message}`);
        continue;
      }
      ran++;

      const problems = auditEverything((await c.get('/api/db')).body);
      if (problems.length) failures.push(`seed ${seed} (scenario ${i % scenarios.length}): ${problems.slice(0, 3).join('; ')}`);
    }

    T.check(`all ${SCENARIO_COUNT} scenarios ran without the server failing`, ran === SCENARIO_COUNT, `${ran} of ${SCENARIO_COUNT}`);
    const dead = c.notFound();
    T.check(
      'every scenario called a route that exists, so none of them silently did nothing',
      dead.length === 0,
      `${dead.length} calls 404'd, e.g. ${[...new Set(dead)].slice(0, 3).join(' | ')}`
    );
    T.check('the whole application stayed coherent after every one', failures.length === 0, failures.slice(0, 5).join(' | '));

    /* ---------------------------------------------------------------- *
     * The property at the end of it
     * ---------------------------------------------------------------- */

    const db = (await c.get('/api/db')).body;

    T.check('rent was billed and collected', db.charges.some(x => x.category === 'Rent') && db.payments.some(x => x.category === 'Rent' && x.status === 'completed'));
    T.check('standing monthly costs were posted', db.expenses.some(x => x.recurringId));
    T.check('and never posted twice for the same month', auditEverything(db).every(x => !/posted twice/.test(x)));
    T.check('maintenance was requested, done and paid for', db.unitActivities.some(a => a.workStatus === 'Completed' && a.costAmount > 0));
    T.check('the work reached the expense register', db.unitActivities.some(a => a.expenseId && db.expenses.some(e => e.id === a.expenseId)));
    T.check('a work order raised its cost exactly once', db.unitActivities.filter(a => a.expenseId).every(a => db.expenses.filter(e => e.id === a.expenseId).length === 1));
    T.check('resident activity was recorded', db.unitActivities.some(a => a.activityType !== 'Maintenance Request'));
    T.check('short stays were booked', db.bookings.length >= 5, `${db.bookings.length} bookings`);
    T.check('damage deposits were held', db.bookings.some(b => b.damageDepositAmount > 0));
    T.check('security deposits were held', db.tenancies.some(t => t.depositAmount > 0));
    T.check('some deposits were settled and handed back', db.tenancies.some(t => t.depositReturnedOn) || db.bookings.some(b => b.damageDepositReturnedOn));
    T.check('lease end dates were recorded', db.tenancies.some(t => t.leaseEndsOn));
    T.check('meters were read', db.utilities.length > 3, `${db.utilities.length} readings`);
    T.check('payments were reconciled against the bank', db.payments.some(x => x.reconciledOn));
    T.check('receipts were reprinted', db.payments.some(x => x.printCount > 1));
    T.check('one-off charges were raised', db.charges.some(x => x.oneOffType));
    T.check('both currencies are in use', new Set(db.payments.map(x => x.currency)).size === 2);
    T.check('calendar feeds were linked', db.settings.icalFeeds.length > 0);
    T.check('no internal feed was ever stored', !db.settings.icalFeeds.some(f => /127\.0\.0\.1|localhost/.test(f.url)));
    T.check('staff were added and deactivated', db.users.length > 4 && db.users.some(u => !u.active));
    T.check('the exchange rate stayed inside its band', db.settings.fxRateJmdPerUsd >= 50 && db.settings.fxRateJmdPerUsd <= 1000, String(db.settings.fxRateJmdPerUsd));
    T.check('a mistyped figure never became a stored rent', !db.units.some(u => u.monthlyRent === 1.5));
    T.check('no meter ran backwards', !db.utilities.some(u => u.currentReading < u.previousReading));
    T.check('no booking ends before it starts', !db.bookings.some(b => b.checkOut <= b.checkIn));
    T.check('everything left a trail', db.auditLogs.length > 200, `${db.auditLogs.length} audit entries`);
    T.check('the final books are coherent', auditEverything(db).length === 0, auditEverything(db).slice(0, 3).join('; '));

    T.check('the server is still answering', (await c.get('/api/health')).status === 200);
    T.check('and the database still reads back cleanly', Array.isArray((await c.get('/api/db')).body.payments));

    return T.done();
  } finally {
    await srv.stop();
  }
}
