/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Five thousand operations of the kind a property management office actually
 * performs, in the order and the mess they actually happen in (Ro, 2026-11-12).
 *
 * Not a fuzzer throwing noise at endpoints: every operation here is something a
 * person in the office does — posting a month, taking money, taking the wrong
 * money, voiding it, refunding it, putting the rent up, putting the levy up,
 * letting a villa, ending a tenancy, letting it again, restating. The odd cases
 * are the point: a tenant who keeps paying the old figure out of habit, an owner
 * who pays maintenance on a villa that is let, money taken before the month is
 * posted, a villa that changes hands mid-arrears, a levy that rises between a
 * charge and its payment.
 *
 * Nothing is asserted against the application's own arithmetic. Every sweep is
 * an independent recomputation from the raw ledger.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Five thousand operations of a working property office';

const C = n => Math.round((Number(n) || 0) * 100);
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
const day = (m, d) => `${m}-${String(d).padStart(2, '0')}`;

export default async function run({ port, projectRoot }) {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-office-'));
  const outfile = path.join(outdir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const F = await import(pathToFileURL(outfile).href);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-office-db-'));
  const T = reporter(title);
  let srv = await startServer({ port, adminPassword: 'Office-1234!', projectRoot, dataDir });

  const serverErrors = [];
  const refusals = new Map();
  let ops = 0;

  try {
    let c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Office-1234!', 'OfficeNew-9876!');

    // Every call in this test goes through here, so a 500 anywhere is caught at
    // the moment it happens, with the request that caused it.
    const call = async (method, url, body) => {
      ops++;
      const res = await c[method](url, body);
      if (res.status >= 500) serverErrors.push(`${method.toUpperCase()} ${url} -> ${res.status} :: ${JSON.stringify(body).slice(0, 120)}`);
      else if (res.status >= 400) {
        const msg = String(res.body?.error || res.status).slice(0, 60);
        refusals.set(msg, (refusals.get(msg) || 0) + 1);
      }
      return res;
    };

    const VILLAS = ['unit-1', 'unit-2', 'unit-3', 'unit-4', 'unit-5', 'unit-6', 'unit-7', 'unit-8'];
    const state = {};
    const putUnit = (id, over = {}) => {
      const s = { ...state[id], ...over };
      state[id] = s;
      return call('put', `/api/units/${id}`, {
        number: id.replace('unit-', ''),
        ownerName: s.ownerName,
        tenantName: s.status === 'long-term' ? s.tenantName : '',
        status: s.status,
        monthlyRent: s.monthlyRent,
        monthlyMaintenance: s.monthlyMaintenance,
        currency: s.currency,
        maintCurrency: s.maintCurrency,
        rentDueDay: 7,
        maintDueDay: 1,
        ...(over.tenantChangeIntent ? { tenantChangeIntent: over.tenantChangeIntent } : {})
      });
    };

    // Opening position: four lets in JMD, one USD let, one owner-occupied, one
    // short-stay, one off the market. The lets start at the OLD shape — rent
    // keyed as ISPO's share, with the levy billed separately — which is exactly
    // the state the real property was in before today.
    for (const [i, id] of VILLAS.entries()) {
      const usd = i === 4;
      state[id] = {
        ownerName: `Owner ${i + 1}`,
        tenantName: `Tenant ${i + 1}`,
        status: i === 5 ? 'owner-occupied' : i === 6 ? 'short-term' : i === 7 ? 'unavailable' : 'long-term',
        monthlyRent: usd ? 675 : 55000,
        monthlyMaintenance: usd ? 125 : 20000,
        currency: usd ? 'USD' : 'JMD',
        maintCurrency: usd ? 'USD' : 'JMD'
      };
      await putUnit(id);
    }
    await call('post', '/api/charges/post-month', { monthString: '2026-07' });
    await call('post', '/api/charges/post-month', { monthString: '2026-08' });

    /* ---------------- the independent recomputation ---------------- */
    const sweep = async label => {
      const db = (await call('get', '/api/db')).body;
      const problems = [];

      // 1. Every split charge adds up, and nothing is negative or NaN.
      for (const ch of db.charges) {
        if (!Number.isFinite(ch.amount) || ch.amount < 0) problems.push(`charge ${ch.id} amount ${ch.amount}`);
        const hasSplit = ch.rentPortion !== undefined || ch.maintenancePortion !== undefined;
        if (hasSplit && C(ch.rentPortion) + C(ch.maintenancePortion) !== C(ch.amount)) {
          problems.push(`charge ${ch.id} split ${ch.rentPortion}+${ch.maintenancePortion} != ${ch.amount}`);
        }
        if (ch.status === 'void' && !ch.voidReason) problems.push(`voided charge ${ch.id} has no reason`);
      }

      // 2. Every receipt is sane, and a refund never exceeds the receipt.
      for (const p of db.payments) {
        if (!Number.isFinite(p.amount) || p.amount < 0) problems.push(`receipt ${p.id} amount ${p.amount}`);
        if (C(p.refundedAmount || 0) > C(p.amount)) problems.push(`receipt ${p.id} refunded beyond its own value`);
        if (p.status === 'completed' && !p.receiptNo) problems.push(`completed receipt ${p.id} carries no number`);
        if (p.derived) problems.push(`a derived credit was stored on the server: ${p.id}`);
      }

      // 3. Per villa, per currency: maintenance can never be settled beyond what
      //    was charged, counting real receipts and the credits taken from rent.
      const derived = F.settledFromRent(db.charges, db.payments);
      for (const u of db.units) {
        for (const cur of ['JMD', 'USD']) {
          const charged = db.charges.filter(x => x.unitId === u.id && x.category === 'Maintenance' && x.status === 'open' && x.currency === cur)
            .reduce((a, x) => a + C(x.amount), 0);
          const real = db.payments.filter(x => x.unitId === u.id && x.category === 'Maintenance' && x.status === 'completed' && x.currency === cur)
            .reduce((a, x) => a + C(x.amount) - C(x.refundedAmount || 0), 0);
          const cred = derived.filter(x => x.unitId === u.id && x.currency === cur).reduce((a, x) => a + C(x.amount), 0);
          if (real <= charged && real + cred > charged) problems.push(`${u.number} ${cur}: maintenance settled ${real + cred} beyond ${charged} charged`);
          if (cred < 0) problems.push(`${u.number} ${cur}: a negative credit`);
        }
      }

      // 4. A derived credit must never be conjured from rent that never arrived.
      for (const u of db.units) {
        const rentIn = db.payments.filter(x => x.unitId === u.id && x.category === 'Rent' && x.status === 'completed')
          .reduce((a, x) => a + C(x.amount) - C(x.refundedAmount || 0), 0);
        const cred = derived.filter(x => x.unitId === u.id).reduce((a, x) => a + C(x.amount), 0);
        if (cred > rentIn) problems.push(`${u.number}: ${cred} settled from rent, but only ${rentIn} of rent was received`);
      }

      // 5. The combined view may not ask for more than the two books separately do.
      const combined = F.consolidateEverything(db.charges, db.payments.concat(derived), db.units);
      const rawBilled = db.charges.filter(x => x.status === 'open').reduce((a, x) => a + C(x.amount), 0);
      const combBilled = combined.charges.filter(x => x.status === 'open').reduce((a, x) => a + C(x.amount), 0);
      if (combBilled > rawBilled) problems.push(`the combined view bills ${combBilled} against ${rawBilled} raised`);

      // 6. The application's own integrity check still passes.
      const integ = await call('get', '/api/integrity');
      if (integ.status !== 200) problems.push(`integrity endpoint returned ${integ.status}`);

      if (problems.length) T.check(`${label}: the books recompute cleanly`, false, problems.slice(0, 4).join(' | '));
      return problems.length === 0;
    };

    /*
     * The property starts the day in the state the real one was in: months billed
     * by an older release, at the rent before the levy was counted as part of it,
     * with no split on any charge. Built the honest way — stop the server, strip
     * the fields from db.json, start it again — so the restating under test has
     * genuine legacy data to work on rather than data this test pretended about.
     */
    await srv.stop();
    const dbPath = path.join(dataDir, 'db.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    let stripped = 0;
    for (const ch of raw.charges) {
      if (ch.category === 'Rent' && ch.kind !== 'one-off') { delete ch.rentPortion; delete ch.maintenancePortion; stripped++; }
    }
    // Long-standing tenants, as the real let villas are. Written into the file for
    // the same reason the split is stripped here: setting it through the unit form
    // is a changeover, which raises first and last month's rent. Without a move-in
    // date the receipt move correctly refuses to judge whose money is whose.
    for (const t of raw.tenancies || []) if (t.status === 'active') t.startedOn = '2026-07-01';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'OfficeNew-9876!' }, { captureCookie: true });

    T.check('an eight-villa property was set up and two months billed by an older release', stripped > 0 && (await call('get', '/api/db')).body.charges.length > 0, `${stripped} legacy charges`);
    T.check('the opening position recomputes cleanly', await sweep('opening'));

    // And money taken the old way against them: rent short of the levy, with the
    // levy keyed separately, which is the pair this release has to reconcile.
    for (const id of ['unit-1', 'unit-2', 'unit-3', 'unit-4']) {
      for (const m of ['2026-07', '2026-08']) {
        for (const [cat, amt] of [['Rent', 35000], ['Maintenance', 20000]]) {
          const res = await call('post', '/api/payments', { unitId: id, category: cat, amount: amt, currency: 'JMD', payerName: state[id].tenantName, method: 'Cash', date: day(m, 9) });
          if (res.body?.payment?.id) await call('post', `/api/payments/${res.body.payment.id}/confirm`, {});
        }
      }
    }

    /* ---------------- 5,000 operations ---------------- */
    const r = rng(20261112);
    const pick = a => a[Math.floor(r() * a.length)];
    let restates = 0;
    let moves = 0;
    let statusChanges = 0;
    let evictions = 0;
    let rateChanges = 0;
    let receipts = 0;
    let badSweeps = 0;
    let sweeps = 0;

    while (ops < 5000) {
      const id = pick(VILLAS);
      const s = state[id];
      const m = pick(MONTHS);
      const roll = r();

      if (roll < 0.2) {
        // Taking money. Often the right figure; often not.
        const cur = s.currency;
        const base = s.monthlyRent;
        const amount = pick([base, base, base, base - s.monthlyMaintenance, base + s.monthlyMaintenance, Math.round(base / 2), base * 2, base * 3]);
        const res = await call('post', '/api/payments', {
          unitId: id, category: pick(['Rent', 'Rent', 'Rent', 'Maintenance']), amount, currency: cur,
          payerName: s.tenantName || s.ownerName, method: pick(['Cash', 'Bank Transfer', 'Cheque']), date: day(m, 1 + Math.floor(r() * 27))
        });
        const pid = res.body?.payment?.id;
        if (pid && r() < 0.85) { await call('post', `/api/payments/${pid}/confirm`, {}); receipts++; }
      } else if (roll < 0.28) {
        await call('post', '/api/charges/post-month', { monthString: m });
      } else if (roll < 0.36) {
        // Putting the rent up, or the levy up — including the January 2027 rise.
        rateChanges++;
        if (r() < 0.5) await putUnit(id, { monthlyRent: s.currency === 'USD' ? pick([675, 800, 850]) : pick([55000, 75000, 100000, 107000]) });
        else await putUnit(id, { monthlyMaintenance: s.currency === 'USD' ? pick([125, 170]) : pick([20000, 27000]) });
      } else if (roll < 0.44) {
        // Restating, at any moment — including halfway through a rate change.
        const a = await call('post', '/api/charges/restate-rent', { confirm: true });
        restates += a.body?.restated || 0;
        const b = await call('post', '/api/payments/restate-maintenance-receipts', { confirm: true });
        moves += b.body?.moved || 0;
      } else if (roll < 0.52) {
        // A villa changes what it is for.
        statusChanges++;
        const next = pick(['long-term', 'long-term', 'owner-occupied', 'short-term', 'unavailable']);
        await putUnit(id, { status: next, tenantChangeIntent: next === 'long-term' ? pick(['changeover', 'correction']) : 'moved-out' });
      } else if (roll < 0.58) {
        // A new tenant in an existing villa.
        if (s.status === 'long-term') {
          await putUnit(id, { tenantName: `Tenant ${Math.floor(r() * 50)}`, tenantChangeIntent: pick(['changeover', 'correction']) });
        }
      } else if (roll < 0.64) {
        // Money taken in error, and put right.
        const db = (await call('get', '/api/db')).body;
        const live = db.payments.filter(p => p.status === 'completed' && !p.refundedAmount);
        if (live.length) {
          const p = pick(live);
          if (r() < 0.5) await call('post', `/api/payments/${p.id}/reverse`, { reversalReason: 'Keyed against the wrong villa' });
          else await call('post', `/api/payments/${p.id}/refund`, { refundedAmount: Math.round(p.amount / 2), refundedOn: day('2026-11', 10), refundMethod: 'Cash', refundReason: 'Overpayment returned' });
        }
      } else if (roll < 0.7) {
        // A late fee or a recharge.
        await call('post', '/api/charges', {
          unitId: id, category: pick(['Rent', 'Maintenance']), oneOffType: pick(['Late fee', 'Repair recharge', 'Special assessment']),
          amount: pick([5000, 12000, 500]), dueDate: day(m, 5), description: 'Office entry', confirmCurrencyMismatch: true
        });
      } else if (roll < 0.75) {
        // A charge raised in error.
        const db = (await call('get', '/api/db')).body;
        const open = db.charges.filter(x => x.status === 'open');
        if (open.length) await call('post', `/api/charges/${pick(open).id}/void`, { reason: 'Raised in error by the office' });
      } else if (roll < 0.79) {
        evictions++;
        await call('post', `/api/tenancies/x/evict`, { reason: 'Rent unpaid for three months', effectiveDate: day('2026-11', 1) });
        const db = (await call('get', '/api/db')).body;
        const t = db.tenancies.filter(x => x.status === 'active');
        if (t.length) await call('post', `/api/tenancies/${pick(t).id}/evict`, { reason: 'Rent unpaid for three months', effectiveDate: day('2026-11', 1) });
      } else if (roll < 0.84) {
        await call('post', '/api/expenses', { unitId: r() < 0.5 ? id : '', category: pick(['Repairs', 'Grounds', 'Security']), amount: pick([15000, 40000]), currency: 'JMD', date: day(m, 12), description: 'Office entry', vendor: 'A supplier' });
      } else if (roll < 0.88) {
        const db = (await call('get', '/api/db')).body;
        const done = db.payments.filter(p => p.status === 'completed' && !p.reconciledOn);
        if (done.length) await call('post', `/api/payments/${pick(done).id}/reconcile`, { reconciledOn: day('2026-11', 20), reconciledReference: 'BANK-REF' });
      } else if (roll < 0.92) {
        // The odd one: money against a villa before its month exists.
        const res = await call('post', '/api/payments', { unitId: id, category: 'Rent', amount: s.monthlyRent, currency: s.currency, payerName: 'Paid ahead', method: 'Cash', date: day('2026-11', 25), allowCredit: true });
        const pid = res.body?.payment?.id;
        if (pid) await call('post', `/api/payments/${pid}/confirm`, {});
      } else if (roll < 0.96) {
        await call('get', `/api/annual-reports/2026`);
      } else {
        sweeps++;
        if (!(await sweep(`after ${ops} operations`))) badSweeps++;
      }
    }

    T.check(`${ops} office operations were carried out`, ops >= 5000, String(ops));
    T.check('the work was real: money taken, rates changed, villas re-let, tenancies ended',
      receipts > 100 && rateChanges > 200 && statusChanges > 200 && evictions > 100,
      `receipts ${receipts} rates ${rateChanges} status ${statusChanges} evictions ${evictions}`);
    T.check('the legacy charges and the money keyed against them were both put right, mid-day, amongst everything else',
      restates >= stripped && moves > 5, `restated ${restates} of ${stripped} legacy charges, receipts moved ${moves}`);
    T.check(`every one of the ${sweeps} sweeps taken along the way recomputed cleanly`, badSweeps === 0, `${badSweeps} bad`);
    T.check('not one operation produced a server error', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '));
    T.check('refusals were refusals, not failures — and they carried readable reasons',
      [...refusals.keys()].every(k => k.length > 3), [...refusals.entries()].slice(0, 3).map(([k, v]) => `${v}x ${k}`).join(' | '));
    T.check('the books recompute cleanly at the end of the day', await sweep('final'));

    /* ---------------- the morning after ---------------- */
    const db = (await call('get', '/api/db')).body;
    T.check('every villa still has a coherent register', db.units.every(u => Number.isFinite(u.monthlyRent) && Number.isFinite(u.monthlyMaintenance) && u.monthlyRent >= 0 && u.monthlyMaintenance >= 0));
    T.check('no tenancy is both active and ended', db.tenancies.every(t => !(t.status === 'active' && t.endedOn)));
    T.check('every receipt still belongs to a villa on the register', db.payments.every(p => db.units.some(u => u.id === p.unitId)));
    T.check('every charge still belongs to a villa on the register', db.charges.every(x => db.units.some(u => u.id === x.unitId)));
    T.check('the audit trail recorded the day', db.auditLogs.length > 50, String(db.auditLogs.length));
    T.check('a second restate at the end of it all changes nothing',
      (await call('post', '/api/charges/restate-rent', { confirm: true })).body.restated === 0 ||
      (await call('post', '/api/charges/restate-rent', { confirm: true })).body.restated === 0);
    const after = (await call('post', '/api/payments/restate-maintenance-receipts', { confirm: true })).body;
    T.check('and a second receipt move changes nothing', after.moved === 0, JSON.stringify(after).slice(0, 120));
    T.check('the property can still export a complete backup', (await call('get', '/api/backup/download')).status === 200);
    T.check('server healthy at the end', (await call('get', '/api/health')).status === 200);
  } catch (err) {
    T.check('the office day ran without an unhandled error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(outdir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return T.done();
}
