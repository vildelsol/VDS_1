/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The combined ("Everything") book ties to the Dashboard, villa by villa.
 *
 * QA simulation, 2026-11-19, on a register shaped like the real one (11 villas
 * ISPO owns, J$20,000 / US$125 levy each):
 *
 *   1. `consolidateEverything` dropped ISPO's levy RECEIPTS as transfers between
 *      the two books but kept the levy CHARGES, so every villa ISPO had paid up
 *      read as owing on the default Reports book: J$545,000 receivable beside the
 *      Dashboard's J$205,000 (US$375 beside nil), "14 accounts, 11 over 60 days"
 *      against a truth of 3 and none, October collected 49.46% beside 72.46%.
 *   2. It paired BOTH rent charges of a new tenancy's first month (the month and
 *      the last month held in advance) with the one levy charge, taking the levy
 *      out twice: C15's September billed J$140,000 instead of J$160,000.
 *   3. The Dashboard printed "Total billed J$465,000" beside 46.38%, which was a
 *      rate of J$345,000.
 *
 * Pure in-memory fixtures; every figure is computed through the functions the
 * screens call, and the Reports screen itself is rendered for its receivable.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Combined book ties to the Dashboard and counts ISPO\'s levy once';

const FROM = '2026-10-01';
const TO = '2026-10-31';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-combined-ties-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export * as fin from './src/lib/finance';
        export * as obs from './src/lib/observations';
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export { default as Reports } from './src/components/Reports';
        export { remember, forgetScreenState } from './src/lib/screenState';
        export { setReportRange, resetReportRange } from './src/lib/reportRange';
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

const unit = (id, over = {}) => ({
  id,
  number: id.toUpperCase(),
  ownerName: 'ISPO',
  ownerEmail: '',
  ownerPhone: '',
  tenantName: '',
  tenantEmail: '',
  tenantPhone: '',
  status: 'short-term',
  monthlyRent: 0,
  monthlyMaintenance: 20000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});
const charge = (u, category, month, amount, over = {}) => ({
  id: `chg-${month}-${u.id}-${category.toLowerCase()}${over.kind ? '-advance' : ''}`,
  unitId: u.id,
  unitNumber: u.number,
  category,
  periodMonth: month,
  dueDate: `${month}-01`,
  amount,
  currency: category === 'Maintenance' ? u.maintCurrency || u.currency : u.currency,
  status: 'open',
  payerName: category === 'Rent' ? u.tenantName : u.ownerName,
  createdAt: `${month}-01T00:00:00Z`,
  createdBy: 'test',
  ...over
});
let receipt = 0;
const pay = (u, category, amount, date, over = {}) => ({
  id: `pay-${++receipt}`,
  receiptNo: `R${receipt}`,
  payerName: category === 'Rent' ? u.tenantName : u.ownerName,
  unitId: u.id,
  unitNumber: u.number,
  category,
  amount,
  currency: category === 'Maintenance' ? u.maintCurrency || u.currency : u.currency,
  date,
  method: 'Bank Transfer',
  reference: '',
  notes: '',
  staffMember: 'test',
  status: 'completed',
  ...over
});
const tenancy = (u, startedOn) => ({
  id: `t-${u.id}`,
  unitId: u.id,
  unitNumber: u.number,
  tenantName: u.tenantName,
  tenantEmail: '',
  tenantPhone: '',
  emergencyName: '',
  emergencyPhone: '',
  emergencyEmail: '',
  monthlyRent: u.monthlyRent,
  currency: u.currency,
  rentDueDay: 1,
  startedOn,
  status: 'active',
  recordedBy: 'test',
  recordedAt: `${startedOn}T00:00:00Z`
});

/**
 * Six villas, September and October 2026.
 *   s1  ISPO's, short-let, levy paid by hand both months.
 *   s2  ISPO's, short-let, USD levy US$125 paid by hand both months.
 *   l1  ISPO's, let at J$75,000 (J$20,000 levy inside), paid both months.
 *   l2  ISPO's, let at J$75,000, tenant paid September only: owes October.
 *   n1  ISPO's, new tenancy from 1 October at J$80,000: October's rent plus
 *       the last month held in advance, J$160,000, paid in full.
 *   p1  a private proprietor's, levy paid September only: owes October.
 * Truth at 31 October: J$95,000 owed (l2 J$75,000 + p1 J$20,000), US$ nil,
 * 2 accounts, none older than 30 days.
 */
function fixture(fin) {
  const s1 = unit('s1');
  const s2 = unit('s2', { currency: 'USD', maintCurrency: 'USD', monthlyMaintenance: 125 });
  const l1 = unit('l1', { status: 'long-term', tenantName: 'Tenant L1', monthlyRent: 75000 });
  const l2 = unit('l2', { status: 'long-term', tenantName: 'Tenant L2', monthlyRent: 75000 });
  const n1 = unit('n1', { status: 'long-term', tenantName: 'Tenant N1', monthlyRent: 80000 });
  const p1 = unit('p1', { status: 'owner-occupied', ownerName: 'Proprietor P1' });
  const units = [s1, s2, l1, l2, n1, p1];
  const split = rent => ({ rentPortion: rent - 20000, maintenancePortion: 20000 });
  const charges = [];
  for (const m of ['2026-09', '2026-10']) {
    for (const u of [s1, s2, l1, l2, p1]) charges.push(charge(u, 'Maintenance', m, u.monthlyMaintenance));
    for (const u of [l1, l2]) charges.push(charge(u, 'Rent', m, 75000, split(75000)));
  }
  charges.push(
    charge(n1, 'Rent', '2026-10', 80000, split(80000)),
    charge(n1, 'Rent', '2026-10', 80000, { ...split(80000), kind: 'advance-final-month', description: "Last month's rent, held in advance" }),
    charge(n1, 'Maintenance', '2026-10', 20000)
  );
  const payments = [
    pay(s1, 'Maintenance', 20000, '2026-09-08', { payerName: 'ISPO' }),
    pay(s1, 'Maintenance', 20000, '2026-10-08', { payerName: 'ISPO' }),
    pay(s2, 'Maintenance', 125, '2026-09-08', { payerName: 'ISPO' }),
    pay(s2, 'Maintenance', 125, '2026-10-08', { payerName: 'ISPO' }),
    pay(l1, 'Rent', 75000, '2026-09-03'),
    pay(l1, 'Rent', 75000, '2026-10-03'),
    pay(l2, 'Rent', 75000, '2026-09-03'),
    pay(n1, 'Rent', 160000, '2026-10-01'),
    pay(p1, 'Maintenance', 20000, '2026-09-05')
  ];
  // As every screen is given them (App.tsx): the levy settled out of rent.
  payments.push(...fin.settledFromRent(charges, payments));
  const tenancies = [tenancy(l1, '2026-01-01'), tenancy(l2, '2026-01-01'), tenancy(n1, '2026-10-01')];
  return { units, charges, payments, tenancies, bookings: [], expenses: [], utilities: [] };
}

const cents = n => Math.round(n * 100);

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { fin, obs, React, renderToStaticMarkup, Reports, remember, forgetScreenState, setReportRange, resetReportRange } = mod;
  try {
    const data = fixture(fin);
    const { units, charges, payments } = data;

    /* What the Reports summary computes on the Everything book (Reports.tsx). */
    const combined = fin.consolidateEverything(charges, payments, units);
    const bookCharges = fin.chargesInBook(combined.charges, 'everything');
    const bookPayments = fin.paymentsInBook(combined.payments, 'everything');
    const reportsClosing = cur =>
      units
        .flatMap(u => fin.chargeCategoriesInBook('everything').map(cat => fin.accountBalance(u, cat, bookCharges, bookPayments, TO, units)))
        .filter(a => a.currency === cur)
        .reduce((s, a) => s + cents(a.balance), 0);
    /* What the Dashboard shows as arrears (Dashboard.tsx: delinquentAccounts on the raw books). */
    const dashArrears = cur => fin.delinquentAccounts(units, charges, payments, TO).filter(a => a.currency === cur).reduce((s, a) => s + cents(a.balance), 0);
    const input = cur => ({ ...data, currency: cur, from: '2026-09-01', to: TO, book: 'everything' });

    /* ---- 1. one receivable, wherever it is read ---- */
    for (const cur of ['JMD', 'USD']) {
      const owing = obs.accountsOwing(input(cur));
      const perAccount = owing.reduce((s, a) => s + cents(a.balance), 0);
      const board = cents(fin.receivableAsOf(units, charges, payments, TO, cur));
      T.check(`${cur}: Reports (Everything) closing receivable equals the Dashboard's arrears`, reportsClosing(cur) === dashArrears(cur), `${reportsClosing(cur) / 100} vs ${dashArrears(cur) / 100}`);
      T.check(`${cur}: and equals the sum of the per-account balances`, perAccount === reportsClosing(cur), `${perAccount / 100} vs ${reportsClosing(cur) / 100}`);
      T.check(`${cur}: and equals the board pack's receivable`, board === reportsClosing(cur), `${board / 100} vs ${reportsClosing(cur) / 100}`);
    }
    T.check('JMD: the receivable is the truth, J$95,000 (L2 rent J$75,000 + P1 levy J$20,000)', reportsClosing('JMD') === 9500000, String(reportsClosing('JMD') / 100));
    T.check('USD: ISPO\'s paid US$ levy leaves nothing receivable', reportsClosing('USD') === 0, String(reportsClosing('USD') / 100));

    /* ---- 2. ISPO's paid levy never reads as owed on the combined book ---- */
    const owingJ = obs.accountsOwing(input('JMD')).filter(a => a.balance > 0);
    T.check('two accounts owe, L2 and P1, and no other', owingJ.map(a => a.unit.id).sort().join(',') === 'l2,p1', owingJ.map(a => `${a.unit.id}:${a.balance}`).join(' '));
    T.check('none is older than 30 days', owingJ.every(a => a.oldestDays <= 30), owingJ.map(a => `${a.unit.id}:${a.oldestDays}`).join(' '));
    T.check('no unpaid line is ISPO\'s own levy marked paid', !owingJ.some(a => a.unpaid.some(u => u.paidByIspo)));
    for (const id of ['s1', 'l1', 'n1']) {
      const u = units.find(x => x.id === id);
      const bal = fin.chargeCategoriesInBook('everything').map(cat => fin.accountBalance(u, cat, bookCharges, bookPayments, TO, units).balance);
      T.check(`${id}: every account reads nil on the combined book`, bal.every(b => cents(b) === 0), bal.join(','));
    }
    for (const cur of ['JMD', 'USD']) {
      const flat = obs.observationsFor(input(cur), { closingReceivable: reportsClosing(cur) / 100 }).flatMap(o => [o.text, ...(o.details || [])]);
      T.check(`${cur}: the "Does not tie" guard is silent (nothing left not to tie)`, !flat.some(d => /Does not tie/.test(d)), flat.filter(d => /Does not tie/.test(d)).join(' | '));
    }
    // The guard still fires when given a figure that does not tie.
    const forced = obs.observationsFor(input('JMD'), { closingReceivable: 545000 }).flatMap(o => o.details || []);
    T.check('the guard still names a receivable that does not tie', forced.some(d => /^Does not tie: "Receivable at end of period" reads J\$545,000\.00/.test(d)), forced.join(' | '));

    /* ---- 3. a new tenancy's first month counts the levy once ---- */
    const n1Oct = fin.chargedInPeriod(combined.charges.filter(c => c.unitId === 'n1'), 'JMD', FROM, TO).total;
    T.check('N1 October billed on the combined book is the J$160,000 the tenant was asked for', cents(n1Oct) === 16000000, String(n1Oct));
    const n1Credit = fin.chargeCategoriesInBook('everything').map(cat => fin.accountBalance(units.find(u => u.id === 'n1'), cat, bookCharges, bookPayments, TO, units).balance);
    T.check('and the tenant is not shown in credit', n1Credit.every(b => cents(b) >= 0), n1Credit.join(','));
    // A villa somebody else owns, let with a split: the pairing consumes the levy once.
    const p2 = unit('p2', { status: 'owner-occupied', ownerName: 'Proprietor P2', tenantName: 'Sub Tenant', monthlyRent: 80000 });
    const p2Charges = [
      charge(p2, 'Rent', '2026-10', 80000, { rentPortion: 60000, maintenancePortion: 20000 }),
      charge(p2, 'Rent', '2026-10', 80000, { rentPortion: 60000, maintenancePortion: 20000, kind: 'advance-final-month' }),
      charge(p2, 'Maintenance', '2026-10', 20000)
    ];
    const p2Billed = fin.chargedInPeriod(fin.consolidateEverything(p2Charges, [], [p2]).charges, 'JMD', FROM, TO).total;
    T.check('a proprietor\'s let villa: one levy pairs with one rent charge (J$160,000, not J$140,000)', cents(p2Billed) === 16000000, String(p2Billed));

    /* ---- 4. the Dashboard rate is a rate of the billed figure printed beside it ---- */
    // Billed (Ro, 2026-11-24): maintenance only, every villa's, ISPO's included. Rent is shown whole, apart, never added in.
    for (const cur of ['JMD', 'USD']) {
      const printedBilled = fin.billedOnCombinedView(charges, cur, FROM, TO).total;
      const s = fin.combinedSettledOfBilled(charges, payments, units, cur, FROM, TO);
      T.check(`${cur}: "Maintenance billed" printed equals the base the rate is of`, cents(printedBilled) === cents(s.billed), `${printedBilled} vs ${s.billed}`);
      T.check(`${cur}: the rate equals settled / printed billed`, s.rate === (printedBilled > 0 ? fin.collectionRate(printedBilled, s.settled) : null), `${s.rate} vs ${s.settled}/${printedBilled}`);
    }
    const octBilled = fin.billedOnCombinedView(charges, 'JMD', FROM, TO);
    // Maintenance: s1 l1 l2 n1 p1 = 5 x 20,000. Rent whole: l1 75k + l2 75k + n1 80k + n1 advance 80k = 310k.
    T.check('JMD October: maintenance billed J$100,000 on all five villas, ISPO\'s included', cents(octBilled.maintenance) === 10000000 && cents(octBilled.total) === 10000000, JSON.stringify(octBilled));
    T.check('JMD October: rent charged shown whole, J$310,000, and not added into billed', cents(octBilled.rent) === 31000000, JSON.stringify(octBilled));
    const usdBilled = fin.billedOnCombinedView(charges, 'USD', FROM, TO);
    T.check('USD October: ISPO\'s US$125 maintenance on s2 is billed, not dropped', cents(usdBilled.maintenance) === 12500 && cents(usdBilled.total) === 12500, JSON.stringify(usdBilled));
    const oct = fin.combinedSettledOfBilled(charges, payments, units, 'JMD', FROM, TO);
    // Settled: s1 (ISPO by hand), l1 and n1 (out of rent); not l2 (rent unpaid) nor p1 (unpaid) = 60,000 of 100,000.
    T.check('JMD October: J$100,000 maintenance billed, J$60,000 of it settled, 60%', cents(oct.billed) === 10000000 && cents(oct.settled) === 6000000 && oct.rate === 60, JSON.stringify(oct));
    const octUsd = fin.combinedSettledOfBilled(charges, payments, units, 'USD', FROM, TO);
    T.check('USD October: US$125 billed, US$125 settled, 100%', cents(octUsd.billed) === 12500 && cents(octUsd.settled) === 12500 && octUsd.rate === 100, JSON.stringify(octUsd));
    {
      const r = fin.receivedOnCombinedView(payments, combined.payments, 'JMD', FROM, TO);
      // Rent whole: l1 75k + n1 160k = 235k. Maintenance: s1 20k + l1 20k + n1 20k out of rent = 60k, all ISPO's, also paid out.
      T.check('Received JMD October: rent whole J$235,000', cents(r.received.rent) === 23500000, JSON.stringify(r));
      T.check('Received JMD October: maintenance whole J$60,000, all of it ISPO paying the corporation', cents(r.received.maintenance) === 6000000 && cents(r.ispoMaintenancePaid) === 6000000, JSON.stringify(r));
      T.check('Net JMD October: received less ISPO maintenance paid = the cash from outside, J$235,000',
        cents(r.received.total - r.ispoMaintenancePaid) === 23500000 && cents(r.received.total - r.ispoMaintenancePaid) === cents(fin.collectedInPeriod(combined.payments, 'JMD', FROM, TO).total));
    }

    /* ---- 5. Ro's arithmetic on the real register's shape: 16 villas ---- */
    {
      const ro = [];
      const owners = ['a2', 'b7', 'b8', 'b9', 'c12'].map(id => unit(id, { status: 'owner-occupied', ownerName: `Owner ${id}` }));
      const let3 = ['a5', 'b10', 'c15'].map(id => unit(id, { status: 'long-term', tenantName: `Tenant ${id}`, monthlyRent: 100000 }));
      const short6 = ['a1', 'a3', 'a4', 'b6', 'c14', 'c16'].map(id => unit(id));
      const usd2 = ['c11', 'c13'].map(id => unit(id, { maintCurrency: 'USD', monthlyMaintenance: 125 }));
      const all = [...owners, ...let3, ...short6, ...usd2];
      for (const u of all) ro.push(charge(u, 'Maintenance', '2026-10', u.monthlyMaintenance));
      for (const u of let3) ro.push(charge(u, 'Rent', '2026-10', 100000, { rentPortion: 80000, maintenancePortion: 20000 }));
      T.check('register: 16 villas, 14 on J$20,000 and 2 on US$125', all.length === 16 && all.filter(u => u.maintCurrency === 'JMD').length === 14);
      const j = fin.billedOnCombinedView(ro, 'JMD', FROM, TO);
      const u = fin.billedOnCombinedView(ro, 'USD', FROM, TO);
      T.check('Maintenance billed JMD = 14 x J$20,000 = J$280,000', cents(j.maintenance) === 28000000 && cents(j.total) === 28000000, JSON.stringify(j));
      T.check('Maintenance billed USD = 2 x US$125 = US$250', cents(u.maintenance) === 25000 && cents(u.total) === 25000, JSON.stringify(u));
      T.check('Rent charged shown whole = 3 x J$100,000 = J$300,000, not added in', cents(j.rent) === 30000000, String(j.rent));
      T.check('Billed never exceeds the roll: 16 x J$20,000 = J$320,000', j.total <= 320000);
      for (const cur of ['JMD', 'USD']) {
        const r = fin.combinedSettledOfBilled(ro, fin.settledFromRent(ro, []), all, cur, FROM, TO);
        T.check(`${cur}: the rate is of that same maintenance total`, cents(r.billed) === cents(fin.billedOnCombinedView(ro, cur, FROM, TO).total), `${r.billed}`);
      }

      /* Received (Ro, 2026-11-24): whole rent, whole maintenance; ISPO's maintenance shown again as paid out. */
      let k = 0;
      const rp = (u, category, amount, date, currency = 'JMD', payerName = u.ownerName) =>
        ({ id: `ro-${++k}`, receiptNo: `RO${k}`, unitId: u.id, unitNumber: u.number, category, amount, currency, date, status: 'completed', payerName, method: 'Cash' });
      const a5 = let3[0];
      ro.push(charge(a5, 'Rent', '2026-11', 100000, { rentPortion: 80000, maintenancePortion: 20000 }), charge(a5, 'Maintenance', '2026-11', 20000));
      const cash = [
        ...let3.map(u => rp(u, 'Rent', 100000, '2026-10-05', 'JMD', u.tenantName)),
        rp(a5, 'Rent', 100000, '2026-10-28', 'JMD', a5.tenantName), // November's rent, prepaid in October
        ...owners.map(u => rp(u, 'Maintenance', 20000, '2026-10-06')),
        ...short6.map(u => rp(u, 'Maintenance', 20000, '2026-10-07', 'JMD', 'ISPO')),
        ...usd2.map(u => rp(u, 'Maintenance', 125, '2026-10-07', 'USD', 'ISPO')),
        rp(short6[0], 'Booking', 50000, '2026-10-10', 'JMD', 'Guest')
      ];
      const allPay = [...cash, ...fin.settledFromRent(ro, cash, '2026-11-30')];
      const comb = fin.consolidateEverything(ro, allPay, all);
      const oct = fin.receivedOnCombinedView(allPay, comb.payments, 'JMD', FROM, TO);
      const plain = fin.collectedInPeriod(comb.payments, 'JMD', FROM, TO);
      T.check('Received JMD October: rent whole, 4 x J$100,000 = J$400,000 (November\'s prepaid rent arrived in October)', cents(oct.received.rent) === 40000000, JSON.stringify(oct));
      T.check('Received JMD October: maintenance whole, 5 owners + 6 short-let + 3 out of rent = 14 x J$20,000 = J$280,000', cents(oct.received.maintenance) === 28000000, JSON.stringify(oct));
      T.check('Received JMD October: bookings J$50,000, ISPO income, untouched', cents(oct.received.booking) === 5000000);
      T.check('Received JMD October: total J$730,000', cents(oct.received.total) === 73000000, String(oct.received.total));
      T.check('Paid out JMD October: ISPO maintenance paid to the corporation 9 x J$20,000 = J$180,000', cents(oct.ispoMaintenancePaid) === 18000000, String(oct.ispoMaintenancePaid));
      T.check('Net JMD October: 730,000 - 180,000 = J$550,000, the cash that came from outside', cents(oct.received.total - oct.ispoMaintenancePaid) === 55000000 && cents(plain.total) === 55000000);
      const nov = fin.receivedOnCombinedView(allPay, comb.payments, 'JMD', '2026-11-01', '2026-11-30');
      T.check('November: the prepaid rent\'s J$20,000 maintenance reaches the corporation in November, and nets to nil', cents(nov.received.rent) === 0 && cents(nov.received.maintenance) === 2000000 && cents(nov.ispoMaintenancePaid) === 2000000, JSON.stringify(nov));
      const usdOct = fin.receivedOnCombinedView(allPay, comb.payments, 'USD', FROM, TO);
      T.check('USD October: US$250 maintenance on C11 and C13 received, the same US$250 paid out by ISPO', cents(usdOct.received.maintenance) === 25000 && cents(usdOct.ispoMaintenancePaid) === 25000 && cents(usdOct.received.total) === 25000, JSON.stringify(usdOct));
    }

    /* ---- the Reports screen itself, on its default book ---- */
    let text = '';
    try {
      forgetScreenState();
      remember('reports.book', 'everything');
      setReportRange({ from: FROM, to: TO, preset: 'custom' });
      const html = renderToStaticMarkup(
        React.createElement(Reports, {
          ...data,
          settings: { strataPlanNumber: '1' },
          session: { id: 'x', name: 'Tester', username: 't', email: '', position: '', role: 'ADMINISTRATOR', mustChangePassword: false, permissions: {} }
        })
      );
      resetReportRange();
      text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    } catch (err) {
      T.check('the Reports screen renders', false, err.message);
    }
    T.check('screen, Everything book: "Receivable at end of period" reads J$95,000.00', /Receivable at end of period J\$95,000\.00/.test(text), (text.match(/Receivable at end of period [^ ]+/g) || []).join(' | '));
    T.check('screen, Everything book: never J$135,000 (the paid ISPO levy read as owed)', !/Receivable at end of period J\$135,000\.00/.test(text));
    T.check('screen, Everything book: "Maintenance billed during period" is J$100,000.00, rent apart', /Maintenance billed during period J\$100,000\.00/.test(text) && /Rent charged J\$310,000\.00 is ISPO/.test(text), (text.match(/billed during period [^ ]+/gi) || []).join(' | '));
    T.check('screen, Everything book: no "Does not tie" line', !/Does not tie/.test(text), (text.match(/Does not tie[^.]*\./g) || []).join(' | '));
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    cleanup();
  }
  return T.done();
}
