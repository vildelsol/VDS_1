/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 5,000 randomised operations against the agreed-rent rule (maintenance comes out of it).
 *
 * Rent edits, levy edits (including the 1 January rise), posting months, voids,
 * one-off charges, receipts, hostile inputs and restatements, in a seeded random
 * order across 16 villas of mixed status and currency. After every operation the
 * effect is checked against an independent oracle written here, not against the
 * application's own helper; every 250 operations the whole book is re-checked.
 *
 * Seeded, so a failure reproduces: the seed is in the title.
 */

import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

const SEED = 20261110;
export const title = `5,000 randomised tenant-total operations (seed ${SEED})`;

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
const cents = n => Math.round(n * 100);
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
const STATUSES = ['long-term', 'long-term', 'long-term', 'owner-occupied', 'short-term', 'vacant', 'unavailable'];
const RENTS = [0, 45000, 55000, 60000, 65000.5, 120000];
const LEVIES = [0, 20000, 25000, 27000, 27000, 33333.33];

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Five000-1234!', projectRoot });
  const T = reporter(title);
  const rand = rng(SEED);
  const pick = a => a[Math.floor(rand() * a.length)];
  const problems = new Map();
  let checks = 0;
  const ok = (desc, cond, detail) => {
    checks++;
    if (!cond && problems.size < 40 && !problems.has(desc)) problems.set(desc, detail || '');
    if (!cond && problems.has(desc) && detail && problems.get(desc) === '') problems.set(desc, detail);
    if (!cond) problems.set(desc + '#n', (Number(problems.get(desc + '#n')) || 0) + 1);
  };
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Five000-1234!', 'FiveNew-9876!');

    const body = {};
    const ids = Array.from({ length: 16 }, (_, i) => `unit-${i + 1}`);
    const cur = {};
    const mcur = {};
    for (const id of ids) {
      cur[id] = rand() < 0.8 ? 'JMD' : 'USD';
      mcur[id] = rand() < 0.85 ? cur[id] : cur[id] === 'JMD' ? 'USD' : 'JMD';
    }
    const put = (id, over) =>
      c.put(`/api/units/${id}`, {
        number: id.replace('unit-', ''),
        ownerName: 'Owner ' + id,
        tenantName: 'Tenant ' + id,
        status: 'long-term',
        monthlyRent: 55000,
        monthlyMaintenance: 20000,
        currency: cur[id],
        maintCurrency: mcur[id],
        rentDueDay: 1,
        maintDueDay: 1,
        ...over,
        ...(over.status && over.status !== 'long-term' ? { tenantName: '', tenantChangeIntent: 'moved-out' } : {})
      });
    const getDb = async () => (await c.get('/api/db')).body;
    for (const id of ids) await put(id, {});

    // ---------- the oracle: written independently of finance.ts ----------
    const expectRent = u => {
      if (u.status !== 'long-term' || !(u.monthlyRent > 0)) return null;
      const sameCur = (u.maintCurrency || u.currency) === u.currency;
      const m = u.monthlyMaintenance > 0 && sameCur ? Math.min(u.monthlyMaintenance, u.monthlyRent) : 0;
      // The agreed rent is the whole charge; maintenance is taken out of it.
      return { amount: u.monthlyRent, rent: Math.round((u.monthlyRent - m) * 100) / 100, maint: m, currency: u.currency };
    };
    const expectMaint = u => (u.status !== 'unavailable' && u.monthlyMaintenance > 0 ? { amount: u.monthlyMaintenance, currency: u.maintCurrency || u.currency } : null);

    const ordinary = (db, id, cat, month) => db.charges.filter(x => x.unitId === id && x.category === cat && x.periodMonth === month && x.status === 'open' && x.kind === undefined);
    const balance = (db, id, cat, currency) =>
      cents(db.charges.filter(x => x.unitId === id && x.category === cat && x.status === 'open' && x.currency === currency).reduce((a, x) => a + x.amount, 0)) -
      cents(db.payments.filter(p => p.unitId === id && p.category === cat && p.status === 'completed' && p.currency === currency).reduce((a, p) => a + p.amount - (p.refundedAmount || 0), 0));

    let seenCharges = new Set();
    const globalCheck = db => {
      ok('charge ids are unique', new Set(db.charges.map(x => x.id)).size === db.charges.length);
      for (const id of seenCharges) ok('no charge is ever deleted', db.charges.some(x => x.id === id), id);
      seenCharges = new Set(db.charges.map(x => x.id));
      for (const ch of db.charges) {
        if (ch.rentPortion !== undefined || ch.maintenancePortion !== undefined) {
          ok('a split always adds to the amount', cents((ch.rentPortion || 0) + (ch.maintenancePortion || 0)) === cents(ch.amount), JSON.stringify(ch));
          ok('only rent charges carry a split', ch.category === 'Rent', ch.id);
        }
        ok('amounts are positive finite money to the cent', Number.isFinite(ch.amount) && ch.amount > 0 && cents(ch.amount) / 100 === ch.amount, String(ch.amount));
        if (ch.status === 'void') ok('a void keeps who, when, why', !!ch.voidedBy && !!ch.voidedAt && !!ch.voidReason, ch.id);
        if (ch.kind === undefined && ch.status === 'open') {
          const dup = db.charges.filter(x => x.unitId === ch.unitId && x.category === ch.category && x.periodMonth === ch.periodMonth && x.status === 'open' && x.kind === undefined);
          ok('no month is billed twice on one account', dup.length === 1, ch.id);
        }
      }
    };

    // Months already voided (so a re-post is expected to replace them).
    const N = 5000;
    let counts = { post: 0, edit: 0, hostile: 0, void: 0, oneoff: 0, pay: 0, restate: 0, repost: 0 };
    let db = await getDb();

    for (let i = 1; i <= N; i++) {
      const roll = rand();
      if (roll < 0.22) {
        /* ---- edit a unit: rent / levy / status ---- */
        counts.edit++;
        const id = pick(ids);
        const over = { status: pick(STATUSES), monthlyRent: pick(RENTS), monthlyMaintenance: pick(LEVIES) };
        const before = db.units.find(u => u.id === id);
        const r = await put(id, over);
        ok('a valid register edit is accepted', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
        db = await getDb();
        const after = db.units.find(u => u.id === id);
        if (r.status === 200) {
          ok('levy is stored exactly as typed (unless unavailable)', over.status === 'unavailable' ? after.monthlyMaintenance === 0 : after.monthlyMaintenance === over.monthlyMaintenance, `${over.monthlyMaintenance} -> ${after.monthlyMaintenance}`);
        } else {
          ok('a refused edit changes nothing', after.monthlyMaintenance === before.monthlyMaintenance);
        }
      } else if (roll < 0.52) {
        /* ---- post a month: compare with oracle ---- */
        counts.post++;
        const month = pick(MONTHS);
        const pre = await getDb();
        const expectNew = [];
        for (const u of pre.units) {
          const er = expectRent(u);
          if (er && ordinary(pre, u.id, 'Rent', month).length === 0) expectNew.push({ id: u.id, cat: 'Rent', ...er });
          const em = expectMaint(u);
          if (em && ordinary(pre, u.id, 'Maintenance', month).length === 0) expectNew.push({ id: u.id, cat: 'Maintenance', ...em });
        }
        const r = await c.post('/api/charges/post-month', { monthString: month });
        ok('posting a past month succeeds', r.status === 200, String(r.status));
        db = await getDb();
        const created = db.charges.filter(x => !pre.charges.some(p => p.id === x.id));
        ok('exactly the expected charges were created', created.length === expectNew.length, `${created.length} vs ${expectNew.length} (${month})`);
        for (const e of expectNew) {
          const got = created.find(x => x.unitId === e.id && x.category === e.cat && x.periodMonth === month);
          ok(`${e.cat} charge exists with the oracle amount`, !!got && cents(got.amount) === cents(e.amount) && got.currency === e.currency, `${e.id} ${e.cat} ${month} expected ${e.amount} ${e.currency} got ${got ? got.amount + ' ' + got.currency : 'none'}`);
          if (got && e.cat === 'Rent') ok('rent charge split matches the register', cents(got.rentPortion) === cents(e.rent) && cents(got.maintenancePortion) === cents(e.maint), `${e.id} ${JSON.stringify([got.rentPortion, got.maintenancePortion, e.rent, e.maint])}`);
          if (got && e.cat === 'Maintenance') ok('maintenance charge carries no split', got.rentPortion === undefined && got.maintenancePortion === undefined);
        }
        // pre-existing charges untouched
        for (const p of pre.charges) {
          const now = db.charges.find(x => x.id === p.id);
          ok('earlier charges are byte-identical after posting', JSON.stringify(now) === JSON.stringify(p), p.id);
        }
        // idempotent
        const again = await c.post('/api/charges/post-month', { monthString: month });
        const db2 = await getDb();
        ok('posting the same month again adds nothing', again.status === 200 && db2.charges.length === db.charges.length, `${db2.charges.length} vs ${db.charges.length}`);
        db = db2;
      } else if (roll < 0.62) {
        /* ---- hostile levy / rent values ---- */
        counts.hostile++;
        const id = pick(ids);
        const bad = pick([-1, -0.01, 'abc', '1.500.000', 1e15, null, {}, [], '1e400', Infinity, ' ']);
        const before = db.units.find(u => u.id === id);
        const field = rand() < 0.5 ? 'monthlyMaintenance' : 'monthlyRent';
        const r = await put(id, { status: before.status, [field]: bad });
        db = await getDb();
        const after = db.units.find(u => u.id === id);
        if (r.status >= 400) ok('a refused value changes nothing', after[field] === before[field], `${field} ${JSON.stringify(bad)} ${before[field]} -> ${after[field]}`);
        else ok('an accepted odd value is stored as a sane finite non-negative number', Number.isFinite(after[field]) && after[field] >= 0 && after[field] < 1e12, `${field} ${JSON.stringify(bad)} -> ${after[field]}`);
        ok('no server error on hostile input', r.status < 500, String(r.status));
      } else if (roll < 0.70) {
        /* ---- void a charge, then re-post that month ---- */
        counts.void++;
        const open = db.charges.filter(x => x.status === 'open' && x.kind === undefined);
        if (!open.length) continue;
        const ch = pick(open);
        const bal0 = balance(db, ch.unitId, ch.category, ch.currency);
        const r = await c.post(`/api/charges/${ch.id}/void`, { reason: 'Randomised void for testing.' });
        ok('a void succeeds', r.status === 200, String(r.status));
        db = await getDb();
        ok('a void removes exactly that charge from the balance', balance(db, ch.unitId, ch.category, ch.currency) === bal0 - cents(ch.amount), `${bal0} - ${cents(ch.amount)}`);
        ok('the voided record is still there', db.charges.some(x => x.id === ch.id && x.status === 'void'));
        const r2 = await c.post(`/api/charges/${ch.id}/void`, { reason: 'Second void must be refused.' });
        ok('voiding twice is refused', r2.status === 400, String(r2.status));
      } else if (roll < 0.78) {
        /* ---- one-off charge: never a split, never restated ---- */
        counts.oneoff++;
        const id = pick(ids);
        const u = db.units.find(x => x.id === id);
        const cat = pick(['Rent', 'Maintenance']);
        const amount = pick([1000, 2500.5, 5000]);
        const r = await c.post('/api/charges', { unitId: id, category: cat, oneOffType: 'Late fee', amount, dueDate: '2026-11-05', description: 'Randomised fee' });
        if (r.status === 200) {
          const pre = db;
          db = await getDb();
          const created = db.charges.filter(x => !pre.charges.some(p => p.id === x.id));
          ok('a one-off is a single charge at the typed amount, no split', created.length === 1 && created[0].amount === amount && created[0].rentPortion === undefined && created[0].kind === 'one-off', JSON.stringify(created));
        } else ok('a refused one-off is a clean 4xx', r.status >= 400 && r.status < 500, String(r.status));
      } else if (roll < 0.88) {
        /* ---- receipt: balance oracle ---- */
        counts.pay++;
        const billable = db.charges.filter(x => x.status === 'open');
        if (!billable.length) continue;
        const ch = pick(billable);
        const amount = pick([1000, 5000, 20000, 75000, 82000.25]);
        const pre = db;
        const bal0 = balance(db, ch.unitId, ch.category, ch.currency);
        const created = await c.post('/api/payments', { unitId: ch.unitId, category: ch.category, amount, currency: ch.currency, payerName: 'Payer', method: 'Cash', date: localToday(), confirmNoOpenCharge: true });
        if (created.status === 200 && created.body?.payment?.id) {
          await c.post(`/api/payments/${created.body.payment.id}/confirm`, {});
          db = await getDb();
          ok('a confirmed receipt lowers the account by exactly its amount', balance(db, ch.unitId, ch.category, ch.currency) === bal0 - cents(amount), `${bal0} - ${cents(amount)} = ${balance(db, ch.unitId, ch.category, ch.currency)}`);
          ok('a receipt never touches a charge', db.charges.length === pre.charges.length && db.charges.every(x => JSON.stringify(x) === JSON.stringify(pre.charges.find(p => p.id === x.id))));
        } else ok('a refused receipt is a clean 4xx', created.status >= 400 && created.status < 500, String(created.status));
      } else {
        /* ---- restate: nothing here is legacy, so it must change nothing ---- */
        counts.restate++;
        const dry = await c.post('/api/charges/restate-rent', rand() < 0.5 ? {} : { confirm: 'yes' });
        const r = await c.post('/api/charges/restate-rent', { confirm: true });
        const post = await getDb();
        ok('restate answers cleanly', dry.status === 200 && r.status === 200, `${dry.status}/${r.status}`);
        ok('nothing legacy exists, so restating changes nothing', r.body.restated === 0 && post.charges.length === db.charges.length, JSON.stringify(r.body).slice(0, 120));
        ok('a non-true confirm is only a dry run', dry.body.confirmed === false);
        db = post;
      }
      if (i % 250 === 0) globalCheck((db = await getDb()));
    }
    globalCheck((db = await getDb()));

    // Final cross-account invariant: every account's balance is charges - receipts, never NaN.
    for (const u of db.units) for (const cat of ['Rent', 'Maintenance']) for (const cu of ['JMD', 'USD']) {
      const b = balance(db, u.id, cat, cu);
      ok('every balance is a finite number of cents', Number.isFinite(b));
    }
    const health = await c.get('/api/health');
    ok('the server is healthy at the end', health.status === 200);

    console.log(`  .... ${N} operations, ${checks} assertions: ${JSON.stringify(counts)}`);
    for (const [k, v] of problems) if (!k.endsWith('#n')) T.check(`${k} (${problems.get(k + '#n')}x)`, false, v);
    T.check(`${N} randomised operations and ${checks} assertions held`, problems.size === 0, `${[...problems.keys()].filter(k => !k.endsWith('#n')).length} distinct failures`);
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
  }
  return T.done();
}
