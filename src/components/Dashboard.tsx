/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import {
  AppSettings,
  Booking,
  Charge,
  Currency,
  Expense,
  PAYMENT_METHODS,
  Payment,
  PaymentMethod,
  SessionUser,
  Unit,
  getUnitDisplayName,
  Tenancy
} from '../types';
import {
  AccountBalance,
  chargeCurrency,
  collectedInPeriod,
  chargedInPeriod,
  collectionRate,
  delinquentAccounts,
  expensesInPeriod,
  isOccupied,
  ownerBilledUnitIds,
  unbilledAccounts,
  unbilledOccupancy
} from '../lib/finance';
import { formatMoney, formatMoneyLong, sumMoney } from '../lib/money';
import { addDays, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, today } from '../lib/dates';
import { errorMessage } from '../lib/api';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  Modal,
  SecondaryButton,
  SubmitButton,
  SuccessNote,
  TableScroller,
  inputClass,
  monoInputClass
} from './ui';
import { AlertTriangle, ArrowUpRight, CalendarDays, Key, LogIn, LogOut, TrendingDown, TrendingUp } from 'lucide-react';
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
  onRefresh: () => Promise<void> | void;
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
  const [month, setMonth] = useState(currentMonth());
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [payTarget, setPayTarget] = useState<AccountBalance | 'blank' | null>(null);

  const periodStart = monthStart(month);
  const periodEnd = monthEnd(month);
  const ownerBilled = useMemo(() => ownerBilledUnitIds(units), [units]);

  /* ---------------- occupancy ---------------- */

  const totalUnits = units.length;
  const occupiedUnits = units.filter(isOccupied).length;
  const vacantUnits = units.filter(u => u.status === 'vacant').length;
  // Guard against dividing by zero on an empty register, which rendered "NaN%".
  const occupancyRate = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : null;

  /* ---------------- arrears ---------------- */

  const arrears = useMemo(() => delinquentAccounts(units, charges, payments), [units, charges, payments]);
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
  const unbilledMonths = useMemo(() => unbilledOccupancy(units, tenancies, charges), [units, tenancies, charges]);
  const arrearsByCurrency = useMemo(() => {
    const out: Record<Currency, number> = { USD: 0, JMD: 0 };
    for (const account of arrears) {
      out[account.currency] = sumMoney([out[account.currency], account.balance]);
    }
    return out;
  }, [arrears]);

  const chargesPostedForMonth = charges.some(c => c.periodMonth === month && c.status === 'open');

  /* ---------------- money for the selected period ---------------- */

  const ledger = useMemo(() => {
    return (['JMD', 'USD'] as Currency[]).map(currency => {
      const collected = collectedInPeriod(payments, currency, periodStart, periodEnd, ownerBilled);
      const billed = chargedInPeriod(charges, currency, periodStart, periodEnd);
      const spent = expensesInPeriod(expenses, currency, periodStart, periodEnd);
      return {
        currency,
        collected,
        billed,
        spent,
        net: sumMoney([collected.total, -spent]),
        rate: collectionRate(billed.total, sumMoney([collected.rent, collected.maintenance]))
      };
    });
  }, [payments, charges, expenses, periodStart, periodEnd, ownerBilled]);

  /* ---------------- short-term ---------------- */

  const activeBookings = bookings.filter(b => b.status !== 'cancelled');
  const todayStr = today();
  const horizon = addDays(todayStr, ARRIVAL_WINDOW_DAYS);

  const upcomingArrivals = activeBookings
    .filter(b => b.checkIn >= todayStr && b.checkIn <= horizon && b.status === 'confirmed')
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));

  const upcomingDepartures = activeBookings
    .filter(b => b.checkOut >= todayStr && b.checkOut <= horizon && b.status === 'checked-in')
    .sort((a, b) => a.checkOut.localeCompare(b.checkOut));

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

      {/* Quick actions */}
      <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-teal-950 bg-teal-900 p-5 text-white shadow-md sm:flex-row sm:items-center">
        <div>
          <h3 className="font-display text-sm font-semibold tracking-wide">Operational quick actions</h3>
          <p className="mt-1 text-xs text-teal-100/80">Record a payment received at the office without leaving this page.</p>
        </div>
        {session.permissions.recordPayments && (
          <button
            onClick={() => setPayTarget('blank')}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-xs font-semibold text-teal-900 shadow-sm transition-all hover:bg-teal-50 sm:w-auto"
          >
            <ArrowUpRight className="h-4 w-4 text-emerald-600" />
            Receive payment
          </button>
        )}
      </div>

      {/* Overview */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard
          label="Occupancy"
          value={occupancyRate === null ? '—' : `${occupancyRate}%`}
          hint={totalUnits > 0 ? `${occupiedUnits} of ${totalUnits} villas occupied` : 'No villas in the register'}
          icon={<Key className="h-6 w-6" />}
          tone="emerald"
        />
        <StatCard
          label="Vacant villas"
          value={String(vacantUnits)}
          hint="Available to lease or let"
          icon={<TrendingDown className="h-6 w-6" />}
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
              : unbilled.length > 0
                ? // Never say everything is settled while accounts are set up but unbilled.
                  `${unbilled.length} account${unbilled.length === 1 ? '' : 's'} not yet billed`
                : 'All billed accounts settled'
          }
          icon={<AlertTriangle className="h-6 w-6" />}
          tone={arrears.length > 0 ? 'red' : 'slate'}
        />
      </div>

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
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="font-semibold text-slate-800">{getUnitDisplayName(account.unit.number)}</p>
                      <Badge tone={account.category === 'Maintenance' ? 'purple' : 'green'}>{account.category}</Badge>
                    </div>
                    <p className="mt-1.5 truncate text-[10px] text-slate-500">
                      Payer: <span className="font-medium text-slate-700">{account.unpaidCharges[0]?.payerName || '—'}</span>
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
                  </dl>
                </div>
              </div>
            </div>
          ))}
        </div>

        <p className="border-t border-slate-100 pt-3 font-mono text-[10px] leading-relaxed text-slate-400">
          Utility recoveries from owner-occupied and short-let villas are billed directly to the owner and are excluded
          from the figures above. Indicative rate on file: 1 USD = {settings.fxRateJmdPerUsd} JMD (display only — no
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
            stay value. Platform calendar feeds publish dates only, never pricing — open each reservation and enter the
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
            emptyText="No confirmed arrivals scheduled in this window."
          />
          <TransitionList
            title={`Departures in the next ${ARRIVAL_WINDOW_DAYS} days`}
            icon={<LogOut className="h-3.5 w-3.5" />}
            tone="amber"
            bookings={upcomingDepartures}
            dateOf={b => b.checkOut}
            emptyText="No guests currently checked in are due to depart in this window."
          />
        </div>
      </section>

      {payTarget && (
        <QuickReceiveModal
          units={units}
          charges={charges}
          account={payTarget === 'blank' ? null : payTarget}
          onClose={() => setPayTarget(null)}
          onSubmit={async payload => {
            try {
              const payment = await onRecordPayment(payload);
              setSuccess(`Receipt ${payment.receiptNo} issued for ${formatMoneyLong(payment.amount, payment.currency)}.`);
              setError('');
              setPayTarget(null);
            } catch (err) {
              throw new Error(errorMessage(err, 'Could not record the payment.'));
            }
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  hint,
  icon,
  tone
}: {
  label: string;
  value: string;
  hint: string;
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
  return (
    <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
      <div className="min-w-0">
        <p className="font-mono text-xs uppercase text-slate-500">{label}</p>
        <h3 className="mt-1 font-display text-2xl font-semibold">{value}</h3>
        <p className="mt-1 truncate text-xs text-slate-400" title={hint}>
          {hint}
        </p>
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
                  {b.guestName} — {getUnitDisplayName(b.unitNumber)}
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

/* ------------------------------------------------------------------ */

function QuickReceiveModal({
  units,
  charges,
  account,
  onClose,
  onSubmit
}: {
  units: Unit[];
  charges: Charge[];
  account: AccountBalance | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [unitId, setUnitId] = useState(account?.unit.id || '');
  const [category, setCategory] = useState<'Rent' | 'Maintenance' | 'Booking' | 'Utility' | 'Other'>(account?.category || 'Maintenance');
  const [payerName, setPayerName] = useState(account ? account.unpaidCharges[0]?.payerName || '' : '');
  const [amount, setAmount] = useState(account ? String(Math.max(0, account.balance)) : '');
  const [currency, setCurrency] = useState<Currency>(account?.currency || 'JMD');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>('Cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [confirmNoCharge, setConfirmNoCharge] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const unit = units.find(u => u.id === unitId);

  /** Nothing billed yet: this money would land as a credit, not settle anything. */
  const noOpenCharge =
    !!unit &&
    (category === 'Rent' || category === 'Maintenance') &&
    !charges.some(c => c.unitId === unit.id && c.category === category && c.status === 'open' && c.currency === currency);

  /**
   * Prefill from the unit register. The original picked `unit.currency` even for
   * maintenance, so a villa billed in USD had its receipt recorded in JMD and
   * the payment never cleared the delinquency it was raised against.
   */
  const applyUnitDefaults = (nextUnitId: string, nextCategory: typeof category) => {
    const u = units.find(item => item.id === nextUnitId);
    if (!u) return;
    if (nextCategory === 'Rent' || nextCategory === 'Maintenance') {
      setCurrency(chargeCurrency(u, nextCategory));
      setAmount(String(nextCategory === 'Maintenance' ? u.monthlyMaintenance : u.monthlyRent));
    } else {
      setCurrency(u.currency);
    }
    setPayerName(nextCategory === 'Maintenance' ? u.ownerName : u.tenantName || u.ownerName);
  };

  const expectedCurrency = unit && (category === 'Rent' || category === 'Maintenance') ? chargeCurrency(unit, category) : null;
  const mismatch = !!expectedCurrency && expectedCurrency !== currency;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!unitId) {
      setError('Select the villa this payment relates to.');
      return;
    }
    if (!(Number(amount) > 0)) {
      setError('Enter an amount greater than zero.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        unitId,
        category,
        payerName,
        amount: Number(amount),
        currency,
        date,
        method,
        reference,
        notes,
        // This screen's button says "Receive payment": the money is in hand, so
        // the receipt is issued now and the arrears alert clears immediately.
        receivedNow: true,
        confirmCurrencyMismatch: confirmMismatch,
        confirmNoOpenCharge: confirmNoCharge
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not record the payment.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Record payment received"
      subtitle={account ? `${getUnitDisplayName(account.unit.number)} — ${account.category}` : undefined}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Issuing receipt…" form="vds-quick-receive" className="flex-1">
            Record and issue receipt
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-quick-receive" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Villa unit" htmlFor="qr-unit" required>
            <select
              id="qr-unit"
              value={unitId}
              onChange={e => {
                setUnitId(e.target.value);
                applyUnitDefaults(e.target.value, category);
              }}
              required
              className={inputClass}
            >
              <option value="">Select villa</option>
              {units.map(u => (
                <option key={u.id} value={u.id}>
                  {getUnitDisplayName(u.number)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category" htmlFor="qr-cat" required>
            <select
              id="qr-cat"
              value={category}
              onChange={e => {
                const next = e.target.value as typeof category;
                setCategory(next);
                applyUnitDefaults(unitId, next);
              }}
              className={inputClass}
            >
              <option value="Maintenance">Maintenance (HOA)</option>
              <option value="Rent">Rent (long-term)</option>
              <option value="Booking">Booking (short stay)</option>
              <option value="Utility">Utility</option>
              <option value="Other">Other</option>
            </select>
          </Field>
        </div>

        <Field label="Payer name" htmlFor="qr-payer" required>
          <input id="qr-payer" type="text" value={payerName} onChange={e => setPayerName(e.target.value)} required className={inputClass} placeholder="Owner, tenant or guest" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount received" htmlFor="qr-amount" required>
            <input id="qr-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Currency" htmlFor="qr-cur" required>
            <select id="qr-cur" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={monoInputClass}>
              <option value="JMD">JMD (J$)</option>
              <option value="USD">USD ($)</option>
            </select>
          </Field>
        </div>

        {mismatch && (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <p>
              {getUnitDisplayName(unit!.number)} is billed for {category.toLowerCase()} in <strong>{expectedCurrency}</strong>.
              A receipt in {currency} will not reduce that balance.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmMismatch} onChange={e => setConfirmMismatch(e.target.checked)} className="mt-0.5" />
              <span>Record in {currency} anyway.</span>
            </label>
          </div>
        )}

        {noOpenCharge && !mismatch && (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <p>
              Nothing has been billed to {getUnitDisplayName(unit!.number)} for {category.toLowerCase()} yet, so this would
              be recorded as a <strong>credit</strong> rather than settling anything. Post the month&apos;s charges first.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmNoCharge} onChange={e => setConfirmNoCharge(e.target.checked)} className="mt-0.5" />
              <span>Record it as a credit anyway.</span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Method" htmlFor="qr-method" required>
            <select id="qr-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date received" htmlFor="qr-date" required>
            <input id="qr-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <Field label="Reference" htmlFor="qr-ref">
          <input id="qr-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
        </Field>

        <Field label="Notes" htmlFor="qr-notes">
          <textarea id="qr-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}
