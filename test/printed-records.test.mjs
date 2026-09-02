/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Does the printed record actually contain the record?
 *
 * On 2026-09-02 Ro recorded a rent payment and a maintenance payment against C11,
 * opened the villa in the register, pressed "Print record" and found only the
 * rent. The reasonable conclusion — the one he drew — is that the maintenance
 * receipt had not saved. It had. The button opened the *tenant's* record, which
 * covers rent by design because maintenance is the proprietor's liability, and
 * the document said nothing whatsoever about that. A silent omission on a
 * document that looks complete is indistinguishable from lost data.
 *
 * Two faults were found by reproducing it, and both are asserted here:
 *
 *   1. the tenant record omitted maintenance without declaring it;
 *   2. **the unit ledger listed every receipt and not one charge**, so the
 *      villa's own record showed money coming in with nothing to reconcile it
 *      against.
 *
 * This file exists so a whole class of record cannot go missing from a printed
 * document again. Every record type is seeded once, each document is rendered,
 * and each is asked what it shows — because until PrintPortal was made to render
 * without a DOM, not one printed document in this application could be asserted
 * on at all. The figures that fed them were tested; the documents never were.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Printed records carry the records';

async function loadDocuments(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-printed-'));
  const outfile = path.join(dir, 'docs.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { UnitLedgerDocument, TenancyRecordDocument } from './src/components/Units';
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

/* Every fixture carries a unique marker so "is it on the page" is unambiguous. */
const unit = {
  id: 'u1', number: 'C11', ownerName: 'MARKER-OWNER', ownerEmail: '', ownerPhone: '',
  tenantName: 'MARKER-TENANT', tenantEmail: '', tenantPhone: '', status: 'long-term',
  monthlyRent: 80000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD',
  rentDueDay: 7, maintDueDay: 1, meterNumber: 'MARKER-METER', notes: ''
};

const charges = [
  { id: 'c1', unitId: 'u1', unitNumber: 'C11', category: 'Rent', periodMonth: '2026-08', dueDate: '2026-08-07', amount: 80000, currency: 'JMD', status: 'open', payerName: 'MARKER-TENANT', description: 'MARKER-RENT-CHARGE', createdAt: '', createdBy: 't' },
  { id: 'c2', unitId: 'u1', unitNumber: 'C11', category: 'Maintenance', periodMonth: '2026-08', dueDate: '2026-08-01', amount: 20000, currency: 'JMD', status: 'open', payerName: 'MARKER-OWNER', description: 'MARKER-MAINT-CHARGE', createdAt: '', createdBy: 't' },
  { id: 'c3', unitId: 'u1', unitNumber: 'C11', category: 'Maintenance', periodMonth: '2026-07', dueDate: '2026-07-01', amount: 15000, currency: 'JMD', status: 'void', voidReason: 'MARKER-VOID-REASON', payerName: 'MARKER-OWNER', description: 'MARKER-VOID-CHARGE', createdAt: '', createdBy: 't' }
];

const payments = [
  { id: 'p1', unitId: 'u1', unitNumber: 'C11', category: 'Rent', amount: 80000, currency: 'JMD', date: '2026-08-08', status: 'completed', payerName: 'MARKER-TENANT', method: 'Cash', receiptNo: 'MARKER-RENT-RECEIPT' },
  { id: 'p2', unitId: 'u1', unitNumber: 'C11', category: 'Maintenance', amount: 20000, currency: 'JMD', date: '2026-08-03', status: 'completed', payerName: 'MARKER-OWNER', method: 'Cash', receiptNo: 'MARKER-MAINT-RECEIPT' }
];

const tenancy = {
  id: 't1', unitId: 'u1', unitNumber: 'C11', tenantName: 'MARKER-TENANT', tenantEmail: '', tenantPhone: '',
  status: 'active', startedOn: '2026-01-01', monthlyRent: 80000, currency: 'JMD', rentDueDay: 7,
  recordedAt: '2026-01-01T00:00:00Z'
};

const utilities = [
  { id: 'ut1', unitId: 'u1', unitNumber: 'C11', billingPeriod: '2026-08', previousReading: 100, currentReading: 250, consumption: 150, ratePerUnit: 60, amount: 9000, currency: 'JMD', status: 'unpaid', readingDate: '2026-08-28', meterNumber: 'MARKER-METER', notes: 'MARKER-UTILITY' }
];

const bookings = [
  { id: 'b1', unitId: 'u1', unitNumber: 'C11', guestName: 'MARKER-GUEST', checkIn: '2026-08-10', checkOut: '2026-08-14', nights: 4, nightlyRate: 200, totalAmount: 800, currency: 'USD', status: 'confirmed', source: 'Direct', guestEmail: '', guestPhone: '', notes: '' }
];

const expenses = [
  { id: 'e1', category: 'Repairs', vendor: 'MARKER-VENDOR', description: 'MARKER-EXPENSE', unitId: 'u1', unitNumber: 'C11', amount: 12000, currency: 'JMD', date: '2026-08-20', dueDate: '2026-08-20', datePaid: '2026-08-20', status: 'paid', paymentMethod: 'Cash', reference: '', notes: '' }
];

/*
 * Field names taken from the UnitActivity interface, not from memory.
 *
 * The first version of this fixture invented `summary`/`detail`/`occurredOn`, and
 * the test duly reported that the unit ledger was dropping recorded activity. It
 * was not — the fixture was. These files are plain .mjs and nothing typechecks
 * them, so a fixture that does not match the interface produces a confident,
 * wrong answer. When a check here fails, read the type before believing it.
 */
const unitActivities = [
  {
    id: 'a1',
    unitId: 'u1',
    unitNumber: 'C11',
    residentName: 'MARKER-ACTIVITY',
    residentRole: 'Tenant',
    activityType: 'Pool Reservation',
    dateCaptured: '2026-08-15',
    notes: 'MARKER-ACTIVITY-DETAIL',
    loggedBy: 'Tester',
    loggedAt: '2026-08-15T00:00:00Z'
  }
];

const strip = html => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, "'").replace(/\s+/g, ' ').trim();

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadDocuments(projectRoot);
  try {
    const { UnitLedgerDocument, TenancyRecordDocument, React, renderToStaticMarkup } = mod;

    /* ---------------- the villa's own record ---------------- */
    const ledger = strip(
      renderToStaticMarkup(
        React.createElement(UnitLedgerDocument, {
          unit, units: [unit], charges, payments, utilities, bookings,
          tenancies: [tenancy], expenses, unitActivities,
          generatedBy: 'Tester', onClose: () => {}
        })
      )
    );

    T.check('the printed unit ledger renders at all', ledger.length > 200, `${ledger.length} chars`);

    // Every class of record the application can hold against a villa. A whole
    // class going missing is the failure this file was written for.
    const mustAppear = [
      ['the rent charge', 'MARKER-RENT-CHARGE'],
      ['the maintenance charge', 'MARKER-MAINT-CHARGE'],
      ['a voided charge, marked as void', 'MARKER-VOID-CHARGE'],
      ['and the reason it was voided', 'MARKER-VOID-REASON'],
      ['the rent receipt', 'MARKER-RENT-RECEIPT'],
      ['the maintenance receipt', 'MARKER-MAINT-RECEIPT'],
      ['the utility reading', 'MARKER-METER'],
      ['the guest reservation', 'MARKER-GUEST'],
      ['the expense charged to the villa', 'MARKER-EXPENSE'],
      ['the vendor who was paid', 'MARKER-VENDOR'],
      ['the recorded activity', 'MARKER-ACTIVITY'],
      ['and the note written on it', 'MARKER-ACTIVITY-DETAIL'],
      ['the occupancy history', 'MARKER-TENANT'],
      ['the registered owner', 'MARKER-OWNER']
    ];
    for (const [what, marker] of mustAppear) {
      T.check(`the unit ledger carries ${what}`, ledger.includes(marker), `"${marker}" not found`);
    }

    T.check('and it states both account balances', ledger.includes('Rent account') && ledger.includes('HOA maintenance account'));

    /* ---------------- the tenant's own record ---------------- */
    const tenantDoc = strip(
      renderToStaticMarkup(
        React.createElement(TenancyRecordDocument, {
          tenancy, unit, units: [unit], charges, payments, generatedBy: 'Tester', onClose: () => {}
        })
      )
    );

    T.check('the tenant record carries the rent receipt', tenantDoc.includes('MARKER-RENT-RECEIPT'));
    T.check('and the rent charge', tenantDoc.includes('MARKER-RENT-CHARGE') || tenantDoc.includes('Rent charged'));

    // The design decision, kept deliberately: a tenant is not handed the
    // proprietor's account. What changed is that it now says so.
    T.check(
      'it still does not put the proprietor’s maintenance on a tenant’s record',
      !tenantDoc.includes('MARKER-MAINT-RECEIPT'),
      'maintenance receipt leaked onto the tenant record'
    );
    T.check(
      'but it declares that maintenance is excluded',
      /Not included on this record/i.test(tenantDoc),
      tenantDoc.slice(0, 400)
    );
    T.check(
      'naming the amount billed, so nothing looks lost',
      tenantDoc.includes('20,000.00'),
      tenantDoc.slice(0, 500)
    );
    T.check(
      'and saying it was received rather than leaving it ambiguous',
      /receipt/i.test(tenantDoc) && /recorded/i.test(tenantDoc),
      tenantDoc.slice(0, 500)
    );
    T.check(
      'and pointing at the document that does carry it',
      /unit ledger/i.test(tenantDoc),
      tenantDoc.slice(0, 500)
    );

    /* ---------------- a villa with nothing on it ---------------- */
    {
      // An empty class must say it is empty rather than vanishing, or "no section"
      // and "no records" look the same to whoever is reading.
      const bare = strip(
        renderToStaticMarkup(
          React.createElement(UnitLedgerDocument, {
            unit, units: [unit], charges: [], payments: [], utilities: [], bookings: [],
            tenancies: [], expenses: [], unitActivities: [], generatedBy: 'Tester', onClose: () => {}
          })
        )
      );
      T.check('an empty villa still prints a record', bare.length > 200);
      T.check('saying no charges have been raised', /No charges have been raised/i.test(bare), bare.slice(0, 300));
      T.check('and no payments recorded', /No payments recorded/i.test(bare), bare.slice(0, 300));
    }

    /* ---------------- a tenancy with no maintenance at all ---------------- */
    {
      // The declaration must not appear when there is nothing to declare, or it
      // becomes noise on every document and stops being read.
      const rentOnly = strip(
        renderToStaticMarkup(
          React.createElement(TenancyRecordDocument, {
            tenancy, unit, units: [unit], charges: [charges[0]], payments: [payments[0]],
            generatedBy: 'Tester', onClose: () => {}
          })
        )
      );
      T.check(
        'with no maintenance on the villa, nothing is declared as excluded',
        !/Not included on this record/i.test(rentOnly),
        rentOnly.slice(0, 300)
      );
      T.check('though the document still explains it covers rent only', /covers rent only/i.test(rentOnly), rentOnly.slice(0, 400));
    }

    return T.done();
  } finally {
    cleanup();
  }
}
