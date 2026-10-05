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

import React, { useEffect, useMemo, useState } from 'react';
import {
  AppSettings,
  Booking,
  Charge,
  Currency,
  EXPENSE_CATEGORIES,
  Expense,
  Payment,
  SessionUser,
  Tenancy,
  Unit
} from '../types';
import {
  AgeingBuckets,
  arrearsAgeing,
  chargedInPeriod,
  collectedInPeriod,
  collectionRate,
  categoriesWithSpend,
  expenseBreakdown,
  expensesInPeriod,
  occupancySeries,
  ownerBilledUnitIds
} from '../lib/finance';
import { formatMoney, round2, sumMoney } from '../lib/money';
import { getReportRange, setReportRange } from '../lib/reportRange';
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
import { EmptyState, ErrorNote, Field, SecondaryButton, SubmitButton, TableScroller, monoInputClass, tableHeadRowClass } from './ui';
import BoardPack from './BoardPack';
import { BarChart3, FileText, Printer } from 'lucide-react';

interface ChartsProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  /** Dated occupancy records — `unit.status` carries no history. */
  tenancies: Tenancy[];
  bookings: Booking[];
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

export interface MonthRow {
  month: string;
  billed: number;
  received: number;
  paidOut: number;
  /**
   * Rent and maintenance received, which is the only money measured against what
   * was billed. `received` also carries bookings, utilities and sundries, so
   * rating it against `billed` would invent a collection rate the operating
   * statement disagrees with.
   */
  receivedAgainstBilled: number;
  /** Expense total per category for this month, for the stacked chart. */
  byCategory: Record<string, number>;
}

export default function Charts({ units, charges, payments, expenses, tenancies, bookings, settings, session }: ChartsProps) {
  // Adopt the period chosen on Operational Reports, if one was, so a pack built
  // from both screens covers one period rather than two.
  const shared = getReportRange();
  const sharedPreset = shared?.preset && PRESETS.some(p => p.key === shared.preset) ? (shared.preset as Preset) : null;

  const [preset, setPreset] = useState<Preset>(sharedPreset ?? (shared ? 'custom' : 'last6'));
  const [custom, setCustom] = useState(
    shared ? { from: shared.from, to: shared.to } : { from: monthStart(addMonths(currentMonth(), -5)), to: today() }
  );
  const [printing, setPrinting] = useState(false);
  const [boardPack, setBoardPack] = useState(false);

  const { from, to } = rangeForPreset(preset, custom);
  const invalidRange = to < from;

  // Publish it for the next screen. An invalid range is never published — the
  // other screen should not inherit a period this one is refusing to draw.
  useEffect(() => {
    if (!invalidRange) setReportRange({ from, to, preset });
  }, [from, to, preset, invalidRange]);

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
          /*
           * `!== 0`, not `> 0`. A category that nets to a supplier credit is
           * still a category, and reading it as "nothing happened" dropped it
           * from the chart while every total beside it still counted it.
           */
          if (row.amount !== 0) byCategory[row.category] = row.amount;
        }
        const collected = collectedInPeriod(payments, currency, mFrom, mTo, ownerBilled);
        return {
          month,
          billed: chargedInPeriod(charges, currency, mFrom, mTo).total,
          received: collected.total,
          receivedAgainstBilled: sumMoney([collected.rent, collected.maintenance]),
          paidOut: expensesInPeriod(expenses, currency, mFrom, mTo),
          byCategory
        };
      });

      const breakdown = categoriesWithSpend(expenseBreakdown(expenses, currency, from, to));
      const active = rows.some(r => r.billed || r.received || r.paidOut) || breakdown.length > 0;
      return { currency, rows, breakdown, active };
    });
  }, [months, charges, payments, expenses, from, to, ownerBilled, invalidRange]);

  const shown = byCurrency.filter(c => c.active);

  /**
   * Villas rented, per month. Currency-agnostic, so it sits above the per-currency
   * sections rather than being repeated identically inside each of them.
   */
  const occupancy = useMemo(
    () => (invalidRange ? [] : occupancySeries(units, tenancies, bookings, months, to)),
    [units, tenancies, bookings, months, to, invalidRange]
  );

  /** Debt outstanding at the end of the range, aged into the statutory buckets. */
  const ageing = useMemo(
    () => (invalidRange ? [] : arrearsAgeing(units, charges, payments, to)),
    [units, charges, payments, to, invalidRange]
  );

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
              Money in against money out, and where the spending goes, for any date range.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton type="button" onClick={() => setPrinting(true)} disabled={invalidRange || shown.length === 0}>
              <Printer className="h-4 w-4" /> Print charts
            </SecondaryButton>
            {/*
              The pack, not the pictures: one document carrying the covering
              figures and the charts that evidence them, for the same range.
            */}
            <SubmitButton type="button" onClick={() => setBoardPack(true)} disabled={invalidRange}>
              <FileText className="h-4 w-4" /> Print board pack
            </SubmitButton>
          </div>
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

      {!invalidRange && units.length > 0 && (
        <section className="space-y-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
          <h3 className="font-display text-sm font-semibold text-slate-900">Occupancy</h3>
          <OccupancyChart series={occupancy} />
        </section>
      )}

      {!invalidRange && ageing.length > 0 && (
        <section className="space-y-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
          <h3 className="font-display text-sm font-semibold text-slate-900">Arrears ageing at {formatDayLabel(to)}</h3>
          {ageing.map(entry => (
            <ArrearsAgeingChart key={entry.currency} buckets={entry.buckets} currency={entry.currency} />
          ))}
        </section>
      )}

      {!invalidRange && shown.length === 0 && (
        <EmptyState
          title="No financial activity in this range"
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
            <CollectionRateChart rows={entry.rows} currency={entry.currency} />
            <CategoryBarChart breakdown={entry.breakdown} currency={entry.currency} />
            <CategoryByMonthChart rows={entry.rows} currency={entry.currency} />
            <CategoryTable breakdown={entry.breakdown} currency={entry.currency} />
          </section>
        ))}

      {printing && (
        <ChartsDocument
          data={shown}
          occupancy={occupancy}
          ageing={ageing}
          from={from}
          to={to}
          settings={settings}
          generatedBy={session.name}
          onClose={() => setPrinting(false)}
        />
      )}

      {boardPack && (
        <BoardPack
          units={units}
          charges={charges}
          payments={payments}
          expenses={expenses}
          tenancies={tenancies}
          bookings={bookings}
          settings={settings}
          from={from}
          to={to}
          generatedBy={session.name}
          onClose={() => setBoardPack(false)}
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
export function CashFlowChart({ rows, currency }: { rows: MonthRow[]; currency: Currency }) {
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
                    <title>{`${formatMonthLabel(row.month)}, ${series.label}: ${formatMoney(value, currency)}`}</title>
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

      {/*
        Three bars share each month slot, so a printed value label on every bar
        would overlap its neighbours at any legible size. The figures are given
        underneath instead — which is also what a screen reader and a monochrome
        printout read, neither of which can use the hover tooltips above.
      */}
      <ChartDataTable
        head={['Month', 'Billed', 'Received', 'Paid out']}
        rows={rows.map(row => [
          formatMonthLabel(row.month),
          formatMoney(row.billed, currency),
          formatMoney(row.received, currency),
          formatMoney(row.paidOut, currency)
        ])}
        total={[
          'Total',
          formatMoney(sumMoney(rows.map(r => r.billed)), currency),
          formatMoney(sumMoney(rows.map(r => r.received)), currency),
          formatMoney(sumMoney(rows.map(r => r.paidOut)), currency)
        ]}
      />
    </ChartFrame>
  );
}

/**
 * The figures behind a chart, in text.
 *
 * Every SVG chart on this screen is paired with one of these. The charts carry
 * their values in `<title>` tooltips, which are unreachable on paper, by
 * keyboard, or to a screen reader — and the printed chart pack is the whole
 * reason this screen exists, so the numbers cannot live only in the picture.
 */
function ChartDataTable({
  head,
  rows,
  total
}: {
  head: string[];
  rows: (string | number)[][];
  total?: (string | number)[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-100 break-inside-avoid">
      <TableScroller>
        <table className="w-full min-w-[420px] border-collapse text-left text-[11px]">
          <thead>
            <tr className={tableHeadRowClass}>
              {head.map((label, i) => (
                <th key={label} scope="col" className={`p-2 ${i === 0 ? '' : 'text-right'}`}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map(row => (
              <tr key={String(row[0])}>
                {row.map((cell, i) => (
                  <td key={i} className={`p-2 ${i === 0 ? '' : 'text-right font-mono'}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {total && (
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                {total.map((cell, i) => (
                  <td key={i} className={`p-2 ${i === 0 ? '' : 'text-right font-mono'}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </TableScroller>
    </div>
  );
}

/**
 * Share of each month's billing that was actually collected.
 *
 * Rated on rent and maintenance only — the two categories that are billed — so
 * the line agrees with the collection rate on the operating statement. A month
 * can exceed 100% when arrears from earlier months are cleared in it, so the
 * axis is not capped at 100.
 */
export function CollectionRateChart({ rows, currency }: { rows: MonthRow[]; currency: Currency }) {
  const points = rows.map(row => ({
    month: row.month,
    rate: collectionRate(row.billed, row.receivedAgainstBilled)
  }));
  if (!points.some(p => p.rate !== null)) return null;

  const max = Math.max(100, ...points.map(p => p.rate ?? 0));
  const width = 760;
  const height = 200;
  const pad = { top: 14, right: 12, bottom: 30, left: 52 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const step = chartW / Math.max(points.length, 1);
  const barW = Math.max(6, Math.min(40, step - 16));

  return (
    <ChartFrame
      title="Collection rate by month"
      subtitle="Rent and maintenance received against what was billed that month. Above 100% means older arrears were cleared."
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${currency} collection rate for each month`}
        className="w-full rounded-xl border border-slate-100 bg-white"
      >
        {[0, 0.25, 0.5, 0.75, 1].map(p => {
          const y = pad.top + chartH * (1 - p);
          return (
            <g key={p}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={pad.left - 8} y={y + 3} textAnchor="end" fill="#94a3b8" fontSize="8" fontFamily="monospace">
                {round2(max * p)}%
              </text>
            </g>
          );
        })}

        {/* 100% reference — the line the bars are actually being read against. */}
        {max > 100 && (
          <line
            x1={pad.left}
            y1={pad.top + chartH * (1 - 100 / max)}
            x2={width - pad.right}
            y2={pad.top + chartH * (1 - 100 / max)}
            stroke="#0f766e"
            strokeWidth="1"
            strokeDasharray="4 3"
          />
        )}

        {points.map((point, index) => {
          const x = pad.left + index * step + (step - barW) / 2;
          if (point.rate === null) {
            return (
              <text
                key={point.month}
                x={x + barW / 2}
                y={height - pad.bottom - 4}
                textAnchor="middle"
                fill="#cbd5e1"
                fontSize="8"
                fontFamily="monospace"
              >
                n/a
              </text>
            );
          }
          const h = (point.rate / max) * chartH;
          return (
            <g key={point.month}>
              <rect
                x={x}
                y={height - pad.bottom - h}
                width={barW}
                height={Math.max(0, h)}
                fill={point.rate >= 100 ? '#1baf7a' : point.rate >= 80 ? '#eda100' : '#e34948'}
                rx="2"
              >
                <title>{`${formatMonthLabel(point.month)}, ${point.rate}% collected`}</title>
              </rect>
              <text
                x={x + barW / 2}
                y={height - pad.bottom - h - 4}
                textAnchor="middle"
                fill="#475569"
                fontSize="8"
                fontFamily="monospace"
              >
                {Math.round(point.rate)}%
              </text>
            </g>
          );
        })}

        <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="#94a3b8" strokeWidth="1" />
        {points.map((point, index) => (
          <text
            key={point.month}
            x={pad.left + index * step + step / 2}
            y={height - pad.bottom + 14}
            textAnchor="middle"
            fill="#64748b"
            fontSize="8"
            fontFamily="monospace"
          >
            {point.month.substring(2)}
          </text>
        ))}
      </svg>
    </ChartFrame>
  );
}

/** Villas let, month by month, as a share of the register. */
export function OccupancyChart({ series }: { series: { month: string; occupied: number; total: number; rate: number | null }[] }) {
  if (series.length === 0 || series.every(s => s.rate === null)) return null;

  const width = 760;
  const height = 200;
  const pad = { top: 14, right: 12, bottom: 30, left: 44 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const step = chartW / Math.max(series.length, 1);
  const barW = Math.max(6, Math.min(40, step - 16));

  return (
    <ChartFrame
      title="Rented villas by month"
      subtitle="Villas rented out, under tenancy, or with a guest in residence, on the last day of each month."
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Share of villas rented out at each month end"
        className="w-full rounded-xl border border-slate-100 bg-white"
      >
        {[0, 0.25, 0.5, 0.75, 1].map(p => {
          const y = pad.top + chartH * (1 - p);
          return (
            <g key={p}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={pad.left - 8} y={y + 3} textAnchor="end" fill="#94a3b8" fontSize="8" fontFamily="monospace">
                {Math.round(100 * p)}%
              </text>
            </g>
          );
        })}

        {series.map((row, index) => {
          const x = pad.left + index * step + (step - barW) / 2;
          const rate = row.rate ?? 0;
          const h = (rate / 100) * chartH;
          return (
            <g key={row.month}>
              <rect x={x} y={height - pad.bottom - h} width={barW} height={Math.max(0, h)} fill="#2a78d6" rx="2">
                <title>{`${formatMonthLabel(row.month)}, ${row.occupied} of ${row.total} villas (${rate}%)`}</title>
              </rect>
              <text
                x={x + barW / 2}
                y={height - pad.bottom - h - 4}
                textAnchor="middle"
                fill="#475569"
                fontSize="8"
                fontFamily="monospace"
              >
                {row.occupied}
              </text>
            </g>
          );
        })}

        <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="#94a3b8" strokeWidth="1" />
        {series.map((row, index) => (
          <text
            key={row.month}
            x={pad.left + index * step + step / 2}
            y={height - pad.bottom + 14}
            textAnchor="middle"
            fill="#64748b"
            fontSize="8"
            fontFamily="monospace"
          >
            {row.month.substring(2)}
          </text>
        ))}
      </svg>

      <ChartDataTable
        head={['Month', 'Rented', 'Villas', 'Occupancy']}
        rows={series.map(row => [
          formatMonthLabel(row.month),
          row.occupied,
          row.total,
          row.rate === null ? 'n/a' : `${row.rate}%`
        ])}
      />

      <p className="font-mono text-[9px] leading-relaxed text-slate-500">
        Counted from tenancy and booking records, which are the only dated occupancy evidence, a villa's register status
        records today only. An owner-occupied villa files neither a tenancy nor a booking, so it is not counted as let
        here. This counts villas rented out, not villas physically occupied, and the two differ by exactly the owner-occupied lots.
      </p>
    </ChartFrame>
  );
}

/**
 * Outstanding debt by how old it is.
 *
 * The buckets are Form 13B's own (30 / 60 / 90 / over 90) and come from the same
 * function the statutory return uses, so the chart and the filing agree by
 * construction rather than by review.
 */
export function ArrearsAgeingChart({ buckets, currency }: { buckets: AgeingBuckets; currency: Currency }) {
  if (buckets.total <= 0) return null;

  const bands = [
    { key: 'd30' as const, label: 'Up to 30 days', color: '#eda100' },
    { key: 'd60' as const, label: '31 – 60 days', color: '#eb6834' },
    { key: 'd90' as const, label: '61 – 90 days', color: '#e34948' },
    { key: 'over90' as const, label: 'Over 90 days', color: '#8c1d18' }
  ];

  return (
    <ChartFrame
      title={`Arrears ageing (${currency})`}
      subtitle={`${formatMoney(buckets.total, currency)} outstanding in total.`}
      legend={<Legend items={bands.map(b => ({ label: b.label, color: b.color }))} />}
    >
      <div className="flex h-7 w-full overflow-hidden rounded-lg border border-slate-200">
        {bands.map(band => {
          const value = buckets[band.key];
          if (value <= 0) return null;
          return (
            <div
              key={band.key}
              className="flex items-center justify-center"
              style={{ width: `${(value / buckets.total) * 100}%`, backgroundColor: band.color }}
              title={`${band.label}: ${formatMoney(value, currency)}`}
            >
              <span className="px-1 font-mono text-[9px] font-semibold text-white">
                {Math.round((value / buckets.total) * 100)}%
              </span>
            </div>
          );
        })}
      </div>

      <ChartDataTable
        head={['Age', 'Outstanding', 'Share']}
        rows={bands.map(band => [
          band.label,
          formatMoney(buckets[band.key], currency),
          `${round2((buckets[band.key] / buckets.total) * 100)}%`
        ])}
        total={['Total', formatMoney(buckets.total, currency), '100%']}
      />
    </ChartFrame>
  );
}

/** Where the money went, over the whole range. Values are labelled directly. */
export function CategoryBarChart({
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
export function CategoryByMonthChart({ rows, currency }: { rows: MonthRow[]; currency: Currency }) {
  /*
   * `!== 0`: a category whose month nets to a supplier credit still happened,
   * and reading it as absent dropped it from the chart while every total beside
   * it still counted it (2026-10-05).
   */
  const present = EXPENSE_CATEGORIES.filter(c => rows.some(r => (r.byCategory[c] || 0) !== 0));
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
                const segmentTop = cursor;
                return (
                  <g key={category}>
                    <rect x={x} y={segmentTop} width={barW} height={drawn} fill={categoryColor(category)} rx="2">
                      <title>{`${formatMonthLabel(row.month)}, ${category}: ${formatMoney(value, currency)}`}</title>
                    </rect>
                    {/*
                      Labelled in place only where the segment is actually tall and
                      wide enough to hold the text. A number spilling outside its own
                      band would attach itself to the neighbouring category and say
                      something false; the table below carries the rest.
                    */}
                    {drawn >= 14 && barW >= 26 && (
                      <text
                        x={x + barW / 2}
                        y={segmentTop + drawn / 2 + 3}
                        textAnchor="middle"
                        fill="#ffffff"
                        fontSize="8"
                        fontFamily="monospace"
                      >
                        {formatMoney(value, currency)}
                      </text>
                    )}
                  </g>
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

      {/*
        The per-month, per-category figures in text. Without this the only way to
        read a segment was to hover it, which rules out the printed pack, the
        keyboard and any screen reader — and the stacked segments are precisely
        where colour was carrying data on its own.
      */}
      <ChartDataTable
        head={['Month', ...present, 'Total']}
        rows={rows.map((row, index) => [
          formatMonthLabel(row.month),
          ...present.map(category => formatMoney(row.byCategory[category] || 0, currency)),
          formatMoney(totals[index], currency)
        ])}
        total={[
          'Total',
          ...present.map(category => formatMoney(sumMoney(rows.map(r => r.byCategory[category] || 0)), currency)),
          formatMoney(sumMoney(totals), currency)
        ]}
      />
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
export function CategoryTable({
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
                  {row.outstanding !== 0 ? formatMoney(row.outstanding, currency) : '-'}
                </td>
                <td className="p-3 text-right font-mono text-slate-500">{row.share}%</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-mono font-semibold">
              <td className="p-3">Total</td>
              <td className="p-3 text-right">{formatMoney(paid, currency)}</td>
              <td className="p-3 text-right">{outstanding !== 0 ? formatMoney(outstanding, currency) : '-'}</td>
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
  occupancy,
  ageing,
  from,
  to,
  settings,
  generatedBy,
  onClose
}: {
  data: { currency: Currency; rows: MonthRow[]; breakdown: { category: string; amount: number; outstanding: number; share: number }[] }[];
  occupancy: { month: string; occupied: number; total: number; rate: number | null }[];
  ageing: { currency: Currency; buckets: AgeingBuckets }[];
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
        meta={`Period ${formatDayLabel(from)} to ${formatDayLabel(to)}`}
        generatedBy={generatedBy}
      />

      {occupancy.length > 0 && (
        <section className="mb-8 space-y-5">
          <h3 className="border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">Occupancy</h3>
          <OccupancyChart series={occupancy} />
        </section>
      )}

      {ageing.length > 0 && (
        <section className="mb-8 space-y-5">
          <h3 className="border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
            Arrears ageing at {formatDayLabel(to)}
          </h3>
          {ageing.map(entry => (
            <ArrearsAgeingChart key={entry.currency} buckets={entry.buckets} currency={entry.currency} />
          ))}
        </section>
      )}

      {data.map(entry => (
        <section key={entry.currency} className="mb-8 space-y-5">
          <h3 className="border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
            {entry.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} ({entry.currency})
          </h3>
          <CashFlowChart rows={entry.rows} currency={entry.currency} />
          <CollectionRateChart rows={entry.rows} currency={entry.currency} />
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
