/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Operational Reports observations name who owes the gap.
 *
 * Ro, 2026-11-19, reading "J$275,000.00 was billed in rent; J$200,000.00 was
 * received against it (72.73%)": it does not tell WHO owes the other J$75,000.
 * Each observation that states a gap must name the villa, the person and the
 * amount, sum exactly to the headline and to "Receivable at end of period", say
 * since when, and say what to do. Rent arrears are ISPO's business and never
 * appear on the corporation's book.
 *
 * The fixture is the one Ro described: 11 ISPO villas, 9 carrying the J$20,000
 * levy and 2 the US$125 one. Villa 3's tenant pays nothing in October (rent
 * J$75,000 including the J$20,000 levy), so ISPO's levy on Villa 3 is
 * unsettled and the "Expenses paid" note must read J$180,000 billed / J$160,000
 * paid / J$20,000 unpaid on Villa 3. Pure: bundled source, no server.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Report observations name the villa, the person and the amount behind every gap';

const FROM = '2026-10-01';
const TO = '2026-10-31';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-observations-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export * as obs from './src/lib/observations';
        export * as fin from './src/lib/finance';
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export { default as Reports, ObservationList } from './src/components/Reports';
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

const unit = (n, over = {}) => ({
  id: `u${n}`,
  number: String(n),
  ownerName: 'ISPO',
  ownerEmail: '',
  ownerPhone: '',
  tenantName: '',
  tenantEmail: '',
  tenantPhone: '',
  status: 'vacant',
  monthlyRent: 0,
  monthlyMaintenance: 20000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  meterNumber: '',
  notes: '',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});
const charge = (u, category, amount, over = {}) => ({
  id: `c-${u.id}-${category}-${over.periodMonth || '2026-10'}`,
  unitId: u.id,
  unitNumber: u.number,
  category,
  periodMonth: '2026-10',
  dueDate: '2026-10-01',
  amount,
  currency: category === 'Maintenance' ? u.maintCurrency || u.currency : u.currency,
  status: 'open',
  payerName: category === 'Rent' ? u.tenantName : u.ownerName,
  createdAt: '2026-10-01T00:00:00Z',
  createdBy: 'test',
  ...over
});
let receipt = 0;
const pay = (u, category, amount, over = {}) => ({
  id: `p${++receipt}`,
  receiptNo: `R${receipt}`,
  payerName: 'x',
  unitId: u.id,
  unitNumber: u.number,
  category,
  amount,
  currency: category === 'Maintenance' ? u.maintCurrency || u.currency : u.currency,
  date: '2026-10-05',
  method: 'Bank Transfer',
  reference: '',
  notes: '',
  staffMember: 'test',
  status: 'completed',
  ...over
});
const tenancy = (u, name, over = {}) => ({
  id: `t-${u.id}`,
  unitId: u.id,
  unitNumber: u.number,
  tenantName: name,
  tenantEmail: '',
  tenantPhone: '',
  emergencyName: '',
  emergencyPhone: '',
  emergencyEmail: '',
  monthlyRent: u.monthlyRent,
  currency: u.currency,
  rentDueDay: 1,
  startedOn: '2026-01-01',
  status: 'active',
  recordedBy: 'test',
  recordedAt: '2026-01-01T00:00:00Z',
  ...over
});

function fixture(fin) {
  // Villas 1-9: ISPO's, J$20,000 levy. 3 and 4 are let; the rest vacant.
  const units = [];
  for (let n = 1; n <= 9; n++) units.push(unit(n));
  Object.assign(units[2], { status: 'long-term', tenantName: 'Jane Doe', monthlyRent: 75000 });
  Object.assign(units[3], { status: 'long-term', tenantName: 'Paul Payer', monthlyRent: 100000 });
  // Villas 10-11: ISPO's, US$125 levy, short stays.
  units.push(unit(10, { status: 'short-term', currency: 'USD', maintCurrency: 'USD', monthlyMaintenance: 125 }));
  units.push(unit(11, { status: 'short-term', currency: 'USD', maintCurrency: 'USD', monthlyMaintenance: 125 }));
  // Villas 12-16: owned by private proprietors.
  for (let n = 12; n <= 16; n++) units.push(unit(n, { status: 'owner-occupied', ownerName: `Proprietor ${n}` }));
  const [, , v3, v4] = units;

  const tenancies = [tenancy(v3, 'Jane Doe', { leaseEndsOn: '2026-12-15', depositAmount: 75000, depositCurrency: 'JMD' }), tenancy(v4, 'Paul Payer')];

  const charges = [
    charge(v3, 'Rent', 75000, { rentPortion: 55000, maintenancePortion: 20000 }),
    charge(v4, 'Rent', 100000, { rentPortion: 80000, maintenancePortion: 20000 }),
    ...units.map(u => charge(u, 'Maintenance', u.monthlyMaintenance))
  ];

  const payments = [
    pay(v4, 'Rent', 100000),
    // ISPO pays the levy by hand on the 5 vacant JMD villas and both USD ones.
    ...units.filter(u => u.status === 'vacant' || u.status === 'short-term').map(u => pay(u, 'Maintenance', u.monthlyMaintenance)),
    // Three proprietors pay in full; Proprietor 15 pays J$5,000 of J$20,000; Proprietor 16 pays nothing.
    ...units.filter(u => u.status === 'owner-occupied' && Number(u.number) < 15).map(u => pay(u, 'Maintenance', 20000)),
    pay(units[14], 'Maintenance', 5000),
    // Bob Guest's US$300 deposit, receipted against his stay (what the stay balance is read from).
    pay(units.find(u => u.id === 'u11'), 'Booking', 300, { bookingId: 'b2', currency: 'USD', date: '2026-10-20' })
  ];
  payments.push(...fin.settledFromRent(charges, payments));

  const bookings = [
    { id: 'b1', unitId: 'u10', unitNumber: '10', guestName: 'Ann Guest', guestEmail: '', guestPhone: '', checkIn: '2026-10-10', checkOut: '2026-10-14', source: 'Airbnb', amount: 0, currency: 'USD', depositPaid: 0, balanceDue: 0, status: 'checked-out' },
    { id: 'b2', unitId: 'u11', unitNumber: '11', guestName: 'Bob Guest', guestEmail: '', guestPhone: '', checkIn: '2026-10-20', checkOut: '2026-10-25', source: 'Direct', amount: 900, currency: 'USD', depositPaid: 300, balanceDue: 600, status: 'checked-out' }
  ];

  const expenses = [
    { id: 'e1', category: 'Contractors', vendor: 'Pool Co', description: 'Pool pump', unitId: '', unitNumber: 'General', amount: 30000, currency: 'JMD', date: '2026-10-02', dueDate: '2026-10-15', status: 'pending', reference: '', notes: '', fund: 'ispo' },
    { id: 'e2', category: 'Other', vendor: 'Hardware Ltd', description: 'Sundries', unitId: '', unitNumber: 'General', amount: 12000, currency: 'JMD', date: '2026-10-03', datePaid: '2026-10-03', status: 'paid', reference: '', notes: '', fund: 'ispo' }
  ];

  const utilities = [
    { id: 'ut1', unitId: 'u13', unitNumber: '13', meterNumber: 'M', billingPeriod: '2026-10', previousReading: 0, currentReading: 10, consumption: 10, amountCharged: 4500, currency: 'JMD', status: 'unpaid' }
  ];
  return { units, tenancies, charges, payments, bookings, expenses, utilities };
}

const flat = list => list.flatMap(o => [o.text, ...(o.details || [])]).join('\n');
const cents = n => Math.round(n * 100);

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { obs, fin, React, renderToStaticMarkup, ObservationList, Reports, remember, forgetScreenState, setReportRange, resetReportRange } = mod;
  try {
    const data = fixture(fin);
    const input = (book, currency = 'JMD') => ({ ...data, currency, from: FROM, to: TO, book });
    /** "Receivable at end of period", computed the way the Reports summary computes it. */
    const pageReceivable = (book, currency) => {
      const l = obs.bookLedger(data.charges, data.payments, data.units, book);
      return data.units
        .flatMap(u => l.categories.map(cat => fin.accountBalance(u, cat, l.charges, l.payments, TO, data.units)))
        .filter(a => a.currency === currency)
        .reduce((s, a) => s + cents(a.balance), 0);
    };

    /* ---- ISPO's book: the rent gap is named ---- */
    const ispo = obs.observationsFor(input('ispo'));
    const gap = ispo.find(o => /billed in rent/.test(o.text));
    T.check('ISPO book: the collection observation exists', !!gap, flat(ispo));
    T.check('the headline states the J$75,000.00 unpaid', gap && /J\$75,000\.00 unpaid on 1 villa/.test(gap.text), gap?.text);
    const line = gap?.details?.find(d => /Villa Unit 3/.test(d));
    T.check('the gap names Villa 3, Jane Doe and J$75,000.00', !!line && /Jane Doe/.test(line) && /J\$75,000\.00/.test(line), JSON.stringify(gap?.details));
    T.check('it says since when (due date and days) and what to do', !!line && /due 1 Oct 2026, 30 days/.test(line) && /^Chase Jane Doe/.test(line), line);
    T.check('it says the J$20,000.00 levy inside the rent stays unsettled', !!line && /J\$20,000\.00 levy inside it stays unsettled/.test(line), line);

    /* ---- the per-account list sums exactly to the receivable, on every book ---- */
    for (const book of ['ispo', 'strata', 'everything']) {
      for (const currency of ['JMD', 'USD']) {
        const accounts = obs.accountsOwing(input(book, currency));
        const listed = accounts.reduce((s, a) => s + cents(a.balance), 0);
        const lines = accounts.reduce((s, a) => s + a.unpaid.reduce((x, u) => x + cents(u.unpaid), 0), 0);
        const debts = accounts.filter(a => a.balance > 0).reduce((s, a) => s + cents(a.balance), 0);
        T.check(`${book}/${currency}: per-villa balances sum exactly to the receivable at end of period`, listed === pageReceivable(book, currency), `${listed} vs ${pageReceivable(book, currency)}`);
        T.check(`${book}/${currency}: per-charge unpaid lines sum exactly to the villas owing`, lines === debts, `${lines} vs ${debts}`);
      }
    }
    const recv = ispo.find(o => /villa\(s\) owed/.test(o.text));
    T.check('ISPO book: the receivable observation totals to the receivable', !!recv && recv.details.some(d => d === 'Total J$75,000.00, the receivable at end of period.'), JSON.stringify(recv?.details));
    const mismatch = obs.observationsFor(input('ispo'), { billed: 175000, closingReceivable: 70000 });
    T.check('a receivable figure that does not tie is named with the difference', /Does not tie: "Receivable at end of period" reads J\$70,000\.00; these accounts sum to J\$75,000\.00; difference J\$5,000\.00/.test(flat(mismatch)), flat(mismatch));

    /* ---- the levy note ---- */
    const levy = obs.ispoLevyPosition(input('ispo'));
    const note = obs.levyNote(levy);
    T.check('levy: J$180,000 billed on 9 villas, J$160,000 paid, J$20,000 unpaid', cents(levy.billed) === 18000000 && levy.villas === 9 && cents(levy.paid) === 16000000 && cents(levy.unpaid) === 2000000, JSON.stringify({ billed: levy.billed, villas: levy.villas, paid: levy.paid, unpaid: levy.unpaid }));
    T.check(
      'the note reads billed / paid / unpaid on Villa 3 with the reason',
      /J\$180,000\.00 billed on 9 villas; J\$160,000\.00 paid; J\$20,000\.00 unpaid on Villa Unit 3 \(Jane Doe's October 2026 rent J\$75,000\.00 unpaid, so the J\$20,000\.00 levy inside it is unsettled\)/.test(note),
      note
    );
    T.check('the note ties to the operating statement\'s paid-over figure', cents(fin.operatingStatement(data.payments, data.expenses, data.units, 'JMD', FROM, TO, { book: 'ispo' }).internalTransfer) === cents(levy.paid), String(levy.paid));
    const usdLevy = obs.ispoLevyPosition(input('ispo', 'USD'));
    T.check('USD levy is its own figure: US$250 on 2 villas, all paid', cents(usdLevy.billed) === 25000 && usdLevy.villas === 2 && usdLevy.unpaid === 0, JSON.stringify(usdLevy));

    /* ---- the corporation's book never carries rent ---- */
    const strata = flat(obs.observationsFor({ ...input('strata'), utilities: data.utilities }));
    T.check('strata book: no rent, no tenant name', !/\brent\b/i.test(strata) && !/Jane Doe|Paul Payer/.test(strata), strata);
    T.check('strata book: ISPO owes the Villa 3 levy as proprietor', /ISPO \(proprietor\) · J\$20,000\.00/.test(strata), strata);
    T.check('strata book: Proprietor 16 is named for the unpaid levy', /Chase Proprietor 16, Villa Unit 16: October 2026 maintenance levy J\$20,000\.00 unpaid/.test(strata), strata);
    T.check('strata book: a part-payment shows what is left of the charge', /Chase Proprietor 15, Villa Unit 15: October 2026 maintenance levy J\$15,000\.00 unpaid of J\$20,000\.00/.test(strata), strata);
    T.check('strata book: the gap headline is the sum of its lines', /J\$55,000\.00 unpaid on 3 villa/.test(strata), strata);
    T.check('strata book: no short stays and no empty-villa letting facts', !/short stay|stood empty/i.test(strata), strata);
    // Villa 13 is a proprietor's: its owner holds the utility account (Ro, 2026-11-22),
    // so the reading is named as one to take back, never as a recovery owed to the strata.
    T.check('strata book: a reading billing a proprietor’s villa is named to take back, with the amount', /1 meter reading\(s\) bill proprietors' villas for utilities, J\$4,500\.00/.test(strata) && !/Recover J\$4,500\.00 from Proprietor 13/.test(strata), strata);
    const strataUsd = flat(obs.observationsFor(input('strata', 'USD')));
    T.check('strata book USD: no guest names', !/Ann Guest|Bob Guest/.test(strataUsd), strataUsd);

    /* ---- other observations ---- */
    const usd = flat(obs.observationsFor(input('ispo', 'USD')));
    T.check('short stay with no value is named', /Enter the stay value for Ann Guest, Villa Unit 10/.test(usd), usd);
    T.check('short stay balance owing is named with amount', /Collect \$600\.00 of \$900\.00 from Bob Guest, Villa Unit 11/.test(usd), usd);
    /*
     * The QA run found stays paid in full still listed as owing, because the
     * typed `balanceDue` was read instead of the receipts. Bob pays the other
     * US$600 by a receipt linked to his stay; his reservation still says 600 due.
     */
    const rest = { id: 'p-rest', receiptNo: 'R-rest', payerName: 'Bob Guest', unitId: 'u11', unitNumber: '11', category: 'Booking', amount: 600, currency: 'USD', date: '2026-10-24', method: 'Cash', reference: '', notes: '', staffMember: 'test', status: 'completed', forBookingId: 'b2' };
    const paidUp = flat(obs.observationsFor({ ...input('ispo', 'USD'), payments: [...data.payments, rest] }));
    T.check('a stay paid in full by receipts is not listed as owing, whatever its typed balance says', !/Collect \$[\d,.]+ of \$[\d,.]+ from Bob Guest/.test(paidUp) && /Bob Guest/.test(flat(obs.observationsFor(input('ispo', 'USD')))), paidUp);
    const all = flat(ispo);
    T.check('empty villas are named with days and the levy paid on them', /Villa Unit 1: empty 31 days of 31; levy paid J\$20,000\.00/.test(all), all);
    T.check('unpaid supplier bill named with vendor and due date', /Pay Pool Co: Pool pump J\$30,000\.00, due 15 Oct 2026, 16 days overdue/.test(all), all);
    T.check("'Other' spend is itemised", /Hardware Ltd: Sundries J\$12,000\.00/.test(all), all);
    T.check('lease ending within 60 days named with deposit held', /Jane Doe, Villa Unit 3: lease ends 15 Dec 2026, in 45 days; deposit J\$75,000\.00 held/.test(all), all);

    /* ---- former tenant ---- */
    const left = JSON.parse(JSON.stringify(data));
    left.tenancies[0] = { ...left.tenancies[0], status: 'ended', endedOn: '2026-10-20' };
    const former = flat(obs.observationsFor({ ...left, currency: 'JMD', from: FROM, to: TO, book: 'ispo' }));
    T.check('a former tenant who left owing is named', /Recover from Jane Doe, Villa Unit 3: J\$75,000\.00 \(October 2026\), left 20 Oct 2026; deposit J\$75,000\.00 still held/.test(former), former);

    /* ---- ranking ---- */
    const ranked = obs.rankObservations(ispo);
    // The two "where the money is" summaries (rank -1) lead, then urgent (rank 0), largest first.
    T.check('ranked: summaries, then urgent, the largest money at risk first', ranked[0].rank === obs.SUMMARY && ranked.find(o => o.rank !== obs.SUMMARY).rank === 0 && ranked.filter(o => o.rank === 0).every((o, i, a) => i === 0 || (a[i - 1].atRisk || 0) >= (o.atRisk || 0)), ranked.map(o => `${o.rank}:${o.atRisk}`).join(' '));

    /* ---- the on-screen list renders the details ---- */
    const html = renderToStaticMarkup(React.createElement(ObservationList, { observations: ranked }));
    T.check('the on-screen list renders the indented detail lines', /Chase Jane Doe/.test(html) && /<ul/.test(html), html.slice(0, 400));

    /* ---- the combined book: who to chase, and the one figure that does not tie ---- */
    const every = obs.observationsFor(input('everything'), { billed: 415000, settled: 145000, closingReceivable: pageReceivable('everything', 'JMD') / 100 });
    const everyGap = every.find(o => /billed in rent and maintenance/.test(o.text));
    /*
     * 2026-11-19: the combined book eliminates ISPO's own levy on both sides
     * (charge and receipt), so a let villa's rent stands whole and ISPO's paid
     * levy is simply not there. These three pinned the old split, under which
     * the levy was moved out of the rent into a charge nothing could pay.
     */
    T.check('combined: Jane Doe is chased for one figure, the whole J$75,000 rent', !!everyGap && everyGap.details.some(d => /^Chase Jane Doe, Villa Unit 3: October 2026 rent J\$75,000\.00 unpaid,/.test(d)) && !everyGap.details.some(d => /levy inside the rent/.test(d)), JSON.stringify(everyGap?.details));
    T.check('combined: J$110,000 unpaid on 3 villas (Jane Doe J$75,000, Proprietors 15 and 16 J$35,000)', !!everyGap && /J\$110,000\.00 unpaid on 3 villa/.test(everyGap.text) && !everyGap.details.some(d => /rent J\$55,000\.00 unpaid/.test(d)), everyGap?.text);
    T.check('combined: ISPO\'s own paid levy is neither a debt to chase nor a figure that does not tie', !!everyGap && !everyGap.details.some(d => /ISPO's own levy, which ISPO has paid/.test(d)) && !everyGap.details.some(d => /^ISPO to pay the corporation/.test(d)), JSON.stringify(everyGap?.details));
    T.check('combined: a collection rate that does not tie is named with the difference', !!everyGap && everyGap.details.some(d => /^Does not tie: the collection rate counts J\$145,000\.00 settled, these accounts J\$165,000\.00; difference J\$20,000\.00/.test(d)), JSON.stringify(everyGap?.details));

    /* ---- the Reports screen itself, on ISPO's book and the corporation's ---- */
    const screen = book => {
      forgetScreenState();
      remember('reports.book', book);
      setReportRange({ from: FROM, to: TO, preset: 'custom' });
      const html = renderToStaticMarkup(
        React.createElement(Reports, {
          ...data,
          settings: { strataPlanNumber: '1' },
          session: { id: 'x', name: 'Tester', username: 't', email: '', position: '', role: 'ADMINISTRATOR', mustChangePassword: false, permissions: {} }
        })
      );
      resetReportRange();
      return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    };
    let ispoScreen = '';
    let strataScreen = '';
    try {
      ispoScreen = screen('ispo');
      strataScreen = screen('strata');
    } catch (err) {
      T.check('the Reports screen renders', false, err.message);
    }
    T.check('screen, ISPO book: the Expenses paid note reads J$180,000 billed / J$160,000 paid / J$20,000 unpaid on Villa 3', /J\$180,000\.00 billed on 9 villas; J\$160,000\.00 paid; J\$20,000\.00 unpaid on Villa Unit 3 \(Jane Doe's October 2026 rent/.test(ispoScreen), ispoScreen.slice(ispoScreen.indexOf('Expenses paid'), ispoScreen.indexOf('Expenses paid') + 600));
    T.check('screen, ISPO book: the observation chases Jane Doe for J$75,000', /Chase Jane Doe, Villa Unit 3: October 2026 rent J\$75,000\.00 unpaid/.test(ispoScreen));
    const strataObs = strataScreen.slice(strataScreen.indexOf('Observations'));
    T.check('screen, corporation book: observations carry no rent arrears and no tenant', strataObs.length > 20 && !/Jane Doe|billed in rent/.test(strataObs), strataObs.slice(0, 600));

    /* ---- Where the money is (Ro, 2026-11-19): owed, and leaks ---- */
    const ispoAll = obs.observationsFor(input('ispo'));
    const owed = ispoAll.find(o => o.rank === obs.SUMMARY && /is owed at/.test(o.text));
    T.check('a "where the money is" summary of what is owed comes first', !!owed && obs.rankObservations(ispoAll)[0].rank === obs.SUMMARY, flat(ispoAll).slice(0, 400));
    T.check(
      'it names who owes, the villa, the amount and the month',
      !!owed && owed.details.some(d => /Jane Doe, Villa Unit 3: J\$75,000\.00 rent for October 2026/.test(d)),
      JSON.stringify(owed?.details)
    );
    const unpaidCents = obs
      .accountsOwing(input('ispo'))
      .filter(a => a.balance > 0)
      .flatMap(a => a.unpaid)
      .filter(u => !u.paidByIspo)
      .reduce((t, u) => t + cents(u.unpaid), 0);
    T.check('the owed total is exactly the unpaid lines behind it', !!owed && cents(owed.atRisk) === unpaidCents, `${owed?.atRisk} vs ${unpaidCents / 100}`);
    const strataOwed = obs.observationsFor(input('strata')).find(o => o.rank === obs.SUMMARY && /is owed at/.test(o.text));
    T.check('on the corporation book it names the proprietors who owe their levy', !!strataOwed && /proprietors/.test(strataOwed.text) && strataOwed.details.some(d => /Proprietor 16/.test(d)), JSON.stringify(strataOwed?.details));
    T.check('and never a tenant there', !!strataOwed && !strataOwed.details.some(d => /Jane Doe/.test(d)));

    const leaks = ispoAll.find(o => o.rank === obs.SUMMARY && /where money leaked/.test(o.text));
    const oop = fin.outOfPocketShortfall(data.units, data.tenancies, data.bookings, data.payments, 'JMD', FROM, TO);
    const refundCents = data.payments
      .filter(p => p.currency === 'JMD' && p.status === 'completed' && !p.derived && (p.category === 'Rent' || p.category === 'Booking') && p.refundedOn && p.refundedOn >= FROM && p.refundedOn <= TO)
      .reduce((t, p) => t + cents(p.refundedAmount || 0), 0);
    T.check('a leak summary names the levy ISPO paid with nothing earned to cover it', !!leaks && /levy paid with no earnings to cover it/.test(leaks.text), leaks?.text);
    T.check(
      'and its total ties to the out-of-pocket report plus refunds',
      !!leaks && cents(leaks.atRisk) === cents(oop.totalShortfall) + refundCents && oop.totalShortfall > 0,
      `${leaks?.atRisk} vs ${oop.totalShortfall} + ${refundCents / 100}`
    );
    T.check(
      'each villa-month behind it is named',
      !!leaks && oop.fundedMonths.every(f => leaks.details.some(d => d.includes(f.villa) && f.month === '2026-10' && d.includes('October 2026'))),
      JSON.stringify(leaks?.details)
    );

    /* ---- complimentary stays ---- */
    const compVilla = data.units.find(u => u.status === 'vacant' && (u.maintCurrency || u.currency) === 'JMD');
    const comp = {
      id: 'comp1', unitId: compVilla.id, unitNumber: compVilla.number, guestName: 'Wedding Party', guestEmail: '', guestPhone: '',
      checkIn: '2026-10-10', checkOut: '2026-10-13', source: 'Direct', amount: 0, currency: 'JMD', depositPaid: 0, balanceDue: 0,
      status: 'checked-out', complimentary: true, complimentaryReason: 'Wedding party, owner guests', complimentaryBy: 'Junior Jo'
    };
    const withComp = obs.observationsFor({ ...input('ispo'), bookings: [...data.bookings, comp] });
    const compObs = withComp.find(o => /complimentary stay/.test(o.text));
    T.check('a complimentary stay is listed with its nights and the levy on them', !!compObs && /3 night\(s\) given free/.test(compObs.text) && /J\$1,935\.48/.test(compObs.text), compObs?.text);
    T.check(
      'with the guest, the reason and who marked it',
      !!compObs && compObs.details.some(d => /Wedding Party/.test(d) && /Wedding party, owner guests/.test(d) && /marked by Junior Jo/.test(d)),
      JSON.stringify(compObs?.details)
    );
    T.check('it is never asked for a stay value', !/Enter the stay value for Wedding Party|No stay value entered: Wedding Party/.test(flat(withComp)), flat(withComp).slice(0, 300));
    const compUsd = flat(obs.observationsFor({ ...input('ispo', 'USD'), bookings: [...data.bookings, comp] }));
    T.check('control: a stay with no value that is not complimentary is still flagged', /Ann Guest/.test(compUsd) && /stay value/.test(compUsd), compUsd.slice(0, 300));
  } finally {
    cleanup();
  }
  return T.done();
}
