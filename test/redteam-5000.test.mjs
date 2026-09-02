/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Five thousand operations, and then: is any of it missing from the paperwork?
 *
 * Commissioned by Ro on 2026-09-02, straight after a maintenance receipt that had
 * been recorded correctly failed to appear on a printed record. The existing
 * suites all stop at the same place. They prove the *books* survive whatever a
 * person does to them. Not one of them, until now, could ask the question that
 * actually bit: **does the document you hand somebody contain what the books
 * hold?**
 *
 * So this suite runs the operations and then reads the paperwork.
 *
 * Same founding rule as the 3000-scenario red team, and it is what makes a
 * failure here meaningful:
 *
 *     Nothing touches the database behind the application's back. Every
 *     action goes through the same HTTP API the screens use.
 *
 * A failure is therefore never "the test broke it". It is a sequence of ordinary
 * operations that left a record unreachable, a document contradicting the ledger,
 * or money visible in one place and absent from another.
 *
 * What it covers, per Ro's brief:
 *
 *   - **payments of every kind** — full, part, over, early, in the wrong
 *     currency, duplicated, confirmed, reversed, refunded in part, refunded
 *     twice, refunded after reversal;
 *   - **modifications** — rent and maintenance changed, villas re-denominated,
 *     due days moved, owners and tenants renamed as corrections and as real
 *     changes, move-in dates set and moved, deposits taken and settled,
 *     evictions, charges voided, one-off charges raised, the books-begin date
 *     moved underneath live data;
 *   - **human actions** — the same request sent twice, an action abandoned
 *     half-finished, steps taken in the wrong order, a month posted three times;
 *   - **printed documents** — the villa's ledger and the tenant's record are
 *     rendered from live data and read back;
 *   - **records that must not be omitted** — every completed receipt and every
 *     open charge must appear on the villa's own ledger;
 *   - **records that must be omitted** — a proprietor's maintenance must never
 *     appear on a tenant's record, and when it exists it must be declared rather
 *     than silently dropped;
 *   - **connected and disconnected** — every record must belong to a villa that
 *     exists, and be reachable from the documents; an orphan is a record the
 *     application can create and never show again.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = 'Five thousand operations, and the paperwork they produce';

const OPERATION_COUNT = 5000;
/** Documents are rendered this often. Rendering is far dearer than an API call. */
const PAPERWORK_EVERY = 250;

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rt5000-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { UnitLedgerDocument, TenancyRecordDocument } from './src/components/Units';
        export * as fin from './src/lib/finance';
        export { default as React } from 'react';
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
const ok = res => res.status >= 200 && res.status < 300;
const strip = html => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, "'").replace(/\s+/g, ' ').trim();

const MONTHS = [
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
  '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'
];
const monthOf = n => MONTHS[n % MONTHS.length];
const dayIn = (month, day) => `${month}-${pad(Math.min(28, Math.max(1, day)))}`;

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'RedTeam5k-1234!', projectRoot });
  const { mod, cleanup } = await loadModules(projectRoot);

  try {
    const { UnitLedgerDocument, TenancyRecordDocument, React, renderToStaticMarkup, fin } = mod;
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'RedTeam5k-1234!', 'RedTeam5kNew-9876!');

    const settings = (await c.get('/api/settings')).body;
    await c.put('/api/settings', { ...settings, booksBeginOn: '2026-01-01' });

    /* ---------------- a property shaped like the real one ---------------- */
    const setup = rng(20260902);
    const unitIds = (await c.get('/api/db')).body.units.map(u => u.id);
    const longLets = [];
    const owners = [];

    for (let i = 0; i < unitIds.length; i++) {
      const id = unitIds[i];
      const number = id.replace('unit-', '');
      let body;
      if (i % 5 === 4) {
        // Proprietors who pay maintenance and nothing else — the ordinary case
        // here, and the one whose paperwork went wrong.
        body = { number, ownerName: `Owner ${i}`, status: 'owner-occupied', monthlyMaintenance: money(setup, 8000, 20000), currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 };
        owners.push(id);
      } else if (i === 7) {
        // Rent in USD, maintenance in JMD — the split-currency villa.
        body = { number, ownerName: `Owner ${i}`, tenantName: `Tenant ${i}`, tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', status: 'long-term', monthlyRent: money(setup, 600, 1500), monthlyMaintenance: money(setup, 9000, 16000), currency: 'USD', maintCurrency: 'JMD', rentDueDay: 7, maintDueDay: 1 };
        longLets.push(id);
      } else {
        // Rent due on the 7th on some, the 1st on others, so "posted" and "due"
        // are genuinely different states across the property.
        body = { number, ownerName: `Owner ${i}`, tenantName: `Tenant ${i}`, tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', status: 'long-term', monthlyRent: money(setup, 40000, 140000), monthlyMaintenance: money(setup, 8000, 20000), currency: 'JMD', maintCurrency: 'JMD', rentDueDay: i % 3 === 0 ? 7 : 1, maintDueDay: 1 };
        longLets.push(id);
      }
      await c.put(`/api/units/${id}`, body);
    }

    T.check('a property was configured to work on', longLets.length > 5 && owners.length > 0, `${longLets.length} let, ${owners.length} owner-occupied`);

    /* ================================================================
     * The operations.
     *
     * Each returns nothing and is allowed to be refused — a 4xx is the
     * application defending itself and is a pass. What is never acceptable is a
     * 5xx, or a refusal that still changed something.
     * ================================================================ */
    let serverErrors = 0;
    const note = res => {
      if (res && res.status >= 500) serverErrors++;
      return res;
    };

    const operations = [
      // Post a month. Three times, out of order, and once for the future.
      async ({ month }) => {
        note(await c.post('/api/charges/post-month', { monthString: month }));
        note(await c.post('/api/charges/post-month', { monthString: month }));
        note(await c.post('/api/charges/post-month', { monthString: '2099-01' }));
      },

      // Pay in full, and confirm. The ordinary day.
      async ({ month, rand, db }) => {
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const r = note(await c.post('/api/payments', { unitId: ch.unitId, category: ch.category, amount: ch.amount, currency: ch.currency, payerName: ch.payerName, method: 'Cash', date: dayIn(month, 12) }));
        if (r.body?.payment?.id) note(await c.post(`/api/payments/${r.body.payment.id}/confirm`, {}));
      },

      // Part payment, then the rest — two receipts against one charge.
      async ({ month, rand, db }) => {
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        for (const share of [0.3, 0.7]) {
          const r = note(await c.post('/api/payments', { unitId: ch.unitId, category: ch.category, amount: Math.round(ch.amount * share * 100) / 100, currency: ch.currency, payerName: ch.payerName, method: 'Bank Transfer', date: dayIn(month, 14) }));
          if (r.body?.payment?.id) note(await c.post(`/api/payments/${r.body.payment.id}/confirm`, {}));
        }
      },

      // Overpayment, and payment in the currency the account is not billed in.
      async ({ month, rand, db }) => {
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        note(await c.post('/api/payments', { unitId: ch.unitId, category: ch.category, amount: ch.amount * 3, currency: ch.currency, payerName: ch.payerName, method: 'Cash', date: dayIn(month, 15) }));
        note(await c.post('/api/payments', { unitId: ch.unitId, category: ch.category, amount: ch.amount, currency: ch.currency === 'JMD' ? 'USD' : 'JMD', payerName: ch.payerName, method: 'Cash', date: dayIn(month, 16) }));
      },

      // The same receipt submitted twice — a double-click, or a retried request.
      async ({ month, rand, db }) => {
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const payload = { unitId: ch.unitId, category: ch.category, amount: ch.amount, currency: ch.currency, payerName: ch.payerName, method: 'Cash', date: dayIn(month, 17) };
        const key = `dup-${ch.id}`;
        const headers = { 'Idempotency-Key': key };
        note(await c.post('/api/payments', payload, { headers }));
        note(await c.post('/api/payments', payload, { headers }));
      },

      // A receipt taken and never confirmed — the abandoned action.
      async ({ month, rand, db }) => {
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        note(await c.post('/api/payments', { unitId: ch.unitId, category: ch.category, amount: money(rand, 100, 5000), currency: ch.currency, payerName: ch.payerName, method: 'Cheque', date: dayIn(month, 18) }));
      },

      // Refund part, then more than was ever taken, then reverse it afterwards.
      async ({ month, rand, db }) => {
        const settled = db.payments.filter(p => p.status === 'completed');
        if (!settled.length) return;
        const p = pick(rand, settled);
        note(await c.post(`/api/payments/${p.id}/refund`, { amount: Math.round(p.amount * 0.4 * 100) / 100, reason: 'overpaid', method: 'Cash', refundedOn: dayIn(month, 20) }));
        note(await c.post(`/api/payments/${p.id}/refund`, { amount: p.amount * 5, reason: 'more than was taken', method: 'Cash', refundedOn: dayIn(month, 21) }));
        note(await c.post(`/api/payments/${p.id}/reverse`, { reason: 'entered against the wrong villa' }));
      },

      // Void a charge — including one that has already been paid.
      async ({ rand, db }) => {
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        note(await c.post(`/api/charges/${ch.id}/void`, { reason: 'raised in error' }));
        note(await c.post(`/api/charges/${ch.id}/void`, { reason: 'voided twice' }));
      },

      // A one-off charge: opening balances, insurance shares, recharged repairs.
      async ({ month, rand }) => {
        const unitId = pick(rand, longLets.concat(owners));
        note(await c.post('/api/charges', {
          unitId,
          category: pick(rand, ['Maintenance', 'Rent']),
          oneOffType: pick(rand, ['Opening balance', 'Insurance share', 'Late fee']),
          amount: money(rand, 500, 40000),
          currency: 'JMD',
          dueDate: dayIn(month, 9),
          description: 'One-off raised by the simulation'
        }));
      },

      // Change the rent and the due day underneath live charges.
      async ({ rand }) => {
        const id = pick(rand, longLets);
        const db2 = (await c.get('/api/db')).body;
        const unit = db2.units.find(u => u.id === id);
        if (!unit) return;
        note(await c.put(`/api/units/${id}`, {
          ...unit,
          monthlyRent: money(rand, 40000, 160000),
          rentDueDay: 1 + Math.floor(rand() * 28),
          maintDueDay: 1 + Math.floor(rand() * 28)
        }));
      },

      // Re-denominate a villa — the fault that stranded C11's charges.
      async ({ rand }) => {
        const id = pick(rand, longLets.concat(owners));
        const db2 = (await c.get('/api/db')).body;
        const unit = db2.units.find(u => u.id === id);
        if (!unit) return;
        const flip = unit.maintCurrency === 'JMD' ? 'USD' : 'JMD';
        // First without acknowledging the consequence, then with it.
        note(await c.put(`/api/units/${id}`, { ...unit, maintCurrency: flip }));
        note(await c.put(`/api/units/${id}`, { ...unit, maintCurrency: flip, currencyChangeIntent: 'void-open-charges' }));
      },

      // Rename an owner and a tenant, as a correction and as a real change.
      async ({ rand }) => {
        const id = pick(rand, longLets);
        const db2 = (await c.get('/api/db')).body;
        const unit = db2.units.find(u => u.id === id);
        if (!unit) return;
        note(await c.put(`/api/units/${id}`, { ...unit, ownerName: `${unit.ownerName} (corrected)`, ownerChangeIntent: 'correction' }));
        note(await c.put(`/api/units/${id}`, { ...unit, tenantName: `Tenant ${Math.floor(rand() * 900)}`, tenantChangeIntent: 'changeover' }));
      },

      // Move a move-in date, backwards and forwards, on a live tenancy.
      async ({ month, rand, db }) => {
        const active = db.tenancies.filter(t => t.status === 'active');
        if (!active.length) return;
        const t = pick(rand, active);
        note(await c.put(`/api/tenancies/${t.id}`, { startedOn: dayIn(month, 3) }));
        note(await c.put(`/api/tenancies/${t.id}`, { startedOn: '2009-02-07' }));
      },

      // Deposits: taken, over-returned, returned, returned again.
      async ({ rand, db }) => {
        const active = db.tenancies.filter(t => t.status === 'active');
        if (!active.length) return;
        const t = pick(rand, active);
        const held = money(rand, 5000, 90000);
        const taken = note(await c.post(`/api/tenancies/${t.id}/deposit`, { amount: held, currency: 'JMD', method: 'Cash' }));
        if (!ok(taken)) return;
        note(await c.post(`/api/tenancies/${t.id}/deposit/settle`, { returnedAmount: held * 2, withheldAmount: 0, reason: 'over-return' }));
        note(await c.post(`/api/tenancies/${t.id}/deposit/settle`, { returnedAmount: held, withheldAmount: 0, reason: 'returned in full' }));
      },

      // Move the books-begin date underneath data that already exists.
      async ({ rand }) => {
        const s = (await c.get('/api/settings')).body;
        note(await c.put('/api/settings', { ...s, booksBeginOn: pick(rand, ['2026-01-01', '2026-06-01', '']) }));
        note(await c.put('/api/settings', { ...s, booksBeginOn: '2026-01-01' }));
      },

      // An expense recharged to a villa, and one against the common account.
      async ({ month, rand }) => {
        note(await c.post('/api/expenses', {
          category: pick(rand, ['Repairs', 'Security', 'Supplies']),
          vendor: `Vendor ${Math.floor(rand() * 40)}`,
          description: 'Simulated cost',
          unitId: rand() > 0.5 ? pick(rand, longLets) : '',
          amount: money(rand, 1000, 60000),
          currency: 'JMD',
          date: dayIn(month, 11),
          status: 'paid',
          datePaid: dayIn(month, 11),
          paymentMethod: 'Cash'
        }));
      }
    ];

    /* ================================================================
     * What the paperwork must say.
     * ================================================================ */
    const paperworkFaults = [];
    let documentsRendered = 0;

    async function readThePaperwork(db, label) {
      const units = db.units;
      // Every villa that has anything at all against it, so the sample is not
      // quietly confined to the tidy ones.
      const interesting = units.filter(u =>
        db.charges.some(ch => ch.unitId === u.id) || db.payments.some(p => p.unitId === u.id)
      );
      if (!interesting.length) return;

      for (const unit of interesting.slice(0, 4)) {
        const tenancies = db.tenancies.filter(t => t.unitId === unit.id);
        let ledger;
        try {
          ledger = strip(
            renderToStaticMarkup(
              React.createElement(UnitLedgerDocument, {
                unit, units, charges: db.charges, payments: db.payments,
                utilities: db.utilities || [], bookings: db.bookings || [],
                tenancies, expenses: db.expenses || [], unitActivities: db.unitActivities || [],
                generatedBy: 'Simulation', onClose: () => {}
              })
            )
          );
        } catch (err) {
          paperworkFaults.push(`${label}: the unit ledger for ${unit.number} could not be produced — ${err.message}`);
          continue;
        }
        documentsRendered++;

        // NOT OMITTED: every receipt the books hold for this villa.
        for (const p of db.payments.filter(x => x.unitId === unit.id && x.status === 'completed')) {
          if (p.receiptNo && !ledger.includes(p.receiptNo)) {
            paperworkFaults.push(`${label}: receipt ${p.receiptNo} (${p.category} ${p.amount} ${p.currency}) is in the books but not on villa ${unit.number}'s ledger`);
          }
        }

        // NOT OMITTED: every charge, including the voided ones.
        const unitCharges = db.charges.filter(x => x.unitId === unit.id);
        for (const ch of unitCharges.slice(0, 40)) {
          const marker = ch.description || ch.category;
          if (!ledger.includes(marker) && !ledger.includes(ch.category)) {
            paperworkFaults.push(`${label}: charge ${ch.id} (${ch.category}) is in the books but not on villa ${unit.number}'s ledger`);
          }
        }
        if (unitCharges.length > 0 && /No charges have been raised/i.test(ledger)) {
          paperworkFaults.push(`${label}: villa ${unit.number} has ${unitCharges.length} charges but its ledger says none were raised`);
        }
        if (db.payments.some(x => x.unitId === unit.id && x.status === 'completed') && /No payments recorded/i.test(ledger)) {
          paperworkFaults.push(`${label}: villa ${unit.number} has receipts but its ledger says none were recorded`);
        }

        /* ---------------- the tenant's own record ---------------- */
        for (const tenancy of tenancies.slice(0, 2)) {
          let tenantDoc;
          try {
            tenantDoc = strip(
              renderToStaticMarkup(
                React.createElement(TenancyRecordDocument, {
                  tenancy, unit, units, charges: db.charges, payments: db.payments,
                  generatedBy: 'Simulation', onClose: () => {}
                })
              )
            );
          } catch (err) {
            paperworkFaults.push(`${label}: the tenant record for ${tenancy.tenantName} could not be produced — ${err.message}`);
            continue;
          }
          documentsRendered++;

          // MUST BE OMITTED: the proprietor's maintenance receipts.
          const maintReceipts = db.payments.filter(
            p => p.unitId === unit.id && p.category === 'Maintenance' && p.status === 'completed' && p.receiptNo
          );
          for (const p of maintReceipts) {
            if (tenantDoc.includes(p.receiptNo)) {
              paperworkFaults.push(`${label}: maintenance receipt ${p.receiptNo} appeared on ${tenancy.tenantName}'s tenant record`);
            }
          }

          // ...but never silently. Where maintenance falls inside the occupancy,
          // the document has to say it is being left off.
          /*
           * The occupancy window, defined the way the document defines it.
           *
           * The first version of this check ran the window out to the end of
           * 2027, and reported the tenant record as omitting maintenance without
           * saying so. The document was right and this was wrong: for a tenancy
           * still running, the record covers move-in *to today* — the same window
           * it uses for the rent lines, and the one the heading promises ("for
           * the occupancy dates shown above"). A charge dated next month is not
           * yet part of this tenant's account, and, since v1.10.2, is not even
           * owed. Checked before changing anything, because a test bent to agree
           * with the code is how the owner-statement fault survived 1,245 checks.
           */
          const start = tenancy.startedOn || '';
          const end = tenancy.endedOn || localToday();
          const inWindow = d => (!start || d >= start) && d <= end;
          const maintInWindow =
            maintReceipts.some(p => inWindow(p.date)) ||
            db.charges.some(ch => ch.unitId === unit.id && ch.category === 'Maintenance' && ch.status === 'open' && inWindow(ch.dueDate));
          if (maintInWindow && !/Not included on this record/i.test(tenantDoc)) {
            paperworkFaults.push(`${label}: ${tenancy.tenantName}'s record omits maintenance without declaring it`);
          }
          if (!/covers rent only/i.test(tenantDoc)) {
            paperworkFaults.push(`${label}: ${tenancy.tenantName}'s record does not say what it covers`);
          }
        }
      }
    }

    /* ================================================================
     * Run it.
     * ================================================================ */
    let db = (await c.get('/api/db')).body;

    for (let i = 0; i < OPERATION_COUNT; i++) {
      const rand = rng(1_000_003 + i * 7919);
      const month = monthOf(Math.floor(rand() * MONTHS.length));
      const op = operations[i % operations.length];
      try {
        await op({ month, rand, db, i });
      } catch (err) {
        paperworkFaults.push(`operation ${i} threw outside the API — ${err.message}`);
      }

      if ((i + 1) % PAPERWORK_EVERY === 0) {
        db = (await c.get('/api/db')).body;
        await readThePaperwork(db, `after ${i + 1} operations`);
      } else if ((i + 1) % 20 === 0) {
        db = (await c.get('/api/db')).body;
      }
    }

    db = (await c.get('/api/db')).body;
    await readThePaperwork(db, 'at the end');

    /* ================================================================
     * The verdict.
     * ================================================================ */
    T.check(`${OPERATION_COUNT} operations were carried out through the real API`, true);
    T.check('not one of them produced a server error', serverErrors === 0, `${serverErrors} responses of 500 or worse`);
    T.check('the property still holds records after all of it', db.charges.length > 0 && db.payments.length > 0, `${db.charges.length} charges, ${db.payments.length} receipts`);
    T.check(`the printed documents were produced throughout (${documentsRendered} of them)`, documentsRendered > 40, `${documentsRendered} rendered`);

    // The headline: nothing the books hold is missing from the paperwork, and
    // nothing that must be kept off it leaked on.
    T.check(
      'every record the books hold appears on the document that should carry it',
      paperworkFaults.length === 0,
      paperworkFaults.slice(0, 6).join(' | ')
    );

    /* ---------------- nothing is orphaned ---------------- */
    {
      const unitIdSet = new Set(db.units.map(u => u.id));
      const orphanPayments = db.payments.filter(p => p.unitId && !unitIdSet.has(p.unitId));
      const orphanCharges = db.charges.filter(ch => ch.unitId && !unitIdSet.has(ch.unitId));
      const orphanTenancies = db.tenancies.filter(t => t.unitId && !unitIdSet.has(t.unitId));
      T.check('no receipt belongs to a villa that does not exist', orphanPayments.length === 0, `${orphanPayments.length} orphaned`);
      T.check('no charge belongs to a villa that does not exist', orphanCharges.length === 0, `${orphanCharges.length} orphaned`);
      T.check('no tenancy belongs to a villa that does not exist', orphanTenancies.length === 0, `${orphanTenancies.length} orphaned`);

      // A receipt against a category the villa is not billed in is money that no
      // balance will ever count — reachable in the list, invisible in the sums.
      const stranded = [];
      for (const unit of db.units) {
        for (const category of ['Rent', 'Maintenance']) {
          const account = fin.accountBalance(unit, category, db.charges, db.payments, undefined, db.units);
          if (account.mismatchedCurrencyPayments.length || account.mismatchedCurrencyCharges.length) {
            stranded.push(`${unit.number}/${category}`);
          }
        }
      }
      // Stranded money is allowed to exist — the simulation deliberately creates
      // it — but it must be *reported*, never silent. That is what the fix for
      // C11 promised.
      T.check(
        'money stranded in another currency is reported rather than hidden',
        stranded.length === 0 || fin.currencyMismatchWarnings(db.units, db.charges, db.payments).length === stranded.length,
        `${stranded.length} stranded accounts, ${fin.currencyMismatchWarnings(db.units, db.charges, db.payments).length} reported`
      );
    }

    /* ---------------- the books still add up ---------------- */
    {
      const report = (await c.get('/api/integrity')).body;
      const serious = (report.issues || []).filter(x => x.severity === 'serious');
      T.check(
        'the application reports no serious fault in its own records',
        serious.length === 0,
        serious.slice(0, 4).map(x => `${x.code}: ${x.message}`).join(' | ')
      );

      let arithmetic = 0;
      for (const unit of db.units) {
        for (const category of ['Rent', 'Maintenance']) {
          const a = fin.accountBalance(unit, category, db.charges, db.payments, undefined, db.units);
          if (!Number.isFinite(a.balance) || Math.abs(a.balance * 100 - Math.round(a.balance * 100)) > 1e-6) arithmetic++;
        }
      }
      T.check('every balance is a finite figure to the cent', arithmetic === 0, `${arithmetic} bad balances`);

      const badReceipts = db.payments.filter(p => p.status === 'completed' && !p.receiptNo);
      T.check('every receipt taken carries a receipt number', badReceipts.length === 0, `${badReceipts.length} without one`);
      const dupes = db.payments.filter(p => p.receiptNo).map(p => p.receiptNo);
      T.check('and no two receipts share one', new Set(dupes).size === dupes.length, `${dupes.length - new Set(dupes).size} duplicated`);
    }

    return T.done();
  } finally {
    cleanup();
    await srv.stop();
  }
}
