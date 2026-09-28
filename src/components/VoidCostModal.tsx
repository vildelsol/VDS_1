/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Taking a cost back off the books.
 *
 * Used in two places, because it is the same act at two sizes: one mistaken line
 * in the expense register, and a whole month's run posted in error. Both need the
 * same three things — a reason on the record, a plain statement of what leaves the
 * books, and a second deliberate step when the cost is one the books already say
 * was paid.
 *
 * That second step is not decoration. Recalling a bill nobody has paid is a
 * correction. Recalling one recorded as settled asserts that money never left the
 * account, which moves the operating statement, the proprietors' reports and the
 * annual accounts for that period. The server refuses the first attempt with
 * `expense-already-settled` and the refusal is shown here, verbatim, with the
 * confirmation unticked. Nothing is preselected.
 */

import React, { useState } from 'react';
import { ApiError, errorMessage } from '../lib/api';
import { ErrorNote, Field, Modal, SecondaryButton, SubmitButton, inputClass } from './ui';

/** The server's code for "this is already recorded as paid — confirm it". */
const EXPENSE_SETTLED = 'expense-already-settled';

export default function VoidCostModal({
  title,
  intro,
  actionLabel,
  settledConfirmLabel,
  onClose,
  onSubmit
}: {
  title: string;
  /** What is about to leave the books, in the property's own words. */
  intro: React.ReactNode;
  actionLabel: string;
  /** The sentence the person ticks when the cost was recorded as paid. */
  settledConfirmLabel: string;
  onClose: () => void;
  /** Resolves when the void is written. Rejects with the server's ApiError. */
  onSubmit: (reason: string, includeSettled: boolean) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  /** The server's refusal, held so the person reads the actual consequence. */
  const [settledWarning, setSettledWarning] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (reason.trim().length < 5) {
      setError('Please give a reason of at least 5 characters, it goes on the record.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(reason.trim(), confirmed);
      onClose();
    } catch (err) {
      // The settled refusal is not an error to be shown and dismissed: it is a
      // question, and the answer is the tick box below it.
      if (err instanceof ApiError && err.code === EXPENSE_SETTLED) {
        setSettledWarning(err.message);
        setConfirmed(false);
      } else {
        setError(errorMessage(err, 'Could not take that cost back.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      maxWidthClass="max-w-lg"
      footer={
        <div className="flex gap-3">
          <SubmitButton
            busy={busy}
            busyLabel="Taking it back…"
            form="vds-void-cost-form"
            className="flex-1"
            disabled={!!settledWarning && !confirmed}
          >
            {actionLabel}
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-void-cost-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700">
          {intro}
        </div>

        {settledWarning && (
          <div role="alert" className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-red-900">
            <p className="font-semibold">Nothing has been taken back yet.</p>
            <p className="leading-relaxed">{settledWarning}</p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-0.5" />
              <span>{settledConfirmLabel}</span>
            </label>
          </div>
        )}

        <Field
          label="Why is this being taken back?"
          htmlFor="vc-reason"
          required
          hint="Stays on the record beside your name. “Posted twice”, “wrong month”, “J$ figure read off the US$ invoice”."
        >
          <textarea
            id="vc-reason"
            rows={3}
            value={reason}
            onChange={e => setReason(e.target.value)}
            required
            minLength={5}
            className={inputClass}
          />
        </Field>

        <p className="text-[10px] leading-relaxed text-slate-500">
          The line is not deleted. It stays in the register marked as taken back, with your name, the date and this reason, and it
          leaves every total, statement and report from that moment.
        </p>
      </form>
    </Modal>
  );
}
