/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which reservations belong to a period, and to a villa.
 *
 * The reservations list used to show every stay ever recorded, so it grew for
 * ever. Ro, 2026-11-19, asked for it to be filtered by month and by villa.
 *
 * **The rule.** A stay belongs to a period when at least one *night* of it falls
 * inside the period. `checkIn` is the first night; `checkOut` is the departure
 * day, which is not a night stayed (the villa is free again that day — see
 * `Booking.checkOut` and `nightsBetween`). So a stay overlaps the inclusive days
 * `from`..`to` exactly when it arrives on or before `to` and departs after
 * `from`:
 *
 *   - 25 Oct to 25 Dec shows in October, November and December.
 *   - 28 Oct to 1 Nov does NOT show in November: its last night is 31 October,
 *     and 1 November is only the morning the guest leaves.
 *   - 31 Oct to 2 Nov shows in both: the night of 1 November is in November.
 *
 * Plain YYYY-MM-DD strings compare correctly as text, so no Date is built and no
 * timezone can move a stay into the wrong month.
 */

import { monthEnd, monthStart } from './dates';

type StayDates = { checkIn: string; checkOut: string };

/** True when a night of the stay falls on a day from `from` to `to`, both inclusive. */
export function stayOverlapsDays(stay: StayDates, from: string, to: string): boolean {
  if (!stay.checkIn || !stay.checkOut || !from || !to) return false;
  return stay.checkIn <= to && stay.checkOut > from;
}

/** True when a night of the stay falls in the YYYY-MM month. */
export function stayOverlapsMonth(stay: StayDates, month: string): boolean {
  return stayOverlapsDays(stay, monthStart(month), monthEnd(month));
}

export interface ReservationFilter {
  /** YYYY-MM, or null for every month. */
  month: string | null;
  /** A unit id, or '' for every villa. */
  unitId: string;
}

/** The reservations a month and villa filter keeps, in their original order. */
export function filterReservations<T extends StayDates & { unitId: string }>(rows: T[], filter: ReservationFilter): T[] {
  return rows.filter(
    b => (!filter.unitId || b.unitId === filter.unitId) && (filter.month === null || stayOverlapsMonth(b, filter.month))
  );
}
