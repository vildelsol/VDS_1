/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The owners' monthly report — how the property ran, in one month.
 *
 * Asked for by Ro on 2026-09-02: *"a monthly report that we may be able to give
 * our owners should they ask"*, as a tab beside the annual report. It belongs
 * there because it obeys the annual report's rule, and that rule is the whole
 * design: **identical for every owner, carrying nothing personal.** No lot
 * balances, no proprietor named, nothing about anybody's own villa. Ro,
 * 2026-08-16: *"it has to do with how the property is run, not their unit nor
 * their finances."* Making the period shorter does not relax it.
 *
 * **Everything on it is generated; nothing is typed.** The annual report has
 * eight narrative boxes because it argues a case to a meeting. This one reports a
 * month, so there is no wording to drift out of step with a figure and nothing to
 * save — every number is recomputed from the ledger each time it is opened, and a
 * corrected receipt reaches it without anybody reopening anything.
 *
 * **What it is not**, and each of these exists separately for a reason:
 *
 *   - not the **operating statement**, which names every payee for the council;
 *   - not an **owner statement**, which is one proprietor's own account;
 *   - not the **shortfall report**, which is VDS's own trading position and is
 *     internal to the office.
 *
 * Costs appear as category totals. A circular to sixteen proprietors is not the
 * place to name every contractor paid, and the council has a document that does.
 */

import React, { useMemo, useState } from 'react';
import { AppSettings, Charge, Currency, Expense, Payment, Unit, bodyCorporateName } from '../types';
import { MonthlyOwnersReport as Report, monthlyOwnersReport } from '../lib/finance';
import { formatMoney } from '../lib/money';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, today } from '../lib/dates';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import { EmptyState, InfoNote, SecondaryButton, SubmitButton, TableScroller, monoInputClass, tableHeadRowClass } from './ui';
import { Download, Printer } from 'lucide-react';

interface Props {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  settings: AppSettings;
  generatedBy: string;
}

const CURRENCIES: Currency[] = ['JMD', 'USD'];

export default function MonthlyOwnersReport({ units, charges, payments, expenses, settings, generatedBy }: Props) {
  /*
   * Last month by default: this is a report about a month that has finished, and
   * opening it on a month still running invites a figure being circulated as if
   * it were final.
   */
  const [month, setMonth] = useState(() => addMonths(currentMonth(), -1));
  const [printing, setPrinting] = useState(false);

  const reports = useMemo(
    () => CURRENCIES.map(currency => monthlyOwnersReport(units, charges, payments, expenses, currency, month)).filter(r => !r.empty),
    [units, charges, payments, expenses, month]
  );

  const period = formatMonthLabel(month);
  const unfinished = month >= currentMonth();

  const exportWorkbook = () => {
    const sheets = reports.map(r => {
      const rows: XlsxCell[][] = [
        ...documentHeader({
          documentTitle: `Monthly Report to Proprietors (${r.currency})`,
          period,
          generatedOn: formatDayLabel(today()),
          generatedBy,
          planNumber: settings.strataPlanNumber,
          span: 3
        }),
        [cell.section('The fund this month', 3)],
        [cell.header('Item'), cell.header(''), cell.header('Amount', 'right')],
        [cell.text('Maintenance contributions received'), cell.text(''), cell.money(r.contributionsReceived, r.currency)],
        [cell.text('Common costs paid'), cell.text(''), cell.money(r.costsPaid, r.currency)],
        [
          cell.total(r.surplus >= 0 ? 'SURPLUS FOR THE MONTH' : 'DEFICIT FOR THE MONTH'),
          cell.total(''),
          cell.totalMoney(r.surplus, r.currency)
        ],
        [cell.blank()],
        [cell.section('Where the money went', 3)],
        [cell.header('Category'), cell.header(''), cell.header('Amount', 'right')]
      ];

      for (const category of r.categories) {
        rows.push([cell.text(category.label), cell.text(''), cell.money(category.total, r.currency)]);
      }
      rows.push([cell.total('Total common costs'), cell.total(''), cell.totalMoney(r.costsPaid, r.currency)]);

      rows.push([cell.blank()]);
      rows.push([cell.section('Also worth knowing', 3)]);
      rows.push([
        cell.text('Lots with contributions outstanding at month end'),
        cell.text(''),
        cell.text(`${r.lotsInArrears} of ${r.lotsTotal} — ${formatMoney(r.arrearsOutstanding, r.currency)}`)
      ]);
      if (r.unpaidCount > 0) {
        rows.push([
          cell.text('Bills due this month and still unsettled'),
          cell.text(''),
          cell.money(r.unpaidAtMonthEnd, r.currency)
        ]);
      }
      if (r.villaRechargedCount > 0) {
        rows.push([
          cell.text('Work on individual villas, recharged to those owners'),
          cell.text(''),
          cell.money(r.villaRecharged, r.currency)
        ]);
      }

      rows.push([cell.blank()]);
      rows.push([
        cell.note(
          `All figures are in ${r.currency} and nothing on this sheet is converted. Prepared on a cash basis: contributions are counted ` +
            'when received and costs when paid. Work on an individual villa is recharged to that owner and is not a common cost. ' +
            'No lot is named anywhere on this report — the arrears line is a count and a total only.',
          3
        )
      ]);

      const headerRow = rows.findIndex(row => row.some(cl => cl.style === 'header')) + 1;
      return { name: `Monthly ${r.currency}`, widths: [48, 4, 20], rows, freezeRows: headerRow, repeatRow: headerRow };
    });

    if (sheets.length === 0) return;
    downloadWorkbook(sheets, `VDS Monthly Report ${month}.xlsx`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h3 className="font-display text-base font-medium text-slate-900">Monthly report to proprietors</h3>
          <p className="text-xs text-slate-500">
            How the property ran in one month. The same document for every owner &mdash; no lot balances and nobody
            named.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-slate-500">Month</span>
            <input type="month" value={month} onChange={e => setMonth(e.target.value || month)} className={monoInputClass} />
          </label>
          <SecondaryButton onClick={exportWorkbook} disabled={reports.length === 0} className="flex items-center gap-1.5">
            <Download className="h-4 w-4" /> Export for Excel
          </SecondaryButton>
          <SubmitButton type="button" onClick={() => setPrinting(true)} disabled={reports.length === 0}>
            <Printer className="h-4 w-4" /> Print report
          </SubmitButton>
        </div>
      </div>

      {/*
        A month still running is a partial figure, and a partial figure handed to
        an owner is one they will hold you to. Said plainly rather than refused —
        somebody may genuinely want to see where the month stands.
      */}
      {unfinished && (
        <InfoNote>
          <strong>{period} has not finished.</strong> Every figure below covers the month so far and will change before
          it ends. Send a completed month to an owner unless they have asked for the position to date.
        </InfoNote>
      )}

      <InfoNote>
        Identical for every proprietor. It reports <strong>the fund</strong> &mdash; contributions received and what the
        property spent &mdash; and carries nothing about any individual lot: no balances, and the arrears line is a
        count and a total with nobody named. Costs are shown by category; the itemised statement naming every payee is
        the operating statement, under Operational Reports. Prepared on a cash basis.{' '}
        <strong>Each currency is a separate report</strong> and no figure combines them.
      </InfoNote>

      {reports.length === 0 ? (
        <EmptyState
          title={`Nothing was received or paid in ${period}`}
          hint="Choose another month above. A month with no contributions and no costs has no report to give."
        />
      ) : (
        reports.map(r => <CurrencyBlock key={r.currency} report={r} />)
      )}

      {printing && (
        <MonthlyReportDocument
          reports={reports}
          period={period}
          settings={settings}
          generatedBy={generatedBy}
          onClose={() => setPrinting(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CurrencyBlock({ report: r }: { report: Report }) {
  return (
    <div className="space-y-3 rounded-xl border border-slate-100 p-4">
      <h4 className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">{r.currency}</h4>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Contributions received" value={formatMoney(r.contributionsReceived, r.currency)} tone="positive" />
        <Tile label="Common costs paid" value={formatMoney(r.costsPaid, r.currency)} tone="negative" />
        <Tile
          label={r.surplus >= 0 ? 'Surplus for the month' : 'Deficit for the month'}
          value={formatMoney(Math.abs(r.surplus), r.currency)}
          tone={r.surplus >= 0 ? 'positive' : 'negative'}
          strong
        />
      </dl>

      {r.categories.length > 0 && (
        <TableScroller>
          <table className="w-full min-w-[420px] border-collapse text-left text-xs">
            <thead>
              <tr className={tableHeadRowClass}>
                <th scope="col" className="p-3">
                  Where the money went
                </th>
                <th scope="col" className="p-3 text-right">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {r.categories.map(category => (
                <tr key={category.label}>
                  <td className="p-3 text-slate-700">{category.label}</td>
                  <td className="p-3 text-right font-mono">{formatMoney(category.total, r.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className="p-3">Total common costs</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.costsPaid, r.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroller>
      )}

      <Notes report={r} />
    </div>
  );
}

/**
 * The facts that qualify the figures above.
 *
 * Each one is here because leaving it out would flatter the month: unsettled
 * bills make a good surplus, and recharged work would otherwise vanish from
 * both sides of the statement. The arrears line is the fund's health, stated the
 * only way an owners' circular may state it — a count and a total.
 */
function Notes({ report: r }: { report: Report }) {
  return (
    <ul className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
      <li>
        <strong>
          {r.lotsInArrears} of {r.lotsTotal} lots
        </strong>{' '}
        had contributions outstanding at the end of the month, totalling{' '}
        <strong>{formatMoney(r.arrearsOutstanding, r.currency)}</strong>. No lot is named on this report.
      </li>
      {r.unpaidCount > 0 && (
        <li>
          <strong>{formatMoney(r.unpaidAtMonthEnd, r.currency)}</strong> of bills fell due in the month and were still
          unsettled at the end of it, across {r.unpaidCount} {r.unpaidCount === 1 ? 'bill' : 'bills'}. Not deducted
          above, and stated here so the surplus is not read as the whole picture.
        </li>
      )}
      {r.villaRechargedCount > 0 && (
        <li>
          <strong>{formatMoney(r.villaRecharged, r.currency)}</strong> was spent on work to individual villas across{' '}
          {r.villaRechargedCount} {r.villaRechargedCount === 1 ? 'item' : 'items'}. That is recharged to those owners
          and is not a common cost, so it is excluded above rather than shared.
        </li>
      )}
    </ul>
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

/**
 * The printed report, exported so the suite can render it and ask what it shows.
 *
 * Every printed document in this application is asserted that way. This one
 * carries a further check nobody should have to remember: it goes to
 * proprietors, so a test reads the finished page and fails if a lot number, an
 * owner's name or a personal balance has found its way onto it.
 */
export function MonthlyReportDocument({
  reports,
  period,
  settings,
  generatedBy,
  onClose
}: {
  reports: Report[];
  period: string;
  settings: AppSettings;
  generatedBy: string;
  onClose?: () => void;
}) {
  return (
    <PrintPortal title="Monthly report to proprietors" subtitle={period} onClose={onClose || (() => {})} maxWidthClass="max-w-3xl">
      <PrintLetterhead documentTitle="Monthly Report to Proprietors" meta={period} generatedBy={generatedBy} />

      <p className="mb-4 text-[11px] leading-relaxed">
        This report is circulated to the proprietors of <strong>{bodyCorporateName(settings)}</strong> and is the same
        for every owner. It sets out how the property was run in the month stated: the contributions the fund received
        and what it spent. Prepared on a cash basis &mdash; contributions counted when received and costs when paid.{' '}
        <strong>It carries nothing about any individual lot.</strong>
      </p>

      {reports.map(r => (
        <section key={r.currency} className="mb-8 break-inside-avoid">
          <h3 className="mb-2 border-b-2 border-slate-900 pb-1 text-sm font-bold uppercase tracking-wider">
            {r.currency} — {r.currency === 'JMD' ? 'Jamaican dollars' : 'United States dollars'}
          </h3>

          <table className="mb-4 w-full text-left text-[11px]">
            <tbody className="font-mono">
              <tr>
                <td className="p-2 font-sans">Maintenance contributions received</td>
                <td className="p-2 text-right">{formatMoney(r.contributionsReceived, r.currency)}</td>
              </tr>
              <tr>
                <td className="p-2 font-sans">Common costs paid</td>
                <td className="p-2 text-right">{formatMoney(r.costsPaid, r.currency)}</td>
              </tr>
              <tr className="border-t-2 border-slate-900 font-bold">
                <td className="p-2 font-sans">
                  {r.surplus >= 0 ? 'Surplus for the month' : 'Deficit for the month'} ({r.currency})
                </td>
                <td className="p-2 text-right">{formatMoney(Math.abs(r.surplus), r.currency)}</td>
              </tr>
            </tbody>
          </table>

          {r.categories.length > 0 && (
            <>
              <h4 className="mb-1 text-xs font-bold uppercase tracking-wider">Where the money went</h4>
              <table className="mb-4 w-full text-left text-[10px]">
                <tbody className="font-mono">
                  {r.categories.map(category => (
                    <tr key={category.label}>
                      <td className="p-1.5 font-sans">{category.label}</td>
                      <td className="p-1.5 text-right">{formatMoney(category.total, r.currency)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-400 font-bold">
                    <td className="p-1.5 font-sans">Total common costs</td>
                    <td className="p-1.5 text-right">{formatMoney(r.costsPaid, r.currency)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}

          <div className="rounded border border-slate-300 p-2 text-[10px] leading-relaxed">
            <p>
              <strong>
                {r.lotsInArrears} of {r.lotsTotal} lots
              </strong>{' '}
              had contributions outstanding at the end of the month, totalling{' '}
              <strong>{formatMoney(r.arrearsOutstanding, r.currency)}</strong>. No lot is named on this report.
            </p>
            {r.unpaidCount > 0 && (
              <p className="mt-1">
                <strong>{formatMoney(r.unpaidAtMonthEnd, r.currency)}</strong> of bills fell due in the month and were
                unsettled at the end of it. Not deducted above, and stated so the surplus is not read as the whole
                picture.
              </p>
            )}
            {r.villaRechargedCount > 0 && (
              <p className="mt-1">
                <strong>{formatMoney(r.villaRecharged, r.currency)}</strong> was spent on work to individual villas,
                recharged to those owners. Not a common cost, so it is excluded above rather than shared.
              </p>
            )}
          </div>
        </section>
      ))}

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        Prepared from the property&rsquo;s records for the month stated, on a cash basis, and is not a tax document. USD
        and JMD are reported separately and no figure has been converted. Indicative rate on file: 1 USD ={' '}
        {settings.fxRateJmdPerUsd} JMD, shown for reference only. A proprietor&rsquo;s own account is a separate
        statement, available on request.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="For the corporation" />
    </PrintPortal>
  );
}
