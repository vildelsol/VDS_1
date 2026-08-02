/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the managing agent owes each proprietor, and what each proprietor owes the
 * corporation.
 *
 * The Projections tab is written for the strata corporation: its income is the
 * maintenance (HOA) contributions proprietors pay, and rent and short-let booking
 * income are deliberately excluded because they are not the corporation's money.
 * This tab is the other side of that same rule. Rent and booking income belong to
 * the individual proprietor — the agent only collects it on their behalf — and the
 * costs of their villa are theirs. An owner statement is the one document that
 * puts those three facts on a single page:
 *
 *     collected on your behalf − maintenance billed − expenses on your villa = net
 *
 * Every figure comes from the same finance helpers the ledger, the reports and the
 * projection use, so the two tabs cannot contradict each other. USD and JMD are
 * stated separately and never combined: a villa let in USD with a JMD maintenance
 * fee produces two honest statements rather than one meaningless total.
 */

import React, { useMemo, useState } from 'react';
import { AppSettings, Charge, Currency, Expense, Payment, SessionUser, Unit, getUnitDisplayName } from '../types';
import { OwnerStatement, OwnerStatementGroup, groupStatementsByOwner, ownerStatements } from '../lib/finance';
import { formatMoney, formatMoneyLong, formatMoneyPlain } from '../lib/money';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import { openMailDraft } from '../lib/email';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  SecondaryButton,
  TableScroller,
  monoInputClass,
  tableHeadRowClass
} from './ui';
import { Download, Mail, Printer, Users } from 'lucide-react';

interface OwnerStatementsProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  settings: AppSettings;
  session: SessionUser;
}

/**
 * The period a statement covers.
 *
 * "Last month" is first and is the default. An owner statement is a thing that is
 * issued once a month, after the month has finished — offering the part-finished
 * current month first would produce a document that is wrong by the time it is
 * read, and it is the one people would click by accident.
 */
type Preset = 'lastMonth' | 'thisMonth' | 'last3' | 'last6' | 'ytd' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'lastMonth', label: 'Last month' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'last3', label: 'Last 3 months' },
  { key: 'last6', label: 'Last 6 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'custom', label: 'Custom range' }
];

function rangeForPreset(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const now = currentMonth();
  switch (preset) {
    case 'thisMonth':
      return { from: monthStart(now), to: monthEnd(now) };
    case 'last3':
      return { from: monthStart(addMonths(now, -2)), to: monthEnd(now) };
    case 'last6':
      return { from: monthStart(addMonths(now, -5)), to: monthEnd(now) };
    case 'ytd':
      return { from: `${now.substring(0, 4)}-01-01`, to: today() };
    case 'custom':
      return custom;
    default: {
      const m = addMonths(now, -1);
      return { from: monthStart(m), to: monthEnd(m) };
    }
  }
}

/** How a net position is worded. "Due to" and "due from" are not interchangeable. */
function netLabel(net: number): string {
  return net >= 0 ? 'Due to proprietor' : 'Due from proprietor';
}

export default function OwnerStatements({ units, charges, payments, expenses, settings, session }: OwnerStatementsProps) {
  const [preset, setPreset] = useState<Preset>('lastMonth');
  const [custom, setCustom] = useState({
    from: monthStart(addMonths(currentMonth(), -1)),
    to: monthEnd(addMonths(currentMonth(), -1))
  });
  const [printing, setPrinting] = useState<OwnerStatementGroup | null>(null);

  const { from, to } = rangeForPreset(preset, custom);
  const invalidRange = to < from;

  const groups = useMemo(
    () => (invalidRange ? [] : groupStatementsByOwner(ownerStatements(units, charges, payments, expenses, from, to))),
    [units, charges, payments, expenses, from, to, invalidRange]
  );

  const hasData = groups.length > 0;

  /**
   * Export every statement as a spreadsheet — one row per villa per currency, so
   * the office can file them, mail-merge them, or hand the lot to an accountant
   * without needing the application. CSV with a byte-order mark, which Excel
   * opens directly with the currency symbols intact.
   */
  const downloadSpreadsheet = () => {
    const rows: string[][] = [];
    rows.push(['VILLAGGIO DEL SOL — PROPRIETOR STATEMENTS']);
    rows.push(['Period', `${formatDayLabel(from)} to ${formatDayLabel(to)}`]);
    rows.push(['Generated', formatDayLabel(today()), 'by', session.name]);
    rows.push(['Note', 'Rent and booking income belong to the individual proprietor; the agent collects it on their behalf.']);
    rows.push(['Note', 'USD and JMD are stated separately and are never combined.']);
    rows.push([]);
    rows.push([
      'Proprietor',
      'Villa',
      'Currency',
      'Rent collected',
      'Bookings collected',
      'Utility recoveries',
      'Total collected',
      'Maintenance billed',
      'Maintenance paid in period',
      'Villa expenses',
      'Net',
      'Net position',
      'Maintenance outstanding at period end'
    ]);

    for (const group of groups) {
      for (const s of group.statements) {
        rows.push([
          group.owner || '(owner not recorded)',
          getUnitDisplayName(s.unit.number),
          s.currency,
          formatMoneyPlain(s.rentCollected),
          formatMoneyPlain(s.bookingCollected),
          formatMoneyPlain(s.utilityCollected),
          formatMoneyPlain(s.collected),
          formatMoneyPlain(s.maintenanceBilled),
          formatMoneyPlain(s.maintenancePaid),
          formatMoneyPlain(s.expenses),
          formatMoneyPlain(s.net),
          netLabel(s.net),
          formatMoneyPlain(s.maintenanceOutstanding)
        ]);
      }
    }

    const csv = rows.map(r => r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `VDS_owner_statements_${from}_to_${to}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-medium text-slate-900">
              <Users className="h-4 w-4 text-teal-600" />
              Proprietor statements
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              What was collected for each owner, what they were billed, and the net position — one statement per villa,
              per currency.
            </p>
          </div>
          <SecondaryButton onClick={downloadSpreadsheet} disabled={!hasData} className="flex items-center gap-1.5 self-start">
            <Download className="h-4 w-4" /> Export for Excel
          </SecondaryButton>
        </div>

        <Field label="Statement period" htmlFor="os-preset">
          <div className="flex flex-wrap gap-2" id="os-preset">
            {PRESETS.map(p => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                aria-pressed={preset === p.key}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                  preset === p.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>

        {preset === 'custom' && (
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
            <Field label="From" htmlFor="os-from">
              <input
                id="os-from"
                type="date"
                value={custom.from}
                onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
                className={monoInputClass}
              />
            </Field>
            <Field label="To" htmlFor="os-to">
              <input
                id="os-to"
                type="date"
                value={custom.to}
                onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
                className={monoInputClass}
              />
            </Field>
            <p className="pb-2 font-mono text-[11px] text-slate-500">
              {invalidRange ? 'Invalid range' : `${formatDayLabel(from)} → ${formatDayLabel(to)}`}
            </p>
          </div>
        )}

        {invalidRange && <ErrorNote>The end date must fall on or after the start date.</ErrorNote>}

        <InfoNote>
          Rent and short-term booking income belong to the individual proprietor and are collected on their behalf;
          maintenance (HOA) contributions are the corporation's income. Maintenance is deducted as <strong>billed</strong>
          {' '}for the period, whether or not it has been paid. Expenses are those charged to that villa — common property
          and office costs are the corporation's and never appear here. USD and JMD are stated separately and never
          combined.
        </InfoNote>
      </section>

      {!hasData ? (
        <EmptyState
          title={invalidRange ? 'No statements for an invalid range' : 'Nothing to state for this period'}
          hint="Statements appear once money has been collected against a villa, maintenance has been billed, or an expense has been charged to it."
        />
      ) : (
        <>
          <div className="space-y-6">
            {groups.map(group => (
              <OwnerCard
                key={group.owner || '(unrecorded)'}
                group={group}
                from={from}
                to={to}
                onPrint={() => setPrinting(group)}
              />
            ))}
          </div>

          <p className="px-1 font-mono text-[10px] leading-relaxed text-slate-400">
            {groups.length} proprietor{groups.length === 1 ? '' : 's'} ·{' '}
            {groups.reduce((n, g) => n + g.statements.length, 0)} statement
            {groups.reduce((n, g) => n + g.statements.length, 0) === 1 ? '' : 's'} · period{' '}
            {formatDayLabel(from)} to {formatDayLabel(to)}
          </p>
        </>
      )}

      {printing && (
        <OwnerStatementDocument
          group={printing}
          from={from}
          to={to}
          settings={settings}
          generatedBy={session.name}
          onClose={() => setPrinting(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OwnerCard({
  group,
  from,
  to,
  onPrint
}: {
  group: OwnerStatementGroup;
  from: string;
  to: string;
  onPrint: () => void;
}) {
  const villas = new Set(group.statements.map(s => s.unit.id));
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
      <div className="flex flex-col justify-between gap-3 border-b border-slate-100 bg-slate-50 p-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h3 className="truncate font-display text-sm font-semibold text-slate-900">
            {group.owner || 'Owner not recorded'}
          </h3>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-500">
            {villas.size} villa{villas.size === 1 ? '' : 's'} · {formatDayLabel(from)} to {formatDayLabel(to)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {group.netByCurrency.map(row => (
            <Badge key={row.currency} tone={row.net < 0 ? 'red' : 'green'}>
              {netLabel(row.net)} {formatMoney(Math.abs(row.net), row.currency)}
            </Badge>
          ))}
          <SecondaryButton onClick={onPrint} className="flex items-center gap-1.5 bg-white">
            <Printer className="h-3.5 w-3.5" /> Statement
          </SecondaryButton>
        </div>
      </div>

      <TableScroller>
        <table className="w-full min-w-[820px] border-collapse text-left text-xs">
          <thead>
            <tr className={tableHeadRowClass}>
              <th scope="col" className="p-4">Villa</th>
              <th scope="col" className="p-4">Currency</th>
              <th scope="col" className="p-4 text-right">Collected</th>
              <th scope="col" className="p-4 text-right">Maintenance billed</th>
              <th scope="col" className="p-4 text-right">Villa expenses</th>
              <th scope="col" className="p-4 text-right">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {group.statements.map(s => (
              <tr key={`${s.unit.id}-${s.currency}`} className="align-top hover:bg-slate-50/50">
                <td className="p-4 font-medium text-slate-900">{getUnitDisplayName(s.unit.number)}</td>
                <td className="p-4 font-mono text-slate-500">{s.currency}</td>
                <td className="p-4 text-right">
                  <span className="font-mono text-emerald-600">{formatMoney(s.collected, s.currency)}</span>
                  <span className="mt-0.5 block font-mono text-[10px] leading-relaxed text-slate-400">
                    Rent {formatMoney(s.rentCollected, s.currency)} · Bookings {formatMoney(s.bookingCollected, s.currency)}
                    {s.utilityCollected !== 0 && <> · Utilities {formatMoney(s.utilityCollected, s.currency)}</>}
                  </span>
                </td>
                <td className="p-4 text-right">
                  <span className="font-mono text-rose-500">{formatMoney(s.maintenanceBilled, s.currency)}</span>
                  {/* An owner who paid their own maintenance and had it withheld from
                      their rent as well has been charged twice. Nothing else on the
                      page would show it, so it is said here in as many words. */}
                  {s.maintenancePaid > 0 && s.maintenanceBilled > 0 && (
                    <span className="mt-0.5 block font-mono text-[10px] leading-relaxed text-amber-700">
                      {formatMoney(s.maintenancePaid, s.currency)} already received in the period
                    </span>
                  )}
                  {s.maintenanceOutstanding > 0 && (
                    <span className="mt-0.5 block font-mono text-[10px] leading-relaxed text-slate-400">
                      {formatMoney(s.maintenanceOutstanding, s.currency)} outstanding at period end
                    </span>
                  )}
                </td>
                <td className="p-4 text-right font-mono text-rose-500">{formatMoney(s.expenses, s.currency)}</td>
                <td
                  className={`p-4 text-right font-mono font-semibold ${s.net < 0 ? 'text-red-600' : 'text-emerald-700'}`}
                >
                  {formatMoney(s.net, s.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
    </section>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The document an owner is actually sent: every villa they hold, every figure
 * itemised down to the individual receipt and invoice, and the net position at the
 * end. It is itemised because an owner statement is queried line by line — "what
 * is this expense?" — and a document that can only answer with a total is not one
 * an owner will accept.
 */
function OwnerStatementDocument({
  group,
  from,
  to,
  settings,
  generatedBy,
  onClose
}: {
  group: OwnerStatementGroup;
  from: string;
  to: string;
  settings: AppSettings;
  generatedBy: string;
  onClose: () => void;
}) {
  const ownerEmail = group.statements.map(s => s.unit.ownerEmail).find(Boolean) || '';
  const period = `${formatDayLabel(from)} to ${formatDayLabel(to)}`;

  const emailDraft = () => {
    const body = [
      `Dear ${group.owner || 'Sir/Madam'},`,
      '',
      `Please find your proprietor statement for ${period} summarised below.`,
      '',
      ...group.statements.flatMap(s => [
        `${getUnitDisplayName(s.unit.number)} (${s.currency})`,
        `  Collected on your behalf : ${formatMoneyLong(s.collected, s.currency)}`,
        `  Maintenance billed       : ${formatMoneyLong(s.maintenanceBilled, s.currency)}`,
        `  Expenses on your villa   : ${formatMoneyLong(s.expenses, s.currency)}`,
        `  ${netLabel(s.net)}       : ${formatMoneyLong(Math.abs(s.net), s.currency)}`,
        ''
      ]),
      'A full itemised statement is attached or available on request.',
      '',
      'Villaggio Del Sol Management'
    ].join('\n');
    openMailDraft({ to: ownerEmail, subject: `Proprietor statement — ${period}`, body });
  };

  return (
    <PrintPortal
      title={`Proprietor statement — ${group.owner || 'Owner not recorded'}`}
      subtitle={period}
      onClose={onClose}
      maxWidthClass="max-w-4xl"
      actions={
        <button
          type="button"
          onClick={emailDraft}
          disabled={!ownerEmail}
          title={ownerEmail ? `Draft an email to ${ownerEmail}` : 'No email address on file for this owner'}
          className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50 disabled:opacity-50"
        >
          <Mail className="h-3.5 w-3.5" />
          Email
        </button>
      }
    >
      <PrintLetterhead documentTitle="Proprietor Statement" meta={period} generatedBy={generatedBy} />

      <section className="mb-5 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
        {[
          ['Registered proprietor', group.owner || '—'],
          ['Villas', String(new Set(group.statements.map(s => s.unit.id)).size)],
          ['Period', period],
          ['Net position', group.netByCurrency.map(r => formatMoneyLong(r.net, r.currency)).join(' · ') || '—']
        ].map(([label, value]) => (
          <div key={label}>
            <span className="block font-mono text-[9px] uppercase text-slate-500">{label}</span>
            <span className="font-semibold text-slate-900">{value}</span>
          </div>
        ))}
      </section>

      {group.statements.map(s => (
        <StatementSection key={`${s.unit.id}-${s.currency}`} statement={s} />
      ))}

      <section className="mb-5 break-inside-avoid">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">Basis</h3>
        <ul className="list-disc space-y-1 pl-5 text-[11px] leading-relaxed">
          <li>
            Rent and short-term booking income belong to you as proprietor and are collected on your behalf by the
            managing agent. Maintenance (HOA) contributions are the income of the Strata Corporation.
          </li>
          <li>
            Maintenance is deducted as <strong>billed</strong> for the period, whether or not it has been paid. Where a
            contribution has already been received in the period it is stated beneath the deduction, so the same money is
            not accounted for twice.
          </li>
          <li>
            Expenses are those charged to your villa and paid in the period. Common property and office costs are the
            corporation's and do not appear here.
          </li>
          <li>
            Only payments confirmed as received are included; money expected but not yet received counts for nothing.
            USD and JMD are stated separately and never combined.
          </li>
        </ul>
      </section>

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        This statement is prepared from the property's records for the period stated and is not a tax document.
        Indicative rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD, shown for reference only; no figure on this
        statement has been converted.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Received / Acknowledged by" rightName={group.owner} />
    </PrintPortal>
  );
}

/** One villa, one currency: the itemised working behind the net figure. */
function StatementSection({ statement: s }: { statement: OwnerStatement }) {
  const c = s.currency;
  return (
    <section className="mb-6 break-inside-avoid">
      <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
        {getUnitDisplayName(s.unit.number)} — {c}
      </h3>

      <TableScroller>
        <table className="w-full text-left text-[10px]">
          <tbody className="font-mono">
            <LineGroup
              title="Collected on your behalf"
              rows={s.collectedItems.map(p => ({
                date: p.date,
                detail: `${p.category} — ${p.payerName || 'received'} (${p.method})`,
                ref: p.receiptNo,
                amount: p.amount
              }))}
              total={s.collected}
              currency={c}
              tone="credit"
              emptyLabel="Nothing collected in the period."
            />
            <LineGroup
              title="Less: maintenance billed"
              rows={s.maintenanceCharges.map(charge => ({
                date: charge.dueDate,
                detail: charge.description || `Maintenance — ${formatMonthLabel(charge.periodMonth)}`,
                ref: '',
                amount: charge.amount
              }))}
              total={s.maintenanceBilled}
              currency={c}
              tone="debit"
              emptyLabel="No maintenance billed in the period."
              note={
                s.maintenancePaid > 0 && s.maintenanceBilled > 0
                  ? `${formatMoney(s.maintenancePaid, c)} of maintenance was received in this period. If you paid this directly, it is not also to be withheld from the amount above.`
                  : undefined
              }
            />
            <LineGroup
              title="Less: expenses on your villa"
              rows={s.expenseItems.map(e => ({
                date: e.datePaid || e.date,
                detail: `${e.category}${e.vendor ? ` — ${e.vendor}` : ''}${e.description ? ` — ${e.description}` : ''}`,
                ref: e.reference,
                amount: e.amount
              }))}
              total={s.expenses}
              currency={c}
              tone="debit"
              emptyLabel="No expenses charged to this villa in the period."
            />
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-400 font-mono font-bold">
              <td className="p-2" colSpan={3}>
                {netLabel(s.net)}
              </td>
              <td className="p-2 text-right">{formatMoney(Math.abs(s.net), c)}</td>
            </tr>
          </tfoot>
        </table>
      </TableScroller>

      {s.maintenanceOutstanding > 0 && (
        <p className="mt-2 rounded-lg border border-slate-300 p-2 text-[10px] leading-relaxed">
          <strong>{formatMoneyLong(s.maintenanceOutstanding, c)}</strong> in maintenance contributions remains
          outstanding on this villa as at {formatDayLabel(s.to)}, across all periods. This is a separate debt to the
          Strata Corporation and is not included in the net figure above.
        </p>
      )}
    </section>
  );
}

function LineGroup({
  title,
  rows,
  total,
  currency,
  tone,
  emptyLabel,
  note
}: {
  title: string;
  rows: { date: string; detail: string; ref: string; amount: number }[];
  total: number;
  currency: Currency;
  tone: 'credit' | 'debit';
  emptyLabel: string;
  note?: string;
}) {
  return (
    <>
      <tr>
        <td colSpan={4} className="pt-3 pb-1 font-sans text-[10px] font-bold uppercase tracking-wide text-slate-700">
          {title}
        </td>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={4} className="p-2 font-sans text-[10px] italic text-slate-500">
            {emptyLabel}
          </td>
        </tr>
      ) : (
        rows.map((row, i) => (
          <tr key={i}>
            <td className="whitespace-nowrap p-2">{formatDayLabel(row.date)}</td>
            <td className="p-2 font-sans">{row.detail}</td>
            <td className="p-2">{row.ref || '—'}</td>
            <td className={`p-2 text-right ${tone === 'credit' ? 'text-emerald-700' : ''}`}>
              {formatMoney(row.amount, currency)}
            </td>
          </tr>
        ))
      )}
      <tr className="border-t border-slate-300 font-semibold">
        <td className="p-2 font-sans" colSpan={3}>
          {tone === 'credit' ? 'Total collected' : `Total ${title.replace('Less: ', '')}`}
        </td>
        <td className="p-2 text-right">{formatMoney(total, currency)}</td>
      </tr>
      {note && (
        <tr>
          <td colSpan={4} className="p-2 font-sans text-[10px] leading-relaxed text-slate-600">
            {note}
          </td>
        </tr>
      )}
    </>
  );
}
