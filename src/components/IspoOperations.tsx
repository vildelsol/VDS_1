/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ISPO Operations — the letting company's own position.
 *
 * Ro, 2026-09-03: *"Ispo, the company that owns VDS is the company who collects
 * the Rent payments, there are certain expenses, such as Cell phone bills,
 * company vehicle expenses and insurance and other expenses that are paid from
 * the rental income. This has not yet been accounted for."*
 *
 * The mirror of the owners' monthly operations statement, which is the
 * corporation's side of the same register. Between the two, every cost is
 * counted exactly once — a cost is in one book or the other, and there is no
 * third answer.
 *
 * **This is internal.** It is the company's trading position, not the
 * proprietors' business, and nothing on it belongs on a document that goes to an
 * owner or to the Commission. It is badged accordingly and, unlike the owners'
 * statement beside it, it deliberately has no "print for circulation" framing —
 * it prints for the office.
 *
 * The one figure worth reading twice is the contribution ISPO pays on the villas
 * it lets. It is a real cost of letting — the whole premise of the shortfall
 * report — and it is read from the receipts rather than from the expense
 * register, because a contribution has exactly one record and counting a cost
 * row as well would be the same money twice.
 */

import React, { useMemo, useState } from 'react';
import { useRemembered } from '../lib/screenState';
import { AppSettings, Currency, Expense, MANAGING_COMPANY_NAME, Payment, SessionUser, Unit } from '../types';
import { IspoOperations as Statement, ispoOperations } from '../lib/finance';
import { formatMoney } from '../lib/money';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import { Badge, EmptyState, InfoNote, SecondaryButton, SubmitButton, TableScroller, monoInputClass, tableHeadRowClass } from './ui';
import { Download, Printer } from 'lucide-react';

interface Props {
  units: Unit[];
  expenses: Expense[];
  payments: Payment[];
  settings: AppSettings;
  session: SessionUser;
}

const CURRENCIES: Currency[] = ['JMD', 'USD'];

/**
 * Who may see this at all.
 *
 * The same rule as the shortfall report, on Ro's instruction of 2026-09-03:
 * *"Every role unless withdrawn is the best option."* Internal means internal to
 * the office, not to one login. Administrators are never gated, as everywhere
 * else in this application.
 *
 * ⚠️ **A visibility rule, not a security boundary**, and it must not be
 * described as one. Every screen here computes from `/api/db`, which any
 * signed-in session can fetch, and the receipts underneath are already on the
 * ledger. Withdrawing it keeps the company's trading position off a colleague's
 * page; it does not put it behind a lock. A real boundary would mean computing
 * this on the server behind the permission, which is different work and has not
 * been asked for.
 */
function maySeeIspoOperations(session: SessionUser): boolean {
  if (session.role === 'ADMINISTRATOR') return true;
  // Absent means granted: a database written before the permission existed must
  // not read the missing value as a denial.
  return session.permissions?.viewIspoOperations !== false;
}

export default function IspoOperations({ units, expenses, payments, settings, session }: Props) {
  const [month, setMonth] = useRemembered('reports.ispo.month', () => addMonths(currentMonth(), -1));
  const [printing, setPrinting] = useState(false);
  const allowed = maySeeIspoOperations(session);

  const from = monthStart(month);
  const to = monthEnd(month);

  const statements = useMemo(
    () => CURRENCIES.map(currency => ispoOperations(expenses, payments, units, currency, from, to)),
    [expenses, payments, units, from, to]
  );

  const anything = statements.some(s => !s.empty);
  const live = statements.filter(s => !s.empty);

  /*
   * Returned after the hooks above, never before them. An early return placed
   * ahead of a `useMemo` changes the hook order the moment a session's
   * permissions change, which React treats as a different component.
   */
  if (!allowed) return null;

  const downloadXlsx = () => {
    const sheets = live.map(s => {
      const rows: XlsxCell[][] = [
        ...documentHeader({
          documentTitle: `${MANAGING_COMPANY_NAME} Operations (${s.currency})`,
          period: formatMonthLabel(month),
          generatedOn: formatDayLabel(today()),
          generatedBy: session.name,
          planNumber: settings.strataPlanNumber,
          span: 5
        }),
        [cell.section('Income received', 5)],
        [cell.text('Rent'), cell.text(''), cell.text(''), cell.text(''), cell.money(s.rentReceived, s.currency)],
        [cell.text('Short-stay bookings'), cell.text(''), cell.text(''), cell.text(''), cell.money(s.bookingReceived, s.currency)],
        [cell.total('Total income'), cell.total(''), cell.total(''), cell.total(''), cell.totalMoney(s.totalIncome, s.currency)],
        [cell.blank()],
        [cell.section(`${MANAGING_COMPANY_NAME}'s own costs paid`, 5)],
        [cell.header('Date'), cell.header('Payee'), cell.header('What it was for'), cell.header('Allocation'), cell.header('Amount', 'right')]
      ];

      for (const group of s.groups) {
        rows.push([cell.section(group.category, 5)]);
        for (const line of group.lines) {
          rows.push([
            cell.date(line.date),
            cell.text(line.vendor || '-'),
            cell.text(line.description || '-'),
            cell.text(line.allocation || '-'),
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

      rows.push([
        cell.total(`Total ${MANAGING_COMPANY_NAME} costs`),
        cell.total(''),
        cell.total(''),
        cell.total(''),
        cell.totalMoney(s.ownCostsPaid, s.currency)
      ]);
      rows.push([
        cell.total('Maintenance paid on villas let on own account'),
        cell.total(''),
        cell.total(''),
        cell.total(''),
        cell.totalMoney(s.maintenanceOnOwnVillas, s.currency)
      ]);
      rows.push([
        cell.total(s.net >= 0 ? 'Net for the month' : 'Loss for the month'),
        cell.total(''),
        cell.total(''),
        cell.total(''),
        cell.totalMoney(Math.abs(s.net), s.currency)
      ]);

      if (s.unpaidLines.length > 0) {
        rows.push([cell.blank()]);
        rows.push([cell.section('Billed and not yet paid, not in the figures above', 5)]);
        for (const line of s.unpaidLines) {
          rows.push([
            cell.date(line.date),
            cell.text(line.vendor || '-'),
            cell.text(line.description || '-'),
            cell.text(line.allocation || '-'),
            cell.money(line.amount, s.currency)
          ]);
        }
      }

      rows.push([cell.blank()]);
      rows.push([
        cell.note(
          `Internal. ${MANAGING_COMPANY_NAME}'s own trading position and not the proprietors' business, no part of this belongs on an owner statement or a statutory return. The maintenance line is read from receipts issued against villas let on the corporation's own account, never from the expense register, so it is counted once. Cash basis. USD and JMD are reported separately and never combined.`,
          5
        )
      ]);

      const headerRow = rows.findIndex(r => r.some(c => c.style === 'header')) + 1;
      return { name: `${MANAGING_COMPANY_NAME} ${s.currency}`, widths: [14, 26, 40, 20, 18], rows, freezeRows: headerRow, repeatRow: headerRow };
    });

    if (sheets.length === 0) return;
    downloadWorkbook(sheets, `${MANAGING_COMPANY_NAME} Operations ${month}.xlsx`);
  };

  return (
    <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 font-display text-lg font-medium text-slate-900">
            {MANAGING_COMPANY_NAME} Operations
            <Badge tone="purple">Internal</Badge>
          </h2>
          <p className="text-xs text-slate-500">
            What the letting business took in rent, and what it paid for out of it. Not the proprietors&rsquo; business and not
            part of any statement they receive.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton onClick={downloadXlsx} disabled={!anything} className="flex items-center gap-1.5">
            <Download className="h-4 w-4" /> Export for Excel
          </SecondaryButton>
          <SubmitButton type="button" onClick={() => setPrinting(true)} disabled={!anything}>
            <Printer className="h-4 w-4" /> Print
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
        Rent and short-stay receipts against {MANAGING_COMPANY_NAME}&rsquo;s own costs, the cell phone, the company vehicle and
        its insurance, and anything else marked <strong>paid from rental income</strong>. The corporation&rsquo;s costs are on the
        owners&rsquo; statement instead, and no cost is on both. The maintenance line is the contribution paid on the villas VDS
        lets, which the rent is what funds. Cash basis; USD and JMD never combined.
      </InfoNote>

      {statements.some(s => s.noVillasFlagged) && (
        <InfoNote tone="amber">
          No villa is yet ticked as <strong>let on the corporation&rsquo;s own account</strong> in the Units Register, so the
          maintenance line reads nil. That is the flag being unset rather than a statement that no contributions were paid -
          nothing guesses it from an owner&rsquo;s name.
        </InfoNote>
      )}

      {!anything ? (
        <EmptyState
          title={`Nothing recorded for ${formatMonthLabel(month)}`}
          hint={`This appears once rent has been received or a cost marked as paid from rental income. Mark a cost's book in the expense register or on its monthly cost.`}
        />
      ) : (
        live.map(s => <CurrencyBlock key={s.currency} statement={s} />)
      )}

      {printing && (
        <IspoDocument
          statements={live}
          month={month}
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

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Tile label="Rent received" value={formatMoney(s.rentReceived, s.currency)} tone="positive" />
        <Tile label="Short-stay received" value={formatMoney(s.bookingReceived, s.currency)} tone="positive" />
        <Tile label="Costs paid" value={formatMoney(s.totalCosts, s.currency)} tone="negative" />
        <Tile
          label={s.net >= 0 ? 'Net for the month' : 'Loss for the month'}
          value={formatMoney(Math.abs(s.net), s.currency)}
          tone={s.net >= 0 ? 'positive' : 'negative'}
          strong
        />
      </dl>

      {s.groups.length === 0 ? (
        <p className="text-xs italic text-slate-500">
          No {MANAGING_COMPANY_NAME} costs were paid in this month. Mark a cost as paid from rental income for it to appear here.
        </p>
      ) : (
        <TableScroller>
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead>
              <tr className={tableHeadRowClass}>
                <th scope="col" className="p-3">Date</th>
                <th scope="col" className="p-3">Payee</th>
                <th scope="col" className="p-3">What it was for</th>
                <th scope="col" className="p-3">Allocation</th>
                <th scope="col" className="p-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {s.groups.map(group => (
                <React.Fragment key={group.category}>
                  <tr className="bg-slate-50/70">
                    <td colSpan={4} className="p-2 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {group.category}
                    </td>
                    <td className="p-2 text-right font-mono text-[11px] font-semibold text-slate-700">
                      {formatMoney(group.total, s.currency)}
                    </td>
                  </tr>
                  {group.lines.map(line => (
                    <tr key={line.id}>
                      <td className="p-3 font-mono text-[11px] text-slate-500">{formatDayLabel(line.date)}</td>
                      <td className="p-3 font-medium text-slate-800">{line.vendor || '-'}</td>
                      <td className="p-3 text-slate-600">{line.description || '-'}</td>
                      <td className="p-3 font-mono text-[11px] text-slate-500">{line.allocation || '-'}</td>
                      <td className="p-3 text-right font-mono">{formatMoney(line.amount, s.currency)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}

      <dl className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-600">{MANAGING_COMPANY_NAME}&rsquo;s own costs</dt>
          <dd className="font-mono font-semibold">{formatMoney(s.ownCostsPaid, s.currency)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-600">
            Maintenance paid on villas let on own account
            {s.ownAccountVillas.length > 0 && (
              <span className="mt-0.5 block text-[10px] text-slate-400">{s.ownAccountVillas.join(', ')}</span>
            )}
          </dt>
          <dd className="font-mono font-semibold">{formatMoney(s.maintenanceOnOwnVillas, s.currency)}</dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-slate-200 pt-1 font-bold">
          <dt>Total costs</dt>
          <dd className="font-mono">{formatMoney(s.totalCosts, s.currency)}</dd>
        </div>
      </dl>

      {s.incomeFromUnflaggedVillas > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
          <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-800">
            {formatMoney(s.incomeFromUnflaggedVillas, s.currency)} of the income above came from villas not ticked as own account
          </p>
          <p>
            {s.unflaggedVillasWithIncome.join(', ')}. It is counted as {MANAGING_COMPANY_NAME}&rsquo;s, because the corporation
            never collects a proprietor&rsquo;s rent. But the shortfall report only counts villas that are ticked, so the two
            documents will quote different rent for this month until this is resolved. It means one of two things: a villa VDS
            lets that nobody has ticked yet, or rent recorded against a proprietor&rsquo;s villa.
          </p>
        </div>
      )}

      {s.excludedAsContributionCount > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
          <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-800">
            {formatMoney(s.excludedAsContribution, s.currency)} left out of the costs above
          </p>
          <p>
            {s.excludedAsContributionCount} cost row(s) in the expense register are the maintenance contribution on a villa let
            on the corporation&rsquo;s own account. That contribution is already counted from its receipt, on the line above, so
            counting the cost row as well would be the same money twice. Take those rows back in the expense register, the
            self-check flags them.
          </p>
        </div>
      )}

      {s.unpaidLines.length > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-3">
          <p className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-800">
            Billed and not yet paid, {formatMoney(s.costsUnpaid, s.currency)}
          </p>
          <p className="mb-2 text-[10px] leading-relaxed text-amber-800">
            Deliberately not in the figures above, which are cash. A month with a large unpaid bill would otherwise read as a
            good month.
          </p>
          <ul className="space-y-1 text-[11px] text-amber-900">
            {s.unpaidLines.map(line => (
              <li key={line.id} className="flex justify-between gap-3">
                <span>
                  {line.vendor}, {line.description || 'no description'} · due {formatDayLabel(line.date)}
                </span>
                <span className="shrink-0 font-mono">{formatMoney(line.amount, s.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  strong
}: {
  label: string;
  value: string;
  tone: 'positive' | 'negative';
  strong?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3 ${strong ? 'border-slate-300 bg-slate-50' : 'border-slate-100'}`}>
      <dt className="font-mono text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-1 font-mono text-sm font-semibold ${tone === 'negative' ? 'text-rose-600' : 'text-emerald-700'}`}>
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Exported so the printed statement can actually be asserted on.
 *
 * Until PrintPortal was made to render without a DOM, not one printed document
 * here was covered by any test — which is how a maintenance receipt went missing
 * from one unnoticed. A new printed document arrives with that lesson already
 * learned: `test/printed-records.test.mjs` renders this and checks it carries the
 * rent, the bookings, the costs and the contribution line, and that it carries no
 * strata cost.
 */
export function IspoDocument({
  statements,
  month,
  generatedBy,
  onClose
}: {
  statements: Statement[];
  month: string;
  generatedBy: string;
  onClose: () => void;
}) {
  return (
    <PrintPortal title={`${MANAGING_COMPANY_NAME} Operations`} subtitle={formatMonthLabel(month)} onClose={onClose} maxWidthClass="max-w-4xl">
      <PrintLetterhead
        documentTitle={`${MANAGING_COMPANY_NAME} Operations, internal`}
        meta={formatMonthLabel(month)}
        generatedBy={generatedBy}
      />

      <p className="mb-4 rounded border border-slate-300 p-2 text-[10px] leading-relaxed text-slate-600">
        <strong>Internal document.</strong> The letting company&rsquo;s own income and costs. It is not a statement of the body
        corporate, forms no part of any proprietor&rsquo;s statement, and is not for circulation to owners or to the Commission.
      </p>

      {statements.map(s => (
        <section key={s.currency} className="mb-6">
          <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">{s.currency}</h3>

          <table className="mb-3 w-full text-left text-[10px]">
            <tbody className="font-mono">
              <tr>
                <td className="p-1.5 font-sans">Rent received</td>
                <td className="p-1.5 text-right">{formatMoney(s.rentReceived, s.currency)}</td>
              </tr>
              <tr>
                <td className="p-1.5 font-sans">Short-stay bookings received</td>
                <td className="p-1.5 text-right">{formatMoney(s.bookingReceived, s.currency)}</td>
              </tr>
              <tr className="border-t border-slate-300 font-bold">
                <td className="p-1.5 font-sans">Total income</td>
                <td className="p-1.5 text-right">{formatMoney(s.totalIncome, s.currency)}</td>
              </tr>
            </tbody>
          </table>

          {s.groups.map(group => (
            <div key={group.category} className="mb-2">
              <p className="border-b border-slate-200 pb-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-slate-600">
                {group.category}
              </p>
              <table className="w-full text-left text-[10px]">
                <tbody className="font-mono">
                  {group.lines.map(line => (
                    <tr key={line.id}>
                      <td className="p-1.5">{formatDayLabel(line.date)}</td>
                      <td className="p-1.5 font-sans font-semibold">{line.vendor || '-'}</td>
                      <td className="p-1.5 font-sans">{line.description || '-'}</td>
                      <td className="p-1.5">{line.allocation || '-'}</td>
                      <td className="p-1.5 text-right">{formatMoney(line.amount, s.currency)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="p-1.5 font-sans" colSpan={4}>
                      Total {group.category.toLowerCase()}
                    </td>
                    <td className="p-1.5 text-right">{formatMoney(group.total, s.currency)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}

          <table className="w-full text-left text-[10px]">
            <tbody className="font-mono">
              <tr>
                <td className="p-1.5 font-sans">{MANAGING_COMPANY_NAME}&rsquo;s own costs</td>
                <td className="p-1.5 text-right">{formatMoney(s.ownCostsPaid, s.currency)}</td>
              </tr>
              <tr>
                <td className="p-1.5 font-sans">
                  Maintenance paid on villas let on own account
                  {s.ownAccountVillas.length > 0 ? ` (${s.ownAccountVillas.join(', ')})` : ''}
                </td>
                <td className="p-1.5 text-right">{formatMoney(s.maintenanceOnOwnVillas, s.currency)}</td>
              </tr>
              <tr className="border-t border-slate-300 font-bold">
                <td className="p-1.5 font-sans">Total costs</td>
                <td className="p-1.5 text-right">{formatMoney(s.totalCosts, s.currency)}</td>
              </tr>
              <tr className="border-t-2 border-slate-500 font-bold">
                <td className="p-1.5 font-sans">{s.net >= 0 ? 'Net for the month' : 'Loss for the month'}</td>
                <td className="p-1.5 text-right">{formatMoney(Math.abs(s.net), s.currency)}</td>
              </tr>
            </tbody>
          </table>

          {s.unpaidLines.length > 0 && (
            <p className="mt-2 text-[9px] italic leading-relaxed text-slate-500">
              Billed and not yet paid, and deliberately not in the figures above:{' '}
              {formatMoney(s.costsUnpaid, s.currency)} over {s.unpaidLines.length} item(s).
            </p>
          )}
        </section>
      ))}

      <p className="mt-4 text-[9px] italic leading-relaxed text-slate-500">
        Prepared on a cash basis. The maintenance line is read from receipts issued against villas let on the corporation&rsquo;s
        own account, never from the expense register, so that contribution is counted once and not twice. USD and JMD are
        reported separately and are never combined.
      </p>

      {/* Signed off like every other printed document here, so an internal
          statement still carries who prepared it and who checked it. */}
      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Reviewed / Approved by" />
    </PrintPortal>
  );
}
