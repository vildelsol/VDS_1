/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Operating Statement carried to the strata corporation.
 *
 * Asked for by Ro on 2026-09-01: a document for the council meeting showing what
 * came in and what went out, and nothing else. The management report above it
 * answers different questions — receivables ageing, collection rates, occupancy —
 * and all of that gets in the way of the one thing a council is being asked to
 * approve.
 *
 * Two things were specified and both are load-bearing:
 *
 *   - **Every expense is itemised with the payee named under its category.** In
 *     Ro's own example, a payment of 20,000 to Darryl Whyte is classed as
 *     Payroll *and* carries his name: "Payroll — 20,000" is a figure nobody in
 *     the room can question, approve or check. The category classes it; the name
 *     makes it answerable.
 *   - **The currencies are separated.** One statement per currency, side by
 *     side, with no combined total anywhere on the page. The corporation holds
 *     two genuinely separate pots.
 *
 * Cash basis on both sides — money received against money paid — so the surplus
 * at the foot is a figure that reconciles to the bank statement rather than an
 * accrual somebody has to explain.
 */

import React, { useMemo, useState } from 'react';
import { AppSettings, Currency, Expense, MANAGING_COMPANY_NAME, Payment, PaymentCategory, SessionUser, Unit, bodyCorporateName } from '../types';
import { LineVisibility, OperatingStatement as Statement, OperatingStatementOptions, operatingStatement } from '../lib/finance';
import { formatMoney } from '../lib/money';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import { EmptyState, ErrorNote, Field, InfoNote, SecondaryButton, SubmitButton, TableScroller, inputClass, monoInputClass, tableHeadRowClass } from './ui';
import { Download, Printer } from 'lucide-react';

interface Props {
  units: Unit[];
  payments: Payment[];
  expenses: Expense[];
  settings: AppSettings;
  session: SessionUser;
}

const CURRENCIES: Currency[] = ['JMD', 'USD'];

/**
 * The periods a strata corporation actually asks for.
 *
 * This statement carries its own period rather than inheriting the management
 * report's, because it is a different document with a different audience: a
 * council reviews one month, a quarter, or the full year, and the person
 * printing it should not have to work out which control upstream governs it.
 *
 * The custom range is chosen in **whole months**, not days. A statement running
 * from the 14th to the 13th is not a thing anybody presents to a council, and
 * offering day precision only invites a period that cuts a month in half.
 */
type Preset = 'thisMonth' | 'lastMonth' | 'last3' | 'last6' | 'last12' | 'ytd' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'last3', label: 'Last 3 months' },
  { key: 'last6', label: 'Last 6 months' },
  { key: 'last12', label: 'Last 12 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'custom', label: 'Choose months' }
];

/**
 * The income classes, in the order a statement reads them, with the label each
 * one carries on the page.
 */
const INCOME_CLASSES: { category: PaymentCategory; label: string }[] = [
  { category: 'Maintenance', label: 'Maintenance contributions' },
  { category: 'Rent', label: 'Rent' },
  { category: 'Booking', label: 'Short-stay bookings' },
  { category: 'Utility', label: 'Utilities recovered' },
  { category: 'Other', label: 'Other income' }
];

const VISIBILITIES: { key: LineVisibility; label: string }[] = [
  { key: 'itemised', label: 'Itemised' },
  { key: 'total', label: 'Total only' },
  { key: 'excluded', label: 'Leave out' }
];

/**
 * The two documents this screen produces.
 *
 * Ro, 2026-09-01: maintenance should not be itemised on the copy that goes to
 * the strata corporation, though the office wants to see it; and short-stay
 * rental has no place on the council's statement while internally it matters.
 * Those are the presets. Everything is still adjustable underneath, because the
 * next question a council asks will not be one anybody predicted.
 */
const COUNCIL_PRESET: OperatingStatementOptions = {
  income: { Maintenance: 'total', Booking: 'excluded' }
};

export default function OperatingStatement({ units, payments, expenses, settings, session }: Props) {
  const [printing, setPrinting] = useState(false);
  const [incomeVis, setIncomeVis] = useState<Partial<Record<PaymentCategory, LineVisibility>>>(COUNCIL_PRESET.income || {});
  const [expenditureVis, setExpenditureVis] = useState<Record<string, LineVisibility>>({});
  const [showChooser, setShowChooser] = useState(false);
  const [preset, setPreset] = useState<Preset>('lastMonth');
  const [customFrom, setCustomFrom] = useState(() => addMonths(currentMonth(), -11));
  const [customTo, setCustomTo] = useState(() => currentMonth());

  const { from, to } = useMemo(() => {
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
        return { from: `${now.substring(0, 4)}-01-01`, to: monthEnd(now) };
      default:
        return { from: monthStart(customFrom), to: monthEnd(customTo) };
    }
  }, [preset, customFrom, customTo]);

  const invalidRange = to < from;

  const options: OperatingStatementOptions = useMemo(
    () => ({ income: incomeVis, expenditure: expenditureVis }),
    [incomeVis, expenditureVis]
  );

  const statements = useMemo(
    () =>
      invalidRange
        ? []
        : CURRENCIES.map(currency => operatingStatement(payments, expenses, units, currency, from, to, options)).filter(s => !s.empty),
    [payments, expenses, units, from, to, invalidRange, options]
  );

  /*
   * Which classes exist at all in this period, worked out with nothing hidden.
   *
   * The chooser has to offer a class even when the current selection is hiding
   * it — otherwise leaving something out removes the control that would put it
   * back, and the only way to recover is to change the period.
   */
  const present = useMemo(() => {
    if (invalidRange) return { income: [] as string[], expenditure: [] as string[] };
    const full = CURRENCIES.map(currency => operatingStatement(payments, expenses, units, currency, from, to));
    return {
      income: Array.from(new Set(full.flatMap(s => s.income.map(g => g.label)))),
      expenditure: Array.from(new Set(full.flatMap(s => s.expenditure.map(g => g.label))))
    };
  }, [payments, expenses, units, from, to, invalidRange]);

  const isCouncilView =
    incomeVis.Maintenance === 'total' && incomeVis.Booking === 'excluded' && Object.keys(expenditureVis).length === 0;
  const isInternalView = Object.keys(incomeVis).length === 0 && Object.keys(expenditureVis).length === 0;

  /*
   * A single month is named as a month ("August 2026"), and anything longer as a
   * span of dates. "1 Aug 2026 to 31 Aug 2026" on a monthly statement is just a
   * harder way to read the word August.
   */
  const period =
    monthStart(from.slice(0, 7)) === from && monthEnd(from.slice(0, 7)) === to
      ? formatMonthLabel(from.slice(0, 7))
      : `${formatDayLabel(from)} to ${formatDayLabel(to)}`;

  const exportWorkbook = () => {
    const sheets = statements.map(s => {
      const rows: XlsxCell[][] = [
        ...documentHeader({
          documentTitle: `Operating Statement — Income and Expenditure (${s.currency})`,
          period,
          generatedOn: formatDayLabel(today()),
          generatedBy: session.name,
          planNumber: settings.strataPlanNumber,
          span: 5
        }),
        [cell.section('Income', 5)],
        [cell.header('Date'), cell.header('Received from'), cell.header('Villa'), cell.header('Receipt'), cell.header('Amount', 'right')]
      ];

      for (const group of s.income) {
        rows.push([cell.section(group.itemised ? group.label : `${group.label} (total only)`, 5)]);
        for (const line of group.lines) {
          rows.push([cell.date(line.date), cell.text(line.payer), cell.text(line.villa || '—'), cell.text(line.reference), cell.money(line.amount, s.currency)]);
        }
        rows.push([cell.total(`Total ${group.label.toLowerCase()}`), cell.total(''), cell.total(''), cell.total(''), cell.totalMoney(group.total, s.currency)]);
      }
      rows.push([cell.total('TOTAL INCOME'), cell.total(''), cell.total(''), cell.total(''), cell.totalMoney(s.totalIncome, s.currency)]);

      rows.push([cell.blank()]);
      rows.push([cell.section('Expenditure', 5)]);
      rows.push([cell.header('Date'), cell.header('Paid to'), cell.header('What it was for'), cell.header('Allocation'), cell.header('Amount', 'right')]);
      for (const group of s.expenditure) {
        rows.push([cell.section(group.itemised ? group.label : `${group.label} (total only)`, 5)]);
        for (const line of group.lines) {
          rows.push([cell.date(line.date), cell.text(line.payee), cell.text(line.description || '—'), cell.text(line.allocation), cell.money(line.amount, s.currency)]);
        }
        rows.push([cell.total(`Total ${group.label.toLowerCase()}`), cell.total(''), cell.total(''), cell.total(''), cell.totalMoney(group.total, s.currency)]);
      }
      rows.push([cell.total('TOTAL EXPENDITURE'), cell.total(''), cell.total(''), cell.total(''), cell.totalMoney(s.totalExpenditure, s.currency)]);

      rows.push([cell.blank()]);
      rows.push([
        cell.total(s.surplus >= 0 ? 'SURPLUS FOR THE PERIOD' : 'DEFICIT FOR THE PERIOD'),
        cell.total(''),
        cell.total(''),
        cell.total(''),
        cell.totalMoney(s.surplus, s.currency)
      ]);
      if (s.excludedIncome.length > 0 || s.excludedExpenditure.length > 0) {
        rows.push([cell.blank()]);
        rows.push([cell.section('Not included in this statement', 5)]);
        for (const e of [...s.excludedIncome, ...s.excludedExpenditure]) {
          rows.push([cell.text(e.label), cell.text(''), cell.text(''), cell.text(''), cell.money(e.total, s.currency)]);
        }
        rows.push([cell.note('Left off deliberately and stated here, so the figures above are not read as the whole of the period.', 5)]);
      }

      rows.push([cell.blank()]);
      rows.push([
        cell.note(
          `All figures are in ${s.currency}. Prepared on a cash basis: income is counted when received and expenditure when paid, so the surplus agrees with the bank. USD and JMD are stated on separate sheets and are never combined.`,
          5
        )
      ]);

      const headerRow = rows.findIndex(r => r.some(cl => cl.style === 'header')) + 1;
      return { name: `Operating ${s.currency}`, widths: [14, 30, 42, 20, 18], rows, freezeRows: headerRow, repeatRow: headerRow };
    });

    if (sheets.length === 0) return;
    downloadWorkbook(sheets, `VDS Operating Statement ${from} to ${to}.xlsx`);
  };

  return (
    <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="font-display text-lg font-medium text-slate-900">Operating statement — income and expenditure</h2>
          <p className="text-xs text-slate-500">
            The document for the strata corporation: what came in and what went out, every payment named.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton onClick={exportWorkbook} disabled={statements.length === 0} className="flex items-center gap-1.5">
            <Download className="h-4 w-4" /> Export for Excel
          </SecondaryButton>
          <SubmitButton type="button" onClick={() => setPrinting(true)} disabled={statements.length === 0}>
            <Printer className="h-4 w-4" /> Print statement
          </SubmitButton>
        </div>
      </div>

      {invalidRange && <ErrorNote>The closing month must fall on or after the opening month.</ErrorNote>}

      <Field label="Statement period" htmlFor="op-preset">
        <div className="flex flex-wrap gap-2" id="op-preset">
          {PRESETS.map(pr => (
            <button
              key={pr.key}
              type="button"
              onClick={() => setPreset(pr.key)}
              aria-pressed={preset === pr.key}
              className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                preset === pr.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
              }`}
            >
              {pr.label}
            </button>
          ))}
        </div>
      </Field>

      {/*
        Whole months, both ends. Setting the same month in both gives a single
        month; different months give the span between them, inclusive — which
        covers "month by month", "a range of months" and a full year without
        needing a separate control for each.
      */}
      {preset === 'custom' && (
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-slate-500">From month</span>
            <input type="month" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className={monoInputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-slate-500">To month</span>
            <input type="month" value={customTo} onChange={e => setCustomTo(e.target.value)} className={monoInputClass} />
          </label>
          <p className="font-mono text-[10px] leading-relaxed text-slate-500">
            Set both to the same month for a single month. Whole months only.
          </p>
        </div>
      )}

      <p className="font-mono text-[11px] text-slate-600">
        Covering <strong>{period}</strong>
      </p>

      {/* ---------------- what goes on it ---------------- */}

      <Field label="What goes on this statement" htmlFor="op-audience">
        <div className="flex flex-wrap items-center gap-2" id="op-audience">
          <button
            type="button"
            onClick={() => {
              setIncomeVis(COUNCIL_PRESET.income || {});
              setExpenditureVis({});
            }}
            aria-pressed={isCouncilView}
            className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
              isCouncilView ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
            }`}
          >
            For the strata corporation
          </button>
          <button
            type="button"
            onClick={() => {
              setIncomeVis({});
              setExpenditureVis({});
            }}
            aria-pressed={isInternalView}
            className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
              isInternalView ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
            }`}
          >
            Internal — everything
          </button>
          <button
            type="button"
            onClick={() => setShowChooser(v => !v)}
            className="rounded-lg px-3 py-1.5 font-mono text-xs font-semibold text-teal-700 underline-offset-2 hover:underline"
          >
            {showChooser ? 'Hide' : 'Choose line by line'}
          </button>
        </div>
      </Field>

      <p className="font-mono text-[10px] leading-relaxed text-slate-500">
        <strong>For the strata corporation</strong> shows maintenance contributions as one figure rather than naming every
        proprietor, and leaves short-stay rental off. <strong>Internal</strong> shows everything, itemised. Expenditure is
        always named line by line unless you change it below.
      </p>

      {showChooser && (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 sm:grid-cols-2">
          <VisibilityList
            title="Income"
            classes={INCOME_CLASSES.filter(cl => present.income.includes(cl.label)).map(cl => ({ key: cl.category, label: cl.label }))}
            value={key => incomeVis[key as PaymentCategory] || 'itemised'}
            onChange={(key, next) => setIncomeVis(prev => ({ ...prev, [key]: next }))}
            emptyLabel="No income recorded in this period."
          />
          <VisibilityList
            title="Expenditure"
            classes={present.expenditure.map(label => ({ key: label, label }))}
            value={key => expenditureVis[key] || 'itemised'}
            onChange={(key, next) => setExpenditureVis(prev => ({ ...prev, [key]: next }))}
            emptyLabel="Nothing paid out in this period."
          />
        </div>
      )}

      <InfoNote>
        Income and expenditure only — no arrears ageing, collection rates or occupancy, which belong in the management
        report above. Every payment out is listed under its category with the person or company paid named beside the
        figure. Prepared on a cash basis, so the surplus is money that actually moved. <strong>Each currency is a
        separate statement</strong> and no total anywhere combines them.
      </InfoNote>

      {statements.length === 0 ? (
        <EmptyState title="Nothing received or paid in this period" hint="Choose a different period above." />
      ) : (
        statements.map(s => <CurrencyBlock key={s.currency} statement={s} />)
      )}

      {printing && (
        <StatementDocument
          statements={statements}
          period={period}
          settings={settings}
          generatedBy={session.name}
          onClose={() => setPrinting(false)}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function CurrencyBlock({ statement: s }: { statement: Statement }) {
  return (
    <div className="space-y-3 rounded-xl border border-slate-100 p-4">
      <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">{s.currency}</h3>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Total income" value={formatMoney(s.totalIncome, s.currency)} tone="positive" />
        <Tile label="Total expenditure" value={formatMoney(s.totalExpenditure, s.currency)} tone="negative" />
        <Tile
          label={s.surplus >= 0 ? 'Surplus for the period' : 'Deficit for the period'}
          value={formatMoney(Math.abs(s.surplus), s.currency)}
          tone={s.surplus >= 0 ? 'positive' : 'negative'}
          strong
        />
      </dl>

      <Ledger
        title="Income"
        columns={['Date', 'Received from', 'Villa', 'Receipt']}
        rows={s.income.map(g => ({
          label: g.label,
          total: g.total,
          lines: g.lines.map(l => ({ id: l.id, date: l.date, who: l.payer, what: l.villa, extra: l.reference, amount: l.amount }))
        }))}
        currency={s.currency}
        total={s.totalIncome}
        totalLabel="Total income"
        emptyLabel={
          s.excludedIncome.length > 0
            ? 'Nothing on this statement — income in the period was received under classes left off below.'
            : 'Nothing recorded in this period.'
        }
      />
      <Ledger
        title="Expenditure"
        columns={['Date', 'Paid to', 'What it was for', 'Allocation']}
        rows={s.expenditure.map(g => ({
          label: g.label,
          total: g.total,
          lines: g.lines.map(l => ({ id: l.id, date: l.date, who: l.payee, what: l.description, extra: l.allocation, amount: l.amount }))
        }))}
        currency={s.currency}
        total={s.totalExpenditure}
        totalLabel="Total expenditure"
        emptyLabel={
          s.excludedExpenditure.length > 0
            ? 'Nothing on this statement — expenditure in the period fell under classes left off below.'
            : 'Nothing recorded in this period.'
        }
      />

      <BooksNote statement={s} />

      <ExcludedNote statement={s} />
    </div>
  );
}

/**
 * What the statement deliberately leaves out.
 *
 * Stated on the page rather than silently dropped. A statement that quietly
 * omits a class of income is not a narrower document, it is a misleading one:
 * anybody reconciling it against the bank would find money they cannot place.
 */
/**
 * Which of the two books the expenditure above belongs to.
 *
 * This statement is deliberately combined — Ro, 2026-09-03: *"Keep it, it is my
 * all in view for the entire business which is important."* That is a legitimate
 * document to want, and an unlabelled one is a misleading document: it carries
 * the corporation's letterhead, and a reader has no way to tell the fund's costs
 * from the letting company's without being told which is which.
 *
 * The internal transfer is called out for the same reason. The contribution ISPO
 * pays on the villas it lets is income to the corporation and a cost to ISPO —
 * genuinely both, and genuinely the same money — so on a combined page it sits on
 * both sides and nets to nothing. Anyone reading the gross totals should know
 * that much of them is one transfer between the two books rather than money that
 * entered or left the group.
 */
function BooksNote({ statement: s }: { statement: Statement }) {
  if (s.ispoExpenditure === 0 && s.internalTransfer === 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
      <p className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">
        This statement carries both books
      </p>
      <dl className="space-y-1">
        <div className="flex justify-between gap-3">
          <dt>Expenditure of the body corporate</dt>
          <dd className="font-mono font-semibold">{formatMoney(s.strataExpenditure, s.currency)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Expenditure of {MANAGING_COMPANY_NAME}, paid from rental income</dt>
          <dd className="font-mono font-semibold">{formatMoney(s.ispoExpenditure, s.currency)}</dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-slate-200 pt-1 font-semibold text-slate-700">
          <dt>Total expenditure above</dt>
          <dd className="font-mono">{formatMoney(s.totalExpenditure, s.currency)}</dd>
        </div>
      </dl>
      {s.internalTransfer > 0 && (
        <p className="mt-2 border-t border-slate-200 pt-2">
          Of which <span className="font-mono font-semibold">{formatMoney(s.internalTransfer, s.currency)}</span> is the
          maintenance {MANAGING_COMPANY_NAME} paid on the villas it lets. It is a contribution the corporation received and a
          cost {MANAGING_COMPANY_NAME} bore — the same money on both sides of this page, counted once on each and netting to
          nothing between them, not money that entered or left the group.
        </p>
      )}
      <p className="mt-2 text-[10px] text-slate-500">
        The proprietors&rsquo; statements, the annual report and the returns to the Commission carry the corporation&rsquo;s
        costs only.
      </p>
    </div>
  );
}

function ExcludedNote({ statement: s }: { statement: Statement }) {
  const parts = [
    ...s.excludedIncome.map(e => `${e.label} ${formatMoney(e.total, s.currency)}`),
    ...s.excludedExpenditure.map(e => `${e.label} ${formatMoney(e.total, s.currency)}`)
  ];
  if (parts.length === 0) return null;
  return (
    <p className="rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-[10px] leading-relaxed text-slate-500">
      <strong>Not included in this statement:</strong> {parts.join(' · ')}. Deliberately left off, and named here so the
      figures above are not mistaken for the whole of the period.
    </p>
  );
}

/** A three-way control per class: itemised, total only, or left out. */
function VisibilityList({
  title,
  classes,
  value,
  onChange,
  emptyLabel
}: {
  title: string;
  classes: { key: string; label: string }[];
  value: (key: string) => LineVisibility;
  onChange: (key: string, next: LineVisibility) => void;
  emptyLabel: string;
}) {
  return (
    <div className="space-y-2">
      <h4 className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</h4>
      {classes.length === 0 ? (
        <p className="text-[11px] italic text-slate-500">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1.5">
          {classes.map(cl => (
            <li key={cl.key} className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-700">{cl.label}</span>
              <select
                aria-label={`How ${cl.label} appears`}
                value={value(cl.key)}
                onChange={e => onChange(cl.key, e.target.value as LineVisibility)}
                className={`${inputClass} h-8 w-32 py-0 text-xs`}
              >
                {VISIBILITIES.map(v => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One side of the statement, grouped by class with every line named.
 *
 * Both sides share this because they are the same shape: a heading that classes
 * the money, and under it the individual payments with a person or company on
 * each. A category that only ever showed a total would defeat the purpose of the
 * document.
 */
/**
 * One side of the statement, grouped by class with every line named.
 *
 * Both sides share this because they are the same shape: a heading that classes
 * the money, and under it the individual payments with a person or company on
 * each. A category that only ever showed a total would defeat the purpose of the
 * document.
 *
 * The caller maps its own fields onto `who` / `what` / `extra` rather than this
 * component guessing them. It used to read `reference ?? allocation`, which
 * silently chose the wrong field for expenditure — an expense's reference is
 * usually an empty string, and `??` only falls through on null, so every common
 * cost displayed its allocation as "—" instead of "General".
 */
interface LedgerLine {
  id: string;
  date: string;
  who: string;
  what: string;
  extra: string;
  amount: number;
}

function Ledger({
  title,
  columns,
  rows,
  currency,
  total,
  totalLabel,
  emptyLabel
}: {
  title: string;
  columns: string[];
  rows: { label: string; lines: LedgerLine[]; total: number }[];
  currency: Currency;
  total: number;
  totalLabel: string;
  emptyLabel: string;
}) {
  /*
   * "Nothing recorded in this period" is only true when nothing happened. When
   * a side is empty because its classes were left off, money *was* received or
   * paid and the statement must not imply otherwise — the caller passes the
   * wording that fits.
   */
  if (rows.length === 0) {
    return (
      <div className="space-y-1">
        <h4 className="font-display text-sm font-semibold text-slate-900">{title}</h4>
        <p className="text-xs italic text-slate-500">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="font-display text-sm font-semibold text-slate-900">{title}</h4>
      <TableScroller>
        <table className="w-full min-w-[640px] border-collapse text-left text-xs">
          <thead>
            <tr className={tableHeadRowClass}>
              {columns.map(col => (
                <th key={col} scope="col" className="p-3">
                  {col}
                </th>
              ))}
              <th scope="col" className="p-3 text-right">
                Amount
              </th>
            </tr>
          </thead>
          {rows.map(group => (
            <tbody key={group.label} className="divide-y divide-slate-50">
              <tr className="bg-slate-50/60">
                <td colSpan={columns.length} className="p-3 font-semibold text-slate-900">
                  {group.label}
                </td>
                <td className="p-3 text-right font-mono font-semibold text-slate-900">{formatMoney(group.total, currency)}</td>
              </tr>
              {group.lines.map(line => (
                <tr key={line.id}>
                  <td className="p-3 font-mono text-slate-500">{formatDayLabel(line.date)}</td>
                  <td className="p-3 font-medium text-slate-800">{line.who}</td>
                  <td className="p-3 text-slate-600">{line.what || '—'}</td>
                  <td className="p-3 font-mono text-[10px] text-slate-400">{line.extra || '—'}</td>
                  <td className={`p-3 text-right font-mono ${line.amount < 0 ? 'text-amber-700' : ''}`}>
                    {formatMoney(line.amount, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-semibold">
              <td colSpan={columns.length} className="p-3">
                {totalLabel}
              </td>
              <td className="p-3 text-right font-mono">{formatMoney(total, currency)}</td>
            </tr>
          </tfoot>
        </table>
      </TableScroller>
    </div>
  );
}

function Tile({ label, value, tone, strong }: { label: string; value: string; tone: 'positive' | 'negative'; strong?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${strong ? 'border-slate-300 bg-slate-50' : 'border-slate-100'}`}>
      <dt className="font-mono text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 font-mono text-lg ${tone === 'negative' ? 'text-rose-600' : 'text-emerald-700'}`}>{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StatementDocument({
  statements,
  period,
  settings,
  generatedBy,
  onClose
}: {
  statements: Statement[];
  period: string;
  settings: AppSettings;
  generatedBy: string;
  onClose: () => void;
}) {
  return (
    <PrintPortal title="Operating statement" subtitle={period} onClose={onClose} maxWidthClass="max-w-4xl">
      <PrintLetterhead documentTitle="Operating Statement" meta={`Income and expenditure · ${period}`} generatedBy={generatedBy} />

      <p className="mb-4 text-[11px] leading-relaxed">
        Income and expenditure of <strong>{bodyCorporateName(settings)}</strong> for the period stated. Every payment out
        is listed under its class with the person or company paid named against it. Prepared on a cash basis: income is
        counted when it was received and expenditure when it was paid.{' '}
        <strong>Each currency is reported separately and no figure combines them.</strong>
      </p>

      {statements.map(s => (
        <section key={s.currency} className="mb-8 break-inside-avoid">
          <h3 className="mb-2 border-b-2 border-slate-900 pb-1 text-sm font-bold uppercase tracking-wider">
            {s.currency} — {s.currency === 'JMD' ? 'Jamaican dollars' : 'United States dollars'}
          </h3>

          <PrintLedger
            title="Income"
            headings={['Date', 'Received from', 'Villa', 'Receipt']}
            rows={s.income.map(g => ({
              label: g.label,
              total: g.total,
              lines: g.lines.map(l => ({ id: l.id, date: l.date, who: l.payer, what: l.villa, extra: l.reference, amount: l.amount }))
            }))}
            currency={s.currency}
            total={s.totalIncome}
            totalLabel="Total income"
            emptyLabel={
              s.excludedIncome.length > 0
                ? 'Nothing on this statement — income in the period was received under classes left off below.'
                : 'Nothing recorded in this period.'
            }
          />
          <PrintLedger
            title="Expenditure"
            headings={['Date', 'Paid to', 'What it was for', 'Allocation']}
            rows={s.expenditure.map(g => ({
              label: g.label,
              total: g.total,
              lines: g.lines.map(l => ({ id: l.id, date: l.date, who: l.payee, what: l.description, extra: l.allocation, amount: l.amount }))
            }))}
            currency={s.currency}
            total={s.totalExpenditure}
            totalLabel="Total expenditure"
            emptyLabel={
              s.excludedExpenditure.length > 0
                ? 'Nothing on this statement — expenditure in the period fell under classes left off below.'
                : 'Nothing recorded in this period.'
            }
          />

          <table className="mt-3 w-full text-left text-[11px]">
            <tbody className="font-mono">
              <tr className="border-t-2 border-slate-900 font-bold">
                <td className="p-2">{s.surplus >= 0 ? `Surplus for the period (${s.currency})` : `Deficit for the period (${s.currency})`}</td>
                <td className="p-2 text-right">{formatMoney(Math.abs(s.surplus), s.currency)}</td>
              </tr>
            </tbody>
          </table>

          {(s.ispoExpenditure > 0 || s.internalTransfer > 0) && (
            <p className="mt-2 rounded border border-slate-300 p-2 text-[9px] leading-relaxed">
              <strong>This statement carries both books.</strong> Of the expenditure above,{' '}
              {formatMoney(s.strataExpenditure, s.currency)} is the body corporate&rsquo;s and{' '}
              {formatMoney(s.ispoExpenditure, s.currency)} is {MANAGING_COMPANY_NAME}&rsquo;s, paid from rental income.
              {s.internalTransfer > 0
                ? ` Of that, ${formatMoney(s.internalTransfer, s.currency)} is the maintenance ${MANAGING_COMPANY_NAME} paid on the villas it lets — a contribution the corporation received and a cost ${MANAGING_COMPANY_NAME} bore, being the same money on both sides of this page and counted once on each.`
                : ''}{' '}
              The proprietors&rsquo; statements, the annual report and the returns to the Commission carry the
              corporation&rsquo;s costs only.
            </p>
          )}

          {/* Said on the printed page too: the scope of the document travels with it. */}
          {(s.excludedIncome.length > 0 || s.excludedExpenditure.length > 0) && (
            <p className="mt-2 rounded border border-slate-300 p-2 text-[9px] leading-relaxed">
              <strong>Not included in this statement:</strong>{' '}
              {[...s.excludedIncome, ...s.excludedExpenditure]
                .map(e => `${e.label} ${formatMoney(e.total, s.currency)}`)
                .join(' · ')}
              . Left off deliberately and stated here, so the figures above are not read as the whole of the period.
            </p>
          )}
        </section>
      ))}

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        Prepared on a cash basis from the property's records for the period stated, and is not a tax document. USD and
        JMD are reported separately and are never combined; no figure on this statement has been converted. Indicative
        rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD, shown for reference only.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Received / Approved by" />
    </PrintPortal>
  );
}

function PrintLedger({
  title,
  headings,
  rows,
  currency,
  total,
  totalLabel,
  emptyLabel
}: {
  title: string;
  headings: string[];
  rows: { label: string; lines: LedgerLine[]; total: number }[];
  currency: Currency;
  total: number;
  totalLabel: string;
  emptyLabel: string;
}) {
  return (
    <div className="mb-4">
      <h4 className="mb-1 text-xs font-bold uppercase tracking-wider">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-[10px] italic text-slate-500">{emptyLabel}</p>
      ) : (
        <table className="w-full text-left text-[10px]">
          <thead>
            <tr className="border-b border-slate-400 font-mono text-[9px] uppercase text-slate-600">
              {headings.map(h => (
                <th key={h} className="p-1.5">
                  {h}
                </th>
              ))}
              <th className="p-1.5 text-right">Amount</th>
            </tr>
          </thead>
          {rows.map(group => (
            <tbody key={group.label} className="font-mono">
              <tr>
                <td colSpan={headings.length} className="p-1.5 pt-2 font-sans font-bold">
                  {group.label}
                </td>
                <td className="p-1.5 pt-2 text-right font-bold">{formatMoney(group.total, currency)}</td>
              </tr>
              {group.lines.map(line => (
                <tr key={line.id}>
                  <td className="p-1.5">{formatDayLabel(line.date)}</td>
                  <td className="p-1.5 font-sans">{line.who}</td>
                  <td className="p-1.5 font-sans">{line.what || '—'}</td>
                  <td className="p-1.5">{line.extra || '—'}</td>
                  <td className="p-1.5 text-right">{formatMoney(line.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot>
            <tr className="border-t border-slate-400 font-mono font-bold">
              <td colSpan={headings.length} className="p-1.5">
                {totalLabel}
              </td>
              <td className="p-1.5 text-right">{formatMoney(total, currency)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
