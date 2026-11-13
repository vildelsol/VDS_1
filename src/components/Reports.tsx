/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import { getReportRange, setReportRange } from '../lib/reportRange';
import { useRemembered } from '../lib/screenState';
import {
  AppSettings,
  Booking,
  Charge,
  ChargeCategory,
  Currency,
  EXPENSE_FUND_LABELS,
  Expense,
  MANAGING_COMPANY_NAME,
  Payment,
  SessionUser,
  Tenancy,
  Unit,
  UtilityReading,
  fundOf,
  getAllocationLabel,
  invoiceDateOf,
  getUnitDisplayName
} from '../types';
import {
  REPORT_BOOKS,
  REPORT_BOOK_LABELS,
  REPORT_BOOK_SCOPE,
  ReportBook,
  accountBalance,
  chargeCategoriesInBook,
  chargedInPeriod,
  consolidateEverything,
  chargesInBook,
  collectedInPeriod,
  collectionRate,
  expenseBreakdown,
  expensesForBook,
  expensesInPeriod,
  liveExpenses,
  occupancyOn,
  operatingStatement,
  ownerBilledUnitIds,
  paymentsInBook
} from '../lib/finance';
import { formatMoney, round2, sumMoney } from '../lib/money';
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
import IspoOperations from './IspoOperations';
import OperatingStatement from './OperatingStatement';
import ShortfallReport from './ShortfallReport';
import { Badge, EmptyState, ErrorNote, Field, SecondaryButton, SubmitButton, TableScroller, monoInputClass, tableHeadRowClass } from './ui';
import { BarChart3, Download, Printer } from 'lucide-react';

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

export default function Reports({
  units,
  charges,
  payments: allPayments,
  expenses: allExpenses,
  utilities,
  bookings,
  tenancies,
  settings,
  session
}: ReportsProps) {
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

  /*
   * Which set of books this whole tab is read on.
   *
   * Ro, 2026-09-28: *"Now at the top of the summary all calculations are built
   * into one receivables and billed which is not supposed to be the case."* They
   * were: every figure on this screen summed rent and maintenance, and both
   * books' costs, into one number, and nothing offered a way to take them apart.
   *
   * One selector governs the whole tab rather than one per statement, so a pack
   * printed for the accountant cannot have two of its pages on different books.
   * `everything` is the default and is the combined view that was here before.
   *
   * The books split like this, and it is the same rule `ispoOperations` already
   * applies rather than a new one:
   *   - the corporation's: maintenance contributions, utilities recovered, other
   *     income, against the costs marked as funded by contributions;
   *   - ISPO's: rent and short-stay bookings, against the costs marked as paid
   *     from rental income.
   */
  const [book, setBook] = useRemembered<ReportBook>('reports.book', 'everything');

  /*
   * On the combined view only, money that sits on both books is counted once
   * (the maintenance inside a tenant's rent is the corporation's maintenance
   * charge too). The single-book views are untouched.
   */
  const combined = useMemo(
    () => (book === 'everything' ? consolidateEverything(charges, allPayments, units) : { charges, payments: allPayments }),
    [book, charges, allPayments, units]
  );
  const payments = useMemo(() => paymentsInBook(combined.payments, book), [combined, book]);

  /*
   * `expensesForBook`, not `expensesInBook`: on ISPO's book a contribution typed
   * into the cost register as well as receipted is counted from the receipt, and
   * counting the row too would put the same money on this screen twice. The
   * operating statement below already applied that rule and this summary did not,
   * so the two disagreed.
   *
   * The per-currency form is used for every figure; this array is for the printed
   * list of outgoings, which shows both currencies together.
   */
  const expenses = useMemo(() => expensesForBook(allExpenses, units, book), [allExpenses, units, book]);
  const bookCharges = useMemo(() => chargesInBook(combined.charges, book), [combined, book]);
  /*
   * A balance is computed per unit **per category**, so the book is applied by
   * choosing which categories to walk rather than by filtering an answer after
   * it has been added up.
   */
  const bookCategories = useMemo(() => chargeCategoriesInBook(book), [book]);

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
      const billed = chargedInPeriod(bookCharges, currency, from, to);

      /*
       * What went out, on this book.
       *
       * On ISPO's book the cost register is not the whole of it. The maintenance
       * ISPO pays the corporation on the villas it lets is real money leaving
       * ISPO, and there is no bill for it anywhere — it exists only as a
       * contribution receipt the corporation issued. Left out, this screen said
       * J$39,000 went out while the operating statement underneath it totalled
       * J$61,000 for the same period and the same book: two figures on one page
       * disagreeing, which is the fault this application keeps meeting.
       *
       * Taken from `operatingStatement` rather than computed again here, so the
       * two cannot drift apart. It is nil on the corporation's book and on the
       * combined one, where that money is income rather than a cost.
       */
      const paidOver =
        book === 'ispo'
          ? operatingStatement(allPayments, allExpenses, units, currency, from, to, { book }).internalTransfer
          : 0;
      const costs = expensesForBook(allExpenses, units, book, currency);
      const spent = sumMoney([expensesInPeriod(costs, currency, from, to), paidOver]);

      // Opening / closing receivable position across every account in this
      // currency that belongs to the book being read.
      const openingReceivable = sumMoney(
        units.flatMap(u =>
          bookCategories
            .map(cat => accountBalance(u, cat, bookCharges, payments, addDays(from, -1), units))
            .filter(a => a.currency === currency)
            .map(a => a.balance)
        )
      );
      const closingReceivable = sumMoney(
        units.flatMap(u =>
          bookCategories
            .map(cat => accountBalance(u, cat, bookCharges, payments, to, units))
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
        paidOver,
        breakdown: expenseBreakdown(costs, currency, from, to)
      };
    });
  }, [payments, bookCharges, bookCategories, expenses, allPayments, allExpenses, book, units, from, to, ownerBilled, invalidRange]);

  /* ---------------- monthly series for charts ---------------- */

  const series = useMemo(() => {
    if (invalidRange) return [];
    return months.map(month => {
      const mFrom = monthStart(month) < from ? from : monthStart(month);
      const mTo = monthEnd(month) > to ? to : monthEnd(month);
      const row: Record<string, number | string> = { month };
      for (const currency of ['JMD', 'USD'] as Currency[]) {
        const collected = collectedInPeriod(payments, currency, mFrom, mTo, ownerBilled);
        const billed = chargedInPeriod(bookCharges, currency, mFrom, mTo);
        row[`${currency}_in`] = collected.total;
        /*
         * What came in that is never raised as a charge.
         *
         * Ro, 2026-10-05, reading the printed monthly movement: *"the USD billed
         * was 1700, however the amount received is 5400. The received amount is
         * correct as the system counted short term rentals as well, however,
         * there is no mention that this was from short term rental."* Billed
         * counts rent and maintenance charges; Received counts every receipt. A
         * guest pays on arrival against no charge at all, so the two columns are
         * answering different questions and the page never said so.
         */
        row[`${currency}_booking`] = collected.booking;
        row[`${currency}_out`] = sumMoney([
          expensesInPeriod(expensesForBook(allExpenses, units, book, currency), currency, mFrom, mTo),
          // Same reason as the summary card above: on ISPO's book the
          // contribution it pays over is money out with no cost row behind it.
          book === 'ispo'
            ? operatingStatement(allPayments, allExpenses, units, currency, mFrom, mTo, { book }).internalTransfer
            : 0
        ]);
        row[`${currency}_billed`] = billed.total;
      }
      return row;
    });
  }, [months, payments, bookCharges, expenses, allPayments, allExpenses, book, units, from, to, ownerBilled, invalidRange]);

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

    /*
     * Which accounts the book being read actually holds. "Billed in rent and
     * maintenance" was true of the combined view and false of either single one:
     * the corporation bills no rent and ISPO bills no maintenance.
     */
    const billedAccounts = bookCategories.map(cat => cat.toLowerCase()).join(' and ');

    for (const entry of summary) {
      if (entry.billed.total === 0 && entry.collected.total === 0 && entry.spent === 0) continue;
      const c = entry.currency;

      if (entry.billed.total > 0) {
        // Anything short of full collection is money outstanding, not a statistic.
        say(
          entry.rate !== null && entry.rate < 100 ? URGENT : NOTABLE,
          `${c}: ${formatMoney(entry.billed.total, c)} was billed in ${billedAccounts}; ` +
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

      /*
       * Why Received can exceed Billed, said on the page rather than left for
       * somebody to work out. Only raised when there is actually a gap to
       * explain, so it does not become a sentence people stop reading.
       */
      const unbilled = sumMoney([entry.collected.booking, entry.collected.utility, entry.collected.other]);
      if (unbilled > 0) {
        const parts: string[] = [];
        if (entry.collected.booking > 0) parts.push(`${formatMoney(entry.collected.booking, c)} short-stay rental`);
        if (entry.collected.utility > 0) parts.push(`${formatMoney(entry.collected.utility, c)} utilities recovered`);
        if (entry.collected.other > 0) parts.push(`${formatMoney(entry.collected.other, c)} other income`);
        say(
          NOTABLE,
          `${c}: ${formatMoney(unbilled, c)} of what was received is not raised as a charge, so it appears in nothing that is billed: ` +
            `${parts.join(', ')}. "Billed" counts rent and maintenance only, which is why it can read lower than "Received".`
        );
      }

      // `!== 0` on what went out: a period whose costs are all supplier
      // credits spent less than nothing, and said nothing about it.
      if (entry.collected.total !== 0 || entry.spent !== 0) {
        say(
          // Spending more than came in is a fact that belongs at the top.
          entry.net < 0 ? URGENT : NOTABLE,
          `${c}: ${formatMoney(entry.collected.total, c)} received against ${formatMoney(entry.spent, c)} paid out, ` +
            `a net cash movement of ${formatMoney(entry.net, c)}.`
        );
      }
    }

    // Arrears ageing, stated as counts.
    const aged = units
      .flatMap(u => bookCategories.map(cat => accountBalance(u, cat, bookCharges, payments, to, units)))
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
    /*
     * Short-stay letting is ISPO's trade, not the corporation's — Ro, 2026-09-28:
     * *"Short term rentals should also be an internal calculation and not a part
     * of the strata operating statement or calculations especially when printed."*
     * So it is stated on the internal books and left off the corporation's.
     */
    if (book !== 'strata' && shortLetUnits > 0 && daysInRange > 0) {
      const available = shortLetUnits * daysInRange;
      say(
        CONTEXT,
        `${nightsSold} guest night(s) were sold across ${shortLetUnits} short-let villa(s) over ${daysInRange} day(s), ` +
          `${round2((nightsSold / available) * 100)}% of available nights.`
      );
    }

    const unpaidUtilities = utilities.filter(u => u.status === 'unpaid').length;
    if (book !== 'ispo' && unpaidUtilities > 0) {
      say(URGENT, `${unpaidUtilities} utility bill(s) remain unsettled at the report date.`);
    }

    /*
     * Who was in a villa on the report date, not how the villas are set up to be
     * let. This counted `unit.status`, so a villa merely offered on Airbnb was
     * reported as occupied whether or not anyone was in it — the same fault the
     * dashboard carried (Ro, 2026-09-02).
     */
    if (units.length > 0) {
      const occ = occupancyOn(units, tenancies, bookings, to);
      say(
        CONTEXT,
        `${occ.occupied} of ${occ.total - occ.unavailable} lettable villas had somebody in them on the report date ` +
          `(a tenancy, a guest in residence, or the owner's own home); ${occ.available} stood empty and available` +
          `${occ.unavailable > 0 ? `, and ${occ.unavailable} were off the market` : ''}.`
      );
    }

    // A stable sort: equal ranks keep the order they were computed in.
    return entries
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(entry => entry.text);
  }, [summary, units, bookCharges, bookCategories, book, payments, bookings, utilities, from, to, invalidRange]);

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
        // A separator, not a list. The em dash sweep flattened this to a comma
        // and the sheet read "Expenses, line by line, Everything (both books)".
        documentTitle: `${documentTitle} · ${REPORT_BOOK_LABELS[book]}`,
        period,
        generatedOn: formatDayLabel(today()),
        generatedBy: session.name,
        planNumber: settings.strataPlanNumber,
        span
      });

    /* --- 1. the period, per currency --- */
    const summaryRows: XlsxCell[][] = [
      ...head('Period summary by currency', 10),
      [
        cell.header('Currency'),
        cell.header('Opening receivable', 'right'),
        cell.header('Billed in period', 'right'),
        cell.header('Received in period', 'right'),
        cell.header('Closing receivable', 'right'),
        cell.header('Expenses paid', 'right'),
        cell.header('of which paid to the corporation', 'right'),
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
        cell.money(entry.paidOver, entry.currency),
        cell.money(sumMoney(entry.breakdown.map(b => b.outstanding)), entry.currency),
        cell.money(entry.net, entry.currency),
        entry.rate === null ? cell.muted('n/a') : cell.number(entry.rate)
      ]);
    }
    summaryRows.push([cell.blank()]);
    summaryRows.push([cell.note('USD and JMD are reported separately and are never combined. Each figure is in the currency of its own row.', 10)]);
    summaryRows.push([cell.note(`Scope: ${REPORT_BOOK_SCOPE[book]}`, 10)]);

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

    /* --- 3. what it cost, line by line --- */

    /*
     * Every cost named, not a total per category.
     *
     * Ro, 2026-10-05: *"the expenses on the excel sheet needs to itemize all the
     * expenses, line by line as opposed to grouping them by Payroll, Utilities
     * etc."* The sheet was one row per category, which is a figure nobody can
     * check: "Payroll 82,000" cannot be questioned, approved or reconciled
     * against a bank statement. The same reasoning the Operating Statement was
     * built on, applied to the workbook the accountant actually opens.
     *
     * Taken back costs are left off, because they are in none of the totals and
     * a line that is not in the total is a line that will not reconcile. The
     * category subtotals stay, at the foot, after the detail rather than instead
     * of it.
     */
    const costLines = liveExpenses(expenses)
      .filter(e => {
        const when = e.status === 'paid' ? e.datePaid || e.date : e.dueDate || e.date;
        return when >= from && when <= to;
      })
      .sort(
        (a, b) =>
          a.currency.localeCompare(b.currency) ||
          (a.status === 'paid' ? a.datePaid || a.date : a.dueDate || a.date).localeCompare(
            b.status === 'paid' ? b.datePaid || b.date : b.dueDate || b.date
          ) ||
          a.vendor.localeCompare(b.vendor)
      );

    const expenseRows: XlsxCell[][] = [
      ...head('Expenses, line by line', 10),
      [
        cell.header('Invoice date'),
        cell.header('Paid'),
        cell.header('Currency'),
        cell.header('Paid to'),
        cell.header('What it was for'),
        cell.header('Category'),
        cell.header('Allocation'),
        cell.header('Paid from'),
        cell.header('Reference'),
        cell.header('Amount', 'right')
      ]
    ];

    for (const e of costLines) {
      const invoiced = invoiceDateOf(e);
      expenseRows.push([
        // The supplier's date where it is known, and the logged date marked as a
        // stand-in where it is not. An accountant reconciling a month needs to
        // know which of the two she is reading.
        invoiced.recorded ? cell.date(invoiced.date) : cell.muted(`${formatDayLabel(invoiced.date)} (logged)`),
        e.datePaid ? cell.date(e.datePaid) : cell.muted('not yet'),
        cell.text(e.currency),
        cell.text(e.vendor || 'not recorded'),
        cell.text(e.description || '-'),
        cell.text(e.category),
        cell.text(e.unitId ? getUnitDisplayName(e.unitNumber) : getAllocationLabel(e.unitNumber)),
        cell.text(EXPENSE_FUND_LABELS[fundOf(e)]),
        cell.text(e.reference || ''),
        e.status === 'paid' ? cell.money(e.amount, e.currency) : cell.muted(`${formatMoney(e.amount, e.currency)} (not yet paid)`)
      ]);
    }

    if (costLines.length === 0) {
      expenseRows.push([cell.muted('Nothing was paid or raised in this period.')]);
    }

    for (const currency of ['JMD', 'USD'] as Currency[]) {
      const inCurrency = costLines.filter(e => e.currency === currency);
      if (inCurrency.length === 0) continue;
      const paid = sumMoney(inCurrency.filter(e => e.status === 'paid').map(e => e.amount));
      const due = sumMoney(inCurrency.filter(e => e.status !== 'paid').map(e => e.amount));
      expenseRows.push([cell.blank()]);
      const spacer = () => [cell.total(''), cell.total(''), cell.total(''), cell.total(''), cell.total(''), cell.total(''), cell.total(''), cell.total('')];
      expenseRows.push([cell.total(`Total paid (${currency})`), ...spacer(), cell.totalMoney(paid, currency)]);
      expenseRows.push([cell.total(`Still outstanding (${currency})`), ...spacer(), cell.totalMoney(due, currency)]);
    }

    /*
     * The category totals, kept as a summary *after* the detail. They are what a
     * council asks for; the lines above are what an accountant checks them with.
     */
    expenseRows.push([cell.blank()]);
    expenseRows.push([cell.section('Summary by category', 10)]);
    expenseRows.push([
      cell.header('Currency'),
      cell.header('Category'),
      cell.header('Paid', 'right'),
      cell.header('Outstanding', 'right'),
      cell.header('Total', 'right')
    ]);
    for (const entry of summary) {
      for (const b of entry.breakdown) {
        expenseRows.push([
          cell.text(entry.currency),
          cell.text(b.category),
          cell.money(b.amount, entry.currency),
          cell.money(b.outstanding, entry.currency),
          cell.money(round2(b.amount + b.outstanding), entry.currency)
        ]);
      }
    }
    expenseRows.push([cell.blank()]);
    expenseRows.push([
      cell.note(
        'Costs taken back are not listed and are in none of these totals. A negative amount is a credit from the supplier, and reduces what the period cost. ' +
          'Where no invoice date was recorded the date this was logged here is shown and marked; it is not the supplier\u2019s date.',
        10
      )
    ]);

    /* --- 4. month by month --- */
    const monthlyRows: XlsxCell[][] = [
      ...head('Monthly cash movement', 7),
      [
        cell.header('Month'),
        cell.header('Currency'),
        cell.header('Billed', 'right'),
        cell.header('Received', 'right'),
        cell.header('of which short-stay', 'right'),
        cell.header('Paid out', 'right'),
        cell.header('Net', 'right')
      ]
    ];
    for (const row of series) {
      for (const currency of ['JMD', 'USD'] as Currency[]) {
        const billed = Number(row[`${currency}_billed`]);
        const received = Number(row[`${currency}_in`]);
        const booking = Number(row[`${currency}_booking`] || 0);
        const paidOut = Number(row[`${currency}_out`]);
        if (billed === 0 && received === 0 && paidOut === 0) continue;
        monthlyRows.push([
          cell.text(formatMonthLabel(String(row.month))),
          cell.text(currency),
          cell.money(billed, currency),
          cell.money(received, currency),
          cell.money(booking, currency),
          cell.money(paidOut, currency),
          cell.money(round2(received - paidOut), currency)
        ]);
      }
    }

    /* --- 5. where every account stands --- */
    const balanceRows = units
      .flatMap(unit => bookCategories.map(cat => ({ unit, account: accountBalance(unit, cat, bookCharges, payments, to, units), cat })))
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
        { name: 'Period summary', widths: [12, 18, 18, 18, 18, 16, 24, 20, 18, 16], rows: summaryRows, freezeRows: headerRow, repeatRow: headerRow, landscape: true },
        { name: 'Income received', widths: [12, 16, 16, 16, 16, 16, 18], rows: incomeRows, freezeRows: headerRow, repeatRow: headerRow, landscape: true },
        {
          name: 'Expenses',
          widths: [16, 14, 10, 28, 36, 18, 20, 22, 18, 16],
          rows: expenseRows,
          freezeRows: headerRow,
          repeatRow: headerRow,
          landscape: true
        },
        { name: 'Monthly cash', widths: [18, 12, 16, 16, 20, 16, 16], rows: monthlyRows, freezeRows: headerRow, repeatRow: headerRow },
        { name: 'Account balances', widths: [18, 14, 26, 12, 18, 18, 18, 14], rows: balanceSheet, freezeRows: headerRow, repeatRow: headerRow, landscape: true }
      ],
      `VDS Management Report ${book === 'everything' ? 'Both books' : REPORT_BOOK_LABELS[book]} ${from} to ${to}.xlsx`
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

        {/*
          Which books, above the period, because it decides which money is on the
          screen at all. Everything below it — the summary, the chart, the
          observations, the account balances, the operating statement, the Excel
          export and the printed pack — reads whichever book is chosen here.
        */}
        <div className="space-y-2">
          <span className="block font-mono text-[10px] uppercase tracking-wide text-slate-500">Which set of books</span>
          <div className="flex flex-wrap gap-2">
            {REPORT_BOOKS.map(b => (
              <button
                key={b}
                type="button"
                onClick={() => setBook(b)}
                aria-pressed={book === b}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                  book === b ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                }`}
              >
                {REPORT_BOOK_LABELS[b]}
              </button>
            ))}
          </div>
          <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[10px] leading-relaxed text-slate-600">
            {REPORT_BOOK_SCOPE[book]}
          </p>
          <p className="font-mono text-[10px] leading-relaxed text-slate-400">
            The proprietors&rsquo; monthly statement, the {MANAGING_COMPANY_NAME} operations statement and the out-of-pocket
            report further down each belong to one book by their nature and say so on their own face. This selector does not
            change them.
          </p>
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
                  <StatementRow
                    label="Expenses paid"
                    value={formatMoney(entry.spent, entry.currency)}
                    detail={
                      entry.paidOver > 0
                        ? `Includes ${formatMoney(entry.paidOver, entry.currency)} of maintenance ${MANAGING_COMPANY_NAME} paid the corporation on the villas it lets. It is read from the contribution receipts, there is no bill for it in the cost register.`
                        : undefined
                    }
                  />
                  <StatementRow label="Net cash movement" value={formatMoney(entry.net, entry.currency)} strong tone={entry.net < 0 ? 'negative' : 'positive'} />
                  <StatementRow label="Collection rate" value={entry.rate === null ? 'n/a, nothing billed' : `${entry.rate}%`} />
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
                              {row.outstanding !== 0 && (
                                <span className="text-amber-600">
                                  {' '}
                                  · {formatMoney(row.outstanding, entry.currency)}
                                  {row.outstanding < 0 ? ' credit due back' : ' due'}
                                </span>
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

          <AccountBalancesTable units={units} charges={bookCharges} payments={payments} categories={bookCategories} asOf={to} />
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
      {/*
        The book comes from the selector at the top of this tab, so the statement
        and the management figures above it are never on different books in the
        same printed pack. Ro, 2026-09-28: one selector, governing the whole tab.

        The raw arrays are passed, never the book-filtered ones: `operatingStatement`
        applies the book itself, and handing it a pre-filtered array as well would
        filter twice — harmless today and exactly the shape that silently drops a
        class of money the day the two rules stop agreeing.
      */}
      <OperatingStatement
        units={units}
        payments={allPayments}
        expenses={allExpenses}
        book={book}
        settings={settings}
        session={session}
      />

      <OperationsStatement expenses={allExpenses} payments={allPayments} settings={settings} session={session} />

      {/*
        The other side of the same register: ISPO's own income and costs.

        Ro, 2026-09-03 — the phone, the company vehicle and its insurance come out
        of rental income, not out of the proprietors' contributions, and until the
        two books existed they were counted as the corporation's. Between this and
        the owners' statement above, every cost in the register is counted exactly
        once.

        Visibility is decided inside the component, on the same rule as the
        shortfall report below: every role unless it is withdrawn in Settings.
        Do not wrap this in a role check — that is exactly the mistake corrected
        below it.
      */}
      <IspoOperations units={units} expenses={allExpenses} payments={allPayments} settings={settings} session={session} />

      {/*
        ISPO's own trading position on the villas it lets — deliberately the last
        thing on the screen and badged internal, because it is not the strata
        corporation's money. It carries its own period for the same reason the
        statements above do.

        ⚠️ **Mounted unconditionally on purpose.** This used to be wrapped in
        `session.role === 'ADMINISTRATOR'`, while `ShortfallReport` itself
        implements "every role sees it unless it is withdrawn in Settings" —
        which is what Ro asked for twice. The outer gate made that inner rule
        unreachable for everyone who was not an administrator, so the
        `viewShortfall` permission could never grant anything: a guard that
        cannot fire, counted as coverage. Ro, 2026-09-03: *"Every role unless
        withdrawn is the best option."*

        The permission lives in the component, once. Do not re-wrap this.
      */}
      <ShortfallReport units={units} tenancies={tenancies} bookings={bookings} payments={allPayments} session={session} />

      {printing && (
        <StatementDocument
          units={units}
          charges={bookCharges}
          payments={payments}
          expenses={expenses}
          summary={summary}
          series={series}
          observations={observations}
          book={book}
          categories={bookCategories}
          from={from}
          to={to}
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

function AccountBalancesTable({
  units,
  charges,
  payments,
  categories,
  asOf
}: {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  /** The accounts this book contains — rent is ISPO's, maintenance the fund's. */
  categories: ChargeCategory[];
  asOf: string;
}) {
  const rows = useMemo(
    () =>
      units
        .flatMap(unit => categories.map(category => accountBalance(unit, category, charges, payments, asOf, units)))
        .filter(a => a.charged !== 0 || a.paid !== 0)
        .sort((a, b) => b.balance - a.balance),
    [units, charges, payments, categories, asOf]
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
                <td className="p-3 text-right font-mono text-slate-500">{a.oldestUnpaidDays > 0 ? `${a.oldestUnpaidDays} days` : '-'}</td>
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
    /**
     * How much of `spent` is the maintenance ISPO paid the corporation on the
     * villas it lets. Nil on every book but ISPO's, where it is real money out
     * with no row in the cost register behind it.
     */
    paidOver: number;
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
  book,
  categories,
  from,
  to,
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
  /** The book every figure on this page was read on. Named on the page. */
  book: ReportBook;
  categories: ChargeCategory[];
  from: string;
  to: string;
  generatedBy: string;
  onClose: () => void;
}) {
  const receipts = payments
    .filter(p => isWithin(p.date, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.receiptNo.localeCompare(b.receiptNo));
  /*
   * A cost taken back is in none of the figures on this document, so it must not
   * be in the detail either — this list is what an accountant checks the totals
   * against, and a line that is not in the total is a line that will not
   * reconcile.
   */
  const outgoings = liveExpenses(expenses)
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
        meta={`${REPORT_BOOK_LABELS[book]} · Period ${formatDayLabel(from)} to ${formatDayLabel(to)}`}
        generatedBy={generatedBy}
      />

      {/*
        One note, above the figures, saying everything a reader needs in order to
        read them — the scope of the page and the rules the numbers follow.

        The scope belongs on the sheet because a printed page has no selector on it
        to say which books it was read on. It is joined here with what used to be a
        separate footer: Ro, 2026-09-28, on the statement beside this one —
        *"there are 3 different areas of disclaimers, thats unnecessary."*
      */}
      <p className="mb-4 rounded border border-slate-400 p-2 text-[10px] leading-relaxed">
        <strong>Scope.</strong> {REPORT_BOOK_SCOPE[book]} JMD and USD are reported separately and never combined.
        Utility recoveries billed directly to owners of owner-occupied and short-let villas are excluded from operating
        revenue.
      </p>

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
              ...(entry.paidOver > 0
                ? [[`of which contributions paid to the corporation`, formatMoney(entry.paidOver, entry.currency)] as [string, string]]
                : []),
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
                <th className="p-2 text-right">of which short-stay</th>
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
                      <td className="p-2 text-right">{formatMoney(Number(row[`${c}_booking`] || 0), c)}</td>
                      <td className="p-2 text-right">{formatMoney(Number(row[`${c}_out`]), c)}</td>
                      <td className="p-2 text-right font-semibold">{formatMoney(round2(Number(row[`${c}_in`]) - Number(row[`${c}_out`])), c)}</td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </TableScroller>
        {/*
          The two columns answer different questions, and the page now says so.
          A council reading "billed 1,700, received 5,400" with no explanation
          concludes the billing is wrong.
        */}
        <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
          <strong>Billed</strong> is rent and maintenance charges raised in the month. <strong>Received</strong> is every
          receipt banked in it. Short-stay rental, utilities recovered and other income are never raised as a charge, so
          they appear under Received and never under Billed. That is why Received can be the larger figure.
        </p>
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
                .flatMap(unit => categories.map(cat => accountBalance(unit, cat, charges, payments, to, units)))
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
                    <td className="p-2 text-right">{a.oldestUnpaidDays > 0 ? `${a.oldestUnpaidDays}d` : '-'}</td>
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
                            <td className="p-2 text-right">{b.outstanding !== 0 ? formatMoney(b.outstanding, s.currency) : '-'}</td>
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
                    <td className="p-2">{e.reference || '-'}</td>
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

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Reviewed / Approved by" />
    </PrintPortal>
  );
}
