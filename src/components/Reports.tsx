/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { getReportRange, setReportRange } from '../lib/reportRange';
import {
  AppSettings,
  Booking,
  Charge,
  Currency,
  Expense,
  Payment,
  SessionUser,
  Tenancy,
  Unit,
  UtilityReading,
  getAllocationLabel,
  getUnitDisplayName
} from '../types';
import {
  accountBalance,
  chargedInPeriod,
  collectedInPeriod,
  collectionRate,
  expenseBreakdown,
  expensesInPeriod,
  isOccupied,
  ownerBilledUnitIds
} from '../lib/finance';
import { formatMoney, formatMoneyPlain, round2, sumMoney } from '../lib/money';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
import {
  addDays,
  addMonths,
  currentMonth,
  formatDayLabel,
  formatMonthLabel,
  isWithin,
  monthEnd,
  monthStart,
  monthsBetween,
  nightsBetween,
  today
} from '../lib/dates';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import OperationsStatement from './OperationsStatement';
import OperatingStatement from './OperatingStatement';
import ShortfallReport from './ShortfallReport';
import { Badge, EmptyState, ErrorNote, Field, InfoNote, SecondaryButton, SubmitButton, TableScroller, monoInputClass, tableHeadRowClass } from './ui';
import { BarChart3, Download, Printer, TrendingDown, TrendingUp } from 'lucide-react';

interface ReportsProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  utilities: UtilityReading[];
  bookings: Booking[];
  /** Needed by the shortfall report: occupied days come from dated records, not `unit.status`. */
  tenancies: Tenancy[];
  settings: AppSettings;
  session: SessionUser;
}

type Preset = 'thisMonth' | 'lastMonth' | 'last3' | 'last6' | 'last12' | 'ytd' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'last3', label: 'Last 3 months' },
  { key: 'last6', label: 'Last 6 months' },
  { key: 'last12', label: 'Last 12 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'custom', label: 'Custom range' }
];

function rangeForPreset(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const now = currentMonth();
  switch (preset) {
    case 'thisMonth':
      return { from: monthStart(now), to: monthEnd(now) };
    case 'lastMonth': {
      const m = addMonths(now, -1);
      return { from: monthStart(m), to: monthEnd(m) };
    }
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

export default function Reports({ units, charges, payments, expenses, utilities, bookings, tenancies, settings, session }: ReportsProps) {
  // Adopt the period chosen on Charts, if one was, so the statement and the
  // charts beside it in a pack cover the same period.
  const shared = getReportRange();
  const sharedPreset = shared?.preset && PRESETS.some(p => p.key === shared.preset) ? (shared.preset as Preset) : null;

  const [preset, setPreset] = useState<Preset>(sharedPreset ?? (shared ? 'custom' : 'last3'));
  const [custom, setCustom] = useState(
    shared ? { from: shared.from, to: shared.to } : { from: monthStart(addMonths(currentMonth(), -2)), to: today() }
  );
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');

  const { from, to } = rangeForPreset(preset, custom);
  const invalidRange = to < from;

  useEffect(() => {
    if (!invalidRange) setReportRange({ from, to, preset });
  }, [from, to, preset, invalidRange]);

  const ownerBilled = useMemo(() => ownerBilledUnitIds(units), [units]);
  const months = useMemo(() => (invalidRange ? [] : monthsBetween(from, to)), [from, to, invalidRange]);

  /* ---------------- per-currency period summary ---------------- */

  const summary = useMemo(() => {
    if (invalidRange) return [];
    return (['JMD', 'USD'] as Currency[]).map(currency => {
      const collected = collectedInPeriod(payments, currency, from, to, ownerBilled);
      const billed = chargedInPeriod(charges, currency, from, to);
      const spent = expensesInPeriod(expenses, currency, from, to);

      // Opening / closing receivable position across every account in this currency.
      const openingReceivable = sumMoney(
        units.flatMap(u =>
          (['Rent', 'Maintenance'] as const)
            .map(cat => accountBalance(u, cat, charges, payments, addDays(from, -1), units))
            .filter(a => a.currency === currency)
            .map(a => a.balance)
        )
      );
      const closingReceivable = sumMoney(
        units.flatMap(u =>
          (['Rent', 'Maintenance'] as const)
            .map(cat => accountBalance(u, cat, charges, payments, to, units))
            .filter(a => a.currency === currency)
            .map(a => a.balance)
        )
      );

      return {
        currency,
        collected,
        billed,
        spent,
        net: sumMoney([collected.total, -spent]),
        rate: collectionRate(billed.total, sumMoney([collected.rent, collected.maintenance])),
        openingReceivable,
        closingReceivable,
        breakdown: expenseBreakdown(expenses, currency, from, to)
      };
    });
  }, [payments, charges, expenses, units, from, to, ownerBilled, invalidRange]);

  /* ---------------- monthly series for charts ---------------- */

  const series = useMemo(() => {
    if (invalidRange) return [];
    return months.map(month => {
      const mFrom = monthStart(month) < from ? from : monthStart(month);
      const mTo = monthEnd(month) > to ? to : monthEnd(month);
      const row: Record<string, number | string> = { month };
      for (const currency of ['JMD', 'USD'] as Currency[]) {
        const collected = collectedInPeriod(payments, currency, mFrom, mTo, ownerBilled);
        const billed = chargedInPeriod(charges, currency, mFrom, mTo);
        row[`${currency}_in`] = collected.total;
        row[`${currency}_out`] = expensesInPeriod(expenses, currency, mFrom, mTo);
        row[`${currency}_billed`] = billed.total;
      }
      return row;
    });
  }, [months, payments, charges, expenses, from, to, ownerBilled, invalidRange]);

  /* ---------------- factual observations ---------------- */

  /**
   * These are arithmetic statements about the data in the selected range.
   * The previous version asserted causes it had no way to know ("driven by
   * short-term booking velocity"), which is not something a report should say.
   */
  const observations = useMemo(() => {
    if (invalidRange) return [];

    /**
     * Ranked, not merely listed.
     *
     * These were previously emitted in the order the code happened to compute
     * them, which put "3 accounts exceed 60 days" in the same undifferentiated
     * list as "16 of 16 villas are occupied". Both are true; only one needs
     * acting on this week. Lower rank sorts first, and ties keep the order they
     * were computed in so a currency's figures stay together.
     */
    const URGENT = 0; // money at risk, or a position that has worsened
    const NOTABLE = 1; // the period's headline figures
    const CONTEXT = 2; // standing facts that frame the rest

    const entries: { text: string; rank: number }[] = [];
    const say = (rank: number, text: string) => entries.push({ rank, text });

    for (const entry of summary) {
      if (entry.billed.total === 0 && entry.collected.total === 0 && entry.spent === 0) continue;
      const c = entry.currency;

      if (entry.billed.total > 0) {
        // Anything short of full collection is money outstanding, not a statistic.
        say(
          entry.rate !== null && entry.rate < 100 ? URGENT : NOTABLE,
          `${c}: ${formatMoney(entry.billed.total, c)} was billed in rent and maintenance; ` +
            `${formatMoney(sumMoney([entry.collected.rent, entry.collected.maintenance]), c)} was received against it ` +
            `(${entry.rate ?? 0}% of the amount billed in this period).`
        );
      }

      const movement = round2(entry.closingReceivable - entry.openingReceivable);
      if (entry.openingReceivable !== 0 || entry.closingReceivable !== 0) {
        say(
          // Receivables growing is the single clearest sign collection is slipping.
          movement > 0 ? URGENT : NOTABLE,
          `${c}: receivables ${movement > 0 ? 'rose' : movement < 0 ? 'fell' : 'were unchanged'} from ` +
            `${formatMoney(entry.openingReceivable, c)} at the start of the period to ${formatMoney(entry.closingReceivable, c)} at the end` +
            (movement === 0 ? '.' : `, ${movement > 0 ? 'an increase' : 'a decrease'} of ${formatMoney(Math.abs(movement), c)}.`)
        );
      }

      if (entry.breakdown.length > 0) {
        const top = entry.breakdown[0];
        say(NOTABLE, `${c}: the largest expense category was ${top.category} at ${formatMoney(top.amount, c)} (${top.share}% of ${c} outflows).`);
      }

      if (entry.collected.total > 0 || entry.spent > 0) {
        say(
          // Spending more than came in is a fact that belongs at the top.
          entry.net < 0 ? URGENT : NOTABLE,
          `${c}: ${formatMoney(entry.collected.total, c)} received against ${formatMoney(entry.spent, c)} paid out — ` +
            `a net cash movement of ${formatMoney(entry.net, c)}.`
        );
      }
    }

    // Arrears ageing, stated as counts.
    const aged = units
      .flatMap(u => (['Rent', 'Maintenance'] as const).map(cat => accountBalance(u, cat, charges, payments, to, units)))
      .filter(a => a.balance > 0);
    if (aged.length > 0) {
      const over60 = aged.filter(a => a.oldestUnpaidDays > 60).length;
      const over30 = aged.filter(a => a.oldestUnpaidDays > 30).length;
      say(
        URGENT,
        `${aged.length} account(s) carried a balance at ${formatDayLabel(to)}: ${over30} more than 30 days old, of which ${over60} exceed 60 days.`
      );
    }

    // Short-term occupancy, computed from nights actually sold.
    const nightsSold = bookings
      .filter(b => b.status !== 'cancelled' && b.source !== 'Blocked' && b.source !== 'Unavailable')
      .reduce((total, b) => {
        const overlapStart = b.checkIn > from ? b.checkIn : from;
        const overlapEnd = b.checkOut < addDays(to, 1) ? b.checkOut : addDays(to, 1);
        return total + Math.max(0, nightsBetween(overlapStart, overlapEnd));
      }, 0);
    const shortLetUnits = units.filter(u => u.status === 'short-term').length;
    const daysInRange = nightsBetween(from, addDays(to, 1));
    if (shortLetUnits > 0 && daysInRange > 0) {
      const available = shortLetUnits * daysInRange;
      say(
        CONTEXT,
        `${nightsSold} guest night(s) were sold across ${shortLetUnits} short-let villa(s) over ${daysInRange} day(s) — ` +
          `${round2((nightsSold / available) * 100)}% of available nights.`
      );
    }

    const unpaidUtilities = utilities.filter(u => u.status === 'unpaid').length;
    if (unpaidUtilities > 0) say(URGENT, `${unpaidUtilities} utility bill(s) remain unsettled at the report date.`);

    const occupied = units.filter(isOccupied).length;
    if (units.length > 0) {
      say(CONTEXT, `${occupied} of ${units.length} villas are occupied (long-term, short-let or owner-occupied) at the report date.`);
    }

    // A stable sort: equal ranks keep the order they were computed in.
    return entries
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(entry => entry.text);
  }, [summary, units, charges, payments, bookings, utilities, from, to, invalidRange]);

  /* ---------------- CSV ---------------- */

  /**
   * The operating statement as a real Excel workbook.
   *
   * This was a CSV, and a CSV cannot be made presentable: an accountant opened
   * it to unlabelled narrow columns of raw text, and printing it produced pages
   * with no headings on them. Each section is now its own sheet with its own
   * headers, money is a *number* carrying its currency's format so a column can
   * be re-totalled, and every sheet is set up to print.
   */
  const downloadWorkbookExport = () => {
    const period = `${formatDayLabel(from)} to ${formatDayLabel(to)}`;
    const head = (documentTitle: string, span: number) =>
      documentHeader({
        documentTitle,
        period,
        generatedOn: formatDayLabel(today()),
        generatedBy: session.name,
        planNumber: settings.strataPlanNumber,
        span
      });

    /* --- 1. the period, per currency --- */
    const summaryRows: XlsxCell[][] = [
      ...head('Period summary by currency', 9),
      [
        cell.header('Currency'),
        cell.header('Opening receivable', 'right'),
        cell.header('Billed in period', 'right'),
        cell.header('Received in period', 'right'),
        cell.header('Closing receivable', 'right'),
        cell.header('Expenses paid', 'right'),
        cell.header('Expenses outstanding', 'right'),
        cell.header('Net cash movement', 'right'),
        cell.header('Collection rate %', 'right')
      ]
    ];
    for (const entry of summary) {
      summaryRows.push([
        cell.text(entry.currency),
        cell.money(entry.openingReceivable, entry.currency),
        cell.money(entry.billed.total, entry.currency),
        cell.money(entry.collected.total, entry.currency),
        cell.money(entry.closingReceivable, entry.currency),
        cell.money(entry.spent, entry.currency),
        cell.money(sumMoney(entry.breakdown.map(b => b.outstanding)), entry.currency),
        cell.money(entry.net, entry.currency),
        entry.rate === null ? cell.muted('n/a') : cell.number(entry.rate)
      ]);
    }
    summaryRows.push([cell.blank()]);
    summaryRows.push([cell.note('USD and JMD are reported separately and are never combined. Each figure is in the currency of its own row.', 9)]);

    /* --- 2. what was received, by category --- */
    const incomeRows: XlsxCell[][] = [
      ...head('Income received by category', 7),
      [
        cell.header('Currency'),
        cell.header('Rent', 'right'),
        cell.header('Maintenance', 'right'),
        cell.header('Bookings', 'right'),
        cell.header('Utilities', 'right'),
        cell.header('Other', 'right'),
        cell.header('Total received', 'right')
      ]
    ];
    for (const entry of summary) {
      incomeRows.push([
        cell.text(entry.currency),
        cell.money(entry.collected.rent, entry.currency),
        cell.money(entry.collected.maintenance, entry.currency),
        cell.money(entry.collected.booking, entry.currency),
        cell.money(entry.collected.utility, entry.currency),
        cell.money(entry.collected.other, entry.currency),
        cell.totalMoney(entry.collected.total, entry.currency)
      ]);
    }

    /* --- 3. what it cost --- */
    const expenseRows: XlsxCell[][] = [
      ...head('Expenses by category', 5),
      [cell.header('Currency'), cell.header('Category'), cell.header('Paid', 'right'), cell.header('Outstanding', 'right'), cell.header('Total', 'right')]
    ];
    for (const entry of summary) {
      let paidTot = 0;
      let outTot = 0;
      for (const b of entry.breakdown) {
        paidTot = round2(paidTot + b.amount);
        outTot = round2(outTot + b.outstanding);
        expenseRows.push([
          cell.text(entry.currency),
          cell.text(b.category),
          cell.money(b.amount, entry.currency),
          cell.money(b.outstanding, entry.currency),
          cell.money(round2(b.amount + b.outstanding), entry.currency)
        ]);
      }
      if (entry.breakdown.length > 0) {
        expenseRows.push([
          cell.total(entry.currency),
          cell.total('Total'),
          cell.totalMoney(paidTot, entry.currency),
          cell.totalMoney(outTot, entry.currency),
          cell.totalMoney(round2(paidTot + outTot), entry.currency)
        ]);
      }
    }

    /* --- 4. month by month --- */
    const monthlyRows: XlsxCell[][] = [
      ...head('Monthly cash movement', 6),
      [cell.header('Month'), cell.header('Currency'), cell.header('Billed', 'right'), cell.header('Received', 'right'), cell.header('Paid out', 'right'), cell.header('Net', 'right')]
    ];
    for (const row of series) {
      for (const currency of ['JMD', 'USD'] as Currency[]) {
        const billed = Number(row[`${currency}_billed`]);
        const received = Number(row[`${currency}_in`]);
        const paidOut = Number(row[`${currency}_out`]);
        if (billed === 0 && received === 0 && paidOut === 0) continue;
        monthlyRows.push([
          cell.text(formatMonthLabel(String(row.month))),
          cell.text(currency),
          cell.money(billed, currency),
          cell.money(received, currency),
          cell.money(paidOut, currency),
          cell.money(round2(received - paidOut), currency)
        ]);
      }
    }

    /* --- 5. where every account stands --- */
    const balanceRows = units
      .flatMap(unit => (['Rent', 'Maintenance'] as const).map(cat => ({ unit, account: accountBalance(unit, cat, charges, payments, to, units), cat })))
      .filter(r => r.account.charged !== 0 || r.account.paid !== 0)
      .sort((a, b) => b.account.balance - a.account.balance);

    const balanceSheet: XlsxCell[][] = [
      ...head(`Account balances at ${formatDayLabel(to)}`, 8),
      [
        cell.header('Villa'),
        cell.header('Account'),
        cell.header('Payer'),
        cell.header('Currency'),
        cell.header('Billed to date', 'right'),
        cell.header('Received to date', 'right'),
        cell.header('Balance', 'right'),
        cell.header('Oldest unpaid (days)', 'right')
      ]
    ];
    const balByCurrency: Record<string, number> = { JMD: 0, USD: 0 };
    for (const { unit, account, cat } of balanceRows) {
      balByCurrency[account.currency] = round2(balByCurrency[account.currency] + account.balance);
      balanceSheet.push([
        cell.text(getUnitDisplayName(unit.number)),
        cell.text(cat),
        cell.text(cat === 'Maintenance' ? unit.ownerName : unit.tenantName || unit.ownerName),
        cell.text(account.currency),
        cell.money(account.charged, account.currency),
        cell.money(account.paid, account.currency),
        cell.money(account.balance, account.currency),
        cell.number(account.oldestUnpaidDays)
      ]);
    }
    for (const currency of ['JMD', 'USD'] as Currency[]) {
      if (balByCurrency[currency] !== 0) {
        balanceSheet.push([
          cell.total('Total outstanding'),
          cell.total(''),
          cell.total(''),
          cell.total(currency),
          cell.total(''),
          cell.total(''),
          cell.totalMoney(balByCurrency[currency], currency),
          cell.total('')
        ]);
      }
    }

    const headerRow = 7; // the six-row masthead, then the column headers

    downloadWorkbook(
      [
        { name: 'Period summary', widths: [12, 18, 18, 18, 18, 16, 20, 18, 16], rows: summaryRows, freezeRows: headerRow, repeatRow: headerRow, landscape: true },
        { name: 'Income received', widths: [12, 16, 16, 16, 16, 16, 18], rows: incomeRows, freezeRows: headerRow, repeatRow: headerRow, landscape: true },
        { name: 'Expenses', widths: [12, 24, 16, 16, 16], rows: expenseRows, freezeRows: headerRow, repeatRow: headerRow },
        { name: 'Monthly cash', widths: [18, 12, 16, 16, 16, 16], rows: monthlyRows, freezeRows: headerRow, repeatRow: headerRow },
        { name: 'Account balances', widths: [18, 14, 26, 12, 18, 18, 18, 14], rows: balanceSheet, freezeRows: headerRow, repeatRow: headerRow, landscape: true }
      ],
      `VDS Operating Statement ${from} to ${to}.xlsx`
    );
  };

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}

      <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-display text-lg font-medium text-slate-900">Operating statement</h2>
            <p className="text-xs text-slate-500">
              Reconcilable figures for any date range, reported separately per currency.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={downloadWorkbookExport} disabled={invalidRange} className="flex items-center gap-1.5">
              <Download className="h-4 w-4" /> Export for Excel
            </SecondaryButton>
            <SubmitButton
              type="button"
              onClick={() => {
                if (invalidRange) {
                  setError('The end date must fall on or after the start date.');
                  return;
                }
                setError('');
                setPrinting(true);
              }}
            >
              <Printer className="h-4 w-4" /> Print statement
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
          <Field label="From" htmlFor="rp-from">
            <input
              id="rp-from"
              type="date"
              value={from}
              onChange={e => {
                setPreset('custom');
                setCustom(c => ({ ...c, from: e.target.value }));
              }}
              className={monoInputClass}
            />
          </Field>
          <Field label="To" htmlFor="rp-to">
            <input
              id="rp-to"
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
            {invalidRange ? 'Invalid range' : `${formatDayLabel(from)} → ${formatDayLabel(to)} (${months.length} month${months.length === 1 ? '' : 's'})`}
          </p>
        </div>

        {invalidRange && <ErrorNote>The end date must fall on or after the start date.</ErrorNote>}
      </section>

      {!invalidRange && (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            {summary.map(entry => (
              <section key={entry.currency} className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <h3 className="font-display text-sm font-semibold text-slate-900">
                    {entry.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} statement
                  </h3>
                  <Badge tone="teal">{entry.currency}</Badge>
                </div>

                <dl className="space-y-2 text-xs">
                  <StatementRow label="Receivable at start of period" value={formatMoney(entry.openingReceivable, entry.currency)} />
                  <StatementRow label="Billed during period" value={formatMoney(entry.billed.total, entry.currency)} detail={`Rent ${formatMoney(entry.billed.rent, entry.currency)} · Maintenance ${formatMoney(entry.billed.maintenance, entry.currency)}`} />
                  <StatementRow label="Received during period" value={formatMoney(entry.collected.total, entry.currency)} detail={`Rent ${formatMoney(entry.collected.rent, entry.currency)} · Maintenance ${formatMoney(entry.collected.maintenance, entry.currency)} · Bookings ${formatMoney(entry.collected.booking, entry.currency)} · Utilities ${formatMoney(entry.collected.utility, entry.currency)} · Other ${formatMoney(entry.collected.other, entry.currency)}`} />
                  <StatementRow label="Receivable at end of period" value={formatMoney(entry.closingReceivable, entry.currency)} strong />
                  <StatementRow label="Expenses paid" value={formatMoney(entry.spent, entry.currency)} />
                  <StatementRow label="Net cash movement" value={formatMoney(entry.net, entry.currency)} strong tone={entry.net < 0 ? 'negative' : 'positive'} />
                  <StatementRow label="Collection rate" value={entry.rate === null ? 'n/a — nothing billed' : `${entry.rate}%`} />
                </dl>

                {entry.breakdown.length > 0 && (
                  <div className="space-y-2 border-t border-slate-100 pt-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Expenses by category</h4>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Paid · Outstanding</span>
                    </div>
                    <ul className="space-y-1.5">
                      {entry.breakdown.map(row => (
                        <li key={row.category} className="space-y-1">
                          <div className="flex justify-between gap-2 text-[11px]">
                            <span className="text-slate-600">{row.category}</span>
                            <span className="font-mono font-medium">
                              {formatMoney(row.amount, entry.currency)}
                              {row.outstanding > 0 && (
                                <span className="text-amber-600"> · {formatMoney(row.outstanding, entry.currency)} due</span>
                              )}
                              <span className="text-slate-400"> ({row.share}%)</span>
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-teal-500" style={{ width: `${Math.max(2, row.share)}%` }} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            ))}
          </div>

          <section className="space-y-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-teal-600" />
              <h3 className="font-display text-sm font-semibold text-slate-900">Monthly cash movement</h3>
            </div>
            {series.length === 0 ? (
              <EmptyState title="No months in the selected range" />
            ) : (
              (['JMD', 'USD'] as Currency[]).map(currency => (
                <CashChart key={currency} currency={currency} series={series} />
              ))
            )}
          </section>

          <section className="space-y-3 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
            <h3 className="font-display text-sm font-semibold text-slate-900">Observations</h3>
            <p className="text-[11px] text-slate-500">
              Arithmetic statements about the data in this range. No causes are inferred.
            </p>
            {observations.length === 0 ? (
              <EmptyState title="No activity recorded in this range" />
            ) : (
              <ul className="space-y-2">
                {observations.map((text, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                    <span className="mt-0.5 text-slate-400">{i + 1}.</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <AccountBalancesTable units={units} charges={charges} payments={payments} asOf={to} />
        </>
      )}

      {/*
        The proprietors' own monthly statement, kept beside the operating figures
        it is drawn from rather than on a screen of its own. It carries its own
        month, because it is issued for a completed month while the statement
        above is read over whatever range someone is asking about.
      */}
      {/*
        The statement carried to the strata corporation: income and expenditure,
        every payment named, currencies apart. It holds its own period — a
        council asks for a month, a quarter or the year, independently of
        whatever range the management figures above are being read over.
      */}
      <OperatingStatement units={units} payments={payments} expenses={expenses} settings={settings} session={session} />

      <OperationsStatement expenses={expenses} payments={payments} settings={settings} session={session} />

      {/*
        VDS's own trading position on the villas it lets — deliberately the last
        thing on the screen and badged internal, because it is not the strata
        corporation's money. It carries its own period for the same reason the
        statements above do.

        Administrators only. The component enforces that itself and renders
        nothing for anyone else — the check is repeated here so that whoever
        reads this file can see the rule without opening the other one. Do not
        mount this anywhere an owner or the council can reach.
      */}
      {session.role === 'ADMINISTRATOR' && (
        <ShortfallReport units={units} tenancies={tenancies} bookings={bookings} payments={payments} session={session} />
      )}

      {printing && (
        <StatementDocument
          units={units}
          charges={charges}
          payments={payments}
          expenses={expenses}
          summary={summary}
          series={series}
          observations={observations}
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

function StatementRow({
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

function CashChart({ currency, series }: { currency: Currency; series: Record<string, number | string>[] }) {
  const values = series.flatMap(row => [Number(row[`${currency}_in`]), Number(row[`${currency}_out`]), Number(row[`${currency}_billed`])]);
  const max = Math.max(...values, 1);
  if (max <= 1) {
    return (
      <div className="space-y-2">
        <h4 className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{currency}</h4>
        <EmptyState title={`No ${currency} activity in this range`} />
      </div>
    );
  }

  const width = 720;
  const height = 200;
  const padding = { top: 12, right: 12, bottom: 28, left: 62 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const step = chartW / series.length;
  const barW = Math.min(22, step / 3.4);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{currency}</h4>
        <div className="flex gap-4 text-[10px] text-slate-500">
          {[
            ['bg-slate-300', 'Billed'],
            ['bg-teal-500', 'Received'],
            ['bg-rose-400', 'Paid out']
          ].map(([cls, label]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-sm ${cls}`} />
              {label}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${currency} monthly billed, received and paid out`} className="w-full rounded-xl border border-slate-100 bg-slate-50/50">
        {[0, 0.25, 0.5, 0.75, 1].map(p => {
          const y = padding.top + chartH * (1 - p);
          return (
            <g key={p}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3,3" opacity="0.5" />
              <text x={padding.left - 6} y={y + 3} textAnchor="end" className="fill-slate-400" fontSize="8" fontFamily="monospace">
                {formatMoney(round2(max * p), currency)}
              </text>
            </g>
          );
        })}
        <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="#94a3b8" strokeWidth="1" />

        {series.map((row, index) => {
          const groupX = padding.left + index * step + (step - barW * 3 - 6) / 2;
          const bars = [
            { value: Number(row[`${currency}_billed`]), fill: '#cbd5e1' },
            { value: Number(row[`${currency}_in`]), fill: '#14b8a6' },
            { value: Number(row[`${currency}_out`]), fill: '#fb7185' }
          ];
          return (
            <g key={String(row.month)}>
              {bars.map((bar, i) => {
                const h = (bar.value / max) * chartH;
                return (
                  <rect key={i} x={groupX + i * (barW + 3)} y={height - padding.bottom - h} width={barW} height={Math.max(0, h)} fill={bar.fill} rx="2">
                    <title>{`${formatMonthLabel(String(row.month))}: ${formatMoney(bar.value, currency)}`}</title>
                  </rect>
                );
              })}
              <text x={groupX + (barW * 3) / 2} y={height - padding.bottom + 14} textAnchor="middle" className="fill-slate-500" fontSize="8" fontFamily="monospace">
                {String(row.month).substring(2)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function AccountBalancesTable({ units, charges, payments, asOf }: { units: Unit[]; charges: Charge[]; payments: Payment[]; asOf: string }) {
  const rows = useMemo(
    () =>
      units
        .flatMap(unit =>
          (['Rent', 'Maintenance'] as const).map(category => accountBalance(unit, category, charges, payments, asOf, units))
        )
        .filter(a => a.charged !== 0 || a.paid !== 0)
        .sort((a, b) => b.balance - a.balance),
    [units, charges, payments, asOf]
  );

  if (rows.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
        <EmptyState title="No account activity to reconcile" hint="Post a billing month from the ledger to start the receivables position." />
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
      <div className="border-b border-slate-100 bg-slate-50 p-4">
        <h3 className="font-display text-sm font-semibold text-slate-900">Account balances at {formatDayLabel(asOf)}</h3>
        <p className="mt-0.5 text-[11px] text-slate-500">Billed to date minus received to date, per account.</p>
      </div>
      <TableScroller>
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead>
            <tr className={tableHeadRowClass}>
              <th scope="col" className="p-3">Villa</th>
              <th scope="col" className="p-3">Account</th>
              <th scope="col" className="p-3">Currency</th>
              <th scope="col" className="p-3 text-right">Billed</th>
              <th scope="col" className="p-3 text-right">Received</th>
              <th scope="col" className="p-3 text-right">Balance</th>
              <th scope="col" className="p-3 text-right">Oldest unpaid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map(a => (
              <tr key={`${a.unit.id}-${a.category}`} className="hover:bg-slate-50/50">
                <td className="p-3 font-mono font-semibold">{getUnitDisplayName(a.unit.number)}</td>
                <td className="p-3">{a.category}</td>
                <td className="p-3 font-mono text-slate-500">{a.currency}</td>
                <td className="p-3 text-right font-mono">{formatMoney(a.charged, a.currency)}</td>
                <td className="p-3 text-right font-mono text-emerald-600">{formatMoney(a.paid, a.currency)}</td>
                <td className={`p-3 text-right font-mono font-semibold ${a.balance > 0 ? 'text-red-600' : a.balance < 0 ? 'text-sky-600' : 'text-slate-500'}`}>
                  {formatMoney(a.balance, a.currency)}
                </td>
                <td className="p-3 text-right font-mono text-slate-500">{a.oldestUnpaidDays > 0 ? `${a.oldestUnpaidDays} days` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
    </section>
  );
}

/* ------------------------------------------------------------------ */

type Summary = ReturnType<typeof buildSummaryType>;
function buildSummaryType() {
  return [] as {
    currency: Currency;
    collected: ReturnType<typeof collectedInPeriod>;
    billed: ReturnType<typeof chargedInPeriod>;
    spent: number;
    net: number;
    rate: number | null;
    openingReceivable: number;
    closingReceivable: number;
    breakdown: ReturnType<typeof expenseBreakdown>;
  }[];
}

function StatementDocument({
  units,
  charges,
  payments,
  expenses,
  summary,
  series,
  observations,
  from,
  to,
  settings,
  generatedBy,
  onClose
}: {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  summary: Summary;
  series: Record<string, number | string>[];
  observations: string[];
  from: string;
  to: string;
  settings: AppSettings;
  generatedBy: string;
  onClose: () => void;
}) {
  const receipts = payments
    .filter(p => isWithin(p.date, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.receiptNo.localeCompare(b.receiptNo));
  const outgoings = expenses
    .filter(e => isWithin(e.datePaid || e.date, from, to))
    .sort((a, b) => (a.datePaid || a.date).localeCompare(b.datePaid || b.date));

  return (
    <PrintPortal
      title="Operating statement"
      subtitle={`${formatDayLabel(from)} to ${formatDayLabel(to)}`}
      onClose={onClose}
      maxWidthClass="max-w-5xl"
    >
      <PrintLetterhead
        documentTitle="Operating Statement"
        meta={`Period ${formatDayLabel(from)} — ${formatDayLabel(to)}`}
        generatedBy={generatedBy}
      />

      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {summary.map(entry => (
          <dl key={entry.currency} className="space-y-1 rounded-xl border border-slate-400 p-4 text-xs">
            <p className="mb-2 border-b border-slate-300 pb-1 font-mono text-[10px] font-bold uppercase">{entry.currency} summary</p>
            {[
              ['Receivable brought forward', formatMoney(entry.openingReceivable, entry.currency)],
              ['Billed in period', formatMoney(entry.billed.total, entry.currency)],
              ['Received in period', formatMoney(entry.collected.total, entry.currency)],
              ['Receivable carried forward', formatMoney(entry.closingReceivable, entry.currency)],
              ['Expenses paid', formatMoney(entry.spent, entry.currency)],
              ['Expenses outstanding', formatMoney(sumMoney(entry.breakdown.map(b => b.outstanding)), entry.currency)],
              ['Net cash movement', formatMoney(entry.net, entry.currency)],
              ['Collection rate', entry.rate === null ? 'n/a' : `${entry.rate}%`]
            ].map(([label, value], i, arr) => (
              <div key={label} className={`flex justify-between gap-3 ${i >= arr.length - 2 ? 'border-t border-slate-300 pt-1 font-bold' : ''}`}>
                <dt>{label}</dt>
                <dd className="font-mono">{value}</dd>
              </div>
            ))}
          </dl>
        ))}
      </section>

      <section className="mb-6 break-inside-avoid">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">Monthly movement</h3>
        <TableScroller>
          <table className="w-full text-left text-[10px]">
            <thead>
              <tr className="font-mono text-[9px] uppercase text-slate-600">
                <th className="p-2">Month</th>
                <th className="p-2">Currency</th>
                <th className="p-2 text-right">Billed</th>
                <th className="p-2 text-right">Received</th>
                <th className="p-2 text-right">Paid out</th>
                <th className="p-2 text-right">Net</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {series.flatMap(row =>
                (['JMD', 'USD'] as Currency[])
                  .filter(c => Number(row[`${c}_in`]) !== 0 || Number(row[`${c}_out`]) !== 0 || Number(row[`${c}_billed`]) !== 0)
                  .map(c => (
                    <tr key={`${row.month}-${c}`}>
                      <td className="p-2 font-semibold">{formatMonthLabel(String(row.month))}</td>
                      <td className="p-2">{c}</td>
                      <td className="p-2 text-right">{formatMoney(Number(row[`${c}_billed`]), c)}</td>
                      <td className="p-2 text-right">{formatMoney(Number(row[`${c}_in`]), c)}</td>
                      <td className="p-2 text-right">{formatMoney(Number(row[`${c}_out`]), c)}</td>
                      <td className="p-2 text-right font-semibold">{formatMoney(round2(Number(row[`${c}_in`]) - Number(row[`${c}_out`])), c)}</td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </TableScroller>
      </section>

      <section className="mb-6 break-inside-avoid">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
          Account balances at {formatDayLabel(to)}
        </h3>
        <TableScroller>
          <table className="w-full text-left text-[10px]">
            <thead>
              <tr className="font-mono text-[9px] uppercase text-slate-600">
                <th className="p-2">Villa</th>
                <th className="p-2">Account</th>
                <th className="p-2">Payer</th>
                <th className="p-2">Cur</th>
                <th className="p-2 text-right">Billed</th>
                <th className="p-2 text-right">Received</th>
                <th className="p-2 text-right">Balance</th>
                <th className="p-2 text-right">Age</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {units
                .flatMap(unit => (['Rent', 'Maintenance'] as const).map(cat => accountBalance(unit, cat, charges, payments, to, units)))
                .filter(a => a.charged !== 0 || a.paid !== 0)
                .sort((a, b) => b.balance - a.balance)
                .map(a => (
                  <tr key={`${a.unit.id}-${a.category}`}>
                    <td className="p-2 font-bold">{getUnitDisplayName(a.unit.number)}</td>
                    <td className="p-2">{a.category}</td>
                    <td className="p-2 font-sans">{a.category === 'Maintenance' ? a.unit.ownerName : a.unit.tenantName || a.unit.ownerName}</td>
                    <td className="p-2">{a.currency}</td>
                    <td className="p-2 text-right">{formatMoney(a.charged, a.currency)}</td>
                    <td className="p-2 text-right">{formatMoney(a.paid, a.currency)}</td>
                    <td className="p-2 text-right font-bold">{formatMoney(a.balance, a.currency)}</td>
                    <td className="p-2 text-right">{a.oldestUnpaidDays > 0 ? `${a.oldestUnpaidDays}d` : '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </TableScroller>
      </section>

      <section className="mb-6 break-inside-avoid page-break-before">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
          Receipts issued ({receipts.length})
        </h3>
        {receipts.length === 0 ? (
          <p className="text-xs italic text-slate-500">No receipts issued in this period.</p>
        ) : (
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Date</th>
                  <th className="p-2">Receipt</th>
                  <th className="p-2">Villa</th>
                  <th className="p-2">Payer</th>
                  <th className="p-2">Category</th>
                  <th className="p-2">Method</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {receipts.map(p => (
                  <tr key={p.id} className={p.status === 'reversed' ? 'text-slate-500 line-through' : ''}>
                    <td className="p-2">{formatDayLabel(p.date)}</td>
                    <td className="p-2 font-semibold">{p.receiptNo}</td>
                    <td className="p-2">{p.unitNumber}</td>
                    <td className="p-2 font-sans">{p.payerName}</td>
                    <td className="p-2">{p.category}</td>
                    <td className="p-2">{p.method}</td>
                    <td className="p-2 uppercase">{p.status === 'reversed' ? 'VOID' : p.status === 'pending' ? 'PENDING' : 'OK'}</td>
                    <td className="p-2 text-right font-semibold">
                      {formatMoney(p.amount, p.currency)} {p.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      {summary.some(s => s.breakdown.length > 0) && (
        <section className="mb-6 break-inside-avoid">
          <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">Expenses by category</h3>
          {summary
            .filter(s => s.breakdown.length > 0)
            .map(s => {
              const paidTotal = sumMoney(s.breakdown.map(b => b.amount));
              const outstandingTotal = sumMoney(s.breakdown.map(b => b.outstanding));
              return (
                <div key={s.currency} className="mb-3">
                  <p className="mb-1 font-mono text-[9px] font-bold uppercase text-slate-500">{s.currency}</p>
                  <TableScroller>
                    <table className="w-full text-left text-[10px]">
                      <thead>
                        <tr className="font-mono text-[9px] uppercase text-slate-600">
                          <th className="p-2">Category</th>
                          <th className="p-2 text-right">Paid</th>
                          <th className="p-2 text-right">Outstanding</th>
                          <th className="p-2 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {s.breakdown.map(b => (
                          <tr key={b.category}>
                            <td className="p-2 font-sans">{b.category}</td>
                            <td className="p-2 text-right">{formatMoney(b.amount, s.currency)}</td>
                            <td className="p-2 text-right">{b.outstanding > 0 ? formatMoney(b.outstanding, s.currency) : '—'}</td>
                            <td className="p-2 text-right font-semibold">{formatMoney(round2(b.amount + b.outstanding), s.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-slate-400 font-bold">
                          <td className="p-2">Total</td>
                          <td className="p-2 text-right">{formatMoney(paidTotal, s.currency)}</td>
                          <td className="p-2 text-right">{formatMoney(outstandingTotal, s.currency)}</td>
                          <td className="p-2 text-right">{formatMoney(round2(paidTotal + outstandingTotal), s.currency)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </TableScroller>
                </div>
              );
            })}
        </section>
      )}

      <section className="mb-6 break-inside-avoid">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
          Expense detail ({outgoings.length})
        </h3>
        {outgoings.length === 0 ? (
          <p className="text-xs italic text-slate-500">No expenses recorded in this period.</p>
        ) : (
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Date</th>
                  <th className="p-2">Vendor</th>
                  <th className="p-2">Category</th>
                  <th className="p-2">Allocation</th>
                  <th className="p-2">Reference</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {outgoings.map(e => (
                  <tr key={e.id}>
                    <td className="p-2">{formatDayLabel(e.datePaid || e.date)}</td>
                    <td className="p-2 font-sans font-semibold">{e.vendor}</td>
                    <td className="p-2">{e.category}</td>
                    <td className="p-2">{getAllocationLabel(e.unitNumber)}</td>
                    <td className="p-2">{e.reference || '—'}</td>
                    <td className="p-2 uppercase">{e.status}</td>
                    <td className="p-2 text-right font-semibold">
                      {formatMoney(e.amount, e.currency)} {e.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      {observations.length > 0 && (
        <section className="mb-6 break-inside-avoid">
          <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">Observations</h3>
          <ol className="list-decimal space-y-1 pl-5 text-[11px] leading-relaxed">
            {observations.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ol>
        </section>
      )}

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        USD and JMD are reported separately and are never combined. Utility recoveries billed directly to owners of
        owner-occupied and short-let villas are excluded from operating revenue. Indicative rate on file: 1 USD ={' '}
        {settings.fxRateJmdPerUsd} JMD, used for display only.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Reviewed / Approved by" />
    </PrintPortal>
  );
}
