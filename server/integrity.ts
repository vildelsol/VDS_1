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
import { createHash } from 'crypto';
import { accountBalance, chargeCurrency, creditHeldForOthers, fundForCost, isOwnAccount, isOwnAccountDuring, isProprietorsOwnUtility, netPaidAsOf, settledFromRent } from '../src/lib/finance';
import { hasLevySchedule, isWellFormedFeeChange, levyForMonth, levySchedule } from '../src/lib/feeSchedule';
import { AUDIT_CAP, AUDIT_KEY_FILE, auditRotationFailure, loadAuditKey, verifyAnchorAndArchive, verifyAuditChain } from './auditChain';
import { bankItems } from '../src/lib/bankRec';
import { nameKey, referenceKey } from '../src/lib/text';

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
  /** How many records matched; `records` is capped for readability. */
  total?: number;
}

export interface IntegrityReport {
  checkedAt: string;
  /** True when nothing at all was found. */
  ok: boolean;
  serious: number;
  warnings: number;
  findings: IntegrityFinding[];
  /** How many records were walked, so "ok" on an empty database is not mistaken for a pass. */
  counts: { units: number; charges: number; payments: number; bookings: number; expenses: number; auditLogs?: number };
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
      records: records.slice(0, MAX_LISTED),
      total: records.length
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
      'A voided receipt is still ticked as found on a bank statement, it says the money both did and did not arrive.',
      payments.filter(p => p.status === 'reversed' && !!p.reconciledOn).map(p => p.receiptNo || p.id)
    );
    // Money out, the same rule (Ro, 2026-11-18): a bank tick vouches for money that
    // moved. Taking the cost back, or never paying it, leaves the tick claiming a
    // movement the books say did not happen. The routes clear it; this catches any
    // path that did not.
    add(
      'warning',
      'unpaid-cost-reconciled',
      'A cost that is voided or not paid is still ticked as found leaving the bank, it says the money both did and did not go.',
      expenses.filter(e => e.status !== 'paid' && !!e.bankMatch).map(e => `${e.vendor} ${e.currency} ${e.amount} (${e.id})`)
    );
    add(
      'warning',
      'bank-match-without-money-out',
      'A refund or returned deposit is ticked as found on a bank statement, but the books record no money going out for it.',
      [
        ...payments
          .filter(p => !!p.refundBankMatch && (p.status !== 'completed' || !p.refundedAmount || !p.refundedOn))
          .map(p => `refund on ${p.receiptNo || p.id}`),
        ...tenancies
          .filter(t => !!t.depositReturnBankMatch && !(t.depositReturnedOn && (t.depositReturnedAmount || 0) > 0))
          .map(t => `deposit return ${t.tenantName} (${t.id})`),
        ...bookings
          .filter(b => !!b.damageDepositReturnBankMatch && !(b.damageDepositReturnedOn && (b.damageDepositReturnedAmount || 0) > 0))
          .map(b => `damage deposit return ${b.guestName} (${b.id})`)
      ]
    );

    add(
      'warning',
      'bank-match-without-deposit-in',
      'A deposit is ticked as found arriving in the bank, but the books record no deposit received for it.',
      [
        ...tenancies
          .filter(t => !!t.depositBankMatch && !(t.depositReceivedOn && (t.depositAmount || 0) > 0))
          .map(t => `deposit from ${t.tenantName} (${t.id})`),
        ...bookings
          .filter(b => !!b.damageDepositBankMatch && !(b.damageDepositReceivedOn && (b.damageDepositAmount || 0) > 0))
          .map(b => `damage deposit from ${b.guestName} (${b.id})`)
      ]
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
      // In a same-month changeover the outgoing and incoming tenants each owe that
      // month's rent on their own account: two payers, nobody asked twice. Rent is
      // therefore keyed by payer as well; the levy stays one charge per villa-month.
      const payer = c.category === 'Rent' ? `|${(c.payerName || '').trim().toLowerCase()}` : '';
      const key = `${c.unitId}|${c.category}|${c.periodMonth}${payer}`;
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

    /* ---------------- the audit trail approaching its ceiling ---------------- */

    /*
     * The audit trail is held in the same JSON file as the books and is trimmed
     * at a high-water mark so one file cannot grow without limit. `addAudit`
     * unshifts, so the entries dropped are the **oldest** ones — and there is no
     * archive. For a strata corporation that trail is a governance record, and
     * losing the start of it silently is not acceptable even when the loss is
     * years away.
     *
     * Reported before it happens rather than after, because afterwards there is
     * nothing to report *with*. At this property's volume (a few thousand entries
     * a year) the ceiling is several years out; this is a prompt to archive, not
     * an emergency. Nothing here deletes or rotates anything — that is a decision
     * about where the history should live, and a person makes it.
     */
    /*
     * Since the second security pass the oldest entries are MOVED to audit-archive.jsonl (kept, backed up and
     * verified below) rather than dropped, so a full trail is ordinary and says nothing. It is a serious finding
     * only when that move has failed: then nothing is removed, the trail keeps growing past its ceiling, and the
     * archive has to be fixed before history is at risk.
     */
    const auditCap = AUDIT_CAP;
    const auditCount = (db.auditLogs || []).length;
    const rotationFailure = auditRotationFailure();
    if (rotationFailure && auditCount >= auditCap * 0.9) {
      add(
        'serious',
        'audit-trail-near-capacity',
        `The audit trail holds ${auditCount} entries (its ceiling is ${auditCap}) and the oldest could not be moved to the archive file: ${rotationFailure}. ` +
          'Nothing has been removed, but the trail will keep growing until the data folder can be written to.',
        [`${auditCount} of ${auditCap}`]
      );
    }

    /* ---------------- money in a currency the account is not billed in ---------------- */

    /*
     * A balance is computed per unit, per category, *per currency*: both charges
     * and receipts are scoped to the currency that account is billed in, and
     * nothing is ever combined across currencies. So a record raised in the other
     * currency is counted by neither side of the balance.
     *
     * A receipt in the wrong currency was already surfaced on the ledger screen.
     * A **charge** in the wrong currency was surfaced nowhere: "Billed to date"
     * read nil, and any correctly-denominated payment against it then appeared as
     * a credit — a villa that owed money looked like a villa in credit. This is
     * therefore a misstatement of money, not a tidiness complaint.
     *
     * Reported, never repaired. Which side is wrong — the villa's currency or the
     * record's — is a question about what actually happened, and only a person
     * knows that.
     */
    const billingCurrency = (unit: { currency?: string; maintCurrency?: string }, category: string) =>
      category === 'Maintenance' ? unit.maintCurrency || unit.currency : unit.currency;

    const unitById = new Map((db.units || []).map(u => [u.id, u]));
    const strandedCharges: string[] = [];
    for (const c of charges) {
      if (c.status !== 'open') continue;
      const unit = unitById.get(c.unitId);
      if (!unit) continue;
      const expected = billingCurrency(unit, c.category);
      // Only compare when the villa actually states a currency; a blank one is
      // its own, separate finding rather than a mismatch with everything.
      if (expected && c.currency && c.currency !== expected) {
        strandedCharges.push(`${c.id}, ${c.unitNumber || c.unitId} ${c.category} raised in ${c.currency}, billed in ${expected}`);
      }
    }
    add(
      'serious',
      'charge-in-unbilled-currency',
      'A charge is raised in a currency the account is not billed in, so it is in no balance, the villa owes this money but does not appear to.',
      strandedCharges
    );

    const strandedPayments: string[] = [];
    for (const p of payments) {
      if (p.status !== 'completed') continue;
      if (p.category !== 'Rent' && p.category !== 'Maintenance') continue;
      const unit = unitById.get(p.unitId);
      if (!unit) continue;
      const expected = billingCurrency(unit, p.category);
      if (expected && p.currency && p.currency !== expected) {
        strandedPayments.push(`${p.receiptNo || p.id}, ${p.unitNumber || p.unitId} ${p.category} received in ${p.currency}, billed in ${expected}`);
      }
    }
    add(
      'warning',
      'payment-in-unbilled-currency',
      'A receipt is recorded in a currency the account is not billed in, so it settles nothing on that account.',
      strandedPayments
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
      // A negative amount is a supplier credit, recorded as a negative cost on purpose: only a non-number is impossible.
      expenses.filter(e => isBadNumber(e.amount)).map(e => `${e.id} (${e.amount})`)
    );

    /*
     * Money on the wrong book (audit, 2026-11-22). The server refuses each of
     * these at entry; anything found here came in before the rule or by a
     * restore, and every figure that counts it is wrong until it is put right.
     */
    const villaOf = new Map(units.map(u => [u.id, u]));
    add(
      'warning',
      'proprietor-utility-in-the-books',
      "A utility bill or meter reading is recorded on a proprietor's villa. Proprietors hold their own utility accounts, so it is nobody's cost or debt in these books.",
      [
        ...expenses
          .filter(e => e.status !== 'void' && isProprietorsOwnUtility(e.category, villaOf.get(e.unitId), e.date))
          .map(e => `${e.id} (${e.unitNumber}, ${e.currency} ${e.amount})`),
        ...utilities
          .filter(u => isProprietorsOwnUtility('Utilities', villaOf.get(u.unitId), `${u.billingPeriod}-01`))
          .map(u => `${u.id} (${u.unitNumber}, ${u.billingPeriod})`)
      ]
    );
    add(
      'warning',
      'ispo-villa-utility-on-strata-book',
      "A utility bill on one of ISPO's villas is on the corporation's book. It is ISPO's cost.",
      expenses
        .filter(e => e.status !== 'void' && fundForCost(e.category, villaOf.get(e.unitId), 'strata', e.date) === 'ispo' && (e.fund || 'strata') === 'strata')
        .map(e => `${e.id} (${e.unitNumber}, ${e.currency} ${e.amount})`)
    );
    add(
      'warning',
      'rent-on-a-proprietors-villa',
      "Rent or short-stay money is recorded on a villa that was never ISPO's. Proprietors collect their own; it is not the property's income.",
      payments
        .filter(p => (p.category === 'Rent' || p.category === 'Booking') && p.status !== 'reversed' && !p.derived)
        .filter(p => {
          const u = villaOf.get(p.unitId);
          return !!u && !isOwnAccountDuring(u, '0000-01-01', p.date);
        })
        .map(p => `${p.receiptNo || p.id} (${p.unitNumber}, ${p.currency} ${p.amount})`)
    );

    /*
     * A cost taken back is out of every figure in the application, so the only
     * thing standing between it and an unexplained hole in a month's spend is the
     * record of who took it back and why. That record is written in the same
     * operation as the void; if one is ever missing, something wrote the status
     * directly.
     */
    add(
      'serious',
      'void-cost-without-a-reason',
      'A cost was taken back without recording who did it or why.',
      expenses.filter(e => e.status === 'void' && (!e.voidedBy || !e.voidReason || !e.voidedAt)).map(e => e.id)
    );

    const postedKey = new Map<string, string>();
    const postedTwice: string[] = [];
    for (const e of expenses) {
      if (!e.recurringId || !e.periodMonth) continue;
      // A month that was recalled and posted again leaves the taken-back rows on
      // file. They are in no figure, so counting them here would report the
      // remedy as the fault.
      if (e.status === 'void') continue;
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

    /*
     * A settled utility bill and the receipt that settled it say the same figure.
     * A receipt corrected after the fact left a J$12,000 bill paid by J$8,000
     * (QA, 2026-11-20); the edit is refused now, and this names any that exist.
     */
    add(
      'warning',
      'utility-bill-differs-from-its-receipt',
      'A utility bill is marked paid but the receipt that settled it, net of any refund, is for a different amount or currency. Reverse the receipt and settle the bill again.',
      utilities
        .filter(u => u.status === 'paid')
        .map(u => ({ u, p: payments.find(p => p.utilityId === u.id && p.status === 'completed') }))
        .filter(({ u, p }) => !!p && (p.currency !== u.currency || cents(p.amount) - cents(p.refundedAmount || 0) !== cents(u.amountCharged)))
        .map(({ u, p }) => `${u.id} (${u.unitNumber} ${u.billingPeriod}: bill ${u.currency} ${u.amountCharged}, receipt ${p!.currency} ${(cents(p!.amount) - cents(p!.refundedAmount || 0)) / 100})`)
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

    /*
     * The fee schedule against the ledger.
     *
     * Only villas with a dated levy change are judged, and only from their first
     * change onwards: before it, the standing figure is all the register knows,
     * and historical charges raised at older levies are not its business. A
     * charge is excused when anything is recorded against it in the audit trail
     * (a void-and-repost, a restatement): that is a recorded correction. A
     * warning, never a write blocker, because historical data must keep loading.
     */
    const malformedSchedules: string[] = [];
    const offSchedule: string[] = [];
    const correctedCharges = new Set((db.auditLogs || []).filter(a => a.recordType === 'Charge').map(a => String(a.recordId)));
    for (const u of units) {
      if (!hasLevySchedule(u)) continue;
      const raw = Array.isArray(u.maintenanceSchedule) ? u.maintenanceSchedule : [];
      const usable = levySchedule(u);
      if (!Array.isArray(u.maintenanceSchedule) || raw.length !== usable.length || raw.some(e => !isWellFormedFeeChange(e))) {
        malformedSchedules.push(`villa ${u.number}`);
      }
      if (usable.length === 0) continue;
      const first = usable[0].effectiveFrom;
      const levyCur = chargeCurrency(u, 'Maintenance');
      for (const c of charges) {
        if (c.unitId !== u.id || c.status !== 'open' || c.kind !== undefined || c.oneOffType) continue;
        if (!c.periodMonth || c.periodMonth < first || correctedCharges.has(c.id)) continue;
        const levy = levyForMonth(u, c.periodMonth);
        if (c.category === 'Maintenance' && c.currency === levyCur && cents(c.amount) !== cents(levy)) {
          offSchedule.push(`charge ${c.id} (${c.periodMonth}: ${c.currency} ${c.amount}, schedule ${levy})`);
        } else if (c.category === 'Rent' && c.maintenancePortion !== undefined && c.currency === levyCur && c.maintenancePortion > 0) {
          const expected = Math.min(levy, c.amount);
          if (cents(c.maintenancePortion) !== cents(expected)) {
            offSchedule.push(`charge ${c.id} (${c.periodMonth}: maintenance share ${c.maintenancePortion}, schedule ${expected})`);
          }
        }
      }
    }
    add(
      'warning',
      'fee-schedule-malformed',
      "A villa's dated maintenance changes include an entry that cannot be billed (bad month, amount or currency); it is being ignored.",
      malformedSchedules
    );
    add(
      'warning',
      'levy-differs-from-schedule',
      "A charge's maintenance differs from the fee schedule for its month, and no correction is recorded against it.",
      offSchedule
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

    /* ------------- the two books accounting for each other -------------
     *
     * The levy a tenant pays is inside their rent, and the corporation raises
     * the same levy as its own charge. Three separate figures therefore have to
     * agree at all times: the split recorded on the rent charge, the levy the
     * corporation charged, and the credit worked out from rent received. Each is
     * produced by different code on a different screen, so a change to one can
     * drift from the others without anything failing — which is precisely the
     * kind of silent misstatement this file exists to catch.
     */

    // A split that does not add up misstates the tenant's bill or ISPO's share.
    const brokenSplit = charges
      .filter(c => c.category === 'Rent' && (c.rentPortion !== undefined || c.maintenancePortion !== undefined))
      .filter(c => cents(c.rentPortion || 0) + cents(c.maintenancePortion || 0) !== cents(c.amount))
      .map(c => `charge ${c.id} (${c.unitNumber} ${c.periodMonth})`);
    add(
      'serious',
      'rent-split-does-not-add-up',
      'A rent charge says the tenant pays one figure but its rent and maintenance parts add up to another.',
      brokenSplit
    );

    const negativeSplit = charges
      .filter(c => c.category === 'Rent' && ((c.rentPortion || 0) < 0 || (c.maintenancePortion || 0) < 0))
      .map(c => `charge ${c.id} (${c.unitNumber} ${c.periodMonth})`);
    add('serious', 'negative-rent-split', 'A rent charge carries a negative rent or maintenance part.', negativeSplit);

    /*
     * A levy inside the rent, in a currency the levy is not billed in.
     *
     * The parts adding up is not enough on its own. The maintenance part of a
     * rent charge is a strata contribution, and it can only ever settle a levy
     * billed in the same currency. Re-denominate a villa's levy and every open
     * rent charge keeps its old-currency portion: it settles nothing ever again,
     * the proprietor is billed the new levy on top, and the combined view counts
     * one levy twice. Nothing else could see it — the rent charge sits in the
     * villa's own rent currency, so no mismatch check fires and the arithmetic
     * is sound.
     */
    const splitInWrongCurrency = charges
      .filter(c => c.category === 'Rent' && c.status === 'open' && (c.maintenancePortion || 0) > 0)
      .filter(c => {
        const unit = unitById.get(c.unitId);
        return !!unit && c.currency !== billingCurrency(unit, 'Maintenance');
      })
      .map(c => `charge ${c.id} (${c.unitNumber} ${c.periodMonth}, ${c.currency} maintenance inside the rent)`);
    add(
      'serious',
      'rent-split-in-unbilled-currency',
      'A rent charge carries a maintenance contribution in a currency this villa is not billed maintenance in, so it can never settle one.',
      splitInWrongCurrency
    );

    /*
     * Money on a villa the register says belongs to somebody else.
     *
     * Own-account is derived from status: anything that is not `owner-occupied`
     * is ISPO's (`isOwnAccount`). That removed a hand-ticked flag nobody could be
     * relied on to tick, and with it the warning that used to live here — a let
     * villa left unticked is no longer a state this register can hold.
     *
     * It moved the risk rather than removing it. A villa belonging to another
     * proprietor but recorded as `vacant` or `unavailable` is now claimed as
     * ISPO's: the combined view drops that proprietor's real levy payments as if
     * they were internal, and the shortfall report bills ISPO for a villa it does
     * not own. The old field's note warned about exactly this — "claiming villas
     * that are not ours would overstate the shortfall, which is the one number
     * this report exists to state honestly."
     *
     * Status alone cannot prove that mistake: a villa ISPO owns and has never let
     * looks identical to a stranger's villa left on the wrong status. What CAN be
     * proved is the opposite shape, and it catches the same data error from the
     * other side — a villa marked `owner-occupied`, which this corporation only
     * bills maintenance on, that is nevertheless being let **right now**.
     *
     * Only what is live counts. A villa ISPO let for years and then sold is
     * legitimately `owner-occupied` today and keeps every rent charge and closed
     * tenancy it ever had: Ro, 2026-11-12, a sale is off books and only who is
     * billed changes. Reporting that history would fire on every sale the
     * property has ever made. An **open** rent charge or a **sitting** tenant is
     * a different thing — that is rent being billed, now, on a villa the register
     * says belongs to somebody else.
     *
     * The over-claiming direction is not silent either: `outOfPocketShortfall`
     * names every villa it counts and the status it counted it under, so a villa
     * that does not belong there is visible in the report that would overstate.
     */
    const letButOwnerOccupied = units
      .filter(u => !isOwnAccount(u))
      .filter(
        u =>
          tenancies.some(t => t.unitId === u.id && t.status === 'active' && !t.endedOn) ||
          // An `open` rent charge stays open after it is paid, so only rent the
          // villa's own receipts do not cover is rent being billed now.
          [...new Set(charges.filter(c => c.unitId === u.id && c.category === 'Rent' && c.status === 'open').map(c => c.currency))].some(cur => {
            const billed = charges
              .filter(c => c.unitId === u.id && c.category === 'Rent' && c.status === 'open' && c.currency === cur)
              .reduce((a, c) => a + c.amount, 0);
            const received = payments
              .filter(p => p.unitId === u.id && p.category === 'Rent' && p.status === 'completed' && p.currency === cur)
              .reduce((a, p) => a + p.amount - (p.refundedAmount || 0), 0);
            return billed - received > 0.005;
          })
      )
      .map(u => `villa ${u.number} (owner ${u.ownerName || 'not recorded'})`);
    add(
      'serious',
      'rent-billed-on-a-villa-owned-by-somebody-else',
      'This villa is marked owner occupied, so the corporation bills it maintenance only and treats its maintenance payments as a proprietor\'s money. ' +
        'It has a sitting tenant or an open rent charge all the same. Either the status is wrong, or that rent belongs on another villa.',
      letButOwnerOccupied
    );

    /*
     * Credit on a villa that has changed hands.
     *
     * A prepayment is a credit on the villa's account, applied oldest-first, so
     * whoever is billed next is paid from it. Since 1.16.14 a changeover or a sale
     * is refused while the previous holder's credit sits there; this lists credit
     * that predates that rule (or arrived by another route) so somebody decides
     * whose money it is before it quietly pays the new holder's bills. A warning,
     * not a misstatement: the ledger balance is arithmetically right.
     */
    const creditAfterChange: string[] = [];
    const lowerName = (v: string) => nameKey(v);
    for (const u of units) {
      for (const category of ['Rent', 'Maintenance'] as const) {
        const stints =
          category === 'Rent'
            ? tenancies.filter(t => t.unitId === u.id)
            : (db.ownerships || []).filter(o => o.unitId === u.id);
        if (!stints.some(t => t.status === 'ended')) continue;
        // The sitting holder's own prepayment is not what this finding is about.
        const sitting = stints.find(t => t.status === 'active' && !t.endedOn);
        const holder = sitting ? ('tenantName' in sitting ? sitting.tenantName : sitting.ownerName) : '';
        const earlierEnds = stints
          .filter(t => t.status === 'ended' && lowerName('tenantName' in t ? t.tenantName : t.ownerName) === lowerName(holder))
          .map(t => t.endedOn || '');
        const held = creditHeldForOthers(u, category, charges, payments, units, holder, earlierEnds.sort().pop() || '');
        if (held.credit > 0) creditAfterChange.push(`Villa ${u.number} ${category.toLowerCase()}: ${held.currency} ${held.credit.toFixed(2)} credit held`);
      }
    }
    add(
      'warning',
      'credit-held-on-a-villa-that-changed-hands',
      'This villa has had a tenant or owner change and its account is holding a credit. Decide whose money it is: refund it to the former holder, or confirm it belongs to the current one.',
      creditAfterChange
    );

    /*
     * The levy settled out of rent, against the levy actually charged. This is
     * the one figure nobody can see directly: it is worked out in the browser and
     * never stored, so if it ever exceeded what was charged the corporation would
     * read as paid on money that was never owed, and no record would show why.
     */
    try {
      const derived = settledFromRent(charges, payments);
      const overSettled: string[] = [];
      const byUnit = new Map<string, number>();
      for (const d of derived) byUnit.set(`${d.unitId}|${d.currency}`, (byUnit.get(`${d.unitId}|${d.currency}`) || 0) + cents(d.amount));
      for (const [key, credited] of byUnit) {
        const [unitId, currency] = key.split('|');
        const unit = units.find(u => u.id === unitId);
        const chargedLevy = charges
          .filter(c => c.unitId === unitId && c.category === 'Maintenance' && c.status === 'open' && c.currency === currency)
          .reduce((a, c) => a + cents(c.amount), 0);
        const cashLevy = payments
          .filter(p => p.unitId === unitId && p.category === 'Maintenance' && p.status === 'completed' && p.currency === currency)
          .reduce((a, p) => a + cents(p.amount) - cents(p.refundedAmount || 0), 0);
        const rentIn = payments
          .filter(p => p.unitId === unitId && p.category === 'Rent' && p.status === 'completed' && p.currency === currency)
          .reduce((a, p) => a + cents(p.amount) - cents(p.refundedAmount || 0), 0);
        const where = `villa ${unit?.number || unitId} (${currency})`;
        if (cashLevy <= chargedLevy && cashLevy + credited > chargedLevy) overSettled.push(`${where}: settled ${(cashLevy + credited) / 100} against ${chargedLevy / 100} charged`);
        else if (credited > rentIn) overSettled.push(`${where}: ${credited / 100} taken from rent, but only ${rentIn / 100} of rent was received`);
      }
      add(
        'serious',
        'levy-settled-beyond-what-was-charged',
        'More maintenance has been settled out of rent than the villa was charged, or than the rent actually received.',
        overSettled
      );
    } catch {
      add('warning', 'levy-from-rent-uncheckable', 'The maintenance settled from rent could not be worked out, so it has not been checked.', ['settledFromRent']);
    }


    /* ---------------- money with no audit entry ---------------- */

    {
      /*
       * A receipt that reached the books by some route other than the application (a forged or tampered backup,
       * an edit to db.json) has no audit entry. Only receipts made after the audit key existed are judged,
       * and only ones newer than the oldest entry still held (older entries may have rotated to the archive),
       * so legacy, restored-from-before and fixture data raise nothing. A warning, not a block.
       */
      const keyState = loadAuditKey();
      const logs = db.auditLogs || [];
      if (keyState.ok && logs.length > 0) {
        const since = keyState.keyedFrom > logs[logs.length - 1].dateTime ? keyState.keyedFrom : logs[logs.length - 1].dateTime;
        const candidates = payments.filter(p => p.status === 'completed' && !p.derived && typeof p.createdAt === 'string' && p.createdAt >= since);
        if (candidates.length > 0) {
          const mentioned = new Set<string>();
          for (const a of logs) {
            mentioned.add(String(a.recordId));
            for (const text of [a.action, a.previousValue, a.newValue]) {
              if (typeof text !== 'string' || text.length === 0) continue;
              for (const m of text.match(/REC-\d{4}-\d+|"id":"[^"]+"/g) || []) mentioned.add(m.startsWith('"id"') ? m.slice(6, -1) : m);
            }
          }
          add(
            'warning',
            'payment-without-audit-trail',
            'A receipt is recorded as received but nothing in the audit trail says who recorded it or when. It may have been put into the records by hand or by a doctored backup.',
            candidates.filter(p => !mentioned.has(p.id) && !(p.receiptNo && mentioned.has(p.receiptNo))).map(p => `${p.receiptNo || p.id} (${p.amount} ${p.currency})`)
          );
        }
      }
    }

    /* ---------------- the audit trail's hash chain ---------------- */

    {
      const { broken, keyProblem, sealedWithoutKey } = verifyAuditChain(db.auditLogs || []);
      add('serious', 'audit-trail-broken', 'The audit trail has been altered: an entry was edited, inserted or removed after it was written.', broken);
      if (keyProblem) {
        add(
          'serious',
          'audit-key-missing',
          `The audit trail is sealed with a key that is ${keyProblem === 'absent' ? 'missing from' : 'unreadable in'} the data folder (${AUDIT_KEY_FILE}). ` +
            'Its keyed entries cannot be verified, and a new key has NOT been made over them. Put back the audit-key.json that belongs to these records ' +
            '(it is kept beside db.json, not inside it or its backups); until then new entries are sealed without the key.',
          [AUDIT_KEY_FILE]
        );
      }
      // The newest seal and count, kept beside the key: what deleting the newest entries or stripping seals cannot hide.
      const anchored = verifyAnchorAndArchive(db.auditLogs || []);
      add(
        'serious',
        'audit-head-mismatch',
        'The audit trail does not match its head anchor or its archive: entries were removed from either end, or the archive was altered. ' +
          'If an older copy of db.json was put back on purpose, delete audit-head.json in the data folder to accept it.',
        anchored.broken
      );
      // Not write-blocking: the desk kept working while the key was missing, which is right.
      add(
        'serious',
        'audit-sealed-without-key',
        `These audit entries were written while ${AUDIT_KEY_FILE} was missing, so they are sealed without the key. They are still chained, ` +
          'but anyone who could edit db.json in that time could have rewritten them. Check them against your own records.',
        sealedWithoutKey
      );
    }

    /* ---------------- a closed period must not move ---------------- */

    if (db.settings?.closedThrough) {
      const now = currentFingerprintFor(db, db.settings.closedThrough, db.settings.closeFingerprint || '');
      if (db.settings.closeFingerprint && now !== db.settings.closeFingerprint) {
        add(
          'serious',
          'closed-period-changed',
          `Money dated in or before ${db.settings.closedThrough}, a month that has been closed, no longer matches what was closed. ` +
            `A statement already issued for that month would now read differently. Reopen the period first, with a reason, to correct it.`,
          [`through ${db.settings.closedThrough}`]
        );
      }
    }

    /* ---------------- one statement line, one receipt ---------------- */

    {
      // Every kind of bank movement, in and out: one line settles one item.
      const byRef = new Map<string, string[]>();
      for (const item of bankItems({ payments, expenses, tenancies, bookings, units, ownerships: db.ownerships || [] })) {
        const ref = referenceKey(item.match?.reference);
        if (!ref) continue;
        const name = item.kind === 'receipt' ? payments.find(p => p.id === item.id)?.receiptNo || item.id : item.label;
        byRef.set(ref, [...(byRef.get(ref) || []), name]);
      }
      add(
        'warning',
        'bank-line-matched-twice',
        'The same bank reference is matched to more than one item. One line on a statement settles one receipt, cost or refund.',
        [...byRef.entries()].filter(([, ids]) => ids.length > 1).map(([ref, ids]) => `"${ref}": ${ids.join(', ')}`)
      );
    }

    /* ---------------- every account balance, recomputed independently ---------------- */

    {
      const off: string[] = [];
      for (const unit of units) {
        for (const category of ['Rent', 'Maintenance'] as const) {
          let currency;
          try {
            currency = chargeCurrency(unit, category);
          } catch {
            continue;
          }
          // Straight from the raw rows, sharing no code with accountBalance beyond the currency choice.
          const owed = charges
            .filter(c => c.unitId === unit.id && c.category === category && c.status === 'open' && c.currency === currency)
            .reduce((a, c) => a + cents(c.amount), 0);
          const received = payments
            .filter(p => p.unitId === unit.id && p.category === category && p.status === 'completed' && p.currency === currency)
            .reduce((a, p) => a + cents(netPaidAsOf(p)), 0);
          let shown: number;
          try {
            shown = cents(accountBalance(unit, category, charges, payments, undefined, units).balance);
          } catch {
            continue;
          }
          if (shown !== owed - received) off.push(`${unit.number} ${category} (${currency}): screens show ${shown / 100}, raw ledger says ${(owed - received) / 100}`);
        }
      }
      // A warning, not a block: a difference can be a real ownership transfer the raw rows do not model.
      add('warning', 'balance-does-not-reconcile', 'An account balance shown by the application differs from the same balance rebuilt from the raw ledger.', off);
    }

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
        expenses: expenses.length,
        // The whole trail, so a screen showing only the newest entries can say so.
        auditLogs: (db.auditLogs || []).length
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
      counts: { units: 0, charges: 0, payments: 0, bookings: 0, expenses: 0, auditLogs: 0 }
    };
  }
}

/** One line for the console at startup. Deliberately quiet when all is well. */
export function describeIntegrity(report: IntegrityReport): string {
  if (report.ok) {
    return `Records checked: ${report.counts.payments} payments, ${report.counts.charges} charges, no contradictions found.`;
  }
  const parts = [`${report.serious} serious`, `${report.warnings} warning${report.warnings === 1 ? '' : 's'}`];
  return `RECORDS CHECK FOUND PROBLEMS (${parts.join(', ')}):\n` + report.findings.map(f => `  [${f.severity}] ${f.message}`).join('\n');
}


/**
 * A fingerprint of every money record dated in or before a month: what was
 * closed. Refunds are counted only if paid by the end of that month, because a
 * refund paid later belongs to the later month and must not disturb this one.
 */
export function ledgerFingerprint(db: Database, throughMonth: string): string {
  const endOfMonth = `${throughMonth}-31`;
  const rows = legacyLedgerRows(db, throughMonth);
  /*
   * Costs, utility bills and deposits, added 2026-11-20: until then a closed
   * month's expenses could be backdated, edited, voided or recalled and nothing
   * noticed. Cash basis, as every statement reads them: a cost counts from the
   * day it was paid, and its status is read as at the close, so paying or taking
   * back a still-unpaid September bill in October leaves September alone, while
   * taking back a cost paid in September does not.
   */
  for (const e of db.expenses || []) {
    const moneyDay = e.datePaid || e.date || '';
    if (moneyDay.slice(0, 7) > throughMonth) continue;
    const wasPaid = e.status === 'paid' || (e.status === 'void' && e.voidedFromPaid === true);
    if (!wasPaid) continue;
    rows.push(`E|${e.id}|${e.category}|${e.currency}|${moneyDay}|${e.status}|${cents(e.amount)}|${e.fund || 'strata'}|${e.unitId || ''}`);
  }
  for (const u of db.utilities || []) {
    if ((u.billingPeriod || '').slice(0, 7) > throughMonth) continue;
    // Paid as at the close only if its receipt was received by then.
    const settled = (db.payments || []).some(p => p.utilityId === u.id && p.status === 'completed' && (p.date || '') <= endOfMonth);
    rows.push(`U|${u.id}|${u.unitId}|${u.billingPeriod}|${u.currency}|${cents(u.amountCharged)}|${settled ? 'paid' : 'unpaid'}`);
  }
  for (const t of db.tenancies || []) {
    if (t.depositReceivedOn && t.depositReceivedOn <= endOfMonth) rows.push(`DI|${t.id}|${t.depositReceivedOn}|${t.depositCurrency || t.currency}|${cents(t.depositAmount || 0)}`);
    if (t.depositReturnedOn && t.depositReturnedOn <= endOfMonth) rows.push(`DO|${t.id}|${t.depositReturnedOn}|${t.depositCurrency || t.currency}|${cents(t.depositReturnedAmount || 0)}|${cents(t.depositWithheldAmount || 0)}`);
  }
  for (const b of db.bookings || []) {
    if (b.damageDepositReceivedOn && b.damageDepositReceivedOn <= endOfMonth) rows.push(`BI|${b.id}|${b.damageDepositReceivedOn}|${b.damageDepositCurrency || b.currency}|${cents(b.damageDepositAmount || 0)}`);
    if (b.damageDepositReturnedOn && b.damageDepositReturnedOn <= endOfMonth) rows.push(`BO|${b.id}|${b.damageDepositReturnedOn}|${b.damageDepositCurrency || b.currency}|${cents(b.damageDepositReturnedAmount || 0)}`);
  }
  rows.sort();
  return FINGERPRINT_V2 + createHash('sha256').update(rows.join('\n')).digest('hex');
}

/**
 * The fingerprint as written before 2026-11-20 (receipts and charges only). A
 * month closed under it is still checked against it, so an upgrade raises no
 * false alarm; `migrate` re-seals it in the current form once it verifies.
 */
export const FINGERPRINT_V2 = 'v2:';
export function legacyLedgerFingerprint(db: Database, throughMonth: string): string {
  const rows = legacyLedgerRows(db, throughMonth);
  rows.sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

/** The fingerprint a stored seal has to be compared with, by the form it was written in. */
export function currentFingerprintFor(db: Database, throughMonth: string, stored: string): string {
  return stored.startsWith(FINGERPRINT_V2) ? ledgerFingerprint(db, throughMonth) : legacyLedgerFingerprint(db, throughMonth);
}

function legacyLedgerRows(db: Database, throughMonth: string): string[] {
  const endOfMonth = `${throughMonth}-31`;
  const rows: string[] = [];
  for (const p of db.payments || []) {
    if ((p.date || '').slice(0, 7) > throughMonth) continue;
    rows.push(`P|${p.id}|${p.category}|${p.currency}|${p.date}|${p.status}|${cents(p.amount)}|${cents(netPaidAsOf(p, endOfMonth))}|${p.unitId}`);
  }
  for (const c of db.charges || []) {
    if ((c.periodMonth || '').slice(0, 7) > throughMonth) continue;
    rows.push(`C|${c.id}|${c.category}|${c.currency}|${c.periodMonth}|${c.status}|${cents(c.amount)}|${c.unitId}`);
  }
  return rows;
}

/**
 * Serious findings present after a change that were not present before it.
 * A finding is new if its code is new, if it lists a record the earlier one did
 * not, or if it covers more records than before.
 */
export function newSeriousFindings(before: IntegrityReport, after: IntegrityReport): IntegrityFinding[] {
  const known = new Map(before.findings.filter(f => f.severity === 'serious').map(f => [f.code, f]));
  return after.findings.filter(f => {
    if (f.severity !== 'serious') return false;
    const old = known.get(f.code);
    if (!old) return true;
    if ((f.total ?? f.records.length) > (old.total ?? old.records.length)) return true;
    const oldRecords = new Set(old.records);
    return f.records.some(r => !oldRecords.has(r));
  });
}

/**
 * The findings that refuse a write.
 *
 * Only contradictions in the arithmetic or the identity of money: a receipt
 * issued twice, a refund beyond the receipt, a month billed twice, a levy settled
 * beyond what was charged, a closed month that moved, a tampered audit trail.
 * These are never a legitimate state, so no sequence of ordinary actions may end
 * in one.
 *
 * Deliberately not here: findings about how a villa is *classified* or about
 * history, such as rent still owed on a villa that has gone back to its owner
 * (a tenant who left owing a month is ordinary), a villa sold twice, or an
 * amount in a currency the villa is not billed in (which has its own
 * confirmation). Those stay as warnings on the screen. Blocking them would stop
 * the desk working on states the business really passes through, which is worse
 * than the fault.
 */
export const WRITE_BLOCKING_CODES = new Set([
  'duplicate-payment-id',
  'duplicate-receipt-number',
  'received-without-receipt',
  'impossible-payment-amount',
  'refunded-beyond-worth',
  'voided-and-refunded',
  'duplicate-charge-id',
  'month-billed-twice',
  'impossible-charge-amount',
  'damage-deposit-over-settled',
  'deposit-over-settled',
  'work-order-cost-raised-twice',
  'impossible-expense-amount',
  'monthly-cost-posted-twice',
  'duplicate-unit-id',
  'rent-split-does-not-add-up',
  'negative-rent-split',
  'rent-split-in-unbilled-currency',
  'levy-settled-beyond-what-was-charged',
  'audit-trail-broken',
  'audit-head-mismatch',
  'closed-period-changed'
]);

/** New serious findings, restricted to those that refuse a write. */
export function newBlockingFindings(before: IntegrityReport, after: IntegrityReport): IntegrityFinding[] {
  return newSeriousFindings(before, after).filter(f => WRITE_BLOCKING_CODES.has(f.code));
}
