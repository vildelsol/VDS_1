/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The owners' annual report, for the annual general meeting.
 *
 * **This is not the Commission's return.** Forms 13A/13B/13C are a statutory
 * filing keyed by strata lot — what each proprietor owes, aged. This is the
 * document circulated to owners before the meeting, it is identical for every
 * owner, and it carries nothing personal: no unit balances, no arrears by name.
 * Ro, 2026-08-16, asked directly: "it has to do with how the property is run, not
 * their unit nor their finances." Do not merge owner data into it. The same
 * figures are what goes on to the Commission.
 *
 * **The shape of the screen is the point.** The figures, tables and charts are
 * generated from the ledger into fixed slots; the eight boxes down the left are
 * the only things typed. That is deliberate and is the safety property of the
 * whole feature: nobody can type over a number, so the arithmetic in the printed
 * document is always the arithmetic in the books. The 2026 report this replaces
 * had to carry a corrections log because percentages were typed beside figures
 * that did not produce them — a full document editor would reintroduce exactly
 * that failure, which is why this is a form and not a canvas.
 *
 * The narrative persists per year, so opening 2028 starts from 2027's wording
 * with every figure recomputed rather than from a blank page.
 */

import { useMemo, useState } from 'react';
import { AppSettings, Charge, Currency, Expense, Payment, Unit, AnnualReport as AnnualReportRecord, ANNUAL_REPORT_SECTIONS, AnnualReportSectionKey, bodyCorporateName } from '../types';
import { AnnualOwnersReport, annualOwnersReport } from '../lib/finance';
import { formatMoney } from '../lib/money';
import { formatDayLabel, formatMonthLabel, today } from '../lib/dates';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import MonthlyOwnersReport from './MonthlyOwnersReport';
import { EmptyState, ErrorNote, InfoNote, SubmitButton, SecondaryButton, TableScroller, inputClass, monoInputClass, tableHeadRowClass, Badge } from './ui';

interface AnnualReportProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  settings: AppSettings;
  reports: AnnualReportRecord[];
  currentUserName: string;
  canEdit: boolean;
  onSave: (year: number, patch: Partial<AnnualReportRecord>) => Promise<unknown>;
}

const pctLabel = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

export default function AnnualReport({
  units,
  charges,
  payments,
  expenses,
  settings,
  reports,
  currentUserName,
  canEdit,
  onSave
}: AnnualReportProps) {
  // Default to last year: the report is written about a year that has finished.
  /*
   * Two documents to proprietors live on this screen. Ro, 2026-09-02: *"we can
   * include a tab section within that area that gives the option for a monthly
   * report."* They belong together because they obey the same rule — identical
   * for every owner, nothing personal — and differ only in the period they
   * cover and whether anything on them is written by hand.
   */
  const [view, setView] = useState<'annual' | 'monthly'>('annual');
  const [year, setYear] = useState(() => new Date().getFullYear() - 1);
  const [currency, setCurrency] = useState<Currency>('JMD');
  const [printing, setPrinting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const stored = useMemo(() => reports.find(r => r.year === year), [reports, year]);

  /**
   * Draft state. Seeded from the stored record and re-seeded when the year
   * changes, so switching years never carries one year's wording into another.
   */
  const [draft, setDraft] = useState<Partial<AnnualReportRecord>>({});
  const [draftYear, setDraftYear] = useState(year);
  if (draftYear !== year) {
    setDraftYear(year);
    setDraft({});
  }

  const narrative = { ...(stored?.narrative || {}), ...(draft.narrative || {}) };
  const budgetByCategory = { ...(stored?.budgetByCategory || {}), ...(draft.budgetByCategory || {}) };
  const proposedFee = draft.proposedFee !== undefined ? draft.proposedFee : stored?.proposedFee;
  const meetingDate = draft.meetingDate !== undefined ? draft.meetingDate : stored?.meetingDate;

  const report: AnnualOwnersReport = useMemo(
    () =>
      annualOwnersReport(units, charges, payments, expenses, currency, year, {
        budgetByCategory,
        proposedFee: proposedFee || undefined
      }),
    [units, charges, payments, expenses, currency, year, JSON.stringify(budgetByCategory), proposedFee]
  );

  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await onSave(year, { currency, narrative, budgetByCategory, proposedFee, meetingDate });
      setDraft({});
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the report.');
    } finally {
      setSaving(false);
    }
  };

  const setNarrative = (key: AnnualReportSectionKey, value: string) =>
    setDraft(d => ({ ...d, narrative: { ...(d.narrative || {}), [key]: value } }));

  const setBudget = (category: string, value: string) =>
    setDraft(d => ({
      ...d,
      budgetByCategory: { ...(d.budgetByCategory || {}), [category]: value === '' ? undefined : Number(value) } as Record<string, number>
    }));

  /**
   * The whole report as a spreadsheet — figures *and* narrative.
   *
   * Ro asked for this so adjustments can be made outside the application before
   * a document goes out. It carries the written sections too, not only the
   * tables: a committee that has to retype the wording will retype it wrongly.
   *
   * Figures are exported unformatted (`1976334`, not `J$1,976,334.00`) so Excel
   * reads them as numbers and they can be summed and re-worked. Currency and
   * scale are stated in the header instead.
   *
   * CSV with a byte-order mark, the same pattern as Projections and Owner
   * Statements — Excel opens it directly with accents and symbols intact.
   */
  const downloadSpreadsheet = () => {
    const cur = report.currency;
    const pair = (label: string, value: number) => [cell.text(label), cell.money(value, cur)];
    const period = `${report.reportYear} reported · ${report.budgetYear} budget`;

    const positionRows: XlsxCell[][] = [
      ...documentHeader({
        documentTitle: `${bodyCorporateName(settings)} — Annual Report`,
        period,
        generatedOn: formatDayLabel(today()),
        generatedBy: currentUserName,
        planNumber: settings.strataPlanNumber,
        span: 4
      }),
      [cell.section('The position', 4)],
      [cell.header('Measure'), cell.header('Amount', 'right')],
      [cell.text('Contributing villas'), cell.number(report.contributingUnits)],
      pair('Total expenditure', report.expenditure),
      pair('Cost per villa, annual', report.perUnitAnnual),
      pair('Cost per villa, monthly', report.perUnitMonthly),
      pair('Contribution billed, monthly', report.feeBilled),
      pair('Monthly position per villa', report.monthlyPositionPerUnit),
      pair('Annual community position', report.annualCommunityPosition),
      pair('Contributions received', report.received),
      [cell.text('Collection rate %'), report.collectionRatePct === null ? cell.muted('n/a') : cell.number(report.collectionRatePct)],
      [cell.blank()],
      [cell.section('Lever 1 — raise the contribution', 4)],
      pair('Contribution needed to cover the budget', report.feeToCoverBudget),
      pair('Contribution proposed', report.proposedFee),
      pair('Reserve per villa, monthly', report.reservePerUnitMonthly),
      pair('Reserve, annual', report.reserveAnnual),
      [cell.blank()],
      [cell.section('Lever 2 — cut the expenditure', 4)],
      pair('Expenditure ceiling at the current contribution', report.expenditureCeiling),
      pair('Reduction required', report.reductionRequired),
      [cell.blank()],
      [cell.note(`All amounts are in ${cur}. Figures are real numbers, so any column can be re-totalled.`, 4)]
    ];

    const budgetRows: XlsxCell[][] = [
      ...documentHeader({ documentTitle: `Budget ${report.budgetYear}`, period, generatedOn: formatDayLabel(today()), generatedBy: currentUserName, planNumber: settings.strataPlanNumber, span: 7 }),
      [
        cell.header('Category'),
        cell.header(`${report.reportYear - 1} actual`, 'right'),
        cell.header(`${report.reportYear} actual`, 'right'),
        cell.header('Change %', 'right'),
        cell.header(`${report.budgetYear} budget`, 'right'),
        cell.header('Budget change %', 'right'),
        cell.header('Share %', 'right')
      ]
    ];
    for (const c of report.categories) {
      budgetRows.push([
        cell.text(c.category),
        cell.money(c.prior, cur),
        cell.money(c.actual, cur),
        c.priorChangePct === null ? cell.muted('n/a') : cell.number(c.priorChangePct),
        cell.money(c.budget, cur),
        c.budgetChangePct === null ? cell.muted('n/a') : cell.number(c.budgetChangePct),
        cell.number(c.budgetShare)
      ]);
    }
    budgetRows.push([
      cell.total('Total'),
      cell.totalMoney(report.priorExpenditure, cur),
      cell.totalMoney(report.expenditure, cur),
      cell.total(''),
      cell.totalMoney(report.budgetExpenditure, cur),
      cell.total(''),
      cell.total('100')
    ]);

    const monthRows: XlsxCell[][] = [
      ...documentHeader({ documentTitle: 'Month by month', period, generatedOn: formatDayLabel(today()), generatedBy: currentUserName, planNumber: settings.strataPlanNumber, span: 5 }),
      [cell.header('Month'), cell.header('Expenditure', 'right'), cell.header('Contribution', 'right'), cell.header('Received', 'right'), cell.header('Shortfall', 'right')]
    ];
    for (const m of report.months) {
      monthRows.push([
        cell.text(formatMonthLabel(m.month)),
        cell.money(m.expenditure, cur),
        cell.money(m.income, cur),
        cell.money(m.received, cur),
        cell.money(m.shortfall, cur)
      ]);
    }

    /*
     * The written sections travel with the figures so a committee can finish the
     * document outside the application without retyping it — and retyping it is
     * how wording gets changed by accident.
     */
    const narrativeRows: XlsxCell[][] = [
      ...documentHeader({ documentTitle: 'Written sections', period, generatedOn: formatDayLabel(today()), generatedBy: currentUserName, planNumber: settings.strataPlanNumber, span: 2 }),
      [cell.header('Section'), cell.header('Text')]
    ];
    for (const section of ANNUAL_REPORT_SECTIONS) {
      narrativeRows.push([cell.text(section.label), cell.note((narrative[section.key] || '').trim(), 1)]);
    }

    /*
     * The header row differs by sheet, so it is counted rather than assumed.
     * "The position" carries a section band between the masthead and its column
     * headers and the others do not — freezing the same row number on all four
     * would freeze a data row on three of them and repeat the wrong line at the
     * top of every printed page.
     */
    const headerRowOf = (rows: XlsxCell[][]) => {
      const at = rows.findIndex(r => r.some(c => c.style === 'header' || c.style === 'headerRight'));
      return at >= 0 ? at + 1 : 1;
    };

    downloadWorkbook(
      [
        { name: 'The position', widths: [46, 22], rows: positionRows, freezeRows: headerRowOf(positionRows), repeatRow: headerRowOf(positionRows) },
        { name: `Budget ${report.budgetYear}`, widths: [26, 18, 18, 14, 18, 18, 12], rows: budgetRows, freezeRows: headerRowOf(budgetRows), repeatRow: headerRowOf(budgetRows), landscape: true },
        { name: 'Month by month', widths: [20, 18, 18, 18, 18], rows: monthRows, freezeRows: headerRowOf(monthRows), repeatRow: headerRowOf(monthRows) },
        { name: 'Written sections', widths: [30, 100], rows: narrativeRows, freezeRows: headerRowOf(narrativeRows), repeatRow: headerRowOf(narrativeRows), landscape: true }
      ],
      `VDS Annual Report ${report.reportYear}.xlsx`
    );
  };

  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return Array.from({ length: 7 }, (_, i) => now + 1 - i);
  }, []);

  const hasFigures = report.expenditure > 0 || report.contributingUnits > 0;

  const tabClass = (active: boolean) =>
    `rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
      active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
    }`;

  if (view === 'monthly') {
    return (
      <div className="space-y-6">
        <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setView('annual')} aria-pressed={false} className={tabClass(false)}>
              Annual report
            </button>
            <button type="button" onClick={() => setView('monthly')} aria-pressed className={tabClass(true)}>
              Monthly report
            </button>
          </div>
          <MonthlyOwnersReport
            units={units}
            charges={charges}
            payments={payments}
            expenses={expenses}
            settings={settings}
            generatedBy={currentUserName}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setView('annual')} aria-pressed className={tabClass(true)}>
            Annual report
          </button>
          <button type="button" onClick={() => setView('monthly')} aria-pressed={false} className={tabClass(false)}>
            Monthly report
          </button>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">Annual report</h2>
            <p className="mt-1 max-w-3xl text-xs text-slate-500">
              The document circulated to proprietors before the annual general meeting, and the basis of what goes to the
              Commission of Strata Corporations. It is the same for every owner and carries no personal account
              information. Every figure below is computed from the ledger — only the written sections are typed.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-medium text-slate-600">
              <span className="mb-1 block">Year reported</span>
              <select className={inputClass} value={year} onChange={e => setYear(Number(e.target.value))}>
                {years.map(y => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              <span className="mb-1 block">Currency</span>
              <select className={inputClass} value={currency} onChange={e => setCurrency(e.target.value as Currency)}>
                <option value="JMD">JMD</option>
                <option value="USD">USD</option>
              </select>
            </label>
            <SecondaryButton onClick={downloadSpreadsheet} disabled={!hasFigures}>
              Export figures
            </SecondaryButton>
            <SubmitButton onClick={() => setPrinting(true)} disabled={!hasFigures}>
              Preview &amp; print
            </SubmitButton>
          </div>
        </div>

        {stored && (
          <p className="text-[11px] text-slate-400">
            Last saved {formatDayLabel(stored.updatedAt.slice(0, 10))} by {stored.updatedBy}.
          </p>
        )}
      </section>

      {!hasFigures ? (
        <EmptyState
          title={`Nothing recorded for ${year} in ${currency}`}
          hint="Record the year's expenditure and set each villa's maintenance contribution, then the report can be built."
        />
      ) : (
        <>
          <PositionPanel report={report} />
          <LeversPanel report={report} />

          <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Budget for {report.budgetYear}
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Each line starts at what it actually cost in {report.reportYear}. Change only what you expect to move —
                a line left alone is budgeted flat, never at zero. Setting a line to <span className="font-mono">0</span>{' '}
                is how a service is cut, which is the second lever above.
              </p>
            </div>
            <TableScroller>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className={tableHeadRowClass}>
                    <th scope="col" className="p-3">Category</th>
                    <th scope="col" className="p-3 text-right">{report.reportYear - 1}</th>
                    <th scope="col" className="p-3 text-right">{report.reportYear}</th>
                    <th scope="col" className="p-3 text-right">Change</th>
                    <th scope="col" className="p-3 text-right">{report.budgetYear} budget</th>
                    <th scope="col" className="p-3 text-right">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.categories.map(c => (
                    <tr key={c.category}>
                      <td className="p-3 font-medium text-slate-800">{c.category}</td>
                      <td className="p-3 text-right font-mono text-slate-400">{formatMoney(c.prior, report.currency)}</td>
                      <td className="p-3 text-right font-mono text-slate-600">{formatMoney(c.actual, report.currency)}</td>
                      <td className={`p-3 text-right font-mono ${(c.priorChangePct ?? 0) > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {pctLabel(c.priorChangePct)}
                      </td>
                      <td className="p-3 text-right">
                        <input
                          className={`${monoInputClass} w-32 text-right`}
                          type="number"
                          min="0"
                          step="0.01"
                          disabled={!canEdit}
                          value={budgetByCategory[c.category] ?? c.actual}
                          onChange={e => setBudget(c.category, e.target.value)}
                        />
                      </td>
                      <td className="p-3 text-right font-mono text-slate-500">{c.budgetShare.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 font-semibold">
                    <td className="p-3">Total</td>
                    <td className="p-3 text-right font-mono">{formatMoney(report.priorExpenditure, report.currency)}</td>
                    <td className="p-3 text-right font-mono">{formatMoney(report.expenditure, report.currency)}</td>
                    <td className="p-3 text-right font-mono">{pctLabel(report.expenditureChangePct)}</td>
                    <td className="p-3 text-right font-mono">{formatMoney(report.budgetExpenditure, report.currency)}</td>
                    <td className="p-3 text-right font-mono">100%</td>
                  </tr>
                </tfoot>
              </table>
            </TableScroller>
          </section>

          <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-xs font-medium text-slate-600">
                <span className="mb-1 block">Contribution proposed to the meeting (per villa, monthly)</span>
                <input
                  className={`${monoInputClass} w-48`}
                  type="number"
                  min="0"
                  step="0.01"
                  disabled={!canEdit}
                  placeholder={String(report.feeToCoverBudget)}
                  value={proposedFee ?? ''}
                  onChange={e => setDraft(d => ({ ...d, proposedFee: e.target.value === '' ? undefined : Number(e.target.value) }))}
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                <span className="mb-1 block">Meeting date</span>
                <input
                  className={inputClass}
                  type="date"
                  disabled={!canEdit}
                  value={meetingDate ?? ''}
                  onChange={e => setDraft(d => ({ ...d, meetingDate: e.target.value || undefined }))}
                />
              </label>
              <p className="text-[11px] text-slate-500">
                Left blank, the report proposes exactly what the budget requires —{' '}
                <span className="font-mono">{formatMoney(report.feeToCoverBudget, report.currency)}</span> — and holds
                nothing back as reserve.
              </p>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-900">What the report says</h3>
              <p className="mt-1 text-xs text-slate-500">
                The written sections. Everything else in the document is generated from the ledger. Keep figures out of
                these boxes — a number typed here is one nothing recomputes, and it is how a report ends up needing a
                corrections log.
              </p>
            </div>
            <div className="space-y-4">
              {ANNUAL_REPORT_SECTIONS.map(section => (
                <label key={section.key} className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-700">{section.label}</span>
                  <span className="mb-1 block text-[11px] text-slate-400">{section.hint}</span>
                  <textarea
                    className={`${inputClass} min-h-24`}
                    rows={4}
                    disabled={!canEdit}
                    value={narrative[section.key] ?? ''}
                    onChange={e => setNarrative(section.key, e.target.value)}
                  />
                </label>
              ))}
            </div>

            {error && <ErrorNote>{error}</ErrorNote>}
            {saved && !dirty && <InfoNote>Saved. Next year's report will open with this wording.</InfoNote>}
            {!canEdit && <InfoNote tone="amber">You do not have permission to change this report.</InfoNote>}

            <div className="flex items-center gap-3">
              <SubmitButton onClick={save} disabled={!canEdit || saving || !dirty}>
                {saving ? 'Saving…' : dirty ? 'Save report' : 'Saved'}
              </SubmitButton>
              {dirty && <span className="text-[11px] text-amber-600">Unsaved changes.</span>}
            </div>
          </section>
        </>
      )}

      {printing && (
        <PrintPortal
          title={`Annual report ${report.reportYear}`}
          subtitle={bodyCorporateName(settings)}
          onClose={() => setPrinting(false)}
          maxWidthClass="max-w-4xl"
        >
          <PrintedReport report={report} narrative={narrative} settings={settings} generatedBy={currentUserName} meetingDate={meetingDate} />
        </PrintPortal>
      )}
    </div>
  );
}

/** The headline: what it costs against what the contribution raises. */
function PositionPanel({ report }: { report: AnnualOwnersReport }) {
  const short = report.annualCommunityPosition < 0;
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Stat label={`${report.reportYear} expenditure`} value={formatMoney(report.expenditure, report.currency)} detail={`${pctLabel(report.expenditureChangePct)} on ${report.reportYear - 1}`} />
      <Stat label="Cost per villa, monthly" value={formatMoney(report.perUnitMonthly, report.currency)} detail={`across ${report.contributingUnits} contributing villa${report.contributingUnits === 1 ? '' : 's'}`} />
      <Stat label="Contribution billed" value={formatMoney(report.feeBilled, report.currency)} detail="per villa, per month" />
      <Stat
        label={short ? 'Shortfall absorbed' : 'Surplus'}
        value={formatMoney(Math.abs(report.annualCommunityPosition), report.currency)}
        detail={`${formatMoney(Math.abs(report.monthlyPositionPerUnit), report.currency)} per villa per month`}
        tone={short ? 'negative' : 'positive'}
      />
    </section>
  );
}

/**
 * The two levers, side by side.
 *
 * Both are shown always, because the second is what the meeting turns to when it
 * declines the first, and a document that only argues for an increase has no
 * answer when owners say no.
 */
function LeversPanel({ report }: { report: AnnualOwnersReport }) {
  const closers = report.cutsThatWouldClose.filter(c => c.closesGap);
  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="space-y-2 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-slate-900">Raise the contribution</h3>
          <Badge tone="teal">Lever 1</Badge>
        </div>
        <Row label={`${report.budgetYear} budget`} value={formatMoney(report.budgetExpenditure, report.currency)} />
        <Row label="Contribution needed" value={formatMoney(report.feeToCoverBudget, report.currency)} strong />
        <Row label="Contribution proposed" value={formatMoney(report.proposedFee, report.currency)} />
        <Row
          label={report.reservePerUnitMonthly < 0 ? 'Still short, per villa monthly' : 'To reserve, per villa monthly'}
          value={formatMoney(Math.abs(report.reservePerUnitMonthly), report.currency)}
          tone={report.reservePerUnitMonthly < 0 ? 'negative' : 'positive'}
        />
        <Row
          label={report.reserveAnnual < 0 ? 'Still short, annually' : 'Reserve, annually'}
          value={formatMoney(Math.abs(report.reserveAnnual), report.currency)}
          tone={report.reserveAnnual < 0 ? 'negative' : 'positive'}
        />
      </div>

      <div className="space-y-2 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-slate-900">Or cut the expenditure</h3>
          <Badge tone="amber">Lever 2</Badge>
        </div>
        <p className="text-[11px] text-slate-500">
          If the increase is not approved, this is what the property has to fit inside.
        </p>
        <Row label="Current contribution raises" value={formatMoney(report.expenditureCeiling, report.currency)} />
        <Row label={`${report.budgetYear} budget`} value={formatMoney(report.budgetExpenditure, report.currency)} />
        <Row label="Must come out" value={formatMoney(report.reductionRequired, report.currency)} strong tone={report.reductionRequired > 0 ? 'negative' : 'positive'} />
        {report.reductionRequired > 0 && (
          <p className="pt-1 text-[11px] text-slate-500">
            {closers.length > 0
              ? `Removing ${closers[closers.length - 1].category} entirely (${formatMoney(closers[closers.length - 1].budget, report.currency)}) would close it.`
              : 'No single category is large enough to close it — it would take more than one.'}
          </p>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'negative' | 'positive' }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold ${tone === 'negative' ? 'text-rose-600' : tone === 'positive' ? 'text-emerald-600' : 'text-slate-900'}`}>{value}</p>
      {detail && <p className="mt-1 text-[11px] text-slate-500">{detail}</p>}
    </div>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'negative' | 'positive' }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-50 py-1.5 last:border-0">
      <span className="text-xs text-slate-600">{label}</span>
      <span className={`font-mono text-sm ${strong ? 'font-semibold' : ''} ${tone === 'negative' ? 'text-rose-600' : tone === 'positive' ? 'text-emerald-600' : 'text-slate-900'}`}>{value}</span>
    </div>
  );
}

/**
 * The document itself.
 *
 * Narrative and figures alternate in fixed slots and never interleave inside a
 * paragraph: a written section is followed by the table or chart that evidences
 * it, so nothing has to be restated in prose to be visible. That separation is
 * what stops the two drifting apart.
 */
function PrintedReport({
  report,
  narrative,
  settings,
  generatedBy,
  meetingDate
}: {
  report: AnnualOwnersReport;
  narrative: Partial<Record<AnnualReportSectionKey, string>>;
  settings: AppSettings;
  generatedBy: string;
  meetingDate?: string;
}) {
  const say = (key: AnnualReportSectionKey) => (narrative[key] || '').trim();
  const short = report.annualCommunityPosition < 0;

  return (
    <div className="text-[13px] leading-relaxed text-slate-800">
      <PrintLetterhead
        documentTitle={`Annual Report — ${report.reportYear}`}
        meta={`Year reported ${report.reportYear} · Budget ${report.budgetYear} · All figures in ${report.currency}${meetingDate ? ` · Meeting ${formatDayLabel(meetingDate)}` : ''}`}
        generatedBy={generatedBy}
      />

      <p className="mb-6 text-[11px] text-slate-500">
        Prepared for circulation to registered proprietors of {bodyCorporateName(settings)}. This report concerns the
        operation of the property as a whole and contains no individual account information. It is the companion to the
        statutory filing made with the Commission of Strata Corporations of Jamaica.
      </p>

      <Section n={1} title="Executive summary" body={say('executiveSummary')} />

      <table className="mb-6 w-full border-collapse text-[12px]">
        <tbody>
          <FigureRow label={`Total expenditure, ${report.reportYear}`} value={formatMoney(report.expenditure, report.currency)} />
          <FigureRow label="Cost per villa, annual" value={formatMoney(report.perUnitAnnual, report.currency)} />
          <FigureRow label="Cost per villa, monthly" value={formatMoney(report.perUnitMonthly, report.currency)} />
          <FigureRow label="Contribution billed, monthly" value={formatMoney(report.feeBilled, report.currency)} />
          <FigureRow
            label="Monthly position per villa"
            value={`${formatMoney(Math.abs(report.monthlyPositionPerUnit), report.currency)} ${short ? 'deficit' : 'surplus'}`}
          />
          <FigureRow
            label="Annual community position"
            value={`${formatMoney(Math.abs(report.annualCommunityPosition), report.currency)} ${short ? 'absorbed' : 'surplus'}`}
            strong
          />
        </tbody>
      </table>

      <Section n={2} title="What it costs to run the property" body={say('costContext')} />
      <Section n={3} title="What each category contains" body={say('categoryNotes')} />

      <h3 className="mb-2 mt-6 font-display text-sm font-semibold">
        Expenditure by category — {report.reportYear} against {report.budgetYear}
      </h3>
      <table className="mb-6 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b-2 border-slate-800 text-left">
            <th className="py-1.5">Category</th>
            <th className="py-1.5 text-right">{report.reportYear - 1}</th>
            <th className="py-1.5 text-right">{report.reportYear}</th>
            <th className="py-1.5 text-right">Change</th>
            <th className="py-1.5 text-right">{report.budgetYear}</th>
            <th className="py-1.5 text-right">Share</th>
          </tr>
        </thead>
        <tbody>
          {report.categories.map(c => (
            <tr key={c.category} className="border-b border-slate-100">
              <td className="py-1.5">{c.category}</td>
              <td className="py-1.5 text-right font-mono">{formatMoney(c.prior, report.currency)}</td>
              <td className="py-1.5 text-right font-mono">{formatMoney(c.actual, report.currency)}</td>
              <td className="py-1.5 text-right font-mono">{pctLabel(c.priorChangePct)}</td>
              <td className="py-1.5 text-right font-mono">{formatMoney(c.budget, report.currency)}</td>
              <td className="py-1.5 text-right font-mono">{c.budgetShare.toFixed(1)}%</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-800 font-semibold">
            <td className="py-1.5">Total</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.priorExpenditure, report.currency)}</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.expenditure, report.currency)}</td>
            <td className="py-1.5 text-right font-mono">{pctLabel(report.expenditureChangePct)}</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.budgetExpenditure, report.currency)}</td>
            <td className="py-1.5 text-right font-mono">100%</td>
          </tr>
        </tbody>
      </table>

      <Section n={4} title="What the movements tell us" body={say('movements')} />

      <h3 className="mb-2 mt-6 font-display text-sm font-semibold">Month by month, {report.reportYear}</h3>
      <table className="mb-2 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b-2 border-slate-800 text-left">
            <th className="py-1.5">Month</th>
            <th className="py-1.5 text-right">Expenditure</th>
            <th className="py-1.5 text-right">Contribution</th>
            <th className="py-1.5 text-right">Shortfall</th>
          </tr>
        </thead>
        <tbody>
          {report.months.map(m => (
            <tr key={m.month} className="border-b border-slate-100">
              <td className="py-1.5">{m.month}</td>
              <td className="py-1.5 text-right font-mono">{formatMoney(m.expenditure, report.currency)}</td>
              <td className="py-1.5 text-right font-mono">{formatMoney(m.income, report.currency)}</td>
              <td className={`py-1.5 text-right font-mono ${m.shortfall > 0 ? 'font-semibold' : ''}`}>
                {m.shortfall > 0 ? formatMoney(m.shortfall, report.currency) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mb-6 text-[11px] text-slate-500">
        Expenditure exceeded the contribution in {report.monthsOver.length} of twelve months
        {report.monthsOver.length > 0 ? ` (${report.monthsOver.join(', ')})` : ''}.
      </p>

      <Section n={5} title="Recommendation" body={say('recommendation')} />

      <table className="mb-6 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b-2 border-slate-800 text-left">
            <th className="py-1.5">Allocation of the proposed contribution</th>
            <th className="py-1.5 text-right">Per villa, monthly</th>
            <th className="py-1.5 text-right">Community, annual</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-slate-100">
            <td className="py-1.5">Projected operating expenditure</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.feeToCoverBudget, report.currency)}</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.budgetExpenditure, report.currency)}</td>
          </tr>
          <tr className="border-b border-slate-100">
            <td className="py-1.5">{report.reservePerUnitMonthly < 0 ? 'Remaining shortfall' : 'Reserve and contingency'}</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.reservePerUnitMonthly, report.currency)}</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.reserveAnnual, report.currency)}</td>
          </tr>
          <tr className="border-t-2 border-slate-800 font-semibold">
            <td className="py-1.5">Total proposed</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.proposedFee, report.currency)}</td>
            <td className="py-1.5 text-right font-mono">{formatMoney(report.proposedAnnualCommunity, report.currency)}</td>
          </tr>
        </tbody>
      </table>

      <Section n={6} title="If the increase is not approved" body={say('alternatives')} />

      <table className="mb-6 w-full border-collapse text-[12px]">
        <tbody>
          <FigureRow label="The current contribution raises" value={formatMoney(report.expenditureCeiling, report.currency)} />
          <FigureRow label={`${report.budgetYear} budgeted expenditure`} value={formatMoney(report.budgetExpenditure, report.currency)} />
          <FigureRow label="Expenditure that must be removed" value={formatMoney(report.reductionRequired, report.currency)} strong />
        </tbody>
      </table>

      <Section n={7} title="Risks of deferring" body={say('risks')} />
      <Section n={8} title="Next steps" body={say('nextSteps')} />

      <p className="mt-8 text-[11px] text-slate-500">
        Figures are computed from the corporation's own records for the year ended 31 December {report.reportYear}. Only
        expenditure actually settled in the year is counted; bills outstanding at the year end are reported to the
        Commission on Form 13C. Contributions are stated at the amount assessed across {report.contributingUnits}{' '}
        contributing villa{report.contributingUnits === 1 ? '' : 's'}. {report.budgetYear} figures are estimates and
        remain subject to contract renewal, utility tariffs and inflation. This document is provided for the information
        of proprietors and does not constitute legal or investment advice.
      </p>

      <PrintSignatures left="Chairman" right="Executive Committee Member" />
    </div>
  );
}

/** A written section. Renders nothing at all when nobody has written it. */
function Section({ n, title, body }: { n: number; title: string; body: string }) {
  if (!body) return null;
  return (
    <section className="mb-6 break-inside-avoid">
      <h3 className="mb-2 font-display text-sm font-semibold">
        {n}. {title}
      </h3>
      {body.split(/\n{2,}/).map((para, i) => (
        <p key={i} className="mb-2 whitespace-pre-line">
          {para}
        </p>
      ))}
    </section>
  );
}

function FigureRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className={`border-b border-slate-100 ${strong ? 'font-semibold' : ''}`}>
      <td className="py-1.5">{label}</td>
      <td className="py-1.5 text-right font-mono">{value}</td>
    </tr>
  );
}
