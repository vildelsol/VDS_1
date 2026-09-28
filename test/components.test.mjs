/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The screens, not the server.
 *
 * Every other test in this suite exercises the API and the finance module. None
 * of them render a single component, which left the entire client untested: a
 * chart could stop drawing, a letterhead could lose the property name, a printed
 * document could go out with no figures on it, and the suite would stay green.
 *
 * That gap has already cost something. The letterhead mark was set to a size
 * that rendered correctly, typechecked, and passed every test, while printing at
 * roughly a millimetre and a half — present in the DOM, invisible on paper.
 *
 * The invariant this file exists for is the one that failure belongs to:
 *
 *   **a chart is never the only place its numbers appear.**
 *
 * Three of the category colours sit below 3:1 contrast on white, and every SVG
 * chart carries its values in `<title>` tooltips, which are unreachable on paper,
 * by keyboard, or to a screen reader. So each chart must also emit a table. That
 * is asserted per component below, and again as a blanket rule, so a chart added
 * later cannot quietly skip it.
 *
 * Components are rendered with `react-dom/server`, which needs no browser and no
 * new dependency. It does not run effects, so anything behind `useEffect` — the
 * print portal's DOM attachment, the letterhead's image-failure fallback — is
 * out of scope here and is covered by the browser checks instead.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Client components';

/**
 * Bundle the real components together with a server renderer.
 *
 * Built from an in-memory entry point rather than a fixture file, so there is no
 * second copy of the import list to drift out of step with this test.
 */
async function loadComponents(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-components-'));
  const outfile = path.join(dir, 'components.mjs');

  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export {
          CashFlowChart,
          CategoryBarChart,
          CategoryByMonthChart,
          CategoryTable,
          CollectionRateChart,
          ArrearsAgeingChart,
          OccupancyChart
        } from './src/components/Charts';
        export { PrintLetterhead, PrintSignatures } from './src/components/PrintPortal';
        export { HealthCard } from './src/components/Dashboard';
        export { stayValueForRate, GuestStayReceipt } from './src/components/Bookings';
        export { stayPhase, receiptStanding, isClosedDates, platformReservation, guestGreetingName } from './src/lib/stays';
        export { buildStayReceiptEmail } from './src/lib/email';
        export { default as IspoOperations } from './src/components/IspoOperations';
        export { forgetScreenState, recall, remember } from './src/lib/screenState';
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
    /*
     * React's Node server renderer reaches for `util` through a plain `require`,
     * which does not exist in an ESM bundle. Handing it one built from this
     * module's own URL keeps the output ESM — as the other bundled tests are —
     * without falling back to CJS just for one builtin.
     */
    banner: {
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
    }
  });

  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const row = (month, over = {}) => ({
  month,
  billed: 400000,
  received: 350000,
  receivedAgainstBilled: 350000,
  paidOut: 120000,
  byCategory: { Maintenance: 70000, Security: 50000 },
  ...over
});

const MONTHS = [row('2026-01'), row('2026-02'), row('2026-03')];

const BUCKETS = { d30: 1000, d60: 2000, d90: 3000, over90: 4000, total: 10000 };

const OCCUPANCY = [
  { month: '2026-01', occupied: 6, total: 16, rate: 37.5 },
  { month: '2026-02', occupied: 9, total: 16, rate: 56.25 }
];

const BREAKDOWN = [
  { category: 'Maintenance', amount: 210000, outstanding: 0, share: 58.33 },
  { category: 'Security', amount: 150000, outstanding: 5000, share: 41.67 }
];

/** Strip tags so assertions read text the way a person would. */
const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const countOf = (html, tag) => (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;

/* ------------------------------------------------------------------ */

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadComponents(projectRoot);

  try {
    const { React, renderToStaticMarkup: render } = mod;
    const h = React.createElement;

    /* ---------------- occupancy ---------------- */

    const occupancy = render(h(mod.OccupancyChart, { series: OCCUPANCY }));
    T.check('the occupancy chart draws a bar for every month', countOf(occupancy, 'rect') >= OCCUPANCY.length, `${countOf(occupancy, 'rect')} bars`);
    T.check('and states the rate for each of them', textOf(occupancy).includes('37.5%') && textOf(occupancy).includes('56.25%'));
    T.check('and how many villas that was', textOf(occupancy).includes('6') && textOf(occupancy).includes('16'));
    T.check(
      'and says plainly that owner-occupied villas are not counted',
      /owner-occupied villa .*not counted|not villas physically occupied/.test(textOf(occupancy)),
      'the limitation is not stated on the chart'
    );

    const emptyOccupancy = render(h(mod.OccupancyChart, { series: [{ month: '2026-01', occupied: 0, total: 0, rate: null }] }));
    T.check('an empty register draws nothing rather than a broken chart', emptyOccupancy === '', `rendered ${emptyOccupancy.length} chars`);

    /* ---------------- collection rate ---------------- */

    const rate = render(h(mod.CollectionRateChart, { rows: MONTHS, currency: 'JMD' }));
    T.check('the collection rate chart labels each bar with its percentage', (textOf(rate).match(/88%/g) || []).length >= MONTHS.length, textOf(rate).slice(0, 80));
    T.check('and explains that above 100% means arrears were cleared', /above 100%/i.test(textOf(rate)));

    // A month with nothing billed has no rate — it must say so, not read as zero.
    const noBilling = render(h(mod.CollectionRateChart, { rows: [row('2026-01', { billed: 0, receivedAgainstBilled: 0 }), row('2026-02')], currency: 'JMD' }));
    T.check('a month with nothing billed reports n/a rather than 0%', textOf(noBilling).includes('n/a'), textOf(noBilling).slice(0, 80));

    /* ---------------- arrears ageing ---------------- */

    const ageing = render(h(mod.ArrearsAgeingChart, { buckets: BUCKETS, currency: 'JMD' }));
    const ageingText = textOf(ageing);
    T.check('the ageing chart names all four statutory buckets', ['Up to 30 days', '31 – 60 days', '61 – 90 days', 'Over 90 days'].every(b => ageingText.includes(b)), ageingText.slice(0, 120));
    T.check('and totals them', ageingText.includes('100%'));
    T.check('an account owing nothing draws no ageing at all', render(h(mod.ArrearsAgeingChart, { buckets: { d30: 0, d60: 0, d90: 0, over90: 0, total: 0 }, currency: 'JMD' })) === '');

    /* ---------------- the print-legibility invariant ---------------- */

    const charts = [
      ['cash flow', h(mod.CashFlowChart, { rows: MONTHS, currency: 'JMD' })],
      ['expenses by month', h(mod.CategoryByMonthChart, { rows: MONTHS, currency: 'JMD' })],
      ['occupancy', h(mod.OccupancyChart, { series: OCCUPANCY })]
    ];

    for (const [name, element] of charts) {
      const html = render(element);
      T.check(`the ${name} chart draws an svg`, countOf(html, 'svg') > 0);
      T.check(
        `and carries its figures in a table too, so the ${name} chart is readable on paper`,
        countOf(html, 'table') > 0,
        'values would exist only in hover tooltips'
      );
    }

    // The stacked chart is where colour was carrying data on its own.
    const stacked = render(h(mod.CategoryByMonthChart, { rows: MONTHS, currency: 'JMD' }));
    T.check('the stacked chart names every category it draws', ['Maintenance', 'Security'].every(c => textOf(stacked).includes(c)));
    T.check('and gives each month a total', /Total/.test(textOf(stacked)));

    /* ---------------- letterhead ---------------- */

    const letterhead = render(h(mod.PrintLetterhead, { documentTitle: 'Operating Statement', meta: 'Period 1 Jan — 31 Mar', generatedBy: 'A Manager' }));
    T.check('the letterhead names the document', textOf(letterhead).includes('Operating Statement'));
    T.check('and where the property is', textOf(letterhead).includes('Ocho Rios'));
    T.check('and who generated it', textOf(letterhead).includes('A Manager'));
    T.check(
      'the mark is tagged for print, so a printer cannot drop it as a background graphic',
      /vds-letterhead-mark/.test(letterhead),
      'the print class is missing from the letterhead image'
    );
    T.check(
      'and the property is named in text even when the image is not shown',
      /alt="Villaggio Del Sol"/.test(letterhead),
      'a document whose only identification is an image cannot say whose it is'
    );

    /* ---------------- signatures ---------------- */

    const signatures = render(h(mod.PrintSignatures, { left: 'Prepared by', leftName: 'A Manager', right: 'Reviewed / Approved by' }));
    /*
     * Ro, 2026-09-16: signatures kept printing alone on a second sheet. Measured
     * in Chrome's print-to-PDF, cutting the on-paper space above the block (and
     * under the ISPO credit) fits two more table rows on a page before it spills.
     * PDFs are not produced in this suite — it has to run where no Chrome is — so
     * this holds the pieces that measurement depended on.
     */
    {
      const css = fs.readFileSync(path.join(projectRoot, 'src', 'index.css'), 'utf8');
      const printBlock = css.slice(css.indexOf('@media print'));
      T.check('the signature block carries its print class', /class="[^"]*\bvds-print-signatures\b/.test(signatures), signatures.slice(0, 200));
      T.check('which on paper cuts the space above it and is never split across pages',
        /\.vds-print-signatures\s*\{[^}]*margin-top:\s*6mm[^}]*padding-top:\s*0[^}]*break-inside:\s*avoid/.test(printBlock));
      T.check('and the ISPO credit is tightened on paper too, so it cannot take a sheet of its own',
        /\.vds-print-credit\s*\{[^}]*margin-top:\s*3mm/.test(printBlock));
    }
    T.check('a signed document prints who prepared it', textOf(signatures).includes('Prepared by') && textOf(signatures).includes('A Manager'));
    T.check('and leaves a line for who approved it', textOf(signatures).includes('Reviewed / Approved by'));

    /* ---------------- category table ---------------- */

    const table = render(h(mod.CategoryTable, { breakdown: BREAKDOWN, currency: 'JMD' }));
    T.check('the category table separates what is paid from what is outstanding', textOf(table).includes('Paid') && textOf(table).includes('Outstanding'));
    T.check('and shows a category still owing money', textOf(table).includes('5,000'), textOf(table).slice(0, 120));


    /* ---------------- the health grade ---------------- */

    // A single letter is the most dangerous figure on a dashboard: it is the one
    // nobody checks, because checking it means reconstructing it. So it falls
    // under the same rule as every chart here — the numbers behind it must be on
    // the page, not only in the bar or a tooltip.
    const HEALTH = {
      currency: 'JMD',
      score: 62.5,
      grade: 'C',
      from: '2026-06-01',
      to: '2026-06-30',
      components: [
        { key: 'collection', label: 'Collection', score: 80, weight: 40, detail: '80.0% of 100,000.00 billed was received' },
        { key: 'coverage', label: 'Cost coverage', score: 50, weight: 35, detail: '100,000.00 billed against 200,000.00 spent' },
        { key: 'ageing', label: 'Debt ageing', score: 45, weight: 25, detail: '55,000.00 of 100,000.00 owing is over 90 days' }
      ]
    };

    const health = render(h(mod.HealthCard, { health: HEALTH, currency: 'JMD' }));
    const healthText = textOf(health);
    T.check('the health card prints its grade', healthText.includes('C'), healthText.slice(0, 120));
    T.check('and the score behind the letter', healthText.includes('62') || healthText.includes('63'), healthText.slice(0, 200));
    T.check('every component it was graded on is named', ['Collection', 'Cost coverage', 'Debt ageing'].every(l => healthText.includes(l)), healthText.slice(0, 300));
    T.check(
      'each component shows the figures behind it, not just a bar',
      healthText.includes('80.0% of 100,000.00 billed was received') && healthText.includes('over 90 days'),
      healthText.slice(0, 400)
    );
    T.check('and the weight it carried, so the grade can be reproduced by hand', healthText.includes('40%') && healthText.includes('35%'));
    T.check(
      'the values live in a real table, not only in the bar',
      /<table[\s\S]*Collection[\s\S]*<\/table>/.test(health),
      'the health card must carry a data table like every other visual here'
    );
    T.check('the grade boundaries are stated on the card itself', healthText.includes('85') && healthText.includes('70'));

    // Nothing to grade must say so, rather than showing a zero or the worst grade.
    const noHealth = textOf(render(h(mod.HealthCard, { health: null, currency: 'JMD' })));
    T.check('with nothing to grade it says so instead of printing an E', !/\bE\b/.test(noHealth) && /nothing to grade/i.test(noHealth), noHealth.slice(0, 200));

    /* ---------------- currency is never blended ---------------- */

    const jmd = render(h(mod.CashFlowChart, { rows: MONTHS, currency: 'JMD' }));
    const usd = render(h(mod.CashFlowChart, { rows: MONTHS, currency: 'USD' }));
    T.check('a JMD chart is denominated in JMD', /J\$/.test(textOf(jmd)));
    T.check('and never carries a dollar figure from the other currency', !/(^|[^J])\$\d/.test(textOf(jmd).replace(/J\$/g, 'J')), 'a USD amount appeared on a JMD chart');
    T.check('while the USD chart is denominated in USD', /\$/.test(textOf(usd)) && !/J\$/.test(textOf(usd)));

    /* ---------------- a nightly rate has to reach the total ---------------- */

    /*
     * Ro, 2026-09-02: "when i input the nightly rate, the total is not
     * automatically calculated in the total stay value field … if the nightly
     * rate is populated, it should automatically reflect in the total stay
     * value."
     *
     * The override on the total used to latch for the life of the reservation,
     * so one touch of that field and the rate never drove it again. The silent
     * shape of it: type a figure into the total and delete it, and the field
     * looks untouched but is latched — entering a rate afterwards did nothing at
     * all and the total stayed empty, with no way out but closing the form.
     *
     * The rule lives in `stayValueForRate` precisely so it can be asserted here.
     * `renderToStaticMarkup` cannot type into a field or run an effect, which is
     * why the fault was invisible to every test that existed.
     */
    const { stayValueForRate } = mod;
    T.check('a rate over a stay gives the total', stayValueForRate('250', 4) === '1000', String(stayValueForRate('250', 4)));
    T.check('and it is rounded to the cent, not left long', stayValueForRate('33.333', 3) === '100', String(stayValueForRate('33.333', 3)));
    T.check('a single night is still a stay', stayValueForRate('180', 1) === '180', String(stayValueForRate('180', 1)));
    T.check(
      'a cleared rate leaves the total alone rather than wiping it',
      stayValueForRate('', 4) === null,
      String(stayValueForRate('', 4))
    );
    T.check('and so does a rate with no dates behind it yet', stayValueForRate('250', 0) === null, String(stayValueForRate('250', 0)));
    T.check('a rate of nothing implies nothing', stayValueForRate('0', 4) === null, String(stayValueForRate('0', 4)));
    T.check(
      'and neither a negative rate nor a typed comma produces a figure',
      stayValueForRate('-50', 4) === null && stayValueForRate('1,500', 4) === null,
      `${stayValueForRate('-50', 4)} / ${stayValueForRate('1,500', 4)}`
    );
    /* ---------------- who the ISPO statement renders for ----------------
     *
     * Ro, 2026-09-03: *"Every role unless withdrawn is the best option."*
     *
     * A **render** check on purpose, and it exists because of the exact
     * regression it guards. `Reports.tsx` used to wrap the shortfall report in
     * `session.role === 'ADMINISTRATOR'` while the component itself implemented
     * "every role unless withdrawn" — so the permission could never grant
     * anything to anybody. No server-side test could see it, because the
     * permission was served correctly all along; only the screen threw it away.
     * Nothing but rendering the component catches that.
     */
    {
      const ispoUnits = [
        {
          id: 'iu', number: 'V9', ownerName: 'VDS', ownerEmail: '', ownerPhone: '',
          tenantName: 'T', tenantEmail: '', tenantPhone: '', status: 'long-term',
          monthlyRent: 50000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD',
          rentDueDay: 1, maintDueDay: 1, meterNumber: '', notes: '', letOnOwnAccount: true
        }
      ];
      const ispoPayments = [
        { id: 'r1', unitId: 'iu', unitNumber: 'V9', category: 'Rent', amount: 50000, currency: 'JMD', date: '2026-08-05', status: 'completed', payerName: 'T', method: 'Cash', receiptNo: 'RC1' }
      ];
      const ispoCosts = [
        { id: 'x1', category: 'Utilities', vendor: 'MARKER-PHONE', description: '', unitId: '', unitNumber: 'General', amount: 18000, currency: 'JMD', fund: 'ispo', date: '2026-08-05', dueDate: '2026-08-05', datePaid: '2026-08-05', status: 'paid', paymentMethod: 'Cash', reference: '', notes: '' }
      ];
      const ispoSettings = { strataPlanNumber: '2324', vendors: [], rolePermissions: {} };

      // This block has its own destructure: the one at the top of the file
      // belongs to an earlier scope.
      const { React, renderToStaticMarkup, IspoOperations } = mod;
      const renderFor = session =>
        renderToStaticMarkup(
          React.createElement(IspoOperations, {
            units: ispoUnits,
            expenses: ispoCosts,
            payments: ispoPayments,
            settings: ispoSettings,
            session
          })
        );

      const junior = renderFor({ name: 'Junior Jo', role: 'JUNIOR_OFFICER', permissions: { viewIspoOperations: true } });
      T.check('a junior officer sees the ISPO statement', /ISPO Operations/.test(junior), junior.slice(0, 200));

      const legacy = renderFor({ name: 'Old Session', role: 'FINANCE_OFFICER', permissions: {} });
      T.check(
        'and so does a session from before the permission existed — absent means granted',
        /ISPO Operations/.test(legacy),
        legacy.slice(0, 200)
      );

      const withdrawn = renderFor({ name: 'Junior Jo', role: 'JUNIOR_OFFICER', permissions: { viewIspoOperations: false } });
      T.check('withdrawing it in Settings takes the statement off their screen', withdrawn === '', withdrawn.slice(0, 200));

      const admin = renderFor({ name: 'Boss', role: 'ADMINISTRATOR', permissions: { viewIspoOperations: false } });
      T.check('an administrator is never gated, as everywhere else here', /ISPO Operations/.test(admin), admin.slice(0, 200));

      T.check('the statement names itself internal wherever it renders', /Internal/.test(junior), junior.slice(0, 400));
    }


    /* ---------------- remembering where a screen was left ---------------- *
     *
     * Ro, 2026-09-04: *"i was in operational reports, went to the general
     * dashboards to look at the numbers went back to operational reports and
     * what i was looking at was already off screen."*
     *
     * Only one tab is mounted at a time, so coming back re-ran the default. The
     * rules asserted here are Ro's, not the code's:
     *
     *   - a screen opens on its documented default the first time you see it;
     *   - after that it opens on whatever month you last chose;
     *   - signing out forgets all of it, because the desk machine is shared.
     *
     * `renderToStaticMarkup` mounts fresh every call, which is exactly what
     * leaving a tab and coming back does — so a second render *is* the return
     * trip. The user's act of picking a month is `remember`, which is precisely
     * what the setter does and all it does.
     */
    {
      const { React, renderToStaticMarkup, IspoOperations, forgetScreenState, recall, remember } = mod;

      const units = [
        {
          id: 'iu', number: 'V9', ownerName: 'VDS', ownerEmail: '', ownerPhone: '',
          tenantName: 'T', tenantEmail: '', tenantPhone: '', status: 'long-term',
          monthlyRent: 50000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD',
          rentDueDay: 1, maintDueDay: 1, meterNumber: '', notes: '', letOnOwnAccount: true
        }
      ];
      const session = { name: 'Boss', role: 'ADMINISTRATOR', permissions: {} };
      const settings = { strataPlanNumber: '2324', vendors: [], rolePermissions: {} };
      const open = () =>
        renderToStaticMarkup(
          React.createElement(IspoOperations, { units, expenses: [], payments: [], settings, session })
        );

      // The month the screen is on is the value of its month control.
      const monthShown = html => (html.match(/type="month"[^>]*value="(\d{4}-\d{2})"/) || html.match(/value="(\d{4}-\d{2})"[^>]*type="month"/) || [])[1];

      forgetScreenState();

      const lastMonth = (() => {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      })();

      const first = open();
      T.check(
        'a report about a finished month still opens on last month the first time you see it',
        monthShown(first) === lastMonth,
        `showed ${monthShown(first)}, expected ${lastMonth}`
      );

      // The office is looking at March. Ro steps across to the dashboard...
      remember('reports.ispo.month', '2026-03');
      const returned = open();
      T.check(
        'and comes back to the month you left it on, not to the default again',
        monthShown(returned) === '2026-03',
        `showed ${monthShown(returned)}`
      );

      T.check('the choice is what was remembered, not something derived from it', recall('reports.ispo.month') === '2026-03');

      forgetScreenState();
      const afterSignOut = open();
      T.check(
        'signing out forgets it — the next person at the shared desk starts clean',
        monthShown(afterSignOut) === lastMonth,
        `showed ${monthShown(afterSignOut)}`
      );

      /*
       * Two screens sharing a key would silently share a control — pick a month
       * on one and another screen moves. Nothing in TypeScript prevents it, so
       * it is checked here against the real source.
       */
      const keys = [];
      let calls = 0;
      for (const file of fs.readdirSync(path.join(projectRoot, 'src', 'components'))) {
        if (!file.endsWith('.tsx')) continue;
        const src = fs.readFileSync(path.join(projectRoot, 'src', 'components', file), 'utf8');
        // Every use, however it is written, so a key this scan cannot read is
        // counted as a miss rather than quietly escaping the uniqueness check.
        calls += (src.match(/useRemembered\s*[<(]/g) || []).length;
        for (const m of src.matchAll(/useRemembered(?:<[^>]*>)?\(\s*'([^']+)'/g)) keys.push({ key: m[1], file });
      }
      const dupes = keys.filter((k, i) => keys.findIndex(o => o.key === k.key) !== i);
      T.check('every remembered key is used by exactly one screen', dupes.length === 0, dupes.map(d => `${d.key} (${d.file})`).join(', '));
      T.check('and every one of them was read by this check', keys.length === calls, `read ${keys.length} of ${calls}`);
      T.check('the screens are actually using the mechanism', keys.length >= 20, `${keys.length} remembered controls`);
    }


    /* ---------------- short-term stays: what the list and the receipt may say ---------------- *
     *
     * Ro, 2026-09-16, after connecting the Airbnb calendar: an imported stay
     * printed "Paid in full" over USD $0.00 for a stay not yet taken; a finished
     * stay looked like one to come; closed dates read like a guest; and the only
     * guest details the feed has were buried in the notes. Every stay below is one
     * of the rows from that screen.
     */
    {
      const { React, renderToStaticMarkup, GuestStayReceipt, stayPhase, receiptStanding, isClosedDates, platformReservation, guestGreetingName, buildStayReceiptEmail } = mod;

      // Exactly what the sync writes: the feed's description is appended to the notes.
      const airbnbNotes =
        'Imported from the Airbnb calendar. The platform feed does not carry pricing — enter the stay value manually.\n' +
        'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCD1234\nPhone Number (Last 4 Digits): 1234';

      const base = { unitId: 'b6', unitNumber: 'B6', guestEmail: '', guestPhone: '', currency: 'USD', status: 'confirmed', depositPaid: 0, balanceDue: 0, amount: 0 };
      const imported = { ...base, id: 's1', guestName: 'External guest', source: 'Airbnb', checkIn: '2026-12-26', checkOut: '2026-12-28', notes: airbnbNotes, externalUid: 'u1' };
      const closed = { ...base, id: 's2', guestName: 'Airbnb (Not available)', source: 'Blocked', checkIn: '2026-12-28', checkOut: '2027-01-19', notes: 'Owner block imported from the Airbnb calendar.', externalUid: 'u2' };
      const direct = { ...base, id: 's3', guestName: 'Chris Edwards', source: 'Direct', checkIn: '2026-09-11', checkOut: '2026-09-14', amount: 500, depositPaid: 0, balanceDue: 500 };
      const settled = { ...direct, id: 's4', depositPaid: 500, balanceDue: 0 };

      /* ---- money ---- */
      T.check('a stay with no value entered is not "paid" — nothing was paid', receiptStanding(imported) === 'no-value');
      T.check('a stay with money owing is owing', receiptStanding(direct) === 'balance-due');
      T.check('only a stay with a value and nothing left of it is paid', receiptStanding(settled) === 'paid');

      const unit = { id: 'b6', number: 'B6' };
      const receipt = html => textOf(html).toUpperCase();
      const importedReceipt = receipt(renderToStaticMarkup(React.createElement(GuestStayReceipt, { booking: imported, unit, generatedBy: 'Desk', onClose: () => {} })));
      T.check('the receipt for an Airbnb stay with no value never says PAID IN FULL', !importedReceipt.includes('PAID IN FULL'), importedReceipt.slice(0, 300));
      T.check('it says the stay total is not yet confirmed instead of printing $0.00', importedReceipt.includes('NOT YET CONFIRMED') && !importedReceipt.includes('$0.00'), importedReceipt.slice(0, 400));
      T.check('and calls itself a confirmation, not a receipt', importedReceipt.includes('GUEST STAY CONFIRMATION'));
      T.check('it greets a guest, not "External guest"', importedReceipt.includes('DEAR GUEST,') && !importedReceipt.includes('EXTERNAL GUEST,'));

      const settledReceipt = receipt(renderToStaticMarkup(React.createElement(GuestStayReceipt, { booking: settled, unit, generatedBy: 'Desk', onClose: () => {} })));
      T.check('a stay genuinely settled still prints PAID IN FULL', settledReceipt.includes('PAID IN FULL') && settledReceipt.includes('GUEST STAY RECEIPT'));
      const owingReceipt = receipt(renderToStaticMarkup(React.createElement(GuestStayReceipt, { booking: direct, unit, generatedBy: 'Desk', onClose: () => {} })));
      T.check('and a stay with a balance says it is payable on arrival', owingReceipt.includes('PAYABLE ON ARRIVAL') && !owingReceipt.includes('PAID IN FULL'));

      const mail = buildStayReceiptEmail(imported, unit).body;
      T.check('the emailed version makes the same promise — no $0.00 stay total', /not yet confirmed/.test(mail) && !/\$0\.00/.test(mail), mail);

      /* ---- where a stay stands ---- */
      T.check('a stay whose departure has passed is completed', stayPhase(direct, '2026-09-16') === 'completed');
      T.check('the departure day itself belongs to the next guest, so it is completed from then', stayPhase(direct, '2026-09-14') === 'completed');
      T.check('the night before departure the guest is still in', stayPhase(direct, '2026-09-13') === 'in-stay');
      T.check('arrival day is in stay', stayPhase(direct, '2026-09-11') === 'in-stay');
      T.check('before arrival it is upcoming', stayPhase(direct, '2026-09-10') === 'upcoming');
      T.check('a cancelled stay reads cancelled whatever its dates', stayPhase({ ...direct, status: 'cancelled' }, '2026-09-12') === 'cancelled');
      T.check('a stay someone checked out early is completed', stayPhase({ ...direct, status: 'checked-out' }, '2026-09-12') === 'completed');

      /* ---- closed dates ---- */
      T.check('"Airbnb (Not available)" is closed dates, not a guest', isClosedDates(closed) && !isClosedDates(imported));
      T.check('and is never greeted by that name', guestGreetingName(closed) === 'Guest');
      T.check('while a real guest name typed in is used', guestGreetingName({ ...imported, guestName: 'Marcia Brown' }) === 'Marcia Brown');

      /* ---- the details the feed does carry ---- */
      const found = platformReservation(imported.notes);
      T.check('the Airbnb confirmation code is read out of the imported notes', found.code === 'HMABCD1234', JSON.stringify(found));
      T.check('with the last four digits of the guest phone', found.phoneLast4 === '1234');
      T.check('and a link to the reservation on Airbnb', found.url === 'https://www.airbnb.com/hosting/reservations/details/HMABCD1234');
      const spoofed = platformReservation('see https://airbnb.evil.example/hosting/reservations/details/HMABCD1234 and https://evil.example/x');
      T.check(
        'a link typed into the notes can never send that button anywhere but Airbnb',
        !spoofed.url || spoofed.url.startsWith('https://www.airbnb.com/hosting/reservations/details/'),
        String(spoofed.url)
      );
      T.check('closed dates carry no reservation details', !platformReservation(closed.notes).code);
    }

  } finally {
    cleanup();
  }

  return T.done();
}
