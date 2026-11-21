/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppSettings, Booking, Charge, Expense, Payment, Tenancy, Unit, UtilityReading } from '../types';
import { bookingOverlaps, delinquentAccounts, leasesNeedingAttention, letVillasWithNoRent, tenanciesMissingMoveInDate, unbilledOccupancy } from './finance';
import { billingBacklog } from './billingCalendar';
import { today } from './dates';

/**
 * The number on the sidebar badge: the Notifications Hub's "Open items", counted
 * from the same sources the hub lists them from.
 *
 * The badge used to count arrears, unpaid utilities, pending expenses and
 * double-bookings only, while the hub's own headline also counted leases running
 * out, occupied months never billed, levy months never raised and tenants with no
 * move-in date. A property with a lapsing lease read "8" on the badge and "10" on
 * the screen it opens (audit/daily, 2026-11-18). Scheduled charges (posted, not yet
 * due) are excluded from both, as they are not things needing doing now.
 *
 * Levy backlog is counted per villa and currency, the way the hub groups it.
 */
export function hubOpenItemCount(data: {
  units: Unit[];
  charges: Charge[];
  /** Stored receipts plus `settledFromRent`, exactly as the hub is given them. */
  payments: Payment[];
  utilities: UtilityReading[];
  expenses: Expense[];
  bookings: Booking[];
  tenancies: Tenancy[];
  settings?: Pick<AppSettings, 'booksBeginOn' | 'closedThrough'> | null;
}, asOf: string = today()): number {
  const { units, charges, payments, utilities, expenses, bookings, tenancies, settings } = data;
  const levyGroups = new Set(
    billingBacklog(units, tenancies, charges, asOf, settings?.booksBeginOn, settings?.closedThrough)
      .filter(row => row.category === 'Maintenance')
      .map(row => `${row.unit.id}|${row.currency}`)
  );
  return (
    bookingOverlaps(bookings).length +
    leasesNeedingAttention(units, tenancies).length +
    unbilledOccupancy(units, tenancies, charges, asOf, settings?.booksBeginOn, settings?.closedThrough).length +
    levyGroups.size +
    tenanciesMissingMoveInDate(units, tenancies).length +
    letVillasWithNoRent(units).length +
    delinquentAccounts(units, charges, payments, asOf).length +
    utilities.filter(u => u.status === 'unpaid').length +
    expenses.filter(e => e.status === 'pending').length
  );
}
