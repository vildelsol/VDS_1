/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Email drafting.
 *
 * The application does not send email itself — doing so would need a mail server
 * and the property's credentials, and a button that silently did nothing would be
 * exactly the kind of fabricated feature removed elsewhere. Instead these helpers
 * open a pre-filled draft in whatever mail application the staff member already
 * uses (Gmail, Outlook, Apple Mail); they read it and press send themselves.
 *
 * A mailto: draft cannot carry a file attachment, so the receipt text goes in the
 * body and the on-screen document remains printable / Save-as-PDF for a formal
 * copy. This is deliberate and is explained to the user at the point of use.
 */

import { Booking, Payment, Unit, getUnitDisplayName } from '../types';
import { formatMoneyLong } from './money';
import { formatDayLabel, nightsBetween } from './dates';
import { guestGreetingName, receiptStanding } from './stays';

export interface MailDraft {
  to: string;
  subject: string;
  body: string;
}

/** Open the draft in the user's default mail client. Returns false if there is no recipient. */
export function openMailDraft(draft: MailDraft): boolean {
  const params = new URLSearchParams();
  if (draft.subject) params.set('subject', draft.subject);
  if (draft.body) params.set('body', draft.body);
  const query = params.toString().replace(/\+/g, '%20');
  const href = `mailto:${encodeURIComponent(draft.to)}${query ? `?${query}` : ''}`;
  window.location.href = href;
  return true;
}

const PROPERTY = 'Villaggio Del Sol, Ocho Rios, Jamaica';

/** Who a payment receipt should be addressed to, derived from the linked record. */
export function receiptRecipient(
  payment: Payment,
  unit: Unit | undefined,
  booking: Booking | undefined
): { name: string; email: string } {
  if (payment.bookingId && booking) {
    return { name: booking.guestName, email: booking.guestEmail || '' };
  }
  if (!unit) return { name: payment.payerName, email: '' };
  if (payment.category === 'Maintenance') {
    return { name: unit.ownerName || payment.payerName, email: unit.ownerEmail || '' };
  }
  // Rent, utility, other — the tenant if there is one, otherwise the owner.
  if (unit.tenantName) return { name: unit.tenantName, email: unit.tenantEmail || unit.ownerEmail || '' };
  return { name: unit.ownerName || payment.payerName, email: unit.ownerEmail || '' };
}

export function buildReceiptEmail(payment: Payment, unit: Unit | undefined, recipient: { name: string; email: string }): MailDraft {
  const villa = unit ? getUnitDisplayName(unit.number) : `Unit ${payment.unitNumber}`;
  const lines = [
    `Dear ${recipient.name || 'Sir/Madam'},`,
    '',
    `This confirms your ${payment.category.toLowerCase()} payment received by ${PROPERTY}.`,
    '',
    `Receipt number : ${payment.receiptNo}`,
    `Date received  : ${formatDayLabel(payment.date)}`,
    `Villa          : ${villa}`,
    `Payment for    : ${payment.category}`,
    `Amount         : ${formatMoneyLong(payment.amount, payment.currency)}`,
    `Method         : ${payment.method}`,
    ...(payment.reference ? [`Reference      : ${payment.reference}`] : []),
    '',
    payment.status === 'reversed'
      ? '*** NOTE: this receipt has since been VOIDED. Please disregard it. ***'
      : 'A formal printed receipt is available on request.',
    '',
    'Thank you,',
    'Villaggio Del Sol Management'
  ];
  return {
    to: recipient.email,
    subject: `Receipt ${payment.receiptNo}, ${payment.category}, ${villa}`,
    body: lines.join('\n')
  };
}

export function buildStayReceiptEmail(booking: Booking, unit: Unit | undefined): MailDraft {
  const villa = unit ? getUnitDisplayName(unit.number) : `Unit ${booking.unitNumber}`;
  const nights = nightsBetween(booking.checkIn, booking.checkOut);
  const standing = receiptStanding(booking);
  const money =
    standing === 'no-value'
      ? ['Stay total   : not yet confirmed']
      : [
          `Stay total   : ${formatMoneyLong(booking.amount, booking.currency)}`,
          `Deposit paid : ${formatMoneyLong(booking.depositPaid, booking.currency)}`,
          `Balance due  : ${formatMoneyLong(booking.balanceDue, booking.currency)}${booking.balanceDue > 0 ? ' (payable on arrival)' : ''}`
        ];
  const lines = [
    `Dear ${guestGreetingName(booking)},`,
    '',
    `Thank you for choosing ${PROPERTY}. Here are your stay details:`,
    '',
    `Villa        : ${villa}`,
    `Arrival      : ${formatDayLabel(booking.checkIn)}`,
    `Departure    : ${formatDayLabel(booking.checkOut)}`,
    `Nights       : ${nights}`,
    ...(booking.nightlyRate ? [`Nightly rate : ${formatMoneyLong(booking.nightlyRate, booking.currency)}`] : []),
    ...money,
    '',
    'We look forward to welcoming you.',
    '',
    'Villaggio Del Sol Management'
  ];
  return {
    to: booking.guestEmail || '',
    subject: `Your stay at ${villa}, ${formatDayLabel(booking.checkIn)} to ${formatDayLabel(booking.checkOut)}`,
    body: lines.join('\n')
  };
}
