/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A villa's maintenance levy, dated: what it is now, what it will be, and when.
 *
 * Ro, 2026-11-18: the levy rises to J$27,000 from January 2027. This is where
 * that is entered ("from January 2027: J$27,000"), ahead of time, so nobody has
 * to remember to retype the levy between posting December and posting January.
 * Every add and remove is audit-logged by the server with the old and new figure.
 */

import React, { useState } from 'react';
import { Unit } from '../types';
import { formatMoney } from '../lib/money';
import { formatMonthLabel, currentMonth } from '../lib/dates';
import { levyChangeInForce, levyForMonth, levySchedule } from '../lib/feeSchedule';
import { errorMessage } from '../lib/api';
import { ErrorNote, Field, SecondaryButton, SubmitButton, SuccessNote, monoInputClass } from './ui';

export interface FeeChangeRequest {
  effectiveFrom: string;
  amount: number;
  currency: string;
}

export default function FeeSchedulePanel({
  unit,
  canEdit,
  onAdd,
  onAddPropertyWide,
  onRemove
}: {
  unit: Unit;
  canEdit: boolean;
  onAdd?: (unitId: string, change: FeeChangeRequest) => Promise<unknown>;
  onAddPropertyWide?: (change: FeeChangeRequest) => Promise<unknown>;
  onRemove?: (unitId: string, month: string) => Promise<unknown>;
}) {
  const cur = unit.maintCurrency || unit.currency;
  const thisMonth = currentMonth();
  const schedule = levySchedule(unit);
  const upcoming = schedule.filter(e => e.effectiveFrom > thisMonth);
  const past = schedule.filter(e => e.effectiveFrom <= thisMonth);
  const inForce = levyChangeInForce(unit, thisMonth);

  const [month, setMonth] = useState('');
  const [amount, setAmount] = useState('');
  const [everyVilla, setEveryVilla] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  if (unit.status === 'unavailable') return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setDone('');
    setBusy(true);
    try {
      const change = { effectiveFrom: month, amount: Number(amount), currency: cur };
      if (everyVilla && onAddPropertyWide) await onAddPropertyWide(change);
      else if (onAdd) await onAdd(unit.id, change);
      setDone(`From ${formatMonthLabel(month)}: ${formatMoney(Number(amount), cur)}${everyVilla ? ` for every villa charged in ${cur}` : ''}.`);
      setMonth('');
      setAmount('');
      setEveryVilla(false);
    } catch (err) {
      setError(errorMessage(err, 'Could not add the maintenance change.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 text-xs" data-testid="fee-schedule">
      <span className="block font-mono text-[10px] uppercase text-slate-400">Maintenance schedule</span>
      <p className="text-slate-600">
        Billed now: <strong className="font-mono">{formatMoney(levyForMonth(unit, thisMonth), cur)}</strong> a month
        {inForce ? ` (from ${formatMonthLabel(inForce.effectiveFrom)})` : ''}.
      </p>

      {upcoming.length > 0 ? (
        <ul className="space-y-1" aria-label="Upcoming maintenance changes">
          {upcoming.map(e => (
            <li key={e.effectiveFrom} className="flex items-center justify-between rounded-lg bg-teal-50/60 px-2.5 py-1.5 text-teal-900">
              <span>
                From <strong>{formatMonthLabel(e.effectiveFrom)}</strong>: <span className="font-mono">{formatMoney(e.amount, e.currency)}</span>
              </span>
              {canEdit && onRemove && (
                <button
                  type="button"
                  className="font-mono text-[10px] text-red-600 hover:underline"
                  onClick={async () => {
                    setError('');
                    setDone('');
                    try {
                      await onRemove(unit.id, e.effectiveFrom);
                      setDone(`Removed the change from ${formatMonthLabel(e.effectiveFrom)}.`);
                    } catch (err) {
                      setError(errorMessage(err, 'Could not remove the maintenance change.'));
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate-400">No upcoming change.</p>
      )}

      {past.length > 0 && (
        <p className="text-[10px] text-slate-400">
          Earlier changes: {past.map(e => `${formatMonthLabel(e.effectiveFrom)} ${formatMoney(e.amount, e.currency)}`).join('; ')}.
        </p>
      )}

      {canEdit && onAdd && (
        <form onSubmit={submit} className="space-y-2 rounded-xl border border-slate-100 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="From month" htmlFor={`fee-month-${unit.id}`}>
              <input id={`fee-month-${unit.id}`} type="month" required value={month} onChange={e => setMonth(e.target.value)} className={monoInputClass} />
            </Field>
            <Field label={`New maintenance (${cur})`} htmlFor={`fee-amount-${unit.id}`}>
              <input id={`fee-amount-${unit.id}`} type="number" min="0.01" step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} className={monoInputClass} />
            </Field>
          </div>
          {onAddPropertyWide && (
            <label className="flex items-center gap-2 text-[11px] text-slate-600">
              <input type="checkbox" checked={everyVilla} onChange={e => setEveryVilla(e.target.checked)} />
              Apply to every villa charged in {cur}
            </label>
          )}
          <p className="text-[10px] leading-relaxed text-slate-400">
            Months already posted keep the maintenance rate they were billed at; a change cannot be dated into a posted or closed month.
          </p>
          <div className="flex gap-2">
            <SubmitButton busy={busy}>Add dated change</SubmitButton>
            {(month || amount) && (
              <SecondaryButton onClick={() => { setMonth(''); setAmount(''); }}>Clear</SecondaryButton>
            )}
          </div>
        </form>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {done && <SuccessNote>{done}</SuccessNote>}
    </div>
  );
}
