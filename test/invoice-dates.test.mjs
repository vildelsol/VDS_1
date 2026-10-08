/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The date on the supplier's bill, kept apart from the date the money moved.
 *
 * Ro, 2026-10-08: *"the date column that is shown represents the date paid, not
 * the logged date which would be the date the invoice was printed, logged into
 * the system or date received... this creates some confusion as an accountant or
 * anyone reading could mistake the date shown to be the date of the invoice...
 * the date could confuse her thinking this is an October invoice when in truth
 * it is a September invoice."*
 *
 * The register held three dates and none of them was the supplier's: a logged
 * date defaulting to whenever somebody typed it up, an optional due date, and
 * the date paid. The column showed `datePaid || date`, so a September bill
 * settled on 3 October read **3 Oct** with nothing on the record to say
 * otherwise.
 *
 * The rules, in the property's own terms:
 *
 *   1. A cost can carry the date the supplier put on the bill.
 *   2. It is optional, and a cost without one is not broken - it falls back to
 *      the logged date and **says that it has**, rather than passing the day the
 *      office typed it up off as the supplier's date.
 *   3. It is a new field, not a renaming. Every cost written before this keeps
 *      the logged date it always had, and nothing claims that date was an
 *      invoice date.
 *   4. It can be set where the utility bills actually enter the books: on the
 *      monthly run, with the bill in front of you.
 *   5. It changes nothing about what anything cost. The reports are cash basis
 *      on purpose, so the surplus reconciles to the bank, and the invoice date
 *      is a reference for whoever is reconciling rather than a reporting date.
 *   6. A date that is not a date is refused, rather than stored and shown as
 *      nonsense on a statement.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Invoice dates, kept apart from the date paid';

async function loadLib(projectRoot, relative, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outfile = path.join(dir, 'mod.mjs');
  await build({
    entryPoints: [path.join(projectRoot, relative)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function lastMonth() {
  const now = new Date();
  const m = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

const ok = res => res.status >= 200 && res.status < 300;

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Invoice-1234!', projectRoot });
  const T = reporter(title);
  const types = await loadLib(projectRoot, path.join('src', 'types.ts'), 'vds-inv-types-');
  const fin = await loadLib(projectRoot, path.join('src', 'lib', 'finance.ts'), 'vds-inv-fin-');
  const { invoiceDateOf } = types.mod;
  const { expensesInPeriod, operationsStatement } = fin.mod;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Invoice-1234!', 'InvoiceNew-9876!');

    const month = lastMonth();
    /* The month after the bill, which is when it actually gets paid. */
    const paidMonth = (() => {
      const [y, m] = month.split('-').map(Number);
      const d = new Date(y, m, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();

    /* ================================================================
     * Rule 1 — a cost carries the supplier's date
     * ================================================================ */

    const billed = await c.post('/api/expenses', {
      category: 'Utilities',
      vendor: 'JPS',
      description: 'Common property electricity',
      unitNumber: 'General',
      amount: 60000,
      currency: 'JMD',
      status: 'paid',
      invoiceDate: `${month}-26`,
      date: `${paidMonth}-02`,
      datePaid: `${paidMonth}-03`
    });
    T.check('a cost accepts the date the supplier put on the bill', ok(billed), String(billed.body?.error));
    T.check(
      'and keeps the three dates apart rather than collapsing them',
      billed.body?.expense?.invoiceDate === `${month}-26` &&
        billed.body?.expense?.date === `${paidMonth}-02` &&
        billed.body?.expense?.datePaid === `${paidMonth}-03`,
      JSON.stringify({
        invoice: billed.body?.expense?.invoiceDate,
        logged: billed.body?.expense?.date,
        paid: billed.body?.expense?.datePaid
      })
    );

    /*
     * The fault in one assertion: this is the bill that read as an October bill.
     */
    T.check(
      'so a September invoice paid in October is dated September, which is the confusion Ro reported',
      invoiceDateOf(billed.body.expense).date.startsWith(month) && billed.body.expense.datePaid.startsWith(paidMonth),
      `${invoiceDateOf(billed.body.expense).date} vs paid ${billed.body.expense.datePaid}`
    );
    T.check(
      'and it is reported as a real invoice date rather than a stand-in',
      invoiceDateOf(billed.body.expense).recorded === true,
      String(invoiceDateOf(billed.body.expense).recorded)
    );

    /* ================================================================
     * Rules 2 and 3 — optional, and honest about the fallback
     * ================================================================ */

    const noInvoice = await c.post('/api/expenses', {
      category: 'Security',
      vendor: 'Guardsman Ltd',
      unitNumber: 'General',
      amount: 96000,
      currency: 'JMD',
      status: 'paid',
      date: `${month}-10`,
      datePaid: `${month}-10`
    });
    T.check('a cost with no invoice date is still accepted', ok(noInvoice), String(noInvoice.body?.error));
    T.check(
      'nothing is invented for it',
      noInvoice.body?.expense?.invoiceDate === undefined,
      String(noInvoice.body?.expense?.invoiceDate)
    );
    T.check(
      'the logged date stands in, and is reported as standing in rather than passed off as the supplier’s',
      invoiceDateOf(noInvoice.body.expense).date === `${month}-10` &&
        invoiceDateOf(noInvoice.body.expense).recorded === false,
      JSON.stringify(invoiceDateOf(noInvoice.body.expense))
    );

    /* ---- it can be added later, and cleared again ---- */

    const added = await c.put(`/api/expenses/${noInvoice.body.expense.id}`, { invoiceDate: `${month}-08` });
    T.check('an invoice date can be added to a cost already on file', ok(added) && added.body?.expense?.invoiceDate === `${month}-08`, String(added.body?.expense?.invoiceDate));

    const untouched = await c.put(`/api/expenses/${noInvoice.body.expense.id}`, { description: 'Estate security' });
    T.check(
      'an edit that does not mention it leaves it alone',
      untouched.body?.expense?.invoiceDate === `${month}-08`,
      String(untouched.body?.expense?.invoiceDate)
    );

    const cleared = await c.put(`/api/expenses/${noInvoice.body.expense.id}`, { invoiceDate: '' });
    T.check(
      'and clearing it is explicit, rather than something an empty form does by accident',
      ok(cleared) && !cleared.body?.expense?.invoiceDate,
      String(cleared.body?.expense?.invoiceDate)
    );

    /* ================================================================
     * Rule 6 — a date that is not a date is refused
     * ================================================================ */

    const nonsense = await c.put(`/api/expenses/${noInvoice.body.expense.id}`, { invoiceDate: 'last Tuesday' });
    T.check(
      'a date that is not a date is refused rather than stored',
      nonsense.status === 400 && /invoice date/i.test(String(nonsense.body?.error)),
      `${nonsense.status} ${String(nonsense.body?.error).slice(0, 80)}`
    );

    /* ================================================================
     * Rule 4 — the monthly run, which is where utilities come in
     * ================================================================ */

    const template = await c.post('/api/recurring-expenses', {
      category: 'Utilities',
      vendor: 'NWC',
      description: 'Water',
      unitNumber: 'General',
      amount: 18000,
      currency: 'JMD',
      dueDay: 5
    });
    T.check('a monthly cost exists to post', ok(template), String(template.body?.error));

    const posted = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: template.body.template.id, amount: 18000, invoiceDate: `${month}-22` }]
    });
    T.check('the run accepts an invoice date typed against the line', ok(posted), String(posted.body?.error));

    let db = (await c.get('/api/db')).body;
    const raised = db.expenses.find(e => e.recurringId === template.body.template.id);
    T.check(
      'and the cost it raised carries the supplier’s date, not only the month it was posted for',
      raised?.invoiceDate === `${month}-22`,
      String(raised?.invoiceDate)
    );
    T.check(
      'while still being dated to the month it belongs to for reporting',
      raised?.periodMonth === month,
      String(raised?.periodMonth)
    );

    /* ================================================================
     * Rule 5 — none of this changes what anything cost
     * ================================================================ */

    /*
     * The important negative. Reporting is cash basis on purpose, so that the
     * surplus reconciles to the bank; the invoice date is a reference for
     * reconciliation and must not quietly move money between periods.
     *
     * The electricity bill is dated in the earlier month and paid in the later
     * one, so if the invoice date had leaked into the reports it would show up
     * here as the bill moving months.
     */
    db = (await c.get('/api/db')).body;
    const paidInBillMonth = expensesInPeriod(db.expenses, 'JMD', `${month}-01`, `${month}-28`);
    const paidInNextMonth = expensesInPeriod(db.expenses, 'JMD', `${paidMonth}-01`, `${paidMonth}-28`);

    T.check(
      'the electricity bill is still counted in the month its money moved, not the month it was dated',
      paidInNextMonth === 60000,
      `${paidInNextMonth}, expected 60000`
    );
    T.check(
      'and the month it was dated counts only what was actually paid in it',
      paidInBillMonth === 96000,
      `${paidInBillMonth}, expected 96000`
    );
    T.check(
      'the proprietors’ monthly report agrees, so nothing was restated by adding the field',
      operationsStatement(db.expenses, db.payments, 'JMD', `${paidMonth}-01`, `${paidMonth}-28`).costsPaid === 60000,
      String(operationsStatement(db.expenses, db.payments, 'JMD', `${paidMonth}-01`, `${paidMonth}-28`).costsPaid)
    );

    /* ---- and the records are still sound ---- */

    const integrity = await c.post('/api/integrity/check', {});
    T.check(
      'the application checks its own records and finds nothing serious',
      !ok(integrity) || !(integrity.body?.findings || []).some(f => f.severity === 'error'),
      JSON.stringify((integrity.body?.findings || []).filter(f => f.severity === 'error').slice(0, 3))
    );

    return T.done();
  } finally {
    types.cleanup();
    fin.cleanup();
    await srv.stop();
  }
}
