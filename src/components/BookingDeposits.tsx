/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reservation deposits that need a person to look at them.
 *
 * Ro, 2026-09-28: deposits entered on a reservation were raised on the ledger as
 * *"Awaiting funds"*, so every one of them sat there unreceived until somebody
 * answered the same question twice. That is fixed at the point the receipt is
 * raised — a deposit entered on a reservation is money in hand and gets a receipt
 * number on the spot.
 *
 * This panel exists for what that fix cannot see. Ro, in the same message:
 * *"i do not want there to be a double count of payments after i have manually
 * confirmed before i apply the fix."* A deposit typed into **Record a payment**
 * rather than onto the reservation carries no link back to it, so it sits beside
 * the reservation's own receipt and the money is on the ledger twice. Nothing can
 * tell that apart from a guest who genuinely paid the same amount twice.
 *
 * So nothing here decides anything. It lists what it found, names the money in
 * each, and offers the two actions a person might want — with the consequence of
 * each written beside it and neither one preselected. That is the house pattern
 * for an act the machine cannot infer.
 */

import { useMemo, useState } from 'react';
import { Booking, Payment, SessionUser, getUnitDisplayName } from '../types';
import { bookingDepositFindings } from '../lib/finance';
import { formatMoney } from '../lib/money';
import { formatDayLabel } from '../lib/dates';
import { Badge, ErrorNote, SecondaryButton, SubmitButton } from './ui';
import { AlertTriangle, CheckCircle } from 'lucide-react';

interface Props {
  bookings: Booking[];
  payments: Payment[];
  session: SessionUser;
  onConfirmPayment: (paymentId: string, fields?: Record<string, unknown>) => Promise<Payment>;
  onReversePayment: (paymentId: string, reason: string) => Promise<unknown>;
}

export default function BookingDeposits({ bookings, payments, session, onConfirmPayment, onReversePayment }: Props) {
  const findings = useMemo(() => bookingDepositFindings(bookings, payments), [bookings, payments]);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  if (findings.length === 0) return null;

  const canAct = session.permissions.recordPayments;
  const canVoid = session.permissions.modifySettledRecords;

  const run = async (id: string, work: () => Promise<unknown>) => {
    if (busyId) return;
    setBusyId(id);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be done.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/40 p-5 shadow-xs">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div>
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Reservation deposits to check ({findings.length})
          </h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">
            A deposit entered on a reservation now reaches this ledger as a receipt by itself. These are the ones that
            still need a decision: a deposit logged before that, still awaiting confirmation, or a separate booking
            receipt for the same villa and the same amount that may be the same money entered twice.{' '}
            <strong>Nothing has been changed for you.</strong>
          </p>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <ul className="space-y-3">
        {findings.map(f => (
          <li key={f.booking.id} className="space-y-2 rounded-xl border border-amber-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs font-semibold text-slate-900">
                {f.booking.guestName || 'Guest'}, {getUnitDisplayName(f.booking.unitNumber)}
              </p>
              <p className="font-mono text-[11px] text-slate-500">
                {formatDayLabel(f.booking.checkIn)} → {formatDayLabel(f.booking.checkOut)}
              </p>
            </div>
            <p className="font-mono text-[11px] text-slate-600">
              Deposit on the reservation: <strong>{formatMoney(f.booking.depositPaid, f.booking.currency)}</strong>
            </p>

            {f.awaiting && f.linked && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 p-3">
                <p className="text-[11px] leading-relaxed text-slate-700">
                  Its receipt is still <Badge tone="amber">Awaiting funds</Badge> from before the rule changed. Confirming
                  it issues a receipt number and puts the money on the ledger. It does not add a second entry, this is
                  the reservation&rsquo;s own receipt.
                </p>
                {canAct && (
                  <SubmitButton
                    type="button"
                    busy={busyId === f.linked.id}
                    busyLabel="Confirming…"
                    onClick={() => run(f.linked!.id, () => onConfirmPayment(f.linked!.id))}
                  >
                    <CheckCircle className="h-4 w-4" /> Confirm this deposit
                  </SubmitButton>
                )}
              </div>
            )}

            {f.unlinked.map(p => (
              <div key={p.id} className="space-y-2 rounded-lg border border-red-200 bg-red-50/60 p-3">
                <p className="text-[11px] leading-relaxed text-slate-700">
                  <strong>
                    {p.receiptNo || 'An unnumbered receipt'} for {formatMoney(p.amount, p.currency)}
                  </strong>{' '}
                  on {formatDayLabel(p.date)} from {p.payerName || 'not recorded'} is a booking receipt against this villa
                  for exactly this amount, and is <strong>not</strong> tied to this reservation.
                  {f.linked
                    ? ' The reservation has its own receipt as well, so this is either the same deposit entered twice or a second, genuine payment.'
                    : ' The reservation has no receipt of its own, so this may simply be how the deposit was recorded.'}
                </p>
                {canVoid && f.linked && (
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton
                      onClick={() =>
                        run(p.id, () =>
                          onReversePayment(
                            p.id,
                            `Duplicate of the deposit on the reservation for ${f.booking.guestName || 'the guest'} (${f.booking.checkIn}).`
                          )
                        )
                      }
                      className="text-red-700"
                    >
                      {busyId === p.id ? 'Voiding…' : 'This is the same money, void this receipt'}
                    </SecondaryButton>
                    <span className="self-center font-mono text-[10px] text-slate-500">
                      or leave it: two genuine payments stay on the ledger and this notice stays with them.
                    </span>
                  </div>
                )}
                {!canVoid && (
                  <p className="font-mono text-[10px] text-slate-500">
                    Voiding a receipt is not part of your role. Ask an administrator if this is a duplicate.
                  </p>
                )}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
