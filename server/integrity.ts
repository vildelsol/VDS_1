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
import { ownAccountUnitIds, settledFromRent } from '../src/lib/finance';

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
      'A voided receipt is still ticked as found on a bank statement, it says the money both did and did not arrive.',
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
    const auditCap = 20000;
    const auditCount = (db.auditLogs || []).length;
    if (auditCount >= auditCap * 0.9) {
      add(
        'warning',
        'audit-trail-near-capacity',
        `The audit trail holds ${auditCount} entries and is trimmed at ${auditCap}, oldest first. Export and archive it before the earliest entries are dropped.`,
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
      expenses.filter(e => isBadNumber(e.amount) || e.amount < 0).map(e => `${e.id} (${e.amount})`)
    );

    /*
     * A cost taken back is out of every figure in the application, so the only
     * thing standing between it and an unexplained hole in a month's spend is the
     * record of who took it back and why. That record is written in the same
     * operation as the void; if one is ever missing, something wrote the status
     * directly.
     */
    /*
     * The one double count the two books cannot prevent on their own.
     *
     * The maintenance ISPO pays on the villas it lets is a **receipt** against
     * that villa's maintenance account, and the ISPO statement reads it from the
     * payment ledger. If somebody also types it into the expense register as an
     * ISPO cost, the same money is counted twice on that statement — once from
     * the receipt and once from the cost — and the letting business reads as
     * worse than it is.
     *
     * Not refused at entry, because a genuine ISPO cost against one of its own
     * villas (a plumber, a locksmith) is a real and ordinary thing. This finds
     * the specific shape that is never right: a Maintenance-category ISPO cost
     * allocated to a villa VDS lets on its own account.
     */
    const ownAccountVillas = new Set(units.filter(u => u.letOnOwnAccount === true).map(u => u.id));
    add(
      'warning',
      'contribution-entered-as-a-cost',
      'A maintenance contribution on a villa VDS lets looks to have been entered in the expense register as well as receipted. It would be counted twice on the ISPO statement.',
      expenses
        .filter(
          e =>
            e.status !== 'void' &&
            e.fund === 'ispo' &&
            e.category === 'Maintenance' &&
            !!e.unitId &&
            ownAccountVillas.has(e.unitId)
        )
        .map(e => `${e.id} (${e.unitNumber}, ${e.currency} ${e.amount})`)
    );

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
     * The two screens must agree on what an inter-book transfer is.
     *
     * The combined view treats a let villa's levy receipts as ISPO handing the
     * corporation its share, because the levy sits inside the rent. The ISPO
     * operating statement asks a different question — `letOnOwnAccount` — and
     * shows the same money as "contributions paid to the corporation". Where the
     * two answers differ, one screen counts a receipt as income arriving and the
     * other as money moving between the books, and the property's own reports
     * disagree about how much came in.
     *
     * Not an error on its own: a villa genuinely owned by somebody else, and let,
     * is funded from rent and is correctly NOT on VDS's own account. So this is
     * reported as something to look at, not as a contradiction in the money.
     */
    const own = ownAccountUnitIds(units);
    const disagree = units
      .filter(u => u.status === 'long-term')
      .filter(u => {
        const funded = charges.some(c => c.unitId === u.id && c.category === 'Rent' && c.status === 'open' && (c.maintenancePortion || 0) > 0);
        return funded && !own.has(u.id);
      })
      .filter(u => payments.some(p => p.unitId === u.id && p.category === 'Maintenance' && p.status === 'completed'))
      .map(u => `villa ${u.number} (owner ${u.ownerName || 'not recorded'})`);
    add(
      'warning',
      'transfer-rule-disagrees-between-screens',
      'This villa\'s levy comes out of its rent, but it is not marked as let on VDS\'s own account. ' +
        'The combined view treats its maintenance receipts as money moved between the two books; the ISPO operating statement does not. ' +
        'If VDS owns it, tick "let on own account" on the villa. If somebody else owns it, nothing is wrong.',
      disagree
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
    return `Records checked: ${report.counts.payments} payments, ${report.counts.charges} charges, no contradictions found.`;
  }
  const parts = [`${report.serious} serious`, `${report.warnings} warning${report.warnings === 1 ? '' : 's'}`];
  return `RECORDS CHECK FOUND PROBLEMS (${parts.join(', ')}):\n` + report.findings.map(f => `  [${f.severity}] ${f.message}`).join('\n');
}
