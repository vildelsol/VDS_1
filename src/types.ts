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
  monthlyMaintenance: number;
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
  endedOn?: string; // YYYY-MM-DD
  endReason?: string;
  status: 'active' | 'ended';
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
  depositPaid: number;
  balanceDue: number;
  status: 'confirmed' | 'checked-in' | 'checked-out' | 'cancelled';
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
  status: 'completed' | 'reversed';
  reversedBy?: string;
  reversalReason?: string;
  reversalDate?: string;
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
