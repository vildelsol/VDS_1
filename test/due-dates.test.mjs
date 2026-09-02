/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Posted is not the same as due.
 *
 * Posting a month raises every charge in it at once, each carrying the due date
 * built from the villa's own rent or maintenance day. Rent posted on the 1st and
 * due on the 7th is a real, open charge for six days before anybody is late — and
 * `delinquentAccounts` counted it, because every screen called it without an
 * "as of" date and it therefore weighed each open charge regardless of when it
 * fell due. The notifications hub said "Rent outstanding — 1 unpaid month" about
 * money nobody owed yet.
 *
 * Ro's objection on 2026-09-01 is the one this file exists to hold: if a charge
 * is treated as late from the day it is posted, recording a due date at all is
 * pointless. An alert that fires before anything is wrong is an alert people stop
 * reading — and they will still not be reading it on the day it is right.
 *
 * The rule asserted here, in both directions:
 *
 *   - **before the due date** the money is scheduled: shown, never counted as
 *     arrears, never in a total of what is owed;
 *   - **on the due date** it becomes arrears, with no re-posting and nothing for
 *     anyone to do;
 *   - and **a payment can still be taken early**, because a tenant paying on the
 *     1st for the 7th is ordinary and the money must have somewhere to go.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathToFileURL as toUrl } from 'node:url';
import { build } from 'esbuild';
import { reporter, localToday } from './harness.mjs';

export const title = 'Due dates: posted is not due';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-due-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The notifications hub itself, server-rendered.
 *
 * The engine rule above says a scheduled charge is not arrears. This asserts the
 * half a person actually sees: that it is on the page, in grey, saying when it
 * falls due — and that the charge which *is* due is untouched beside it. A rule
 * that is right in the engine and amber on the screen would not have answered the
 * complaint.
 */
async function loadHub(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hub-'));
  const outfile = path.join(dir, 'hub.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as NotificationsTab } from './src/components/NotificationsTab';
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
  const mod = await import(toUrl(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ALL_PERMISSIONS = {
  recordPayments: true,
  editBookings: true,
  cancelBookings: true,
  addBookings: true,
  editUnits: true,
  reversePayments: true,
  enterUtilities: true,
  recordExpenses: true,
  modifySettledRecords: true,
  postCharges: true
};

const villa = (over = {}) => ({
  id: 'unit-1',
  number: '1',
  ownerName: 'Owner',
  ownerEmail: '',
  ownerPhone: '',
  tenantName: 'Tenant',
  tenantEmail: '',
  tenantPhone: '',
  status: 'long-term',
  monthlyRent: 80000,
  monthlyMaintenance: 20000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  rentDueDay: 7,
  maintDueDay: 1,
  meterNumber: '',
  notes: '',
  ...over
});

const rentCharge = (over = {}) => ({
  id: 'chg-1',
  unitId: 'unit-1',
  unitNumber: '1',
  category: 'Rent',
  periodMonth: '2026-09',
  dueDate: '2026-09-07',
  amount: 80000,
  currency: 'JMD',
  status: 'open',
  payerName: 'Tenant',
  createdAt: '',
  createdBy: 'test',
  ...over
});

const rentPayment = (over = {}) => ({
  id: 'pay-1',
  unitId: 'unit-1',
  unitNumber: '1',
  category: 'Rent',
  amount: 80000,
  currency: 'JMD',
  date: '2026-09-01',
  status: 'completed',
  payerName: 'Tenant',
  method: 'Cash',
  receiptNo: 'R1',
  ...over
});

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, "'").replace(/\s+/g, ' ').trim();

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadFinance(projectRoot);
  try {
    const { delinquentAccounts, scheduledCharges, accountBalance } = mod;

    const units = [villa()];
    const charges = [rentCharge()];

    /* ---------------- before the due day ---------------- */
    {
      const POSTED = '2026-09-01'; // month posted; rent due on the 7th
      const arrears = delinquentAccounts(units, charges, [], POSTED);
      T.check(
        'rent posted on the 1st and due on the 7th is not arrears on the 1st',
        arrears.length === 0,
        JSON.stringify(arrears.map(a => [a.unit.number, a.category, a.balance]))
      );

      const scheduled = scheduledCharges(units, charges, [], POSTED);
      T.check('but it is not invisible either — it is reported as scheduled', scheduled.length === 1, String(scheduled.length));
      T.check('for the right amount', scheduled[0].amount === 80000, String(scheduled[0]?.amount));
      T.check('naming the day it falls due', scheduled[0].nextDueDate === '2026-09-07', scheduled[0]?.nextDueDate);
      T.check('and how long there is until then', scheduled[0].daysUntilDue === 6, String(scheduled[0]?.daysUntilDue));
      T.check('in the account currency', scheduled[0].currency === 'JMD', scheduled[0]?.currency);
    }

    /* ---------------- the boundary ---------------- */
    {
      // The day itself is due, not scheduled. Off by one here would either alert a
      // day early — the whole complaint — or leave a day of silence after it fell due.
      T.check(
        'on the due day it becomes arrears',
        delinquentAccounts(units, charges, [], '2026-09-07').length === 1
      );
      T.check(
        'and stops being scheduled on that same day',
        scheduledCharges(units, charges, [], '2026-09-07').length === 0
      );
      T.check(
        'the day before, it is still only scheduled',
        delinquentAccounts(units, charges, [], '2026-09-06').length === 0 &&
          scheduledCharges(units, charges, [], '2026-09-06').length === 1
      );
      T.check(
        'and it ages from the due date, not from the posting date',
        delinquentAccounts(units, charges, [], '2026-09-17')[0].oldestUnpaidDays === 10,
        String(delinquentAccounts(units, charges, [], '2026-09-17')[0]?.oldestUnpaidDays)
      );
    }

    /* ---------------- paying early ---------------- */
    {
      const payments = [rentPayment()];
      // Asked without a date — the question the payment screen asks. The money has
      // somewhere to go, and the account is square.
      const open = accountBalance(villa(), 'Rent', charges, payments, undefined, units);
      T.check('a tenant can pay on the 1st for rent due on the 7th', open.balance === 0, String(open.balance));

      T.check(
        'and having paid, nothing is reported as still to be found',
        scheduledCharges(units, charges, payments, '2026-09-01').length === 0,
        JSON.stringify(scheduledCharges(units, charges, payments, '2026-09-01').map(r => r.amount))
      );
      T.check(
        'nor as arrears when the day arrives',
        delinquentAccounts(units, charges, payments, '2026-09-07').length === 0
      );

      // A part payment leaves only the remainder scheduled, not the whole charge.
      const part = [rentPayment({ amount: 30000 })];
      const rest = scheduledCharges(units, charges, part, '2026-09-01');
      T.check('a part payment leaves only the balance scheduled', rest.length === 1 && rest[0].amount === 50000, JSON.stringify(rest.map(r => r.amount)));
    }

    /* ---------------- what must not change ---------------- */
    {
      // Maintenance due on the 1st is due the day it is posted. The fix must not
      // grant every charge a grace period it was never given.
      const maint = [
        {
          ...rentCharge(),
          id: 'chg-m',
          category: 'Maintenance',
          dueDate: '2026-09-01',
          amount: 20000
        }
      ];
      T.check(
        'a charge due on the day it is posted is due immediately',
        delinquentAccounts(units, maint, [], '2026-09-01').length === 1
      );
      T.check('and is not reported as scheduled', scheduledCharges(units, maint, [], '2026-09-01').length === 0);

      // An overdue charge from a previous month stays overdue while a later month
      // sits scheduled beside it — the two must not cancel out.
      const both = [rentCharge({ id: 'old', periodMonth: '2026-08', dueDate: '2026-08-07' }), rentCharge()];
      const mixed = delinquentAccounts(units, both, [], '2026-09-01');
      T.check('August overdue and September scheduled are reported separately', mixed.length === 1 && mixed[0].balance === 80000, JSON.stringify(mixed.map(m => m.balance)));
      T.check('with only the September charge scheduled', scheduledCharges(units, both, [], '2026-09-01')[0].amount === 80000);
    }

    /* ---------------- a villa nobody bills ---------------- */
    {
      // Nothing posted at all must not manufacture a scheduled item, or every
      // configured villa would appear on the list for ever.
      T.check('a villa with nothing posted reports nothing scheduled', scheduledCharges(units, [], [], '2026-09-01').length === 0);
      T.check(
        'and a voided charge is not scheduled either',
        scheduledCharges(units, [rentCharge({ status: 'void' })], [], '2026-09-01').length === 0
      );
    }

    /* ---------------- and what the screen actually shows ---------------- */
    {
      const hub = await loadHub(projectRoot);
      try {
        const { NotificationsTab, React, renderToStaticMarkup } = hub.mod;
        const today = localToday();
        const inSixDays = new Date(Date.parse(today + 'T12:00:00') + 6 * 86400000).toISOString().slice(0, 10);

        const screenUnits = [villa()];
        const screenCharges = [
          // Rent posted, due in six days — the case Ro raised.
          rentCharge({ id: 'later', periodMonth: today.slice(0, 7), dueDate: inSixDays }),
          // Maintenance due today — must be unaffected.
          rentCharge({ id: 'now', category: 'Maintenance', periodMonth: today.slice(0, 7), dueDate: today, amount: 20000 })
        ];

        const html = renderToStaticMarkup(
          React.createElement(NotificationsTab, {
            units: screenUnits,
            settings: { booksBeginOn: '', vendors: [], fxRateJmdPerUsd: 158, rolePermissions: {}, backupDir: '' },
            charges: screenCharges,
            payments: [],
            utilities: [],
            tenancies: [],
            expenses: [],
            bookings: [],
            session: { id: 'u1', name: 'Tester', username: 't', email: '', position: '', role: 'ADMINISTRATOR', mustChangePassword: false, permissions: ALL_PERMISSIONS },
            onNavigateToTab: () => {},
            onRecordPayment: async () => ({}),
            onSettleUtility: async () => ({}),
            onUpdateExpense: async () => ({}),
            onPostMonth: async () => ({})
          })
        );
        const words = text(html);

        T.check('the scheduled rent is on the page, not hidden', words.includes('Rent due'), words.slice(0, 200));
        T.check('marked as not yet due', words.includes('Not yet due'), words.slice(0, 300));
        T.check('and it does not call itself outstanding', !words.includes('Rent outstanding'), words.slice(0, 300));
        T.check(
          'the maintenance that IS due still reads as outstanding',
          words.includes('HOA maintenance outstanding'),
          words.slice(0, 300)
        );
        T.check(
          'the open-items count is 1, not 2 — the scheduled one is not owed',
          / 1 <\/h3>|>1<\/h3>/.test(html.replace(/\s+/g, ' ')) || words.includes('1 more posted, not yet due'),
          words.slice(0, 240)
        );
        T.check('and the page says so in words', words.includes('1 more posted, not yet due'), words.slice(0, 300));

        // The grey. A rule that is right in the engine and amber on screen would
        // not have answered the complaint at all.
        T.check('the scheduled row is rendered grey, not amber', html.includes('bg-slate-100 text-slate-500'), 'no grey tint found');
        T.check('and the due one is still amber', html.includes('bg-amber-50 text-amber-600'), 'no amber tint found');
      } finally {
        hub.cleanup();
      }
    }

    return T.done();
  } finally {
    cleanup();
  }
}
