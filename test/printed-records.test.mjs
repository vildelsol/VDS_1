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
        export { IspoDocument } from './src/components/IspoOperations';
        export { ispoOperations } from './src/lib/finance';
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
    const { UnitLedgerDocument, TenancyRecordDocument, IspoDocument, ispoOperations, React, renderToStaticMarkup } = mod;

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
    // Ro, 2026-11-10: tenants pay rent, not maintenance; the corporation takes its
    // share out of the rent. The tenant's record says nothing about maintenance at all.
    T.check(
      'and it carries no maintenance section or wording of any kind',
      !/maintenance/i.test(tenantDoc) && !/Not included on this record/i.test(tenantDoc),
      tenantDoc.slice(0, 500)
    );
    T.check('and no details block with an agreed-rent figure (Ro, 2026-11-10)', !/Agreed rent/i.test(tenantDoc), tenantDoc.slice(0, 300));
    T.check(
      'and showing the receipt, so it is clear the rent was received',
      /receipt/i.test(tenantDoc) && /Payment received/i.test(tenantDoc),
      tenantDoc.slice(0, 500)
    );
    T.check('and no boilerplate about other occupancies or the unit ledger (Ro, 2026-11-10)', !/unit ledger/i.test(tenantDoc) && !/own rent account/i.test(tenantDoc), tenantDoc.slice(0, 500));

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
        'with no maintenance on the villa, nothing about maintenance appears',
        !/Not included on this record/i.test(rentOnly),
        rentOnly.slice(0, 300)
      );
      T.check('and it still carries the account history', /Account history/i.test(rentOnly), rentOnly.slice(0, 400));
    }

    /* ---------------- the ISPO Operations statement ----------------
     *
     * Ro, 2026-09-03: *"Ispo read only. also ensure it is printable."* It is, and
     * this is what makes that a fact rather than a claim — the document is
     * rendered and asked what it shows.
     *
     * The rule it must keep is the one the whole two-books change exists for: it
     * carries ISPO's income and ISPO's costs, and **no strata cost is on it**.
     */
    {
      const ispoUnit = { ...unit, id: 'iu1', number: 'V1', letOnOwnAccount: true, ownerName: 'MARKER-VDS' };
      const ispoPayments = [
        { id: 'ip1', unitId: 'iu1', unitNumber: 'V1', category: 'Rent', amount: 50000, currency: 'JMD', date: '2026-08-03', status: 'completed', payerName: 'MARKER-TENANT', method: 'Cash', receiptNo: 'R1' },
        { id: 'ip2', unitId: 'iu1', unitNumber: 'V1', category: 'Booking', amount: 22000, currency: 'JMD', date: '2026-08-11', status: 'completed', payerName: 'MARKER-GUEST', method: 'Cash', receiptNo: 'R2' },
        { id: 'ip3', unitId: 'iu1', unitNumber: 'V1', category: 'Maintenance', amount: 20000, currency: 'JMD', date: '2026-08-02', status: 'completed', payerName: 'MARKER-VDS', method: 'Cash', receiptNo: 'R3' }
      ];
      const ispoExpenseRows = [
        { id: 'ie1', category: 'Utilities', vendor: 'MARKER-DIGICEL', description: 'Company cell phones', unitId: '', unitNumber: 'General', amount: 18000, currency: 'JMD', fund: 'ispo', date: '2026-08-12', dueDate: '2026-08-12', datePaid: '2026-08-12', status: 'paid', paymentMethod: 'Cash', reference: '', notes: '' },
        { id: 'ie2', category: 'Other', vendor: 'MARKER-VEHICLE', description: 'Company vehicle insurance', unitId: '', unitNumber: 'General', amount: 34000, currency: 'JMD', fund: 'ispo', date: '2026-08-12', dueDate: '2026-08-12', datePaid: '2026-08-12', status: 'paid', paymentMethod: 'Cash', reference: '', notes: '' },
        { id: 'ie3', category: 'Security', vendor: 'MARKER-GUARDSMAN', description: 'Common property security', unitId: '', unitNumber: 'General', amount: 96000, currency: 'JMD', date: '2026-08-12', dueDate: '2026-08-12', datePaid: '2026-08-12', status: 'paid', paymentMethod: 'Cash', reference: '', notes: '' },
        { id: 'ie4', category: 'Contractors', vendor: 'MARKER-TYRES', description: 'Vehicle tyres, unpaid', unitId: '', unitNumber: 'General', amount: 25000, currency: 'JMD', fund: 'ispo', date: '2026-08-20', dueDate: '2026-08-20', status: 'pending', paymentMethod: 'Cash', reference: '', notes: '' }
      ];

      const statements = ['JMD', 'USD']
        .map(currency => ispoOperations(ispoExpenseRows, ispoPayments, [ispoUnit], currency, '2026-08-01', '2026-08-31'))
        .filter(x => !x.empty);

      T.check('the ISPO statement has something to print', statements.length === 1, `${statements.length} currency blocks`);

      const doc = strip(
        renderToStaticMarkup(
          React.createElement(IspoDocument, {
            statements,
            month: '2026-08',
            generatedBy: 'MARKER-PREPARER',
            onClose: () => {}
          })
        )
      );

      T.check('it prints at all', doc.length > 400, `${doc.length} characters`);
      T.check('the rent is on it', /50,000/.test(doc), doc.slice(0, 400));
      T.check('so is the short-stay income, which is ISPO’s too', /22,000/.test(doc), doc.slice(0, 400));
      T.check('the cell phone is named, not lumped into a total', /MARKER-DIGICEL/.test(doc), doc.slice(0, 600));
      T.check('and the company vehicle', /MARKER-VEHICLE/.test(doc));
      T.check(
        'the contribution ISPO pays on its own villa is on it',
        /Maintenance paid on villas let on own account/i.test(doc) && /20,000/.test(doc),
        doc.slice(0, 800)
      );
      T.check(
        '⚠ and no strata cost appears anywhere on it',
        !/MARKER-GUARDSMAN/.test(doc),
        'a corporation cost reached the ISPO statement'
      );
      T.check(
        'the unpaid bill is declared rather than folded into the cash figures',
        /not yet paid/i.test(doc) && /25,000/.test(doc),
        doc.slice(0, 900)
      );
      T.check(
        'it says on its face that it is internal and not for owners',
        /Internal document/i.test(doc) && /not for circulation/i.test(doc),
        doc.slice(0, 500)
      );
      T.check('and it carries who prepared it', /MARKER-PREPARER/.test(doc), doc.slice(0, 400));
    }

    return T.done();
  } finally {
    cleanup();
  }
}
