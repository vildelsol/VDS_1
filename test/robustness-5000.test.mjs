/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Five thousand operations with the billing running itself.
 *
 * Ro, 2026-11-18: *"run integrity and accuracy, robustness tests against the
 * changes and the entire robustness of the entire software, not just the fixes
 * you just implemented."*
 *
 * Every other suite runs with automatic billing switched off, so that a test's
 * own fixtures are the only thing that raises a charge. This one is the opposite
 * and is the only place the shipped default is put under load: the application
 * bills for itself, at startup and on a one-minute tick, **while** five thousand
 * ordinary and hostile operations are going through the same books — payments in
 * the wrong currency, refunds beyond the receipt, villas re-denominated, fees
 * changed underneath live charges, move-in dates dragged backwards, the
 * books-begin date moved, periods closed and reopened, and the server stopped and
 * restarted twice in the middle of it.
 *
 * The founding rule is the one the other red teams use, and it is what makes a
 * failure here mean something:
 *
 *     Nothing touches db.json behind the application's back. Every action goes
 *     through the same HTTP API the screens use.
 *
 * So a failure is never "the test broke it". It is a sequence of ordinary
 * operations that left the books contradicting themselves.
 *
 * The invariants, checked every 250 operations and again at the end:
 *
 *   1. No request anywhere produces a server error.
 *   2. Every charge and every receipt belongs to a villa that exists.
 *   3. No account carries the same ordinary month twice — the fault automatic
 *      billing could cause and a person could not.
 *   4. A rent charge's parts add up to the charge.
 *   5. Nothing is billed or received for a month that has not happened.
 *   6. Receipt numbers are unique, and nothing is refunded beyond its worth.
 *   7. The balance the application shows equals the balance rebuilt from the raw
 *      ledger, per villa, per category, per currency.
 *   8. The integrity engine finds nothing serious that it did not find at the
 *      start, the audit chain included.
 *   9. Stopping and restarting changes nothing that was already settled.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday, resetOutcomes, checkMoneyEndpointsSucceeded } from './harness.mjs';

export const title = 'Five thousand operations while the billing runs itself';

/**
 * Five thousand in the suite. `VDS_RB_OPS` shortens it only so that a positive
 * control can be run cheaply — breaking the server on purpose and watching these
 * invariants fail. A suite that has never been seen to fail proves nothing.
 */
const OPERATION_COUNT = Math.max(50, Number(process.env.VDS_RB_OPS) || 5000);
const CHECK_EVERY = Math.max(10, Math.floor(OPERATION_COUNT / 20));
const PASS = 'Str0ng-Pass!2026';
const TODAY = localToday();
const THIS_MONTH = TODAY.slice(0, 7);

/** Deterministic: a failure here can be replayed exactly. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];
const money = (rand, lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
const cents = x => Math.round((Number(x) || 0) * 100);

function monthBack(back) {
  const [y, m] = TODAY.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const dayIn = (month, day) => `${month}-${String(Math.min(day, 28)).padStart(2, '0')}`;

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rb5000-'));
  const outfile = path.join(dir, 'fin.mjs');
  await build({
    stdin: { contents: `export * as fin from './src/lib/finance';`, resolveDir: projectRoot, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { fin: mod.fin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { fin, cleanup } = await loadFinance(projectRoot);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rb-data-'));
  const serverErrors = [];
    /*
   * A one-minute tick, not the hour the application really uses, and the floor
   * the runner enforces. The point is not the interval: it is that the automatic
   * run and a person's writes are repeatedly in flight against the same books
   * over the course of the run, rather than once at startup.
   */
  const autoEnv = { VDS_AUTO_POST: 'on', VDS_AUTO_POST_MS: '60000' };
  let server = null;
  let c = null;
  /*
   * The run stops and starts the server twice, and each child keeps only its own
   * log — so a 500 raised before a restart left nothing behind but "an
   * unexpected server error". Kept across restarts, with the request that caused
   * it, because that is what makes the failure fixable.
   */
  let serverLog = '';
  let lastCall = '';

  /** Every response is watched: a 5xx anywhere is a defect regardless of what was asked. */
  const note = r => {
    if (r && r.status >= 500) serverErrors.push(`${r.status} on ${lastCall} ${JSON.stringify(r.body).slice(0, 120)}`);
    return r;
  };

  /** Remember the request being made, so a 500 can name it. */
  const watch = client => {
    for (const verb of ['get', 'post', 'put', 'delete']) {
      if (typeof client[verb] !== 'function') continue;
      const original = client[verb].bind(client);
      client[verb] = (apiPath, body, opts) => {
        lastCall = `${verb.toUpperCase()} ${apiPath} ${body ? JSON.stringify(body).slice(0, 200) : ''}`;
        return original(apiPath, body, opts);
      };
    }
    return client;
  };
  const ok = r => r && r.status >= 200 && r.status < 300;

  async function connect(first = false) {
    if (server) serverLog += server.getLog() || '';
    server = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir, env: autoEnv });
    c = watch(makeClient(server.baseUrl));
    if (first) await activateAdmin(c, 'admin123', PASS);
    else await c.post('/api/auth/login', { username: 'admin', password: PASS }, { captureCookie: true });
  }

  try {
    resetOutcomes();
    await connect(true);

    /* ---- a property worth billing ---------------------------------- */
    const longLets = ['unit-1', 'unit-2', 'unit-4', 'unit-6', 'unit-7'];
    const owners = ['unit-3', 'unit-5', 'unit-8'];
    for (const id of longLets) {
      note(
        await c.put(`/api/units/${id}`, {
          number: id.replace('unit-', ''),
          ownerName: `Owner ${id}`,
          tenantName: `Tenant ${id}`,
          status: 'long-term',
          monthlyRent: id === 'unit-2' ? 1200 : 75000,
          monthlyMaintenance: id === 'unit-2' ? 125 : 20000,
          currency: id === 'unit-2' ? 'USD' : 'JMD',
          maintCurrency: id === 'unit-2' ? 'USD' : 'JMD',
          rentDueDay: 1,
          maintDueDay: 1
        })
      );
    }
    for (const id of owners) {
      note(
        await c.put(`/api/units/${id}`, {
          number: id.replace('unit-', ''),
          ownerName: `Owner ${id}`,
          status: 'owner-occupied',
          monthlyMaintenance: 20000,
          currency: 'JMD',
          maintCurrency: 'JMD',
          maintDueDay: 1
        })
      );
    }
    const settings = (await c.get('/api/db')).body.settings;
    note(await c.post('/api/settings', { ...settings, booksBeginOn: `${monthBack(3)}-01` }));

    const baseline = (await c.get('/api/integrity')).body;
    const baselineSerious = new Set((baseline.findings || []).filter(f => f.severity === 'serious').map(f => f.code));
    T.check('the property starts with no serious contradiction in its records', baselineSerious.size === 0, [...baselineSerious].join(','));

    /* ================================================================ *
     * The invariants
     * ================================================================ */
    const breaches = new Map();
    const breach = (name, detail) => {
      if (!breaches.has(name)) breaches.set(name, detail);
    };

    async function assertInvariants(at) {
      const db = (await c.get('/api/db')).body;
      const unitIds = new Set(db.units.map(u => u.id));

      for (const ch of db.charges) {
        if (!unitIds.has(ch.unitId)) breach('orphan-charge', `${at}: charge ${ch.id} belongs to no villa`);
        if (ch.status === 'open' && ch.periodMonth > THIS_MONTH) breach('future-charge', `${at}: ${ch.id} billed ${ch.periodMonth}`);
        if (ch.rentPortion !== undefined && ch.maintenancePortion !== undefined) {
          if (cents(ch.rentPortion) + cents(ch.maintenancePortion) !== cents(ch.amount)) {
            breach('split-does-not-add-up', `${at}: ${ch.id} ${ch.rentPortion}+${ch.maintenancePortion}!=${ch.amount}`);
          }
        }
      }

      const seen = new Map();
      for (const ch of db.charges) {
        if (ch.status !== 'open' || ch.kind || ch.oneOffType) continue;
        const key = `${ch.unitId}|${ch.category}|${ch.periodMonth}`;
        if (seen.has(key)) breach('month-billed-twice', `${at}: ${key} as ${seen.get(key)} and ${ch.id}`);
        else seen.set(key, ch.id);
      }

      const receipts = new Map();
      for (const p of db.payments) {
        if (!unitIds.has(p.unitId)) breach('orphan-receipt', `${at}: receipt ${p.id} belongs to no villa`);
        if (p.status === 'completed' && p.date > TODAY) breach('future-receipt', `${at}: ${p.id} dated ${p.date}`);
        if (cents(p.refundedAmount || 0) > cents(p.amount)) breach('over-refunded', `${at}: ${p.id} refunded ${p.refundedAmount} of ${p.amount}`);
        if (p.receiptNo) {
          if (receipts.has(p.receiptNo)) breach('duplicate-receipt', `${at}: ${p.receiptNo} on ${receipts.get(p.receiptNo)} and ${p.id}`);
          else receipts.set(p.receiptNo, p.id);
        }
      }

      // The figure the application shows, against the figure rebuilt from the raw rows.
      const settled = db.payments.concat(fin.settledFromRent(db.charges, db.payments));
      for (const unit of db.units) {
        for (const category of ['Rent', 'Maintenance']) {
          const currency = fin.chargeCurrency(unit, category);
          const shown = fin.accountBalance(unit, category, db.charges, settled, undefined, db.units).balance;
          const owed = db.charges
            .filter(x => x.unitId === unit.id && x.category === category && x.status === 'open' && x.currency === currency)
            .reduce((a, x) => a + cents(x.amount), 0);
          const paid = settled
            .filter(x => x.unitId === unit.id && x.category === category && x.status === 'completed' && x.currency === currency)
            .reduce((a, x) => a + cents(x.amount) - cents(x.refundedAmount || 0), 0);
          if (cents(shown) !== owed - paid) {
            breach('balance-does-not-reconcile', `${at}: ${unit.number}/${category} shown ${shown}, ledger ${(owed - paid) / 100}`);
          }
        }
      }

      const report = (await c.get('/api/integrity')).body;
      for (const f of report.findings || []) {
        if (f.severity === 'serious' && !baselineSerious.has(f.code)) breach(`integrity:${f.code}`, `${at}: ${f.message}`);
      }
    }

    /* ================================================================ *
     * The operations
     * ================================================================ */
    const months = [monthBack(3), monthBack(2), monthBack(1), monthBack(0)];

    const operations = [
      // Post a month by hand, including one automatic billing has already raised.
      async ({ rand }) => {
        note(await c.post('/api/charges/post-month', { monthString: pick(rand, months) }));
      },

      // Pay a charge: in full, in part, over, early, in the wrong currency.
      async ({ rand, db }) => {
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const shape = rand();
        const amount =
          shape < 0.4 ? ch.amount : shape < 0.7 ? Math.round(ch.amount * 0.45 * 100) / 100 : shape < 0.85 ? ch.amount * 2 : money(rand, 100, 5000);
        const r = note(
          await c.post('/api/payments', {
            unitId: ch.unitId,
            category: ch.category,
            amount,
            currency: shape > 0.93 ? (ch.currency === 'JMD' ? 'USD' : 'JMD') : ch.currency,
            payerName: ch.payerName || 'Payer',
            method: pick(rand, ['Cash', 'Bank Transfer', 'Cheque']),
            date: dayIn(ch.periodMonth || THIS_MONTH, 1 + Math.floor(rand() * 27))
          })
        );
        const id = r?.body?.payment?.id;
        if (id && rand() > 0.2) note(await c.post(`/api/payments/${id}/confirm`, {}));
      },

      // Refund, refund again, refund beyond the receipt, then reverse it.
      async ({ rand, db }) => {
        const done = db.payments.filter(p => p.status === 'completed');
        if (!done.length) return;
        const p = pick(rand, done);
        note(await c.post(`/api/payments/${p.id}/refund`, { amount: Math.round(p.amount * 0.3 * 100) / 100, reason: 'part refund', method: 'Cash', refundedOn: TODAY }));
        if (rand() > 0.6) note(await c.post(`/api/payments/${p.id}/refund`, { amount: p.amount * 4, reason: 'beyond its worth', method: 'Cash', refundedOn: TODAY }));
        if (rand() > 0.8) note(await c.post(`/api/payments/${p.id}/reverse`, { reversalReason: 'entered against the wrong villa' }));
      },

      // Void a charge, including one already paid, and void it twice.
      async ({ rand, db }) => {
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        note(await c.post(`/api/charges/${ch.id}/void`, { reason: 'raised in error' }));
        if (rand() > 0.7) note(await c.post(`/api/charges/${ch.id}/void`, { reason: 'voided twice' }));
      },

      // A one-off in a month the recurring run also bills.
      async ({ rand }) => {
        const unitId = pick(rand, longLets.concat(owners));
        note(
          await c.post('/api/charges', {
            unitId,
            category: owners.includes(unitId) ? 'Maintenance' : pick(rand, ['Maintenance', 'Rent']),
            oneOffType: pick(rand, ['Opening balance', 'Insurance share', 'Late fee']),
            amount: money(rand, 500, 40000),
            currency: 'JMD',
            dueDate: dayIn(pick(rand, months), 9),
            description: 'One-off raised by the simulation'
          })
        );
      },

      // Change the fee and the due days underneath live charges.
      async ({ rand }) => {
        const id = pick(rand, longLets.concat(owners));
        const unit = (await c.get('/api/db')).body.units.find(u => u.id === id);
        if (!unit) return;
        note(
          await c.put(`/api/units/${id}`, {
            ...unit,
            monthlyRent: unit.status === 'long-term' ? money(rand, 40000, 160000) : unit.monthlyRent,
            monthlyMaintenance: money(rand, 5000, 40000),
            rentDueDay: 1 + Math.floor(rand() * 28),
            maintDueDay: 1 + Math.floor(rand() * 28)
          })
        );
      },

      // Take a villa out of service and put it back — it must stop and start being levied.
      async ({ rand }) => {
        const id = pick(rand, owners);
        const unit = (await c.get('/api/db')).body.units.find(u => u.id === id);
        if (!unit) return;
        note(await c.put(`/api/units/${id}`, { ...unit, status: 'unavailable' }));
        if (rand() > 0.3) note(await c.put(`/api/units/${id}`, { ...unit, status: 'owner-occupied' }));
      },

      // Re-denominate a villa, with and without acknowledging the consequence.
      async ({ rand }) => {
        const id = pick(rand, longLets.concat(owners));
        const unit = (await c.get('/api/db')).body.units.find(u => u.id === id);
        if (!unit) return;
        const flip = unit.maintCurrency === 'JMD' ? 'USD' : 'JMD';
        note(await c.put(`/api/units/${id}`, { ...unit, maintCurrency: flip }));
        if (rand() > 0.5) note(await c.put(`/api/units/${id}`, { ...unit, maintCurrency: flip, currencyChangeIntent: 'void-open-charges' }));
      },

      // Owners and tenants renamed, as corrections and as real changes.
      async ({ rand }) => {
        const id = pick(rand, longLets);
        const unit = (await c.get('/api/db')).body.units.find(u => u.id === id);
        if (!unit) return;
        if (rand() > 0.5) note(await c.put(`/api/units/${id}`, { ...unit, ownerName: `${unit.ownerName} (corrected)`, ownerChangeIntent: 'correction' }));
        else note(await c.put(`/api/units/${id}`, { ...unit, tenantName: `Tenant ${Math.floor(rand() * 900)}`, tenantChangeIntent: 'changeover' }));
      },

      // Drag a move-in date about underneath a live tenancy.
      async ({ rand, db }) => {
        const active = (db.tenancies || []).filter(t => t.status === 'active');
        if (!active.length) return;
        const t = pick(rand, active);
        note(await c.put(`/api/tenancies/${t.id}`, { startedOn: dayIn(pick(rand, months), 3) }));
      },

      // Move the books-begin date underneath data that already exists.
      async ({ rand }) => {
        const s = (await c.get('/api/db')).body.settings;
        note(await c.post('/api/settings', { ...s, booksBeginOn: pick(rand, [`${monthBack(3)}-01`, `${monthBack(2)}-01`, '']) }));
      },

      // Close a period and reopen it, while the billing is trying to fill it.
      async ({ rand }) => {
        const s = (await c.get('/api/db')).body.settings;
        note(await c.post('/api/settings', { ...s, closedThrough: pick(rand, [monthBack(3), monthBack(2), '']) }));
      },

      // Costs, against a villa and against the common account.
      async ({ rand }) => {
        note(
          await c.post('/api/expenses', {
            category: pick(rand, ['Repairs', 'Security', 'Supplies']),
            vendor: `Vendor ${Math.floor(rand() * 40)}`,
            description: 'Simulated cost',
            unitId: rand() > 0.5 ? pick(rand, longLets) : '',
            amount: money(rand, 1000, 60000),
            currency: 'JMD',
            date: dayIn(pick(rand, months), 11),
            status: 'paid',
            datePaid: dayIn(pick(rand, months), 11),
            paymentMethod: 'Cash'
          })
        );
      },

      // A short stay with a deposit, which becomes a receipt on its own.
      async ({ rand }) => {
        const unitId = pick(rand, longLets.concat(owners));
        const start = 40 + Math.floor(rand() * 300);
        const checkIn = new Date(Date.now() + start * 86400000).toISOString().slice(0, 10);
        const checkOut = new Date(Date.now() + (start + 3) * 86400000).toISOString().slice(0, 10);
        note(
          await c.post('/api/bookings', {
            unitId,
            guestName: `Guest ${Math.floor(rand() * 900)}`,
            checkIn,
            checkOut,
            nightlyRate: money(rand, 80, 400),
            currency: 'USD',
            status: 'confirmed',
            depositPaid: money(rand, 50, 300),
            depositMethod: pick(rand, ['Cash', 'Bank Transfer', 'Credit Card'])
          })
        );
      }
    ];

    /* ================================================================ *
     * Run them
     * ================================================================ */
    const rand = rng(20261118);
    let performed = 0;
    const restartsAt = new Set([Math.floor(OPERATION_COUNT / 3), Math.floor((OPERATION_COUNT * 2) / 3)]);
    let restarts = 0;
    let settledBeforeRestart = null;

    for (let i = 1; i <= OPERATION_COUNT; i++) {
      const db = (await c.get('/api/db')).body;
      const op = pick(rand, operations);
      try {
        await op({ rand, db, month: pick(rand, months) });
        performed++;
      } catch (err) {
        breach('operation-threw', `op ${i}: ${err instanceof Error ? err.message : err}`);
      }

      if (restartsAt.has(i)) {
        const before = (await c.get('/api/db')).body;
        settledBeforeRestart = before.payments.filter(p => p.status === 'completed').map(p => `${p.id}|${p.receiptNo}|${p.amount}`).sort();
        await server.stop();
        await connect();
        const after = (await c.get('/api/db')).body;
        const settledAfter = after.payments.filter(p => p.status === 'completed').map(p => `${p.id}|${p.receiptNo}|${p.amount}`).sort();
        T.check(
          `restart ${++restarts}: every settled receipt survived being switched off and on`,
          settledAfter.join('\n') === settledBeforeRestart.join('\n'),
          `${settledBeforeRestart.length} before, ${settledAfter.length} after`
        );
        await assertInvariants(`after restart ${restarts}`);
      }

      if (i % CHECK_EVERY === 0) await assertInvariants(`operation ${i}`);
    }

    await assertInvariants('the end');

    /* ================================================================ *
     * The verdict
     * ================================================================ */
    T.check(`${OPERATION_COUNT} operations were performed`, performed === OPERATION_COUNT, `${performed} of ${OPERATION_COUNT}`);
    /*
     * A 500 is a defect whatever was asked for, and "an unexpected server error"
     * tells nobody which line threw. The server's own log goes in the failure
     * detail so the next person has the stack rather than the apology.
     */
    const everyLog = serverLog + (server.getLog() || '');
    const lines = everyLog.split('\n');
    const firstUnhandled = lines.findIndex(l => l.includes('[vds] unhandled error'));
    const stack =
      serverErrors.length > 0
        ? ` || ${firstUnhandled >= 0 ? lines.slice(firstUnhandled, firstUnhandled + 10).join(' ~ ') : 'no [vds] unhandled error in any server log'}`
        : '';
    T.check('not one of them produced a server error', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | ') + stack);

    const invariants = [
      ['no charge or receipt was left belonging to a villa that does not exist', ['orphan-charge', 'orphan-receipt']],
      ['no account was billed for the same month twice', ['month-billed-twice']],
      ["every rent charge's parts still add up to the charge", ['split-does-not-add-up']],
      ['nothing was billed or received for a month that has not happened', ['future-charge', 'future-receipt']],
      ['no receipt number was issued twice, and nothing was refunded beyond its worth', ['duplicate-receipt', 'over-refunded']],
      ['the balance the application shows equals the balance rebuilt from the ledger', ['balance-does-not-reconcile']],
      ['no operation threw', ['operation-threw']]
    ];
    for (const [desc, codes] of invariants) {
      const hit = codes.filter(k => breaches.has(k));
      T.check(desc, hit.length === 0, hit.map(k => breaches.get(k)).join(' | '));
    }

    const introduced = [...breaches.keys()].filter(k => k.startsWith('integrity:'));
    T.check(
      'the integrity engine found nothing serious that it did not find at the start',
      introduced.length === 0,
      introduced.map(k => breaches.get(k)).join(' | ')
    );

    /*
     * Automatic billing spends most of this run with nothing to do, because the
     * simulation keeps posting months by hand — which is the correct outcome, not
     * a failure. So prove it still works on books this battered by giving it one
     * thing that only it can do: put a villa back into service with a levy, and
     * touch nothing else.
     */
    const waking = (await c.get('/api/db')).body.units.find(u => u.id === 'unit-9');
    note(
      await c.put('/api/units/unit-9', {
        ...waking,
        number: '9',
        ownerName: 'Owner Nine',
        status: 'owner-occupied',
        monthlyMaintenance: 20000,
        currency: 'JMD',
        maintCurrency: 'JMD',
        maintDueDay: 1
      })
    );
    /*
     * The runner floors its interval at a minute whatever the environment asks
     * for, so a villa put into service now is billed on the next whole tick.
     * Waiting it out is slow and is the point: this is the real timer, not a
     * stubbed one.
     */
    let raisedOnItsOwn = [];
    for (let wait = 0; wait < 80 && raisedOnItsOwn.length === 0; wait++) {
      await new Promise(r => setTimeout(r, 1000));
      raisedOnItsOwn = (await c.get('/api/db')).body.charges.filter(x => x.unitId === 'unit-9' && x.createdBy === 'System');
    }
    T.check(
      'a villa put back into service is billed by the application itself, on books this battered',
      raisedOnItsOwn.length > 0 && raisedOnItsOwn.every(x => x.periodMonth === THIS_MONTH),
      raisedOnItsOwn.map(x => `${x.periodMonth}/${x.createdBy}`).join(',') || 'nothing was raised'
    );

    const finalDb = (await c.get('/api/db')).body;
    const auto = (finalDb.auditLogs || []).filter(a => /\(automatically\)/.test(a.action || ''));
    T.check(
      'everything it raised is attributed to System, never to a member of staff',
      auto.length > 0 && auto.every(a => a.user === 'System') && finalDb.charges.filter(x => x.createdBy === 'System').every(x => x.periodMonth <= THIS_MONTH),
      `${auto.length} automatic runs logged`
    );
    await assertInvariants('after the application billed on its own');
    T.check('the books are big enough for the result to mean something', finalDb.charges.length > 50 && finalDb.payments.length > 50, `${finalDb.charges.length} charges, ${finalDb.payments.length} receipts`);

    checkMoneyEndpointsSucceeded(T, 'robustness');
  } finally {
    if (server) await server.stop();
    cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return T.done();
}
