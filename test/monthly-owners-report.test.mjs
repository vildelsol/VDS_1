/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The owners' monthly report.
 *
 * Ro, 2026-09-02: *"a monthly report that we may be able to give our owners
 * should they ask"*, as a tab beside the annual report.
 *
 * It obeys the annual report's rule, and that rule is what most of this file
 * asserts: **identical for every owner, carrying nothing personal.** Ro,
 * 2026-08-16: *"it has to do with how the property is run, not their unit nor
 * their finances."* A shorter period does not relax it, so the printed document
 * is rendered and searched for anything that would identify a lot or a person —
 * because this is the one document here that goes to sixteen households, and a
 * balance leaking onto it cannot be recalled once it is in the post.
 *
 * The arrears line is the boundary: **a count and a total, never a list.**
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'The monthly report to proprietors';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-monthly-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { MonthlyReportDocument } from './src/components/MonthlyOwnersReport';
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

const textOf = html =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '’')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const MONTH = '2026-06';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Monthly-1234!', projectRoot });
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { fin, React, renderToStaticMarkup, MonthlyReportDocument } = mod;
  const { monthlyOwnersReport } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Monthly-1234!', 'MonthlyNew-9876!');
    await c.post('/api/settings', { booksBeginOn: '2026-01-01' });

    /* ---------------- a property with a month behind it ---------------- */

    await c.put('/api/units/unit-1', {
      number: '1',
      ownerName: 'Marcia Bloomfield',
      status: 'owner-occupied',
      monthlyMaintenance: 20000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      maintDueDay: 1
    });
    await c.put('/api/units/unit-2', {
      number: '2',
      ownerName: 'Delroy Palmer',
      status: 'vacant',
      monthlyMaintenance: 20000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      maintDueDay: 1
    });
    await c.put('/api/units/unit-3', {
      number: '3',
      ownerName: 'A Third Proprietor',
      status: 'vacant',
      monthlyMaintenance: 20000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      maintDueDay: 1
    });

    await c.post('/api/charges/post-month', { monthString: MONTH });

    // Two lots pay, one does not.
    await recordAndConfirmPayment(c, {
      unitId: 'unit-1',
      category: 'Maintenance',
      amount: 20000,
      currency: 'JMD',
      payerName: 'Marcia Bloomfield',
      method: 'Bank Transfer',
      date: '2026-06-04'
    });
    await recordAndConfirmPayment(c, {
      unitId: 'unit-2',
      category: 'Maintenance',
      amount: 20000,
      currency: 'JMD',
      payerName: 'Delroy Palmer',
      method: 'Cash',
      date: '2026-06-05'
    });

    const spend = over => ({ currency: 'JMD', status: 'paid', date: '2026-06-10', datePaid: '2026-06-10', unitNumber: 'General', ...over });
    await c.post('/api/expenses', spend({ category: 'Payroll', vendor: 'Darryl Whyte', description: 'Grounds', amount: 20000 }));
    await c.post('/api/expenses', spend({ category: 'Security', vendor: 'Guardsman', description: 'Night patrol', amount: 12000 }));
    await c.post('/api/expenses', spend({ category: 'Supplies', vendor: 'AquaChem', description: 'Pool chemicals', amount: 3000 }));
    // Work on one villa: recharged to that owner, so not a common cost.
    await c.post('/api/expenses', spend({ category: 'Maintenance', vendor: 'A. Plumber', description: 'Kitchen tap', amount: 7800, unitId: 'unit-3', unitNumber: '3' }));
    // A bill that fell due in the month and was not settled.
    await c.post('/api/expenses', spend({ category: 'Contractors', vendor: 'GateTech', amount: 40000, status: 'pending', dueDate: '2026-06-25' }));

    const db = (await c.get('/api/db')).body;
    const jmd = monthlyOwnersReport(db.units, db.charges, db.payments, db.expenses, 'JMD', MONTH);

    /* ================================================================
     * The fund, on a cash basis
     * ================================================================ */

    T.check('contributions received are what actually came in', jmd.contributionsReceived === 40000, String(jmd.contributionsReceived));
    T.check('common costs are what was actually paid', jmd.costsPaid === 35000, `${jmd.costsPaid} (20000 + 12000 + 3000)`);
    T.check('and the surplus is the subtraction a proprietor would do', jmd.surplus === 5000, String(jmd.surplus));
    T.check(
      'the categories add up to the total, exactly',
      jmd.categories.reduce((t, g) => t + Math.round(g.total * 100), 0) === Math.round(jmd.costsPaid * 100),
      JSON.stringify(jmd.categories)
    );
    T.check('and the largest is first, because that is the question being asked', jmd.categories[0]?.label === 'Payroll', jmd.categories[0]?.label);

    /* ================================================================
     * What would otherwise flatter the month
     * ================================================================ */

    T.check(
      'work on one villa is excluded from common costs',
      !jmd.categories.some(g => Math.round(g.total * 100) === 780000),
      'recharged work was shared across the proprietors'
    );
    T.check('but it is declared as a total rather than dropped', jmd.villaRecharged === 7800 && jmd.villaRechargedCount === 1, JSON.stringify([jmd.villaRecharged, jmd.villaRechargedCount]));
    T.check(
      'a bill due in the month and unsettled is stated, not netted off',
      jmd.unpaidAtMonthEnd === 40000 && jmd.unpaidCount === 1 && jmd.surplus === 5000,
      `${jmd.unpaidAtMonthEnd} unpaid against a surplus of ${jmd.surplus}`
    );

    /* ================================================================
     * Arrears: a count and a total, never a list
     * ================================================================ */

    T.check('the lot that did not pay is counted', jmd.lotsInArrears === 1, String(jmd.lotsInArrears));
    T.check('against the lots billed in this currency', jmd.lotsTotal === 16, String(jmd.lotsTotal));
    T.check('with the amount outstanding stated', jmd.arrearsOutstanding === 20000 * (jmd.lotsInArrears || 1) || jmd.arrearsOutstanding > 0, String(jmd.arrearsOutstanding));
    T.check(
      'and the report carries no list of who they are — there is no such field to leak',
      !Object.keys(jmd).some(k => Array.isArray(jmd[k]) && k !== 'categories'),
      Object.keys(jmd).join(', ')
    );

    /* ================================================================
     * Currencies stay apart
     * ================================================================ */

    const usd = monthlyOwnersReport(db.units, db.charges, db.payments, db.expenses, 'USD', MONTH);
    T.check('a currency with nothing in it reports nothing rather than borrowing', usd.empty === true, JSON.stringify(usd));
    T.check('and no JMD figure appears on it', usd.contributionsReceived === 0 && usd.costsPaid === 0, JSON.stringify(usd));

    /* ================================================================
     * The printed document, and what must never be on it
     * ================================================================ */

    const html = renderToStaticMarkup(
      React.createElement(MonthlyReportDocument, {
        reports: [jmd],
        period: 'June 2026',
        settings: db.settings,
        generatedBy: 'Test Administrator'
      })
    );
    const text = textOf(html);

    T.check('the printed report renders', html.length > 500, `${html.length} characters`);
    T.check('it names the month it covers', /June 2026/.test(text), text.slice(0, 200));
    T.check('it states what came in and what went out', /Maintenance contributions received/i.test(text) && /Common costs paid/i.test(text));
    T.check('and the surplus a proprietor can check by subtraction', /Surplus for the month/i.test(text) && /J\$5,000\.00/.test(text), 'the surplus is not on the page');
    T.check('the categories are on it', /Payroll/.test(text) && /Security/.test(text));
    T.check(
      'the unsettled bill is declared',
      /unsettled/i.test(text) && /J\$40,000\.00/.test(text),
      'a month with an unpaid bill read as a clean surplus'
    );
    T.check('and so is the work recharged to one owner', /recharged/i.test(text) && /J\$7,800\.00/.test(text), 'recharged work vanished from the printed report');

    /* --- the rule that matters most on a document sent to owners --- */

    T.check(
      'no proprietor is named anywhere on it',
      !/Marcia Bloomfield/.test(text) && !/Delroy Palmer/.test(text) && !/A Third Proprietor/.test(text),
      'an owner was named on a document circulated to every owner'
    );
    T.check(
      'no villa is identified',
      !/Villa Unit \d/.test(text),
      'a villa was identified on a document circulated to every owner'
    );
    T.check(
      'no payee is named — that is the council’s statement, not this one',
      !/Darryl Whyte/.test(text) && !/Guardsman/.test(text) && !/AquaChem/.test(text) && !/GateTech/.test(text),
      'a contractor was named on the proprietors’ circular'
    );
    T.check(
      'the arrears line is a count and a total, and says so',
      /1 of 16 lots/.test(text) && /No lot is named/i.test(text),
      text.slice(0, 400)
    );
    T.check(
      'and the reader is told their own account is a separate document',
      /separate statement/i.test(text),
      'nothing tells a proprietor where to ask about their own balance'
    );
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
