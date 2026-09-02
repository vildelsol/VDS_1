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
        export { stayValueForRate } from './src/components/Bookings';
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
  } finally {
    cleanup();
  }

  return T.done();
}
