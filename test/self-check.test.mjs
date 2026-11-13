/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The records checking themselves, on the live machine.
 *
 * The rest of this suite proves the code is right when it runs here. This proves
 * the application can tell, on the HP in Ocho Rios, whether the file it just
 * opened still makes sense — after a year of use, a restore from a USB stick, a
 * half-finished upgrade, or a disk that started returning bad sectors.
 *
 * Two failure modes matter and they pull against each other:
 *
 *   - **Missing a real fault** makes the check worse than useless, because a
 *     clean bill of health is what somebody will act on. So each invariant is
 *     tested against a database deliberately broken in exactly that way.
 *   - **Crying wolf** is nearly as bad. A check that reports problems on a
 *     healthy property gets ignored within a week, and then the real finding is
 *     ignored with it. So a large, busy, entirely legitimate database — the one
 *     the simulations build — must come back clean.
 *
 * The checker must also never repair anything and never throw.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'The records checking themselves';

async function loadChecker(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-selfcheck-'));
  const outfile = path.join(dir, 'integrity.mjs');
  await build({
    entryPoints: [path.join(projectRoot, 'server', 'integrity.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    external: ['crypto'],
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A small, entirely coherent property. */
function healthyDb() {
  return {
    schemaVersion: 3,
    units: [
      { id: 'unit-1', number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD' }
    ],
    tenancies: [],
    bookings: [],
    charges: [
      { id: 'chg-1', unitId: 'unit-1', unitNumber: '1', category: 'Rent', periodMonth: '2026-07', dueDate: '2026-07-01', amount: 50000, currency: 'JMD', status: 'open' }
    ],
    payments: [
      { id: 'p-1', unitId: 'unit-1', unitNumber: '1', category: 'Rent', amount: 50000, currency: 'JMD', date: '2026-07-02', status: 'completed', receiptNo: 'REC-2026-0001' }
    ],
    utilities: [],
    expenses: [],
    recurringExpenses: [],
    annualReports: [],
    auditLogs: [],
    unitActivities: [],
    users: [],
    sessions: [],
    counters: { receiptYear: 2026, receiptSeq: 1 },
    settings: {}
  };
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadChecker(projectRoot);
  const { checkIntegrity, describeIntegrity } = mod;

  const codesFrom = report => report.findings.map(f => f.code);

  try {
    /* ---------------- a healthy property must come back clean ---------------- */

    {
      const r = checkIntegrity(healthyDb());
      T.check('a coherent property reports no problems', r.ok === true, JSON.stringify(codesFrom(r)));
      T.check('and says how much it actually looked at', r.counts.payments === 1 && r.counts.charges === 1, JSON.stringify(r.counts));
      T.check('and describes itself in one quiet line', /no contradictions found/.test(describeIntegrity(r)), describeIntegrity(r));
    }

    {
      // An empty database is coherent, but "ok" on nothing must not read as a
      // pass over real records — hence the counts.
      const empty = { ...healthyDb(), units: [], charges: [], payments: [] };
      const r = checkIntegrity(empty);
      T.check('an empty database is not a contradiction', r.ok === true);
      T.check('but its counts say plainly that nothing was there', r.counts.payments === 0 && r.counts.units === 0);
    }

    /* ---------------- each fault is actually caught ---------------- */

    const broken = (mutate, code, label) => {
      const db = healthyDb();
      mutate(db);
      const r = checkIntegrity(db);
      T.check(`it catches ${label}`, codesFrom(r).includes(code), `found ${JSON.stringify(codesFrom(r))}`);
      return r;
    };

    broken(db => db.payments.push({ ...db.payments[0] }), 'duplicate-payment-id', 'two payments sharing an id');
    broken(
      db => db.payments.push({ ...db.payments[0], id: 'p-2' }),
      'duplicate-receipt-number',
      'the same receipt number issued twice'
    );
    broken(db => delete db.payments[0].receiptNo, 'received-without-receipt', 'money received with no receipt raised');
    broken(
      db => db.payments.push({ ...db.payments[0], id: 'p-3', status: 'pending', receiptNo: 'REC-2026-0009' }),
      'expected-holds-receipt',
      'an expected payment holding a receipt number'
    );
    broken(db => (db.payments[0].amount = 0), 'impossible-payment-amount', 'a payment of nothing');

    /*
     * The audit trail is trimmed oldest-first at 20,000 entries and there is no
     * archive, so the governance record would quietly lose its beginning. Warned
     * about before the ceiling rather than after, when there would be nothing
     * left to warn with.
     */
    {
      const db = healthyDb();
      db.auditLogs = Array.from({ length: 18500 }, (_, i) => ({ id: `a-${i}`, action: 'x', dateTime: '2026-01-01T00:00:00.000Z' }));
      const r = checkIntegrity(db);
      T.check(
        'it warns before the audit trail starts dropping its oldest entries',
        codesFrom(r).includes('audit-trail-near-capacity'),
        JSON.stringify(codesFrom(r))
      );
      T.check(
        'and that is a warning, not a misstatement of money',
        r.findings.find(f => f.code === 'audit-trail-near-capacity')?.severity === 'warning',
        'wrong severity'
      );
    }
    {
      const r = checkIntegrity(healthyDb());
      T.check('an ordinary audit trail raises no such warning', !codesFrom(r).includes('audit-trail-near-capacity'), JSON.stringify(codesFrom(r)));
    }

    /*
     * Money stranded in a currency the account is not billed in.
     *
     * Balances are computed per unit, per category, per currency, and nothing is
     * ever combined across currencies — so a record in the other currency is
     * counted by neither side. The API refuses to *raise* one, but changing the
     * villa's own currency after charges exist strands every charge already on
     * the books, and that edit is one keystroke on the register.
     *
     * The consequence is the dangerous direction: the villa still owes the money,
     * "Billed to date" reads nil, and a correctly denominated receipt then shows
     * the account as being in credit. Serious, because money is misstated.
     */
    broken(
      db => (db.units[0].currency = 'USD'),
      'charge-in-unbilled-currency',
      'a villa re-denominated while charges were already open against it'
    );
    broken(
      db => {
        db.units[0].maintCurrency = 'USD';
        db.charges.push({
          id: 'chg-m',
          unitId: 'unit-1',
          unitNumber: '1',
          category: 'Maintenance',
          periodMonth: '2026-07',
          dueDate: '2026-07-01',
          amount: 20000,
          currency: 'JMD',
          status: 'open'
        });
      },
      'charge-in-unbilled-currency',
      'a maintenance charge left behind when the maintenance currency changed'
    );
    {
      // The receipt side of the same fault, reported but not as a misstatement:
      // the money exists and is recorded, it just settles nothing here.
      const r = broken(
        db => (db.units[0].maintCurrency = 'USD') && db.payments.push({
          ...db.payments[0],
          id: 'p-m',
          category: 'Maintenance',
          receiptNo: 'REC-2026-0007'
        }),
        'payment-in-unbilled-currency',
        'a receipt recorded in a currency the account is not billed in'
      );
      T.check(
        'and a stranded receipt is a warning rather than a misstatement of money',
        r.findings.find(f => f.code === 'payment-in-unbilled-currency')?.severity === 'warning',
        JSON.stringify(r.findings.map(f => [f.code, f.severity]))
      );
    }
    {
      // A charge voided before the currency changed is not stranded — it is not
      // in any balance by design, so reporting it would be noise that trains
      // people to ignore the check.
      const db = healthyDb();
      db.charges[0].status = 'void';
      db.units[0].currency = 'USD';
      const r = checkIntegrity(db);
      T.check(
        'a voided charge left in the other currency is not reported',
        !codesFrom(r).includes('charge-in-unbilled-currency'),
        JSON.stringify(codesFrom(r))
      );
    }
    broken(db => (db.payments[0].amount = Number.NaN), 'impossible-payment-amount', 'a payment that is not a number');
    broken(db => (db.payments[0].refundedAmount = 60000), 'refunded-beyond-worth', 'more refunded than was ever received');

    // The one that takes the money off the ledger twice.
    broken(
      db => {
        db.payments[0].status = 'reversed';
        db.payments[0].refundedAmount = 10000;
      },
      'voided-and-refunded',
      'a receipt both voided and refunded'
    );
    broken(
      db => {
        db.payments[0].status = 'reversed';
        db.payments[0].reconciledOn = '2026-07-31';
      },
      'voided-but-reconciled',
      'a voided receipt still ticked off against the bank'
    );

    broken(
      db => db.charges.push({ ...db.charges[0], id: 'chg-2' }),
      'month-billed-twice',
      'the same month billed twice on one account'
    );
    broken(db => (db.charges[0].amount = -1), 'impossible-charge-amount', 'a charge for a negative amount');
    broken(db => db.charges.push({ ...db.charges[0] }), 'duplicate-charge-id', 'two charges sharing an id');

    // The next receipt would reuse a number already on a printed document.
    broken(db => (db.counters.receiptSeq = 0), 'receipt-counter-behind', 'a receipt counter that has fallen behind');

    {
      // The receipt format is REC-YYYY-NNNN. The counter check reads it with a
      // pattern, and that pattern read `R-` until it was tried against a real
      // database — it matched nothing, so the check passed on every property
      // that had ever issued a receipt. Pin the real format here: a guard that
      // cannot fire is worse than no guard, because it is counted as coverage.
      const db = healthyDb();
      db.payments[0].receiptNo = 'REC-2026-0007';
      db.counters.receiptSeq = 3;
      const r = checkIntegrity(db);
      T.check(
        'and it reads the real receipt format, not one that never matches',
        codesFrom(r).includes('receipt-counter-behind'),
        `receipt was ${db.payments[0].receiptNo}, found ${JSON.stringify(codesFrom(r))}`
      );
    }

    broken(
      db => db.bookings.push({ id: 'b-1', unitId: 'unit-1', unitNumber: '1', checkIn: '2026-08-10', checkOut: '2026-08-05', status: 'confirmed' }),
      'booking-ends-before-it-starts',
      'a stay ending before it starts'
    );
    broken(
      db =>
        db.bookings.push(
          { id: 'b-2', unitId: 'unit-1', unitNumber: '1', checkIn: '2026-08-01', checkOut: '2026-08-05', status: 'confirmed' },
          { id: 'b-3', unitId: 'unit-1', unitNumber: '1', checkIn: '2026-08-03', checkOut: '2026-08-07', status: 'confirmed' }
        ),
      'villa-sold-twice',
      'one villa confirmed to two guests on the same night'
    );
    broken(
      db =>
        db.bookings.push({
          id: 'b-4',
          unitId: 'unit-1',
          unitNumber: '1',
          checkIn: '2026-09-01',
          checkOut: '2026-09-05',
          status: 'confirmed',
          damageDepositAmount: 100,
          damageDepositReturnedAmount: 80,
          damageDepositWithheldAmount: 50
        }),
      'damage-deposit-over-settled',
      'a damage deposit settled beyond what was held'
    );
    broken(
      db =>
        db.tenancies.push({
          id: 't-1',
          unitId: 'unit-1',
          depositAmount: 50000,
          depositReturnedOn: '2026-08-01',
          depositReturnedAmount: 40000,
          depositWithheldAmount: 20000
        }),
      'deposit-over-settled',
      'a tenant deposit settled beyond what was held'
    );

    broken(
      db => {
        db.expenses.push({ id: 'ex-1', category: 'Maintenance', amount: 5000, currency: 'JMD', status: 'paid', date: '2026-07-01' });
        db.unitActivities.push({ id: 'a-1', unitId: 'unit-1', expenseId: 'ex-1' }, { id: 'a-2', unitId: 'unit-1', expenseId: 'ex-1' });
      },
      'work-order-cost-raised-twice',
      'one job’s cost reaching the expense register twice'
    );
    broken(
      db =>
        db.expenses.push(
          { id: 'ex-2', category: 'Security', amount: 1000, currency: 'JMD', status: 'paid', date: '2026-07-01', recurringId: 'rex-1', periodMonth: '2026-07' },
          { id: 'ex-3', category: 'Security', amount: 1000, currency: 'JMD', status: 'paid', date: '2026-07-01', recurringId: 'rex-1', periodMonth: '2026-07' }
        ),
      'monthly-cost-posted-twice',
      'a standing monthly cost posted twice for one month'
    );
    broken(
      db => db.utilities.push({ id: 'ut-1', unitId: 'unit-1', previousReading: 900, currentReading: 100 }),
      'meter-ran-backwards',
      'a meter reading lower than the one before it'
    );

    broken(db => db.units.push({ ...db.units[0] }), 'duplicate-unit-id', 'two villas sharing an id');
    broken(db => (db.units[0].monthlyRent = -5), 'impossible-unit-figure', 'a villa with a negative rent');
    broken(
      db => db.charges.push({ ...db.charges[0], id: 'chg-9', unitId: 'unit-999' }),
      'record-points-at-missing-villa',
      'a charge pointing at a villa no longer on the register'
    );

    /* ---------------- serious and warning are told apart ---------------- */

    {
      const db = healthyDb();
      db.utilities.push({ id: 'ut-2', unitId: 'unit-1', previousReading: 900, currentReading: 100 });
      const r = checkIntegrity(db);
      T.check('a meter reading backwards is a warning, not a misstatement of money', r.serious === 0 && r.warnings === 1, JSON.stringify(r));
      T.check('and the report is not "ok" even so', r.ok === false);
    }

    {
      const db = healthyDb();
      db.payments.push({ ...db.payments[0], id: 'p-9' });
      const r = checkIntegrity(db);
      T.check('a duplicated receipt number is serious', r.serious >= 1, JSON.stringify(r.findings.map(f => [f.code, f.severity])));
      T.check('and the finding names the records so a person can go and look', r.findings.every(f => Array.isArray(f.records)));
    }

    /* ---------------- it never repairs, and never throws ---------------- */

    {
      const db = healthyDb();
      db.payments[0].amount = 0;
      const before = JSON.stringify(db);
      checkIntegrity(db);
      T.check('checking the records changes nothing about them', JSON.stringify(db) === before);
    }

    {
      // Garbage in must produce a finding, not an exception — a checker that
      // crashes takes the application down with it at start-up.
      const nasty = [null, undefined, {}, { payments: null }, { payments: [null] }, { units: 'not an array' }];
      let threw = null;
      for (const db of nasty) {
        try {
          const r = checkIntegrity(db);
          if (!r || typeof r.ok !== 'boolean') threw = `returned ${JSON.stringify(r)}`;
        } catch (err) {
          threw = err.message;
        }
      }
      T.check('a malformed database produces a finding rather than an exception', threw === null, String(threw));
      T.check(
        'and a checker that cannot complete never reports "ok"',
        checkIntegrity({ payments: [null] }).ok === false,
        JSON.stringify(checkIntegrity({ payments: [null] }))
      );
    }

    /* ---------------- against a real running server ---------------- */

    {
      const srv = await startServer({ port, adminPassword: 'SelfCheck-1234!', projectRoot });
      try {
        const c = makeClient(srv.baseUrl);
        await activateAdmin(c, 'SelfCheck-1234!', 'SelfCheckNew-1234!');
        await makeLongTermUnit(c);
        await c.post('/api/charges/post-month', { monthString: '2026-07' });
        await recordAndConfirmPayment(c, {
          unitId: 'unit-1',
          category: 'Rent',
          amount: 50000,
          currency: 'JMD',
          payerName: 'Tenant',
          method: 'Cash'
        });

        const res = await c.get('/api/integrity');
        T.check('the running server can report on its own records', res.status === 200, String(res.status));
        T.check(
          'and a property used normally reports no contradictions',
          res.body?.ok === true,
          JSON.stringify(res.body?.findings)
        );
        T.check('it states what it walked', (res.body?.counts?.charges || 0) > 0, JSON.stringify(res.body?.counts));
        T.check('and stamps when it looked', typeof res.body?.checkedAt === 'string' && res.body.checkedAt.length > 10);

        // Signed out, nothing is disclosed.
        const stranger = makeClient(srv.baseUrl);
        T.check('a stranger cannot read it', (await stranger.get('/api/integrity')).status === 401);
      } finally {
        await srv.stop();
      }
    }

    return T.done();
  } finally {
    cleanup();
  }
}
