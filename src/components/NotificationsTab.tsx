/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import {
  Booking,
  Charge,
  Currency,
  Expense,
  PAYMENT_METHODS,
  Payment,
  PaymentMethod,
  SessionUser,
  Unit,
  UtilityReading,
  getAllocationLabel,
  getUnitDisplayName,
  Tenancy,
  AppSettings
} from '../types';
import { AccountBalance, accountBalance, bookingOverlaps, delinquentAccounts, leasesNeedingAttention, maintenanceFundedFromRent, tenanciesMissingMoveInDate, scheduledCharges, unbilledOccupancy } from '../lib/finance';
import { formatMoney, formatMoneyLong, sumMoney } from '../lib/money';
import { formatDayLabel, formatMonthLabel, daysSince, today } from '../lib/dates';
import { ALREADY_SETTLED, POSSIBLE_DUPLICATE, ApiError, errorMessage } from '../lib/api';
import type { TabKey } from '../App';
import {
  AlreadySettledNote,
  DuplicateEntryNote,
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  Modal,
  SecondaryButton,
  SubmitButton,
  SuccessNote,
  inputClass,
  monoInputClass
} from './ui';
import { AlertTriangle, Bell, CalendarX, CheckCircle, DollarSign, Gauge, Wrench } from 'lucide-react';

interface NotificationsTabProps {
  units: Unit[];
  /** Carries the migration cutover, so months before it are not called unbilled. */
  settings: AppSettings;
  charges: Charge[];
  payments: Payment[];
  utilities: UtilityReading[];
  tenancies: Tenancy[];
  expenses: Expense[];
  bookings: Booking[];
  session: SessionUser;
  onNavigateToTab: (tab: TabKey) => void;
  onRecordPayment: (payload: Record<string, unknown>) => Promise<Payment>;
  onSettleUtility: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
  onUpdateExpense: (id: string, fields: Record<string, unknown>) => Promise<unknown>;
  /** Post a billing month. Lets an unbilled month be fixed here rather than sending someone to the ledger. */
  onPostMonth: (month: string) => Promise<unknown>;
}

type Filter = 'all' | 'rent' | 'maintenance' | 'unbilled' | 'lease' | 'utility' | 'expense' | 'booking';

interface Item {
  id: string;
  type: Exclude<Filter, 'all'>;
  title: string;
  description: string;
  amount: number;
  currency: Currency;
  /**
   * 'scheduled' is money posted but not yet due. It is shown, quietly, and is
   * deliberately kept out of every count and total of what is owed — see the
   * note on scheduledCharges() in lib/finance.
   */
  severity: 'high' | 'medium' | 'scheduled';
  ageDays: number;
  account?: AccountBalance;
  utility?: UtilityReading;
  expense?: Expense;
  /** The day a scheduled charge falls due, for the items that have one. */
  dueOn?: string;
  /** Months a tenant has occupied that were never billed. */
  unbilledMonths?: string[];
  isBooking?: boolean;
}

export default function NotificationsTab({
  units,
  settings,
  charges,
  payments,
  utilities,
  tenancies,
  expenses,
  bookings,
  session,
  onNavigateToTab,
  onRecordPayment,
  onSettleUtility,
  onUpdateExpense,
  onPostMonth
}: NotificationsTabProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  /** The id of the item whose months are being posted, so only its button spins. */
  const [posting, setPosting] = useState<string | null>(null);

  const [settleAccount, setSettleAccount] = useState<AccountBalance | null>(null);
  const [settleUtility, setSettleUtility] = useState<UtilityReading | null>(null);
  const [settleExpense, setSettleExpense] = useState<Expense | null>(null);

  const perms = session.permissions;

  /**
   * Post the months an occupied villa was never billed for, from here.
   *
   * One request per month, in order, oldest first — the endpoint takes a single
   * month and posts every billable villa in it, skipping any already billed. So
   * this is safe to press twice, and safe when two villas report the same missing
   * month: the second press bills nothing.
   */
  const handlePostMissingMonths = async (item: Item) => {
    const months = item.unbilledMonths || [];
    if (months.length === 0) return;
    setPosting(item.id);
    setError('');
    setSuccess('');
    try {
      for (const month of [...months].sort()) {
        await onPostMonth(month);
      }
      setSuccess(
        months.length === 1
          ? `${formatMonthLabel(months[0])} has been posted. The rent is now owed and can be collected.`
          : `${months.length} months have been posted (${months.map(formatMonthLabel).join(', ')}). The rent is now owed and can be collected.`
      );
    } catch (err) {
      setError(errorMessage(err, 'The month could not be posted.'));
    } finally {
      setPosting(null);
    }
  };

  const items = useMemo<Item[]>(() => {
    // As of today. Without this every open charge counted, so a month posted on
    // the 1st with rent due on the 7th read as an unpaid month from the moment it
    // was posted — see scheduledCharges() in lib/finance.
    const accounts = delinquentAccounts(units, charges, payments, today()).map<Item>(account => ({
      id: `${account.category.toLowerCase()}-${account.unit.id}`,
      type: account.category === 'Rent' ? 'rent' : 'maintenance',
      title: `${account.category === 'Rent' ? 'Rent' : 'HOA maintenance'} outstanding, ${getUnitDisplayName(account.unit.number)}`,
      description:
        `${account.unpaidCharges[0]?.payerName || 'The account holder'} has ${account.unpaidCharges.length} unpaid ` +
        `month${account.unpaidCharges.length === 1 ? '' : 's'} from ${formatMonthLabel(account.unpaidCharges[0]?.periodMonth || '')}. ` +
        `Billed ${formatMoney(account.charged, account.currency)}, received ${formatMoney(account.paid, account.currency)}.` +
        (maintenanceFundedFromRent(account.unit)
          ? account.category === 'Maintenance'
            ? ' Settled from rent: it is taken out of the tenant\'s rent as each payment arrives, so nothing is collected separately.'
            : ' The HOA maintenance is settled from this rent as it is received.'
          : ''),
      amount: account.balance,
      currency: account.currency,
      severity: account.oldestUnpaidDays > 30 ? 'high' : 'medium',
      ageDays: account.oldestUnpaidDays,
      account
    }));

    // Posted, but not owed yet. Shown so the coming week is visible, and kept out
    // of every count and total of money owed so it can never read as a debt.
    const scheduledItems = scheduledCharges(units, charges, payments, today()).map<Item>(row => ({
      id: `scheduled-${row.category.toLowerCase()}-${row.unit.id}`,
      type: row.category === 'Rent' ? 'rent' : 'maintenance',
      title: `${row.category === 'Rent' ? 'Rent' : 'HOA maintenance'} due ${formatDayLabel(row.nextDueDate)}, ${getUnitDisplayName(row.unit.number)}`,
      description:
        `${row.charges[0].payerName || 'The account holder'}, posted and not yet due` +
        `${row.daysUntilDue === 1 ? ', due tomorrow' : `, due in ${row.daysUntilDue} days`}. ` +
        'Nothing is late. It moves to the list above on the day itself.',
      amount: row.amount,
      currency: row.currency,
      severity: 'scheduled',
      ageDays: -1, // sorts below everything that is actually due
      dueOn: row.nextDueDate,
      /*
       * Deliberately the *unrestricted* balance, with no as-of date: a tenant who
       * walks in on the 1st to pay rent due on the 7th must have somewhere to put
       * the money. What is owed today and what is open on the account are two
       * different questions, and only the first one drives an alert.
       */
      account: accountBalance(row.unit, row.category, charges, payments, undefined, units)
    }));

    // Occupied months that were never billed — most often a tenant recorded
    // weeks after they moved in. Nothing else surfaces these, because an unbilled
    // month looks identical to a month with nothing owed.
    const unbilledItems = unbilledOccupancy(units, tenancies, charges, today(), settings?.booksBeginOn).map<Item>(row => ({
      id: `unbilled-${row.tenancy.id}`,
      type: 'unbilled',
      title: `Rent not yet billed, ${getUnitDisplayName(row.unit.number)}`,
      description:
        `${row.tenancy.tenantName} has occupied ${row.months.length} month${row.months.length === 1 ? '' : 's'} ` +
        `that ${row.months.length === 1 ? 'has' : 'have'} never been billed (${row.months.map(formatMonthLabel).join(', ')}). ` +
        'Post those months so the rent is owed and can be collected.',
      amount: row.amount,
      currency: row.currency,
      severity: row.months.length > 1 ? 'high' : 'medium',
      ageDays: 0,
      unbilledMonths: row.months
    }));

    /*
     * A sitting tenant with no move-in date. Shown because the absence is what
     * silently disables the unbilled-months alarm for that villa — the warning
     * has to come from here, since nothing else would ever mention it.
     */
    const missingMoveIn = tenanciesMissingMoveInDate(units, tenancies).map<Item>(row => ({
      id: `movein-${row.tenancy.id}`,
      type: 'unbilled',
      title: `Move-in date missing, ${getUnitDisplayName(row.unit.number)}`,
      description:
        `${row.tenancy.tenantName || 'The sitting tenant'} has no move-in date on record. ` +
        'Until one is entered this villa is left out of the check for occupied months that were never billed, ' +
        'is not counted as occupied, and will not have first and last month\'s rent raised. ' +
        'Set it on the tenancy from the villa page.',
      amount: 0,
      currency: row.unit.currency,
      severity: 'medium',
      ageDays: 0
    }));

    // Leases running out. A fixed term that lapses unnoticed rolls the tenant
    // onto month-to-month terms nobody chose, at the old rent — so this has to be
    // visible before the date, not after it.
    const leaseItems = leasesNeedingAttention(units, tenancies).map<Item>(row => ({
      id: `lease-${row.tenancy.id}`,
      type: 'lease',
      title: `${row.expired ? 'Lease expired' : 'Lease ending soon'}, ${getUnitDisplayName(row.unit.number)}`,
      description: row.expired
        ? `${row.tenancy.tenantName}'s lease ended ${formatDayLabel(row.leaseEndsOn)}, ${Math.abs(row.daysRemaining)} day${Math.abs(row.daysRemaining) === 1 ? '' : 's'} ago. ` +
          'Until it is renewed they are on month-to-month terms at the old rent. Agree a renewal or serve notice.'
        : `${row.tenancy.tenantName}'s lease ends ${formatDayLabel(row.leaseEndsOn)}, in ${row.daysRemaining} day${row.daysRemaining === 1 ? '' : 's'}. ` +
          'Decide now whether to renew, change the rent, or give notice.',
      amount: 0,
      currency: row.tenancy.currency,
      severity: row.expired || row.daysRemaining <= 30 ? 'high' : 'medium',
      ageDays: row.expired ? Math.abs(row.daysRemaining) : 0
    }));

    const utilityItems = utilities
      .filter(u => u.status === 'unpaid')
      .map<Item>(u => ({
        id: `util-${u.id}`,
        type: 'utility',
        title: `Unpaid utility bill, ${getUnitDisplayName(u.unitNumber)}`,
        description: `Meter ${u.meterNumber} for ${formatMonthLabel(u.billingPeriod)}: ${u.consumption.toLocaleString()} units consumed.`,
        amount: u.amountCharged,
        currency: u.currency,
        severity: 'medium',
        ageDays: 0,
        utility: u
      }));

    const expenseItems = expenses
      .filter(e => e.status === 'pending')
      .map<Item>(e => {
        const due = e.dueDate || e.date;
        const overdueBy = daysSince(due);
        return {
          id: `expense-${e.id}`,
          type: 'expense',
          title: `Expense due, ${e.vendor}`,
          description: `${e.category}${e.unitNumber !== 'General' ? ` for ${getAllocationLabel(e.unitNumber)}` : ' (property-wide)'}: ${
            e.description || 'no description recorded'
          }. Due ${formatDayLabel(due)}${overdueBy > 0 ? `, ${overdueBy} days overdue` : ''}.`,
          amount: e.amount,
          currency: e.currency,
          severity: overdueBy > 0 ? 'high' : 'medium',
          ageDays: Math.max(0, overdueBy),
          expense: e
        };
      });

    const overlapItems = bookingOverlaps(bookings).map<Item>((clash, i) => ({
      id: `overlap-${clash.unitId}-${i}`,
      type: 'booking',
      title: `Double-booking, ${getUnitDisplayName(clash.unitNumber)}`,
      description:
        `${clash.a.guestName} (${formatDayLabel(clash.a.checkIn)}–${formatDayLabel(clash.a.checkOut)}) overlaps ` +
        `${clash.b.guestName} (${formatDayLabel(clash.b.checkIn)}–${formatDayLabel(clash.b.checkOut)}). ` +
        `Cancel or move one reservation in the Bookings tab.`,
      amount: 0,
      currency: 'USD',
      severity: 'high',
      ageDays: 9999, // sort to the very top, a clash needs resolving before it reaches a guest
      isBooking: true
    }));

    return [...overlapItems, ...leaseItems, ...unbilledItems, ...missingMoveIn, ...accounts, ...utilityItems, ...expenseItems, ...scheduledItems].sort(
      (a, b) => b.ageDays - a.ageDays
    );
  }, [units, charges, payments, utilities, expenses, bookings, tenancies]);

  const visible = items.filter(i => filter === 'all' || i.type === filter);
  const highCount = items.filter(i => i.severity === 'high').length;

  /*
   * Everything below counts what is *owed*, so scheduled items are excluded from
   * all of it. Including them would put the same lie back in a different place:
   * a headline total that a manager reads as debt, made partly of rent that is
   * not due until next week.
   */
  const owedItems = items.filter(i => i.severity !== 'scheduled');
  const scheduledCount = items.length - owedItems.length;

  const totals = useMemo(() => {
    const out: Record<Currency, number> = { USD: 0, JMD: 0 };
    for (const item of items) {
      if (item.severity === 'scheduled') continue;
      out[item.currency] = sumMoney([out[item.currency], item.amount]);
    }
    return out;
  }, [items]);

  const counts: Record<Filter, number> = {
    all: items.length,
    booking: items.filter(i => i.type === 'booking').length,
    rent: items.filter(i => i.type === 'rent').length,
    maintenance: items.filter(i => i.type === 'maintenance').length,
    unbilled: items.filter(i => i.type === 'unbilled').length,
    lease: items.filter(i => i.type === 'lease').length,
    utility: items.filter(i => i.type === 'utility').length,
    expense: items.filter(i => i.type === 'expense').length
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
          <div>
            <p className="font-mono text-xs uppercase text-slate-500">Open items</p>
            <h3 className="mt-1 font-display text-2xl font-semibold text-slate-950">{owedItems.length}</h3>
            <p className="mt-1 text-xs text-slate-400">
              Money owed to and by the property
              {scheduledCount > 0 && (
                <>
                  {' · '}
                  <span className="text-slate-500">
                    {scheduledCount} more posted, not yet due
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="rounded-xl bg-teal-50 p-3 text-teal-600">
            <Bell className="h-6 w-6" />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
          <div>
            <p className="font-mono text-xs uppercase text-slate-500">Needs attention</p>
            <h3 className="mt-1 font-display text-2xl font-semibold text-red-600">{highCount}</h3>
            <p className="mt-1 text-xs text-slate-400">Over 30 days in arrears, or past due</p>
          </div>
          <div className="rounded-xl bg-red-50 p-3 text-red-600">
            <AlertTriangle className="h-6 w-6" />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
          <div>
            <p className="font-mono text-xs uppercase text-slate-500">Total value</p>
            <div className="mt-1 space-y-0.5">
              <p className="font-mono text-sm font-bold text-slate-800">{formatMoney(totals.JMD, 'JMD')} JMD</p>
              <p className="font-mono text-sm font-bold text-slate-800">{formatMoney(totals.USD, 'USD')} USD</p>
            </div>
            <p className="mt-1 text-xs text-slate-400">Currencies reported separately · owed now, excluding what is not yet due</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3 text-slate-600">
            <DollarSign className="h-6 w-6" />
          </div>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}

      <div className="flex flex-wrap gap-2">
        {([
          ['all', 'All'],
          ['booking', 'Double-bookings'],
          ['rent', 'Rent'],
          ['maintenance', 'Maintenance'],
          ['unbilled', 'Not yet billed'],
          ['lease', 'Leases'],
          ['utility', 'Utilities'],
          ['expense', 'Expenses']
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
              filter === key ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {label} ({counts[key]})
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={items.length === 0 ? 'Nothing outstanding' : 'Nothing outstanding in this category'}
          hint={
            charges.length === 0
              ? 'No charges have been posted yet. Rent and maintenance only appear here once a billing month is posted, from the ledger, or from the "not yet billed" alerts on this page.'
              : 'Nothing is overdue, all utility bills are paid, and no expenses are pending. Rent posted for a month but not yet due is shown in grey rather than counted here.'
          }
          icon={<CheckCircle className="h-6 w-6" />}
        />
      ) : (
        <ul className="space-y-3">
          {visible.map(item => (
            <li
              key={item.id}
              className={`flex flex-col gap-3 rounded-2xl border bg-white p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between ${
                item.severity === 'high' ? 'border-red-100' : 'border-slate-100'
              } ${
                // Posted but not owed. Held back visually on purpose: it must be
                // readable as "coming", never as "late".
                item.severity === 'scheduled' ? 'bg-slate-50/60' : ''
              }`}
            >
              <div className="flex min-w-0 gap-3">
                <span
                  className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                    item.severity === 'scheduled'
                      ? 'bg-slate-100 text-slate-500'
                      : item.type === 'booking'
                        ? 'bg-red-50 text-red-600'
                        : item.type === 'utility'
                          ? 'bg-sky-50 text-sky-600'
                          : item.type === 'expense'
                            ? 'bg-slate-100 text-slate-600'
                            : item.severity === 'high'
                              ? 'bg-red-50 text-red-600'
                              : 'bg-amber-50 text-amber-600'
                  }`}
                >
                  {item.type === 'booking' ? (
                    <CalendarX className="h-4 w-4" />
                  ) : item.type === 'utility' ? (
                    <Gauge className="h-4 w-4" />
                  ) : item.type === 'expense' ? (
                    <Wrench className="h-4 w-4" />
                  ) : (
                    <DollarSign className="h-4 w-4" />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className={`text-sm font-semibold ${item.severity === 'scheduled' ? 'text-slate-600' : 'text-slate-900'}`}>
                      {item.title}
                    </p>
                    {item.severity === 'high' && <Badge tone="red">Needs attention</Badge>}
                    {item.severity === 'scheduled' && <Badge tone="slate">Not yet due</Badge>}
                    {item.type !== 'booking' && item.ageDays > 0 && (
                      <Badge tone={item.ageDays > 60 ? 'red' : 'amber'}>{item.ageDays} days</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{item.description}</p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-4 sm:flex-col sm:items-end">
                {item.type !== 'booking' && item.amount !== 0 && (
                  <div className="text-right">
                    <span className="block font-mono text-[9px] uppercase text-slate-400">
                      {item.severity === 'scheduled' ? 'Due' : item.type === 'expense' ? 'To pay' : 'Outstanding'}
                    </span>
                    <span
                      className={`font-mono text-base font-bold ${
                        item.severity === 'scheduled' ? 'text-slate-500' : item.type === 'expense' ? 'text-slate-800' : 'text-red-600'
                      }`}
                    >
                      {formatMoney(item.amount, item.currency)}
                    </span>
                    <span className="block font-mono text-[9px] text-slate-400">{item.currency}</span>
                  </div>
                )}
                <ItemAction
                  item={item}
                  perms={perms}
                  onSettleAccount={() => item.account && setSettleAccount(item.account)}
                  onSettleUtility={() => item.utility && setSettleUtility(item.utility)}
                  onSettleExpense={() => item.expense && setSettleExpense(item.expense)}
                  onOpenBookings={() => onNavigateToTab('bookings')}
                  onOpenUnits={() => onNavigateToTab('units')}
                  onPostMissingMonths={() => void handlePostMissingMonths(item)}
                  posting={posting === item.id}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {settleAccount && (
        <SettleAccountModal
          account={settleAccount}
          staffName={session.name}
          onClose={() => setSettleAccount(null)}
          onSubmit={async payload => {
            const payment = await onRecordPayment(payload);
            setSuccess(`Receipt ${payment.receiptNo} issued for ${formatMoneyLong(payment.amount, payment.currency)}.`);
            setError('');
            setSettleAccount(null);
          }}
        />
      )}

      {settleUtility && (
        <SettleUtilityModal
          utility={settleUtility}
          units={units}
          onClose={() => setSettleUtility(null)}
          onSubmit={async payload => {
            await onSettleUtility(settleUtility.id, payload);
            setSuccess('Utility bill settled and a receipt issued, so the payment now appears in the ledger and in reports.');
            setError('');
            setSettleUtility(null);
          }}
        />
      )}

      {settleExpense && (
        <SettleExpenseModal
          expense={settleExpense}
          onClose={() => setSettleExpense(null)}
          onSubmit={async fields => {
            await onUpdateExpense(settleExpense.id, fields);
            setSuccess(`Expense to ${settleExpense.vendor} recorded as paid.`);
            setError('');
            setSettleExpense(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ItemAction({
  item,
  perms,
  onSettleAccount,
  onSettleUtility,
  onSettleExpense,
  onOpenBookings,
  onOpenUnits,
  onPostMissingMonths,
  posting
}: {
  item: Item;
  perms: SessionUser['permissions'];
  onSettleAccount: () => void;
  onSettleUtility: () => void;
  onSettleExpense: () => void;
  onOpenBookings: () => void;
  onOpenUnits: () => void;
  onPostMissingMonths: () => void;
  posting: boolean;
}) {
  if (item.type === 'booking') {
    return (
      <button
        type="button"
        onClick={onOpenBookings}
        className="whitespace-nowrap rounded-xl bg-red-600 px-3 py-2 text-[11px] font-medium text-white transition-all hover:bg-red-700"
      >
        Resolve in Bookings
      </button>
    );
  }
  if (item.type === 'utility') {
    if (!perms.enterUtilities) return <span className="text-[10px] text-slate-400">Requires utility permission</span>;
    // Settling issues a receipt, so it needs the payment permission too.
    if (!perms.recordPayments) return <span className="text-[10px] text-slate-400">Requires payment permission</span>;
    return (
      <SubmitButton type="button" onClick={onSettleUtility} className="whitespace-nowrap px-3 py-2 text-[11px]">
        Settle &amp; receipt
      </SubmitButton>
    );
  }
  if (item.type === 'expense') {
    if (!perms.recordExpenses) return <span className="text-[10px] text-slate-400">Requires expense permission</span>;
    return (
      <SubmitButton type="button" onClick={onSettleExpense} className="whitespace-nowrap px-3 py-2 text-[11px]">
        Record as paid
      </SubmitButton>
    );
  }
  // A lease warning and an unbilled month are not debts to collect — offering
  // "Receive payment" on them was a button that called a handler with no account
  // and did nothing at all. Send people where the work actually is.
  if (item.type === 'lease') {
    return (
      <SecondaryButton onClick={onOpenUnits} className="whitespace-nowrap px-3 py-2 text-[11px]">
        Open the tenancy
      </SecondaryButton>
    );
  }
  // "Move-in date missing" is raised as an unbilled item but has no months to post:
  // the fix is to set the date on the tenancy. It used to offer "Post the undefined
  // months", a button that posted nothing.
  if (item.type === 'unbilled' && !item.unbilledMonths?.length) {
    return (
      <SecondaryButton onClick={onOpenUnits} className="whitespace-nowrap px-3 py-2 text-[11px]">
        Open the tenancy
      </SecondaryButton>
    );
  }
  if (item.type === 'unbilled') {
    if (!perms.postCharges) return <span className="text-[10px] text-slate-400">Requires the post-charges permission</span>;
    // Posts from here rather than navigating to the ledger. The work is one
    // click away from the alert that asked for it, and posting is idempotent per
    // month per villa — a month already billed is skipped, not billed twice.
    return (
      <SubmitButton type="button" busy={posting} busyLabel="Posting…" onClick={onPostMissingMonths} className="whitespace-nowrap px-3 py-2 text-[11px]">
        Post {item.unbilledMonths && item.unbilledMonths.length === 1 ? 'the month' : `the ${item.unbilledMonths?.length} months`}
      </SubmitButton>
    );
  }

  // Posted but not due. Money can still be taken early — a tenant who pays on the
  // 1st for the 7th is not doing anything unusual — but it is offered quietly.
  if (item.severity === 'scheduled') {
    if (!perms.recordPayments) return <span className="text-[10px] text-slate-400">Nothing to do yet</span>;
    return (
      <SecondaryButton onClick={onSettleAccount} className="whitespace-nowrap px-3 py-2 text-[11px]">
        Receive early payment
      </SecondaryButton>
    );
  }
  if (!perms.recordPayments) return <span className="text-[10px] text-slate-400">Requires payment permission</span>;
  return (
    <SubmitButton type="button" onClick={onSettleAccount} className="whitespace-nowrap px-3 py-2 text-[11px]">
      Receive payment
    </SubmitButton>
  );
}

/* ------------------------------------------------------------------ */

function SettleAccountModal({
  account,
  staffName,
  onClose,
  onSubmit
}: {
  account: AccountBalance;
  staffName: string;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(account.balance));
  const [payerName, setPayerName] = useState(account.unpaidCharges[0]?.payerName || '');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>('Bank Transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  // This is the screen the race actually happens on: two people working the same
  // arrears list. The balance above was fetched before whoever else banked the
  // money saved it, so only the server can tell us, and only at submit.
  const [alreadySettled, setAlreadySettled] = useState('');
  const [confirmAlreadySettled, setConfirmAlreadySettled] = useState(false);
  const [duplicateNote, setDuplicateNote] = useState('');
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const partial = Number(amount) > 0 && Number(amount) < account.balance;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        unitId: account.unit.id,
        category: account.category,
        payerName,
        amount: Number(amount),
        currency: account.currency,
        date,
        method,
        reference,
        notes: notes || `${account.category} settlement recorded from the Notifications Hub.`,
        // Actioning an alert here means the money has been taken, so the receipt
        // is issued now and the alert clears from here and the dashboard at once.
        receivedNow: true,
        confirmAlreadySettled,
        confirmDuplicate
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === POSSIBLE_DUPLICATE) {
        setDuplicateNote(err.message);
        setError('');
      } else if (err instanceof ApiError && err.code === ALREADY_SETTLED) {
        setAlreadySettled(err.message);
        setError('');
      } else {
        setError(errorMessage(err, 'Could not record the payment.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Receive ${account.category.toLowerCase()} payment`}
      subtitle={`${getUnitDisplayName(account.unit.number)}, balance ${formatMoneyLong(account.balance, account.currency)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Issuing receipt…" form="vds-settle-account" className="flex-1">
            Record and issue receipt
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-settle-account" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <AlreadySettledNote message={alreadySettled} confirmed={confirmAlreadySettled} onConfirm={setConfirmAlreadySettled} />
        <DuplicateEntryNote message={duplicateNote} confirmed={confirmDuplicate} onConfirm={setConfirmDuplicate} />

        <InfoNote>
          Unpaid months on this account:{' '}
          {account.unpaidCharges.map(c => formatMonthLabel(c.periodMonth)).join(', ') || 'none'}. Payments are applied to
          the oldest month first.
        </InfoNote>

        <Field label="Payer name" htmlFor="sa-payer" required>
          <input id="sa-payer" type="text" value={payerName} onChange={e => setPayerName(e.target.value)} required className={inputClass} />
        </Field>

        <Field
          label={`Amount received (${account.currency})`}
          htmlFor="sa-amount"
          required
          hint={partial ? 'This is a part payment, the remainder stays on the account.' : undefined}
        >
          <input id="sa-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required className={monoInputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Method" htmlFor="sa-method" required>
            <select id="sa-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date received" htmlFor="sa-date" required>
            <input id="sa-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <Field label="Reference" htmlFor="sa-ref">
          <input id="sa-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
        </Field>

        <Field label="Notes" htmlFor="sa-notes">
          <textarea id="sa-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>

        <p className="font-mono text-[10px] text-slate-400">Receipt will be issued in the name of {staffName}.</p>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function SettleUtilityModal({
  utility,
  units,
  onClose,
  onSubmit
}: {
  utility: UtilityReading;
  units: Unit[];
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const unit = units.find(u => u.id === utility.unitId);
  const [payerName, setPayerName] = useState(unit?.tenantName || unit?.ownerName || '');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>('Cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ payerName, date, method, reference, notes });
    } catch (err) {
      setError(errorMessage(err, 'Could not settle the utility bill.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Settle utility bill"
      subtitle={`${getUnitDisplayName(utility.unitNumber)}, ${formatMonthLabel(utility.billingPeriod)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Settling…" form="vds-settle-utility" className="flex-1">
            Settle and issue receipt
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-settle-utility" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <dl className="space-y-1 rounded-xl bg-slate-50 p-3 font-mono text-[11px]">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Meter</dt>
            <dd className="font-semibold">{utility.meterNumber}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Readings</dt>
            <dd className="font-semibold">
              {utility.previousReading.toLocaleString()} → {utility.currentReading.toLocaleString()}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Consumption</dt>
            <dd className="font-semibold">{utility.consumption.toLocaleString()} units</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Amount</dt>
            <dd className="font-semibold">{formatMoneyLong(utility.amountCharged, utility.currency)}</dd>
          </div>
        </dl>

        <InfoNote>
          Settling raises a receipt in the payments ledger for the billed amount, so the money appears on the dashboard
          and in reports. Voiding that receipt reopens this bill.
        </InfoNote>

        <Field label="Payer name" htmlFor="su-payer" required>
          <input id="su-payer" type="text" value={payerName} onChange={e => setPayerName(e.target.value)} required className={inputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Method" htmlFor="su-method" required>
            <select id="su-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date received" htmlFor="su-date" required>
            <input id="su-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <Field label="Reference" htmlFor="su-ref">
          <input id="su-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
        </Field>

        <Field label="Notes" htmlFor="su-notes">
          <textarea id="su-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function SettleExpenseModal({
  expense,
  onClose,
  onSubmit
}: {
  expense: Expense;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const [datePaid, setDatePaid] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>(expense.paymentMethod || 'Bank Transfer');
  const [reference, setReference] = useState(expense.reference || '');
  const [notes, setNotes] = useState(expense.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        category: expense.category,
        vendor: expense.vendor,
        description: expense.description,
        unitId: expense.unitId || undefined,
        unitNumber: expense.unitNumber,
        amount: expense.amount,
        currency: expense.currency,
        date: expense.date,
        dueDate: expense.dueDate,
        status: 'paid',
        datePaid,
        paymentMethod: method,
        reference,
        notes
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not record the expense as paid.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Record expense as paid"
      subtitle={`${expense.vendor}, ${formatMoneyLong(expense.amount, expense.currency)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-settle-expense" className="flex-1">
            Record as paid
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-settle-expense" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date paid" htmlFor="se-date" required>
            <input id="se-date" type="date" value={datePaid} max={today()} onChange={e => setDatePaid(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Method" htmlFor="se-method" required>
            <select id="se-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Reference" htmlFor="se-ref" hint="Cheque number, bank reference or voucher number.">
          <input id="se-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
        </Field>

        <Field label="Notes" htmlFor="se-notes">
          <textarea id="se-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}
