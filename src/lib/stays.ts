/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * How a short-term stay reads on screen and on paper.
 *
 * Ro, 2026-09-16, testing the Airbnb calendar on real bookings, found four things
 * the booking list and the guest receipt said that were not true or not said:
 *
 *   - an imported stay with no value entered printed **"Paid in full"** over
 *     USD $0.00, because the receipt read "no balance" as "settled";
 *   - a stay that had already ended looked exactly like one still to come;
 *   - dates Airbnb closes read like a guest called "Airbnb (Not available)", with
 *     a guest receipt button beside them;
 *   - the feed's reservation code and phone digits were buried in the notes.
 *
 * Kept as pure functions of a booking and a date so each rule can be asserted
 * without a screen — see `test/components.test.mjs`.
 */

import type { Booking } from '../types';

/**
 * Dates that are closed rather than sold.
 *
 * Airbnb's export sends two kinds of entry. A guest's reservation is `Reserved`.
 * Everything else the listing is not open for — nights blocked by hand, a
 * preparation gap, the booking window, dates synced in from another calendar —
 * comes out identically as `Airbnb (Not available)`, with no way to tell which.
 * None of them is a guest, so none of them gets a receipt.
 */
export function isClosedDates(booking: Pick<Booking, 'source'>): boolean {
  return booking.source === 'Blocked' || booking.source === 'Unavailable';
}

export type StayPhase = 'upcoming' | 'in-stay' | 'completed' | 'cancelled';

/**
 * Where a stay stands on a given day, from its dates.
 *
 * Derived rather than stored. The recorded `status` only changes when somebody
 * changes it, and nobody checks a guest out of an Airbnb stay in this program, so
 * a stay from last month still read "confirmed". The departure day belongs to the
 * next guest — the villa is free on it — so a stay is completed from that day on.
 */
export function stayPhase(booking: Pick<Booking, 'checkIn' | 'checkOut' | 'status'>, day: string): StayPhase {
  if (booking.status === 'cancelled') return 'cancelled';
  if (booking.status === 'checked-out') return 'completed';
  if (day >= booking.checkOut) return 'completed';
  if (day >= booking.checkIn) return 'in-stay';
  return 'upcoming';
}

export const STAY_PHASE_LABEL: Record<StayPhase, string> = {
  upcoming: 'Upcoming',
  'in-stay': 'In stay',
  completed: 'Completed',
  cancelled: 'Cancelled'
};

export type ReceiptStanding = 'no-value' | 'balance-due' | 'paid';

/**
 * What a guest receipt may truthfully say about money.
 *
 * "Paid in full" is a statement that money was received. A stay with no value
 * entered has received nothing and owes nothing *on the record*, and those are
 * not the same fact — the Airbnb feed carries no prices, so every imported stay
 * starts here. It is only paid when there was something to pay and nothing is
 * left of it.
 */
export function receiptStanding(booking: Pick<Booking, 'amount' | 'balanceDue'>): ReceiptStanding {
  if (!(booking.amount > 0)) return 'no-value';
  return booking.balanceDue > 0 ? 'balance-due' : 'paid';
}

export interface PlatformReservation {
  /** Airbnb's confirmation code, e.g. `HMABC12345`. */
  code?: string;
  /** Link to the reservation on the host's Airbnb account. */
  url?: string;
  /** The only contact detail the feed carries. */
  phoneLast4?: string;
}

/**
 * The reservation details a platform feed does carry.
 *
 * Airbnb's export has no guest name, no email, no price — by Airbnb's design, not
 * this program's — but each reservation's description holds a link to it and the
 * last four digits of the guest's phone. Those are copied into the booking's notes
 * on import, and this reads them back out, so the person at the desk can open the
 * reservation in Airbnb and copy the guest across in one step.
 */
export function platformReservation(notes: string | undefined): PlatformReservation {
  const text = String(notes || '');
  const out: PlatformReservation = {};
  /*
   * Notes are free text anybody with edit rights can type into, so the link is
   * never lifted from them. Only the code is read, and the link is rebuilt on
   * Airbnb's own address — a note cannot point this button anywhere else.
   */
  const found = /airbnb\.[a-z.]+\/hosting\/reservations\/details\/([A-Z0-9]{6,20})\b/i.exec(text);
  if (found) {
    out.code = found[1].toUpperCase();
    out.url = `https://www.airbnb.com/hosting/reservations/details/${out.code}`;
  }
  const phone = /last\s*4\s*digits\)?\s*:\s*(\d{4})\b/i.exec(text);
  if (phone) out.phoneLast4 = phone[1];
  return out;
}

/**
 * The name to address a guest by, or "Guest" while nobody has entered one.
 *
 * An imported stay is named by the feed: "External guest" for a reservation, and
 * whatever the platform wrote for closed dates. Neither is a person, and "Dear
 * Airbnb (Not available)" was printed on a receipt.
 */
export function guestGreetingName(booking: Pick<Booking, 'guestName' | 'source'>): string {
  const name = String(booking.guestName || '').trim();
  if (!name || isClosedDates(booking) || /^external guest$/i.test(name) || /not available|unavailable|blocked/i.test(name)) {
    return 'Guest';
  }
  return name;
}

/**
 * Who is actually arriving, and who is actually leaving, within a window.
 *
 * Ro, 2026-09-28: *"the general dashboard should show the actual departure in the
 * next 14 days and not just be a heading based on dates."* The dashboard filtered
 * departures on `status === 'checked-in'` and arrivals on `status === 'confirmed'`,
 * and **nobody checks a guest in or out of an imported stay in this program**. So
 * the departures panel was empty whatever was in the calendar, and a stay went on
 * reading as a coming arrival after the guest had been and gone.
 *
 * These live here, not in the screen, for the reason `stayValueForRate` does:
 * `react-dom/server` can render a screen but cannot type into one, so a rule
 * written inside a component is a rule no test can reach. `test/short-stay-
 * deposits.test.mjs` asserts these directly.
 *
 * Both are derived from the dates through `stayPhase`, and closed dates are left
 * out on both sides — a night Airbnb has simply blocked is not a guest and is not
 * a movement.
 */
export function arrivalsWithin<T extends Pick<Booking, 'checkIn' | 'checkOut' | 'status' | 'source'>>(
  bookings: T[],
  day: string,
  horizon: string
): T[] {
  return bookings
    .filter(b => b.status !== 'cancelled' && !isClosedDates(b))
    .filter(b => b.checkIn >= day && b.checkIn <= horizon && stayPhase(b, day) === 'upcoming')
    .slice()
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
}

export function departuresWithin<T extends Pick<Booking, 'checkIn' | 'checkOut' | 'status' | 'source'>>(
  bookings: T[],
  day: string,
  horizon: string
): T[] {
  return bookings
    .filter(b => b.status !== 'cancelled' && !isClosedDates(b))
    /*
     * Anything not already finished. A guest in residence leaves on their
     * departure day and belongs here; one whose stay ended does not. Deliberately
     * not "checked in", which is a status nobody sets.
     */
    .filter(b => b.checkOut >= day && b.checkOut <= horizon && stayPhase(b, day) !== 'completed')
    .slice()
    .sort((a, b) => a.checkOut.localeCompare(b.checkOut));
}
