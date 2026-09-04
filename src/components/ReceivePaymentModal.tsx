/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Taking money, from wherever you happen to be standing.
 *
 * This lived inside the dashboard, which meant the only places you could receive
 * a payment were the two screens that already listed arrears. Someone looking at
 * a villa's record — with its outstanding balances right there on the page — had
 * to close it, change tab and find the villa again to accept the money for it.
 *
 * It is one component rather than a copy per screen on purpose. The rules it
 * enforces are not presentation: what the account owes, which currency it is
 * billed in, whether anything is billed at all, and what to do when the server
 * says the debt has already been settled by somebody else. A second copy would
 * drift from those, and the screens would start disagreeing about money.
 */

import React, { useState } from 'react';
import {
  Charge,
  Currency,
  PAYMENT_METHODS,
  Payment,
  PaymentMethod,
  Unit,
  getUnitDisplayName
} from '../types';
import { AccountBalance, accountBalance, chargeCurrency } from '../lib/finance';
import { formatMoneyLong } from '../lib/money';
import { formatMonthLabel, today } from '../lib/dates';
import { ALREADY_SETTLED, ApiError, errorMessage } from '../lib/api';
import {
  AlreadySettledNote,
  ErrorNote,
  Field,
  Modal,
  SecondaryButton,
  SubmitButton,
  inputClass,
  monoInputClass
} from './ui';

export default function ReceivePaymentModal({
  units,
  charges,
  payments,
  account,
  onClose,
  onSubmit
}: {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  account: AccountBalance | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [unitId, setUnitId] = useState(account?.unit.id || '');
  const [category, setCategory] = useState<'Rent' | 'Maintenance' | 'Booking' | 'Utility' | 'Other'>(account?.category || 'Maintenance');
  const [payerName, setPayerName] = useState(account ? account.unpaidCharges[0]?.payerName || '' : '');
  const [amount, setAmount] = useState(account ? String(Math.max(0, account.balance)) : '');
  const [currency, setCurrency] = useState<Currency>(account?.currency || 'JMD');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>('Cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [confirmNoCharge, setConfirmNoCharge] = useState(false);
  // Revealed by the server's refusal: this browser's ledger was fetched before
  // whoever else banked the money saved it, so it cannot know in advance.
  const [alreadySettled, setAlreadySettled] = useState('');
  const [confirmAlreadySettled, setConfirmAlreadySettled] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const unit = units.find(u => u.id === unitId);

  /** Nothing billed yet: this money would land as a credit, not settle anything. */
  const noOpenCharge =
    !!unit &&
    (category === 'Rent' || category === 'Maintenance') &&
    !charges.some(c => c.unitId === unit.id && c.category === category && c.status === 'open' && c.currency === currency);

  /**
   * What this account actually owes, right now.
   *
   * The same helper the arrears list and the ledger derive from, so the figure in
   * this form cannot disagree with the figure that sent someone to it.
   */
  const liveAccount =
    unit && (category === 'Rent' || category === 'Maintenance')
      ? accountBalance(unit, category, charges, payments, undefined, units)
      : null;
  const owed = liveAccount && liveAccount.balance > 0 ? liveAccount.balance : 0;

  /**
   * Prefill from the account, not from the rate card.
   *
   * This used to fill in one month's rent whatever the tenant actually owed. A
   * tenant two months behind hands over J$170,000 and the form says J$85,000,
   * with the balance nowhere on screen to check it against — so the officer
   * either happens to know, or records half the money. Opening the same form from
   * an arrears card filled in the full balance, so the identical field meant two
   * different things depending on which button you pressed.
   *
   * It now offers what is owed, and falls back to the monthly figure only when
   * the account is clear — where a payment is genuinely an advance for one month.
   *
   * (The currency comes from `chargeCurrency`, not `unit.currency`: a villa billed
   * for maintenance in USD once had its receipt recorded in JMD, and the payment
   * never cleared the delinquency it was raised against.)
   */
  const applyUnitDefaults = (nextUnitId: string, nextCategory: typeof category) => {
    const u = units.find(item => item.id === nextUnitId);
    if (!u) return;
    if (nextCategory === 'Rent' || nextCategory === 'Maintenance') {
      setCurrency(chargeCurrency(u, nextCategory));
      const next = accountBalance(u, nextCategory, charges, payments, undefined, units);
      const outstanding = next.balance > 0 ? next.balance : 0;
      const fallback = nextCategory === 'Maintenance' ? u.monthlyMaintenance : u.monthlyRent;
      const suggested = outstanding > 0 ? outstanding : fallback;
      // A villa with no rate configured yields zero, and a zero in the box reads
      // as a figure someone has already checked. Leave it empty so it asks to be
      // filled in — the submit refuses zero anyway.
      setAmount(suggested > 0 ? String(suggested) : '');
    } else {
      setCurrency(u.currency);
    }
    setPayerName(nextCategory === 'Maintenance' ? u.ownerName : u.tenantName || u.ownerName);
  };

  const expectedCurrency = unit && (category === 'Rent' || category === 'Maintenance') ? chargeCurrency(unit, category) : null;
  const mismatch = !!expectedCurrency && expectedCurrency !== currency;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!unitId) {
      setError('Select the villa this payment relates to.');
      return;
    }
    if (!(Number(amount) > 0)) {
      setError('Enter an amount greater than zero.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        unitId,
        category,
        payerName,
        amount: Number(amount),
        currency,
        date,
        method,
        reference,
        notes,
        // This screen's button says "Receive payment": the money is in hand, so
        // the receipt is issued now and the arrears alert clears immediately.
        receivedNow: true,
        confirmCurrencyMismatch: confirmMismatch,
        confirmNoOpenCharge: confirmNoCharge,
        confirmAlreadySettled
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === ALREADY_SETTLED) {
        setAlreadySettled(err.message);
        setError('');
      } else {
        setError(errorMessage(err, 'Could not record the payment.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Record payment received"
      subtitle={account ? `${getUnitDisplayName(account.unit.number)} — ${account.category}` : undefined}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Issuing receipt…" form="vds-quick-receive" className="flex-1">
            Record and issue receipt
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-quick-receive" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <AlreadySettledNote message={alreadySettled} confirmed={confirmAlreadySettled} onConfirm={setConfirmAlreadySettled} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Villa unit" htmlFor="qr-unit" required>
            <select
              id="qr-unit"
              value={unitId}
              onChange={e => {
                setUnitId(e.target.value);
                applyUnitDefaults(e.target.value, category);
              }}
              required
              className={inputClass}
            >
              <option value="">Select villa</option>
              {units.map(u => (
                <option key={u.id} value={u.id}>
                  {getUnitDisplayName(u.number)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category" htmlFor="qr-cat" required>
            <select
              id="qr-cat"
              value={category}
              onChange={e => {
                const next = e.target.value as typeof category;
                setCategory(next);
                applyUnitDefaults(unitId, next);
              }}
              className={inputClass}
            >
              <option value="Maintenance">Maintenance (HOA)</option>
              <option value="Rent">Rent (long-term)</option>
              <option value="Booking">Booking (short stay)</option>
              <option value="Utility">Utility</option>
              <option value="Other">Other</option>
            </select>
          </Field>
        </div>

        {/* What the account owes, stated before the amount is typed. Without it
            the officer is checking a figure against nothing, which is how a
            tenant two months behind gets recorded as having paid one. */}
        {liveAccount && (
          <div
            className={`rounded-xl border p-3 text-[11px] leading-relaxed ${
              owed > 0 ? 'border-red-100 bg-red-50 text-red-900' : 'border-slate-100 bg-slate-50 text-slate-600'
            }`}
          >
            {owed > 0 ? (
              <>
                <span className="font-semibold">
                  {getUnitDisplayName(liveAccount.unit.number)} owes {formatMoneyLong(owed, liveAccount.currency)} for{' '}
                  {liveAccount.category === 'Maintenance' ? 'HOA maintenance' : 'rent'}.
                </span>{' '}
                {liveAccount.unpaidCharges.length > 0 && (
                  <>
                    {liveAccount.unpaidCharges.length} unpaid month
                    {liveAccount.unpaidCharges.length === 1 ? '' : 's'} from{' '}
                    {formatMonthLabel(liveAccount.unpaidCharges[0].periodMonth)}.{' '}
                  </>
                )}
                The amount is set to the full balance — change it if less was handed over.
              </>
            ) : (
              <>Nothing is outstanding on this account. Anything recorded here will sit as a credit against future billing.</>
            )}
          </div>
        )}

        <Field label="Payer name" htmlFor="qr-payer" required>
          <input id="qr-payer" type="text" value={payerName} onChange={e => setPayerName(e.target.value)} required className={inputClass} placeholder="Owner, tenant or guest" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount received" htmlFor="qr-amount" required>
            <input id="qr-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Currency" htmlFor="qr-cur" required>
            <select id="qr-cur" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={monoInputClass}>
              <option value="JMD">JMD (J$)</option>
              <option value="USD">USD ($)</option>
            </select>
          </Field>
        </div>

        {mismatch && (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <p>
              {getUnitDisplayName(unit!.number)} is billed for {category.toLowerCase()} in <strong>{expectedCurrency}</strong>.
              A receipt in {currency} will not reduce that balance.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmMismatch} onChange={e => setConfirmMismatch(e.target.checked)} className="mt-0.5" />
              <span>Record in {currency} anyway.</span>
            </label>
          </div>
        )}

        {noOpenCharge && !mismatch && (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <p>
              Nothing has been billed to {getUnitDisplayName(unit!.number)} for {category.toLowerCase()} yet, so this would
              be recorded as a <strong>credit</strong> rather than settling anything. Post the month&apos;s charges first.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmNoCharge} onChange={e => setConfirmNoCharge(e.target.checked)} className="mt-0.5" />
              <span>Record it as a credit anyway.</span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Method" htmlFor="qr-method" required>
            <select id="qr-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date received" htmlFor="qr-date" required>
            <input id="qr-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <Field label="Reference" htmlFor="qr-ref">
          <input id="qr-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
        </Field>

        <Field label="Notes" htmlFor="qr-notes">
          <textarea id="qr-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}
