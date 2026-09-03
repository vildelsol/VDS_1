/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forward-looking cash projection for the strata corporation (body corporate).
 *
 * The Reports tab states what has happened. This tab projects what is likely to
 * happen next, framed for the Registered Strata Plan rather than for individual
 * landlords: the corporation's operating income is the maintenance (HOA)
 * contributions its proprietors pay, and its outgoings are the property's shared
 * expenses. Rent and short-term booking income belong to individual proprietors,
 * not to the corporation, so they are deliberately excluded from this projection.
 *
 * The method is a transparent straight-line run-rate — no growth or seasonality is
 * assumed, no bank balance is invented, and USD and JMD are projected separately
 * and never combined. Every figure is derived from the same finance helpers the
 * ledger and reports use, so the numbers reconcile across the application.
 */

import React, { useMemo, useState } from 'react';
import { AppSettings, Charge, Currency, Expense, Payment, SessionUser, Unit, bodyCorporateName } from '../types';
import {
  accountBalance,
  chargeAmount,
  chargeCurrency,
  chargedInPeriod,
  collectedInPeriod,
  collectionRate,
  expensesInPeriod,
  strataExpenses,
  isBillable
} from '../lib/finance';
import { formatMoney, round2, sumMoney } from '../lib/money';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
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
import { Badge, EmptyState, ErrorNote, Field, InfoNote, SecondaryButton, SubmitButton, TableScroller, monoInputClass, tableHeadRowClass } from './ui';
import { Download, Landmark, Printer, TrendingDown, TrendingUp } from 'lucide-react';

interface ProjectionsProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  settings: AppSettings;
  session: SessionUser;
}

/** A month of the straight-line forecast. */
interface ForecastMonth {
  month: string; // YYYY-MM
  income: number;
  expenditure: number;
  net: number;
  cumulative: number;
}

/** Everything projected for one currency. */
export interface CurrencyProjection {
  currency: Currency;
  /** Number of completed months the run-rate is averaged over. */
  lookback: number;
  from: string;
  to: string;
  /** Maintenance contributions actually received over the look-back window. */
  maintReceived: number;
  /** Maintenance billed over the look-back window. */
  maintBilled: number;
  /** Operating expenses paid over the look-back window. */
  expensesPaid: number;
  avgReceived: number;
  avgExpense: number;
  /** Collection rate over the window, or null when nothing was billed. */
  rate: number | null;
  /** Current monthly maintenance assessment across contributing proprietors. */
  contractedMonthly: number;
  contributingUnits: number;
  /** Forward projection. */
  projectedIncome: number;
  projectedExpense: number;
  projectedNet: number;
  forecast: ForecastMonth[];
  horizonIncome: number;
  horizonExpense: number;
  horizonNet: number;
  /** Maintenance arrears outstanding today. */
  arrears: number;
  arrearsAccounts: number;
  arrearsOver60: number;
  /** Whether this currency has enough activity to be worth showing. */
  active: boolean;
}

const LOOKBACK_OPTIONS = [3, 6, 12] as const;
const HORIZON_OPTIONS = [3, 6, 12] as const;

/** The historical window a projection is averaged over. */
interface LookbackWindow {
  from: string;
  to: string;
  /** Whole months in the window — the divisor for every average below. */
  months: number;
}

function buildProjection(
  currency: Currency,
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  expenses: Expense[],
  window: LookbackWindow,
  horizon: number
): CurrencyProjection {
  const { from, to } = window;
  // Never divide by zero if a range somehow collapses to nothing.
  const lookback = Math.max(1, window.months);

  const maintReceived = collectedInPeriod(payments, currency, from, to).maintenance;
  const maintBilled = chargedInPeriod(charges, currency, from, to).maintenance;
  /*
   * The corporation's costs only.
   *
   * This projection already excludes rent and booking income "because they
   * belong to individual proprietors, not to the corporation" — see the note at
   * the head of this file. Counting ISPO's costs against contributions while
   * excluding ISPO's income would project a deficit for the fund out of money
   * that was never the fund's, which is the same fault as the annual report's
   * and worse for being on a page that says what it excludes.
   */
  const expensesPaid = expensesInPeriod(strataExpenses(expenses), currency, from, to);

  const avgReceived = round2(maintReceived / lookback);
  const avgExpense = round2(expensesPaid / lookback);
  const rate = collectionRate(maintBilled, maintReceived);

  // Current fee schedule: what every contributing proprietor is assessed per month.
  const contributing = units.filter(u => isBillable(u, 'Maintenance') && chargeCurrency(u, 'Maintenance') === currency);
  const contractedMonthly = sumMoney(contributing.map(u => chargeAmount(u, 'Maintenance')));

  // Projected monthly contributions: the current assessment tempered by the recent
  // collection rate (a rate above 100% is arrears catch-up, not a sustainable
  // run-rate, so it is capped). With no assessment on file, fall back to the plain
  // average actually received.
  const effRate = rate === null ? 1 : Math.min(rate, 100) / 100;
  const projectedIncome = contractedMonthly > 0 ? round2(contractedMonthly * effRate) : avgReceived;
  const projectedExpense = avgExpense;
  const projectedNet = round2(projectedIncome - projectedExpense);

  const forecast: ForecastMonth[] = [];
  let cumulative = 0;
  for (let i = 1; i <= horizon; i++) {
    cumulative = round2(cumulative + projectedNet);
    forecast.push({
      month: addMonths(currentMonth(), i),
      income: projectedIncome,
      expenditure: projectedExpense,
      net: projectedNet,
      cumulative
    });
  }

  // Maintenance arrears outstanding today — money owed to the corporation, and the
  // clearest upside to the projected position if collected.
  const arrearsBalances = units
    .map(u => accountBalance(u, 'Maintenance', charges, payments, today(), units))
    .filter(a => a.currency === currency && a.balance > 0);
  const arrears = sumMoney(arrearsBalances.map(a => a.balance));

  const active = contractedMonthly > 0 || maintBilled > 0 || maintReceived > 0 || expensesPaid > 0;

  return {
    currency,
    lookback,
    from,
    to,
    maintReceived,
    maintBilled,
    expensesPaid,
    avgReceived,
    avgExpense,
    rate,
    contractedMonthly,
    contributingUnits: contributing.length,
    projectedIncome,
    projectedExpense,
    projectedNet,
    forecast,
    horizonIncome: round2(projectedIncome * horizon),
    horizonExpense: round2(projectedExpense * horizon),
    horizonNet: round2(projectedNet * horizon),
    arrears,
    arrearsAccounts: arrearsBalances.length,
    arrearsOver60: arrearsBalances.filter(a => a.oldestUnpaidDays > 60).length,
    active
  };
}

/**
 * Plain-language analysis for one currency, addressed to the corporation. Every
 * sentence is an arithmetic statement about the figures above — no cause is
 * inferred and no number is invented.
 */
function analysisFor(p: CurrencyProjection, horizon: number): string[] {
  const c = p.currency;
  const out: string[] = [];
  const window = `${formatMonthLabel(p.from.substring(0, 7))} to ${formatMonthLabel(p.to.substring(0, 7))}`;

  const avgNet = round2(p.avgReceived - p.avgExpense);
  out.push(
    `Over the ${p.lookback} months ${window}, the corporation received ${formatMoney(p.maintReceived, c)} in maintenance ` +
      `contributions against ${formatMoney(p.expensesPaid, c)} in operating expenditure — an average monthly ` +
      `${avgNet >= 0 ? 'surplus' : 'deficit'} of ${formatMoney(Math.abs(avgNet), c)}.`
  );

  if (p.contractedMonthly > 0) {
    out.push(
      `The current maintenance assessment across ${p.contributingUnits} contributing proprietor ` +
        `account${p.contributingUnits === 1 ? '' : 's'} totals ${formatMoney(p.contractedMonthly, c)} per month. ` +
        (p.rate === null
          ? 'No maintenance was billed in the look-back period, so the projection uses the current assessment in full.'
          : `At the ${p.rate}% collection rate observed over the period, projected monthly contributions are ${formatMoney(p.projectedIncome, c)}.`)
    );
  }

  out.push(
    `Projected over the next ${horizon} months on a straight-line basis, contributions of ${formatMoney(p.horizonIncome, c)} ` +
      `against expenditure of ${formatMoney(p.horizonExpense, c)} leave a cumulative ` +
      `${p.horizonNet >= 0 ? 'surplus' : 'deficit'} of ${formatMoney(Math.abs(p.horizonNet), c)}.`
  );

  if (p.arrears > 0) {
    out.push(
      `${formatMoney(p.arrears, c)} in maintenance contributions is outstanding across ${p.arrearsAccounts} proprietor ` +
        `account${p.arrearsAccounts === 1 ? '' : 's'} as at ${formatDayLabel(today())}` +
        (p.arrearsOver60 > 0 ? `, of which ${p.arrearsOver60} exceed 60 days` : '') +
        `. Recovering these arrears would improve the corporation's position by ${formatMoney(p.arrears, c)}.`
    );
  }

  // A governance-oriented closing note, kept factual and advisory.
  if (p.projectedNet < 0) {
    out.push(
      `On current contributions and spending the corporation is projected to run a monthly deficit of ` +
        `${formatMoney(Math.abs(p.projectedNet), c)}. The Executive Committee may wish to review the maintenance ` +
        `assessment or defer non-essential expenditure so that contributions cover operating costs.`
    );
  } else {
    out.push(
      `On current contributions and spending the corporation is projected to run a monthly surplus of ` +
        `${formatMoney(p.projectedNet, c)}, which can be set aside toward the reserve / sinking fund.`
    );
  }

  return out;
}

export default function Projections({ units, charges, payments, expenses, settings, session }: ProjectionsProps) {
  const [lookback, setLookback] = useState<number>(6);
  const [horizon, setHorizon] = useState<number>(6);
  const [customRange, setCustomRange] = useState(false);
  const [customFrom, setCustomFrom] = useState(monthStart(addMonths(currentMonth(), -6)));
  const [customTo, setCustomTo] = useState(monthEnd(addMonths(currentMonth(), -1)));
  const [printing, setPrinting] = useState(false);

  const invalidRange = customRange && customTo < customFrom;

  /**
   * The historical window the run-rate is averaged over: either the last N
   * completed months, or an explicit range. The preset deliberately ends with
   * last month — the current, part-finished month would drag every average down.
   */
  const basis = useMemo<LookbackWindow>(() => {
    if (customRange) {
      return { from: customFrom, to: customTo, months: monthsBetween(customFrom, customTo).length };
    }
    return {
      from: monthStart(addMonths(currentMonth(), -lookback)),
      to: monthEnd(addMonths(currentMonth(), -1)),
      months: lookback
    };
  }, [customRange, customFrom, customTo, lookback]);

  const projections = useMemo(
    () =>
      invalidRange
        ? []
        : (['JMD', 'USD'] as Currency[])
            .map(currency => buildProjection(currency, units, charges, payments, expenses, basis, horizon))
            .filter(p => p.active),
    [units, charges, payments, expenses, basis, horizon, invalidRange]
  );

  const hasData = projections.length > 0;

  /**
   * Export the projection as a spreadsheet, so the committee can adjust figures
   * by hand — change an assessment, add a planned expense — without needing the
   * application. CSV with a byte-order mark, which Excel opens directly with
   * accents and currency symbols intact.
   */
  const downloadSpreadsheet = () => {
    const period = `${formatDayLabel(basis.from)} to ${formatDayLabel(basis.to)} (${basis.months} month basis), projected ${horizon} month(s) forward`;

    const sheets = projections.map(p => {
      const rows: XlsxCell[][] = [
        ...documentHeader({
          documentTitle: `Financial Projection — ${p.currency}`,
          period,
          generatedOn: formatDayLabel(today()),
          generatedBy: session.name,
          planNumber: settings.strataPlanNumber,
          span: 5
        }),
        [cell.header('Measure'), cell.header('Amount', 'right')],
        [cell.text('Current monthly assessment'), cell.money(p.contractedMonthly, p.currency)],
        [cell.text('Contributing proprietors'), cell.number(p.contributingUnits)],
        [cell.text(`Received over basis (${p.lookback} mo.)`), cell.money(p.maintReceived, p.currency)],
        [cell.text(`Billed over basis (${p.lookback} mo.)`), cell.money(p.maintBilled, p.currency)],
        [cell.text(`Expenses paid over basis (${p.lookback} mo.)`), cell.money(p.expensesPaid, p.currency)],
        [cell.text('Collection rate %'), p.rate === null ? cell.muted('n/a') : cell.number(p.rate)],
        [cell.text('Projected monthly contributions'), cell.money(p.projectedIncome, p.currency)],
        [cell.text('Projected monthly expenditure'), cell.money(p.projectedExpense, p.currency)],
        [cell.text('Projected monthly net'), cell.money(p.projectedNet, p.currency)],
        [cell.text('Maintenance arrears outstanding today'), cell.money(p.arrears, p.currency)],
        [cell.blank()],
        [cell.section(`Forecast — next ${horizon} month(s)`, 5)],
        [cell.header('Month'), cell.header('Contributions', 'right'), cell.header('Expenditure', 'right'), cell.header('Net', 'right'), cell.header('Cumulative', 'right')]
      ];

      for (const row of p.forecast) {
        rows.push([
          cell.text(formatMonthLabel(row.month)),
          cell.money(row.income, p.currency),
          cell.money(row.expenditure, p.currency),
          cell.money(row.net, p.currency),
          cell.money(row.cumulative, p.currency)
        ]);
      }
      rows.push([
        cell.total(`Total over ${horizon} months`),
        cell.totalMoney(p.horizonIncome, p.currency),
        cell.totalMoney(p.horizonExpense, p.currency),
        cell.totalMoney(p.horizonNet, p.currency),
        cell.totalMoney(p.horizonNet, p.currency)
      ]);

      rows.push([cell.blank()]);
      rows.push([cell.section('What this projection says', 5)]);
      for (const line of analysisFor(p, horizon)) rows.push([cell.note(line, 5)]);

      rows.push([cell.blank()]);
      rows.push([
        cell.note(
          'Maintenance (HOA) contributions only — rent and guest income belong to individual proprietors and never pass through the corporation. USD and JMD are projected separately and are never combined.',
          5
        )
      ]);

      return { name: `Projection ${p.currency}`, widths: [42, 20, 20, 20, 20], rows, freezeRows: 7, repeatRow: 7 };
    });

    if (sheets.length === 0) return;
    downloadWorkbook(sheets, `VDS Financial Projection ${basis.from} to ${basis.to} plus ${horizon}m.xlsx`);
  };

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-medium text-slate-900">
              <Landmark className="h-4 w-4 text-teal-600" />
              Strata corporation financial projection
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              A forward view of maintenance contributions against operating expenditure, for the body corporate.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={downloadSpreadsheet} disabled={!hasData} className="flex items-center gap-1.5">
              <Download className="h-4 w-4" /> Export for Excel
            </SecondaryButton>
            <SubmitButton type="button" onClick={() => setPrinting(true)} disabled={!hasData}>
              <Printer className="h-4 w-4" /> Print projection
            </SubmitButton>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Base the run-rate on" htmlFor="pj-lookback">
            <div className="flex flex-wrap gap-2" id="pj-lookback">
              {LOOKBACK_OPTIONS.map(n => (
                <button
                  key={n}
                  onClick={() => {
                    setCustomRange(false);
                    setLookback(n);
                  }}
                  aria-pressed={!customRange && lookback === n}
                  className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                    !customRange && lookback === n ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {n} months
                </button>
              ))}
              <button
                onClick={() => setCustomRange(true)}
                aria-pressed={customRange}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                  customRange ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                }`}
              >
                Custom range
              </button>
            </div>
          </Field>
          <Field label="Project forward" htmlFor="pj-horizon">
            <div className="flex gap-2" id="pj-horizon">
              {HORIZON_OPTIONS.map(n => (
                <button
                  key={n}
                  onClick={() => setHorizon(n)}
                  aria-pressed={horizon === n}
                  className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                    horizon === n ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {n} months
                </button>
              ))}
            </div>
          </Field>
        </div>

        {customRange && (
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
            <Field label="Basis from" htmlFor="pj-from">
              <input id="pj-from" type="date" value={customFrom} max={today()} onChange={e => setCustomFrom(e.target.value)} className={monoInputClass} />
            </Field>
            <Field label="Basis to" htmlFor="pj-to">
              <input id="pj-to" type="date" value={customTo} max={today()} onChange={e => setCustomTo(e.target.value)} className={monoInputClass} />
            </Field>
            <p className="pb-2 font-mono text-[11px] text-slate-500">
              {invalidRange
                ? 'Invalid range'
                : `${formatDayLabel(basis.from)} → ${formatDayLabel(basis.to)} (${basis.months} month${basis.months === 1 ? '' : 's'})`}
            </p>
          </div>
        )}

        {invalidRange && <ErrorNote>The end date must fall on or after the start date.</ErrorNote>}

        <InfoNote>
          Straight-line projection — no growth or seasonality is assumed. Income is maintenance (HOA) contributions only;
          rent and short-term booking income belong to individual proprietors and are excluded. USD and JMD are projected
          separately and never combined. No opening bank balance is assumed; figures are cash movement, not a bank position.
        </InfoNote>
      </section>

      {!hasData ? (
        <EmptyState
          title="Not enough recorded activity to project"
          hint="Post maintenance charges and record contributions and expenses, then a run-rate can be established here."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            {projections.map(p => (
              <ProjectionCard key={p.currency} p={p} horizon={horizon} />
            ))}
          </div>

          <ForecastTable projections={projections} />

          <section className="space-y-3 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
            <h3 className="font-display text-sm font-semibold text-slate-900">Summary for {bodyCorporateName(settings)}</h3>
            <p className="text-[11px] text-slate-500">
              Arithmetic statements about the figures above. No causes are inferred.
            </p>
            {projections.map(p => (
              <div key={p.currency} className="space-y-2">
                <h4 className="font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {p.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} ({p.currency})
                </h4>
                <ol className="space-y-2">
                  {analysisFor(p, horizon).map((text, i) => (
                    <li key={i} className="flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                      <span className="mt-0.5 text-slate-400">{i + 1}.</span>
                      <span>{text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </section>
        </>
      )}

      {printing && (
        <ProjectionDocument
          projections={projections}
          lookback={basis.months}
          basisFrom={basis.from}
          basisTo={basis.to}
          horizon={horizon}
          settings={settings}
          generatedBy={session.name}
          onClose={() => setPrinting(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProjectionCard({ p, horizon }: { p: CurrencyProjection; horizon: number }) {
  const deficit = p.projectedNet < 0;
  const max = Math.max(p.projectedIncome, p.projectedExpense, 1);
  return (
    <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <h3 className="font-display text-sm font-semibold text-slate-900">
          {p.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} projection
        </h3>
        <Badge tone="teal">{p.currency}</Badge>
      </div>

      <dl className="space-y-2 text-xs">
        <ProjRow label="Current monthly assessment" value={formatMoney(p.contractedMonthly, p.currency)} detail={`${p.contributingUnits} contributing proprietor${p.contributingUnits === 1 ? '' : 's'}`} />
        <ProjRow label={`Average received (last ${p.lookback} mo.)`} value={formatMoney(p.avgReceived, p.currency)} />
        <ProjRow label="Collection rate" value={p.rate === null ? 'n/a — nothing billed' : `${p.rate}%`} />
      </dl>

      {/* Projected monthly income vs expenditure, at a glance. */}
      <div className="space-y-2 border-t border-slate-100 pt-3">
        <CompareBar label="Projected monthly contributions" value={p.projectedIncome} max={max} currency={p.currency} tone="teal" />
        <CompareBar label="Projected monthly expenditure" value={p.projectedExpense} max={max} currency={p.currency} tone="rose" />
      </div>

      <div className={`flex items-center justify-between rounded-xl border p-3 ${deficit ? 'border-red-100 bg-red-50' : 'border-emerald-100 bg-emerald-50'}`}>
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
          {deficit ? <TrendingDown className="h-4 w-4 text-red-600" /> : <TrendingUp className="h-4 w-4 text-emerald-600" />}
          Projected monthly {deficit ? 'deficit' : 'surplus'}
        </span>
        <span className={`font-mono text-sm font-bold ${deficit ? 'text-red-700' : 'text-emerald-700'}`}>
          {formatMoney(Math.abs(p.projectedNet), p.currency)}
        </span>
      </div>

      <dl className="space-y-2 border-t border-slate-100 pt-3 text-xs">
        <ProjRow label={`Projected contributions (${horizon} mo.)`} value={formatMoney(p.horizonIncome, p.currency)} />
        <ProjRow label={`Projected expenditure (${horizon} mo.)`} value={formatMoney(p.horizonExpense, p.currency)} />
        <ProjRow label={`Cumulative ${p.horizonNet < 0 ? 'deficit' : 'surplus'} (${horizon} mo.)`} value={formatMoney(Math.abs(p.horizonNet), p.currency)} strong tone={p.horizonNet < 0 ? 'negative' : 'positive'} />
      </dl>

      {p.arrears > 0 && (
        <InfoNote tone="amber">
          {formatMoney(p.arrears, p.currency)} in maintenance contributions is outstanding across {p.arrearsAccounts} account
          {p.arrearsAccounts === 1 ? '' : 's'}
          {p.arrearsOver60 > 0 ? ` (${p.arrearsOver60} over 60 days)` : ''} — recoverable upside not included in the projection above.
        </InfoNote>
      )}
    </section>
  );
}

function ProjRow({
  label,
  value,
  detail,
  strong,
  tone
}: {
  label: string;
  value: string;
  detail?: string;
  strong?: boolean;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className={`flex flex-col gap-0.5 border-b border-slate-50 pb-2 ${strong ? 'font-semibold' : ''}`}>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-slate-600">{label}</dt>
        <dd className={`font-mono ${tone === 'negative' ? 'text-red-600' : tone === 'positive' ? 'text-emerald-700' : 'text-slate-900'}`}>{value}</dd>
      </div>
      {detail && <p className="font-mono text-[10px] leading-relaxed text-slate-400">{detail}</p>}
    </div>
  );
}

function CompareBar({ label, value, max, currency, tone }: { label: string; value: number; max: number; currency: Currency; tone: 'teal' | 'rose' }) {
  const pct = Math.max(2, round2((value / max) * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-[11px]">
        <span className="text-slate-600">{label}</span>
        <span className="font-mono font-medium text-slate-900">{formatMoney(value, currency)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone === 'teal' ? 'bg-teal-500' : 'bg-rose-400'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ForecastTable({ projections }: { projections: CurrencyProjection[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
      <div className="border-b border-slate-100 bg-slate-50 p-4">
        <h3 className="font-display text-sm font-semibold text-slate-900">Month-by-month projection</h3>
        <p className="mt-0.5 text-[11px] text-slate-500">Cumulative net is the projected operating result carried forward, starting from zero.</p>
      </div>
      <TableScroller>
        <table className="w-full min-w-[640px] border-collapse text-left text-xs">
          <thead>
            <tr className={tableHeadRowClass}>
              <th scope="col" className="p-4">Month</th>
              <th scope="col" className="p-4">Currency</th>
              <th scope="col" className="p-4 text-right">Contributions</th>
              <th scope="col" className="p-4 text-right">Expenditure</th>
              <th scope="col" className="p-4 text-right">Net</th>
              <th scope="col" className="p-4 text-right">Cumulative</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {projections.flatMap(p =>
              p.forecast.map(row => (
                <tr key={`${p.currency}-${row.month}`} className="hover:bg-slate-50/50">
                  <td className="p-4 font-medium text-slate-900">{formatMonthLabel(row.month)}</td>
                  <td className="p-4 font-mono text-slate-500">{p.currency}</td>
                  <td className="p-4 text-right font-mono text-emerald-600">{formatMoney(row.income, p.currency)}</td>
                  <td className="p-4 text-right font-mono text-rose-500">{formatMoney(row.expenditure, p.currency)}</td>
                  <td className={`p-4 text-right font-mono ${row.net < 0 ? 'text-red-600' : 'text-slate-700'}`}>{formatMoney(row.net, p.currency)}</td>
                  <td className={`p-4 text-right font-mono font-semibold ${row.cumulative < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{formatMoney(row.cumulative, p.currency)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </TableScroller>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ProjectionDocument({
  projections,
  lookback,
  basisFrom,
  basisTo,
  horizon,
  settings,
  generatedBy,
  onClose
}: {
  projections: CurrencyProjection[];
  lookback: number;
  basisFrom: string;
  basisTo: string;
  horizon: number;
  settings: AppSettings;
  generatedBy: string;
  onClose: () => void;
}) {
  return (
    <PrintPortal
      title="Strata corporation financial projection"
      subtitle={`Run-rate over ${lookback} months · projected ${horizon} months forward`}
      onClose={onClose}
      maxWidthClass="max-w-4xl"
    >
      <PrintLetterhead
        documentTitle="Financial Projection"
        meta={`Projected ${horizon} months · basis ${lookback} months`}
        generatedBy={generatedBy}
      />

      <section className="mb-5 break-inside-avoid">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">Basis and assumptions</h3>
        <ul className="list-disc space-y-1 pl-5 text-[11px] leading-relaxed">
          <li>
            Prepared for <strong>{bodyCorporateName(settings)}</strong> — the body corporate — for its own management and
            annual general meeting. <strong>This is not the annual return filed with the Commission of Strata Corporations</strong>,
            which is made on Forms 13A, 13B and 13C for the financial year.
          </li>
          <li>Income is maintenance (HOA) contributions only; rent and short-term booking income belong to individual proprietors and are excluded.</li>
          <li>
            Projection is straight-line from the run-rate of {formatDayLabel(basisFrom)} to {formatDayLabel(basisTo)} (
            {lookback} month{lookback === 1 ? '' : 's'}) — no growth, inflation or seasonality is assumed.
          </li>
          <li>Projected contributions are the current monthly assessment tempered by the recent collection rate; expenditure is the average of expenses paid over the period.</li>
          <li>USD and JMD are projected separately and never combined. No opening bank balance is assumed — figures represent cash movement, not a bank position.</li>
        </ul>
      </section>

      {projections.map(p => (
        <section key={p.currency} className="mb-6 break-inside-avoid">
          <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
            {p.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} ({p.currency})
          </h3>

          <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ['Monthly assessment', formatMoney(p.contractedMonthly, p.currency)],
              ['Collection rate', p.rate === null ? 'n/a' : `${p.rate}%`],
              ['Projected monthly contributions', formatMoney(p.projectedIncome, p.currency)],
              ['Projected monthly expenditure', formatMoney(p.projectedExpense, p.currency)],
              [`Contributions (${horizon} mo.)`, formatMoney(p.horizonIncome, p.currency)],
              [`Expenditure (${horizon} mo.)`, formatMoney(p.horizonExpense, p.currency)],
              [`Cumulative ${p.horizonNet < 0 ? 'deficit' : 'surplus'} (${horizon} mo.)`, formatMoney(Math.abs(p.horizonNet), p.currency)],
              ['Maintenance arrears (today)', formatMoney(p.arrears, p.currency)]
            ].map(([label, value]) => (
              <div key={label}>
                <span className="block font-mono text-[9px] uppercase text-slate-500">{label}</span>
                <span className="font-mono font-semibold text-slate-900">{value}</span>
              </div>
            ))}
          </div>

          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Month</th>
                  <th className="p-2 text-right">Contributions</th>
                  <th className="p-2 text-right">Expenditure</th>
                  <th className="p-2 text-right">Net</th>
                  <th className="p-2 text-right">Cumulative</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {p.forecast.map(row => (
                  <tr key={row.month}>
                    <td className="p-2 font-sans font-semibold">{formatMonthLabel(row.month)}</td>
                    <td className="p-2 text-right">{formatMoney(row.income, p.currency)}</td>
                    <td className="p-2 text-right">{formatMoney(row.expenditure, p.currency)}</td>
                    <td className="p-2 text-right">{formatMoney(row.net, p.currency)}</td>
                    <td className="p-2 text-right font-bold">{formatMoney(row.cumulative, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-400 font-bold">
                  <td className="p-2">Total ({horizon} months)</td>
                  <td className="p-2 text-right">{formatMoney(p.horizonIncome, p.currency)}</td>
                  <td className="p-2 text-right">{formatMoney(p.horizonExpense, p.currency)}</td>
                  <td className="p-2 text-right">{formatMoney(p.horizonNet, p.currency)}</td>
                  <td className="p-2 text-right">{formatMoney(p.horizonNet, p.currency)}</td>
                </tr>
              </tfoot>
            </table>
          </TableScroller>
        </section>
      ))}

      <section className="mb-6 break-inside-avoid">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">Summary for {bodyCorporateName(settings)}</h3>
        {projections.map(p => (
          <div key={p.currency} className="mb-3">
            <p className="mb-1 font-mono text-[9px] font-bold uppercase text-slate-500">{p.currency}</p>
            <ol className="list-decimal space-y-1 pl-5 text-[11px] leading-relaxed">
              {analysisFor(p, horizon).map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ol>
          </div>
        ))}
      </section>

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        This projection is an internal planning estimate prepared on a straight-line run-rate basis and is not a forecast of
        guaranteed results. It excludes rent and booking income, non-recurring items, and any reserve / sinking fund balance.
        Indicative rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD, used for display only; USD and JMD are never combined.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Treasurer / Executive Committee" />
    </PrintPortal>
  );
}
