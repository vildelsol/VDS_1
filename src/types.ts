/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type UserRole = 'ADMINISTRATOR' | 'MANAGER' | 'FINANCE_OFFICER' | 'JUNIOR_OFFICER';

export type Currency = 'USD' | 'JMD';

export const CURRENCIES: Currency[] = ['USD', 'JMD'];

export type PaymentMethod = 'Cash' | 'Bank Transfer' | 'Credit Card' | 'Cheque' | 'Other';

export const PAYMENT_METHODS: PaymentMethod[] = ['Cash', 'Bank Transfer', 'Credit Card', 'Cheque', 'Other'];

export type PaymentCategory = 'Rent' | 'Maintenance' | 'Booking' | 'Utility' | 'Other';

export const PAYMENT_CATEGORIES: PaymentCategory[] = ['Rent', 'Maintenance', 'Booking', 'Utility', 'Other'];

/** Categories that are billed through the recurring charge ledger. */
export type ChargeCategory = 'Rent' | 'Maintenance';

/**
 * What a one-off charge is for.
 *
 * These are billed to an existing account rather than being accounts of their
 * own: a late fee or a recharged repair belongs on the tenant's rent account, a
 * special assessment on the owner's maintenance account. Keeping them there means
 * one balance per villa per account, which is the rule the whole application is
 * built on, and it means they age into arrears and chase themselves.
 */
export type OneOffChargeType =
  | 'Late fee'
  | 'Repair recharge'
  | 'Fine / breach'
  | 'Amenity fee'
  | 'Legal costs'
  | 'Special assessment'
  | 'Other';

export const ONE_OFF_CHARGE_TYPES: OneOffChargeType[] = [
  'Late fee',
  'Repair recharge',
  'Fine / breach',
  'Amenity fee',
  'Legal costs',
  'Special assessment',
  'Other'
];

export interface User {
  id: string;
  name: string;
  username: string;
  email: string;
  position: string;
  role: UserRole;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

/** The authenticated user as exposed to the browser. Never carries password material. */
export interface SessionUser {
  id: string;
  name: string;
  username: string;
  email: string;
  position: string;
  role: UserRole;
  mustChangePassword: boolean;
  permissions: RolePermissions;
}

export interface RolePermissions {
  /**
   * Take money and issue a receipt. Granted to every role by default: when nobody
   * senior is on site the junior officer still has to run the day, and collecting
   * rent is the day. It is a permission rather than an open door so it can be
   * withdrawn from a role in System Settings when that is wanted.
   */
  recordPayments: boolean;
  editBookings: boolean;
  cancelBookings: boolean;
  addBookings: boolean;
  editUnits: boolean;
  reversePayments: boolean;
  enterUtilities: boolean;
  recordExpenses: boolean;
  modifySettledRecords: boolean;
  postCharges: boolean;
  hasVetoPower?: boolean;
}

export const PERMISSION_KEYS: (keyof RolePermissions)[] = [
  'recordPayments',
  'addBookings',
  'editBookings',
  'cancelBookings',
  'editUnits',
  'enterUtilities',
  'recordExpenses',
  'postCharges',
  'reversePayments',
  'modifySettledRecords'
];

export const PERMISSION_LABELS: Record<string, string> = {
  recordPayments: 'Record payments & issue receipts',
  addBookings: 'Create guest reservations',
  editBookings: 'Edit guest reservations',
  cancelBookings: 'Cancel reservations & issue refunds',
  editUnits: 'Edit the unit register (rates, owners, tenants)',
  enterUtilities: 'Record utility meter readings',
  recordExpenses: 'Record property expenses',
  postCharges: 'Post monthly rent & maintenance charges',
  reversePayments: 'Reverse payments & void receipts',
  modifySettledRecords: 'Modify settled ledger records'
};

export interface StaffProfile {
  name: string;
  position: string;
}

export interface ICalFeed {
  id: string;
  unitId: string;
  unitNumber: string;
  url: string;
  source: 'Airbnb' | 'Booking.com' | 'Other';
  active: boolean;
  lastSyncAt?: string;
  lastResult?: string;
  lastStatus?: 'ok' | 'error';
}

export interface AppSettings {
  /** Indicative JMD per 1 USD, used only for display conversions. Never used to convert stored amounts. */
  fxRateJmdPerUsd: number;
  rolePermissions: {
    MANAGER: RolePermissions;
    FINANCE_OFFICER: RolePermissions;
    JUNIOR_OFFICER: RolePermissions;
  };
  vendors: string[];
  icalFeeds: ICalFeed[];
  /**
   * Folder for the off-machine backup copy — an external drive or a synced
   * folder. Set from System Settings so no environment variable or restart is
   * needed. Empty or absent means only the on-disk copy is kept.
   */
  backupDir?: string;
  /**
   * Identifies the chosen backup drive by a marker file written into the folder,
   * rather than by where it happened to be mounted. Windows hands a stick a
   * different letter depending on what else was plugged in first, and a path that
   * silently stops matching means the off-machine copy silently stops being made.
   * With this, the same drive is recognised wherever it turns up.
   */
  backupMarkerId?: string;
  /** Legacy fields retained so older databases keep loading. No longer read by the app. */
  juniorHasAdvancedAccess?: boolean;
  juniorPermissions?: RolePermissions;
  staffProfiles?: Record<string, StaffProfile>;
}

export type UnitStatus = 'long-term' | 'short-term' | 'owner-occupied' | 'vacant' | 'unavailable';

export const UNIT_STATUSES: UnitStatus[] = ['long-term', 'short-term', 'owner-occupied', 'vacant', 'unavailable'];

export interface Unit {
  id: string;
  number: string; // display label, e.g. "1" or "A1" — may be edited, so never use as a join key
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  tenantName: string;
  tenantEmail: string;
  tenantPhone: string;
  status: UnitStatus;
  monthlyRent: number;
  /**
   * The HOA levy actually billed each month.
   *
   * This is the figure that is charged. `entitlement` below is what it is
   * supposed to be *derived from* — the two are kept separate deliberately, so
   * that a levy which has drifted out of proportion can be seen rather than
   * silently overwritten.
   */
  monthlyMaintenance: number;
  /**
   * This lot's unit entitlement from the registered strata plan.
   *
   * Contributions must be levied on proprietors in proportion to unit
   * entitlement, so this — not a typed-in monthly figure — is what makes a levy
   * defensible when a proprietor challenges it at an AGM. It is the aggregate
   * share attaching to the lot, not a percentage: the shares are summed across
   * the plan and each lot's proportion is its share of that total.
   *
   * Optional because a register that predates it must keep working, and because
   * the figure comes off the strata plan rather than out of this system. A lot
   * with no entitlement recorded is excluded from proportionality checks rather
   * than assumed to be zero.
   *
   * See STRATA_COMPLIANCE.md.
   */
  entitlement?: number;
  /**
   * The lot number as it appears on the strata plan.
   *
   * Distinct from `number`, which is the villa label people use day to day and is
   * editable. The Commission's annual return asks for proprietor balances against
   * **strata lot numbers**, and there is no guarantee the two agree.
   */
  strataLotNumber?: string;
  currency: Currency;
  maintCurrency?: Currency;
  meterNumber: string;
  notes: string;
  rentDueDay?: number;
  maintDueDay?: number;
  ownerEmergencyName?: string;
  ownerEmergencyPhone?: string;
  ownerEmergencyEmail?: string;
  tenantEmergencyName?: string;
  tenantEmergencyPhone?: string;
  tenantEmergencyEmail?: string;
}

/**
 * An occupancy period for a unit.
 *
 * The Unit record carries only the *current* tenant, as a set of editable fields.
 * Overwriting them, or moving a unit off a long-term lease, used to discard the
 * previous occupant entirely — so there was no way to answer "who lived in Villa 7
 * last year, and what were they paying?". Tenancies are append-only: a tenant is
 * never edited away, their period is closed and a new one opened.
 */
export interface Tenancy {
  id: string;
  unitId: string;
  unitNumber: string;
  tenantName: string;
  tenantEmail: string;
  tenantPhone: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyEmail: string;
  /** Rent agreed for this occupancy, captured so a later rate change does not rewrite history. */
  monthlyRent: number;
  currency: Currency;
  rentDueDay: number;
  startedOn: string; // YYYY-MM-DD
  /**
   * When the fixed term ends, if there is one.
   *
   * Distinct from `endedOn`, which is when the tenant actually left. This is the
   * date the agreement runs to — the thing you need to see *before* it happens,
   * so a renewal is negotiated deliberately rather than discovered afterwards. A
   * tenancy with no lease end date is treated as running month to month.
   */
  leaseEndsOn?: string; // YYYY-MM-DD
  endedOn?: string; // YYYY-MM-DD
  endReason?: string;
  status: 'active' | 'ended';
  /**
   * The charge raised at move-in for the tenant's final month ("first and last").
   * Held on the tenancy so that closing it knows the final month is already paid
   * for and must not be charged a second time.
   */
  advanceRentChargeId?: string;
  /** When that advance was actually consumed against a final month. */
  advanceRentAppliedOn?: string;

  /**
   * A refundable security / damage deposit held on the tenant's behalf.
   *
   * Deliberately not a rent charge and not a payment: it is neither owed to the
   * property nor income of it. It is the tenant's money the property holds and
   * must give back, less any deductions for damage, so it stays off the balance,
   * off the operating statement and out of every collection figure. Its whole
   * lifecycle lives here.
   */
  depositAmount?: number;
  depositCurrency?: Currency;
  depositReceivedOn?: string;
  /** Set once the deposit has been reconciled at move-out. */
  depositReturnedOn?: string;
  /** Given back to the tenant. */
  depositReturnedAmount?: number;
  /** Kept — for damage, cleaning, unpaid charges. Its reason is recorded. */
  depositWithheldAmount?: number;
  depositWithheldReason?: string;
  /** True when the tenancy was ended by eviction rather than an ordinary move-out. */
  evicted?: boolean;
  /** Rent written off as bad debt at eviction. Retained for the record even though it left the dashboard. */
  writeOffAmount?: number;
  writeOffCurrency?: Currency;
  recordedBy: string;
  recordedAt: string;
  closedBy?: string;
}

export interface Booking {
  id: string;
  unitId: string;
  unitNumber: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  checkIn: string; // YYYY-MM-DD (arrival, inclusive)
  checkOut: string; // YYYY-MM-DD (departure, exclusive — the unit is free again on this date)
  source: 'Direct' | 'Airbnb' | 'Booking.com' | 'Blocked' | 'Unavailable';
  amount: number;
  nightlyRate?: number;
  currency: Currency;
  /** Part-payment toward the stay. This IS income — see `damageDepositAmount` for the other kind. */
  depositPaid: number;
  balanceDue: number;
  status: 'confirmed' | 'checked-in' | 'checked-out' | 'cancelled';

  /**
   * A refundable damage deposit held against the stay. **Entirely optional** —
   * most stays will not have one, and nothing about a booking, a check-out or a
   * receipt requires it.
   *
   * Not to be confused with `depositPaid`, which is a part-payment toward the
   * stay and is the guest's money becoming the property's. This is the opposite:
   * the guest's money that stays the guest's, held against damage and owed back
   * less whatever is fairly deducted. So it is never a payment row, never
   * collections, never income, and never touches an owner statement or a
   * projection. It lives here on the booking, as the tenancy deposit lives on the
   * tenancy.
   */
  damageDepositAmount?: number;
  damageDepositCurrency?: Currency;
  damageDepositReceivedOn?: string;
  /** Set once the deposit has been reconciled after the stay. */
  damageDepositReturnedOn?: string;
  damageDepositReturnedAmount?: number;
  damageDepositWithheldAmount?: number;
  damageDepositWithheldReason?: string;
  notes?: string;
  /** Set for reservations imported from an external iCalendar feed. Used for idempotent re-import. */
  externalUid?: string;
  externalFeedId?: string;
  importedAt?: string;
}

/**
 * A billed obligation. Outstanding balances are always
 * (sum of open charges) - (sum of completed payments), per unit, per category, per currency.
 */
export interface Charge {
  id: string;
  unitId: string;
  unitNumber: string;
  category: ChargeCategory;
  periodMonth: string; // YYYY-MM
  dueDate: string; // YYYY-MM-DD
  amount: number;
  currency: Currency;
  status: 'open' | 'void';
  payerName: string;
  /**
   * `advance-final-month` is the second month's rent taken at move-in — the
   * "last" of "first and last". It is a real rent charge that is really owed, but
   * it pays for the tenant's *final* month rather than this one, so their last
   * month is not charged again when they leave. Absent means an ordinary month.
   */
  kind?: 'advance-final-month' | 'one-off';
  /** For a one-off charge, what it is for. Drives reporting and the ledger label. */
  oneOffType?: OneOffChargeType;
  /** Shown on statements and the charge history where the month alone is not enough. */
  description?: string;
  createdAt: string;
  createdBy: string;
  voidedBy?: string;
  voidedAt?: string;
  voidReason?: string;
}

export interface Payment {
  id: string;
  receiptNo: string;
  payerName: string;
  unitId: string;
  unitNumber: string;
  category: PaymentCategory;
  amount: number;
  currency: Currency;
  date: string; // YYYY-MM-DD
  method: PaymentMethod;
  reference: string;
  notes: string;
  staffMember: string;
  /**
   * `pending` is money that has been *entered* but not yet *received* — a cheque
   * that has not cleared, a transfer that has been promised. It sits on the
   * ledger as an expected receipt and deliberately counts for nothing: it does
   * not reduce a balance, does not appear as income, and carries no receipt
   * number, because a receipt is proof that money changed hands. Confirming it
   * turns it into `completed`, which is the only status any figure is derived
   * from.
   */
  status: 'pending' | 'completed' | 'reversed';
  /** Set when a pending entry was confirmed as actually received. */
  receivedBy?: string;
  receivedAt?: string;
  reversedBy?: string;
  reversalReason?: string;
  reversalDate?: string;

  /**
   * Money genuinely handed back — which is **not** the same as voiding a receipt.
   *
   * Voiding says the receipt should never have existed: an entry error, a cheque
   * that bounced, money that never arrived. The event is erased and the ledger
   * reads as though it never happened.
   *
   * A refund says the opposite. The money *did* arrive, the receipt *is* valid and
   * stays valid, and then some or all of it went back out again — an overpayment
   * returned, a cancelled booking, a double payment given back. Recording that as
   * a void destroys the evidence that the property ever held the money, which is
   * exactly the record you need when someone asks what happened to it. Recording
   * it as an expense is no better: a refund is not a cost of running the property,
   * it is income handed back.
   *
   * So it lives here, on the receipt it came out of. Every figure that sums
   * completed payments nets this off — see `accountBalance`, `collectedInPeriod`
   * and `ownerStatement` — which is what makes a refunded rent payment put the
   * tenant back into arrears, correctly, instead of leaving the property looking
   * as though it still holds the money.
   *
   * Partial refunds are the normal case, so this is an amount rather than a flag.
   */
  refundedAmount?: number;
  refundedOn?: string; // YYYY-MM-DD
  refundMethod?: PaymentMethod;
  refundReason?: string;
  refundedBy?: string;

  /**
   * Seen on the bank statement.
   *
   * Nothing tied a receipt to the bank before this. The ledger could say a
   * J$95,000 transfer was received and be entirely self-consistent while the money
   * never actually landed — a transfer that was promised and never sent, a cheque
   * that bounced, or a receipt written for cash that went into somebody's pocket.
   * Internal consistency is not evidence; the bank is.
   *
   * Deliberately a **tick, not an import.** Ro, asked how the statement actually
   * reaches the office (2026-08-09): manual tick-off. A CSV importer would have to
   * be written against a bank export format nobody has a sample of, and would fail
   * silently the first time the bank changed a column. A person with the statement
   * in front of them, ticking what they can see, is slower and correct.
   *
   * `reconciledOn` is the statement date the entry appears under — the bank's date,
   * not today's, because that is the date being matched against.
   */
  reconciledOn?: string; // YYYY-MM-DD
  reconciledBy?: string;
  reconciledAt?: string;
  /** The bank's own reference for the line, when the statement shows one. */
  reconciledReference?: string;
  /** Number of times this receipt has been rendered for printing. >0 means a reprint. */
  printCount?: number;
  /** Set when the payment was generated from another record, so the two stay in step. */
  bookingId?: string;
  utilityId?: string;
}

export interface UtilityReading {
  id: string;
  unitId: string;
  unitNumber: string;
  meterNumber: string;
  billingPeriod: string; // YYYY-MM
  previousReading: number;
  currentReading: number;
  consumption: number;
  amountCharged: number;
  currency: Currency;
  status: 'unpaid' | 'paid';
  /** Receipt raised when the reading was settled. */
  paymentId?: string;
}

export type ExpenseCategory =
  | 'Maintenance'
  | 'Security'
  | 'Landscaping'
  | 'Utilities'
  | 'Payroll'
  | 'Property Taxes'
  | 'Supplies'
  | 'Contractors'
  | 'Other';

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'Maintenance',
  'Security',
  'Landscaping',
  'Utilities',
  'Payroll',
  'Property Taxes',
  'Supplies',
  'Contractors',
  'Other'
];

/**
 * Where a non-unit cost belongs. Villas are referenced by unitId; these named
 * locations cover everything that is not a specific villa, so the office and the
 * common/general property have a real record that flows into the reports.
 */
export const PROPERTY_LOCATIONS = ['General', 'Office'] as const;
export type PropertyLocation = (typeof PROPERTY_LOCATIONS)[number];

export const PROPERTY_LOCATION_LABELS: Record<PropertyLocation, string> = {
  General: 'General / common property',
  Office: 'Office'
};

export interface Expense {
  id: string;
  category: ExpenseCategory;
  vendor: string;
  description: string;
  /** '' means the cost is not tied to a specific villa; see `location`. */
  unitId: string;
  /** Villa number, or a PropertyLocation ("General" / "Office") when unitId is ''. */
  unitNumber: string;
  amount: number;
  currency: Currency;
  date: string; // YYYY-MM-DD (logged date)
  dueDate?: string;
  datePaid?: string;
  paymentMethod?: PaymentMethod;
  status: 'paid' | 'pending';
  reference: string;
  notes: string;
  /** Set when this expense came out of a monthly run; the template it came from. */
  recurringId?: string;
  /** The month a posted run raised this for, YYYY-MM. Set on run-posted rows only. */
  periodMonth?: string;
}

/**
 * A cost that comes round every month: payroll, electricity, water, the security
 * contract. The property was re-typing about twenty of these by hand every month,
 * which is slow and, worse, silently lossy — a bill nobody remembered was simply
 * never recorded.
 *
 * This is a template, not a bill. `amount` is the figure to start from, not a
 * fact: electricity is never the same twice, so a run pre-fills from here and the
 * person posting it corrects each line before anything is written. Nothing is
 * raised from a template without someone looking at it.
 *
 * Deliberately monthly-only. The annual insurance premium is split across the
 * villas, which is a different operation with different arithmetic, and it stays
 * a hand-entered expense rather than being forced through this.
 */
export interface RecurringExpense {
  id: string;
  category: ExpenseCategory;
  vendor: string;
  description: string;
  /** '' when the cost is not tied to a specific villa; see `unitNumber`. */
  unitId: string;
  /** Villa number, or a PropertyLocation ("General" / "Office") when unitId is ''. */
  unitNumber: string;
  /** The usual figure. A run pre-fills with it and the poster may change it. */
  amount: number;
  currency: Currency;
  paymentMethod: PaymentMethod;
  /** Day of the month the bill falls due, 1–28. */
  dueDay: number;
  /** A retired template stays on file so old expenses keep their lineage. */
  active: boolean;
  notes: string;
  createdAt: string;
  createdBy: string;
}

export interface AuditLog {
  id: string;
  user: string;
  role: string;
  dateTime: string;
  action: string;
  recordType: string;
  recordId: string;
  previousValue: string;
  newValue: string;
  approvedBy?: string;
}

/**
 * Where a maintenance request has got to.
 *
 * Deliberately short. A longer list looks thorough and then goes unused, because
 * nobody updates a status they have to think about.
 */
export type WorkStatus = 'Reported' | 'Scheduled' | 'In progress' | 'Completed' | 'Cancelled';

export const WORK_STATUSES: WorkStatus[] = ['Reported', 'Scheduled', 'In progress', 'Completed', 'Cancelled'];

/** Statuses that still need someone to do something. */
export const OPEN_WORK_STATUSES: WorkStatus[] = ['Reported', 'Scheduled', 'In progress'];

export interface UnitActivity {
  id: string;
  unitId: string;
  unitNumber: string;
  residentName: string;
  residentRole: 'Owner' | 'Tenant' | 'Guest' | 'Other';
  activityType:
    | 'Construction Work'
    | 'Pool Reservation'
    | 'Maintenance Request'
    | 'Noise / Event Notice'
    | 'Amenity Access'
    | 'Other Activity';
  dateCaptured: string;
  notes: string;
  loggedBy: string;
  loggedAt: string;

  /**
   * Work-order fields.
   *
   * A "Maintenance Request" used to be a note and nothing else: no state, no
   * owner, no cost, no end. It was logged and then lived in somebody's memory,
   * which is how a reported leak becomes a repair bill nobody expected. These
   * turn it into something that can be chased, closed and costed.
   *
   * Absent on every other kind of activity — a pool booking or a noise notice is
   * a record of something that happened, not work to be done — and absent on the
   * requests logged before this existed, which are treated as open.
   */
  workStatus?: WorkStatus;
  /** Who is doing it: a contractor, a caretaker, a member of staff. */
  assignedTo?: string;
  /** What it actually cost, once known. Recorded against the villa for reporting. */
  costAmount?: number;
  costCurrency?: Currency;
  completedOn?: string;
  /** How it was resolved, or why it was closed without work. */
  outcome?: string;
  /** Set when a linked expense was raised for the cost, so it is not double-entered. */
  expenseId?: string;
}

/** Human label for an expense allocation: a villa, the office, or common property. */
export function getAllocationLabel(unitNumber: string): string {
  if (unitNumber === 'General') return 'General / common';
  if (unitNumber === 'Office') return 'Office';
  return getUnitDisplayName(unitNumber);
}

export function getUnitDisplayName(number: string): string {
  const num = number || '';
  if (num.toLowerCase().includes('villa')) {
    return num;
  }
  // "General" and "Office" are property allocations, not villas. Calling this on
  // one produced "Villa Unit Office", which labels a communal cost as belonging to
  // a villa that does not exist. Guarded here as well as at the call sites,
  // because the two helpers are easy to confuse.
  if ((PROPERTY_LOCATIONS as readonly string[]).includes(num)) {
    return num;
  }
  return `Villa Unit ${num}`;
}

export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  'long-term': 'Long-term Lease',
  'short-term': 'Short-term / Airbnb',
  'owner-occupied': 'Owner Occupied',
  vacant: 'Vacant',
  unavailable: 'Unavailable'
};
