/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The company that owns VDS and lets its villas.
 *
 * A constant rather than a setting on purpose. `strataPlanNumber` is a setting
 * that never got an input box, and three versions of the handover told people to
 * edit it in a screen where it did not exist. A name with no way to change it is
 * better than a setting that pretends to be changeable. Make it a setting on the
 * day it needs to change, with the field built in the same commit.
 */
export const MANAGING_COMPANY_NAME = 'ISPO';

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
  | 'Insurance share'
  | 'Opening balance'
  | 'Other';

export const ONE_OFF_CHARGE_TYPES: OneOffChargeType[] = [
  'Late fee',
  'Repair recharge',
  'Fine / breach',
  'Amenity fee',
  'Legal costs',
  'Special assessment',
  /**
   * A proprietor's share of the annual insurance premium.
   *
   * Distinct from a special assessment, which is a levy for unbudgeted major
   * works. This is a recurring annual apportionment of a known premium, and
   * calling it an assessment would misdescribe it on the owner's ledger and in
   * the annual return. Raised on the maintenance account, because it is a
   * contribution to the body corporate and ages into arrears alongside the
   * maintenance it is collected with.
   */
  'Insurance share',
  /**
   * A balance carried in from the system the corporation kept before this one.
   *
   * Labelled distinctly so it is never mistaken for something billed here: on a
   * ledger it reads as what it is, and it can be told apart from the months this
   * application actually raised. Dated to when the debt fell due rather than to
   * the migration, so it ages into the right bucket on the annual return instead
   * of appearing to have arisen on the day the records were moved.
   */
  'Opening balance',
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
  /**
   * See the out-of-pocket shortfall report under Operational Reports.
   *
   * Ro, 2026-09-02: *"just for us as admin means every staff member who has an
   * account so ensure every role can see it"* — so this is **granted to every
   * role by default**, and is here as a permission rather than an open door
   * because he asked for the choice to live in System Settings. "Internal" means
   * internal to the office: not owners, not the council, not a public document.
   *
   * **Absent means granted.** A database written before this field existed must
   * not read the missing value as a denial and take the report away from the
   * team on the next restart — the same rule `recordPayments` follows, and for
   * the same reason.
   */
  viewShortfall: boolean;
  /**
   * See the ISPO Operations statement — the letting company's own income and
   * costs — under Operational Reports.
   *
   * Ro, 2026-09-03, asked for the same rule the shortfall report follows:
   * *"Every role unless withdrawn is the best option."* So this is **granted to
   * every role by default** and is a permission rather than an open door only so
   * that it can be taken away in System Settings.
   *
   * **Absent means granted**, for the reason `recordPayments` and `viewShortfall`
   * carry: a database written before this field existed must not read the missing
   * value as a denial and take the statement away from the team on the next
   * restart.
   */
  viewIspoOperations: boolean;
  /**
   * Take a backup now and download a records snapshot.
   *
   * Ro, 2026-11-13: a junior officer could not save a backup, because every
   * backup route was gated as "change system settings", which is Administrators
   * and Managers only. Taking a copy changes nothing and protects everything, so
   * it is its own permission and can be given to any role in System Settings.
   *
   * This covers *taking* and *downloading* a copy only. Choosing where backups
   * are written, and **restoring** records from one, stay with settings
   * managers and the administrator respectively.
   *
   * **Absent means "as it was"**, which is not the same for every role: before
   * this existed, Managers (and anyone with veto power) could back up and the
   * others could not. The upgrade in server/db.ts reads a missing value that way.
   */
  takeBackups: boolean;
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
  'modifySettledRecords',
  'viewShortfall',
  'viewIspoOperations',
  'takeBackups'
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
  modifySettledRecords: 'Modify settled ledger records',
  viewShortfall: 'See the out-of-pocket shortfall report (internal)',
  viewIspoOperations: `See the ${MANAGING_COMPANY_NAME} Operations statement (internal)`,
  takeBackups: 'Take a backup now & download a records snapshot'
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
  /**
   * The last month whose books have been closed (YYYY-MM). Money dated in or
   * before it can no longer change without reopening the period.
   */
  closedThrough?: string;
  /** When true, voiding, correcting or refunding a received payment needs a second person's approval. */
  requireCosign?: boolean;
  /** What was closed: a fingerprint of that money, checked on every write. */
  closeFingerprint?: string;
  /**
   * Who this body corporate is, on the register.
   *
   * "Strata corporation" in the Act means **this body corporate** — the
   * proprietors of Villaggio Del Sol acting together — and NOT the Commission of
   * Strata Corporations, which is the regulator it files returns with. Printed
   * documents used to say "the Strata Corporation" and were read as meaning the
   * regulator. They now name the plan instead, which cannot be misread.
   *
   * The Commission's forms ask for both of these in their headers.
   */
  strataPlanNumber?: string;
  /** Taxpayer registration number, as it appears on the annual return forms. */
  trn?: string;
  /**
   * The day this application's records begin — the migration cutover.
   *
   * Everything before it happened in whatever system came before, and the
   * application holds no charges for it. Without this date the checks that look
   * backwards cannot tell "nobody billed this month" from "this month was billed
   * somewhere else": a tenancy entered with its real start date of, say, 2019
   * would be reported as having eighty-odd unbilled months, and the notifications
   * that matter would be buried under them.
   *
   * It is deliberately not a substitute for entering what is genuinely owed. A
   * balance carried over from the old system is entered as a dated charge like
   * any other, so it appears in arrears and ages correctly. This date only stops
   * the application inventing obligations for a period it was never keeping.
   *
   * Absent means the records are assumed to go all the way back, which is the
   * right default for a property that started on this system.
   */
  booksBeginOn?: string; // YYYY-MM-DD
  /**
   * Whether the dashboard shows the property health grade.
   *
   * **Absent means shown.** It is stored as "hide" rather than "show" so that a
   * database written before this existed — and there are live ones — keeps the
   * card rather than losing it to a missing field. Anything reading this must
   * treat `undefined` as on.
   */
  hidePropertyHealth?: boolean;
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

/**
 * How to name this body corporate in a document, unambiguously.
 *
 * "Strata corporation" in the Act means the proprietors of this plan acting
 * together — Villaggio Del Sol itself. It does **not** mean the Commission of
 * Strata Corporations, which is the regulator the corporation files returns
 * with. Documents that said "the Strata Corporation" were read as meaning the
 * regulator, so they name the plan instead.
 */
export function bodyCorporateName(settings?: { strataPlanNumber?: string } | null): string {
  const plan = settings?.strataPlanNumber?.trim();
  return plan ? `Villaggio Del Sol (Strata Plan No. ${plan})` : 'Villaggio Del Sol';
}

/**
 * What a villa's status means. Read this before using it for anything.
 *
 * These five values were declared here for years with no note on what any of
 * them meant, and that silence cost real money: `consolidateEverything` could
 * not tell whose villa it was looking at, so it guessed from the rent charges
 * instead, and a short stay raises no rent charge. ISPO's levy on an Airbnb
 * villa was counted as income on top of the guest's booking — the same money
 * twice, J$130,000 reported against J$90,000 received on a two-month fixture.
 *
 * Ro, 2026-11-12: *"owners are all responsible for their own tenants and rental
 * payments. this was made clear since this program was build"*, and *"thats why
 * we have the status owner occupied, which denotes its owned by someone else and
 * therefore from that status the system only charges maintenance"*.
 *
 * So the question this field answers is **who owns the villa**, and only
 * secondarily what is happening in it:
 *
 *   - **`owner-occupied`** — owned by **somebody other than ISPO**. The
 *     corporation bills it maintenance only, never rent, and the levy payments
 *     that arrive against it are a proprietor's own money: income. It is about
 *     ownership, NOT occupancy — a third party's villa standing empty is still
 *     `owner-occupied`, and nothing else records that fact.
 *   - **`long-term`** — ISPO's, let to a tenant. One rent figure, the levy taken
 *     out of it (`settledFromRent`).
 *   - **`short-term`** — ISPO's, on Airbnb. Guests pay bookings; no rent charge
 *     is ever raised, which is the case that broke the old inference.
 *   - **`vacant`** — ISPO's, nothing in it at the moment. Ro, 2026-11-12: *"yes
 *     vacant and unavailable are ispo's"*. ISPO still passes the corporation its
 *     levy every month, so this is not a gap in the money.
 *   - **`unavailable`** — ISPO's, off the market (works, a family stay).
 *
 * Everything except `owner-occupied` is therefore ISPO's, and that is exactly
 * what `isOwnAccount` in `src/lib/finance.ts` returns. Do not re-derive this
 * question anywhere else, and do not infer it from `ownerName`, which is free
 * text (see the note on that field).
 */
export type UnitStatus = 'long-term' | 'short-term' | 'owner-occupied' | 'vacant' | 'unavailable';

export const UNIT_STATUSES: UnitStatus[] = ['long-term', 'short-term', 'owner-occupied', 'vacant', 'unavailable'];

export interface Unit {
  id: string;
  number: string; // display label, e.g. "1" or "A1", may be edited, so never use as a join key
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
  /**
   * **Retired 2026-11-13. Read, written and acted on by nothing.**
   *
   * This was a hand-ticked "VDS lets this villa on its own account" box, and the
   * question it answered is now read from `status` by `isOwnAccount` — every
   * status except `owner-occupied` is ISPO's. The flag was right wherever
   * somebody remembered to tick it and silently wrong wherever they did not: an
   * unticked let villa made the combined view count ISPO's levy as income on top
   * of the rent, and made the shortfall report drop a villa VDS was really
   * funding.
   *
   * The field is kept so that an existing `db.json` still loads and so a later
   * reader meeting it in old data knows why it is ignored. **Do not read it, and
   * do not bring it back.** If a villa is being classified wrongly, its status is
   * wrong and the status is what to fix.
   */
  letOnOwnAccount?: boolean;
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
/**
 * A period of ownership of one villa.
 *
 * The unit record holds only the *current* proprietor, as editable fields, which
 * meant a villa changing hands was indistinguishable from an owner's name being
 * typed wrong: both were a silent overwrite, and afterwards nothing could answer
 * "who owned Villa 7 in March, and what did they owe?".
 *
 * That question is not academic here. Contributions are levied on proprietors,
 * and Form 13B reports what each one owes **against their strata lot**. When a
 * villa sells mid-year the arrears belong to whoever was the proprietor when the
 * contribution fell due — not to whoever owns it at the time the return is
 * filed. Charges already raised keep the payer they were raised with, so the
 * ledger is right; this record is what makes it *explicable*.
 *
 * Append-only, exactly like `Tenancy`: a sale closes the period and opens a new
 * one, and nothing is ever erased. Correcting a mis-typed name edits the open
 * period in place, because a spelling mistake is not a change of ownership.
 */
export interface Ownership {
  id: string;
  unitId: string;
  unitNumber: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  /**
   * When this proprietor acquired the villa, where it is known.
   *
   * Empty is normal and is not a defect. The register is usually filled in for
   * owners who have held their villas for years, and inventing a date would be
   * worse than admitting the date is not recorded — the same rule `Tenancy`
   * follows for a move-in.
   */
  startedOn: string; // YYYY-MM-DD, or '' when not known
  endedOn?: string; // YYYY-MM-DD
  endReason?: string;
  status: 'active' | 'ended';
  recordedBy: string;
  recordedAt: string;
  closedBy?: string;
}

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
  checkOut: string; // YYYY-MM-DD (departure, exclusive, the unit is free again on this date)
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
  /**
   * For a tenant's monthly rent charge, how `amount` splits: the rent proper and
   * the HOA maintenance the tenant also pays. `rentPortion + maintenancePortion`
   * always equals `amount`. Absent on charges raised before the tenant's total
   * included maintenance (they are whole rent), and on every non-rent charge.
   */
  rentPortion?: number;
  maintenancePortion?: number;
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
  /** When the entry was first made. Lets the desk tell a double click from a genuine second payment. */
  createdAt?: string;

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
  /**
   * Not a stored receipt: a maintenance credit worked out from rent collected on a
   * rented villa ("settled from rent"). Created in the browser by
   * `settledFromRent`, never sent to or kept by the server, never listed as a
   * receipt and never offered for voiding, refunding or reconciling.
   */
  derived?: boolean;
  /**
   * Set when a hand-keyed Maintenance receipt on a let villa was moved into the
   * tenant's rent (restate-maintenance-receipts). Internal only: never printed.
   */
  movedFrom?: PaymentCategory;
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

/**
 * The date to show as a cost's invoice date, and whether it is really one.
 *
 * A register that silently falls back to the logged date tells an accountant the
 * supplier dated a bill on the day the office happened to type it up. So the
 * fallback is reported rather than hidden, and every screen that shows it marks
 * it.
 */
export function invoiceDateOf(expense: Pick<Expense, 'date' | 'invoiceDate'>): { date: string; recorded: boolean } {
  return expense.invoiceDate ? { date: expense.invoiceDate, recorded: true } : { date: expense.date, recorded: false };
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

/**
 * Whose money pays for a cost.
 *
 * Two entities share this application and their money is not the same money:
 *
 *   - **`strata`** — the body corporate. Security, landscaping, the pool,
 *     grounds payroll, painting, the office and its power. Funded by the
 *     proprietors' maintenance contributions, and the subject of the annual
 *     report, the proprietors' monthly report and the Commission's returns.
 *   - **`ispo`** — the company that owns VDS and collects the rent. Its cell
 *     phone, its company vehicle and that vehicle's insurance. Funded out of
 *     rental income, and nothing to do with the proprietors.
 *
 * Ro, 2026-09-03: *"there are certain expenses, such as Cell phone bills,
 * company vehicle expenses and insurance and other expenses that are paid from
 * the rental income … The other expenses i mentioned are supposed to come from
 * the Rental Income for Ispo."*
 *
 * Before this field existed every cost was treated as the corporation's, which
 * put ISPO's phone bill into the proprietors' monthly report and — through
 * `feeToCoverBudget` — into the maintenance contribution the annual report puts
 * to the meeting. **Absent therefore means `strata`**: that is what every
 * existing record already is, it is what the reports already say, and it is what
 * the overwhelming majority of costs genuinely are. A database written before
 * this field must not have its books move underneath it on an upgrade — the same
 * rule `letOnOwnAccount` follows, and for the same reason.
 */
export type ExpenseFund = 'strata' | 'ispo';

export const EXPENSE_FUNDS: ExpenseFund[] = ['strata', 'ispo'];

/** Named by what pays, because that is the decision the person posting makes. */
export const EXPENSE_FUND_LABELS: Record<ExpenseFund, string> = {
  strata: 'Maintenance (Strata)',
  ispo: `Rental income (${MANAGING_COMPANY_NAME})`
};

export const EXPENSE_FUND_HINTS: Record<ExpenseFund, string> = {
  strata: 'Security, landscaping, pool, grounds staff, painting, the office, what contributions cover.',
  ispo: `Cell phone, company vehicle and its insurance, ${MANAGING_COMPANY_NAME}'s own costs, paid from rent.`
};

/**
 * The book a cost belongs to, with the default applied.
 *
 * Always read the fund through this rather than touching `fund` directly, so
 * "absent means strata" is stated once instead of at every call site.
 */
export function fundOf(record: { fund?: ExpenseFund }): ExpenseFund {
  return record.fund === 'ispo' ? 'ispo' : 'strata';
}

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
  /**
   * The date the supplier put on the bill, which is not the date anybody here
   * typed it in or paid it.
   *
   * Ro, 2026-10-08: *"the date column that is shown represents the date paid,
   * not the logged date... this creates some confusion as an accountant or
   * anyone reading could mistake the date shown to be the date of the invoice...
   * the date could confuse her thinking this is an October invoice when in truth
   * it is a September invoice."*
   *
   * Optional, and deliberately a **new** field rather than a relabelling of
   * `date`. Every cost written before this carries the day it was entered in
   * `date`, and calling that the invoice date would restate the whole register:
   * a September bill typed up in October would start claiming the supplier dated
   * it in October, which is the fault being fixed, written backwards.
   *
   * Read it through `invoiceDateOf`, which says whether it is the real thing or
   * the logged date standing in.
   */
  invoiceDate?: string;
  dueDate?: string;
  datePaid?: string;
  paymentMethod?: PaymentMethod;
  /**
   * `void` is a cost that was raised and then taken back — a bill entered twice,
   * a run posted for the wrong month, an amount typed from the wrong invoice.
   *
   * It is a third state rather than a deleted row for the same reason a charge is
   * voided rather than removed: a cost that reached the register and was recalled
   * is part of the property's history, and a register that quietly drops a line
   * invites the question of what else it dropped. Every figure in this system is
   * derived from `status === 'paid'` or `status === 'pending'`, so a voided cost
   * falls out of the arithmetic everywhere by construction.
   */
  status: 'paid' | 'pending' | 'void';
  reference: string;
  notes: string;
  /** Which of the two books pays for this. Absent means `strata`; see ExpenseFund. */
  fund?: ExpenseFund;
  /** Set when this expense came out of a monthly run; the template it came from. */
  recurringId?: string;
  /** The month a posted run raised this for, YYYY-MM. Set on run-posted rows only. */
  periodMonth?: string;
  /** Who took the cost back, when, and why. Set together, on a void only. */
  voidedBy?: string;
  voidedAt?: string;
  voidReason?: string;
  /**
   * Set when the cost was `paid` at the moment it was voided. Recalling a bill
   * nobody has paid is a correction; recalling one the books say was settled is a
   * statement that the money never left, so it is marked as the larger act it is.
   */
  voidedFromPaid?: boolean;
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
  /**
   * Which book this recurs against. Set once on the template, carried onto every
   * cost the run raises, so payroll goes to the strata and the phone bill to
   * ISPO every month without anyone having to remember.
   */
  fund?: ExpenseFund;
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
  /** SHA-256 over this entry and the seal of the entry before it. Absent on entries written before the chain began. */
  seal?: string;
  prevSeal?: string;
}

/**
 * Where a maintenance request has got to.
 *
 * Deliberately short. A longer list looks thorough and then goes unused, because
 * nobody updates a status they have to think about.
 */
export type WorkStatus = 'Reported' | 'Scheduled' | 'In progress' | 'Completed' | 'Cancelled';

export const WORK_STATUSES: WorkStatus[] = ['Reported', 'Scheduled', 'In progress', 'Completed', 'Cancelled'];

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

/* ------------------------------------------------------------------ *
 * The owners' annual report (AGM)
 * ------------------------------------------------------------------ */

/**
 * The sections of the AGM report that are written rather than computed.
 *
 * Deliberately a fixed set of named fields and **not a document editor**. The
 * figures, tables and charts are generated from the ledger into fixed slots; only
 * these boxes are typed. That is the whole safety property: nobody can type over
 * a number, so the arithmetic in the document is always the arithmetic in the
 * books. A free canvas would lose that on the first edit, and the 2026 report
 * needed a corrections log for exactly that reason.
 *
 * Keys are stable — renaming one silently drops last year's text.
 */
export const ANNUAL_REPORT_SECTIONS = [
  { key: 'executiveSummary', label: 'Executive summary', hint: 'The position in a few sentences: what the year cost, what owners were billed, and what is being proposed.' },
  { key: 'costContext', label: 'What it costs to run the property', hint: 'Why the cost is what it is. The figures and chart are generated below this text.' },
  { key: 'categoryNotes', label: 'What each category contains', hint: 'What sits inside each expenditure heading, so owners can see nothing is combined for convenience.' },
  { key: 'movements', label: 'What the movements tell us', hint: 'The year-over-year changes worth explaining, which lines moved and why.' },
  { key: 'recommendation', label: 'Recommendation', hint: 'The contribution being proposed, and the case for it.' },
  { key: 'alternatives', label: 'If the increase is not approved', hint: 'What must be reduced to fit within the current contribution. The reduction required is computed below.' },
  { key: 'risks', label: 'Risks of deferring', hint: 'What happens if the position is left as it is.' },
  { key: 'nextSteps', label: 'Next steps', hint: 'What owners are being asked to do, and when.' }
] as const;

export type AnnualReportSectionKey = (typeof ANNUAL_REPORT_SECTIONS)[number]['key'];

/**
 * One year's AGM report: the narrative, the budget, and the proposal.
 *
 * Stored per year so that opening next year's report starts from last year's
 * wording with every figure recomputed, rather than from a blank page. The
 * figures themselves are never stored — they are derived from the ledger on
 * every render by `annualOwnersReport()`, so a correction to a receipt reaches
 * the report without anyone re-opening it.
 */
export interface AnnualReport {
  /** The year reported on. The budget is for the year after it. */
  year: number;
  /** Which currency the report is stated in. JMD in practice. */
  currency: Currency;
  /** Narrative, keyed by section. Absent means not yet written. */
  narrative: Partial<Record<AnnualReportSectionKey, string>>;
  /**
   * Next year's budget per expenditure category. A category left out falls back
   * to this year's actual, so an untouched budget is a flat run-rate.
   */
  budgetByCategory: Record<string, number>;
  /** The contribution being put to the meeting, per villa per month. */
  proposedFee?: number;
  /** When the meeting is, printed on the cover. */
  meetingDate?: string;
  updatedAt: string;
  updatedBy: string;
}

/* ------------------------------------------------------------------ *
 * The records checking themselves
 * ------------------------------------------------------------------ */

/**
 * What the application found when it read its own records.
 *
 * Declared here rather than imported from `server/integrity.ts`, because that
 * module imports the server's `Database` type and pulling it into the client
 * bundle would drag the whole persistence layer with it. The shapes must stay
 * in step; both are small and both are covered by `self-check.test.mjs`.
 */
export interface IntegrityFinding {
  /** 'serious' means money is misstated somewhere. */
  severity: 'serious' | 'warning';
  code: string;
  message: string;
  /** The records involved, so a person can go and look at them. */
  records: string[];
}

export interface IntegrityReport {
  checkedAt: string;
  ok: boolean;
  serious: number;
  warnings: number;
  findings: IntegrityFinding[];
  /** Stated so "nothing found" on an empty database is not mistaken for a pass. */
  counts: { units: number; charges: number; payments: number; bookings: number; expenses: number };
}
