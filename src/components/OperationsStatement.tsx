/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The monthly operations statement sent to the proprietors.
 *
 * What the maintenance contributions were spent on, itemised, and what is left.
 * Asked for by Ro on 2026-09-01; three decisions were taken with him at the same
 * time and they shape everything here:
 *
 *   - **Common costs only.** Fuel, grounds staff, pool chemicals — the cost of
 *     running the place. Work on one villa is recharged to that owner and shows
 *     on their own statement; itemising it here would tell all sixteen owners
 *     what was done to each other's villas.
 *   - **One statement, not sixteen.** It is the fund's position, which is the
 *     same for every proprietor. Nothing on this page is personal to anyone, so
 *     the same sheet can go to all of them.
 *   - **Cash in, cash out.** Costs count when they are paid, matching the
 *     contributions actually collected, so the surplus reconciles to the bank.
 *     A bill raised and not yet settled is carried as a memo underneath rather
 *     than mixed in — otherwise a month with a large unpaid bill reads as a good
 *     month.
 *
 * The one thing on the page that is not an owner-facing figure is the excluded
 * total: spend keyed against a particular villa is counted and named as an
 * exclusion rather than quietly dropped, so the statement always reconciles to
 * the expense register. A cost miscategorised against a villa shows up as a
 * number that moved, instead of vanishing from both sides.
 */

import React, { useMemo, useState } from 'react';
import { useRemembered } from '../lib/screenState';
import { AppSettings, Currency, Expense, Payment, SessionUser } from '../types';
import { OperationsStatement as Statement, operationsStatement } from '../lib/finance';
import { formatMoney } from '../lib/money';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import { EmptyState, InfoNote, SecondaryButton, SubmitButton, TableScroller, monoInputClass, tableHeadRowClass } from './ui';
import { Download, Printer } from 'lucide-react';

interface Props {
  expenses: Expense[];
  payments: Payment[];
  settings: AppSettings;
  session: SessionUser;
}

const CURRENCIES: Currency[] = ['JMD', 'USD'];

export default function OperationsStatement({ expenses, payments, settings, session }: Props) {
  // Last completed month: the period a statement is actually issued for.
  const [month, setMonth] = useRemembered('reports.operations.month', () => addMonths(currentMonth(), -1));
  const [printing, setPrinting] = useState(false);

  const from = monthStart(month);
  const to = monthEnd(month);

  const statements = useMemo(
    () => CURRENCIES.map(currency => operationsStatement(expenses, payments, currency, from, to)),
    [expenses, payments, from, to]
  );

  const anything = statements.some(s => !s.empty);

  /**
   * The month's operations as an Excel workbook, one sheet per currency.
   *
   * This is the document that goes to all sixteen proprietors, so it has to read
   * as a statement rather than a data dump: each cost is itemised under its
   * category with the supplier named, the totals are real numbers an accountant
   * can check, and the unpaid and excluded memos keep their own labelled blocks
   * instead of running into the figures above them.
   */
  const downloadCsv = () => {
    const sheets = statements
      .filter(s => !s.empty)
      .map(s => {
        const rows: XlsxCell[][] = [
          ...documentHeader({
            documentTitle: `Statement of Operations, ${s.currency}`,
            period: formatMonthLabel(month),
            generatedOn: formatDayLabel(today()),
            generatedBy: session.name,
            planNumber: settings.strataPlanNumber,
            span: 5
          }),
          /*
           * The money coming in is stated before the column headers, not under
           * them: it is not a cost line, and sitting beneath "Date / Supplier /
           * What it was for" it read as though it were one.
           */
          [
            cell.total('Maintenance contributions received in the month'),
            cell.total(''),
            cell.total(''),
            cell.total(''),
            cell.totalMoney(s.maintenanceCollected, s.currency)
          ],
          [cell.blank()],
          [cell.section('What the contributions paid for', 5)],
          [cell.header('Date'), cell.header('Supplier'), cell.header('What it was for'), cell.header('Reference'), cell.header('Amount', 'right')]
        ];

        for (const group of s.groups) {
          rows.push([cell.section(group.category, 5)]);
          for (const line of group.lines) {
            rows.push([
              cell.date(line.date),
              cell.text(line.vendor || '-'),
              cell.text(line.description || '-'),
              cell.text(line.reference || ''),
              cell.money(line.amount, s.currency)
            ]);
          }
          rows.push([
            cell.total(`Total ${group.category.toLowerCase()}`),
            cell.total(''),
            cell.total(''),
            cell.total(''),
            cell.totalMoney(group.total, s.currency)
          ]);
          rows.push([cell.blank()]);
        }

        rows.push([cell.total('Total common costs paid'), cell.total(''), cell.total(''), cell.total(''), cell.totalMoney(s.costsPaid, s.currency)]);
        rows.push([
          cell.total(s.surplus >= 0 ? 'Surplus for the month' : 'Shortfall for the month'),
          cell.total(''),
          cell.total(''),
          cell.total(''),
          cell.totalMoney(s.surplus, s.currency)
        ]);

        if (s.unpaidLines.length > 0) {
          rows.push([cell.blank()]);
          rows.push([cell.section('Billed in the month and not yet settled', 5)]);
          for (const line of s.unpaidLines) {
            rows.push([
              cell.date(line.date),
              cell.text(line.vendor || '-'),
              cell.text(line.description || '-'),
              cell.text(line.reference || ''),
              cell.money(line.amount, s.currency)
            ]);
          }
          rows.push([cell.total('Memo total'), cell.total(''), cell.total(''), cell.total(''), cell.totalMoney(s.costsUnpaid, s.currency)]);
          rows.push([cell.note('Shown for information only. These are not in the figures above, which count money that has actually been paid so the surplus agrees with the bank.', 5)]);
        }

        if (s.villaRecharged !== 0) {
          rows.push([cell.blank()]);
          rows.push([
            cell.note(
              `Excluded from this statement: ${formatMoney(s.villaRecharged, s.currency)} over ${s.villaRechargedCount} item(s) charged to individual villas and recharged to those proprietors. Shown so this statement always reconciles to the expense register.`,
              5
            )
          ]);
        }

        rows.push([cell.blank()]);
        rows.push([
          cell.note(
            'The costs of the common property only, grounds, pool, security, fuel and payroll. Work on an individual villa is recharged to that proprietor. Prepared on a cash basis. USD and JMD are reported separately and are never combined.',
            5
          )
        ]);

        // The masthead, the contributions line, a spacer and the section band
        // sit above the column headers, which land on row 10.
        const headerRow = rows.findIndex(r => r.some(c => c.style === 'header')) + 1;
        return { name: `Operations ${s.currency}`, widths: [14, 26, 46, 16, 18], rows, freezeRows: headerRow, repeatRow: headerRow };
      });

    if (sheets.length === 0) return;
    downloadWorkbook(sheets, `VDS Operations Statement ${month}.xlsx`);
  };

  return (
    <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="font-display text-lg font-medium text-slate-900">Owners' monthly operations statement</h2>
          <p className="text-xs text-slate-500">
            What the contributions collected were spent on, line by line. The same statement goes to every proprietor.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton onClick={downloadCsv} disabled={!anything} className="flex items-center gap-1.5">
            <Download className="h-4 w-4" /> Export for Excel
          </SecondaryButton>
          <SubmitButton type="button" onClick={() => setPrinting(true)} disabled={!anything}>
            <Printer className="h-4 w-4" /> Print statement
          </SubmitButton>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-slate-500">Month</span>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} className={monoInputClass} />
        </label>
      </div>

      <InfoNote>
        The costs of the common property only, the grounds, the pool, security, fuel, payroll. Work done to an
        individual villa is recharged to that proprietor and appears on their own statement, not here. Costs count in
        the month they were <strong>paid</strong>, against the contributions received in the same month, so the surplus
        is money that actually moved. Anything billed but not yet settled is listed underneath and is deliberately not
        in that figure. USD and JMD are reported separately and never combined.
      </InfoNote>

      {!anything ? (
        <EmptyState
          title={`Nothing recorded for ${formatMonthLabel(month)}`}
          hint="A statement appears once contributions have been received or common costs paid in the month."
        />
      ) : (
        statements.filter(s => !s.empty).map(s => <CurrencyBlock key={s.currency} statement={s} />)
      )}

      {printing && (
        <OperationsDocument
          statements={statements.filter(s => !s.empty)}
          month={month}
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
        <Tile label="Contributions received" value={formatMoney(s.maintenanceCollected, s.currency)} tone="positive" />
        <Tile label="Common costs paid" value={formatMoney(s.costsPaid, s.currency)} tone="negative" />
        <Tile
          label={s.surplus >= 0 ? 'Surplus for the month' : 'Shortfall for the month'}
          value={formatMoney(Math.abs(s.surplus), s.currency)}
          tone={s.surplus >= 0 ? 'positive' : 'negative'}
          strong
        />
      </dl>

      {s.groups.length === 0 ? (
        <p className="text-xs italic text-slate-500">No common costs were paid in this month.</p>
      ) : (
        <TableScroller>
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead>
              <tr className={tableHeadRowClass}>
                <th scope="col" className="p-3">Date</th>
                <th scope="col" className="p-3">Supplier</th>
                <th scope="col" className="p-3">What it was for</th>
                <th scope="col" className="p-3 text-right">Amount</th>
              </tr>
            </thead>
            {s.groups.map(group => (
              <tbody key={group.category} className="divide-y divide-slate-50">
                <tr className="bg-slate-50/60">
                  <td colSpan={3} className="p-3 font-semibold text-slate-900">{group.category}</td>
                  <td className="p-3 text-right font-mono font-semibold text-slate-900">
                    {formatMoney(group.total, s.currency)}
                  </td>
                </tr>
                {group.lines.map(line => (
                  <tr key={line.id}>
                    <td className="p-3 font-mono text-slate-500">{formatDayLabel(line.date)}</td>
                    <td className="p-3">{line.vendor || '-'}</td>
                    <td className="p-3 text-slate-600">
                      {line.description || '-'}
                      {line.reference && <span className="ml-1 font-mono text-[10px] text-slate-400">({line.reference})</span>}
                    </td>
                    <td className="p-3 text-right font-mono">{formatMoney(line.amount, s.currency)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td colSpan={3} className="p-3">Total common costs paid</td>
                <td className="p-3 text-right font-mono">{formatMoney(s.costsPaid, s.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroller>
      )}

      {s.unpaidLines.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="mb-1 text-xs font-semibold text-amber-900">
            Billed in the month and not yet settled, {formatMoney(s.costsUnpaid, s.currency)}
          </p>
          {/* Deliberately outside the surplus. Netting an unpaid bill into the
              cash position is how a bad month reads as a good one. */}
          <ul className="space-y-0.5 font-mono text-[11px] text-amber-900">
            {s.unpaidLines.map(line => (
              <li key={line.id}>
                {formatDayLabel(line.date)} · {line.vendor || 'supplier'} · {line.description || '-'} ·{' '}
                {formatMoney(line.amount, s.currency)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] leading-relaxed text-amber-800">
            Not included in the surplus above, which counts only money that has actually moved.
          </p>
        </div>
      )}

      {s.villaRecharged !== 0 && (
        <p className="font-mono text-[10px] leading-relaxed text-slate-400">
          Excluded from this statement: {formatMoney(s.villaRecharged, s.currency)} over {s.villaRechargedCount}{' '}
          item(s) charged to individual villas and recharged to those proprietors. Shown so this statement always
          reconciles to the expense register.
        </p>
      )}
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

function OperationsDocument({
  statements,
  month,
  settings,
  generatedBy,
  onClose
}: {
  statements: Statement[];
  month: string;
  settings: AppSettings;
  generatedBy: string;
  onClose: () => void;
}) {
  return (
    <PrintPortal title="Monthly operations statement" subtitle={formatMonthLabel(month)} onClose={onClose} maxWidthClass="max-w-4xl">
      <PrintLetterhead
        documentTitle="Statement of Operations"
        meta={`Month of ${formatMonthLabel(month)}`}
        generatedBy={generatedBy}
      />

      <p className="mb-4 text-[11px] leading-relaxed">
        This statement sets out what the corporation collected in maintenance contributions during the month, and what
        those contributions paid for. It covers the <strong>common property</strong>, the grounds, the pool, security,
        fuel and payroll. Work carried out on an individual villa is recharged to that proprietor and appears on their
        own statement rather than here.
      </p>

      {statements.map(s => (
        <section key={s.currency} className="mb-6 break-inside-avoid">
          <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
            {s.currency}
          </h3>

          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <tbody className="font-mono">
                <tr className="border-b border-slate-200">
                  <td className="p-2 font-sans" colSpan={3}>Maintenance contributions received in the month</td>
                  <td className="p-2 text-right font-semibold">{formatMoney(s.maintenanceCollected, s.currency)}</td>
                </tr>
                {s.groups.map(group => (
                  <React.Fragment key={group.category}>
                    <tr>
                      <td className="p-2 pt-3 font-sans font-bold" colSpan={4}>{group.category}</td>
                    </tr>
                    {group.lines.map(line => (
                      <tr key={line.id}>
                        <td className="p-2">{formatDayLabel(line.date)}</td>
                        <td className="p-2 font-sans">{line.vendor || '-'}</td>
                        <td className="p-2 font-sans">{line.description || '-'}</td>
                        <td className="p-2 text-right">{formatMoney(line.amount, s.currency)}</td>
                      </tr>
                    ))}
                    <tr className="border-b border-slate-200">
                      <td className="p-2 font-sans italic" colSpan={3}>Total {group.category.toLowerCase()}</td>
                      <td className="p-2 text-right font-semibold">{formatMoney(group.total, s.currency)}</td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-400 font-mono font-semibold">
                  <td className="p-2 font-sans" colSpan={3}>Total common costs paid</td>
                  <td className="p-2 text-right">{formatMoney(s.costsPaid, s.currency)}</td>
                </tr>
                <tr className="border-t-2 border-slate-400 font-mono font-bold">
                  <td className="p-2 font-sans" colSpan={3}>
                    {s.surplus >= 0 ? 'Surplus carried forward' : 'Shortfall met by the corporation'}
                  </td>
                  <td className="p-2 text-right">{formatMoney(Math.abs(s.surplus), s.currency)}</td>
                </tr>
              </tfoot>
            </table>
          </TableScroller>

          {s.unpaidLines.length > 0 && (
            <div className="mt-2 rounded border border-slate-300 p-2">
              <p className="text-[10px] font-bold uppercase tracking-wide">
                Billed in the month, not yet settled, {formatMoney(s.costsUnpaid, s.currency)}
              </p>
              <ul className="mt-1 space-y-0.5 font-mono text-[10px]">
                {s.unpaidLines.map(line => (
                  <li key={line.id}>
                    {formatDayLabel(line.date)} · {line.vendor || 'supplier'} · {line.description || '-'} ·{' '}
                    {formatMoney(line.amount, s.currency)}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
                Shown for information. These are not included in the figures above, which count only money that has
                actually been paid, so that the surplus agrees with the bank.
              </p>
            </div>
          )}
        </section>
      ))}

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        Prepared on a cash basis: contributions are counted when received and costs when paid, so the surplus or
        shortfall is money that actually moved during the month. USD and JMD are reported separately and are never
        combined. Indicative rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD, shown for reference only; no figure
        on this statement has been converted.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Reviewed / Approved by" />
    </PrintPortal>
  );
}
