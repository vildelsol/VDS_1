/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The out-of-pocket shortfall — what VDS funded on the villas it lets.
 *
 * Designed 2026-09-02 when Ro asked what such a report would look like, and
 * built on his yes. The gap it fills is not an arithmetic one: on the villas VDS
 * lets on its own account the maintenance contribution is paid out of the rent
 * that villa collects, so a month with no tenant is a month VDS finds the
 * contribution from somewhere else. The books bill a vacant villa perfectly
 * correctly and have never had any concept that the rent was what paid it.
 *
 * **Administrators only, and it appears on nothing an owner ever sees.** Ro,
 * 2026-09-02: *"it should not be reflected in any public facing reports
 * whatsoever, that includes owners. this is just for us as admin."* Nothing else
 * in the application calls `outOfPocketShortfall` — not the owner statement, the
 * board pack, the annual report, the operating statement or the operations
 * statement — and nothing should. See `MAY_SEE_SHORTFALL` below.
 *
 * **It sits under Operational Reports, below the operating statement, and it is
 * badged internal.** That placement was specified and it is load-bearing: the
 * operating statement is the strata corporation's income and expenditure, this
 * is VDS's own trading position as a landlord, and the two entities must stay
 * apart. On one page they would be read as one set of books.
 *
 * Two views come off one engine, because there are two questions:
 *
 *   - **By villa** — is this villa worth letting?
 *   - **By month** — how much cash did we need to find?
 *
 * The months that cost money are named rather than counted. "J$240,000 across
 * seven villa-months" is a figure nobody can act on until they can see which
 * seven.
 *
 * **Short-stay income counts against the contribution.** The first cut of this
 * report offset it with long-term rent only and carried booking receipts as a
 * memo. Ro: *"when a unit is vacant or under short term/airbnb Villaggio still
 * has to cover that cost"* — so what the villa earned is rent plus short-stay,
 * and a villa that paid its own way on Airbnb is not reported as having cost
 * anything. Rent and short-stay keep their own columns, because how a villa was
 * let is a separate question from whether it paid for itself.
 */

import { useMemo, useState } from 'react';
import { Booking, Currency, Payment, SessionUser, Tenancy, Unit } from '../types';
import { ShortfallReport as Report, outOfPocketShortfall } from '../lib/finance';
import { formatMoney } from '../lib/money';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import { XlsxCell, cell, documentHeader, downloadWorkbook } from '../lib/xlsx';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import {
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  SecondaryButton,
  SubmitButton,
  TableScroller,
  monoInputClass,
  tableHeadRowClass
} from './ui';
import { Download, Printer } from 'lucide-react';

interface Props {
  units: Unit[];
  tenancies: Tenancy[];
  bookings: Booking[];
  payments: Payment[];
  session: SessionUser;
}

const CURRENCIES: Currency[] = ['JMD', 'USD'];

/**
 * Whole months, the same control the operating statement carries and for the
 * same reason: a period that cuts a month in half produces a contribution
 * counted against a fortnight of rent, which is not a comparison anybody means
 * to make.
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

type View = 'villa' | 'month';

/**
 * Who may see this at all.
 *
 * Ro, 2026-09-02: *"The shortfall is for internal uses only, it should not be
 * reflected in any public facing reports whatsoever, that includes owners"* —
 * and then, when it was first built for administrators alone: *"just for us as
 * admin means every staff member who has an account so ensure every role can see
 * it, not just adminstrators. Or make it an access checkbox in the settings."*
 *
 * So **internal means internal to the office**, not to one login. Every role sees
 * it by default, and it is a permission rather than an open door because Ro
 * asked for the choice to live in System Settings — where it can be withdrawn
 * from a role without a release. Administrators are never gated, exactly as
 * everywhere else in this application.
 *
 * ⚠️ **This is a visibility rule, not a security boundary**, and it must not be
 * described as one. Every screen in this application computes from `/api/db`,
 * which any signed-in session can fetch, and the receipts underneath are already
 * on the ledger. Withdrawing the permission keeps VDS's trading position off a
 * colleague's page; it does not put it behind a lock. A real boundary would need
 * the figures computed on the server behind that permission, which is a
 * different piece of work and has not been asked for.
 */
function maySeeShortfall(session: SessionUser): boolean {
  if (session.role === 'ADMINISTRATOR') return true;
  // Absent means granted: a database written before the permission existed must
  // not read the missing value as a denial.
  return session.permissions?.viewShortfall !== false;
}

export default function ShortfallReport({ units, tenancies, bookings, payments, session }: Props) {
  const [printing, setPrinting] = useState(false);
  /*
   * Closed until it is asked for. Ro, 2026-09-02: *"make it a toggle switch as it
   * is not something we need to have open permanently."* Operational Reports is a
   * screen people leave open in front of whoever is at the desk, and VDS's own
   * trading position does not belong on it by default. Nothing is computed while
   * it is shut.
   */
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<Preset>('ytd');
  const [view, setView] = useState<View>('villa');
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

  const all = useMemo(
    () =>
      !open || invalidRange
        ? []
        : CURRENCIES.map(currency => outOfPocketShortfall(units, tenancies, bookings, payments, currency, from, to)),
    [open, units, tenancies, bookings, payments, from, to, invalidRange]
  );

  const reports = all.filter(r => !r.empty);

  /*
   * "No villa is ticked" and "the ticked villas had a quiet period" are
   * different states and must not share an empty message. The first is a setup
   * step nobody has done, and saying "nothing to report" would leave the reader
   * believing a report they never configured.
   */
  const noneFlagged = all.length > 0 && all.every(r => r.noneFlagged);

  const period =
    monthStart(from.slice(0, 7)) === from && monthEnd(from.slice(0, 7)) === to
      ? formatMonthLabel(from.slice(0, 7))
      : `${formatDayLabel(from)} to ${formatDayLabel(to)}`;

  /*
   * Checked after the hooks, never before them: React requires the same hooks to
   * run on every render, and an early return above them would break the rules of
   * hooks the moment a session changed role.
   */
  if (!maySeeShortfall(session)) return null;

  const exportWorkbook = () => {
    const sheets = reports.map(r => {
      const rows: XlsxCell[][] = [
        ...documentHeader({
          documentTitle: `Out-of-pocket shortfall — internal (${r.currency})`,
          period,
          generatedOn: formatDayLabel(today()),
          generatedBy: session.name,
          span: 8
        }),
        [cell.note('Internal to VDS. Not a strata document and not the corporation’s income and expenditure.', 8)],
        [cell.blank()],
        [cell.section('By villa', 8)],
        [
          cell.header('Villa'),
          cell.header('Days let'),
          cell.header('Days in period'),
          cell.header('Rent received', 'right'),
          cell.header('Short stay received', 'right'),
          cell.header('Earned', 'right'),
          cell.header('Maintenance paid', 'right'),
          cell.header('Funded by VDS', 'right')
        ]
      ];

      for (const v of r.byVilla) {
        rows.push([
          cell.text(v.villa),
          cell.number(v.occupiedDays),
          cell.number(v.daysCounted),
          cell.money(v.rentReceived, r.currency),
          cell.money(v.shortStayReceived, r.currency),
          cell.money(v.earned, r.currency),
          cell.money(v.maintenancePaid, r.currency),
          cell.money(v.shortfall, r.currency)
        ]);
      }
      rows.push([
        cell.total('TOTAL'),
        cell.total(''),
        cell.total(''),
        cell.totalMoney(r.totalRentReceived, r.currency),
        cell.totalMoney(r.totalShortStayReceived, r.currency),
        cell.totalMoney(r.totalEarned, r.currency),
        cell.totalMoney(r.totalMaintenancePaid, r.currency),
        cell.totalMoney(r.totalShortfall, r.currency)
      ]);

      rows.push([cell.blank()]);
      rows.push([cell.section('By month', 8)]);
      rows.push([
        cell.header('Month'),
        cell.header('Villas empty'),
        cell.header(''),
        cell.header('Rent received', 'right'),
        cell.header('Short stay received', 'right'),
        cell.header('Earned', 'right'),
        cell.header('Maintenance paid', 'right'),
        cell.header('Funded by VDS', 'right')
      ]);
      for (const m of r.byMonth) {
        rows.push([
          cell.text(formatMonthLabel(m.month)),
          cell.text(m.vacantVillas.length > 0 ? m.vacantVillas.join(', ') : '—'),
          cell.text(''),
          cell.money(m.rentReceived, r.currency),
          cell.money(m.shortStayReceived, r.currency),
          cell.money(m.earned, r.currency),
          cell.money(m.maintenancePaid, r.currency),
          cell.money(m.shortfall, r.currency)
        ]);
      }

      rows.push([cell.blank()]);
      rows.push([cell.section('Every villa-month', 8)]);
      rows.push([
        cell.header('Villa'),
        cell.header('Month'),
        cell.header('Days let'),
        cell.header('Rent received', 'right'),
        cell.header('Short stay received', 'right'),
        cell.header('Earned', 'right'),
        cell.header('Maintenance paid', 'right'),
        cell.header('Funded by VDS', 'right')
      ]);
      for (const l of r.lines) {
        rows.push([
          cell.text(l.villa),
          cell.text(formatMonthLabel(l.month)),
          cell.number(l.occupiedDays),
          cell.money(l.rentReceived, r.currency),
          cell.money(l.shortStayReceived, r.currency),
          cell.money(l.earned, r.currency),
          cell.money(l.maintenancePaid, r.currency),
          cell.money(l.shortfall, r.currency)
        ]);
      }

      rows.push([cell.blank()]);
      rows.push([cell.section('The months VDS funded', 8)]);
      if (r.fundedMonths.length === 0) {
        rows.push([cell.text('None in this period — every villa covered its own contribution.')]);
      } else {
        for (const v of r.fundedMonths) {
          rows.push([
            cell.text(v.villa),
            cell.text(formatMonthLabel(v.month)),
            cell.text(v.vacant ? 'empty all month' : 'let, but earned less than the contribution'),
            cell.text(''),
            cell.text(''),
            cell.text(''),
            cell.text(''),
            cell.money(v.shortfall, r.currency)
          ]);
        }
        rows.push([
          cell.total(`Funded across ${r.fundedVillaMonths} villa-month(s), ${r.vacantVillaMonths} of them empty throughout`),
          cell.total(''),
          cell.total(''),
          cell.total(''),
          cell.total(''),
          cell.total(''),
          cell.total(''),
          cell.totalMoney(r.totalShortfall, r.currency)
        ]);
      }

      if (r.currencyNotes.length > 0) {
        rows.push([cell.blank()]);
        rows.push([cell.section('No shortfall computed', 8)]);
        for (const n of r.currencyNotes) {
          rows.push([cell.text(n.villa), cell.text(`rent in ${n.rentCurrency}, contribution in ${n.maintCurrency}`)]);
        }
        rows.push([
          cell.note(
            'Rent and contribution are in different currencies, so subtracting one from the other would invent a figure. Named here rather than left out.',
            8
          )
        ]);
      }

      rows.push([cell.blank()]);
      rows.push([
        cell.note(
          `All figures are in ${r.currency} and nothing on this sheet is converted. Cash basis: earnings counted when received, the contribution counted when paid. ` +
            '“Earned” is rent plus short-stay receipts — both fund the contribution, so both are subtracted from it. ' +
            'Days let are counted from tenancies and bookings, not from the villa’s current status.',
          8
        )
      ]);

      const headerRow = rows.findIndex(row => row.some(cl => cl.style === 'header')) + 1;
      return {
        name: `Shortfall ${r.currency}`,
        widths: [16, 26, 14, 18, 20, 18, 18, 18],
        rows,
        freezeRows: headerRow,
        repeatRow: headerRow,
        landscape: true
      };
    });

    if (sheets.length === 0) return;
    downloadWorkbook(sheets, `VDS Out-of-pocket shortfall ${from} to ${to}.xlsx`);
  };

  return (
    <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-lg font-medium text-slate-900">Out-of-pocket shortfall</h2>
            <span className="rounded-md bg-amber-100 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-800">
              Internal
            </span>
          </div>
          <p className="text-xs text-slate-500">
            What VDS funded from its own account on the villas it lets, in the months the villa did not earn its contribution.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/*
            The switch itself. A real switch rather than a "Show" link, because
            this is a thing that is on or off rather than a place to navigate to,
            and it says which state it is in without being read closely.
          */}
          <button
            type="button"
            role="switch"
            aria-checked={open}
            aria-label="Show the out-of-pocket shortfall"
            onClick={() => setOpen(v => !v)}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
              open ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
            }`}
          >
            <span
              aria-hidden="true"
              className={`relative inline-block h-4 w-7 rounded-full transition-colors ${open ? 'bg-emerald-400' : 'bg-slate-300'}`}
            >
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${open ? 'left-3.5' : 'left-0.5'}`} />
            </span>
            {open ? 'Showing' : 'Show report'}
          </button>
          {open && (
            <>
              <SecondaryButton onClick={exportWorkbook} disabled={reports.length === 0} className="flex items-center gap-1.5">
                <Download className="h-4 w-4" /> Export for Excel
              </SecondaryButton>
              <SubmitButton type="button" onClick={() => setPrinting(true)} disabled={reports.length === 0}>
                <Printer className="h-4 w-4" /> Print report
              </SubmitButton>
            </>
          )}
        </div>
      </div>

      {/*
        Shut by default and shut again on every visit. Nothing below is computed
        while it is closed, so this is also the cheapest state — the engine walks
        every day in the period across every villa.
      */}
      {!open ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
          Closed by default. This is VDS&rsquo;s own trading position as a landlord, not the strata corporation&rsquo;s money, and not
          something to leave open on a screen in front of the desk. Switch it on when you need it.
        </p>
      ) : (
        <>
          {invalidRange && <ErrorNote>The closing month must fall on or after the opening month.</ErrorNote>}

          <Field label="Period" htmlFor="sf-preset">
            <div className="flex flex-wrap gap-2" id="sf-preset">
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

          <Field label="How to read it" htmlFor="sf-view">
            <div className="flex flex-wrap gap-2" id="sf-view">
              <button
                type="button"
                onClick={() => setView('villa')}
                aria-pressed={view === 'villa'}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                  view === 'villa' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                }`}
              >
                By villa
              </button>
              <button
                type="button"
                onClick={() => setView('month')}
                aria-pressed={view === 'month'}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                  view === 'month' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                }`}
              >
                By month
              </button>
            </div>
          </Field>

          <p className="font-mono text-[10px] leading-relaxed text-slate-500">
            <strong>By villa</strong> answers whether a villa is worth letting. <strong>By month</strong> answers how much cash had to be
            found, and when. Both are the same figures folded two ways.
          </p>

          <p className="font-mono text-[11px] text-slate-600">
            Covering <strong>{period}</strong>
          </p>

          <InfoNote>
            <strong>Internal to VDS.</strong> This is not a strata document: the operating statement above is the corporation&rsquo;s income
            and expenditure, this is VDS&rsquo;s own position as a landlord and the two are different entities. Only villas ticked as{' '}
            <strong>let on the corporation&rsquo;s own account</strong> in the villa register appear here. Cash basis &mdash; earnings
            counted when they were received, the contribution when it was paid. <strong>Earned is rent plus short-stay receipts:</strong> a
            villa let on Airbnb pays towards its own contribution the same way a long-term let does, so both are subtracted from it and a
            villa only shows a shortfall where what it earned fell short. <strong>Each currency is a separate report</strong> and no figure
            combines them.
          </InfoNote>

          {noneFlagged ? (
            <EmptyState
              title="No villa is marked as let on the corporation's own account"
              hint="Open a villa in the Units Register, tick “Let on the corporation’s own account”, and it will appear here. Nothing else in the register can answer which villas are VDS’s own — an owner name is free text and matching on it breaks the day it is typed differently."
            />
          ) : reports.length === 0 ? (
            <EmptyState
              title="No rent received and no contribution paid in this period"
              hint="On the villas marked as let on the corporation's own account. Choose a different period above."
            />
          ) : (
            reports.map(r => <CurrencyBlock key={r.currency} report={r} view={view} />)
          )}

          {printing && (
            <ShortfallDocument reports={reports} period={period} generatedBy={session.name} onClose={() => setPrinting(false)} />
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The sentence the report exists to produce.
 *
 * Stated in words rather than left as a column total, because this is the line
 * that gets read out. The months are named underneath it: a total with no list
 * behind it is a figure nobody can check or act on.
 */
function headline(r: Report): string {
  if (r.fundedVillaMonths === 0) {
    return `Every villa let on the corporation's own account covered its own contribution ${
      r.months.length === 1 ? 'this month' : 'over the period'
    }.`;
  }
  const months = `${r.fundedVillaMonths} villa-month${r.fundedVillaMonths === 1 ? '' : 's'}`;
  /*
   * The empty months are called out inside the sentence rather than being the
   * whole of it. A villa let on Airbnb that did not earn its contribution cost
   * VDS money too — that is the case Ro raised, and a headline counting only
   * wholly-empty months would leave it out of the figure it belongs in.
   */
  const empty =
    r.vacantVillaMonths === 0
      ? ' None of them stood empty — the villas were let and did not earn their contribution.'
      : r.vacantVillaMonths === r.fundedVillaMonths
        ? ' Every one of them stood empty for the whole month.'
        : ` ${r.vacantVillaMonths} of them stood empty for the whole month, accounting for ${formatMoney(r.vacantShortfall, r.currency)}.`;
  return `VDS funded ${formatMoney(r.totalShortfall, r.currency)} from its own account across ${months}.${empty}`;
}

function CurrencyBlock({ report: r, view }: { report: Report; view: View }) {
  return (
    <div className="space-y-3 rounded-xl border border-slate-100 p-4">
      <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">{r.currency}</h3>

      <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">{headline(r)}</p>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Tile label="Rent received" value={formatMoney(r.totalRentReceived, r.currency)} tone="positive" />
        <Tile label="Short stay received" value={formatMoney(r.totalShortStayReceived, r.currency)} tone="positive" />
        <Tile label="Maintenance paid" value={formatMoney(r.totalMaintenancePaid, r.currency)} tone="negative" />
        <Tile label="Funded by VDS" value={formatMoney(r.totalShortfall, r.currency)} tone="negative" strong />
      </dl>

      {view === 'villa' ? (
        <TableScroller>
          <table className="w-full min-w-[900px] border-collapse text-left text-xs">
            <thead>
              <tr className={tableHeadRowClass}>
                <th scope="col" className="p-3">
                  Villa
                </th>
                <th scope="col" className="p-3">
                  Days let
                </th>
                <th scope="col" className="p-3">
                  Months empty
                </th>
                <th scope="col" className="p-3 text-right">
                  Rent
                </th>
                <th scope="col" className="p-3 text-right">
                  Short stay
                </th>
                <th scope="col" className="p-3 text-right">
                  Earned
                </th>
                <th scope="col" className="p-3 text-right">
                  Maintenance paid
                </th>
                <th scope="col" className="p-3 text-right">
                  Funded by VDS
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {r.byVilla.map(v => (
                <tr key={v.unitId}>
                  <td className="p-3 font-medium text-slate-800">{v.villa}</td>
                  <td className="p-3 font-mono text-slate-600">
                    {v.occupiedDays} of {v.daysCounted}
                  </td>
                  <td className="p-3 text-slate-600">
                    {v.vacantMonths.length === 0 ? '—' : v.vacantMonths.map(m => formatMonthLabel(m)).join(', ')}
                  </td>
                  <td className="p-3 text-right font-mono">{formatMoney(v.rentReceived, r.currency)}</td>
                  <td className="p-3 text-right font-mono">{formatMoney(v.shortStayReceived, r.currency)}</td>
                  <td className="p-3 text-right font-mono font-semibold">{formatMoney(v.earned, r.currency)}</td>
                  <td className="p-3 text-right font-mono">{formatMoney(v.maintenancePaid, r.currency)}</td>
                  <td className={`p-3 text-right font-mono ${v.shortfall > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>
                    {formatMoney(v.shortfall, r.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className="p-3" colSpan={3}>
                  Total
                </td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalRentReceived, r.currency)}</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalShortStayReceived, r.currency)}</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalEarned, r.currency)}</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalMaintenancePaid, r.currency)}</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalShortfall, r.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroller>
      ) : (
        <TableScroller>
          <table className="w-full min-w-[900px] border-collapse text-left text-xs">
            <thead>
              <tr className={tableHeadRowClass}>
                <th scope="col" className="p-3">
                  Month
                </th>
                <th scope="col" className="p-3">
                  Villas empty
                </th>
                <th scope="col" className="p-3 text-right">
                  Rent
                </th>
                <th scope="col" className="p-3 text-right">
                  Short stay
                </th>
                <th scope="col" className="p-3 text-right">
                  Earned
                </th>
                <th scope="col" className="p-3 text-right">
                  Maintenance paid
                </th>
                <th scope="col" className="p-3 text-right">
                  Funded by VDS
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {r.byMonth.map(m => (
                <tr key={m.month}>
                  <td className="p-3 font-medium text-slate-800">{formatMonthLabel(m.month)}</td>
                  <td className="p-3 text-slate-600">{m.vacantVillas.length === 0 ? '—' : m.vacantVillas.join(', ')}</td>
                  <td className="p-3 text-right font-mono">{formatMoney(m.rentReceived, r.currency)}</td>
                  <td className="p-3 text-right font-mono">{formatMoney(m.shortStayReceived, r.currency)}</td>
                  <td className="p-3 text-right font-mono font-semibold">{formatMoney(m.earned, r.currency)}</td>
                  <td className="p-3 text-right font-mono">{formatMoney(m.maintenancePaid, r.currency)}</td>
                  <td className={`p-3 text-right font-mono ${m.shortfall > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>
                    {formatMoney(m.shortfall, r.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className="p-3" colSpan={2}>
                  Total
                </td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalRentReceived, r.currency)}</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalShortStayReceived, r.currency)}</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalEarned, r.currency)}</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalMaintenancePaid, r.currency)}</td>
                <td className="p-3 text-right font-mono">{formatMoney(r.totalShortfall, r.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroller>
      )}

      <FundedList report={r} />
      <Caveats report={r} />
    </div>
  );
}

/**
 * The villa-months VDS funded, named, with what each one cost and why.
 *
 * "Empty all month" and "let, but earned less than the contribution" are both
 * on the list. Restricting it to empty months would hide the short-let month
 * that did not pay for itself — which is exactly the case that made short-stay
 * income count in the first place.
 */
function FundedList({ report: r }: { report: Report }) {
  if (r.fundedMonths.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h4 className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">Where it went</h4>
      <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-slate-700">
        {r.fundedMonths.map(v => (
          <li key={`${v.unitId}-${v.month}`}>
            {v.villa} · {formatMonthLabel(v.month)} — {formatMoney(v.shortfall, r.currency)}{' '}
            <span className="text-slate-400">({v.vacant ? 'empty all month' : 'let, earned less than the contribution'})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the report does not count, said on the page.
 *
 * A document that quietly leaves money out is indistinguishable from one that
 * lost it — the fault v1.10.3 was cut for. A villa whose rent and contribution
 * are in different currencies is deliberately given no figure, so it is named
 * here rather than silently dropped.
 */
function Caveats({ report: r }: { report: Report }) {
  const parts: string[] = [];
  for (const n of r.currencyNotes) {
    parts.push(
      `${n.villa} takes rent in ${n.rentCurrency} and is billed its contribution in ${n.maintCurrency}, so no shortfall is computed for it — subtracting one currency from the other would invent a figure.`
    );
  }
  if (parts.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2 font-mono text-[10px] leading-relaxed text-slate-500">
      {parts.map((text, i) => (
        <p key={i} className={i > 0 ? 'mt-1' : undefined}>
          {text}
        </p>
      ))}
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

/**
 * The printed report.
 *
 * Exported so it can be rendered and asserted by the test suite. Every printed
 * document in this application is now rendered by `react-dom/server` and asked
 * what it shows, because until 2026-09-02 not one of them was covered by
 * anything.
 */
export function ShortfallDocument({
  reports,
  period,
  generatedBy,
  onClose
}: {
  reports: Report[];
  period: string;
  generatedBy: string;
  onClose?: () => void;
}) {
  return (
    <PrintPortal title="Out-of-pocket shortfall" subtitle={period} onClose={onClose || (() => {})} maxWidthClass="max-w-4xl">
      <PrintLetterhead documentTitle="Out-of-pocket Shortfall" meta={`Internal · ${period}`} generatedBy={generatedBy} />

      {/*
        The banner names the managing entity plainly. `bodyCorporateName` is the
        strata corporation — the wrong party on this document, and reading
        "Internal to The Proprietors, Strata Plan No. 2324's managing entity"
        invites exactly the confusion the document exists to prevent.
      */}
      <p className="mb-4 rounded border-2 border-slate-900 p-2 text-[11px] font-bold uppercase tracking-wider">
        Internal to Villaggio Del Sol as landlord — not a strata document
      </p>

      <p className="mb-4 text-[11px] leading-relaxed">
        On the villas let on the corporation&rsquo;s own account the maintenance contribution is funded out of what that villa earns. This
        report states what was funded from VDS&rsquo;s own account where those earnings did not cover the contribution paid.{' '}
        <strong>Earnings are rent and short-stay receipts together</strong> — a villa let on short stay pays towards its own contribution
        the same way a long-term let does, and both are subtracted from it. It is <strong>not</strong> the corporation&rsquo;s income and
        expenditure — that is the operating statement, and the two are different entities. Prepared on a cash basis.{' '}
        <strong>Each currency is reported separately and no figure combines them.</strong>
      </p>

      {reports.map(r => (
        <section key={r.currency} className="mb-8 break-inside-avoid">
          <h3 className="mb-2 border-b-2 border-slate-900 pb-1 text-sm font-bold uppercase tracking-wider">
            {r.currency} — {r.currency === 'JMD' ? 'Jamaican dollars' : 'United States dollars'}
          </h3>

          <p className="mb-3 border border-slate-400 p-2 text-[11px] font-bold">{headline(r)}</p>

          <h4 className="mb-1 text-xs font-bold uppercase tracking-wider">By villa</h4>
          <table className="mb-4 w-full text-left text-[10px]">
            <thead>
              <tr className="border-b border-slate-400 font-mono text-[9px] uppercase text-slate-600">
                <th className="p-1.5">Villa</th>
                <th className="p-1.5">Days let</th>
                <th className="p-1.5">Months empty</th>
                <th className="p-1.5 text-right">Rent</th>
                <th className="p-1.5 text-right">Short stay</th>
                <th className="p-1.5 text-right">Earned</th>
                <th className="p-1.5 text-right">Maintenance paid</th>
                <th className="p-1.5 text-right">Funded by VDS</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {r.byVilla.map(v => (
                <tr key={v.unitId}>
                  <td className="p-1.5 font-sans">{v.villa}</td>
                  <td className="p-1.5">
                    {v.occupiedDays} of {v.daysCounted}
                  </td>
                  <td className="p-1.5 font-sans">
                    {v.vacantMonths.length === 0 ? '—' : v.vacantMonths.map(m => formatMonthLabel(m)).join(', ')}
                  </td>
                  <td className="p-1.5 text-right">{formatMoney(v.rentReceived, r.currency)}</td>
                  <td className="p-1.5 text-right">{formatMoney(v.shortStayReceived, r.currency)}</td>
                  <td className="p-1.5 text-right font-bold">{formatMoney(v.earned, r.currency)}</td>
                  <td className="p-1.5 text-right">{formatMoney(v.maintenancePaid, r.currency)}</td>
                  <td className="p-1.5 text-right">{formatMoney(v.shortfall, r.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-400 font-mono font-bold">
                <td className="p-1.5" colSpan={3}>
                  Total
                </td>
                <td className="p-1.5 text-right">{formatMoney(r.totalRentReceived, r.currency)}</td>
                <td className="p-1.5 text-right">{formatMoney(r.totalShortStayReceived, r.currency)}</td>
                <td className="p-1.5 text-right">{formatMoney(r.totalEarned, r.currency)}</td>
                <td className="p-1.5 text-right">{formatMoney(r.totalMaintenancePaid, r.currency)}</td>
                <td className="p-1.5 text-right">{formatMoney(r.totalShortfall, r.currency)}</td>
              </tr>
            </tfoot>
          </table>

          <h4 className="mb-1 text-xs font-bold uppercase tracking-wider">By month</h4>
          <table className="mb-4 w-full text-left text-[10px]">
            <thead>
              <tr className="border-b border-slate-400 font-mono text-[9px] uppercase text-slate-600">
                <th className="p-1.5">Month</th>
                <th className="p-1.5">Villas empty</th>
                <th className="p-1.5 text-right">Rent</th>
                <th className="p-1.5 text-right">Short stay</th>
                <th className="p-1.5 text-right">Earned</th>
                <th className="p-1.5 text-right">Maintenance paid</th>
                <th className="p-1.5 text-right">Funded by VDS</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {r.byMonth.map(m => (
                <tr key={m.month}>
                  <td className="p-1.5 font-sans">{formatMonthLabel(m.month)}</td>
                  <td className="p-1.5 font-sans">{m.vacantVillas.length === 0 ? '—' : m.vacantVillas.join(', ')}</td>
                  <td className="p-1.5 text-right">{formatMoney(m.rentReceived, r.currency)}</td>
                  <td className="p-1.5 text-right">{formatMoney(m.shortStayReceived, r.currency)}</td>
                  <td className="p-1.5 text-right font-bold">{formatMoney(m.earned, r.currency)}</td>
                  <td className="p-1.5 text-right">{formatMoney(m.maintenancePaid, r.currency)}</td>
                  <td className="p-1.5 text-right">{formatMoney(m.shortfall, r.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-400 font-mono font-bold">
                <td className="p-1.5" colSpan={2}>
                  Total
                </td>
                <td className="p-1.5 text-right">{formatMoney(r.totalRentReceived, r.currency)}</td>
                <td className="p-1.5 text-right">{formatMoney(r.totalShortStayReceived, r.currency)}</td>
                <td className="p-1.5 text-right">{formatMoney(r.totalEarned, r.currency)}</td>
                <td className="p-1.5 text-right">{formatMoney(r.totalMaintenancePaid, r.currency)}</td>
                <td className="p-1.5 text-right">{formatMoney(r.totalShortfall, r.currency)}</td>
              </tr>
            </tfoot>
          </table>

          {r.fundedMonths.length > 0 && (
            <>
              <h4 className="mb-1 text-xs font-bold uppercase tracking-wider">The months VDS funded</h4>
              <table className="mb-3 w-full text-left text-[10px]">
                <tbody className="font-mono">
                  {r.fundedMonths.map(v => (
                    <tr key={`${v.unitId}-${v.month}`}>
                      <td className="p-1.5 font-sans">{v.villa}</td>
                      <td className="p-1.5">{formatMonthLabel(v.month)}</td>
                      <td className="p-1.5 font-sans">{v.vacant ? 'empty all month' : 'let, earned less than the contribution'}</td>
                      <td className="p-1.5 text-right">{formatMoney(v.shortfall, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {r.currencyNotes.length > 0 && (
            <div className="mt-2 rounded border border-slate-300 p-2 text-[9px] leading-relaxed">
              {r.currencyNotes.map(n => (
                <p key={n.unitId} className="mt-1">
                  <strong>No shortfall computed for {n.villa}:</strong> rent is taken in {n.rentCurrency} and the contribution is billed in{' '}
                  {n.maintCurrency}. Subtracting one from the other would invent a figure.
                </p>
              ))}
            </div>
          )}
        </section>
      ))}

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        Internal management information, prepared on a cash basis from the property&rsquo;s records for the period stated. Not a strata
        document, not the corporation&rsquo;s income and expenditure, and not a tax document. &ldquo;Earned&rdquo; is rent plus short-stay
        receipts; both fund the contribution and both are subtracted from it. Days let are counted from tenancies and bookings rather than
        the villa&rsquo;s current status. USD and JMD are reported separately and no figure here has been converted.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Reviewed by" />
    </PrintPortal>
  );
}
