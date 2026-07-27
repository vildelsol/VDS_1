/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Visual snapshots.
 *
 * Operational Reports answers "what are the exact figures"; this answers "what
 * does the year look like". It exists as its own screen because the two are read
 * at different moments — a committee meeting wants the shape of the money at a
 * glance, not a five-section reconciliation — and because a chart pack is a
 * different printed document from an operating statement.
 *
 * Every figure is drawn from the same finance helpers as the ledger and the
 * reports, so the pictures and the statements can never disagree. USD and JMD are
 * charted separately and never combined.
 */

import React, { useMemo, useState } from 'react';
import {
  AppSettings,
  Charge,
  Currency,
  EXPENSE_CATEGORIES,
  Expense,
  Payment,
  SessionUser,
  Unit
} from '../types';
import { chargedInPeriod, collectedInPeriod, expenseBreakdown, expensesInPeriod, ownerBilledUnitIds } from '../lib/finance';
import { formatMoney, round2, sumMoney } from '../lib/money';
import {
  addMonths,
  currentMonth,
  formatDayLabel,
  formatMonthLabel,
  monthEnd,
  monthStart,
  monthsBetween,
  today
} from '../lib/dates';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import { EmptyState, ErrorNote, Field, SubmitButton, TableScroller, monoInputClass, tableHeadRowClass } from './ui';
import { BarChart3, Printer } from 'lucide-react';

interface ChartsProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  settings: AppSettings;
  session: SessionUser;
}

/**
 * Categorical colours, assigned to a category by identity and never by rank, so
 * a filter or a change in size never repaints a category. Validated as a set for
 * colour-vision deficiency and against a white chart surface; three of them sit
 * below 3:1 contrast on white, which is why every chart here also carries direct
 * value labels and a table view rather than relying on the fill alone.
 */
const CATEGORY_COLORS: Record<string, string> = {
  Maintenance: '#2a78d6',
  Security: '#eb6834',
  Landscaping: '#1baf7a',
  Utilities: '#eda100',
  Payroll: '#e87ba4',
  'Property Taxes': '#008300',
  Supplies: '#4a3aa7',
  Contractors: '#e34948',
  Other: '#8a8a83'
};

const categoryColor = (category: string) => CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;

/** The three cash series. Validated together on an all-pairs basis. */
const CASH_SERIES = [
  { key: 'billed', label: 'Billed', color: '#2a78d6' },
  { key: 'received', label: 'Received', color: '#1baf7a' },
  { key: 'paidOut', label: 'Paid out', color: '#eb6834' }
] as const;

type Preset = 'last3' | 'last6' | 'last12' | 'ytd' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'last3', label: 'Last 3 months' },
  { key: 'last6', label: 'Last 6 months' },
  { key: 'last12', label: 'Last 12 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'custom', label: 'Custom range' }
];

function rangeForPreset(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const now = currentMonth();
  switch (preset) {
    case 'last3':
      return { from: monthStart(addMonths(now, -2)), to: monthEnd(now) };
    case 'last6':
      return { from: monthStart(addMonths(now, -5)), to: monthEnd(now) };
    case 'last12':
      return { from: monthStart(addMonths(now, -11)), to: monthEnd(now) };
    case 'ytd':
      return { from: `${now.substring(0, 4)}-01-01`, to: today() };
    default:
      return custom;
  }
}

interface MonthRow {
  month: string;
  billed: number;
  received: number;
  paidOut: number;
  /** Expense total per category for this month, for the stacked chart. */
  byCategory: Record<string, number>;
}

export default function Charts({ units, charges, payments, expenses, settings, session }: ChartsProps) {
  const [preset, setPreset] = useState<Preset>('last6');
  const [custom, setCustom] = useState({ from: monthStart(addMonths(currentMonth(), -5)), to: today() });
  const [printing, setPrinting] = useState(false);

  const { from, to } = rangeForPreset(preset, custom);
  const invalidRange = to < from;

  const ownerBilled = useMemo(() => ownerBilledUnitIds(units), [units]);
  const months = useMemo(() => (invalidRange ? [] : monthsBetween(from, to)), [from, to, invalidRange]);

  /** Monthly series and category breakdown, per currency. */
  const byCurrency = useMemo(() => {
    if (invalidRange) return [];
    return (['JMD', 'USD'] as Currency[]).map(currency => {
      const rows: MonthRow[] = months.map(month => {
        const mFrom = monthStart(month) < from ? from : monthStart(month);
        const mTo = monthEnd(month) > to ? to : monthEnd(month);
        const byCategory: Record<string, number> = {};
        for (const row of expenseBreakdown(expenses, currency, mFrom, mTo)) {
          if (row.amount > 0) byCategory[row.category] = row.amount;
        }
        return {
          month,
          billed: chargedInPeriod(charges, currency, mFrom, mTo).total,
          received: collectedInPeriod(payments, currency, mFrom, mTo, ownerBilled).total,
          paidOut: expensesInPeriod(expenses, currency, mFrom, mTo),
          byCategory
        };
      });

      const breakdown = expenseBreakdown(expenses, currency, from, to).filter(row => row.amount > 0);
      const active = rows.some(r => r.billed || r.received || r.paidOut) || breakdown.length > 0;
      return { currency, rows, breakdown, active };
    });
  }, [months, charges, payments, expenses, from, to, ownerBilled, invalidRange]);

  const shown = byCurrency.filter(c => c.active);

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-medium text-slate-900">
              <BarChart3 className="h-4 w-4 text-teal-600" />
              Visual snapshot
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Money in against money out, and where the spending goes — for any date range.
            </p>
          </div>
          <SubmitButton type="button" onClick={() => setPrinting(true)} disabled={invalidRange || shown.length === 0}>
            <Printer className="h-4 w-4" /> Print charts
          </SubmitButton>
        </div>

        <div className="flex flex-wrap gap-2">
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

        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <Field label="From" htmlFor="ch-from">
            <input
              id="ch-from"
              type="date"
              value={from}
              onChange={e => {
                setPreset('custom');
                setCustom(c => ({ ...c, from: e.target.value }));
              }}
              className={monoInputClass}
            />
          </Field>
          <Field label="To" htmlFor="ch-to">
            <input
              id="ch-to"
              type="date"
              value={to}
              onChange={e => {
                setPreset('custom');
                setCustom(c => ({ ...c, to: e.target.value }));
              }}
              className={monoInputClass}
            />
          </Field>
          <p className="pb-2 font-mono text-[11px] text-slate-500">
            {invalidRange
              ? 'Invalid range'
              : `${formatDayLabel(from)} → ${formatDayLabel(to)} (${months.length} month${months.length === 1 ? '' : 's'})`}
          </p>
        </div>

        {invalidRange && <ErrorNote>The end date must fall on or after the start date.</ErrorNote>}
      </section>

      {!invalidRange && shown.length === 0 && (
        <EmptyState
          title="No activity in this range"
          hint="Widen the date range, or post charges and record payments to build up a picture."
        />
      )}

      {!invalidRange &&
        shown.map(entry => (
          <section key={entry.currency} className="space-y-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
            <h3 className="font-display text-sm font-semibold text-slate-900">
              {entry.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} ({entry.currency})
            </h3>

            <CashFlowChart rows={entry.rows} currency={entry.currency} />
            <CategoryBarChart breakdown={entry.breakdown} currency={entry.currency} />
            <CategoryByMonthChart rows={entry.rows} currency={entry.currency} />
            <CategoryTable breakdown={entry.breakdown} currency={entry.currency} />
          </section>
        ))}

      {printing && (
        <ChartsDocument
          data={shown}
          from={from}
          to={to}
          settings={settings}
          generatedBy={session.name}
          onClose={() => setPrinting(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Shared legend. Identity is never carried by colour alone. */
function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1.5 text-[10px] text-slate-600">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function ChartFrame({
  title,
  subtitle,
  legend,
  children
}: {
  title: string;
  subtitle?: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 break-inside-avoid">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h4 className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-600">{title}</h4>
          {subtitle && <p className="text-[10px] text-slate-500">{subtitle}</p>}
        </div>
        {legend}
      </div>
      {children}
    </div>
  );
}

/** Money billed, money received and money paid out, month by month. */
function CashFlowChart({ rows, currency }: { rows: MonthRow[]; currency: Currency }) {
  const max = Math.max(...rows.flatMap(r => [r.billed, r.received, r.paidOut]), 1);
  if (max <= 1) return null;

  const width = 760;
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 30, left: 70 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const step = chartW / Math.max(rows.length, 1);
  // Three bars plus a 2px surface gap between each, inside a slot with breathing room.
  const barW = Math.max(3, Math.min(20, (step - 12) / 3 - 2));

  return (
    <ChartFrame
      title="Monthly cash movement"
      subtitle="Billed is what was raised; received is money actually in."
      legend={<Legend items={CASH_SERIES.map(s => ({ label: s.label, color: s.color }))} />}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${currency} billed, received and paid out for each month`}
        className="w-full rounded-xl border border-slate-100 bg-white"
      >
        {[0, 0.25, 0.5, 0.75, 1].map(p => {
          const y = pad.top + chartH * (1 - p);
          return (
            <g key={p}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={pad.left - 8} y={y + 3} textAnchor="end" fill="#94a3b8" fontSize="8" fontFamily="monospace">
                {formatMoney(round2(max * p), currency)}
              </text>
            </g>
          );
        })}
        <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="#94a3b8" strokeWidth="1" />

        {rows.map((row, index) => {
          const groupX = pad.left + index * step + (step - (barW * 3 + 4)) / 2;
          return (
            <g key={row.month}>
              {CASH_SERIES.map((series, i) => {
                const value = row[series.key];
                const h = (value / max) * chartH;
                return (
                  <rect
                    key={series.key}
                    x={groupX + i * (barW + 2)}
                    y={height - pad.bottom - h}
                    width={barW}
                    height={Math.max(0, h)}
                    fill={series.color}
                    rx="2"
                  >
                    <title>{`${formatMonthLabel(row.month)} — ${series.label}: ${formatMoney(value, currency)}`}</title>
                  </rect>
                );
              })}
              <text
                x={groupX + (barW * 3 + 4) / 2}
                y={height - pad.bottom + 14}
                textAnchor="middle"
                fill="#64748b"
                fontSize="8"
                fontFamily="monospace"
              >
                {row.month.substring(2)}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

/** Where the money went, over the whole range. Values are labelled directly. */
function CategoryBarChart({
  breakdown,
  currency
}: {
  breakdown: { category: string; amount: number; share: number }[];
  currency: Currency;
}) {
  if (breakdown.length === 0) return null;
  const max = Math.max(...breakdown.map(b => b.amount), 1);

  return (
    <ChartFrame title="Expenses by category" subtitle={`Total ${formatMoney(sumMoney(breakdown.map(b => b.amount)), currency)} over the range.`}>
      <ul className="space-y-2">
        {breakdown.map(row => (
          <li key={row.category} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-[11px]">
              <span className="flex items-center gap-1.5 text-slate-700">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: categoryColor(row.category) }} />
                {row.category}
              </span>
              <span className="font-mono text-slate-900">
                {formatMoney(row.amount, currency)}
                <span className="ml-1 text-slate-400">({row.share}%)</span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(1, (row.amount / max) * 100)}%`, backgroundColor: categoryColor(row.category) }}
              />
            </div>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

/** The same spending, split month by month, so a spike is attributable. */
function CategoryByMonthChart({ rows, currency }: { rows: MonthRow[]; currency: Currency }) {
  const present = EXPENSE_CATEGORIES.filter(c => rows.some(r => (r.byCategory[c] || 0) > 0));
  const totals = rows.map(r => sumMoney(present.map(c => r.byCategory[c] || 0)));
  const max = Math.max(...totals, 1);
  if (present.length === 0 || max <= 1) return null;

  const width = 760;
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 30, left: 70 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const step = chartW / Math.max(rows.length, 1);
  const barW = Math.max(6, Math.min(38, step - 14));

  return (
    <ChartFrame
      title="Expenses by category, month by month"
      subtitle="Each column is one month's spending, split by what it was spent on."
      legend={<Legend items={present.map(c => ({ label: c, color: categoryColor(c) }))} />}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${currency} expenses for each month, split by category`}
        className="w-full rounded-xl border border-slate-100 bg-white"
      >
        {[0, 0.25, 0.5, 0.75, 1].map(p => {
          const y = pad.top + chartH * (1 - p);
          return (
            <g key={p}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={pad.left - 8} y={y + 3} textAnchor="end" fill="#94a3b8" fontSize="8" fontFamily="monospace">
                {formatMoney(round2(max * p), currency)}
              </text>
            </g>
          );
        })}
        <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="#94a3b8" strokeWidth="1" />

        {rows.map((row, index) => {
          const x = pad.left + index * step + (step - barW) / 2;
          let cursor = height - pad.bottom;
          return (
            <g key={row.month}>
              {present.map(category => {
                const value = row.byCategory[category] || 0;
                if (value <= 0) return null;
                const h = (value / max) * chartH;
                // A 2px surface gap keeps neighbouring segments legible as separate
                // blocks rather than one continuous band of colour.
                const drawn = Math.max(0, h - 2);
                cursor -= h;
                return (
                  <rect key={category} x={x} y={cursor} width={barW} height={drawn} fill={categoryColor(category)} rx="2">
                    <title>{`${formatMonthLabel(row.month)} — ${category}: ${formatMoney(value, currency)}`}</title>
                  </rect>
                );
              })}
              <text
                x={x + barW / 2}
                y={height - pad.bottom + 14}
                textAnchor="middle"
                fill="#64748b"
                fontSize="8"
                fontFamily="monospace"
              >
                {row.month.substring(2)}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

/**
 * The same numbers as a table.
 *
 * Three of the category colours sit below 3:1 against a white surface, so the
 * charts above are never the only way to read this: the figures are also here in
 * text, which is what someone using a screen reader, a monochrome printout or a
 * colour-vision deficiency reads instead.
 */
function CategoryTable({
  breakdown,
  currency
}: {
  breakdown: { category: string; amount: number; outstanding: number; share: number }[];
  currency: Currency;
}) {
  if (breakdown.length === 0) return null;
  const paid = sumMoney(breakdown.map(b => b.amount));
  const outstanding = sumMoney(breakdown.map(b => b.outstanding));

  return (
    <div className="overflow-hidden rounded-xl border border-slate-100 break-inside-avoid">
      <TableScroller>
        <table className="w-full min-w-[420px] border-collapse text-left text-xs">
          <thead>
            <tr className={tableHeadRowClass}>
              <th scope="col" className="p-3">Category</th>
              <th scope="col" className="p-3 text-right">Paid</th>
              <th scope="col" className="p-3 text-right">Outstanding</th>
              <th scope="col" className="p-3 text-right">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {breakdown.map(row => (
              <tr key={row.category}>
                <td className="p-3">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: categoryColor(row.category) }} />
                    {row.category}
                  </span>
                </td>
                <td className="p-3 text-right font-mono">{formatMoney(row.amount, currency)}</td>
                <td className="p-3 text-right font-mono text-amber-700">
                  {row.outstanding > 0 ? formatMoney(row.outstanding, currency) : '—'}
                </td>
                <td className="p-3 text-right font-mono text-slate-500">{row.share}%</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-mono font-semibold">
              <td className="p-3">Total</td>
              <td className="p-3 text-right">{formatMoney(paid, currency)}</td>
              <td className="p-3 text-right">{outstanding > 0 ? formatMoney(outstanding, currency) : '—'}</td>
              <td className="p-3 text-right">100%</td>
            </tr>
          </tfoot>
        </table>
      </TableScroller>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ChartsDocument({
  data,
  from,
  to,
  settings,
  generatedBy,
  onClose
}: {
  data: { currency: Currency; rows: MonthRow[]; breakdown: { category: string; amount: number; outstanding: number; share: number }[] }[];
  from: string;
  to: string;
  settings: AppSettings;
  generatedBy: string;
  onClose: () => void;
}) {
  return (
    <PrintPortal
      title="Charts"
      subtitle={`${formatDayLabel(from)} to ${formatDayLabel(to)}`}
      onClose={onClose}
      maxWidthClass="max-w-4xl"
    >
      <PrintLetterhead
        documentTitle="Visual Snapshot"
        meta={`Period ${formatDayLabel(from)} — ${formatDayLabel(to)}`}
        generatedBy={generatedBy}
      />

      {data.map(entry => (
        <section key={entry.currency} className="mb-8 space-y-5">
          <h3 className="border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
            {entry.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} ({entry.currency})
          </h3>
          <CashFlowChart rows={entry.rows} currency={entry.currency} />
          <CategoryBarChart breakdown={entry.breakdown} currency={entry.currency} />
          <CategoryByMonthChart rows={entry.rows} currency={entry.currency} />
          <CategoryTable breakdown={entry.breakdown} currency={entry.currency} />
        </section>
      ))}

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        USD and JMD are charted separately and are never combined. Utility recoveries billed directly to owners of
        owner-occupied and short-let villas are excluded from received income, matching the operating statement.
        Indicative rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD, for display only.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Reviewed / Approved by" />
    </PrintPortal>
  );
}
