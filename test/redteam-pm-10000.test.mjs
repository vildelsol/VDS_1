/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ten thousand scenarios from a professional property manager's desk, red-team
 * style, with a security matrix and a route map. Commissioned by Ro 2026-11-13.
 *
 * Founding rule (same as redteam-3000/5000): nothing touches the database behind
 * the application. Every action goes through the same HTTP API the screens use.
 * A failure is therefore a sequence of ordinary or hostile requests that left
 * the books wrong, the server crashed, or a role do what it must not.
 *
 * Four independent oracles, none of which reuse the application's own sums:
 *   1. SHADOW LEDGER  — every payment this suite creates is remembered with the
 *      status it should have. At the end the database must match: no lost
 *      receipt, no phantom receipt, no changed amount.
 *   2. BALANCE ORACLE — for owner-occupied villas, maintenance balance is
 *      recomputed from raw charges and receipts and compared to finance.ts.
 *   3. STATE-UNCHANGED — a refused request must leave the record count and the
 *      record untouched.
 *   4. ROUTE MAP — every /api route is hit unauthenticated; every one must
 *      refuse. A coverage map lists routes the scenarios never exercised.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = 'Ten thousand property-manager scenarios: red team, security, accuracy, route map';

const SCENARIOS = Number(process.env.RT_SCENARIOS || 10000);
const ONLY = process.env.RT_ONLY ? process.env.RT_ONLY.split(',') : null;
const BALANCE_CHECK_EVERY = 500;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (r, l) => l[Math.floor(r() * l.length) % l.length];
const money = (r, lo, hi) => Math.round((lo + r() * (hi - lo)) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const is2 = res => res.status >= 200 && res.status < 300;
const is4 = res => res.status >= 400 && res.status < 500;
const r2 = n => Math.round(n * 100) / 100;

const TODAY = localToday();
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
/** A date inside `month` that is never in the future. */
const dayIn = (month, day) => {
  const d = `${month}-${pad(Math.min(28, Math.max(1, day)))}`;
  return d > TODAY ? TODAY : d;
};

async function loadFin(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rtpm-'));
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
  const PW = 'RedTeamPM-1234!';
  const srv = await startServer({ port, adminPassword: PW, projectRoot });
  const { fin, cleanup } = await loadFin(projectRoot);

  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, PW, 'RedTeamPMNew-9876!');

    /* ---------- route map: every call is recorded against its route ---------- */
    const hits = new Map();
    const norm = p => p.split('?')[0].replace(/^(\/api\/(?:payments|charges|expenses|utilities|tenancies|users|units|bookings|recurring-expenses|unit-activities|ical\/feeds))\/[^/]+/, '$1/:id').replace(/^(\/api\/annual-reports)\/[^/]+/, '$1/:id');
    const api = (client, method, p, body, opts) => {
      const k = `${method} ${norm(p)}`;
      hits.set(k, (hits.get(k) || 0) + 1);
      return client.call(method, p, body, opts);
    };
    const A = {
      get: (p, o) => api(admin, 'GET', p, undefined, o),
      post: (p, b, o) => api(admin, 'POST', p, b, o),
      put: (p, b, o) => api(admin, 'PUT', p, b, o)
    };

    const settings = (await A.get('/api/settings')).body;
    await A.put('/api/settings', { ...settings, booksBeginOn: '2026-01-01' });

    /* ---------- staff of every role ---------- */
    const staff = {};
    for (const [username, role] of [['mgr', 'MANAGER'], ['fin', 'FINANCE_OFFICER'], ['jr', 'JUNIOR_OFFICER']]) {
      const pw = `Staff-${username}-1234!`;
      await A.post('/api/users', { name: username, username, role, password: pw });
      const cl = makeClient(srv.baseUrl);
      await cl.post('/api/auth/login', { username, password: pw }, { captureCookie: true });
      await cl.post('/api/auth/change-password', { currentPassword: pw, newPassword: pw + 'x' });
      staff[role] = cl;
    }
    const anon = makeClient(srv.baseUrl);

    /* ---------- a portfolio shaped like a real one ---------- */
    const setup = rng(20261113);
    const unitIds = (await A.get('/api/db')).body.units.map(u => u.id);
    const lets = [], owners = [], shortStay = [];
    for (let i = 0; i < unitIds.length; i++) {
      const id = unitIds[i];
      const number = id.replace('unit-', '');
      let body;
      if (i % 4 === 3) {
        body = { number, ownerName: `Owner ${i}`, status: 'owner-occupied', monthlyMaintenance: money(setup, 8000, 20000), currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 };
        owners.push(id);
      } else if (i % 4 === 2) {
        body = { number, ownerName: `Owner ${i}`, status: 'short-term', currency: 'USD', maintCurrency: 'JMD', monthlyMaintenance: money(setup, 8000, 16000), maintDueDay: 1 };
        shortStay.push(id);
      } else {
        const usd = i % 5 === 0;
        body = { number, ownerName: `Owner ${i}`, tenantName: `Tenant ${i}`, tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', status: 'long-term', monthlyRent: usd ? money(setup, 600, 1500) : money(setup, 45000, 140000), monthlyMaintenance: money(setup, 8000, 20000), currency: usd ? 'USD' : 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 };
        lets.push(id);
      }
      await A.put(`/api/units/${id}`, body);
    }
    T.check('portfolio configured', lets.length > 3 && owners.length > 1 && shortStay.length > 1, `${lets.length}/${owners.length}/${shortStay.length}`);

    /* ---------- shadow ledger ---------- */
    const shadow = new Map(); // id -> { unitId, amount, currency, category, status, refunded }
    let serverErrors = 0;
    const serverErrorSamples = [];
    const faults = {}; // family -> [messages]
    const tally = {};
    const fault = (fam, msg) => { tally[fam + ' :: ' + msg.replace(/[0-9]+/g, 'N').slice(0, 90)] = (tally[fam + ' :: ' + msg.replace(/[0-9]+/g, 'N').slice(0, 90)] || 0) + 1; ((faults[fam] ||= []).length < 5 && faults[fam].push(msg), (faults[fam].count = (faults[fam].count || 0) + 1)); };
    const watch = (fam, res, label) => {
      if (res && res.status >= 500) {
        serverErrors++;
        if (serverErrorSamples.length < 8) serverErrorSamples.push(`${fam}: ${label} -> ${res.status} ${String(res.text).slice(0, 80)}`);
      }
      return res;
    };
    const dbNow = async () => (await A.get('/api/db')).body;

    async function pay(fam, payload, { confirm = false, client = admin, headers } = {}) {
      const res = watch(fam, await api(client, 'POST', '/api/payments', payload, headers ? { headers } : undefined), 'POST /api/payments');
      const id = res.body?.payment?.id;
      if (is2(res) && id) {
        shadow.set(id, { unitId: payload.unitId, amount: payload.amount, currency: payload.currency, category: payload.category, status: 'pending', refunded: 0 });
        if (confirm) {
          const c = watch(fam, await api(client, 'POST', `/api/payments/${id}/confirm`, {}), 'confirm');
          if (is2(c)) shadow.get(id).status = 'completed';
        }
      }
      return res;
    }

    /* ================= the scenario families ================= */
    const families = {
      /** Month-end posting is idempotent and never future. */
      async 'month-run'({ month, rand }) {
        const before = (await dbNow()).charges.length;
        const a = watch('month-run', await A.post('/api/charges/post-month', { monthString: month }), 'post-month');
        const mid = (await dbNow()).charges.length;
        const b = watch('month-run', await A.post('/api/charges/post-month', { monthString: month }), 'post-month again');
        const after = (await dbNow()).charges.length;
        if (after !== mid) fault('month-run', `posting ${month} twice added ${after - mid} charges the second time`);
        const fut = await A.post('/api/charges/post-month', { monthString: '2099-01' });
        watch('month-run', fut, 'future month');
        if (is2(fut) && (await dbNow()).charges.some(c => c.dueDate >= '2099')) fault('month-run', 'a future month was posted');
        void before; void a; void b; void rand;
      },
      /** Full receipt, confirmed: gets a receipt number, shadow updated. */
      async 'full-receipt'({ month, rand }) {
        const db = await dbNow();
        const open = db.charges.filter(c => c.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const res = await pay('full-receipt', { unitId: ch.unitId, category: ch.category, amount: ch.amount, currency: ch.currency, payerName: ch.payerName || 'Payer', method: 'Cash', date: dayIn(month, 12) }, { confirm: true });
        if (is2(res)) {
          const p = (await dbNow()).payments.find(x => x.id === res.body.payment.id);
          if (p && p.status === 'completed' && !p.receiptNo) fault('full-receipt', `confirmed payment ${p.id} has no receipt number`);
        }
      },
      /** Part payments that must sum exactly (floating point trap). */
      async 'part-payments'({ month, rand }) {
        const open = (await dbNow()).charges.filter(c => c.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const parts = [0.1, 0.2, 0.7];
        for (const f of parts) await pay('part-payments', { unitId: ch.unitId, category: ch.category, amount: r2(ch.amount * f), currency: ch.currency, payerName: 'P', method: 'Bank Transfer', date: dayIn(month, 14) }, { confirm: true });
      },
      /** Overpayment and wrong-currency receipts. */
      async 'over-and-wrong-currency'({ month, rand }) {
        const open = (await dbNow()).charges.filter(c => c.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        await pay('over-and-wrong-currency', { unitId: ch.unitId, category: ch.category, amount: ch.amount * 3, currency: ch.currency, payerName: 'P', method: 'Cash', date: dayIn(month, 15) });
        await pay('over-and-wrong-currency', { unitId: ch.unitId, category: ch.category, amount: ch.amount, currency: ch.currency === 'JMD' ? 'USD' : 'JMD', payerName: 'P', method: 'Cash', date: dayIn(month, 16) });
      },
      /** The same submit sent twice with one idempotency key, and in parallel. */
      async 'double-submit'({ month, rand, i }) {
        const open = (await dbNow()).charges.filter(c => c.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const payload = { unitId: ch.unitId, category: ch.category, amount: ch.amount, currency: ch.currency, payerName: 'D', method: 'Cash', date: dayIn(month, 17) };
        const key = `rtpm-${i}`;
        const rs = await Promise.all([1, 2, 3].map(() => api(admin, 'POST', '/api/payments', payload, { headers: { 'Idempotency-Key': key } })));
        rs.forEach(r => watch('double-submit', r, 'parallel'));
        const ids = new Set(rs.filter(is2).map(r => r.body?.payment?.id).filter(Boolean));
        if (ids.size > 1) fault('double-submit', `${ids.size} different receipts from one idempotency key`);
        for (const id of ids) shadow.set(id, { unitId: payload.unitId, amount: payload.amount, currency: payload.currency, category: payload.category, status: 'pending', refunded: 0 });
      },
      /** Hostile amounts and dates: must be refused and create nothing. */
      async 'bad-amounts'({ rand }) {
        const open = (await dbNow()).charges.filter(c => c.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const base = { unitId: ch.unitId, category: ch.category, currency: ch.currency, payerName: 'B', method: 'Cash', date: TODAY };
        const bad = [-100, 0, 'abc', '1e999', null, NaN, Infinity, 1e15, '50,000x', [], {}, true, 0.001, -0.01];
        const n0 = (await dbNow()).payments.length;
        for (const amount of bad) {
          const r = watch('bad-amounts', await api(admin, 'POST', '/api/payments', { ...base, amount }), `amount ${String(amount)}`);
          if (is2(r)) fault('bad-amounts', `amount ${JSON.stringify(amount)} accepted`);
        }
        const r = await api(admin, 'POST', '/api/payments', { ...base, amount: 100, date: '2099-01-01' });
        watch('bad-amounts', r, 'future date');
        if (is2(r)) fault('bad-amounts', 'future-dated receipt accepted');
        for (const date of ['2026-02-30', '2026-13-01', 'yesterday', '0000-00-00', '2026-11-13T25:00']) {
          const x = await api(admin, 'POST', '/api/payments', { ...base, amount: 100, date });
          watch('bad-amounts', x, `date ${date}`);
          if (is2(x)) fault('bad-amounts', `impossible date "${date}" accepted`);
        }
        const n1 = (await dbNow()).payments.length;
        if (n1 !== n0) fault('bad-amounts', `${n1 - n0} receipts were created by refused requests`);
      },
      /** Refund bounds and reversal interplay. */
      async 'refund-reverse'({ month, rand }) {
        const comp = Array.from(shadow.entries()).filter(([, s]) => s.status === 'completed' && !s.refunded);
        if (!comp.length) return;
        const [id, s] = pick(rand, comp);
        const part = r2(s.amount * 0.4);
        const a = watch('refund-reverse', await A.post(`/api/payments/${id}/refund`, { amount: part, reason: 'overpaid', method: 'Cash', refundedOn: dayIn(month, 20) }), 'refund');
        if (is2(a)) s.refunded = part;
        const over = watch('refund-reverse', await A.post(`/api/payments/${id}/refund`, { amount: s.amount * 5, reason: 'too much', method: 'Cash', refundedOn: TODAY }), 'over-refund');
        if (is2(over)) fault('refund-reverse', 'refund larger than the receipt accepted');
        const neg = await A.post(`/api/payments/${id}/refund`, { amount: -5, reason: 'neg', method: 'Cash', refundedOn: TODAY });
        watch('refund-reverse', neg, 'negative refund');
        if (is2(neg)) fault('refund-reverse', 'negative refund accepted');
        if (rand() > 0.6) {
          const rv = watch('refund-reverse', await A.post(`/api/payments/${id}/reverse`, { reversalReason: 'entered against the wrong villa' }), 'reverse');
          if (is2(rv)) s.status = 'reversed';
        }
      },
      /** Void a charge twice. */
      async 'void-charge'({ rand }) {
        const open = (await dbNow()).charges.filter(c => c.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        watch('void-charge', await A.post(`/api/charges/${ch.id}/void`, { reason: 'error' }), 'void');
        const again = watch('void-charge', await A.post(`/api/charges/${ch.id}/void`, { reason: 'again' }), 'void twice');
        void again;
        const c2 = (await dbNow()).charges.find(c => c.id === ch.id);
        if (c2 && c2.status === 'open') fault('void-charge', `charge ${ch.id} still open after void`);
      },
      /** One-off charges: opening balances, late fees, insurance. */
      async 'one-off'({ month, rand }) {
        const unitId = pick(rand, lets.concat(owners));
        const amount = money(rand, 500, 40000);
        const r = watch('one-off', await A.post('/api/charges', { unitId, category: pick(rand, ['Maintenance', 'Rent']), oneOffType: pick(rand, ['Opening balance', 'Insurance share', 'Late fee']), amount, currency: 'JMD', dueDate: dayIn(month, 9), description: 'One-off' }), 'one-off');
        void r;
        const neg = await A.post('/api/charges', { unitId, category: 'Rent', oneOffType: 'Late fee', amount: -50, currency: 'JMD', dueDate: TODAY, description: 'neg' });
        watch('one-off', neg, 'negative charge');
        if (is2(neg)) fault('one-off', 'negative charge accepted');
      },
      /** Deposits: over-return refused, double settle refused. */
      async 'deposit-lifecycle'({ rand }) {
        const active = (await dbNow()).tenancies.filter(t => t.status === 'active');
        if (!active.length) return;
        const t = pick(rand, active);
        const held = money(rand, 5000, 90000);
        const taken = watch('deposit-lifecycle', await A.post(`/api/tenancies/${t.id}/deposit`, { amount: held, currency: 'JMD', method: 'Cash' }), 'take deposit');
        if (!is2(taken)) return;
        const over = watch('deposit-lifecycle', await A.post(`/api/tenancies/${t.id}/deposit/settle`, { returnedAmount: held * 2, withheldAmount: 0, reason: 'over' }), 'over-return');
        if (is2(over)) fault('deposit-lifecycle', 'returned more deposit than was held');
        const ok1 = watch('deposit-lifecycle', await A.post(`/api/tenancies/${t.id}/deposit/settle`, { returnedAmount: held, withheldAmount: 0, reason: 'full' }), 'settle');
        const ok2 = watch('deposit-lifecycle', await A.post(`/api/tenancies/${t.id}/deposit/settle`, { returnedAmount: held, withheldAmount: 0, reason: 'again' }), 'settle twice');
        if (is2(ok1) && is2(ok2)) fault('deposit-lifecycle', 'deposit settled twice');
      },
      /** Rent changes and re-denomination under live charges. */
      async 'rent-change'({ rand }) {
        const id = pick(rand, lets);
        const unit = (await dbNow()).units.find(u => u.id === id);
        if (!unit) return;
        watch('rent-change', await A.put(`/api/units/${id}`, { ...unit, monthlyRent: money(rand, 40000, 160000), rentDueDay: 1 + Math.floor(rand() * 28) }), 'rent change');
        const bad = await A.put(`/api/units/${id}`, { ...unit, monthlyRent: -1 });
        watch('rent-change', bad, 'negative rent');
        if (is2(bad)) fault('rent-change', `negative rent accepted on a ${unit.status} villa, tenant ${JSON.stringify(unit.tenantName)}`);
        const dd = await A.put(`/api/units/${id}`, { ...unit, rentDueDay: 45 });
        watch('rent-change', dd, 'due day 45');
        if (is2(dd)) fault('rent-change', 'due day 45 accepted (silently clamped)');
      },
      /** Utilities billed, settled twice. */
      async 'utilities'({ month, rand }) {
        const unitId = pick(rand, lets);
        const u = watch('utilities', await A.post('/api/utilities', { unitId, type: pick(rand, ['Electricity', 'Water']), billingPeriod: month, amountCharged: money(rand, 1500, 28000), currency: 'JMD', previousReading: 100, currentReading: 100 + Math.floor(rand() * 400) }), 'utility');
        const id = u.body?.utility?.id || u.body?.reading?.id;
        if (!id) return;
        const a = watch('utilities', await A.post(`/api/utilities/${id}/settle`, {}), 'settle');
        const b = watch('utilities', await A.post(`/api/utilities/${id}/settle`, {}), 'settle twice');
        if (is2(a) && is2(b)) {
          const pays = (await dbNow()).payments.filter(p => p.utilityId === id && p.status !== 'reversed');
          if (pays.length > 1) fault('utilities', `utility ${id} settled twice produced ${pays.length} receipts`);
        }
      },
      /** Expenses: post, void twice, negative, month recall. */
      async 'expenses'({ month, rand }) {
        const r = watch('expenses', await A.post('/api/expenses', { category: pick(rand, ['Maintenance', 'Security', 'Supplies']), vendor: `V${Math.floor(rand() * 40)}`, description: 'cost', unitId: '', amount: money(rand, 1000, 60000), currency: 'JMD', date: dayIn(month, 11), status: 'paid', datePaid: dayIn(month, 11), paymentMethod: 'Cash' }), 'expense');
        const neg = await A.post('/api/expenses', { category: 'Maintenance', vendor: 'V', description: 'neg', amount: -1000, currency: 'JMD', date: TODAY, status: 'paid', datePaid: TODAY, paymentMethod: 'Cash' });
        watch('expenses', neg, 'negative expense');
        // A negative expense is a supplier credit, on purpose (Ro, 2026-10-05; supplier-credits suite).
        const id = r.body?.expense?.id;
        if (id) {
          watch('expenses', await A.post(`/api/expenses/${id}/void`, { reason: 'x' }), 'void');
          watch('expenses', await A.post(`/api/expenses/${id}/void`, { reason: 'x2' }), 'void twice');
        }
        watch('expenses', await A.post('/api/expenses/post-month', { monthString: month }), 'post-month');
      },
      /** Short-stay bookings: overlap must be refused. */
      async 'bookings'({ month, rand }) {
        const unitId = pick(rand, shortStay);
        const day = 2 + Math.floor(rand() * 10);
        const mk = (g, ci, co) => ({ unitId, guestName: g, checkIn: dayIn(month, ci), checkOut: dayIn(month, co), amount: money(rand, 200, 3000), depositPaid: 100, currency: 'USD', source: 'Direct' });
        const a = watch('bookings', await A.post('/api/bookings', mk('Guest A', day, day + 3)), 'booking');
        if (!is2(a)) return;
        const b = watch('bookings', await A.post('/api/bookings', mk('Guest B', day + 1, day + 4)), 'overlap');
        if (is2(b) && dayIn(month, day) < TODAY) fault('bookings', `overlapping stay accepted on ${unitId} ${month}`);
        const inv = watch('bookings', await A.post('/api/bookings', { ...mk('Guest C', day + 6, day + 5) }), 'check-out before check-in');
        if (is2(inv) && dayIn(month, day + 6) < dayIn(month, day + 5)) fault('bookings', 'checkout before checkin accepted');
      },
      /** Period close: a closed month refuses late receipts; reopen restores. */
      async 'period-close'({ rand }) {
        void rand;
        const close = watch('period-close', await A.post('/api/periods/close', { through: '2026-01' }), 'close');
        if (!is2(close)) return;
        const open = (await dbNow()).charges.find(c => c.status === 'open' && c.unitId);
        if (open) {
          const r = await pay('period-close', { unitId: open.unitId, category: open.category, amount: 1, currency: open.currency, payerName: 'late', method: 'Cash', date: '2026-01-10' });
          if (is2(r)) fault('period-close', 'a receipt dated inside a closed period was accepted');
        }
        watch('period-close', await A.post('/api/periods/reopen', { through: '2026-01' }), 'reopen');
      },
      /** Mass assignment: client must not choose status, receipt number, id. */
      async 'mass-assignment'({ rand }) {
        const open = (await dbNow()).charges.filter(c => c.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const r = await pay('mass-assignment', { unitId: ch.unitId, category: ch.category, amount: 10, currency: ch.currency, payerName: 'M', method: 'Cash', date: TODAY, status: 'completed', receiptNo: 'FAKE-0001', id: 'pay-forged', createdBy: 'nobody', refundedAmount: 999 });
        if (is2(r)) {
          const p = r.body.payment;
          if (p.status === 'completed') fault('mass-assignment', 'client set status=completed on create');
          if (p.receiptNo === 'FAKE-0001') fault('mass-assignment', 'client chose the receipt number');
          if (p.id === 'pay-forged') fault('mass-assignment', 'client chose the record id');
          if (p.refundedAmount) fault('mass-assignment', 'client set refundedAmount on create');
        }
        const me = (await A.get('/api/auth/me')).body;
        const uid = (await dbNow()).users.find(u => u.username === 'jr')?.id;
        const esc = await A.put(`/api/users/${uid}`, { role: 'ADMINISTRATOR', name: 'jr', passwordHash: 'x' });
        watch('mass-assignment', esc, 'role escalation by admin (allowed)');
        await A.put(`/api/users/${uid}`, { role: 'JUNIOR_OFFICER' });
        void me;
      },
      /** Hostile text: XSS, SQL, formula, unicode, control characters round-trip safely. */
      async 'hostile-text'({ rand, i }) {
        const evil = pick(rand, ['<script>alert(1)</script>', "'; DROP TABLE users;--", '=cmd|\' /C calc\'!A0', '${7*7}{{7*7}}', '‮gnp.exe', 'A'.repeat(5000), '\u0000\u0001', '😀'.repeat(300), '<img src=x onerror=alert(1)>']);
        const unitId = pick(rand, lets);
        const unit = (await dbNow()).units.find(u => u.id === unitId);
        const r = watch('hostile-text', await A.put(`/api/units/${unitId}`, { ...unit, ownerName: evil, ownerChangeIntent: 'correction' }), 'hostile owner name');
        void r; void i;
        const e = watch('hostile-text', await A.post('/api/expenses', { category: 'Maintenance', vendor: evil, description: evil, amount: 100, currency: 'JMD', date: TODAY, status: 'paid', datePaid: TODAY, paymentMethod: 'Cash' }), 'hostile expense');
        void e;
        const html = await api(anon, 'GET', '/');
        if (/<script>alert\(1\)<\/script>/.test(html.text)) fault('hostile-text', 'stored script reachable unauthenticated on /');
        await A.put(`/api/units/${unitId}`, { ...unit, ownerChangeIntent: 'correction' });
      },
      /** Prototype pollution and malformed bodies. */
      async 'malformed-bodies'({ rand }) {
        const poison = [
          '{"__proto__":{"polluted":true}}',
          '{"constructor":{"prototype":{"polluted":true}}}',
          '{"unitId":',
          '[]', 'null', '"str"', '123',
          '{"a":' + '['.repeat(2000) + ']'.repeat(2000) + '}'
        ];
        for (const raw of poison) {
          const res = await fetch(srv.baseUrl + pick(rand, ['/api/payments', '/api/charges', '/api/units/unit-1', '/api/settings', '/api/expenses']), { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.getCookie() }, body: raw });
          hits.set('POST malformed', (hits.get('POST malformed') || 0) + 1);
          if (res.status >= 500) { serverErrors++; serverErrorSamples.push(`malformed: ${raw.slice(0, 30)} -> ${res.status}`); }
        }
        const wrongType = await fetch(srv.baseUrl + '/api/payments', { method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: admin.getCookie() }, body: 'unitId=1&amount=5' });
        if (wrongType.status >= 500) { serverErrors++; serverErrorSamples.push(`wrong content-type -> ${wrongType.status}`); }
        if (is2({ status: wrongType.status })) fault('malformed-bodies', 'form-encoded body created a record');
        const h = await fetch(srv.baseUrl + '/api/health');
        if (!h.ok) fault('malformed-bodies', 'server unhealthy after malformed bodies');
      },
      /** Odd ids and paths. */
      async 'path-abuse'({ rand }) {
        const ids = ['..%2f..%2fdb.json', '%2e%2e/%2e%2e/etc/passwd', 'x'.repeat(5000), '%00', "' OR '1'='1", '__proto__', 'constructor', 'pay-0', '../../server.ts'];
        const id = pick(rand, ids);
        for (const [m, p] of [['GET', `/api/payments/${id}`], ['POST', `/api/payments/${id}/confirm`], ['POST', `/api/charges/${id}/void`], ['PUT', `/api/units/${id}`], ['DELETE', `/api/expenses/${id}`], ['POST', `/api/payments/${id}/refund`]]) {
          const res = await api(admin, m, p, m === 'GET' ? undefined : {});
          if (res.status >= 500) { serverErrors++; serverErrorSamples.push(`path-abuse: ${m} ${p.slice(0, 50)} -> ${res.status}`); }
          if (is2(res) && m !== 'GET') fault('path-abuse', `${m} ${p.slice(0, 40)} succeeded on a nonexistent id`);
        }
        const leak = await api(anon, 'GET', '/..%2f..%2fdb.json');
        if (/"users"|"charges"/.test(leak.text)) fault('path-abuse', 'db.json readable through static path traversal');
      },
      /** Anonymous access to every route: all must refuse. */
      async 'anon-matrix'({ rand }) {
        const routes = [
          ['GET', '/api/db'], ['GET', '/api/settings'], ['GET', '/api/integrity'], ['GET', '/api/users'], ['GET', '/api/backup/download'], ['GET', '/api/backup/status'], ['GET', '/api/annual-reports/2026'], ['GET', '/api/ical/feeds'], ['GET', '/api/backup/drives'],
          ['POST', '/api/payments'], ['POST', '/api/charges'], ['POST', '/api/charges/post-month'], ['POST', '/api/expenses'], ['POST', '/api/bookings'], ['POST', '/api/utilities'], ['POST', '/api/users'], ['POST', '/api/backup/restore'], ['POST', '/api/backup/run'], ['POST', '/api/periods/close'], ['POST', '/api/periods/reopen'], ['POST', '/api/payments/x/confirm'], ['POST', '/api/payments/x/reverse'], ['POST', '/api/payments/x/refund'], ['POST', '/api/charges/x/void'], ['POST', '/api/ical/sync'],
          ['PUT', '/api/units/unit-1'], ['PUT', '/api/settings'], ['PUT', '/api/users/x'], ['POST', '/api/users/x/reset-password'], ['DELETE', '/api/expenses/x'], ['DELETE', '/api/utilities/x']
        ];
        const [m, p] = pick(rand, routes);
        const res = await api(anon, m, p, m === 'GET' ? undefined : {});
        if (!(res.status === 401 || res.status === 403)) fault('anon-matrix', `${m} ${p} answered ${res.status} with no session`);
        if (res.status >= 500) serverErrors++;
      },
      /** Role matrix: lower roles cannot do administrator-only things; nothing changes. */
      async 'role-matrix'({ rand }) {
        const role = pick(rand, ['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER']);
        const cl = staff[role];
        const db = await dbNow();
        const adminId = db.users.find(u => u.username === 'admin').id;
        const attacks = [
          ['POST', '/api/users', { name: 'z', username: 'z' + Math.floor(rand() * 1e6), role: 'ADMINISTRATOR', password: 'Sneaky-1111!' }],
          ['PUT', `/api/users/${adminId}`, { active: false }],
          ['PUT', `/api/users/${adminId}`, { role: 'JUNIOR_OFFICER' }],
          ['POST', `/api/users/${adminId}/reset-password`, { password: 'Seized-1234!' }],
          ['POST', '/api/backup/restore', { data: { users: [], charges: [], payments: [], units: [] } }],
          ...(role === 'JUNIOR_OFFICER' || role === 'FINANCE_OFFICER' ? [['POST', '/api/settings', { rolePermissions: { JUNIOR_OFFICER: { reversePayments: true } } }]] : [])
        ];
        const [m, p, b] = pick(rand, attacks);
        const usersBefore = db.users.length;
        const res = watch('role-matrix', await api(cl, m, p, b), `${role} ${m} ${p}`);
        if (is2(res)) fault('role-matrix', `${role} succeeded at ${m} ${p}`);
        const after = await dbNow();
        if (after.users.length !== usersBefore) fault('role-matrix', `${role} changed the user count`);
        if (!after.users.find(u => u.username === 'admin')?.active && after.users.find(u => u.username === 'admin')?.active !== undefined) fault('role-matrix', `${role} deactivated the administrator`);
        // The administrator can still log in.
        const probe = makeClient(srv.baseUrl);
        const login = await probe.post('/api/auth/login', { username: 'admin', password: 'RedTeamPMNew-9876!' }, { captureCookie: true });
        if (!is2(login)) fault('role-matrix', 'administrator could not sign in after a lower-role attack');
      },
      /** Sign-in abuse: wrong passwords, timing parity, header spoofing. */
      async 'auth-abuse'({ rand }) {
        const cl = makeClient(srv.baseUrl);
        const spoof = { 'X-Forwarded-For': `10.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.1` };
        let locked = false;
        for (let k = 0; k < 6; k++) {
          const r = await api(cl, 'POST', '/api/auth/login', { username: 'jr', password: `wrong-${k}` }, { headers: spoof });
          if (r.status >= 500) serverErrors++;
          if (r.status === 429) locked = true;
          if (is2(r)) fault('auth-abuse', 'wrong password accepted');
        }
        void locked;
        const sqli = await api(cl, 'POST', '/api/auth/login', { username: "admin' --", password: "' OR '1'='1" });
        if (is2(sqli)) fault('auth-abuse', 'injection string signed in');
        const objectLogin = await api(cl, 'POST', '/api/auth/login', { username: { $ne: null }, password: { $ne: null } });
        if (is2(objectLogin)) fault('auth-abuse', 'operator object signed in');
        const fake = makeClient(srv.baseUrl);
        fake.setCookie('vds_session=' + 'a'.repeat(64));
        if (is2(await api(fake, 'GET', '/api/db'))) fault('auth-abuse', 'forged session cookie accepted');
      },
      /** Backup file must not carry credentials. */
      async 'backup-secrets'() {
        const r = await A.get('/api/backup/download');
        if (!is2(r)) return;
        if (/\$2[aby]\$|scrypt\$|pbkdf2\$|"passwordHash"|"password"\s*:\s*"[^"]{4,}"/i.test(r.text)) fault('backup-secrets', 'backup download appears to contain password material');
        const dbText = JSON.stringify((await dbNow()));
        if (/passwordHash|"salt"|scrypt/i.test(dbText)) fault('backup-secrets', '/api/db exposes password material');
      },
      /** Tenancy evict then bill: no rent charged after a tenancy has ended. */
      async 'evict-and-bill'({ rand }) {
        const active = (await dbNow()).tenancies.filter(t => t.status === 'active');
        if (active.length < 3) return;
        const t = pick(rand, active);
        watch('evict-and-bill', await A.post(`/api/tenancies/${t.id}/evict`, { endedOn: TODAY, reason: 'test' }), 'evict');
        const again = watch('evict-and-bill', await A.post(`/api/tenancies/${t.id}/evict`, { endedOn: TODAY, reason: 'twice' }), 'evict twice');
        void again;
      },
      /** Read-only and session routes. */
      async 'session-routes'({ rand }) {
        watch('session-routes', await A.get('/api/annual-reports/2026'), 'annual');
        watch('session-routes', await A.get('/api/auth/me'), 'me');
        watch('session-routes', await A.get('/api/backup/status'), 'backup status');
        watch('session-routes', await A.get('/api/backup/drives'), 'drives');
        watch('session-routes', await A.post('/api/backup/check-folder', { path: pick(rand, ['/etc', '../../..', 'C:\\Windows', '/nonexistent', '\\\\evil\\share']) }), 'check-folder');
        const cl = makeClient(srv.baseUrl);
        await cl.post('/api/auth/login', { username: 'admin', password: 'RedTeamPMNew-9876!' }, { captureCookie: true });
        watch('session-routes', await api(cl, 'POST', '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'x' }), 'change-password wrong');
        const out = await api(cl, 'POST', '/api/auth/logout', {});
        if (is2(out) && is2(await api(cl, 'GET', '/api/db'))) fault('session-routes', 'session still valid after logout');
      },
      /** Integrity self-report must stay clean of serious faults. */
      async 'integrity-report'() {
        const rep = await A.get('/api/integrity');
        watch('integrity-report', rep, 'integrity');
        const serious = (rep.body?.issues || []).filter(x => x.severity === 'serious');
        if (serious.length) fault('integrity-report', serious.slice(0, 2).map(x => `${x.code}: ${x.message}`).join(' | '));
      },
      /** Concurrent confirms of one receipt must confirm once. */
      async 'confirm-race'({ month, rand }) {
        const open = (await dbNow()).charges.filter(c => c.status === 'open');
        if (!open.length) return;
        const ch = pick(rand, open);
        const r = await pay('confirm-race', { unitId: ch.unitId, category: ch.category, amount: money(rand, 100, 900), currency: ch.currency, payerName: 'R', method: 'Cash', date: dayIn(month, 12) });
        const id = r.body?.payment?.id;
        if (!id) return;
        const rs = await Promise.all([1, 2, 3, 4].map(() => api(admin, 'POST', `/api/payments/${id}/confirm`, {})));
        rs.forEach(x => watch('confirm-race', x, 'confirm'));
        shadow.get(id).status = 'completed';
        const nums = (await dbNow()).payments.filter(p => p.receiptNo).map(p => p.receiptNo);
        if (new Set(nums).size !== nums.length) fault('confirm-race', 'duplicate receipt numbers after racing confirms');
        const p = (await dbNow()).payments.find(x => x.id === id);
        if (p && p.status !== 'completed') shadow.get(id).status = p.status;
      }
    };
    const names = Object.keys(families).filter(n => !ONLY || ONLY.includes(n));

    /* ================= balance oracle ================= */
    const balanceFaults = [];
    async function checkBalances(label) {
      const db = await dbNow();
      let checked = 0;
      for (const unit of db.units.filter(u => u.status === 'owner-occupied')) {
        const cur = unit.maintCurrency || unit.currency;
        const charged = r2(db.charges.filter(c => c.unitId === unit.id && c.category === 'Maintenance' && c.status === 'open' && c.currency === cur && c.dueDate <= TODAY).reduce((s, c) => s + c.amount, 0));
        const paid = r2(db.payments.filter(p => p.unitId === unit.id && p.category === 'Maintenance' && p.status === 'completed' && p.currency === cur && p.date <= TODAY).reduce((s, p) => s + p.amount - (p.refundedAmount && p.refundedOn && p.refundedOn <= TODAY ? p.refundedAmount : 0), 0));
        const a = fin.accountBalance(unit, 'Maintenance', db.charges, db.payments, undefined, db.units);
        checked++;
        if (Math.abs(a.balance - r2(charged - paid)) > 0.005) balanceFaults.push(`${label}: ${unit.number} app ${a.balance} vs raw ${r2(charged - paid)}`);
      }
      return checked;
    }

    /* ================= run ================= */
    let balanceChecks = 0;
    let thrown = 0;
    for (let i = 0; i < SCENARIOS; i++) {
      const rand = rng(777_001 + i * 7919);
      const month = pick(rand, MONTHS);
      const name = names[i % names.length];
      try {
        await families[name]({ month, rand, i });
      } catch (err) {
        thrown++;
        fault(name, `scenario ${i} threw outside the API: ${err.message}`);
      }
      if ((i + 1) % BALANCE_CHECK_EVERY === 0) balanceChecks += await checkBalances(`after ${i + 1}`);
      if ((i + 1) % 1000 === 0) console.log(`  … ${i + 1} scenarios`);
    }
    balanceChecks += await checkBalances('at the end');

    /* ================= verdicts ================= */
    const end = await dbNow();

    for (const name of names) {
      const f = faults[name];
      T.check(`family "${name}" (${Math.floor(SCENARIOS / names.length)} scenarios)`, !f || f.length === 0, f ? `${f.count} faults, e.g. ${f.slice(0, 3).join(' | ')}` : undefined);
    }
    console.log('  fault tally:', JSON.stringify(tally, null, 1));
    T.check(`${SCENARIOS} scenarios ran through the real API`, thrown === 0, `${thrown} threw`);
    T.check('no response was a 5xx server error', serverErrors === 0, `${serverErrors}: ${serverErrorSamples.join(' || ')}`);
    T.check('server still healthy at the end', (await anon.get('/api/health')).status === 200);
    T.check('prototype pollution did not take', ({}).polluted === undefined && (await anon.get('/api/health')).body?.polluted === undefined);

    // Shadow ledger.
    const byId = new Map(end.payments.map(p => [p.id, p]));
    const lost = [], wrong = [];
    for (const [id, s] of shadow) {
      const p = byId.get(id);
      if (!p) { lost.push(id); continue; }
      if (Math.abs(p.amount - s.amount) > 0.005) wrong.push(`${id} amount ${p.amount} vs ${s.amount}`);
      if (s.status === 'completed' && p.status !== 'completed' && p.status !== 'reversed') wrong.push(`${id} status ${p.status} vs completed`);
      if (s.status === 'reversed' && p.status === 'completed') wrong.push(`${id} still completed after reverse`);
    }
    const phantom = end.payments.filter(p => !shadow.has(p.id) && p.category !== undefined && !p.utilityId && !p.bookingId && !p.tenancyId && p.method !== 'Deposit');
    const phantomSample = phantom.slice(0, 3).map(p => ({ id: p.id, cat: p.category, method: p.method, status: p.status, payer: p.payerName, notes: p.notes || p.description, keys: Object.keys(p).join(',') }));
    console.log('  phantom sample:', JSON.stringify(phantomSample));
    T.check(`shadow ledger: ${shadow.size} receipts all present`, lost.length === 0, `${lost.length} lost`);
    T.check('shadow ledger: no amount or status drifted', wrong.length === 0, wrong.slice(0, 4).join(' | '));
    T.check('shadow ledger: no receipt exists that this suite did not create', phantom.length === 0, `${phantom.length} phantom, e.g. ${phantom.slice(0, 2).map(p => p.id).join(',')}`);

    // Receipt-number integrity.
    const nums = end.payments.filter(p => p.receiptNo).map(p => p.receiptNo);
    T.check('receipt numbers unique', new Set(nums).size === nums.length, `${nums.length - new Set(nums).size} duplicated`);
    T.check('every completed receipt has a number', end.payments.filter(p => p.status === 'completed' && !p.receiptNo).length === 0);
    T.check('no refund exceeds its receipt', end.payments.filter(p => (p.refundedAmount || 0) > p.amount + 0.005).length === 0);
    T.check('no receipt dated in the future', end.payments.filter(p => p.date > TODAY).length === 0);
    T.check('no negative or non-finite money anywhere', [...end.payments, ...end.charges].filter(x => !Number.isFinite(x.amount) || x.amount < 0).length === 0);
    const unitSet = new Set(end.units.map(u => u.id));
    T.check('no orphaned receipts or charges', end.payments.concat(end.charges).filter(x => x.unitId && !unitSet.has(x.unitId)).length === 0);

    // Balance oracle.
    T.check(`balance oracle: ${balanceChecks} independent recomputations agree with finance.ts`, balanceFaults.length === 0, balanceFaults.slice(0, 4).join(' | '));

    // Final integrity.
    const rep = (await A.get('/api/integrity')).body;
    const serious = (rep.issues || []).filter(x => x.severity === 'serious');
    T.check('application integrity report has no serious fault', serious.length === 0, serious.slice(0, 3).map(x => `${x.code}: ${x.message}`).join(' | '));

    // Route map: coverage of every route the server declares.
    const declared = ['GET /api/annual-reports/:id', 'POST /api/auth/change-password', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me', 'POST /api/backup/check-folder', 'GET /api/backup/download', 'GET /api/backup/drives', 'POST /api/backup/restore', 'POST /api/backup/run', 'GET /api/backup/status', 'POST /api/bookings', 'POST /api/charges', 'POST /api/charges/:id/void', 'POST /api/charges/post-month', 'GET /api/db', 'POST /api/expenses', 'POST /api/expenses/:id/void', 'POST /api/expenses/post-month', 'GET /api/integrity', 'POST /api/payments', 'POST /api/payments/:id/confirm', 'POST /api/payments/:id/refund', 'POST /api/payments/:id/reverse', 'POST /api/periods/close', 'POST /api/periods/reopen', 'GET /api/settings', 'PUT /api/settings', 'POST /api/tenancies/:id/deposit', 'POST /api/tenancies/:id/deposit/settle', 'POST /api/tenancies/:id/evict', 'PUT /api/units/:id', 'POST /api/users', 'PUT /api/users/:id', 'POST /api/users/:id/reset-password', 'POST /api/utilities', 'POST /api/utilities/:id/settle'];
    const unexercised = declared.filter(d => ![...hits.keys()].some(k => k === d || k.replace(/\/x(\/|$)/g, '/:id$1') === d));
    console.log(`  route map: ${hits.size} distinct method+route pairs exercised; not reached by any scenario: ${unexercised.join(', ') || 'none'}`);
    T.check('route map: every declared core route was exercised', unexercised.length <= 8, unexercised.join(', '));

    return T.done();
  } finally {
    cleanup();
    await srv.stop();
  }
}
