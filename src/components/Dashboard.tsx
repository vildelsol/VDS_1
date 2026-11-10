/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { useRemembered } from '../lib/screenState';
import {
  AppSettings,
  Booking,
  Charge,
  Currency,
  Expense,
  Payment,
  SessionUser,
  Unit,
  getUnitDisplayName,
  Tenancy
} from '../types';
import {
  AccountBalance,
  collectedInPeriod,
  chargedInPeriod,
  consolidateEverything,
  collectionRate,
  delinquentAccounts,
  expensesInPeriod,
  residentialOccupancy,
  shortLetOccupancy,
  ownerBilledUnitIds,
  leasesNeedingAttention,
  unbilledAccounts,
  unbilledOccupancy,
  operationalHealth,
  OperationalHealth
} from '../lib/finance';
import { formatMoney, formatMoneyLong, round2, sumMoney } from '../lib/money';
import { arrivalsWithin, departuresWithin } from '../lib/stays';
import ReceivePaymentModal from './ReceivePaymentModal';
import { addDays, addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  SecondaryButton,
  SuccessNote,
  TableScroller,
  monoInputClass
} from './ui';
import { AlertTriangle, ArrowUpRight, CalendarDays, Key, LogIn, LogOut } from 'lucide-react';
import type { TabKey } from '../App';

interface DashboardProps {
  units: Unit[];
  bookings: Booking[];
  tenancies: Tenancy[];
  charges: Charge[];
  payments: Payment[];
  expenses: Expense[];
  settings: AppSettings;
  session: SessionUser;
  onRecordPayment: (payload: Record<string, unknown>) => Promise<Payment>;
  onNavigateToTab: (tab: TabKey) => void;
}

const ARRIVAL_WINDOW_DAYS = 14;

export default function Dashboard({
  units,
  bookings,
  tenancies,
  charges,
  payments,
  expenses,
  settings,
  session,
  onRecordPayment,
  onNavigateToTab
}: DashboardProps) {
  const [month, setMonth] = useRemembered('dashboard.month', currentMonth);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [payTarget, setPayTarget] = useState<AccountBalance | 'blank' | null>(null);

  const periodStart = monthStart(month);
  const periodEnd = monthEnd(month);
  const ownerBilled = useMemo(() => ownerBilledUnitIds(units), [units]);

  /**
   * The health grade, for the month on screen.
   *
   * Graded per currency like everything else. JMD leads because the corporation's
   * own operating costs are in JMD; a USD grade is shown beside it only when
   * there is USD activity to grade, rather than an empty card asserting nothing.
   */
  const healthByCurrency = useMemo(
    () =>
      (['JMD', 'USD'] as Currency[])
        .map(c => operationalHealth(units, charges, payments, expenses, c, periodStart, periodEnd))
        .filter((h): h is OperationalHealth => h !== null),
    [units, charges, payments, expenses, periodStart, periodEnd]
  );

  // Absent means shown — see `hidePropertyHealth` on AppSettings for why it is
  // stored the negative way round.
  const showHealth = settings.hidePropertyHealth !== true;

  /* ---------------- occupancy ---------------- */

  /*
   * Who is actually in a villa today, not how the villas are set up to be let.
   *
   * This card used to count `unit.status`, so every villa offered on Airbnb was
   * counted as occupied whether or not a guest was in it, and "Vacant villas"
   * counted only the ones explicitly marked vacant. On a property whose short-let
   * villas were all empty and available it read **Occupancy 100%, Vacant villas
   * 0** — Ro, 2026-09-02. Worse, the charts and the board pack already used the
   * dated records, so the application disagreed with itself on the same screenful.
   */
  const totalUnits = units.length;

  /*
   * Two businesses, counted apart. Ro, 2026-09-02: *"the dashboard occupancy
   * chart will now only use long term lease, vacancy and unavailable status.
   * Short term rental should have its own chart."* A long-term lease is a state
   * that holds for months; a short let is a villa that is either taken tonight
   * or on sale. One percentage over both blends a state with a rate.
   */
  const residential = useMemo(() => residentialOccupancy(units, tenancies, today()), [units, tenancies]);
  const shortLet = useMemo(() => shortLetOccupancy(units, bookings, today(), month), [units, bookings, month]);

  /* ---------------- arrears ---------------- */

  // As of today: a charge whose due date has not arrived is not arrears, however
  // long ago the month was posted. See scheduledCharges() in lib/finance.
  const arrears = useMemo(() => delinquentAccounts(units, charges, payments, today()), [units, charges, payments]);
  /**
   * Accounts set up to be billed that have never had a charge raised. They owe
   * nothing, so they never appear in arrears — which is exactly why an unbilled
   * villa could sit here looking fine while its rent was never collected.
   */
  const unbilled = useMemo(() => unbilledAccounts(units, charges, payments), [units, charges, payments]);

  /**
   * Occupied months that were never billed — the same list the notifications hub
   * shows, from the same function, so the two screens cannot disagree about it.
   */
  const unbilledMonths = useMemo(
    () => unbilledOccupancy(units, tenancies, charges, today(), settings.booksBeginOn),
    [units, tenancies, charges, settings.booksBeginOn]
  );

  /** Leases ending or already lapsed — same function the hub uses. */
  const leases = useMemo(() => leasesNeedingAttention(units, tenancies), [units, tenancies]);
  const arrearsByCurrency = useMemo(() => {
    const out: Record<Currency, number> = { USD: 0, JMD: 0 };
    for (const account of arrears) {
      out[account.currency] = sumMoney([out[account.currency], account.balance]);
    }
    return out;
  }, [arrears]);

  const chargesPostedForMonth = charges.some(c => c.periodMonth === month && c.status === 'open');

  /* ---------------- the month before, for comparison ---------------- */

  /**
   * A single figure says nothing about direction: 88% collected is good news or
   * bad depending entirely on what it was last month. Every comparison here is
   * the same measure over the preceding month, computed by the same functions —
   * never a different measure dressed up as a trend.
   */
  const previousMonth = addMonths(month, -1);
  const previousStart = monthStart(previousMonth);
  const previousEnd = monthEnd(previousMonth);

  /**
   * Whether there is anything to compare against.
   *
   * A month that falls entirely before the books began is not a quiet month, it
   * is a month this system has no standing to describe. Comparing to it reads
   * every opening balance as growth: on a database whose books begin on 1
   * September, eleven accounts in arrears on the 2nd showed as **"+11 vs August
   * 2026"** — a trend invented out of a month that never existed here (Ro,
   * 2026-09-02). The same class of fault as calling rent arrears before its due
   * date: a figure stated about a period the records do not cover.
   *
   * When there is nothing to compare against the cards say so instead, naming
   * the date the books begin, so the absence is explained rather than hidden.
   */
  const booksBeginOn = settings.booksBeginOn || '';
  const hasComparison = !booksBeginOn || previousEnd >= booksBeginOn;
  const noComparisonLabel = `no comparison, the books begin ${formatDayLabel(booksBeginOn)}`;

  /** Arrears as they stood at the end of the previous month. */
  const previousArrears = useMemo(
    () => delinquentAccounts(units, charges, payments, previousEnd),
    [units, charges, payments, previousEnd]
  );
  const arrearsDelta = arrears.length - previousArrears.length;

  /* ---------------- money for the selected period ---------------- */

  const ledger = useMemo(() => {
    // Money on both books counted once: see consolidateEverything.
    const combined = consolidateEverything(charges, payments);
    return (['JMD', 'USD'] as Currency[]).map(currency => {
      const collected = collectedInPeriod(combined.payments, currency, periodStart, periodEnd, ownerBilled);
      const billed = chargedInPeriod(combined.charges, currency, periodStart, periodEnd);
      const spent = expensesInPeriod(expenses, currency, periodStart, periodEnd);

      // The same three figures for the preceding month, so the screen can say
      // which way each one moved rather than only where it stands.
      const priorCollected = collectedInPeriod(combined.payments, currency, previousStart, previousEnd, ownerBilled);
      const priorBilled = chargedInPeriod(combined.charges, currency, previousStart, previousEnd);
      const priorSpent = expensesInPeriod(expenses, currency, previousStart, previousEnd);

      const rate = collectionRate(billed.total, sumMoney([collected.rent, collected.maintenance]));
      const priorRate = collectionRate(priorBilled.total, sumMoney([priorCollected.rent, priorCollected.maintenance]));

      return {
        currency,
        collected,
        billed,
        spent,
        net: sumMoney([collected.total, -spent]),
        rate,
        priorRate,
        priorNet: sumMoney([priorCollected.total, -priorSpent]),
        priorReceived: priorCollected.total
      };
    });
  }, [payments, charges, expenses, periodStart, periodEnd, previousStart, previousEnd, ownerBilled]);

  /* ---------------- short-term ---------------- */

  const activeBookings = bookings.filter(b => b.status !== 'cancelled');
  const todayStr = today();
  const horizon = addDays(todayStr, ARRIVAL_WINDOW_DAYS);

  /*
   * Who is actually arriving and leaving, from the dates.
   *
   * Both lists were filtered on the recorded `status` — `confirmed` for arrivals
   * and `checked-in` for departures — and nobody checks a guest in or out of an
   * imported stay in this program. The departures panel was therefore empty
   * whatever was in the calendar (Ro, 2026-09-28). The rules now live in
   * `src/lib/stays.ts` where a test can reach them.
   */
  const upcomingArrivals = arrivalsWithin(activeBookings, todayStr, horizon);
  const upcomingDepartures = departuresWithin(activeBookings, todayStr, horizon);

  const stayBalances = useMemo(() => {
    const out: Record<Currency, { collected: number; outstanding: number }> = {
      USD: { collected: 0, outstanding: 0 },
      JMD: { collected: 0, outstanding: 0 }
    };
    for (const b of activeBookings) {
      out[b.currency].collected = sumMoney([out[b.currency].collected, b.depositPaid]);
      out[b.currency].outstanding = sumMoney([out[b.currency].outstanding, b.balanceDue]);
    }
    return out;
  }, [activeBookings]);

  const importedWithoutValue = activeBookings.filter(b => b.externalUid && b.amount === 0 && b.source !== 'Blocked');

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}

      {/*
        The full-width banner that used to sit here held a single button, which
        spent the most valuable space on the screen on an action while the
        problems — arrears, unbilled accounts, lapsing leases — began below the
        fold. The action is still one click away, in the row of figures it
        belongs beside.
      */}
      {session.permissions.recordPayments && (
        <div className="flex justify-end print:hidden">
          <button
            onClick={() => setPayTarget('blank')}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-teal-700 px-4 py-2.5 text-xs font-semibold text-white shadow-xs transition-all hover:bg-teal-800"
          >
            <ArrowUpRight className="h-4 w-4" />
            Receive payment
          </button>
        </div>
      )}

      {/* Overview */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard
          label="Long-term occupancy"
          value={residential.rate === null ? 'n/a' : `${residential.rate}%`}
          hint={
            residential.pool > 0
              ? `${residential.leased} of ${residential.pool} villas leased · ${residential.vacant} to let` +
                [
                  residential.ownerOccupied > 0 ? `${residential.ownerOccupied} owner-occupied` : null,
                  residential.shortLet > 0 ? `${residential.shortLet} on short-let` : null,
                  residential.unavailable > 0 ? `${residential.unavailable} off the market` : null,
                  // The register and the dated records disagreeing is a fact
                  // worth seeing: it is how a villa gets occupied for a month
                  // that nobody ever bills.
                  residential.markedLeasedWithoutTenancy.length > 0
                    ? `${residential.markedLeasedWithoutTenancy.length} marked long-term with no tenancy on file`
                    : null
                ]
                  .filter(Boolean)
                  .reduce((line, part) => `${line} · ${part}`, '')
              : totalUnits > 0
                ? 'No villa is in the long-term pool'
                : 'No villas in the register'
          }
          icon={<Key className="h-6 w-6" />}
          tone="emerald"
        />
        <StatCard
          label="Short-let occupancy"
          value={shortLet.rate === null ? 'n/a' : `${shortLet.rate}%`}
          hint={
            shortLet.villas > 0
              ? `${shortLet.occupied} of ${shortLet.villas} short-let villas taken tonight · ${shortLet.available} to sell` +
                (shortLet.nightsRate !== null
                  ? ` · ${shortLet.nightsSold} of ${shortLet.nightsAvailable} nights sold in ${formatMonthLabel(shortLet.month)} (${shortLet.nightsRate}%)`
                  : '')
              : 'No villa is listed for short stays'
          }
          icon={<CalendarDays className="h-6 w-6" />}
          tone="teal"
        />
        <StatCard
          label={`Arrivals (${ARRIVAL_WINDOW_DAYS} days)`}
          value={String(upcomingArrivals.length)}
          hint={`Confirmed check-ins to ${formatDayLabel(horizon)}`}
          icon={<CalendarDays className="h-6 w-6" />}
          tone="indigo"
        />
        <StatCard
          label="Accounts in arrears"
          value={String(arrears.length)}
          hint={
            arrears.length > 0
              ? [
                  arrearsByCurrency.JMD > 0 ? formatMoney(arrearsByCurrency.JMD, 'JMD') : null,
                  arrearsByCurrency.USD > 0 ? formatMoney(arrearsByCurrency.USD, 'USD') : null
                ]
                  .filter(Boolean)
                  .join(' + ') + ' outstanding'
              : 'All billed accounts settled'
          }
          // Unbilled accounts used to share this line, which meant they vanished
          // the moment anything was in arrears — exactly when nobody would notice
          // they had gone. They carry their own warning below now.
          delta={
            !hasComparison
              ? { direction: 'flat', label: noComparisonLabel }
              : arrearsDelta === 0
                ? { direction: 'flat', label: `unchanged from ${formatMonthLabel(previousMonth)}` }
                : {
                    direction: arrearsDelta > 0 ? 'worse' : 'better',
                    label: `${arrearsDelta > 0 ? '+' : ''}${arrearsDelta} vs ${formatMonthLabel(previousMonth)}`
                  }
          }
          icon={<AlertTriangle className="h-6 w-6" />}
          tone={arrears.length > 0 ? 'red' : 'slate'}
        />
      </div>

      {/* How the property is running, in one letter that shows its working.
          Switched off entirely in System Settings → General for anyone who does
          not want a graded summary on the front page. */}
      {!showHealth ? null : healthByCurrency.length === 0 ? (
        <HealthCard health={null} currency="JMD" />
      ) : (
        <div className={`grid grid-cols-1 gap-4 ${healthByCurrency.length > 1 ? 'xl:grid-cols-2' : ''}`}>
          {healthByCurrency.map(h => (
            <HealthCard key={h.currency} health={h} currency={h.currency} />
          ))}
        </div>
      )}

      {/* Arrears */}
      {arrears.length > 0 ? (
        <section className="space-y-4 rounded-2xl border border-red-100 bg-red-50/40 p-6 shadow-xs">
          <div className="flex items-center gap-2 text-red-800">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <h3 className="font-display text-sm font-semibold">Accounts in arrears</h3>
          </div>
          <p className="text-xs leading-relaxed text-slate-600">
            Total billed minus total received, across every month posted. Oldest debt first.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {arrears.slice(0, 9).map(account => (
              <div key={`${account.unit.id}-${account.category}`} className="flex flex-col justify-between gap-3 rounded-xl border border-red-100 bg-white p-4 text-xs shadow-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {/*
                      The balance beside this column is `shrink-0`, so a long
                      figure squeezes the name into whatever is left — measured
                      at 80px against 84px of content, which clipped the end of
                      the villa name with no way to read it. The name is allowed
                      to shrink and ellipsise, and carries its full text as a
                      title so nothing is actually lost.
                    */}
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <p className="min-w-0 truncate font-semibold text-slate-800" title={getUnitDisplayName(account.unit.number)}>
                        {getUnitDisplayName(account.unit.number)}
                      </p>
                      <Badge tone={account.category === 'Maintenance' ? 'purple' : 'green'}>{account.category}</Badge>
                    </div>
                    <p className="mt-1.5 truncate text-[10px] text-slate-500">
                      Payer: <span className="font-medium text-slate-700">{account.unpaidCharges[0]?.payerName || '-'}</span>
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-500">
                      {account.unpaidCharges.length} unpaid month{account.unpaidCharges.length === 1 ? '' : 's'} from{' '}
                      {formatMonthLabel(account.unpaidCharges[0]?.periodMonth || '')}
                    </p>
                    {account.oldestUnpaidDays > 0 && (
                      <p className="mt-1 font-mono text-[10px] text-red-600">{account.oldestUnpaidDays} days overdue</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="block font-mono text-[9px] uppercase text-slate-400">Balance</span>
                    <span className="font-mono text-sm font-bold text-red-600">{formatMoney(account.balance, account.currency)}</span>
                    <span className="block font-mono text-[9px] text-slate-400">{account.currency}</span>
                  </div>
                </div>
                {session.permissions.recordPayments && (
                  <button
                    onClick={() => setPayTarget(account)}
                    className="flex w-full items-center justify-center gap-1 rounded-lg border border-red-200 bg-red-50 py-1.5 text-[10px] font-semibold text-red-700 transition-all hover:bg-red-100"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                    Receive payment
                  </button>
                )}
              </div>
            ))}
          </div>
          {arrears.length > 9 && (
            <button onClick={() => onNavigateToTab('notifications')} className="text-xs font-medium text-red-700 underline">
              View all {arrears.length} accounts in the Notifications Hub
            </button>
          )}
        </section>
      ) : (
        charges.length === 0 && (
          <InfoNote tone="amber">
            No charges have been posted yet, so no arrears can be calculated. Open the{' '}
            <button onClick={() => onNavigateToTab('finance')} className="font-semibold underline">
              HOA &amp; Tenants Ledger
            </button>{' '}
            and use <strong>Post month</strong> to raise rent and maintenance charges for a billing month.
          </InfoNote>
        )
      )}

      {/*
        Accounts configured to be billed that have never had a charge raised.
        They owe nothing, so they can never appear in arrears — which is exactly
        why this needs saying out loud rather than sharing a line with the
        arrears figure, where any arrears at all would hide it.
      */}
      {unbilled.length > 0 && (
        <InfoNote tone="amber">
          <strong>
            {unbilled.length} account{unbilled.length === 1 ? ' is' : 's are'} set up to be billed but{' '}
            {unbilled.length === 1 ? 'has' : 'have'} never been charged.
          </strong>{' '}
          {unbilled
            .slice(0, 3)
            .map(account => `${getUnitDisplayName(account.unit.number)} (${account.category})`)
            .join(', ')}
          {unbilled.length > 3 ? ` and ${unbilled.length - 3} more` : ''}. Nothing is owed because nothing was billed, so
          these never reach the arrears above. Open the{' '}
          <button onClick={() => onNavigateToTab('finance')} className="font-semibold underline">
            HOA &amp; Tenants Ledger
          </button>{' '}
          and use <strong>Post month</strong> to raise the charges.
        </InfoNote>
      )}

      {leases.length > 0 && (
        <InfoNote tone="amber">
          <strong>
            {leases.filter(l => l.expired).length > 0
              ? `${leases.filter(l => l.expired).length} lease${leases.filter(l => l.expired).length === 1 ? ' has' : 's have'} already expired`
              : `${leases.length} lease${leases.length === 1 ? '' : 's'} ending soon`}
            .
          </strong>{' '}
          {leases
            .slice(0, 3)
            .map(l =>
              `${getUnitDisplayName(l.unit.number)}, ${l.tenancy.tenantName} (${l.expired ? `expired ${Math.abs(l.daysRemaining)}d ago` : `${l.daysRemaining}d left`})`
            )
            .join('; ')}
          {leases.length > 3 ? ` and ${leases.length - 3} more` : ''}. An expired term does not end the tenancy, it
          continues month to month at the old rent until it is renewed or notice is served. See the{' '}
          <button onClick={() => onNavigateToTab('notifications')} className="font-semibold underline">
            Notifications Hub
          </button>
          .
        </InfoNote>
      )}

      {unbilledMonths.length > 0 && (
        <InfoNote tone="amber">
          <strong>
            {unbilledMonths.length} tenanc{unbilledMonths.length === 1 ? 'y has' : 'ies have'} occupied months that were
            never billed.
          </strong>{' '}
          {unbilledMonths
            .slice(0, 3)
            .map(row => `${getUnitDisplayName(row.unit.number)} (${row.months.length})`)
            .join(', ')}
          {unbilledMonths.length > 3 ? ` and ${unbilledMonths.length - 3} more` : ''}. Rent is owed for those months but
          nothing has been charged, so they are invisible in the arrears above. Open the{' '}
          <button onClick={() => onNavigateToTab('finance')} className="font-semibold underline">
            HOA &amp; Tenants Ledger
          </button>{' '}
          and use <strong>Post month</strong> for each, or the{' '}
          <button onClick={() => onNavigateToTab('notifications')} className="font-semibold underline">
            Notifications Hub
          </button>{' '}
          to see the detail.
        </InfoNote>
      )}

      {/* Period ledger */}
      <section className="space-y-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <h2 className="font-display text-lg font-medium text-slate-900">Operational ledger</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Cash received and paid out during {formatMonthLabel(month)} only. Currencies are reported separately and
              never combined.
            </p>
          </div>
          <Field label="Billing month" htmlFor="dash-month">
            <input id="dash-month" type="month" value={month} max={currentMonth()} onChange={e => setMonth(e.target.value || currentMonth())} className={monoInputClass} />
          </Field>
        </div>

        {!chargesPostedForMonth && (
          <InfoNote tone="amber">
            No charges are posted for {formatMonthLabel(month)}, so the collection rate cannot be calculated for this
            month.
          </InfoNote>
        )}

        <div className="grid grid-cols-1 gap-8 border-t border-slate-100 pt-6 xl:grid-cols-2">
          {ledger.map(entry => (
            <div key={entry.currency} className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-slate-800">
                  {entry.currency === 'USD' ? 'United States Dollar' : 'Jamaican Dollar'} ledger
                </h3>
                <Badge tone="teal">{entry.currency}</Badge>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <h4 className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Received</h4>
                  <dl className="space-y-2 rounded-xl bg-emerald-50/50 p-4">
                    {[
                      ['Rent', entry.collected.rent],
                      ['Maintenance', entry.collected.maintenance],
                      ['Bookings', entry.collected.booking],
                      ['Utilities', entry.collected.utility],
                      ['Other', entry.collected.other]
                    ].map(([label, value]) => (
                      <div key={String(label)} className="flex justify-between gap-2 text-[11px] text-slate-600">
                        <dt>{label}</dt>
                        <dd className="font-mono font-medium">{formatMoney(Number(value), entry.currency)}</dd>
                      </div>
                    ))}
                    <div className="flex justify-between gap-2 border-t border-emerald-100 pt-2 text-xs font-semibold text-emerald-800">
                      <dt>Total received</dt>
                      <dd className="font-mono">{formatMoney(entry.collected.total, entry.currency)}</dd>
                    </div>
                  </dl>
                </div>

                <div className="space-y-2">
                  <h4 className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Billed this month</h4>
                  <dl className="space-y-2 rounded-xl bg-amber-50/50 p-4">
                    <div className="flex justify-between gap-2 text-[11px] text-slate-600">
                      <dt>Rent charged</dt>
                      <dd className="font-mono font-medium">{formatMoney(entry.billed.rent, entry.currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-2 text-[11px] text-slate-600">
                      <dt>Maintenance charged</dt>
                      <dd className="font-mono font-medium">{formatMoney(entry.billed.maintenance, entry.currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-2 border-t border-amber-100 pt-2 text-xs font-semibold text-amber-800">
                      <dt>Total billed</dt>
                      <dd className="font-mono">{formatMoney(entry.billed.total, entry.currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-2 text-[11px] text-slate-500">
                      <dt>Collection rate</dt>
                      <dd className="font-mono font-medium">{entry.rate === null ? 'n/a' : `${entry.rate}%`}</dd>
                    </div>
                    {entry.rate !== null && entry.priorRate !== null && hasComparison && (
                      <div className="flex justify-between gap-2 text-[10px] text-slate-400">
                        <dt>vs {formatMonthLabel(previousMonth)}</dt>
                        <dd
                          className={`font-mono ${
                            entry.rate > entry.priorRate
                              ? 'text-emerald-600'
                              : entry.rate < entry.priorRate
                                ? 'text-red-600'
                                : ''
                          }`}
                        >
                          {entry.rate === entry.priorRate
                            ? 'unchanged'
                            : `${entry.rate > entry.priorRate ? '+' : ''}${round2(entry.rate - entry.priorRate)} pts`}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>

                <div className="space-y-2">
                  <h4 className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Paid out</h4>
                  <dl className="space-y-2 rounded-xl bg-slate-50 p-4">
                    <div className="flex justify-between gap-2 text-[11px] text-slate-600">
                      <dt>Expenses paid</dt>
                      <dd className="font-mono font-medium">{formatMoney(entry.spent, entry.currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-2 border-t border-slate-200 pt-2 text-xs font-semibold text-slate-800">
                      <dt>Net cash movement</dt>
                      <dd className={`font-mono ${entry.net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                        {formatMoney(entry.net, entry.currency)}
                      </dd>
                    </div>
                    {hasComparison ? (
                      <div className="flex justify-between gap-2 text-[10px] text-slate-400">
                        <dt>vs {formatMonthLabel(previousMonth)}</dt>
                        <dd className="font-mono">{formatMoney(entry.priorNet, entry.currency)}</dd>
                      </div>
                    ) : (
                      <p className="font-mono text-[10px] text-slate-400">{noComparisonLabel}</p>
                    )}
                  </dl>
                </div>
              </div>
            </div>
          ))}
        </div>

        <p className="border-t border-slate-100 pt-3 font-mono text-[10px] leading-relaxed text-slate-400">
          Utility recoveries from owner-occupied and short-let villas are billed directly to the owner and are excluded
          from the figures above. Indicative rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD (display only, no
          stored amount is converted).
        </p>
      </section>

      {/* Short-term */}
      <section className="space-y-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
        <div className="flex flex-col items-start justify-between gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-display text-lg font-medium text-slate-900">Short-term guest reservations</h2>
            <p className="mt-0.5 text-xs text-slate-500">Deposits held and balances still due across active stays.</p>
          </div>
          <SecondaryButton onClick={() => onNavigateToTab('bookings')}>Open bookings</SecondaryButton>
        </div>

        {importedWithoutValue.length > 0 && (
          <InfoNote tone="amber">
            {importedWithoutValue.length} imported reservation{importedWithoutValue.length === 1 ? '' : 's'} carry no
            stay value. Platform calendar feeds publish dates only, never pricing, open each reservation and enter the
            amount so it appears in revenue.
          </InfoNote>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-4">
            <span className="block font-mono text-[10px] uppercase text-slate-500">Active reservations</span>
            <span className="font-display text-2xl font-bold text-slate-800">{activeBookings.length}</span>
            <span className="mt-1 block text-xs text-slate-500">Confirmed, checked-in or checked-out</span>
          </div>
          <div className="rounded-xl bg-emerald-50/50 p-4">
            <span className="block font-mono text-[10px] uppercase text-emerald-700">Deposits held</span>
            <div className="mt-1 space-y-0.5">
              <p className="font-mono text-sm font-bold text-emerald-800">{formatMoney(stayBalances.USD.collected, 'USD')} USD</p>
              <p className="font-mono text-sm font-bold text-emerald-800">{formatMoney(stayBalances.JMD.collected, 'JMD')} JMD</p>
            </div>
          </div>
          <div className="rounded-xl bg-amber-50/50 p-4">
            <span className="block font-mono text-[10px] uppercase text-amber-700">Balances due on arrival</span>
            <div className="mt-1 space-y-0.5">
              <p className="font-mono text-sm font-bold text-amber-800">{formatMoney(stayBalances.USD.outstanding, 'USD')} USD</p>
              <p className="font-mono text-sm font-bold text-amber-800">{formatMoney(stayBalances.JMD.outstanding, 'JMD')} JMD</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <TransitionList
            title={`Arrivals in the next ${ARRIVAL_WINDOW_DAYS} days`}
            icon={<LogIn className="h-3.5 w-3.5" />}
            tone="emerald"
            bookings={upcomingArrivals}
            dateOf={b => b.checkIn}
            emptyText="No guests are due to arrive in this window."
          />
          <TransitionList
            title={`Departures in the next ${ARRIVAL_WINDOW_DAYS} days`}
            icon={<LogOut className="h-3.5 w-3.5" />}
            tone="amber"
            bookings={upcomingDepartures}
            dateOf={b => b.checkOut}
            emptyText="No guests are due to depart in this window."
          />
        </div>
      </section>

      {payTarget && (
        <ReceivePaymentModal
          units={units}
          charges={charges}
          payments={payments}
          account={payTarget === 'blank' ? null : payTarget}
          onClose={() => setPayTarget(null)}
          onSubmit={async payload => {
            // A failure is deliberately not caught here. Re-wrapping it as a plain
            // Error threw away the typed ApiError, and with it the code the form
            // needs to tell "the server is unhappy" from "this money has already
            // been banked by someone else" — which is the difference between a
            // message to read and a decision to make. The form does the reporting.
            const payment = await onRecordPayment(payload);
            setSuccess(`Receipt ${payment.receiptNo} issued for ${formatMoneyLong(payment.amount, payment.currency)}.`);
            setError('');
            setPayTarget(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** How a figure moved against the same figure a month earlier. */
interface StatDelta {
  /** Whether the movement is good news, bad news, or no movement at all. */
  direction: 'better' | 'worse' | 'flat';
  label: string;
}

function StatCard({
  label,
  value,
  hint,
  delta,
  icon,
  tone
}: {
  label: string;
  value: string;
  hint: string;
  delta?: StatDelta;
  icon: React.ReactNode;
  tone: 'emerald' | 'teal' | 'indigo' | 'red' | 'slate';
}) {
  const tones: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-600',
    teal: 'bg-teal-50 text-teal-600',
    indigo: 'bg-indigo-50 text-indigo-600',
    red: 'bg-red-50 text-red-600',
    slate: 'bg-slate-50 text-slate-600'
  };
  const deltaTone =
    delta?.direction === 'better' ? 'text-emerald-600' : delta?.direction === 'worse' ? 'text-red-600' : 'text-slate-400';
  return (
    <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
      <div className="min-w-0">
        <p className="font-mono text-xs uppercase text-slate-500">{label}</p>
        <h3 className="mt-1 font-display text-2xl font-semibold">{value}</h3>
        <p className="mt-1 truncate text-xs text-slate-400" title={hint}>
          {hint}
        </p>
        {delta && (
          <p className={`mt-0.5 truncate font-mono text-[10px] ${deltaTone}`} title={delta.label}>
            {delta.label}
          </p>
        )}
      </div>
      <div className={`ml-3 shrink-0 rounded-xl p-3 ${tones[tone]}`}>{icon}</div>
    </div>
  );
}

function TransitionList({
  title,
  icon,
  tone,
  bookings,
  dateOf,
  emptyText
}: {
  title: string;
  icon: React.ReactNode;
  tone: 'emerald' | 'amber';
  bookings: Booking[];
  dateOf: (b: Booking) => string;
  emptyText: string;
}) {
  const styles =
    tone === 'emerald' ? 'border-emerald-100 bg-emerald-50/30 text-emerald-700' : 'border-amber-100 bg-amber-50/30 text-amber-700';
  return (
    <div className="space-y-3">
      <span className={`flex items-center gap-1.5 font-mono text-xs font-medium uppercase ${tone === 'emerald' ? 'text-emerald-600' : 'text-amber-600'}`}>
        {icon}
        {title} ({bookings.length})
      </span>
      {bookings.length === 0 ? (
        <EmptyState title={emptyText} />
      ) : (
        <ul className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
          {bookings.map(b => (
            <li key={b.id} className={`flex items-center justify-between gap-2 rounded-xl border p-3 text-xs ${styles}`}>
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">
                  {b.guestName}, {getUnitDisplayName(b.unitNumber)}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-slate-500">{formatDayLabel(dateOf(b))}</p>
              </div>
              <Badge tone={tone === 'emerald' ? 'green' : 'amber'}>{b.source}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The health grade.
 *
 * One letter for "is the property being run well", from four things the ledger
 * already knows. Asked for as a quick read so nobody has to open four screens
 * and hold the figures in their head.
 *
 * **It shows its working, and that is not decoration.** A single letter is the
 * most dangerous figure on the screen — it is the one nobody checks, because
 * checking it means reconstructing it. So every component is listed with its
 * own score, its weight, and the figures behind it, and the grade is exactly
 * their weighted mean. The bar is a second reading of the same numbers, never
 * the only one: the values live in the table, not in a tooltip, for the same
 * reason every other chart here carries a data table.
 *
 * A component that cannot be measured is absent from the list rather than
 * scored zero, and when nothing can be measured there is no grade at all.
 */
export function HealthCard({ health, currency }: { health: OperationalHealth | null; currency: Currency }) {
  if (!health) {
    return (
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
        <h3 className="font-display text-sm font-semibold text-slate-900">Property health</h3>
        <p className="mt-2 text-xs text-slate-500">
          Nothing has been billed or spent in {currency} this period, so there is nothing to grade yet. A grade appears
          once the month has been posted and costs are recorded.
        </p>
      </section>
    );
  }

  const tone =
    health.grade === 'A' || health.grade === 'B'
      ? { text: 'text-emerald-700', ring: 'border-emerald-200 bg-emerald-50/50', bar: 'bg-emerald-500' }
      : health.grade === 'C'
        ? { text: 'text-amber-700', ring: 'border-amber-200 bg-amber-50/50', bar: 'bg-amber-500' }
        : { text: 'text-rose-700', ring: 'border-rose-200 bg-rose-50/50', bar: 'bg-rose-500' };

  const meaning: Record<string, string> = {
    A: 'Running well, collecting, covering its costs, and not carrying old debt.',
    B: 'Sound, with something worth watching below.',
    C: 'Under strain. One or more of the figures below needs attention.',
    D: 'Struggling, the property is not being funded as it is being run.',
    E: 'Serious. Collection or cost coverage has broken down.'
  };

  return (
    <section className={`space-y-4 rounded-2xl border p-6 shadow-xs ${tone.ring}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-sm font-semibold text-slate-900">Property health</h3>
          <p className="mt-1 text-xs text-slate-600">{meaning[health.grade]}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`font-display text-4xl font-bold leading-none ${tone.text}`}>{health.grade}</div>
          <div className="text-right">
            <p className={`font-mono text-lg font-semibold ${tone.text}`}>{health.score.toFixed(0)}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400">out of 100 · {health.currency}</p>
          </div>
        </div>
      </div>

      {/* The bar is a second reading of the table below it, never the only one. */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(2, health.score)}%` }} />
      </div>

      <TableScroller>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-400">
              <th scope="col" className="py-2 pr-3">What was measured</th>
              <th scope="col" className="py-2 pr-3">The figures behind it</th>
              <th scope="col" className="py-2 pr-3 text-right">Score</th>
              <th scope="col" className="py-2 text-right">Weight</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {health.components.map(c => (
              <tr key={c.key}>
                <td className="py-2 pr-3 font-medium text-slate-800">{c.label}</td>
                <td className="py-2 pr-3 text-slate-500">{c.detail}</td>
                <td className="py-2 pr-3 text-right font-mono text-slate-800">{c.score.toFixed(0)}</td>
                <td className="py-2 text-right font-mono text-slate-400">{c.weight.toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>

      <p className="text-[11px] leading-relaxed text-slate-500">
        The grade is the weighted average of the scores above and nothing else, A is 85 and over, B 70, C 55, D 40.
        Anything that cannot be measured this period is left out and the weights are shared across the rest, rather than
        being counted as a zero. Currencies are graded separately.
      </p>
    </section>
  );
}
