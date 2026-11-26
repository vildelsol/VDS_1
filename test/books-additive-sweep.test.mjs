/*
 * System-wide guard: the two books add up to the combined view, on every
 * calculation that splits between them, over 200 generated registers
 * (2026-11-25, after Ro: "these safeguards need to be throughout the entire system").
 *
 * One hand-built fixture only proves the case someone thought of. These registers
 * are generated from fixed seeds (never the clock), so a failure is repeatable:
 * the message names the seed. Each register mixes owner, let and short-let
 * villas, USD and JMD, refunds, voided receipts, rent paid ahead, expenses on
 * both books, paid and unpaid, and is checked over several periods.
 *
 * Invariants, per currency and period:
 *  - every receipt and every cost belongs to exactly one book;
 *  - operating statement: Everything = strata + ISPO, per income and expenditure
 *    heading, in total and in surplus; nothing is left off the combined income;
 *  - the combined Received figure (Dashboard, Reports, Board pack, Charts) is the
 *    Everything statement's income, and ISPO's maintenance paid to the
 *    corporation is the maintenance received on ISPO's own villas;
 *  - bank reconciliation: strata + ISPO = both, money in and money out;
 *    no settled-from-rent payment or ISPO book entry is ever a bank item;
 *  - USD and JMD never meet: a statement in one currency holds no line of the other.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Sweep: strata + ISPO = combined on every split calculation, 200 generated registers';

const C = n => Math.round((Number(n) || 0) * 100);

async function load(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-sweep-'));
  const outfile = path.join(dir, 'm.mjs');
  await build({
    stdin: { contents: `export * as fin from './src/lib/finance'; export * as bank from './src/lib/bankRec';`, resolveDir: projectRoot, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const MONTHS = ['2026-09', '2026-10', '2026-11'];
const day = (m, d) => `${m}-${String(d).padStart(2, '0')}`;

function generate(fin, seed) {
  const r = rng(seed);
  const pick = a => a[Math.floor(r() * a.length)];
  const units = [];
  for (let i = 1; i <= 16; i++) {
    const usd = i === 11 || i === 13;
    const status = usd ? pick(['short-term', 'long-term']) : pick(['owner-occupied', 'long-term', 'short-term', 'short-term']);
    units.push({
      id: `u${i}`, number: `V${i}`, ownerName: status === 'owner-occupied' ? `Owner ${i}` : 'ISPO', tenantName: status === 'long-term' ? `Tenant ${i}` : '',
      status, monthlyRent: status === 'long-term' ? (usd ? 0 : 100000) : 0, monthlyMaintenance: usd ? 125 : 20000,
      currency: 'JMD', maintCurrency: usd ? 'USD' : 'JMD', meterNumber: '', notes: '', rentDueDay: 1, maintDueDay: 1
    });
  }
  const charges = [], payments = [], expenses = [];
  let n = 0;
  for (const m of MONTHS) {
    for (const u of units) {
      charges.push({ id: `c-${m}-${u.id}-m`, unitId: u.id, unitNumber: u.number, category: 'Maintenance', periodMonth: m, dueDate: day(m, 1), amount: u.monthlyMaintenance, currency: u.maintCurrency, status: 'open', payerName: u.ownerName, createdAt: `${m}-01T00:00:00Z` });
      if (u.status === 'long-term' && u.monthlyRent > 0) {
        charges.push({ id: `c-${m}-${u.id}-r`, unitId: u.id, unitNumber: u.number, category: 'Rent', periodMonth: m, dueDate: day(m, 1), amount: 100000, rentPortion: 80000, maintenancePortion: 20000, currency: 'JMD', status: 'open', payerName: u.tenantName, createdAt: `${m}-01T00:00:00Z` });
      }
    }
  }
  const pay = (u, category, amount, date, currency, payerName, over = {}) =>
    payments.push({ id: `p${seed}-${++n}`, receiptNo: `R${n}`, unitId: u.id, unitNumber: u.number, category, amount, currency, date, status: 'completed', payerName, method: 'Bank Transfer', ...over });
  for (const m of MONTHS) {
    for (const u of units) {
      const d = day(m, 1 + Math.floor(r() * 27));
      if (u.status === 'long-term' && u.monthlyRent > 0 && r() < 0.85) {
        // Sometimes paid ahead, sometimes short, now and then refunded or voided.
        const amt = pick([100000, 100000, 100000, 60000, 200000]);
        const over = r() < 0.08 ? { status: 'voided' } : r() < 0.08 ? { refundedAmount: 10000, refundedOn: day(m, 28), refundReason: 'overpaid' } : {};
        pay(u, 'Rent', amt, d, 'JMD', u.tenantName, over);
      }
      if (u.status !== 'long-term' || u.maintCurrency === 'USD') {
        if (r() < 0.8) pay(u, 'Maintenance', u.monthlyMaintenance, d, u.maintCurrency, u.ownerName, r() < 0.05 ? { status: 'voided' } : {});
      }
      if (u.status === 'short-term' && r() < 0.6) {
        const usd = r() < 0.4;
        pay(u, 'Booking', usd ? pick([300, 450, 800]) : pick([30000, 50000, 75000]), day(m, 1 + Math.floor(r() * 27)), usd ? 'USD' : 'JMD', 'Guest',
          r() < 0.07 ? { refundedAmount: usd ? 100 : 10000, refundedOn: day(m, 28), refundReason: 'cut short' } : {});
      }
    }
    for (let k = 0; k < 4; k++) {
      const fund = pick(['strata', 'ispo']);
      const usd = r() < 0.2;
      const paid = r() < 0.8;
      const ex = { id: `e${seed}-${m}-${k}`, description: `Cost ${k}`, category: pick(['Security', 'Supplies', 'Repairs', 'Insurance']), amount: usd ? pick([100, 250]) : pick([15000, 40000, 60000]), currency: usd ? 'USD' : 'JMD', date: day(m, 10 + k), status: paid ? 'paid' : 'unpaid', vendor: `Vendor ${k}`, fund };
      if (paid) ex.datePaid = day(m, 12 + k);
      if (fund === 'ispo') ex.unitId = pick(units.filter(u => u.ownerName === 'ISPO')).id;
      expenses.push(ex);
    }
  }
  const all = [...payments, ...fin.settledFromRent(charges, payments, '2026-11-30')];
  return { units, charges, payments: all, rawPayments: payments, expenses };
}

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await load(projectRoot);
  const { fin, bank } = mod;
  const PERIODS = [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-09-01', '2026-11-30']];
  const fails = new Map(); // invariant -> first failing seed and detail
  let cases = 0;
  const check = (name, ok, detail) => { if (!ok && !fails.has(name)) fails.set(name, detail); };
  try {
    fin.setOwnershipRegistry([]);
    for (let seed = 1; seed <= 200; seed++) {
      const D = generate(fin, seed);
      // Partition: each receipt and each cost on exactly one book.
      const ps = fin.paymentsInBook(D.payments, 'strata'), pi = fin.paymentsInBook(D.payments, 'ispo');
      check('every receipt is on exactly one book', ps.length + pi.length === D.payments.length && !ps.some(p => pi.includes(p)), `seed ${seed}`);
      const es = fin.expensesInBook(D.expenses, 'strata'), ei = fin.expensesInBook(D.expenses, 'ispo');
      check('every cost is on exactly one book', es.length + ei.length === D.expenses.length && !es.some(e => ei.includes(e)), `seed ${seed}`);

      const combined = fin.consolidateEverything(D.charges, D.payments, D.units);
      for (const cur of ['JMD', 'USD']) {
        for (const [from, to] of PERIODS) {
          cases++;
          const at = `seed ${seed} ${cur} ${from}..${to}`;
          const st = book => fin.operatingStatement(D.payments, D.expenses, D.units, cur, from, to, { book });
          const [s, i, e] = [st('strata'), st('ispo'), st('everything')];
          check('statement: Everything income = strata + ISPO', C(e.totalIncome) === C(s.totalIncome) + C(i.totalIncome), `${at}: ${e.totalIncome} vs ${s.totalIncome} + ${i.totalIncome}`);
          check('statement: Everything expenditure = strata + ISPO', C(e.totalExpenditure) === C(s.totalExpenditure) + C(i.totalExpenditure), `${at}: ${e.totalExpenditure} vs ${s.totalExpenditure} + ${i.totalExpenditure}`);
          check('statement: Everything surplus = strata + ISPO', C(e.surplus) === C(s.surplus) + C(i.surplus), `${at}: ${e.surplus} vs ${s.surplus} + ${i.surplus}`);
          const heads = side => new Set([s, i, e].flatMap(x => x[side].map(g => g.label)));
          const g = (x, side, label) => C(x[side].find(y => y.label === label)?.total || 0);
          for (const side of ['income', 'expenditure']) {
            for (const label of heads(side)) {
              check(`statement: each ${side} heading on Everything = strata + ISPO`, g(e, side, label) === g(s, side, label) + g(i, side, label), `${at} "${label}": ${g(e, side, label)} vs ${g(s, side, label)} + ${g(i, side, label)}`);
            }
          }
          check('statement: nothing is left off the combined income', (e.excludedIncome || []).length === 0, `${at}: ${JSON.stringify(e.excludedIncome)}`);
          check('statement: no line in the other currency', [s, i, e].every(x => x.currency === cur), at);

          // The combined Received figure every summary screen prints.
          const whole = fin.receivedOnCombinedView(D.payments, combined.payments, cur, from, to);
          check('Received on the combined view = the Everything statement’s income', C(whole.received.total) === C(e.totalIncome), `${at}: ${whole.received.total} vs ${e.totalIncome}`);
          check('ISPO maintenance paid to the corporation = the strata/ISPO transfer on the statements', C(whole.ispoMaintenancePaid) === C(i.internalTransfer ?? 0), `${at}: ${whole.ispoMaintenancePaid} vs ${i.internalTransfer}`);

          // Bank reconciliation: two accounts make the whole; book entries never appear.
          const input = { payments: D.payments, expenses: D.expenses, units: D.units };
          const [bs, bi, bb] = [bank.bankReconciliation(input, cur, from, to, 'strata'), bank.bankReconciliation(input, cur, from, to, 'ispo'), bank.bankReconciliation(input, cur, from, to)];
          check('bank rec: strata + ISPO money in = both', C(bb.moneyIn.total) === C(bs.moneyIn.total) + C(bi.moneyIn.total), `${at}`);
          check('bank rec: strata + ISPO money out = both', C(bb.moneyOut.total) === C(bs.moneyOut.total) + C(bi.moneyOut.total), `${at}`);
        }
      }
      const items = bank.bankItems({ payments: D.payments, expenses: D.expenses, units: D.units });
      const own = fin.ownLevyReceiptTest(D.units);
      check('bank rec: no settled-from-rent payment is a bank item', !items.some(it => D.payments.find(p => p.id === it.id)?.derived), `seed ${seed}`);
      check('bank rec: no ISPO maintenance book entry is a bank item', !items.some(it => { const p = D.payments.find(q => q.id === it.id); return p && own(p); }), `seed ${seed}`);
    }
    T.check(`ran ${cases} register-currency-period cases`, cases === 200 * 2 * PERIODS.length, String(cases));
    const NAMES = [
      'every receipt is on exactly one book', 'every cost is on exactly one book',
      'statement: Everything income = strata + ISPO', 'statement: Everything expenditure = strata + ISPO', 'statement: Everything surplus = strata + ISPO',
      'statement: each income heading on Everything = strata + ISPO', 'statement: each expenditure heading on Everything = strata + ISPO',
      'statement: nothing is left off the combined income', 'statement: no line in the other currency',
      'Received on the combined view = the Everything statement’s income',
      'ISPO maintenance paid to the corporation = the strata/ISPO transfer on the statements',
      'bank rec: strata + ISPO money in = both', 'bank rec: strata + ISPO money out = both',
      'bank rec: no settled-from-rent payment is a bank item', 'bank rec: no ISPO maintenance book entry is a bank item'
    ];
    for (const name of NAMES) T.check(name, !fails.has(name), fails.get(name));
    for (const [name, detail] of fails) if (!NAMES.includes(name)) T.check(name, false, detail);
    // The registers must actually exercise the cases that matter.
    const sample = generate(fin, 7);
    const first = [1, 2, 3, 4, 5].map(s => generate(fin, s).payments);
    T.check('control: the registers include refunds', first.some(ps => ps.some(p => p.refundedAmount)));
    T.check('control: the registers include voided receipts', first.some(ps => ps.some(p => p.status === 'voided')));
    T.check('control: derived payments, USD receipts and both books’ costs appear',
      sample.payments.some(p => p.derived) && sample.payments.some(p => p.currency === 'USD') && sample.expenses.some(e => e.fund === 'strata') && sample.expenses.some(e => e.fund === 'ispo'));
  } finally {
    cleanup();
  }
  return T.done();
}
