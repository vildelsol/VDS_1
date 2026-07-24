/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type UserRole = 'ADMINISTRATOR' | 'MANAGER' | 'FINANCE_OFFICER' | 'JUNIOR_OFFICER';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface RolePermissions {
  editBookings: boolean;
  cancelBookings: boolean;
  addBookings: boolean;
  editUnits: boolean;
  reversePayments: boolean;
  enterUtilities: boolean;
  recordExpenses: boolean;
  modifySettledRecords: boolean;
  hasVetoPower?: boolean;
}

export interface StaffProfile {
  name: string;
  position: string;
}

export interface AppSettings {
  juniorHasAdvancedAccess: boolean;
  juniorPermissions?: RolePermissions;
  rolePermissions?: {
    MANAGER: RolePermissions;
    FINANCE_OFFICER: RolePermissions;
    JUNIOR_OFFICER: RolePermissions;
  };
  staffProfiles?: {
    ADMINISTRATOR: StaffProfile;
    MANAGER: StaffProfile;
    FINANCE_OFFICER: StaffProfile;
    JUNIOR_OFFICER: StaffProfile;
  };
  vendors?: string[];
}

export interface Unit {
  id: string;
  number: string; // "1" to "16"
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  tenantName: string;
  tenantEmail: string;
  tenantPhone: string;
  status: 'long-term' | 'short-term' | 'owner-occupied' | 'vacant' | 'unavailable';
  monthlyRent: number;
  monthlyMaintenance: number;
  currency: 'USD' | 'JMD';
  maintCurrency?: 'USD' | 'JMD';
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

export interface Booking {
  id: string;
  unitId: string;
  unitNumber: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  source: 'Direct' | 'Airbnb' | 'Booking.com' | 'Blocked' | 'Unavailable';
  amount: number;
  nightlyRate?: number;
  currency: 'USD' | 'JMD';
  depositPaid: number;
  balanceDue: number;
  status: 'confirmed' | 'checked-in' | 'checked-out' | 'cancelled';
  notes?: string;
}

export interface Payment {
  id: string;
  receiptNo: string;
  payerName: string;
  unitNumber: string;
  category: 'Rent' | 'Maintenance' | 'Booking' | 'Utility' | 'Other';
  amount: number;
  currency: 'USD' | 'JMD';
  date: string; // YYYY-MM-DD
  method: 'Cash' | 'Bank Transfer' | 'Credit Card' | 'Check' | 'Other';
  reference: string;
  notes: string;
  staffMember: string;
  status: 'completed' | 'reversed';
  reversedBy?: string;
  reversalReason?: string;
  reversalDate?: string;
}

export interface UtilityReading {
  id: string;
  unitNumber: string;
  meterNumber: string;
  billingPeriod: string; // e.g., "2026-06"
  previousReading: number;
  currentReading: number;
  consumption: number;
  amountCharged: number;
  currency: 'USD' | 'JMD';
  status: 'unpaid' | 'paid';
}

export interface Expense {
  id: string;
  category: 'Maintenance' | 'Security' | 'Landscaping' | 'Utilities' | 'Payroll' | 'Property Taxes' | 'Supplies' | 'Contractors' | 'Other';
  vendor: string;
  description: string;
  unitNumber: string; // unit number or "General"
  amount: number;
  currency: 'USD' | 'JMD';
  date: string; // YYYY-MM-DD (created date / logged date)
  dueDate?: string; // YYYY-MM-DD
  datePaid?: string; // YYYY-MM-DD
  paymentMethod?: string; // "Bank Transfer" | "Cash" | "Credit/Debit Card" | "Cheque" | "Other"
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
  previousValue: string; // JSON string or text
  newValue: string; // JSON string or text
  approvedBy?: string;
}

export interface UnitActivity {
  id: string;
  unitId: string;
  unitNumber: string; // e.g., "A1", "1", "2"
  residentName: string; // e.g. "Yvonne Clarke"
  residentRole: 'Owner' | 'Tenant' | 'Guest' | 'Other';
  activityType: 'Construction Work' | 'Pool Reservation' | 'Maintenance Request' | 'Noise / Event Notice' | 'Amenity Access' | 'Other Activity';
  dateCaptured: string; // YYYY-MM-DD
  notes: string;
  loggedBy: string; // Staff member name
  loggedAt: string; // ISO datetime
}

export function getUnitDisplayName(number: string): string {
  const num = number || '';
  if (num.toLowerCase().includes('villa')) {
    return num;
  }
  return `Villa Unit ${num}`;
}

