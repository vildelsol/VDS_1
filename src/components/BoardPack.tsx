/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The board pack.
 *
 * Preparing for a committee meeting used to mean printing the operating
 * statement, then the chart pack, then reading the arrears off a third screen —
 * three documents, three letterheads, three chances for the covering figures to
 * be quoted from a different date than the charts behind them. This is one
 * document for one date range, opening with the figures a committee actually
 * votes on and carrying the charts that evidence them.
 *
 * It computes nothing of its own. Every number comes from the same finance
 * helpers as the ledger, the operating statement and the statutory returns, so a
 * board pack can never quote a figure the ledger would contradict.
 */

import React from 'react';
import { AppSettings, Booking, Charge, Currency, Expense, Payment, Tenancy, Unit } from '../types';
import {
  accountBalance,
  arrearsAgeing,
  chargedInPeriod,
  collectedInPeriod,
  collectionRate,
  expenseBreakdown,
  expensesInPeriod,
  occupancySeries,
  occupiedUnitIdsOn,
  ownerBilledUnitIds
} from '../lib/finance';
import { formatMoney, round2, sumMoney } from '../lib/money';
import { addDays, formatDayLabel, monthEnd, monthStart, monthsBetween } from '../lib/dates';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import {
  ArrearsAgeingChart,
  CashFlowChart,
  CategoryBarChart,
  CategoryTable,
  CollectionRateChart,
  MonthRow,
  OccupancyChart
} from './Charts';

interface BoardPackProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  tenancies: Tenancy[];
  bookings: Booking[];
  settings: AppSettings;
  from: string;
  to: string;
  generatedBy: string;
  onClose: () => void;
}

export default function BoardPack({
  units,
  charges,
  payments,
  expenses,
  tenancies,
  bookings,
  settings,
  from,
  to,
  generatedBy,
  onClose
}: BoardPackProps) {
  const ownerBilled = ownerBilledUnitIds(units);
  const months = monthsBetween(from, to);

  const byCurrency = (['JMD', 'USD'] as Currency[])
    .map(currency => {
      const rows: MonthRow[] = months.map(month => {
        const mFrom = monthStart(month) < from ? from : monthStart(month);
        const mTo = monthEnd(month) > to ? to : monthEnd(month);
        const byCategory: Record<string, number> = {};
        for (const row of expenseBreakdown(expenses, currency, mFrom, mTo)) {
          if (row.amount > 0) byCategory[row.category] = row.amount;
        }
        const collectedInMonth = collectedInPeriod(payments, currency, mFrom, mTo, ownerBilled);
        return {
          month,
          billed: chargedInPeriod(charges, currency, mFrom, mTo).total,
          received: collectedInMonth.total,
          receivedAgainstBilled: sumMoney([collectedInMonth.rent, collectedInMonth.maintenance]),
          paidOut: expensesInPeriod(expenses, currency, mFrom, mTo),
          byCategory
        };
      });

      const collected = collectedInPeriod(payments, currency, from, to, ownerBilled);
      const billed = chargedInPeriod(charges, currency, from, to);
      const spent = expensesInPeriod(expenses, currency, from, to);

      // Same opening/closing receivable construction as the operating statement.
      const receivableAt = (asOf: string) =>
        sumMoney(
          units.flatMap(unit =>
            (['Rent', 'Maintenance'] as const)
              .map(category => accountBalance(unit, category, charges, payments, asOf, units))
              .filter(account => account.currency === currency)
              .map(account => account.balance)
          )
        );

      const breakdown = expenseBreakdown(expenses, currency, from, to).filter(row => row.amount > 0);

      return {
        currency,
        rows,
        breakdown,
        billed,
        collected,
        spent,
        net: sumMoney([collected.total, -spent]),
        rate: collectionRate(billed.total, sumMoney([collected.rent, collected.maintenance])),
        openingReceivable: receivableAt(addDays(from, -1)),
        closingReceivable: receivableAt(to),
        active: rows.some(r => r.billed || r.received || r.paidOut) || breakdown.length > 0
      };
    })
    .filter(entry => entry.active);

  const occupancy = occupancySeries(units, tenancies, bookings, months, to);
  const ageing = arrearsAgeing(units, charges, payments, to);
  const occupiedAtEnd = occupiedUnitIdsOn(units, tenancies, bookings, to).size;

  return (
    <PrintPortal
      title="Board pack"
      subtitle={`${formatDayLabel(from)} to ${formatDayLabel(to)}`}
      onClose={onClose}
      maxWidthClass="max-w-4xl"
    >
      <PrintLetterhead
        documentTitle="Board Pack"
        meta={`Period ${formatDayLabel(from)} — ${formatDayLabel(to)}`}
        generatedBy={generatedBy}
      />

      {/* ---------------- executive summary ---------------- */}

      <section className="mb-8 break-inside-avoid">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
          Position at {formatDayLabel(to)}
        </h3>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <SummaryTile
            label="Villas rented"
            value={`${occupiedAtEnd} of ${units.length}`}
            note={units.length > 0 ? `${round2((occupiedAtEnd / units.length) * 100)}% of the register` : 'No villas registered'}
          />
          <SummaryTile
            label="Accounts in arrears"
            value={String(
              units.flatMap(unit =>
                (['Rent', 'Maintenance'] as const)
                  .map(category => accountBalance(unit, category, charges, payments, to, units))
                  .filter(account => account.balance > 0)
              ).length
            )}
            note={
              ageing.length > 0
                ? ageing.map(entry => formatMoney(entry.buckets.total, entry.currency)).join(' + ') + ' outstanding'
                : 'Nothing outstanding'
            }
          />
        </div>

        {byCurrency.length === 0 ? (
          <p className="text-[11px] italic text-slate-500">No financial activity was recorded in this period.</p>
        ) : (
          <table className="w-full border-collapse text-left text-[11px]">
            <thead>
              <tr className="border-b border-slate-300">
                <th scope="col" className="py-1.5">Measure</th>
                {byCurrency.map(entry => (
                  <th key={entry.currency} scope="col" className="py-1.5 text-right font-mono">
                    {entry.currency}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(
                [
                  { label: 'Billed (rent and maintenance)', of: e => formatMoney(e.billed.total, e.currency) },
                  { label: 'Received against billing', of: e => formatMoney(sumMoney([e.collected.rent, e.collected.maintenance]), e.currency) },
                  { label: 'Collection rate', of: e => (e.rate === null ? 'n/a' : `${e.rate}%`) },
                  { label: 'Total received (all sources)', of: e => formatMoney(e.collected.total, e.currency) },
                  { label: 'Paid out', of: e => formatMoney(e.spent, e.currency) },
                  { label: 'Net cash movement', of: e => formatMoney(e.net, e.currency) },
                  { label: 'Receivable at start', of: e => formatMoney(e.openingReceivable, e.currency) },
                  { label: 'Receivable at end', of: e => formatMoney(e.closingReceivable, e.currency) }
                ] satisfies { label: string; of: (entry: (typeof byCurrency)[number]) => string }[]
              ).map(row => (
                <tr key={row.label}>
                  <td className="py-1.5">{row.label}</td>
                  {byCurrency.map(entry => (
                    <td key={entry.currency} className="py-1.5 text-right font-mono">
                      {row.of(entry)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ---------------- occupancy ---------------- */}

      {units.length > 0 && (
        <section className="mb-8 space-y-3">
          <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">Occupancy</h3>
          <OccupancyChart series={occupancy} />
        </section>
      )}

      {/* ---------------- arrears ---------------- */}

      {ageing.length > 0 && (
        <section className="mb-8 space-y-4">
          <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
            Arrears ageing at {formatDayLabel(to)}
          </h3>
          {ageing.map(entry => (
            <ArrearsAgeingChart key={entry.currency} buckets={entry.buckets} currency={entry.currency} />
          ))}
          <p className="font-mono text-[9px] leading-relaxed text-slate-500">
            Aged in the same buckets, by the same function, as the Form 13B return on outstanding contributions. Only the
            uncovered remainder of a part-paid charge is aged, so these columns total the outstanding balance exactly.
          </p>
        </section>
      )}

      {/* ---------------- money, per currency ---------------- */}

      {byCurrency.map(entry => (
        <section key={entry.currency} className="mb-8 space-y-5">
          <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
            {entry.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} ({entry.currency})
          </h3>
          <CashFlowChart rows={entry.rows} currency={entry.currency} />
          <CollectionRateChart rows={entry.rows} currency={entry.currency} />
          <CategoryBarChart breakdown={entry.breakdown} currency={entry.currency} />
          <CategoryTable breakdown={entry.breakdown} currency={entry.currency} />
        </section>
      ))}

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        USD and JMD are reported separately and are never combined. Utility recoveries billed directly to owners of
        owner-occupied and short-let villas are excluded from received income, matching the operating statement.
        Indicative rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD, for display only — no stored amount is
        converted.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Reviewed / Approved by" />
    </PrintPortal>
  );
}

function SummaryTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="print-outline rounded-lg border border-slate-300 bg-slate-50 p-3">
      <span className="block font-mono text-[9px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="mt-0.5 block font-mono text-lg font-bold text-slate-900">{value}</span>
      <span className="block text-[10px] text-slate-500">{note}</span>
    </div>
  );
}
