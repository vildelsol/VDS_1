/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What each proprietor owes the corporation.
 *
 * The Projections tab is written for the body corporate: its income is the
 * maintenance (HOA) contributions proprietors pay, and rent and short-let booking
 * income are deliberately excluded because they are not the corporation's money.
 * This tab is the other side of that same rule.
 *
 * **Proprietors let their own villas on their own account.** The corporation does
 * not collect rent or guest income for them, and never sees it. What it does
 * collect is contributions — the maintenance levy and each lot's share of the
 * annual insurance premium — so for an ordinary proprietor this page is an
 * account of what they owe, not a remittance of what was gathered for them.
 *
 * The remittance columns are still here, and still correct, for the villas the
 * corporation lets on its *own* account. They render only when money was
 * actually held, so a proprietor's statement is never opened by a line reading
 * "nothing collected in the period" about rent nobody was collecting:
 *
 *     collected (when any) − contributions billed − utilities billed − amounts charged = net
 *
 * Every figure comes from the same finance helpers the ledger, the reports and the
 * projection use, so the two tabs cannot contradict each other. USD and JMD are
 * stated separately and never combined: a villa let in USD with a JMD maintenance
 * fee produces two honest statements rather than one meaningless total.
 */

import { useMemo, useState } from 'react';
import { useRemembered } from '../lib/screenState';
import { AppSettings, Charge, Currency, Expense, Payment, SessionUser, Unit, UtilityReading, getUnitDisplayName,
  bodyCorporateName
} from '../types';
import { OwnerStatement, OwnerStatementGroup, groupStatementsByOwner, ownerStatements } from '../lib/finance';
import { formatMoney, formatMoneyLong } from '../lib/money';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import { openMailDraft } from '../lib/email';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  SecondaryButton,
  TableScroller,
  monoInputClass,
  tableHeadRowClass
} from './ui';
import { Download, Mail, Printer, Users } from 'lucide-react';

interface OwnerStatementsProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  /** Metered utilities billed to a villa, which are charges the owner owes. */
  utilities: UtilityReading[];
  settings: AppSettings;
  session: SessionUser;
}

/**
 * The period a statement covers.
 *
 * "Last month" is first and is the default. An owner statement is a thing that is
 * issued once a month, after the month has finished — offering the part-finished
 * current month first would produce a document that is wrong by the time it is
 * read, and it is the one people would click by accident.
 */
type Preset = 'lastMonth' | 'thisMonth' | 'last3' | 'last6' | 'ytd' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'lastMonth', label: 'Last month' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'last3', label: 'Last 3 months' },
  { key: 'last6', label: 'Last 6 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'custom', label: 'Custom range' }
];

function rangeForPreset(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const now = currentMonth();
  switch (preset) {
    case 'thisMonth':
      return { from: monthStart(now), to: monthEnd(now) };
    case 'last3':
      return { from: monthStart(addMonths(now, -2)), to: monthEnd(now) };
    case 'last6':
      return { from: monthStart(addMonths(now, -5)), to: monthEnd(now) };
    case 'ytd':
      return { from: `${now.substring(0, 4)}-01-01`, to: today() };
    case 'custom':
      return custom;
    default: {
      const m = addMonths(now, -1);
      return { from: monthStart(m), to: monthEnd(m) };
    }
  }
}

/**
 * How a net position is worded.
 *
 * "Due to" and "due from" are not interchangeable, and neither is worth much
 * without saying *who* and *which villa*. A statement covering two villas
 * repeated "Due to proprietor" on both, so a line lifted out of context named
 * nobody. It now names the owner and the villa, because that is the line someone
 * reads out at a meeting or queries a month later.
 */
function netLabel(net: number, owner?: string, unitNumber?: string): string {
  const who = (owner || '').trim();
  const villa = unitNumber ? getUnitDisplayName(unitNumber) : '';

  /*
   * Nothing outstanding is its own state, not a debt of zero.
   *
   * "Due to Fr. Howard James — Villa Unit C12   J$0.00" is what a settled
   * proprietor used to be shown, which reads as a demand however small the
   * figure beside it. A proprietor who has paid should be told they have paid.
   */
  if (net === 0) {
    if (villa) return `Settled in full, ${villa}`;
    return 'Settled in full';
  }

  const direction = net > 0 ? 'Due to' : 'Due from';
  if (who && villa) return `${direction} ${who}, ${villa}`;
  if (who) return `${direction} ${who}`;
  if (villa) return `${direction} the owner of ${villa}`;
  return `${direction} the owner`;
}

export default function OwnerStatements({ units, charges, payments, expenses, utilities, settings, session }: OwnerStatementsProps) {
  const [preset, setPreset] = useRemembered<Preset>('owner-statements.preset', 'lastMonth');
  const [custom, setCustom] = useRemembered('owner-statements.custom', () => ({
    from: monthStart(addMonths(currentMonth(), -1)),
    to: monthEnd(addMonths(currentMonth(), -1))
  }));
  const [printing, setPrinting] = useState<OwnerStatementGroup | null>(null);

  const { from, to } = rangeForPreset(preset, custom);
  const invalidRange = to < from;

  const groups = useMemo(
    () => (invalidRange ? [] : groupStatementsByOwner(ownerStatements(units, charges, payments, expenses, utilities, from, to))),
    [units, charges, payments, expenses, utilities, from, to, invalidRange]
  );

  const hasData = groups.length > 0;

  /**
   * Export every statement as a spreadsheet — one row per villa per currency, so
   * the office can file them, mail-merge them, or hand the lot to an accountant
   * without needing the application. CSV with a byte-order mark, which Excel
   * opens directly with the currency symbols intact.
   */
  /**
   * Every proprietor statement as one Excel workbook, one row per villa.
   *
   * These go to owners and to the corporation's accountant, so the money is
   * written as numbers carrying their own currency format — a column of
   * contributions can be selected and summed by whoever receives it — and the
   * owner's name repeats on every printed page.
   */
  const downloadSpreadsheet = () => {
    const period = `${formatDayLabel(from)} to ${formatDayLabel(to)}`;
    const rows: XlsxCell[][] = [
      ...documentHeader({
        documentTitle: 'Proprietor Statements',
        period,
        generatedOn: formatDayLabel(today()),
        generatedBy: session.name,
        planNumber: settings.strataPlanNumber,
        span: 9
      }),
      [
        cell.header('Proprietor'),
        cell.header('Villa'),
        cell.header('Currency'),
        cell.header('Contribution billed', 'right'),
        cell.header('Received in period', 'right'),
        cell.header('Utilities billed', 'right'),
        cell.header('Charged to villa', 'right'),
        cell.header('Balance', 'right'),
        cell.header('Position')
      ]
    ];

    for (const group of groups) {
      for (const st of group.statements) {
        rows.push([
          cell.text(group.owner || '(owner not recorded)'),
          cell.text(getUnitDisplayName(st.unit.number)),
          cell.text(st.currency),
          cell.money(st.maintenanceBilled, st.currency),
          cell.money(st.maintenancePaid, st.currency),
          cell.money(st.utilityBilled, st.currency),
          cell.money(st.expenses, st.currency),
          cell.money(st.net, st.currency),
          cell.text(netLabel(st.net, st.unit.ownerName, st.unit.number))
        ]);
      }
    }

    rows.push([cell.blank()]);
    rows.push([
      cell.note(
        'Proprietors let their own villas; rent and guest income is theirs in full and does not pass through the corporation. ' +
          'What is shown is the contribution billed for the period less anything received against it, so a proprietor who has ' +
          'paid in full reads as settled. USD and JMD are stated separately and are never combined.',
        9
      )
    ]);

    const headerRow = 7;
    downloadWorkbook(
      [{ name: 'Proprietor statements', widths: [26, 18, 12, 20, 20, 18, 18, 18, 30], rows, freezeRows: headerRow, repeatRow: headerRow, landscape: true }],
      `VDS Proprietor Statements ${from} to ${to}.xlsx`
    );
  };

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-medium text-slate-900">
              <Users className="h-4 w-4 text-teal-600" />
              Owners statements
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              What each proprietor has been billed by the corporation and what they have paid, one statement per villa,
              per currency.
            </p>
          </div>
          <SecondaryButton onClick={downloadSpreadsheet} disabled={!hasData} className="flex items-center gap-1.5 self-start">
            <Download className="h-4 w-4" /> Export for Excel
          </SecondaryButton>
        </div>

        <Field label="Statement period" htmlFor="os-preset">
          <div className="flex flex-wrap gap-2" id="os-preset">
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
        </Field>

        {preset === 'custom' && (
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
            <Field label="From" htmlFor="os-from">
              <input
                id="os-from"
                type="date"
                value={custom.from}
                onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
                className={monoInputClass}
              />
            </Field>
            <Field label="To" htmlFor="os-to">
              <input
                id="os-to"
                type="date"
                value={custom.to}
                onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
                className={monoInputClass}
              />
            </Field>
            <p className="pb-2 font-mono text-[11px] text-slate-500">
              {invalidRange ? 'Invalid range' : `${formatDayLabel(from)} → ${formatDayLabel(to)}`}
            </p>
          </div>
        )}

        {invalidRange && <ErrorNote>The end date must fall on or after the start date.</ErrorNote>}

        <InfoNote>
          Rent and short-term booking income are the proprietor's own and never pass through the corporation's books;
          maintenance (HOA) contributions are the corporation's income. What is deducted is the contribution{' '}
          <strong>still outstanding</strong> for the period, anything already received is shown and taken off, so a
          proprietor who has paid is stated as settled rather than billed again. Expenses are those charged to that villa,
          common property and office costs are the corporation's and never appear here. USD and JMD are stated
          separately and never combined.
        </InfoNote>
      </section>

      {!hasData ? (
        <EmptyState
          title={invalidRange ? 'No statements for an invalid range' : 'Nothing to state for this period'}
          hint="Statements appear once money has been collected against a villa, maintenance has been billed, or an expense has been charged to it."
        />
      ) : (
        <>
          <div className="space-y-6">
            {groups.map(group => (
              <OwnerCard
                key={group.owner || '(unrecorded)'}
                group={group}
                from={from}
                to={to}
                onPrint={() => setPrinting(group)}
              />
            ))}
          </div>

          <p className="px-1 font-mono text-[10px] leading-relaxed text-slate-400">
            {groups.length} proprietor{groups.length === 1 ? '' : 's'} ·{' '}
            {groups.reduce((n, g) => n + g.statements.length, 0)} statement
            {groups.reduce((n, g) => n + g.statements.length, 0) === 1 ? '' : 's'} · period{' '}
            {formatDayLabel(from)} to {formatDayLabel(to)}
          </p>
        </>
      )}

      {printing && (
        <OwnerStatementDocument
          group={printing}
          from={from}
          to={to}
          settings={settings}
          generatedBy={session.name}
          onClose={() => setPrinting(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OwnerCard({
  group,
  from,
  to,
  onPrint
}: {
  group: OwnerStatementGroup;
  from: string;
  to: string;
  onPrint: () => void;
}) {
  const villas = new Set(group.statements.map(s => s.unit.id));

  /*
   * There is no Collected column.
   *
   * It meant rent or guest income taken in on the owner's behalf, and the
   * corporation does not do that for any proprietor — every owner lets their own
   * villa. The column was therefore permanently J$0.00, and sitting beside a
   * contribution the owner had actually paid it read as though the payment had
   * been missed. Confirmed by Ro on 2026-09-01 and removed rather than hidden.
   */

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
      <div className="flex flex-col justify-between gap-3 border-b border-slate-100 bg-slate-50 p-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h3 className="truncate font-display text-sm font-semibold text-slate-900">
            {group.owner || 'Owner not recorded'}
          </h3>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-500">
            {villas.size} villa{villas.size === 1 ? '' : 's'} · {formatDayLabel(from)} to {formatDayLabel(to)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {group.netByCurrency.map(row => (
            <Badge key={row.currency} tone={row.net < 0 ? 'red' : 'green'}>
              {/* "Settled in full J$0.00" states the nil twice; the words are the
                  whole message when nothing is owed. */}
              {netLabel(row.net, group.owner)}
              {row.net !== 0 ? ` ${formatMoney(Math.abs(row.net), row.currency)}` : ''}
            </Badge>
          ))}
          <SecondaryButton onClick={onPrint} className="flex items-center gap-1.5 bg-white">
            <Printer className="h-3.5 w-3.5" /> Statement
          </SecondaryButton>
        </div>
      </div>

      <TableScroller>
        <table className="w-full min-w-[820px] border-collapse text-left text-xs">
          <thead>
            <tr className={tableHeadRowClass}>
              <th scope="col" className="p-4">Villa</th>
              <th scope="col" className="p-4">Currency</th>
              <th scope="col" className="p-4 text-right">Maintenance billed</th>
              <th scope="col" className="p-4 text-right">Villa expenses</th>
              <th scope="col" className="p-4 text-right">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {group.statements.map(s => (
              <tr key={`${s.unit.id}-${s.currency}`} className="align-top hover:bg-slate-50/50">
                <td className="p-4 font-medium text-slate-900">{getUnitDisplayName(s.unit.number)}</td>
                <td className="p-4 font-mono text-slate-500">{s.currency}</td>
                <td className="p-4 text-right">
                  <span className="font-mono text-rose-500">{formatMoney(s.maintenanceBilled, s.currency)}</span>
                  {/* Said out loud because it is deducted from the net beside it.
                      This line used to read "already received" while the net still
                      demanded the full contribution — the page contradicted itself
                      on a proprietor who had paid. */}
                  {s.maintenancePaid > 0 && (
                    <span className="mt-0.5 block font-mono text-[10px] leading-relaxed text-emerald-700">
                      less {formatMoney(s.maintenancePaid, s.currency)} received in the period
                    </span>
                  )}
                  {s.maintenanceOutstanding > 0 && (
                    <span className="mt-0.5 block font-mono text-[10px] leading-relaxed text-slate-400">
                      {formatMoney(s.maintenanceOutstanding, s.currency)} outstanding at period end
                    </span>
                  )}
                </td>
                <td className="p-4 text-right font-mono text-rose-500">{formatMoney(s.expenses, s.currency)}</td>
                <td
                  className={`p-4 text-right font-mono font-semibold ${s.net < 0 ? 'text-red-600' : 'text-emerald-700'}`}
                >
                  {formatMoney(s.net, s.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
    </section>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The document an owner is actually sent: every villa they hold, every figure
 * itemised down to the individual receipt and invoice, and the net position at the
 * end. It is itemised because an owner statement is queried line by line — "what
 * is this expense?" — and a document that can only answer with a total is not one
 * an owner will accept.
 */
function OwnerStatementDocument({
  group,
  from,
  to,
  settings,
  generatedBy,
  onClose
}: {
  group: OwnerStatementGroup;
  from: string;
  to: string;
  settings: AppSettings;
  generatedBy: string;
  onClose: () => void;
}) {
  const ownerEmail = group.statements.map(s => s.unit.ownerEmail).find(Boolean) || '';
  const period = `${formatDayLabel(from)} to ${formatDayLabel(to)}`;

  const emailDraft = () => {
    const body = [
      `Dear ${group.owner || 'Sir/Madam'},`,
      '',
      `Please find your proprietor statement for ${period} summarised below.`,
      '',
      // No collection line: the corporation collects nothing for a proprietor,
      // and quoting a nil collection invites a question about rent that was
      // never the corporation's to take.
      ...group.statements.flatMap(s => [
        `${getUnitDisplayName(s.unit.number)} (${s.currency})`,
        `  Contributions billed     : ${formatMoneyLong(s.maintenanceBilled, s.currency)}`,
        ...(s.maintenancePaid !== 0 ? [`  Less received            : ${formatMoneyLong(s.maintenancePaid, s.currency)}`] : []),
        ...(s.expenses !== 0 ? [`  Charged to your villa    : ${formatMoneyLong(s.expenses, s.currency)}`] : []),
        `  ${netLabel(s.net, s.unit.ownerName, s.unit.number)} : ${formatMoneyLong(Math.abs(s.net), s.currency)}`,
        ''
      ]),
      'A full itemised statement is attached or available on request.',
      '',
      'Villaggio Del Sol Management'
    ].join('\n');
    openMailDraft({ to: ownerEmail, subject: `Owner statement, ${period}`, body });
  };

  return (
    <PrintPortal
      title={`Owner statement, ${group.owner || 'Owner not recorded'}`}
      subtitle={period}
      onClose={onClose}
      maxWidthClass="max-w-4xl"
      actions={
        <button
          type="button"
          onClick={emailDraft}
          disabled={!ownerEmail}
          title={ownerEmail ? `Draft an email to ${ownerEmail}` : 'No email address on file for this owner'}
          className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50 disabled:opacity-50"
        >
          <Mail className="h-3.5 w-3.5" />
          Email
        </button>
      }
    >
      <PrintLetterhead documentTitle="Owner Statement" meta={period} generatedBy={generatedBy} />

      {/*
        "Net position: -J$150,000" asks the reader to work out that a minus sign
        means they owe it. When the corporation collected nothing there is no
        position to net — there is a balance owing — so the tile says that and
        drops the sign. The netting language stays for the villas the corporation
        does let, where money genuinely runs both ways.
      */}
      <section className="mb-5 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
        {[
          ['Registered proprietor', group.owner || '-'],
          ['Villas', String(new Set(group.statements.map(s => s.unit.id)).size)],
          ['Period', period],
          // Nothing is ever collected for a proprietor, so this is always a
          // balance rather than a netted position. "Balance owing J$0.00" is a
          // demand for nothing, so a settled owner is told they have settled.
          group.netByCurrency.length > 0 && group.netByCurrency.every(r => r.net === 0)
            ? ['Balance', 'Settled in full']
            : [
                group.netByCurrency.every(r => r.net <= 0) ? 'Balance owing' : 'Balance',
                group.netByCurrency.map(r => formatMoneyLong(Math.abs(r.net), r.currency)).join(' · ') || '-'
              ]
        ].map(([label, value]) => (
          <div key={label}>
            <span className="block font-mono text-[9px] uppercase text-slate-500">{label}</span>
            <span className="font-semibold text-slate-900">{value}</span>
          </div>
        ))}
      </section>

      {group.statements.map(s => (
        <StatementSection key={`${s.unit.id}-${s.currency}`} statement={s} />
      ))}

      {/*
        Retitled from "Basis", which told a lay proprietor nothing, and corrected.
        The first bullet used to state that rent and booking income were
        "collected on your behalf by the managing agent". That is not the
        arrangement: proprietors let their own villas entirely on their own
        account, and the corporation collects only contributions. A statement
        that describes a service it does not provide is worse than one that says
        nothing, so the claim is gone rather than softened.
      */}
      <section className="mb-5 break-inside-avoid">
        <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
          How this statement is prepared
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-[11px] leading-relaxed">
          <li>
            This is an account of what you owe the body corporate,{' '}
            <strong>{bodyCorporateName(settings)}</strong>, not of income from your villa. Letting your villa is
            yours to arrange, and any rent or guest income from it is yours in full and does not pass through this
            corporation.
          </li>
          <li>
            Each contribution is shown as billed for the period, and anything already received against it in the same
            period is deducted immediately beneath. What you are asked for is therefore the amount{' '}
            <strong>still outstanding</strong>, and a contribution paid in full leaves nothing owing.
          </li>
          <li>
            Only amounts the corporation charges you appear here, your maintenance contribution, your share of the
            annual insurance premium, and anything separately recharged to your villa. Your utilities are supplied on
            your own meter in your own name and settled directly with the utility, so they never appear on this
            statement. Common property and office costs are the corporation's.
          </li>
          <li>
            Only payments confirmed as received are credited; money expected but not yet received counts for nothing.
            USD and JMD are stated separately and never combined.
          </li>
        </ul>
      </section>

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        This statement is prepared from the property's records for the period stated and is not a tax document.
        Indicative rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD, shown for reference only; no figure on this
        statement has been converted.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Received / Acknowledged by" rightName={group.owner} />
    </PrintPortal>
  );
}

/** One villa, one currency: the itemised working behind the net figure. */
function StatementSection({ statement: s }: { statement: OwnerStatement }) {
  const c = s.currency;
  return (
    <section className="mb-6 break-inside-avoid">
      <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
        {getUnitDisplayName(s.unit.number)}, {c}
      </h3>

      <TableScroller>
        <table className="w-full text-left text-[10px]">
          <tbody className="font-mono">
            {/*
              There is no "collected on your behalf" section, and there is no
              collection column on the summary table either.

              The corporation does not collect rent or guest income for any
              proprietor — every owner lets their own villa and that money never
              passes through these books. A nil collection line therefore did not
              describe a month in which nothing happened to be collected; it
              described an arrangement that does not exist, and it read as a
              failure to collect rent that was never the corporation's to take.
              Confirmed by Ro on 2026-09-01 and removed outright rather than
              hidden behind a condition.

              This page is an account of what the proprietor owes the
              corporation, so the headings say so plainly rather than as
              deductions from a remittance.
            */}
            <LineGroup
              title="Maintenance contribution billed"
              rows={s.maintenanceCharges.map(charge => ({
                date: charge.dueDate,
                detail: charge.description || `Maintenance, ${formatMonthLabel(charge.periodMonth)}`,
                ref: '',
                amount: charge.amount
              }))}
              total={s.maintenanceBilled}
              currency={c}
              tone="debit"
              emptyLabel="No maintenance billed in the period."
              note={
                s.maintenancePaid > 0
                  ? `Less ${formatMoney(s.maintenancePaid, c)} received in this period, already deducted from the amount due below.`
                  : undefined
              }
            />
            {/*
              Shown only when the corporation actually metered and billed this
              villa — which for a proprietor it does not, because each owner's
              supply is in their own name and settled directly with the utility.
              Rendering it regardless would put "no utilities were billed to this
              villa" on every proprietor's statement, about a bill that was never
              the corporation's to raise.

              It stays for the villas the corporation lets on its own account,
              where it does meter the occupant and the figure is real.
            */}
            {s.utilityCharges.length > 0 && (
            <LineGroup
              title="Utilities billed to your villa"
              rows={s.utilityCharges.map(u => ({
                date: monthEnd(u.billingPeriod),
                detail: `Utilities, ${formatMonthLabel(u.billingPeriod)}${u.meterNumber ? ` (meter ${u.meterNumber})` : ''}${
                  u.consumption ? `, ${u.consumption} units` : ''
                }`,
                ref: u.status === 'paid' ? 'settled' : 'unpaid',
                amount: u.amountCharged
              }))}
              total={s.utilityBilled}
              currency={c}
              tone="debit"
              emptyLabel="No utilities were billed to this villa in the period."
            />
            )}
            <LineGroup
              title="Charged to your villa"
              rows={s.expenseItems.map(e => ({
                date: e.datePaid || e.date,
                detail: `${e.category}${e.vendor ? `, ${e.vendor}` : ''}${e.description ? `, ${e.description}` : ''}`,
                ref: e.reference,
                amount: e.amount
              }))}
              total={s.expenses}
              currency={c}
              tone="debit"
              emptyLabel="Nothing else was charged to this villa in the period."
            />
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-400 font-mono font-bold">
              <td className="p-2" colSpan={3}>
                {netLabel(s.net, s.unit.ownerName, s.unit.number)}
              </td>
              <td className="p-2 text-right">{formatMoney(Math.abs(s.net), c)}</td>
            </tr>
          </tfoot>
        </table>
      </TableScroller>

      {s.maintenanceOutstanding > 0 && (
        <p className="mt-2 rounded-lg border border-slate-300 p-2 text-[10px] leading-relaxed">
          <strong>{formatMoneyLong(s.maintenanceOutstanding, c)}</strong> in maintenance contributions remains
          outstanding on this villa as at {formatDayLabel(s.to)}, across all periods. This is a separate debt to the
          body corporate and is not included in the net figure above.
        </p>
      )}
    </section>
  );
}

function LineGroup({
  title,
  rows,
  total,
  currency,
  tone,
  emptyLabel,
  note
}: {
  title: string;
  rows: { date: string; detail: string; ref: string; amount: number }[];
  total: number;
  currency: Currency;
  tone: 'credit' | 'debit';
  emptyLabel: string;
  note?: string;
}) {
  return (
    <>
      {/*
        Horizontally padded to the same inset as the cells beneath it. The
        heading previously carried only vertical padding, so every section title
        sat hard against the table's left rule while its own rows were indented
        by `p-2` — the heading looked like it belonged to the border rather than
        to the figures under it.
      */}
      <tr>
        <td colSpan={4} className="px-2 pt-4 pb-1 font-sans text-[10px] font-bold uppercase tracking-wide text-slate-700">
          {title}
        </td>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={4} className="p-2 font-sans text-[10px] italic text-slate-500">
            {emptyLabel}
          </td>
        </tr>
      ) : (
        rows.map((row, i) => (
          <tr key={i}>
            <td className="whitespace-nowrap p-2">{formatDayLabel(row.date)}</td>
            <td className="p-2 font-sans">{row.detail}</td>
            <td className="p-2">{row.ref || '-'}</td>
            <td className={`p-2 text-right ${tone === 'credit' ? 'text-emerald-700' : ''}`}>
              {formatMoney(row.amount, currency)}
            </td>
          </tr>
        ))
      )}
      <tr className="border-t border-slate-300 font-semibold">
        <td className="p-2 font-sans" colSpan={3}>
          {/* "Total Maintenance contribution billed" read as two headings collided;
              the section name is lower-cased so the total reads as a sentence. */}
          {tone === 'credit'
            ? 'Total collected'
            : `Total ${title.replace('Less: ', '').replace(/^./, ch => ch.toLowerCase())}`}
        </td>
        <td className="p-2 text-right">{formatMoney(total, currency)}</td>
      </tr>
      {note && (
        <tr>
          <td colSpan={4} className="p-2 font-sans text-[10px] leading-relaxed text-slate-600">
            {note}
          </td>
        </tr>
      )}
    </>
  );
}
