/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tying the ledger to the bank.
 *
 * Every other figure in this application is derived from the property's own
 * records. That makes them consistent with each other, which is not the same as
 * true: a transfer that was promised and never sent, a cheque that bounced, or
 * cash that was receipted and never banked all look exactly like money that
 * arrived. This screen is the only place the ledger is checked against something
 * that is not the ledger.
 *
 * **A tick, not an import.** Ro, asked how the statement actually reaches the
 * office (2026-08-09): manual tick-off. A CSV importer would have to be written
 * against a bank export nobody has a sample of, and would fail quietly the first
 * time a column moved. Someone with the statement open, ticking what they can
 * actually see, is slower and right — and it works with a paper statement, a PDF,
 * or a banking site on a phone.
 *
 * So the screen is built for one posture: statement on one side, this on the
 * other, working down. One period, one currency, newest last, and a single number
 * at the top that the whole exercise exists to drive to zero.
 */

import React, { useMemo, useState } from 'react';
import { Banknote, CheckCircle2, Circle, Landmark, Printer } from 'lucide-react';

import { Currency, CURRENCIES, Payment, SessionUser, Unit, getUnitDisplayName } from '../types';
import { Reconciliation as ReconciliationResult, reconciliation } from '../lib/finance';
import { formatMoney, formatMoneyLong } from '../lib/money';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import { errorMessage } from '../lib/api';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  PermissionNote,
  SecondaryButton,
  SuccessNote,
  TableScroller,
  inputClass,
  monoInputClass,
  tableHeadRowClass
} from './ui';

interface ReconciliationProps {
  payments: Payment[];
  units: Unit[];
  session: SessionUser;
  onReconcile: (paymentId: string, fields: Record<string, unknown>) => Promise<unknown>;
}

export default function ReconciliationTab({ payments, units, session, onReconcile }: ReconciliationProps) {
  const [month, setMonth] = useState(currentMonth());
  const [currency, setCurrency] = useState<Currency>('JMD');
  const [show, setShow] = useState<'unmatched' | 'all'>('unmatched');
  const [statementDate, setStatementDate] = useState(today());
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [printing, setPrinting] = useState(false);

  const canReconcile = session.role === 'ADMINISTRATOR' || !!session.permissions.recordPayments;

  const from = monthStart(month);
  const to = monthEnd(month);

  const result: ReconciliationResult = useMemo(
    () => reconciliation(payments, currency, from, to),
    [payments, currency, from, to]
  );

  const rows = show === 'unmatched' ? result.unmatched : result.receipts;
  const done = result.receipts.length > 0 && result.unmatched.length === 0;

  const unitLabel = (p: Payment) => {
    const unit = units.find(u => u.id === p.unitId);
    return unit ? getUnitDisplayName(unit.number) : p.unitNumber || '—';
  };

  const toggle = async (p: Payment) => {
    setError('');
    setSuccess('');
    setBusyId(p.id);
    try {
      if (p.reconciledOn) {
        await onReconcile(p.id, { reconciled: false });
        setSuccess(`${p.receiptNo} un-matched.`);
      } else {
        await onReconcile(p.id, { reconciledOn: statementDate });
        setSuccess(`${p.receiptNo} matched to the statement of ${formatDayLabel(statementDate)}.`);
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not update that receipt.'));
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="space-y-4">
      <ErrorNote>{error}</ErrorNote>
      <SuccessNote>{success}</SuccessNote>

      <InfoNote>
        Open the bank statement beside this and work down it. Tick each receipt you can see on the statement; what stays
        unticked at the bottom is what the ledger claims and the bank does not show. Nothing here changes a balance — it
        records only whether the money was actually found.
      </InfoNote>

      {/* ---------------- the figure that matters ---------------- */}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-xs">
          <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Ledger says received</p>
          <p className="mt-1 font-mono text-lg font-semibold text-slate-900">{formatMoney(result.total, currency)}</p>
          <p className="mt-0.5 text-[10px] text-slate-400">{result.receipts.length} receipt(s) in {formatMonthLabel(month)}</p>
        </div>
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-emerald-700">Found on the statement</p>
          <p className="mt-1 font-mono text-lg font-semibold text-emerald-800">{formatMoney(result.matchedTotal, currency)}</p>
          <p className="mt-0.5 text-[10px] text-emerald-600">{result.matched.length} matched</p>
        </div>
        <div className={`rounded-2xl border p-4 ${result.unmatchedTotal === 0 ? 'border-slate-100 bg-white' : 'border-amber-200 bg-amber-50'}`}>
          <p className={`font-mono text-[10px] uppercase tracking-wider ${result.unmatchedTotal === 0 ? 'text-slate-500' : 'text-amber-800'}`}>
            Not yet found
          </p>
          <p className={`mt-1 font-mono text-lg font-semibold ${result.unmatchedTotal === 0 ? 'text-slate-400' : 'text-amber-900'}`}>
            {formatMoney(result.unmatchedTotal, currency)}
          </p>
          <p className={`mt-0.5 text-[10px] ${result.unmatchedTotal === 0 ? 'text-slate-400' : 'text-amber-700'}`}>
            {result.unmatched.length} outstanding
          </p>
        </div>
      </div>

      {done && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-xs text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span>
            <strong>{formatMonthLabel(month)} reconciles.</strong> Every {currency} receipt for the month has been found on
            a statement.
          </span>
        </div>
      )}

      {/* ---------------- controls ---------------- */}

      <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[9rem]">
            <Field label="Month" htmlFor="rc-month">
              <input id="rc-month" type="month" value={month} max={currentMonth()} onChange={e => setMonth(e.target.value)} className={monoInputClass} />
            </Field>
          </div>
          <div className="min-w-[7rem]">
            <Field label="Currency" htmlFor="rc-currency" hint="Never combined.">
              <select id="rc-currency" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={inputClass}>
                {CURRENCIES.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="min-w-[9rem]">
            <Field label="Show" htmlFor="rc-show">
              <select id="rc-show" value={show} onChange={e => setShow(e.target.value as 'unmatched' | 'all')} className={inputClass}>
                <option value="unmatched">Still to find</option>
                <option value="all">Every receipt</option>
              </select>
            </Field>
          </div>
          <div className="min-w-[10rem]">
            <Field
              label="Statement date"
              htmlFor="rc-stmt"
              hint="The bank's date for the lines you are ticking. Set once, then work down."
            >
              <input id="rc-stmt" type="date" value={statementDate} max={today()} onChange={e => setStatementDate(e.target.value)} className={monoInputClass} />
            </Field>
          </div>
          <div className="ml-auto">
            <SecondaryButton onClick={() => setPrinting(true)} disabled={result.receipts.length === 0}>
              <span className="flex items-center gap-1.5">
                <Printer className="h-3.5 w-3.5" />
                Print the reconciliation
              </span>
            </SecondaryButton>
          </div>
        </div>
        {!canReconcile && (
          <div className="mt-3">
            <PermissionNote>
              Your role cannot mark receipts against a statement. The figures above are still accurate.
            </PermissionNote>
          </div>
        )}
      </div>

      {/* ---------------- the list ---------------- */}

      {rows.length === 0 ? (
        <EmptyState
          title={
            show === 'unmatched'
              ? result.receipts.length === 0
                ? `No ${currency} receipts in ${formatMonthLabel(month)}`
                : 'Everything for this month has been found'
              : `No ${currency} receipts in ${formatMonthLabel(month)}`
          }
          hint={
            result.receipts.length === 0
              ? 'Only money confirmed as received appears here. An expected cheque shows up once it is confirmed.'
              : undefined
          }
          icon={<Landmark className="h-6 w-6" />}
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
          <TableScroller>
            <table className="w-full text-left text-xs">
              <thead>
                <tr className={tableHeadRowClass}>
                  <th scope="col" className="p-3">Seen</th>
                  <th scope="col" className="p-3">Date</th>
                  <th scope="col" className="p-3">Receipt</th>
                  <th scope="col" className="p-3">Payer</th>
                  <th scope="col" className="p-3">Villa</th>
                  <th scope="col" className="p-3">Method</th>
                  <th scope="col" className="p-3 text-right">Amount</th>
                  <th scope="col" className="p-3">Matched</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(p => (
                  <tr key={p.id} className={p.reconciledOn ? 'bg-emerald-50/40' : ''}>
                    <td className="p-3">
                      <button
                        type="button"
                        disabled={!canReconcile || busyId === p.id}
                        onClick={() => void toggle(p)}
                        aria-label={p.reconciledOn ? `Un-match receipt ${p.receiptNo}` : `Mark receipt ${p.receiptNo} as seen on the statement`}
                        aria-pressed={!!p.reconciledOn}
                        className="rounded-lg p-1 text-slate-300 transition-colors hover:bg-slate-100 disabled:opacity-40"
                      >
                        {p.reconciledOn ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                        ) : (
                          <Circle className="h-5 w-5" />
                        )}
                      </button>
                    </td>
                    <td className="p-3 font-mono text-[11px] text-slate-500">{formatDayLabel(p.date)}</td>
                    <td className="p-3 font-mono font-semibold text-slate-700">{p.receiptNo}</td>
                    <td className="p-3">
                      <p className="font-medium text-slate-900">{p.payerName}</p>
                      {p.reference && <p className="font-mono text-[10px] text-slate-400">{p.reference}</p>}
                    </td>
                    <td className="p-3 font-mono text-[11px]">{unitLabel(p)}</td>
                    <td className="p-3">
                      <Badge tone={p.method === 'Cash' ? 'amber' : 'slate'}>
                        {p.method === 'Cash' && <Banknote className="h-3 w-3" />}
                        {p.method}
                      </Badge>
                    </td>
                    <td className="p-3 text-right font-mono font-medium">
                      {formatMoney(p.amount, p.currency)}
                      {!!p.refundedAmount && (
                        <p className="text-[9px] font-normal text-amber-700">less {formatMoney(p.refundedAmount, p.currency)} refunded</p>
                      )}
                    </td>
                    <td className="p-3 font-mono text-[10px] text-slate-500">
                      {p.reconciledOn ? (
                        <>
                          {formatDayLabel(p.reconciledOn)}
                          <span className="block text-slate-400">by {p.reconciledBy}</span>
                        </>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </div>
      )}

      {printing && (
        <PrintPortal
          title="Bank reconciliation"
          subtitle={`${formatMonthLabel(month)} · ${currency}`}
          onClose={() => setPrinting(false)}
        >
          <ReconciliationSheet result={result} month={month} generatedBy={session.name} unitLabel={unitLabel} />
        </PrintPortal>
      )}
    </div>
  );
}

/**
 * The month's reconciliation as a sheet to sign and file.
 *
 * Leads with what was *not* found, because that is the finding. A reconciliation
 * that opens with a long list of things that matched buries the two lines somebody
 * actually has to chase.
 */
function ReconciliationSheet({
  result,
  month,
  generatedBy,
  unitLabel
}: {
  result: ReconciliationResult;
  month: string;
  generatedBy: string;
  unitLabel: (p: Payment) => string;
}) {
  return (
    <>
      <PrintLetterhead
        documentTitle="Bank Reconciliation"
        meta={`${formatMonthLabel(month)} · ${result.currency}`}
        generatedBy={generatedBy}
      />

      <table className="mb-6 w-full text-[11px]">
        <tbody className="font-mono">
          <tr>
            <td className="py-1 text-slate-600">Received according to the ledger</td>
            <td className="py-1 text-right font-semibold">{formatMoneyLong(result.total, result.currency)}</td>
          </tr>
          <tr>
            <td className="py-1 text-slate-600">Found on the bank statement</td>
            <td className="py-1 text-right font-semibold">{formatMoneyLong(result.matchedTotal, result.currency)}</td>
          </tr>
          <tr className="border-t border-slate-300">
            <td className="py-1 font-semibold text-slate-900">Not found</td>
            <td className="py-1 text-right font-bold">{formatMoneyLong(result.unmatchedTotal, result.currency)}</td>
          </tr>
        </tbody>
      </table>

      <h3 className="mb-1 text-sm font-semibold text-slate-900">Not found on the statement</h3>
      {result.unmatched.length === 0 ? (
        <p className="mb-6 text-[11px] text-slate-600">
          Nothing outstanding. Every {result.currency} receipt for {formatMonthLabel(month)} was found.
        </p>
      ) : (
        <table className="mb-6 w-full text-left text-[10px]">
          <thead>
            <tr className="border-b border-slate-300 font-mono uppercase text-slate-600">
              <th className="py-1">Date</th>
              <th className="py-1">Receipt</th>
              <th className="py-1">Payer</th>
              <th className="py-1">Villa</th>
              <th className="py-1">Method</th>
              <th className="py-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {result.unmatched.map(p => (
              <tr key={p.id} className="border-b border-slate-100">
                <td className="py-1">{formatDayLabel(p.date)}</td>
                <td className="py-1">{p.receiptNo}</td>
                <td className="py-1 font-sans">{p.payerName}</td>
                <td className="py-1">{unitLabel(p)}</td>
                <td className="py-1">{p.method}</td>
                <td className="py-1 text-right">{formatMoneyLong(p.amount, p.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="mb-1 text-sm font-semibold text-slate-900">Matched</h3>
      {result.matched.length === 0 ? (
        <p className="text-[11px] text-slate-600">Nothing has been matched for this month yet.</p>
      ) : (
        <table className="w-full text-left text-[10px]">
          <thead>
            <tr className="border-b border-slate-300 font-mono uppercase text-slate-600">
              <th className="py-1">Date</th>
              <th className="py-1">Receipt</th>
              <th className="py-1">Payer</th>
              <th className="py-1">Statement</th>
              <th className="py-1">Checked by</th>
              <th className="py-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {result.matched.map(p => (
              <tr key={p.id} className="border-b border-slate-100">
                <td className="py-1">{formatDayLabel(p.date)}</td>
                <td className="py-1">{p.receiptNo}</td>
                <td className="py-1 font-sans">{p.payerName}</td>
                <td className="py-1">{formatDayLabel(p.reconciledOn || '')}</td>
                <td className="py-1 font-sans">{p.reconciledBy}</td>
                <td className="py-1 text-right">{formatMoneyLong(p.amount, p.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <PrintSignatures left="Reconciled By" right="Approved By" leftName={generatedBy} />
    </>
  );
}
