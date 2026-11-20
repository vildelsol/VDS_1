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

import type { Booking, Currency, Payment } from '../types';
import { refundedAsOf } from './finance';
import { addMoney, round2, subtractMoney, sumMoney } from './money';

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

export type ReceiptStanding = 'complimentary' | 'no-value' | 'balance-due' | 'paid' | 'overpaid' | 'cancelled';

/**
 * What a guest receipt may truthfully say about money.
 *
 * "Paid in full" is a statement that money was received. A stay with no value
 * entered has received nothing and owes nothing *on the record*, and those are
 * not the same fact — the Airbnb feed carries no prices, so every imported stay
 * starts here. It is only paid when there was something to pay and nothing is
 * left of it.
 */
export function receiptStanding(
  booking: Pick<Booking, 'amount' | 'balanceDue' | 'complimentary'> & { status?: Booking['status']; overpaid?: number }
): ReceiptStanding {
  // A cancelled stay is not "paid in full", whatever its money (hunt, 2026-11-20).
  if (booking.status === 'cancelled') return 'cancelled';
  // Free on purpose, not missing a price (Ro, 2026-11-19).
  if (booking.complimentary) return 'complimentary';
  // Held beyond the price: the guest is owed money back, which "paid in full" hid.
  if ((booking.overpaid || 0) > 0) return 'overpaid';
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

/* ------------------------------------------------------------------ *
 * What a stay has been paid, from the receipts
 * ------------------------------------------------------------------ */

export interface StayMoney {
  /** Received on the stay's receipts, before refunds. */
  received: number;
  /** Handed back against those receipts. */
  refunded: number;
  /** Received less refunded: what the property holds for this stay. */
  paid: number;
  /** Still to collect. Zero on a cancelled stay, whose price is no longer owed. */
  balance: number;
  /** Held beyond the stay's price (or anything held on a cancelled stay). */
  overpaid: number;
  receipts: Payment[];
}

/**
 * The one reading of a reservation's money, for every screen and document.
 *
 * QA, 2026-11-19: stays paid in full showed as owing — the Dashboard read
 * "Balance outstanding $3,610" where $300 was true — because every screen read
 * the reservation's own `depositPaid` / `balanceDue`. Those are what was typed on
 * the reservation, not what was received: the balance paid on arrival is its own
 * receipt, and a refund or a void lands on a receipt, never on those fields.
 *
 * So the receipts are the truth: the reservation's deposit receipt (`bookingId`)
 * and every receipt recorded toward the stay (`forBookingId`). Only completed
 * ones count, net of refunds — the same rule as every other balance.
 */
export function stayMoney(
  booking: Pick<Booking, 'id' | 'amount' | 'status'> & Partial<Pick<Booking, 'currency'>>,
  payments: Payment[],
  opts: { asOf?: string } = {}
): StayMoney {
  const asOf = opts.asOf;
  const receipts = payments.filter(
    p =>
      p.status === 'completed' &&
      !p.derived &&
      (p.bookingId === booking.id || p.forBookingId === booking.id) &&
      // USD and JMD never combine, whatever a link says (hunt, 2026-11-20).
      (!booking.currency || p.currency === booking.currency) &&
      // As at a day: only what had arrived by then.
      (!asOf || p.date <= asOf)
  );
  const received = sumMoney(receipts.map(p => p.amount));
  const refunded = sumMoney(receipts.map(p => refundedAsOf(p, asOf)));
  const paid = subtractMoney(received, refunded);
  // A cancelled stay's price is nothing: any money still on it is held for the guest.
  const price = booking.status === 'cancelled' ? 0 : booking.amount || 0;
  if (booking.status === 'cancelled') {
    return { received, refunded, paid, balance: 0, overpaid: round2(Math.max(0, paid - price)), receipts };
  }
  return {
    received,
    refunded,
    paid,
    balance: round2(Math.max(0, price - paid)),
    overpaid: round2(Math.max(0, paid - price)),
    receipts
  };
}

export interface StayTotals {
  /** Held against live (not cancelled) stays. */
  paid: number;
  /** Still to collect on live stays. */
  outstanding: number;
  /** Held beyond a stay's price, or held on a cancelled stay: owed back or to be explained. */
  overpaid: number;
  /** Booking receipts tied to no reservation. Counted here so they never vanish. */
  unlinked: number;
  unlinkedReceipts: Payment[];
}

/**
 * Per-currency totals of `stayMoney` over a set of reservations, plus the
 * Booking receipts that are not tied to any reservation at all — receipts
 * recorded before a receipt could name its stay. Those cannot reduce any one
 * stay's balance (nobody has said which), so they are counted and shown on
 * their own line rather than dropped.
 */
export function stayTotals(bookings: Booking[], payments: Payment[], allBookings: Booking[] = bookings): Record<Currency, StayTotals> {
  const out: Record<Currency, StayTotals> = {
    USD: { paid: 0, outstanding: 0, overpaid: 0, unlinked: 0, unlinkedReceipts: [] },
    JMD: { paid: 0, outstanding: 0, overpaid: 0, unlinked: 0, unlinkedReceipts: [] }
  };
  for (const b of bookings) {
    const m = stayMoney(b, payments);
    const t = out[b.currency];
    if (!t) continue;
    if (b.status !== 'cancelled') t.paid = addMoney(t.paid, m.paid);
    t.outstanding = addMoney(t.outstanding, m.balance);
    t.overpaid = addMoney(t.overpaid, m.overpaid);
  }
  const known = new Set(allBookings.map(b => b.id));
  for (const p of payments) {
    if (p.category !== 'Booking' || p.status !== 'completed' || p.derived) continue;
    const link = p.bookingId || p.forBookingId;
    if (link && known.has(link)) continue;
    const t = out[p.currency];
    if (!t) continue;
    t.unlinked = addMoney(t.unlinked, subtractMoney(p.amount, refundedAsOf(p)));
    t.unlinkedReceipts.push(p);
  }
  return out;
}
