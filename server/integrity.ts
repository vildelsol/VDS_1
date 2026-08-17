/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The books checking themselves, on the machine that holds them.
 *
 * Every invariant below was already asserted — in the test suite, against a
 * simulated property, on this laptop. None of it ran on the HP in Ocho Rios,
 * which is the only computer whose records anyone actually cares about. A test
 * proves the code was correct when it ran here; it says nothing about the file
 * sitting on the live machine after a year of use, a restore from a USB stick,
 * a half-finished upgrade, or a disk that started returning bad sectors.
 *
 * So the same checks run on the real database: at startup, and on demand. What
 * they find is surfaced in the application rather than written to a log nobody
 * reads — the person who needs to know is the one at the desk, not a developer.
 *
 * **Rules this file lives by:**
 *
 *   - **It never repairs anything.** It reports. An automatic fix to a ledger is
 *     a second, unaudited author of the accounts, and a wrong repair is worse
 *     than the fault it hid. Every finding names the record so a person can look
 *     at it and decide.
 *   - **It never throws.** A fault in the checker must not stop the property
 *     taking a payment. Anything unexpected is reported as a finding.
 *   - **It is read-only and cheap.** It walks the records once. This database is
 *     a single JSON file for sixteen villas; it is not worth an index.
 *   - **A finding is a real contradiction, never a judgement.** "This villa owes
 *     a lot" is not a finding. "This receipt says money both did and did not
 *     arrive" is.
 */

import type { Database } from './db';

export type IntegritySeverity =
  /** The books contradict themselves. Money is misstated somewhere. */
  | 'serious'
  /** Wrong, but not a misstatement of money on its own. */
  | 'warning';

export interface IntegrityFinding {
  severity: IntegritySeverity;
  /** Stable machine key, so the interface can group without parsing prose. */
  code: string;
  /** What is wrong, in the words someone at the desk would use. */
  message: string;
  /** The records involved, so a person can go and look at them. */
  records: string[];
}

export interface IntegrityReport {
  checkedAt: string;
  /** True when nothing at all was found. */
  ok: boolean;
  serious: number;
  warnings: number;
  findings: IntegrityFinding[];
  /** How many records were walked, so "ok" on an empty database is not mistaken for a pass. */
  counts: { units: number; charges: number; payments: number; bookings: number; expenses: number };
}

const isBadNumber = (v: unknown): boolean => typeof v === 'number' && !Number.isFinite(v);
const cents = (v: number) => Math.round(v * 100);

/**
 * Walk the database once and report every contradiction found.
 *
 * Capped at a sane number of records per finding: a database that has gone
 * badly wrong should produce a readable report, not ten thousand lines nobody
 * can act on. The count is always stated in the message.
 */
export function checkIntegrity(db: Database): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  const MAX_LISTED = 20;

  const add = (severity: IntegritySeverity, code: string, message: string, records: string[]) => {
    if (records.length === 0) return;
    findings.push({
      severity,
      code,
      message: records.length > MAX_LISTED ? `${message} (${records.length} records; first ${MAX_LISTED} listed)` : message,
      records: records.slice(0, MAX_LISTED)
    });
  };

  try {
    const payments = db.payments || [];
    const charges = db.charges || [];
    const bookings = db.bookings || [];
    const units = db.units || [];
    const expenses = db.expenses || [];
    const utilities = db.utilities || [];
    const tenancies = db.tenancies || [];
    const activities = db.unitActivities || [];

    /* ---------------- receipts and money ---------------- */

    const seenPaymentIds = new Set<string>();
    const duplicatePaymentIds: string[] = [];
    for (const p of payments) {
      if (seenPaymentIds.has(p.id)) duplicatePaymentIds.push(p.id);
      seenPaymentIds.add(p.id);
    }
    add('serious', 'duplicate-payment-id', 'Two payment records share the same id.', duplicatePaymentIds);

    const receiptSeen = new Map<string, string>();
    const duplicateReceipts: string[] = [];
    for (const p of payments) {
      if (!p.receiptNo) continue;
      const already = receiptSeen.get(p.receiptNo);
      if (already) duplicateReceipts.push(`${p.receiptNo} (${already} and ${p.id})`);
      else receiptSeen.set(p.receiptNo, p.id);
    }
    add(
      'serious',
      'duplicate-receipt-number',
      'The same receipt number was issued more than once. Two different payments can be produced as the same receipt.',
      duplicateReceipts
    );

    add(
      'serious',
      'received-without-receipt',
      'Money is recorded as received but no receipt number was issued for it.',
      payments.filter(p => p.status === 'completed' && !p.receiptNo).map(p => p.id)
    );
    add(
      'warning',
      'expected-holds-receipt',
      'A payment still only expected is holding a receipt number, as though the money had arrived.',
      payments.filter(p => p.status === 'pending' && !!p.receiptNo).map(p => p.id)
    );
    add(
      'serious',
      'impossible-payment-amount',
      'A payment has an amount that cannot be right.',
      payments.filter(p => isBadNumber(p.amount) || p.amount <= 0).map(p => `${p.id} (${p.amount})`)
    );
    add(
      'serious',
      'refunded-beyond-worth',
      'More money was refunded against a receipt than the receipt was ever worth.',
      payments
        .filter(p => typeof p.refundedAmount === 'number' && cents(p.refundedAmount) > cents(p.amount))
        .map(p => `${p.receiptNo || p.id} (${p.refundedAmount} of ${p.amount})`)
    );
    // Void says the money never arrived; refund says it arrived and went back.
    // One receipt cannot say both, and saying both takes the money off twice.
    add(
      'serious',
      'voided-and-refunded',
      'A receipt is recorded as both voided and refunded. Those say opposite things, and together they remove the money twice.',
      // A voided receipt carries status 'reversed'. Getting this wrong would
      // have made the check silently pass on every database — the typechecker
      // caught it, which is the argument for the check being typed at all.
      payments.filter(p => p.status === 'reversed' && !!p.refundedAmount).map(p => p.receiptNo || p.id)
    );
    add(
      'warning',
      'voided-but-reconciled',
      'A voided receipt is still ticked as found on a bank statement — it says the money both did and did not arrive.',
      payments.filter(p => p.status === 'reversed' && !!p.reconciledOn).map(p => p.receiptNo || p.id)
    );

    /* ---------------- charges ---------------- */

    const seenChargeIds = new Set<string>();
    const duplicateChargeIds: string[] = [];
    for (const c of charges) {
      if (seenChargeIds.has(c.id)) duplicateChargeIds.push(c.id);
      seenChargeIds.add(c.id);
    }
    add('serious', 'duplicate-charge-id', 'Two charges share the same id.', duplicateChargeIds);

    // The advance charge for a final month legitimately shares the move-in
    // month's period, so it is excluded — as it is everywhere else.
    const billedKey = new Map<string, string>();
    const doubleBilled: string[] = [];
    for (const c of charges) {
      if (c.status !== 'open' || c.oneOffType || c.kind === 'advance-final-month') continue;
      const key = `${c.unitId}|${c.category}|${c.periodMonth}`;
      const already = billedKey.get(key);
      if (already) doubleBilled.push(`${key} (${already} and ${c.id})`);
      else billedKey.set(key, c.id);
    }
    add(
      'serious',
      'month-billed-twice',
      'The same month has been billed twice on the same account. Somebody is being asked for it twice.',
      doubleBilled
    );
    add(
      'serious',
      'impossible-charge-amount',
      'A charge has an amount that cannot be right.',
      charges.filter(c => isBadNumber(c.amount) || c.amount <= 0).map(c => `${c.id} (${c.amount})`)
    );

    /* ---------------- receipt counter ---------------- */

    // If the counter has fallen behind the receipts already issued, the next
    // receipt will reuse a number that is already on a document in somebody's
    // hands. Worth catching before it happens rather than after.
    const counters = db.counters;
    if (counters) {
      const highestForYear = payments
        // REC-2026-0001, matching `nextReceiptNo` in db.ts. This read `R-`
        // until it was checked against a real database: the pattern never
        // matched, so the check silently passed on every property that has ever
        // issued a receipt. A guard that cannot fire is worse than none, because
        // it is counted as coverage.
        .map(p => /^REC-(\d{4})-(\d+)$/.exec(p.receiptNo || ''))
        .filter((m): m is RegExpExecArray => !!m && Number(m[1]) === counters.receiptYear)
        .map(m => Number(m[2]));
      const highest = highestForYear.length > 0 ? Math.max(...highestForYear) : 0;
      if (counters.receiptSeq < highest) {
        add('serious', 'receipt-counter-behind', 'The receipt counter has fallen behind the receipts already issued, so the next receipt would reuse a number.', [
          `counter at ${counters.receiptSeq}, highest issued ${highest} for ${counters.receiptYear}`
        ]);
      }
    }

    /* ---------------- stays ---------------- */

    add(
      'serious',
      'booking-ends-before-it-starts',
      'A stay is recorded as ending before it begins.',
      bookings.filter(b => b.checkOut <= b.checkIn).map(b => `${b.id} (${b.checkIn} to ${b.checkOut})`)
    );

    const byUnit = new Map<string, typeof bookings>();
    for (const b of bookings) {
      if (b.status !== 'confirmed') continue;
      const list = byUnit.get(b.unitId) || [];
      list.push(b);
      byUnit.set(b.unitId, list);
    }
    const doubleSold: string[] = [];
    for (const [, list] of byUnit) {
      const sorted = [...list].sort((a, b) => a.checkIn.localeCompare(b.checkIn));
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (cur.checkIn < prev.checkOut) {
          doubleSold.push(`villa ${cur.unitNumber}: ${prev.checkIn}–${prev.checkOut} and ${cur.checkIn}–${cur.checkOut}`);
        }
      }
    }
    add('serious', 'villa-sold-twice', 'A villa is confirmed to two guests on the same night.', doubleSold);

    add(
      'serious',
      'damage-deposit-over-settled',
      'More of a guest damage deposit has been returned and withheld than was ever held.',
      bookings
        .filter(
          b =>
            !!b.damageDepositAmount &&
            cents((b.damageDepositReturnedAmount || 0) + (b.damageDepositWithheldAmount || 0)) > cents(b.damageDepositAmount)
        )
        .map(b => b.id)
    );

    /* ---------------- deposits held on a tenancy ---------------- */

    add(
      'serious',
      'deposit-over-settled',
      'More of a tenant deposit has been returned and withheld than was ever held.',
      tenancies
        .filter(
          t =>
            !!t.depositReturnedOn &&
            cents((t.depositReturnedAmount || 0) + (t.depositWithheldAmount || 0)) > cents(t.depositAmount || 0)
        )
        .map(t => t.id)
    );

    /* ---------------- work orders and costs ---------------- */

    const raised = activities.filter(a => a.expenseId).map(a => a.expenseId as string);
    const seenExpenseLink = new Set<string>();
    const doubleRaised: string[] = [];
    for (const id of raised) {
      if (seenExpenseLink.has(id)) doubleRaised.push(id);
      seenExpenseLink.add(id);
    }
    add('serious', 'work-order-cost-raised-twice', 'The cost of one job has reached the expense register more than once.', doubleRaised);

    add(
      'serious',
      'impossible-expense-amount',
      'A recorded cost has an amount that cannot be right.',
      expenses.filter(e => isBadNumber(e.amount) || e.amount < 0).map(e => `${e.id} (${e.amount})`)
    );

    const postedKey = new Map<string, string>();
    const postedTwice: string[] = [];
    for (const e of expenses) {
      if (!e.recurringId || !e.periodMonth) continue;
      const key = `${e.recurringId}|${e.periodMonth}`;
      const already = postedKey.get(key);
      if (already) postedTwice.push(`${key} (${already} and ${e.id})`);
      else postedKey.set(key, e.id);
    }
    add('serious', 'monthly-cost-posted-twice', 'A standing monthly cost has been posted twice for the same month.', postedTwice);

    /* ---------------- meters ---------------- */

    add(
      'warning',
      'meter-ran-backwards',
      'A meter reading is lower than the one before it.',
      utilities.filter(u => u.currentReading < u.previousReading).map(u => `${u.id} (${u.previousReading} → ${u.currentReading})`)
    );

    /* ---------------- the register ---------------- */

    const seenUnitIds = new Set<string>();
    const duplicateUnits: string[] = [];
    for (const u of units) {
      if (seenUnitIds.has(u.id)) duplicateUnits.push(u.id);
      seenUnitIds.add(u.id);
    }
    add('serious', 'duplicate-unit-id', 'Two villas share the same id.', duplicateUnits);

    add(
      'serious',
      'impossible-unit-figure',
      'A villa has a rent or maintenance figure that cannot be right.',
      units
        .filter(u => isBadNumber(u.monthlyRent) || isBadNumber(u.monthlyMaintenance) || u.monthlyRent < 0 || u.monthlyMaintenance < 0)
        .map(u => `villa ${u.number}`)
    );

    // A record pointing at a villa that is no longer on the register is money
    // that will not appear on any statement.
    const knownUnitIds = new Set(units.map(u => u.id));
    const orphaned = [
      ...charges.filter(c => c.unitId && !knownUnitIds.has(c.unitId)).map(c => `charge ${c.id}`),
      ...payments.filter(p => p.unitId && !knownUnitIds.has(p.unitId)).map(p => `payment ${p.id}`)
    ];
    add(
      'warning',
      'record-points-at-missing-villa',
      'A charge or payment points at a villa that is no longer on the register, so it will not appear on any statement.',
      orphaned
    );

    return {
      checkedAt: new Date().toISOString(),
      ok: findings.length === 0,
      serious: findings.filter(f => f.severity === 'serious').length,
      warnings: findings.filter(f => f.severity === 'warning').length,
      findings,
      counts: {
        units: units.length,
        charges: charges.length,
        payments: payments.length,
        bookings: bookings.length,
        expenses: expenses.length
      }
    };
  } catch (err) {
    // The checker failing must never stop the property working, and must never
    // be mistaken for a clean bill of health.
    return {
      checkedAt: new Date().toISOString(),
      ok: false,
      serious: 1,
      warnings: 0,
      findings: [
        {
          severity: 'serious',
          code: 'integrity-check-failed',
          message: `The integrity check could not complete: ${(err as Error).message}. The records could not be verified.`,
          records: []
        }
      ],
      counts: { units: 0, charges: 0, payments: 0, bookings: 0, expenses: 0 }
    };
  }
}

/** One line for the console at startup. Deliberately quiet when all is well. */
export function describeIntegrity(report: IntegrityReport): string {
  if (report.ok) {
    return `Records checked: ${report.counts.payments} payments, ${report.counts.charges} charges — no contradictions found.`;
  }
  const parts = [`${report.serious} serious`, `${report.warnings} warning${report.warnings === 1 ? '' : 's'}`];
  return `RECORDS CHECK FOUND PROBLEMS (${parts.join(', ')}):\n` + report.findings.map(f => `  [${f.severity}] ${f.message}`).join('\n');
}
