/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useRemembered } from '../lib/screenState';
import {
  Booking,
  Tenancy,
  CURRENCIES,
  Charge,
  ChargeCategory,
  Currency,
  PAYMENT_CATEGORIES,
  PAYMENT_METHODS,
  Payment,
  PaymentCategory,
  PaymentMethod,
  ONE_OFF_CHARGE_TYPES,
  OneOffChargeType,
  SessionUser,
  UNIT_STATUS_LABELS,
  Unit,
  getUnitDisplayName
} from '../types';
import {
  ACCOUNT_STATUS_LABEL,
  AccountBalance,
  accountBalance,
  chargeAmount,
  chargeBreakdownNote,
  chargeCurrency,
  maintenanceReceiptsToMove,
  rentChargesToRestate,
  chargesForUnit,
  currencyMismatchWarnings,
  isBillable,
  paymentsForUnit
} from '../lib/finance';
import { formatMoney, formatMoneyLong, round2 } from '../lib/money';
import { currentMonth, formatDayLabel, formatMonthLabel, today } from '../lib/dates';
import { ALREADY_SETTLED, POSSIBLE_DUPLICATE, ApiError, CURRENCY_CHANGE, errorMessage } from '../lib/api';
import { openMailDraft } from '../lib/email';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import BookingDeposits from './BookingDeposits';
import {
  AlreadySettledNote,
  DuplicateEntryNote,
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  Modal,
  PermissionNote,
  SecondaryButton,
  SubmitButton,
  SuccessNote,
  TableScroller,
  inputClass,
  monoInputClass,
  tableHeadRowClass
} from './ui';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle,
  Clock,
  Edit,
  FilePlus,
  FileText,
  Mail,
  Plus,
  Printer,
  RotateCcw,
  Search,
  ShieldAlert,
  Undo2
} from 'lucide-react';

interface FinanceHubProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  /** Needed to spot a deposit that is on the ledger twice. See `BookingDeposits`. */
  bookings: Booking[];
  /** Needed to tell whose money a maintenance receipt was: the tenant's or the owner's. */
  tenancies: Tenancy[];
  session: SessionUser;
  onRecordPayment: (payload: Record<string, unknown>) => Promise<Payment>;
  onConfirmPayment: (paymentId: string, fields?: Record<string, unknown>) => Promise<Payment>;
  onReversePayment: (paymentId: string, reason: string) => Promise<unknown>;
  onRefundPayment: (paymentId: string, fields: Record<string, unknown>) => Promise<unknown>;
  onUpdatePayment: (paymentId: string, fields: Record<string, unknown>) => Promise<unknown>;
  onPostMonth: (month: string) => Promise<{ message: string }>;
  /** Voids and re-raises old whole-rent charges at rent + maintenance. */
  onRestateRent?: () => Promise<{ restated: number }>;
  /** Moves a let villa's separately keyed maintenance receipts into its rent. */
  onRestateMaintenanceReceipts?: () => Promise<{ moved: number }>;
  onVoidCharge: (chargeId: string, reason: string) => Promise<unknown>;
  onAddCharge: (payload: Record<string, unknown>) => Promise<unknown>;
  onOpenReceipt: (payment: Payment) => void;
}

const PAGE_SIZE = 25;

export default function FinanceHub({
  units,
  charges,
  payments,
  bookings,
  tenancies,
  session,
  onRecordPayment,
  onConfirmPayment,
  onReversePayment,
  onRefundPayment,
  onUpdatePayment,
  onPostMonth,
  onRestateRent,
  onRestateMaintenanceReceipts,
  onVoidCharge,
  onAddCharge,
  onOpenReceipt
}: FinanceHubProps) {
  const [tab, setTab] = useRemembered<'tenants' | 'owners' | 'transactions'>('finance.tab', 'tenants');
  const [asOf, setAsOf] = useState(today());
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const perms = session.permissions;

  /* ---------------- account rows ---------------- */

  const rentAccounts = useMemo(
    () =>
      units
        .filter(u => isBillable(u, 'Rent') || charges.some(c => c.unitId === u.id && c.category === 'Rent'))
        .map(u => accountBalance(u, 'Rent', charges, payments, asOf, units)),
    [units, charges, payments, asOf]
  );

  const maintAccounts = useMemo(
    () =>
      units
        .filter(u => isBillable(u, 'Maintenance') || charges.some(c => c.unitId === u.id && c.category === 'Maintenance'))
        .map(u => accountBalance(u, 'Maintenance', charges, payments, asOf, units)),
    [units, charges, payments, asOf]
  );

  const mismatches = useMemo(() => currencyMismatchWarnings(units, charges, payments), [units, charges, payments]);

  /* ---------------- restate old rent charges ---------------- */

  const restatable = useMemo(() => rentChargesToRestate(units, charges), [units, charges]);
  const movableReceipts = useMemo(() => maintenanceReceiptsToMove(units, charges, payments, tenancies), [units, charges, payments, tenancies]);
  const handleMoveReceipts = async () => {
    if (!onRestateMaintenanceReceipts) return;
    const list = movableReceipts.move;
    // The payer is shown because a receipt keyed against the owner rather than the
    // tenant is the one case the rules cannot tell apart, and only Ro can.
    const lines = list
      .map(m => `${m.unit.number}  ${m.payment.date}  ${formatMoney(m.payment.amount, m.payment.currency)}  receipt ${m.payment.receiptNo || '-'}  from ${m.payment.payerName || '-'}`)
      .join('\n');
    if (!window.confirm(`Move ${list.length} maintenance receipt(s) into the tenants' rent?\n\n${lines}\n\nEach keeps its number, date and amount.`)) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const r = await onRestateMaintenanceReceipts();
      setSuccess(`Moved ${r.moved} receipt(s) into the tenants' rent.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not move the receipts.'));
    } finally {
      setBusy(false);
    }
  };
  const handleRestate = async () => {
    if (!onRestateRent) return;
    const n = restatable.restate.length;
    if (!window.confirm(`Restate ${n} rent charge(s) to rent plus maintenance? Each old charge is voided (kept on record) and replaced.`)) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const r = await onRestateRent();
      setSuccess(`Restated ${r.restated} rent charge(s) to rent plus maintenance.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not restate the rent charges.'));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- post month ---------------- */

  const [postMonth, setPostMonth] = useState(currentMonth());

  const handlePostMonth = async (month = postMonth) => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await onPostMonth(month);
      setSuccess(result.message);
    } catch (err) {
      setError(errorMessage(err, 'Could not post the monthly charges.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * What the one-click "post this month" would raise, and whether it's already
   * been done. The units rarely change, so the same rents and maintenance fees
   * recur every month — staff post them in one click rather than re-entering each.
   */
  const thisMonth = currentMonth();
  const monthCharges = useMemo(() => {
    const rentUnits = units.filter(u => isBillable(u, 'Rent'));
    const maintUnits = units.filter(u => isBillable(u, 'Maintenance'));
    const rentPosted = rentUnits.filter(u =>
      charges.some(c => c.unitId === u.id && c.category === 'Rent' && c.periodMonth === thisMonth && c.status === 'open')
    ).length;
    const maintPosted = maintUnits.filter(u =>
      charges.some(c => c.unitId === u.id && c.category === 'Maintenance' && c.periodMonth === thisMonth && c.status === 'open')
    ).length;
    const totalToPost = rentUnits.length + maintUnits.length;
    const alreadyPosted = rentPosted + maintPosted;
    return {
      rentCount: rentUnits.length,
      maintCount: maintUnits.length,
      fullyPosted: totalToPost > 0 && alreadyPosted >= totalToPost,
      anyToPost: totalToPost > alreadyPosted
    };
  }, [units, charges, thisMonth]);

  /* ---------------- record payment ---------------- */

  const [addingCharge, setAddingCharge] = useState(false);
  const [payTarget, setPayTarget] = useState<{ unit: Unit; category: PaymentCategory; amount: number; currency: Currency; receivedNow: boolean } | null>(null);

  const openPaymentFor = (account: AccountBalance) => {
    setPayTarget({
      unit: account.unit,
      category: account.category,
      amount: Math.max(0, account.balance),
      currency: account.currency,
      // The row's button says "Receive payment" — the money is being taken now.
      receivedNow: true
    });
  };

  /* ---------------- receipts ledger ---------------- */

  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<'all' | PaymentCategory>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'completed' | 'reversed'>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(0);

  const filteredPayments = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return payments
      .filter(p => !p.derived)
      .filter(p => {
        if (filterCategory !== 'all' && p.category !== filterCategory) return false;
        if (filterStatus !== 'all' && p.status !== filterStatus) return false;
        if (fromDate && p.date < fromDate) return false;
        if (toDate && p.date > toDate) return false;
        if (!needle) return true;
        return (
          p.receiptNo.toLowerCase().includes(needle) ||
          p.payerName.toLowerCase().includes(needle) ||
          p.unitNumber.toLowerCase().includes(needle) ||
          (p.reference || '').toLowerCase().includes(needle) ||
          (p.notes || '').toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.receiptNo.localeCompare(a.receiptNo));
  }, [payments, search, filterCategory, filterStatus, fromDate, toDate]);

  const pageCount = Math.max(1, Math.ceil(filteredPayments.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filteredPayments.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  /* ---------------- modals ---------------- */

  const [reversalTarget, setReversalTarget] = useState<Payment | null>(null);
  const [refundTarget, setRefundTarget] = useState<Payment | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Payment | null>(null);
  const [detailTarget, setDetailTarget] = useState<Payment | null>(null);
  const [chargesTarget, setChargesTarget] = useState<AccountBalance | null>(null);
  const [statementTarget, setStatementTarget] = useState<AccountBalance | null>(null);

  const canReverse = !!perms.reversePayments;
  const canModifySettled = !!perms.modifySettledRecords;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl font-medium text-slate-900">Tenant &amp; HOA Financial Ledger</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Balances are billed charges minus receipted payments, so unpaid months carry forward.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Balances as at" htmlFor="vds-asof">
            <input id="vds-asof" type="date" value={asOf} max={today()} onChange={e => setAsOf(e.target.value || today())} className={monoInputClass} />
          </Field>
          {perms.postCharges && (
            <SecondaryButton onClick={() => setAddingCharge(true)} disabled={units.length === 0} className="flex items-center gap-1.5">
              <FilePlus className="h-4 w-4" />
              Bill a one-off
            </SecondaryButton>
          )}
          {perms.recordPayments && (
            <button
              onClick={() => setPayTarget({ unit: units[0], category: 'Rent', amount: 0, currency: units[0]?.currency || 'JMD', receivedNow: false })}
              disabled={units.length === 0}
              className="flex items-center gap-1.5 rounded-xl bg-teal-600 px-4 py-2.5 text-xs font-medium text-white shadow-xs transition-all hover:bg-teal-700 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              Record payment
            </button>
          )}
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}

      {perms.postCharges && monthCharges.anyToPost && (
        <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border-2 border-amber-200 bg-amber-50 p-5 shadow-xs sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-amber-900">
                {formatMonthLabel(thisMonth)} charges are not fully posted yet
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
                Post them in one click to bill every unit at once, rent for {monthCharges.rentCount} long-term lease
                {monthCharges.rentCount === 1 ? '' : 's'} and maintenance for {monthCharges.maintCount} owner
                {monthCharges.maintCount === 1 ? '' : 's'}. You do not re-enter these each month; posting is safe to run
                again and never double-bills.
              </p>
            </div>
          </div>
          <SubmitButton
            type="button"
            busy={busy}
            busyLabel="Posting…"
            onClick={() => {
              setPostMonth(thisMonth);
              void handlePostMonth(thisMonth);
            }}
            className="shrink-0"
          >
            <CalendarClock className="h-4 w-4" />
            Post {formatMonthLabel(thisMonth)} charges
          </SubmitButton>
        </div>
      )}

      {perms.postCharges && monthCharges.fullyPosted && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-100 bg-emerald-50/60 px-4 py-2.5 text-xs text-emerald-800">
          <CheckCircle className="h-4 w-4 text-emerald-600" />
          {formatMonthLabel(thisMonth)} charges are posted, every unit is billed. Record payments as they come in.
        </div>
      )}

      {mismatches.length > 0 && (
        <InfoNote tone="amber">
          <strong>{mismatches.length} account(s) hold payments in a different currency to the amount billed.</strong>{' '}
          Those receipts are shown in the ledger but are deliberately not netted off the balance, because USD and JMD are
          never combined. Correct them from the receipt record:{' '}
          {mismatches
            .slice(0, 4)
            .map(m => `${getUnitDisplayName(m.unit.number)} ${m.category.toLowerCase()}`)
            .join(', ')}
          {mismatches.length > 4 ? ` and ${mismatches.length - 4} more` : ''}.
        </InfoNote>
      )}

      <div className="flex flex-col gap-3 border-b border-slate-200 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex gap-4">
          {([
            ['tenants', 'Tenant rent'],
            ['owners', 'Owner maintenance'],
            ['transactions', 'Receipts ledger']
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
                setError('');
                setSuccess('');
              }}
              className={`border-b-2 pb-3 text-xs font-medium transition-all ${
                tab === key ? 'border-teal-600 font-semibold text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {perms.postCharges ? (
          <div className="flex items-end gap-2 pb-2">
            <Field label="Post charges for" htmlFor="vds-postmonth">
              <input
                id="vds-postmonth"
                type="month"
                value={postMonth}
                max={currentMonth()}
                onChange={e => setPostMonth(e.target.value)}
                className="rounded-lg border border-slate-200 p-1.5 font-mono text-[11px]"
              />
            </Field>
            <SubmitButton type="button" busy={busy} busyLabel="Posting…" onClick={() => void handlePostMonth()} className="px-3 py-2 text-[11px]">
              <CalendarClock className="h-3.5 w-3.5" />
              Post month
            </SubmitButton>
          </div>
        ) : (
          <div className="pb-3">
            <PermissionNote>Posting monthly charges requires additional permission.</PermissionNote>
          </div>
        )}
      </div>

      {tab === 'tenants' && perms.postCharges && onRestateRent && restatable.restate.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
          <span>
            {restatable.restate.length} rent charge(s) were raised at the old rent, before the maintenance was counted as part of it. The tenant pays the agreed rent.
            {restatable.skipped.length > 0 ? ` ${restatable.skipped.length} billed at another figure are left as they are.` : ''}
          </span>
          <SubmitButton type="button" busy={busy} busyLabel="Restating…" onClick={() => void handleRestate()} className="px-3 py-2 text-[11px]">
            Restate to rent + maintenance
          </SubmitButton>
        </div>
      )}

      {tab === 'tenants' && perms.postCharges && onRestateMaintenanceReceipts && restatable.restate.length === 0 && movableReceipts.move.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
          <span>
            {movableReceipts.move.length} maintenance receipt(s) on let villas were keyed separately from the rent. The tenant pays one rent figure, so they belong in the rent account.
            {movableReceipts.skipped.length > 0 ? ` ${movableReceipts.skipped.length} other maintenance receipt(s) on let villas are left as they are.` : ''}
          </span>
          <SubmitButton type="button" busy={busy} busyLabel="Moving…" onClick={() => void handleMoveReceipts()} className="px-3 py-2 text-[11px]">
            Move receipts into rent
          </SubmitButton>
        </div>
      )}

      {tab === 'tenants' && (
        <AccountTable
          accounts={rentAccounts}
          category="Rent"
          asOf={asOf}
          nameOf={u => u.tenantName || '- no tenant on record -'}
          contactOf={u => u.tenantEmail}
          payments={payments}
          onReceive={openPaymentFor}
          onViewCharges={setChargesTarget}
          onPrintStatement={setStatementTarget}
          generatedBy={session.name}
        />
      )}

      {tab === 'owners' && (
        <AccountTable
          accounts={maintAccounts}
          category="Maintenance"
          asOf={asOf}
          nameOf={u => u.ownerName}
          contactOf={u => u.ownerEmail}
          payments={payments}
          onReceive={openPaymentFor}
          onViewCharges={setChargesTarget}
          onPrintStatement={setStatementTarget}
          generatedBy={session.name}
        />
      )}

      {tab === 'transactions' && (
        <div className="space-y-4">
          {/*
            Above the filters on purpose: it is a decision waiting, not a record to
            look up, and it renders nothing at all when there is nothing to decide.
          */}
          <BookingDeposits
            bookings={bookings}
            payments={payments}
            session={session}
            onConfirmPayment={onConfirmPayment}
            onReversePayment={onReversePayment}
          />

          <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-xs sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Search" htmlFor="vds-search">
              <div className="relative">
                <Search className="absolute left-3 top-3 h-3.5 w-3.5 text-slate-400" />
                <input
                  id="vds-search"
                  type="search"
                  value={search}
                  onChange={e => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  placeholder="Receipt no, payer, unit, reference"
                  className={`${inputClass} pl-8`}
                />
              </div>
            </Field>
            <Field label="Category" htmlFor="vds-cat">
              <select
                id="vds-cat"
                value={filterCategory}
                onChange={e => {
                  setFilterCategory(e.target.value as 'all' | PaymentCategory);
                  setPage(0);
                }}
                className={inputClass}
              >
                <option value="all">All categories</option>
                {PAYMENT_CATEGORIES.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status" htmlFor="vds-status">
              <select
                id="vds-status"
                value={filterStatus}
                onChange={e => {
                  setFilterStatus(e.target.value as 'all' | 'pending' | 'completed' | 'reversed');
                  setPage(0);
                }}
                className={inputClass}
              >
                <option value="all">All statuses</option>
                <option value="pending">Awaiting confirmation</option>
                <option value="completed">Received only</option>
                <option value="reversed">Voided only</option>
              </select>
            </Field>
            <Field label="From date" htmlFor="vds-from">
              <input id="vds-from" type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(0); }} className={monoInputClass} />
            </Field>
            <Field label="To date" htmlFor="vds-to">
              <input id="vds-to" type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(0); }} className={monoInputClass} />
            </Field>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 p-4 text-xs">
              <span className="font-mono text-slate-500">
                {filteredPayments.length} receipt{filteredPayments.length === 1 ? '' : 's'}
                {(search || filterCategory !== 'all' || filterStatus !== 'all' || fromDate || toDate) && ' matching the current filters'}
              </span>
              {(search || filterCategory !== 'all' || filterStatus !== 'all' || fromDate || toDate) && (
                <button
                  onClick={() => {
                    setSearch('');
                    setFilterCategory('all');
                    setFilterStatus('all');
                    setFromDate('');
                    setToDate('');
                    setPage(0);
                  }}
                  className="text-[11px] font-medium text-teal-700 underline"
                >
                  Clear filters
                </button>
              )}
            </div>

            {pageRows.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No receipts match these filters"
                  hint="Adjust the search or date range, or record a payment to start the ledger."
                  icon={<FileText className="h-6 w-6" />}
                />
              </div>
            ) : (
              <TableScroller>
                <table className="w-full min-w-[880px] border-collapse text-left text-xs">
                  <thead>
                    <tr className={tableHeadRowClass}>
                      <th scope="col" className="p-4">Receipt no</th>
                      <th scope="col" className="p-4">Payer</th>
                      <th scope="col" className="p-4">Villa</th>
                      <th scope="col" className="p-4">Category</th>
                      <th scope="col" className="p-4 text-right">Amount</th>
                      <th scope="col" className="p-4">Date</th>
                      <th scope="col" className="p-4">Status</th>
                      <th scope="col" className="p-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pageRows.map(p => (
                      <tr key={p.id} className="transition-colors hover:bg-slate-50/60">
                        <td className="p-4 font-mono font-semibold text-slate-700">
                          <button onClick={() => setDetailTarget(p)} className="underline-offset-2 hover:underline">
                            {p.receiptNo || <span className="italic text-slate-400">not yet issued</span>}
                          </button>
                          {(p.printCount || 0) > 1 && (
                            <span
                              className="ml-1 cursor-help text-[9px] text-amber-600"
                              title={`Printed ${p.printCount} times, every copy after the first is marked REPRINT and recorded on the audit trail`}
                            >
                              ×{p.printCount}
                            </span>
                          )}
                        </td>
                        <td className="p-4">
                          <p className="font-medium text-slate-900">{p.payerName}</p>
                          {p.notes && <p className="max-w-xs truncate text-[10px] text-slate-400">{p.notes}</p>}
                        </td>
                        <td className="p-4 font-mono">{p.unitNumber}</td>
                        <td className="p-4">
                          <Badge>{p.category}</Badge>
                        </td>
                        <td className={`p-4 text-right font-mono font-medium ${p.status === 'reversed' ? 'text-slate-400 line-through' : ''}`}>
                          {formatMoney(p.amount, p.currency)}
                          <span className="ml-1 text-[9px] text-slate-400">{p.currency}</span>
                          {/* The gross stays legible — it is what the receipt says — with what
                              went back shown under it rather than silently netted. */}
                          {!!p.refundedAmount && (
                            <p className="text-[9px] font-normal text-amber-700">
                              less {formatMoney(p.refundedAmount, p.currency)} refunded
                            </p>
                          )}
                        </td>
                        <td className="p-4 font-mono text-[11px] text-slate-500">{formatDayLabel(p.date)}</td>
                        <td className="p-4">
                          {p.status === 'completed' && p.refundedAmount ? (
                            // Received *and* refunded is its own state, not a
                            // shade of either. The money came in and went back.
                            <Badge tone="amber">
                              <Undo2 className="h-3 w-3" />
                              {p.refundedAmount >= p.amount ? 'Refunded' : 'Part refunded'}
                            </Badge>
                          ) : p.status === 'completed' ? (
                            <Badge tone="green">
                              <CheckCircle className="h-3 w-3" /> Received
                            </Badge>
                          ) : p.status === 'pending' ? (
                            <Badge tone="amber">
                              <Clock className="h-3 w-3" /> Awaiting funds
                            </Badge>
                          ) : (
                            <Badge tone="red">
                              <RotateCcw className="h-3 w-3" /> Voided
                            </Badge>
                          )}
                        </td>
                        <td className="p-4">
                          <div className="flex justify-end gap-2">
                            {p.status === 'pending' && perms.recordPayments && (
                              <button
                                onClick={() => setConfirmTarget(p)}
                                className="rounded-lg bg-teal-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-teal-700"
                                title="Confirm the money has been received"
                              >
                                Confirm received
                              </button>
                            )}
                            {p.status === 'completed' && (
                              <button
                                onClick={() => onOpenReceipt(p)}
                                className="rounded-lg border border-slate-200 p-1.5 text-slate-500 transition-all hover:bg-slate-50 hover:text-slate-800"
                                title="Print receipt"
                                aria-label={`Print receipt ${p.receiptNo}`}
                              >
                                <Printer className="h-4 w-4" />
                              </button>
                            )}
                            {/* Refund sits beside void, not inside it, because they say
                                opposite things: void means the money never arrived,
                                refund means it did and then went back. */}
                            {p.status === 'completed' && !p.refundedAmount && canReverse && (
                              <button
                                onClick={() => setRefundTarget(p)}
                                className="rounded-lg border border-amber-200 p-1.5 text-amber-700 transition-all hover:bg-amber-50"
                                title="Refund: record money handed back to the payer"
                                aria-label={`Refund receipt ${p.receiptNo}`}
                              >
                                <Undo2 className="h-4 w-4" />
                              </button>
                            )}
                            {p.status !== 'reversed' && !p.refundedAmount && canReverse && (
                              <button
                                onClick={() => setReversalTarget(p)}
                                className="rounded-lg border border-red-200 p-1.5 text-red-600 transition-all hover:bg-red-50"
                                title={p.status === 'pending' ? 'Cancel this expected payment' : 'Void this receipt'}
                                aria-label={p.status === 'pending' ? 'Cancel expected payment' : `Void receipt ${p.receiptNo}`}
                              >
                                <RotateCcw className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}

            {pageCount > 1 && (
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 p-3 text-[11px]">
                <span className="font-mono text-slate-500">
                  Page {safePage + 1} of {pageCount}
                </span>
                <div className="flex gap-2">
                  <SecondaryButton onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="px-3 py-1.5">
                    Previous
                  </SecondaryButton>
                  <SecondaryButton onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} className="px-3 py-1.5">
                    Next
                  </SecondaryButton>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {addingCharge && (
        <OneOffChargeModal
          units={units}
          onClose={() => setAddingCharge(false)}
          onSubmit={async payload => {
            await onAddCharge(payload);
            setSuccess(
              `${payload.oneOffType} of ${formatMoneyLong(Number(payload.amount), payload.currency as Currency)} billed to ` +
                `${getUnitDisplayName(units.find(u => u.id === payload.unitId)?.number || '')}. It is now owed on that account.`
            );
            setAddingCharge(false);
          }}
        />
      )}

      {payTarget && (
        <RecordPaymentModal
          units={units}
          charges={charges}
          initial={payTarget}
          staffName={session.name}
          onClose={() => setPayTarget(null)}
          onSubmit={async payload => {
            const payment = await onRecordPayment(payload);
            setSuccess(
              payment.status === 'completed'
                ? `Receipt ${payment.receiptNo} issued for ${formatMoneyLong(payment.amount, payment.currency)}.`
                : `${formatMoneyLong(payment.amount, payment.currency)} logged as expected from ${payment.payerName}. ` +
                  'It does not affect any balance yet, confirm it as received, in the Receipts ledger, once the money is actually in hand.'
            );
            setPayTarget(null);
          }}
        />
      )}

      {confirmTarget && (
        <ConfirmReceiptModal
          payment={confirmTarget}
          onClose={() => setConfirmTarget(null)}
          onSubmit={async fields => {
            const confirmed = await onConfirmPayment(confirmTarget.id, fields);
            setSuccess(
              `Receipt ${confirmed.receiptNo} issued for ${formatMoneyLong(confirmed.amount, confirmed.currency)}. The balance and the reports now include it.`
            );
            setConfirmTarget(null);
          }}
        />
      )}

      {reversalTarget && (
        <ReversalModal
          payment={reversalTarget}
          onClose={() => setReversalTarget(null)}
          onSubmit={async reason => {
            await onReversePayment(reversalTarget.id, reason);
            setSuccess(`Receipt ${reversalTarget.receiptNo} has been voided. It remains in the ledger and the audit trail.`);
            setReversalTarget(null);
          }}
        />
      )}

      {refundTarget && (
        <RefundModal
          payment={refundTarget}
          onClose={() => setRefundTarget(null)}
          onSubmit={async fields => {
            await onRefundPayment(refundTarget.id, fields);
            setSuccess(
              `Refund recorded against receipt ${refundTarget.receiptNo}. The receipt stays valid; the money is netted off from the refund date.`
            );
            setRefundTarget(null);
          }}
        />
      )}

      {detailTarget && (
        <PaymentDetailModal
          payment={detailTarget}
          units={units}
          canEdit={canModifySettled}
          onClose={() => setDetailTarget(null)}
          onPrint={() => onOpenReceipt(detailTarget)}
          onSave={async fields => {
            await onUpdatePayment(detailTarget.id, fields);
            setSuccess(`Receipt ${detailTarget.receiptNo} corrected. The change is recorded in the audit trail.`);
            setDetailTarget(null);
          }}
        />
      )}

      {chargesTarget && (
        <ChargeHistoryModal
          account={chargesTarget}
          charges={charges}
          canVoid={canModifySettled}
          onClose={() => setChargesTarget(null)}
          onVoid={async (chargeId, reason) => {
            await onVoidCharge(chargeId, reason);
            setSuccess('Charge voided. It no longer counts toward the balance.');
            setChargesTarget(null);
          }}
        />
      )}

      {statementTarget && (
        <AccountStatementDocument
          account={statementTarget}
          charges={charges}
          payments={payments}
          units={units}
          generatedBy={session.name}
          onClose={() => setStatementTarget(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The whole ledger on paper: every account on the screen, the balance of each,
 * and a total for each currency. The two currencies are totalled separately and
 * never added together. It is built from the same account list the screen shows,
 * so the page and the paper cannot disagree.
 */
export function LedgerDocument({
  accounts,
  category,
  asOf,
  payments,
  nameOf,
  generatedBy,
  onClose
}: {
  accounts: AccountBalance[];
  category: ChargeCategory;
  asOf: string;
  payments: Payment[];
  nameOf: (u: Unit) => string;
  generatedBy: string;
  onClose: () => void;
}) {
  const lastPaid = (a: AccountBalance): string => {
    const dates = payments
      .filter(p => p.unitId === a.unit.id && p.category === category && p.status === 'completed' && p.currency === a.currency)
      .map(p => p.date)
      .sort();
    return dates.length ? formatDayLabel(dates[dates.length - 1]) : 'never';
  };
  const currencies = Array.from(new Set(accounts.map(a => a.currency)));
  const title = category === 'Rent' ? 'Tenants rent ledger' : 'HOA maintenance ledger';

  return (
    <PrintPortal title={`${title} as at ${formatDayLabel(asOf)}`} onClose={onClose} maxWidthClass="max-w-5xl">
      <PrintLetterhead documentTitle={title} meta={`As at ${formatDayLabel(asOf)}`} generatedBy={generatedBy} />
      {currencies.map(currency => {
        const rows = accounts.filter(a => a.currency === currency);
        const charged = round2(rows.reduce((t, a) => t + a.charged, 0));
        const paid = round2(rows.reduce((t, a) => t + a.paid, 0));
        const owing = round2(rows.filter(a => a.balance > 0).reduce((t, a) => t + a.balance, 0));
        const credit = round2(rows.filter(a => a.balance < 0).reduce((t, a) => t + Math.abs(a.balance), 0));
        return (
          <section key={currency} className="mb-6">
            <h2 className="mb-2 font-display text-sm font-semibold text-slate-900">
              {currency === 'USD' ? 'United States dollar accounts' : 'Jamaican dollar accounts'}
            </h2>
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="border-b-2 border-slate-400 font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Villa</th>
                  <th className="p-2">{category === 'Rent' ? 'Tenant' : 'Registered owner'}</th>
                  <th className="p-2 text-right">Billed</th>
                  <th className="p-2 text-right">Received</th>
                  <th className="p-2">Last payment</th>
                  <th className="p-2 text-right">Balance</th>
                  <th className="p-2 text-right">Days</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map(a => (
                  <tr key={a.unit.id} className="border-b border-slate-100">
                    <td className="p-2 font-semibold">{getUnitDisplayName(a.unit.number)}</td>
                    <td className="p-2 font-sans">{nameOf(a.unit)}</td>
                    <td className="p-2 text-right">{formatMoney(a.charged, currency)}</td>
                    <td className="p-2 text-right">{formatMoney(a.paid, currency)}</td>
                    <td className="p-2">{lastPaid(a)}</td>
                    <td className="p-2 text-right font-semibold">
                      {a.balance > 0 ? formatMoney(a.balance, currency) : a.balance < 0 ? `${formatMoney(Math.abs(a.balance), currency)} credit` : 'Settled'}
                    </td>
                    <td className="p-2 text-right">{a.balance > 0 && a.oldestUnpaidDays > 0 ? a.oldestUnpaidDays : '-'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-400 font-mono font-bold">
                  <td className="p-2" colSpan={2}>Total ({currency})</td>
                  <td className="p-2 text-right">{formatMoney(charged, currency)}</td>
                  <td className="p-2 text-right">{formatMoney(paid, currency)}</td>
                  <td className="p-2" />
                  <td className="p-2 text-right">{formatMoney(owing, currency)} owing</td>
                  <td className="p-2" />
                </tr>
              </tfoot>
            </table>
            {credit > 0 && <p className="mt-1 text-[10px] text-slate-600">Credit balances held: {formatMoney(credit, currency)}</p>}
          </section>
        );
      })}
      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Reviewed by" />
    </PrintPortal>
  );
}

/* ------------------------------------------------------------------ */

function AccountTable({
  accounts,
  category,
  asOf,
  payments,
  nameOf,
  contactOf,
  onReceive,
  onViewCharges,
  onPrintStatement,
  generatedBy
}: {
  accounts: AccountBalance[];
  category: ChargeCategory;
  asOf: string;
  payments: Payment[];
  nameOf: (u: Unit) => string;
  contactOf: (u: Unit) => string;
  onReceive: (a: AccountBalance) => void;
  onViewCharges: (a: AccountBalance) => void;
  onPrintStatement: (a: AccountBalance) => void;
  generatedBy: string;
}) {
  const [printingLedger, setPrintingLedger] = useState(false);
  // The most recent completed payment date for an account, so the ledger shows
  // when money last came in without opening the full statement.
  const lastPaymentDate = (account: AccountBalance): string | null => {
    const dates = payments
      .filter(p => p.unitId === account.unit.id && p.category === category && p.status === 'completed' && p.currency === account.currency)
      .map(p => p.date)
      .sort();
    return dates.length ? dates[dates.length - 1] : null;
  };
  if (accounts.length === 0) {
    return (
      <EmptyState
        title={`No villas are currently billed for ${category.toLowerCase()}`}
        hint={
          category === 'Rent'
            ? 'Rent is billed for units set to Long-term Lease with a monthly rent above zero.'
            : 'Maintenance is billed for every unit that is not marked Unavailable and has a fee above zero.'
        }
      />
    );
  }

  const noCharges = accounts.every(a => a.charged === 0);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <SecondaryButton onClick={() => setPrintingLedger(true)}>
          <span className="flex items-center gap-1.5">
            <Printer className="h-3.5 w-3.5" /> Print ledger
          </span>
        </SecondaryButton>
      </div>
      {printingLedger && (
        <LedgerDocument
          accounts={accounts}
          category={category}
          asOf={asOf}
          payments={payments}
          nameOf={nameOf}
          generatedBy={generatedBy}
          onClose={() => setPrintingLedger(false)}
        />
      )}
      {noCharges && (
        <InfoNote tone="amber">
          No {category.toLowerCase()} charges have been posted yet, so every balance reads zero. Use{' '}
          <strong>Post month</strong> above to raise the charges for a billing month, that is what makes arrears
          accumulate.
        </InfoNote>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        <TableScroller>
          <table className="w-full min-w-[900px] border-collapse text-left text-xs">
            <thead>
              <tr className={tableHeadRowClass}>
                <th scope="col" className="p-4">Villa</th>
                <th scope="col" className="p-4">{category === 'Rent' ? 'Tenant' : 'Registered owner'}</th>
                <th scope="col" className="p-4 text-right">Monthly fee</th>
                <th scope="col" className="p-4 text-right">Billed to date</th>
                <th scope="col" className="p-4 text-right">Received</th>
                <th scope="col" className="p-4">Last payment</th>
                <th scope="col" className="p-4 text-right">Balance</th>
                <th scope="col" className="p-4">Ageing</th>
                <th scope="col" className="p-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {accounts.map(account => {
                const { unit } = account;
                const monthly = chargeAmount(unit, category);
                const overdue = account.balance > 0;
                return (
                  <tr key={unit.id} className="hover:bg-slate-50/50">
                    <td className="p-4 font-mono font-semibold">{getUnitDisplayName(unit.number)}</td>
                    <td className="p-4">
                      <p className="font-medium text-slate-900">{nameOf(unit)}</p>
                      {contactOf(unit) && <p className="font-mono text-[10px] text-slate-400">{contactOf(unit)}</p>}
                    </td>
                    <td className="p-4 text-right font-mono">{formatMoney(monthly, account.currency)}</td>
                    <td className="p-4 text-right font-mono text-slate-600">
                      <button onClick={() => onViewCharges(account)} className="underline-offset-2 hover:underline" title="View billed charges">
                        {formatMoney(account.charged, account.currency)}
                      </button>
                    </td>
                    <td className="p-4 text-right font-mono text-emerald-600">{formatMoney(account.paid, account.currency)}</td>
                    <td className="p-4 font-mono text-[11px] text-slate-500">
                      {lastPaymentDate(account) ? formatDayLabel(lastPaymentDate(account)!) : <span className="text-slate-300">never</span>}
                    </td>
                    <td className="p-4 text-right">
                      <span
                        title={
                          account.status === 'not-billed'
                            ? `${account.currency} ${monthly} per month is set up for this villa, but no charge has been raised yet. Post the month's charges to bill it.`
                            : undefined
                        }
                        className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-medium ${
                          account.status === 'in-arrears'
                            ? 'bg-red-50 text-red-700'
                            : account.status === 'credit'
                              ? 'bg-sky-50 text-sky-700'
                              : account.status === 'not-billed'
                                ? 'bg-amber-50 text-amber-700'
                                : account.status === 'settled'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : // Nothing is billed here at all (vacant, or the rate is zero).
                                    // Neutral, because green reads as "collected".
                                    'bg-slate-50 text-slate-500'
                        }`}
                      >
                        {account.status === 'in-arrears'
                          ? formatMoney(account.balance, account.currency)
                          : account.status === 'credit'
                            ? `${formatMoney(Math.abs(account.balance), account.currency)} credit`
                            : ACCOUNT_STATUS_LABEL[account.status]}
                      </span>
                    </td>
                    <td className="p-4">
                      {overdue && account.oldestUnpaidDays > 0 ? (
                        <Badge tone={account.oldestUnpaidDays > 60 ? 'red' : account.oldestUnpaidDays > 30 ? 'amber' : 'slate'}>
                          {account.oldestUnpaidDays} days
                        </Badge>
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                    </td>
                    <td className="p-4">
                      {/* Two fixed slots so the Statement button and the status/receive-payment
                          control line up in the same column on every row, regardless of which
                          state a row is in. */}
                      <div className="flex items-center justify-end gap-2">
                        {/*
                          * Reaching the individual charges used to mean knowing that the
                          * "Billed" figure was a button — a plain number with no underline
                          * and only a tooltip to say so. Voiding a charge raised in error
                          * lives behind it, so in practice the correction path could not be
                          * found: it was reported as "there is no void option". It is a
                          * labelled control now, beside Statement.
                          */}
                        <button
                          onClick={() => onViewCharges(account)}
                          title="See every charge billed to this account, and void one raised in error"
                          className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 font-medium text-slate-600 transition-colors hover:bg-slate-50"
                        >
                          <FileText className="h-3.5 w-3.5" /> Charges
                        </button>
                        <button
                          onClick={() => onPrintStatement(account)}
                          title="Print or email an account statement"
                          className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 font-medium text-slate-600 transition-colors hover:bg-slate-50"
                        >
                          <Printer className="h-3.5 w-3.5" /> Statement
                        </button>
                        <div className="flex w-36 shrink-0 justify-end">
                          {overdue ? (
                            <button
                              onClick={() => onReceive(account)}
                              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-center font-medium text-teal-700 transition-colors hover:border-teal-200 hover:text-teal-900"
                            >
                              Receive payment
                            </button>
                          ) : account.status === 'not-billed' ? (
                            <span className="inline-flex items-center gap-1 font-medium text-amber-600" title="Nothing has been billed for this account yet.">
                              <AlertTriangle className="h-3.5 w-3.5" /> Not yet billed
                            </span>
                          ) : account.status === 'settled' ? (
                            <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                              <CheckCircle className="h-3.5 w-3.5" /> Settled
                            </span>
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
        <p className="border-t border-slate-100 bg-slate-50 p-3 font-mono text-[10px] text-slate-400">
          Balances as at {formatDayLabel(asOf)}. Amounts shown in each villa&apos;s own billing currency.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RecordPaymentModal({
  units,
  charges,
  initial,
  staffName,
  onClose,
  onSubmit
}: {
  units: Unit[];
  charges: Charge[];
  initial: { unit: Unit; category: PaymentCategory; amount: number; currency: Currency; receivedNow: boolean };
  staffName: string;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [unitId, setUnitId] = useState(initial.unit?.id || units[0]?.id || '');
  const [category, setCategory] = useState<PaymentCategory>(initial.category);
  const [payerName, setPayerName] = useState('');
  const [amount, setAmount] = useState(initial.amount > 0 ? String(initial.amount) : '');
  const [currency, setCurrency] = useState<Currency>(initial.currency);
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>('Cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [confirmNoCharge, setConfirmNoCharge] = useState(false);
  /**
   * The server refused because the debt had already been settled — usually by
   * somebody else, seconds ago, on another machine. This cannot be predicted from
   * what this browser holds: its copy of the ledger was fetched before the other
   * person saved. So it is revealed by the refusal itself, and the refusal text is
   * kept on screen beside it, because the sensible answer is very often "stop".
   */
  const [alreadySettled, setAlreadySettled] = useState('');
  const [confirmAlreadySettled, setConfirmAlreadySettled] = useState(false);
  const [duplicateNote, setDuplicateNote] = useState('');
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const unit = units.find(u => u.id === unitId);

  // Prefill the payer from the unit register: tenants pay rent, owners pay HOA fees.
  React.useEffect(() => {
    if (!unit) return;
    const expected = category === 'Maintenance' ? unit.ownerName : unit.tenantName || unit.ownerName;
    setPayerName(prev => (prev ? prev : expected || ''));
    if (category === 'Rent' || category === 'Maintenance') {
      setCurrency(chargeCurrency(unit, category as ChargeCategory));
    }
  }, [unitId, category, unit]);

  /**
   * Move off Rent when the villa selected is not rent-billable.
   *
   * An owner-occupied villa has no tenant and is never billed rent, so leaving the
   * category on the default of Rent produced an immediate warning about rent that
   * this villa will never owe. Switching with the villa means the common case —
   * an owner paying their HOA maintenance — is simply correct from the start.
   * Only fires when the villa actually changes, so a deliberate choice stands.
   */
  const lastUnitRef = React.useRef(unitId);
  React.useEffect(() => {
    if (unitId === lastUnitRef.current) return;
    lastUnitRef.current = unitId;
    if (!unit) return;
    if (category === 'Rent' && !isBillable(unit, 'Rent') && isBillable(unit, 'Maintenance')) {
      setCategory('Maintenance');
    }
  }, [unitId, unit, category]);

  const expectedCurrency = unit && (category === 'Rent' || category === 'Maintenance') ? chargeCurrency(unit, category as ChargeCategory) : null;
  const currencyMismatch = !!expectedCurrency && expectedCurrency !== currency;

  const isLedgerCategory = category === 'Rent' || category === 'Maintenance';

  /**
   * This villa is not billed for this category at all — an owner-occupied or
   * vacant villa against Rent, most often. Kept separate from "nothing posted
   * yet" below, because the advice for the two is opposite: telling someone to
   * post the month's charges is useless here, as posting a month would never
   * raise a rent charge for a villa that has no tenant.
   */
  const notBillableForCategory = !!unit && isLedgerCategory && !isBillable(unit, category as ChargeCategory);

  /**
   * Nothing billed on this account yet, so this money would land as a credit on a
   * villa that reads as owing nothing — which is how a payment appears to vanish.
   */
  const noOpenCharge =
    !!unit &&
    isLedgerCategory &&
    !notBillableForCategory &&
    !charges.some(c => c.unitId === unit.id && c.category === category && c.status === 'open' && c.currency === currency);

  const outstandingHint = useMemo(() => {
    if (!unit || (category !== 'Rent' && category !== 'Maintenance')) return null;
    const open = charges.filter(c => c.unitId === unit.id && c.category === category && c.status === 'open');
    if (open.length === 0) return null;
    const months = open.map(c => formatMonthLabel(c.periodMonth));
    return `Billed months on this account: ${months.slice(-4).join(', ')}${months.length > 4 ? ` (+${months.length - 4} earlier)` : ''}.`;
  }, [unit, category, charges]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!unitId) {
      setError('Select the villa this payment relates to.');
      return;
    }
    if (!(Number(amount) > 0)) {
      setError('Enter a payment amount greater than zero.');
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
        receivedNow: initial.receivedNow,
        confirmCurrencyMismatch: confirmMismatch,
        confirmNoOpenCharge: confirmNoCharge,
        confirmAlreadySettled,
        confirmDuplicate
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === POSSIBLE_DUPLICATE) {
        setDuplicateNote(err.message);
        setError('');
      } else if (err instanceof ApiError && err.code === ALREADY_SETTLED) {
        // Not an error to dismiss and retry — a fact about the account that the
        // person now has to make a decision about.
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
      title={initial.receivedNow ? 'Receive payment and issue receipt' : 'Log an expected payment'}
      subtitle={
        initial.receivedNow
          ? `Receipt will be issued in the name of ${staffName}`
          : 'Nothing is received yet, confirm it from the Receipts ledger when the money arrives'
      }
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton
            busy={busy}
            busyLabel={initial.receivedNow ? 'Issuing receipt…' : 'Logging…'}
            form="vds-payment-form"
            className="flex-1"
          >
            {initial.receivedNow ? 'Record and issue receipt' : 'Log as expected'}
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-payment-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <AlreadySettledNote message={alreadySettled} confirmed={confirmAlreadySettled} onConfirm={setConfirmAlreadySettled} />
        <DuplicateEntryNote message={duplicateNote} confirmed={confirmDuplicate} onConfirm={setConfirmDuplicate} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Villa unit" htmlFor="pm-unit" required>
            <select id="pm-unit" value={unitId} onChange={e => setUnitId(e.target.value)} required className={inputClass}>
              <option value="">Select villa</option>
              {units.map(u => (
                <option key={u.id} value={u.id}>
                  {getUnitDisplayName(u.number)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category" htmlFor="pm-cat" required>
            <select id="pm-cat" value={category} onChange={e => setCategory(e.target.value as PaymentCategory)} className={inputClass}>
              {PAYMENT_CATEGORIES.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Payer full name" htmlFor="pm-payer" required>
          <input id="pm-payer" type="text" value={payerName} onChange={e => setPayerName(e.target.value)} required className={inputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" htmlFor="pm-amount" required>
            <input
              id="pm-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              required
              className={monoInputClass}
            />
          </Field>
          <Field label="Currency" htmlFor="pm-currency" required>
            <select id="pm-currency" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={inputClass}>
              <option value="JMD">Jamaican Dollar (JMD)</option>
              <option value="USD">US Dollar (USD)</option>
            </select>
          </Field>
        </div>

        {currencyMismatch && (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <p>
              <strong>{getUnitDisplayName(unit!.number)}</strong> is billed for {category.toLowerCase()} in{' '}
              <strong>{expectedCurrency}</strong>, but this receipt is in <strong>{currency}</strong>. A payment in a
              different currency will not reduce the {expectedCurrency} balance.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmMismatch} onChange={e => setConfirmMismatch(e.target.checked)} className="mt-0.5" />
              <span>Record it in {currency} anyway, I will reconcile the account separately.</span>
            </label>
          </div>
        )}

        {notBillableForCategory && !currencyMismatch && (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <p>
              <strong>{getUnitDisplayName(unit!.number)}</strong> is {UNIT_STATUS_LABELS[unit!.status].toLowerCase()} and is
              not billed for {category.toLowerCase()}.
              {category === 'Rent'
                ? ' Owners pay HOA maintenance rather than rent, switch the category to Maintenance if that is what this money is for.'
                : ' Set a monthly fee on the villa first if it should be billed.'}
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmNoCharge} onChange={e => setConfirmNoCharge(e.target.checked)} className="mt-0.5" />
              <span>Record it as a credit on this account anyway.</span>
            </label>
          </div>
        )}

        {noOpenCharge && !currencyMismatch && (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <p>
              Nothing has been billed to <strong>{getUnitDisplayName(unit!.number)}</strong> for {category.toLowerCase()} yet,
              so this money would sit as a <strong>credit</strong> rather than settling anything. Post the month&apos;s
              charges first and the payment will clear the balance properly.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmNoCharge} onChange={e => setConfirmNoCharge(e.target.checked)} className="mt-0.5" />
              <span>Record it as a credit on the account anyway.</span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Method" htmlFor="pm-method" required>
            <select id="pm-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date received" htmlFor="pm-date" required>
            <input id="pm-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <Field label="Reference" htmlFor="pm-ref" hint="Bank transaction id, cheque number, or similar.">
          <input id="pm-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
        </Field>

        <Field label="Notes" htmlFor="pm-notes">
          <textarea id="pm-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>

        {outstandingHint && <InfoNote>{outstandingHint}</InfoNote>}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Confirm that an expected payment has actually arrived.
 *
 * The date defaults to the date the entry was logged, but is editable: money
 * often lands days after someone wrote it down, and the ledger should record when
 * it *arrived*, not when it was typed. Only at this point is a receipt number
 * issued and the balance moved.
 */
function ConfirmReceiptModal({
  payment,
  onClose,
  onSubmit
}: {
  payment: Payment;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const [date, setDate] = useState(payment.date);
  const [method, setMethod] = useState<PaymentMethod>(payment.method);
  const [reference, setReference] = useState(payment.reference || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ date, method, reference });
    } catch (err) {
      setError(errorMessage(err, 'Could not confirm the payment.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Confirm money received"
      subtitle={`${payment.payerName}: ${formatMoneyLong(payment.amount, payment.currency)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Confirming…" form="vds-confirm-form" className="flex-1">
            Confirm and issue receipt
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-confirm-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <InfoNote tone="amber">
          Only confirm this once the money is genuinely in hand or shown in the account. Confirming issues a receipt
          number, reduces the outstanding balance, and includes the money in the reports.
        </InfoNote>

        <dl className="space-y-1 rounded-xl bg-slate-50 p-3 font-mono text-[11px]">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Villa</dt>
            <dd className="font-semibold">{getUnitDisplayName(payment.unitNumber)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">For</dt>
            <dd className="font-semibold">{payment.category}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Amount</dt>
            <dd className="font-semibold">{formatMoneyLong(payment.amount, payment.currency)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Logged by</dt>
            <dd className="font-semibold">{payment.staffMember}</dd>
          </div>
        </dl>

        <Field label="Date the money was received" htmlFor="cf-date" required hint="Defaults to the date it was logged. Change it if the money landed later.">
          <input id="cf-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Method" htmlFor="cf-method" required>
            <select id="cf-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reference" htmlFor="cf-ref" hint="Bank transaction id, cheque number.">
            <input id="cf-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Record money handed back.
 *
 * Deliberately worded against the mistake it exists to prevent. Staff reached for
 * "void" for this before, because it was the only control there was — and voiding
 * says the money never arrived, which erases the fact that the property once held
 * it. The note here says which instrument this is and what the other one means, at
 * the moment the choice is being made.
 */
function RefundModal({
  payment,
  onClose,
  onSubmit
}: {
  payment: Payment;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(payment.amount));
  const [refundedOn, setRefundedOn] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>(payment.method);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const parsed = Number(amount);
  const partial = parsed > 0 && parsed < payment.amount;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!(parsed > 0)) {
      setError('Enter how much was handed back.');
      return;
    }
    if (parsed > payment.amount) {
      setError(`You cannot refund more than the receipt: ${formatMoneyLong(payment.amount, payment.currency)}.`);
      return;
    }
    if (reason.trim().length < 5) {
      setError('Give a reason of at least 5 characters. It is stored permanently against the receipt.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({ amount: parsed, refundedOn, method, reason: reason.trim() });
    } catch (err) {
      setError(errorMessage(err, 'Could not record the refund.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Refund this payment"
      subtitle={payment.receiptNo}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <button
            type="submit"
            form="vds-refund-form"
            disabled={busy}
            className="flex-1 rounded-xl bg-amber-600 py-2.5 text-xs font-medium text-white transition-all hover:bg-amber-700 disabled:opacity-60"
          >
            {busy ? 'Recording…' : 'Record the refund'}
          </button>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-refund-form" onSubmit={handleSubmit} className="space-y-4 p-6 text-xs">
        {error && <ErrorNote>{error}</ErrorNote>}

        <dl className="space-y-1 rounded-xl bg-slate-50 p-3 font-mono text-[11px]">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Payer</dt>
            <dd className="font-semibold">{payment.payerName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Receipt</dt>
            <dd className="font-semibold">{formatMoneyLong(payment.amount, payment.currency)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Received</dt>
            <dd className="font-semibold">{formatDayLabel(payment.date)}</dd>
          </div>
        </dl>

        <InfoNote tone="amber">
          This records money <strong>going back out</strong>. Receipt {payment.receiptNo} stays valid and printable,
          because the money really was received, it is netted off the balance and the collection figures from the
          refund date. If instead the payment should never have been recorded at all, void it rather than refunding it.
        </InfoNote>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount handed back" htmlFor="rf-amount" required>
            <input
              id="rf-amount"
              type="number"
              step="0.01"
              min="0.01"
              max={payment.amount}
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className={monoInputClass}
            />
          </Field>
          <Field label="Date it went back" htmlFor="rf-date" required hint="The day the money actually left.">
            <input id="rf-date" type="date" value={refundedOn} min={payment.date} onChange={e => setRefundedOn(e.target.value)} className={monoInputClass} />
          </Field>
        </div>

        {partial && (
          <InfoNote>
            A partial refund. {formatMoneyLong(payment.amount - parsed, payment.currency)} of this receipt stays with the
            property.
          </InfoNote>
        )}

        <Field label="How it was returned" htmlFor="rf-method" required>
          <select id="rf-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
            {PAYMENT_METHODS.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Reason for the refund" htmlFor="rf-reason" required hint="Overpayment returned, stay cancelled, paid twice.">
          <textarea
            id="rf-reason"
            rows={3}
            value={reason}
            onChange={e => setReason(e.target.value)}
            className={inputClass}
            placeholder="e.g. Guest cancelled within the free window; deposit returned in full."
          />
        </Field>
      </form>
    </Modal>
  );
}

function ReversalModal({
  payment,
  onClose,
  onSubmit
}: {
  payment: Payment;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 5) {
      setError('Give a reason of at least 5 characters. It is stored permanently against the receipt.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setError(errorMessage(err, 'Could not void the receipt.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Void receipt"
      subtitle={payment.receiptNo}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <button
            type="submit"
            form="vds-reversal-form"
            disabled={busy}
            className="flex-1 rounded-xl bg-red-600 py-2.5 text-xs font-medium text-white transition-all hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? 'Voiding…' : 'Void this receipt'}
          </button>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-reversal-form" onSubmit={handleSubmit} className="space-y-4 p-6 text-xs">
        {error && <ErrorNote>{error}</ErrorNote>}

        <dl className="space-y-1 rounded-xl bg-slate-50 p-3 font-mono text-[11px]">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Payer</dt>
            <dd className="font-semibold">{payment.payerName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Amount</dt>
            <dd className="font-semibold">{formatMoneyLong(payment.amount, payment.currency)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Recorded by</dt>
            <dd className="font-semibold">{payment.staffMember}</dd>
          </div>
        </dl>

        <InfoNote tone="amber">
          Voiding is permanent and cannot be undone. The receipt stays in the ledger marked VOID, and any linked
          reservation deposit or utility settlement is reopened.
        </InfoNote>

        <Field label="Reason for voiding" htmlFor="rv-reason" required>
          <textarea
            id="rv-reason"
            rows={3}
            value={reason}
            onChange={e => setReason(e.target.value)}
            required
            placeholder="e.g. Recorded against the wrong villa, re-entered as REC-2026-0042"
            className={inputClass}
          />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function PaymentDetailModal({
  payment,
  units,
  canEdit,
  onClose,
  onPrint,
  onSave
}: {
  payment: Payment;
  units: Unit[];
  canEdit: boolean;
  onClose: () => void;
  onPrint: () => void;
  onSave: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [payerName, setPayerName] = useState(payment.payerName);
  const [unitId, setUnitId] = useState(payment.unitId);
  const [category, setCategory] = useState<PaymentCategory>(payment.category);
  const [amount, setAmount] = useState(String(payment.amount));
  const [currency, setCurrency] = useState<Currency>(payment.currency);
  const [date, setDate] = useState(payment.date);
  const [method, setMethod] = useState<PaymentMethod>(payment.method);
  const [reference, setReference] = useState(payment.reference || '');
  const [notes, setNotes] = useState(payment.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * The server refuses a currency change once and asks for it again.
   *
   * Held as its own state rather than folded into `error`, because it is not a
   * failure to report — it is a question to answer. `ApiError.code` is what
   * distinguishes the two; matching on the wording would break the first time
   * anyone rephrased it.
   */
  const [currencyWarning, setCurrencyWarning] = useState('');
  const [confirmCurrency, setConfirmCurrency] = useState(false);

  const locked = payment.status === 'reversed' || !!payment.bookingId || !!payment.utilityId;
  const currencyChanged = currency !== payment.currency;
  React.useEffect(() => {
    if (!currencyChanged) {
      setCurrencyWarning('');
      setConfirmCurrency(false);
    }
  }, [currencyChanged]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({
        payerName, unitId, category, amount: Number(amount), currency, date, method, reference, notes,
        ...(confirmCurrency ? { confirmCurrencyChange: true } : {})
      });
    } catch (err) {
      // Do NOT collapse this to errorMessage() alone: that discards the code and
      // the officer is left with a refusal and no way through it.
      if (err instanceof ApiError && err.code === CURRENCY_CHANGE) {
        setCurrencyWarning(err.message);
        setError('');
      } else {
        setError(errorMessage(err, 'Could not save the correction.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Receipt details"
      subtitle={payment.receiptNo}
      onClose={onClose}
      footer={
        editing ? (
          <div className="flex gap-3">
            <SubmitButton busy={busy} busyLabel="Saving…" form="vds-payment-edit" className="flex-1">
              Save correction
            </SubmitButton>
            <SecondaryButton onClick={() => setEditing(false)}>Cancel</SecondaryButton>
          </div>
        ) : (
          <div className="flex gap-3">
            {canEdit && !locked && (
              <SecondaryButton onClick={() => setEditing(true)} className="flex flex-1 items-center justify-center gap-1.5">
                <Edit className="h-4 w-4" /> Correct this record
              </SecondaryButton>
            )}
            <SubmitButton type="button" onClick={onPrint} className="flex-1">
              <Printer className="h-4 w-4" /> Print receipt
            </SubmitButton>
          </div>
        )
      }
    >
      {!editing ? (
        <div className="space-y-4 p-6 text-xs">
          {payment.status === 'reversed' && (
            <ErrorNote>
              <strong>Voided</strong> by {payment.reversedBy} on {formatDayLabel(payment.reversalDate || '')}, “
              {payment.reversalReason}”
            </ErrorNote>
          )}
          {locked && payment.status !== 'reversed' && (
            <InfoNote>
              {payment.bookingId
                ? 'This receipt is generated from a reservation deposit. Edit the reservation and the receipt follows automatically.'
                : 'This receipt was generated when a utility bill was settled. Void it to reopen that bill.'}
            </InfoNote>
          )}

          <dl className="grid grid-cols-2 gap-4">
            {[
              ['Payer', payment.payerName],
              ['Villa', payment.unitNumber],
              ['Category', payment.category],
              ['Amount', formatMoneyLong(payment.amount, payment.currency)],
              ['Date received', formatDayLabel(payment.date)],
              ['Method', payment.method],
              ['Reference', payment.reference || '-'],
              ['Recorded by', payment.staffMember]
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="block font-mono text-[10px] uppercase text-slate-400">{label}</dt>
                <dd className="font-semibold text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>

          <div>
            <span className="block font-mono text-[10px] uppercase text-slate-400">Notes</span>
            <p className="mt-1 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 italic leading-relaxed text-slate-700">
              {payment.notes || 'No notes recorded.'}
            </p>
          </div>

          {(payment.printCount || 0) > 0 && (
            <p className="font-mono text-[10px] text-slate-400">
              Printed {payment.printCount} time{payment.printCount === 1 ? '' : 's'}. Copies after the first are marked as reprints.
            </p>
          )}

          {!canEdit && !locked && (
            <PermissionNote>
              Correcting a settled record requires the &ldquo;modify settled records&rdquo; permission. Ask an
              Administrator or Manager.
            </PermissionNote>
          )}
        </div>
      ) : (
        <form id="vds-payment-edit" onSubmit={handleSubmit} className="space-y-4 p-6 text-xs">
          {error && <ErrorNote>{error}</ErrorNote>}

          {/*
            A refused currency change. Red rather than amber, and it leads with what
            did NOT happen: a form that comes back with a message reads as "saved,
            with a note", and nothing has been saved here. The acknowledgement is
            deliberately narrow — it claims the money really was that currency, not
            that the warning is a nuisance.
          */}
          {currencyWarning && (
            <div role="alert" className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-red-900">
              <p className="font-semibold">This correction has not been saved.</p>
              <p className="leading-relaxed">{currencyWarning}</p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmCurrency}
                  onChange={e => setConfirmCurrency(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  The money really was received in {currency}. Move this receipt onto the {currency} account without
                  converting the figure.
                </span>
              </label>
            </div>
          )}

          <InfoNote tone="amber">
            Corrections are recorded in the audit trail with the previous and new values. The receipt number and its
            void status cannot be changed here, void the receipt and re-enter it if the payment itself was wrong.
          </InfoNote>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Payer name" htmlFor="pe-payer" required>
              <input id="pe-payer" type="text" value={payerName} onChange={e => setPayerName(e.target.value)} required className={inputClass} />
            </Field>
            <Field label="Villa" htmlFor="pe-unit" required>
              <select id="pe-unit" value={unitId} onChange={e => setUnitId(e.target.value)} required className={inputClass}>
                {units.map(u => (
                  <option key={u.id} value={u.id}>
                    {getUnitDisplayName(u.number)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" htmlFor="pe-cat" required>
              <select id="pe-cat" value={category} onChange={e => setCategory(e.target.value as PaymentCategory)} className={inputClass}>
                {PAYMENT_CATEGORIES.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount" htmlFor="pe-amount" required>
              <input id="pe-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required className={monoInputClass} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Currency"
              htmlFor="pe-cur"
              required
              // Said at the field, not only after the refusal: the point is to stop
              // an accidental change, and by then it has already been made.
              hint={currencyChanged ? 'The figure is not converted, it moves to the other account as it stands.' : undefined}
            >
              <select
                id="pe-cur"
                value={currency}
                onChange={e => setCurrency(e.target.value as Currency)}
                className={`${inputClass} ${currencyChanged ? 'border-red-300 bg-red-50' : ''}`}
              >
                <option value="JMD">JMD (J$)</option>
                <option value="USD">USD ($)</option>
              </select>
            </Field>
            <Field label="Method" htmlFor="pe-method" required>
              <select id="pe-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
                {PAYMENT_METHODS.map(m => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date received" htmlFor="pe-date" required>
              <input id="pe-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
            </Field>
            <Field label="Reference" htmlFor="pe-ref">
              <input id="pe-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
            </Field>
          </div>

          <Field label="Notes" htmlFor="pe-notes">
            <textarea id="pe-notes" rows={3} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
          </Field>
        </form>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function ChargeHistoryModal({
  account,
  charges,
  canVoid,
  onClose,
  onVoid
}: {
  account: AccountBalance;
  charges: Charge[];
  canVoid: boolean;
  onClose: () => void;
  onVoid: (chargeId: string, reason: string) => Promise<void>;
}) {
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = charges
    .filter(c => c.unitId === account.unit.id && c.category === account.category)
    .sort((a, b) => b.dueDate.localeCompare(a.dueDate));

  const handleVoid = async (chargeId: string) => {
    if (reason.trim().length < 5) {
      setError('Give a reason of at least 5 characters.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onVoid(chargeId, reason.trim());
    } catch (err) {
      setError(errorMessage(err, 'Could not void the charge.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${account.category} charges: ${getUnitDisplayName(account.unit.number)}`}
      subtitle={`Balance ${formatMoneyLong(account.balance, account.currency)}`}
      onClose={onClose}
      maxWidthClass="max-w-2xl"
    >
      <div className="space-y-4 p-6 text-xs">
        {error && <ErrorNote>{error}</ErrorNote>}

        {/*
          * Say why the Void column is absent rather than simply omitting it. A
          * charge raised in error is corrected here and nowhere else, so someone
          * without the permission needs to know who to ask — not to conclude the
          * application cannot do it.
          */}
        {!canVoid && rows.length > 0 && (
          <p className="rounded-lg bg-slate-50 p-3 text-[11px] text-slate-500">
            A charge raised in error is cancelled by voiding it, which needs the permission to
            correct settled records. Ask an Administrator or Manager. Nothing is deleted, a
            voided charge stays on the record with the reason and who voided it.
          </p>
        )}

        {rows.length === 0 ? (
          <EmptyState title="No charges have been posted for this account yet" />
        ) : (
          <TableScroller>
            <table className="w-full min-w-[520px] border-collapse text-left">
              <thead>
                <tr className={tableHeadRowClass}>
                  <th scope="col" className="p-2">Period</th>
                  <th scope="col" className="p-2">Due</th>
                  <th scope="col" className="p-2 text-right">Amount</th>
                  <th scope="col" className="p-2">Status</th>
                  {canVoid && <th scope="col" className="p-2 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(charge => (
                  <React.Fragment key={charge.id}>
                    <tr>
                      <td className="p-2 font-medium">
                        {formatMonthLabel(charge.periodMonth)}
                        {charge.description && (
                          <span className="mt-0.5 block text-[10px] font-normal text-slate-500">{charge.description}</span>
                        )}
                        {chargeBreakdownNote(charge) && (
                          <span className="mt-0.5 block text-[10px] font-normal text-slate-500">{chargeBreakdownNote(charge)}</span>
                        )}
                      </td>
                      <td className="p-2 font-mono text-slate-500">{formatDayLabel(charge.dueDate)}</td>
                      <td className={`p-2 text-right font-mono ${charge.status === 'void' ? 'text-slate-400 line-through' : ''}`}>
                        {formatMoney(charge.amount, charge.currency)}
                      </td>
                      <td className="p-2">
                        {charge.status === 'open' ? <Badge tone="slate">Billed</Badge> : <Badge tone="red">Voided</Badge>}
                      </td>
                      {canVoid && (
                        <td className="p-2 text-right">
                          {charge.status === 'open' && (
                            <button onClick={() => { setVoidingId(voidingId === charge.id ? null : charge.id); setReason(''); }} className="text-[11px] font-medium text-red-600 underline">
                              Void
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                    {voidingId === charge.id && (
                      <tr>
                        <td colSpan={5} className="bg-slate-50 p-3">
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                              type="text"
                              value={reason}
                              onChange={e => setReason(e.target.value)}
                              placeholder="Reason this charge should not have been raised"
                              className={`${inputClass} flex-1`}
                            />
                            <SubmitButton busy={busy} type="button" onClick={() => void handleVoid(charge.id)} className="bg-red-600 hover:bg-red-700">
                              Confirm void
                            </SubmitButton>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}

        {account.mismatchedCurrencyPayments.length > 0 && (
          <InfoNote tone="amber">
            <strong>Not included in this balance:</strong>{' '}
            {account.mismatchedCurrencyPayments.map(p => `${p.receiptNo} (${formatMoneyLong(p.amount, p.currency)})`).join(', ')} -
            recorded in a different currency to the {account.currency} billed on this account.
          </InfoNote>
        )}

        {/*
          The other half of the same fault, and the half that used to be silent.
          A charge raised in the currency this account is not billed in is counted
          by neither side: "Billed to date" reads nil and any matching-currency
          receipt then shows as a credit, so a villa that owes money looks like a
          villa in credit. Said out loud, with the amount, so it can be corrected.
        */}
        {account.mismatchedCurrencyCharges.length > 0 && (
          <InfoNote tone="amber">
            <strong>Billed in another currency and not counted above:</strong>{' '}
            {account.mismatchedCurrencyCharges
              .map(c => `${formatMoneyLong(c.amount, c.currency)} due ${c.dueDate}`)
              .join(', ')}
            , this account is billed in {account.currency}, so these charges are not in the balance and
            anything paid against them will look like a credit. Void and re-raise them in {account.currency},
            or change the currency on the villa.
          </InfoNote>
        )}

        <p className="flex items-start gap-1.5 font-mono text-[10px] leading-relaxed text-slate-400">
          <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          Charges are never deleted. Voiding leaves the record in place and removes it from the balance, with the reason
          stored in the audit trail.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A printable, emailable account statement for one tenant or owner: every charge
 * and payment in date order with a running balance, plus the closing position.
 * This is the "print from the ledger tab" document, and the email button drafts
 * it to the account holder.
 */
function AccountStatementDocument({
  account,
  charges,
  payments,
  units,
  generatedBy,
  onClose
}: {
  account: AccountBalance;
  charges: Charge[];
  payments: Payment[];
  units: Unit[];
  generatedBy: string;
  onClose: () => void;
}) {
  const { unit, category, currency } = account;

  // Build a single date-ordered ledger of charges (debits) and payments (credits).
  const rows = useMemo(() => {
    const debits = chargesForUnit(charges, unit, units)
      .filter(c => c.category === category && c.status === 'open' && c.currency === currency)
      .map(c => ({
        date: c.dueDate,
        kind: 'charge' as const,
        label: c.description || `${category} charge for ${formatMonthLabel(c.periodMonth)}`,
        ref: '',
        debit: c.amount,
        credit: 0
      }));
    const credits = paymentsForUnit(payments, unit, units)
      .filter(p => p.category === category && p.status === 'completed' && p.currency === currency)
      .map(p => ({ date: p.date, kind: 'payment' as const, label: p.derived ? 'Maintenance settled from rent' : `Payment received (${p.method})`, ref: p.receiptNo, debit: 0, credit: p.amount }));
    const merged = [...debits, ...credits].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'charge' ? -1 : 1));
    let running = 0;
    return merged.map(row => {
      running = round2(running + row.debit - row.credit);
      return { ...row, running };
    });
  }, [charges, payments, unit, units, category, currency]);

  const recipientName = category === 'Maintenance' ? unit.ownerName : unit.tenantName || unit.ownerName;
  const recipientEmail = category === 'Maintenance' ? unit.ownerEmail : unit.tenantEmail || unit.ownerEmail;

  const emailDraft = () => {
    const body = [
      `Dear ${recipientName || 'Sir/Madam'},`,
      '',
      `Please find your ${category.toLowerCase()} account statement for ${getUnitDisplayName(unit.number)} below.`,
      '',
      `Total billed   : ${formatMoneyLong(account.charged, currency)}`,
      `Total received : ${formatMoneyLong(account.paid, currency)}`,
      `Balance ${account.balance >= 0 ? 'due' : 'in credit'} : ${formatMoneyLong(Math.abs(account.balance), currency)}`,
      '',
      'A full itemised statement is available on request.',
      '',
      'Villaggio Del Sol Management'
    ].join('\n');
    openMailDraft({ to: recipientEmail || '', subject: `${category} statement: ${getUnitDisplayName(unit.number)}`, body });
  };

  return (
    <PrintPortal
      title={`${category} statement: ${getUnitDisplayName(unit.number)}`}
      subtitle={recipientName}
      onClose={onClose}
      maxWidthClass="max-w-3xl"
      actions={
        <button
          type="button"
          onClick={emailDraft}
          disabled={!recipientEmail}
          title={recipientEmail ? `Draft an email to ${recipientEmail}` : 'No email address on file for this account'}
          className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50 disabled:opacity-50"
        >
          <Mail className="h-3.5 w-3.5" />
          Email
        </button>
      }
    >
      <PrintLetterhead
        documentTitle={`${category} Account Statement`}
        meta={getUnitDisplayName(unit.number)}
        generatedBy={generatedBy}
      />

      <section className="mb-5 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
        {[
          [category === 'Maintenance' ? 'Registered owner' : 'Tenant', recipientName || '-'],
          ['Account', `${category} (${currency})`],
          ['Total billed', formatMoney(account.charged, currency)],
          ['Balance', account.balance >= 0 ? `${formatMoney(account.balance, currency)} due` : `${formatMoney(Math.abs(account.balance), currency)} credit`]
        ].map(([label, value]) => (
          <div key={label}>
            <span className="block font-mono text-[9px] uppercase text-slate-500">{label}</span>
            <span className="font-semibold text-slate-900">{value}</span>
          </div>
        ))}
      </section>

      {rows.length === 0 ? (
        <p className="text-xs italic text-slate-500">No charges or payments recorded on this account yet.</p>
      ) : (
        <TableScroller>
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="font-mono text-[9px] uppercase text-slate-600">
                <th className="p-2">Date</th>
                <th className="p-2">Detail</th>
                <th className="p-2">Receipt</th>
                <th className="p-2 text-right">Charge</th>
                <th className="p-2 text-right">Paid</th>
                <th className="p-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((row, i) => (
                <tr key={i}>
                  <td className="p-2 whitespace-nowrap">{formatDayLabel(row.date)}</td>
                  <td className="p-2 font-sans">{row.label}</td>
                  <td className="p-2">{row.ref || '-'}</td>
                  <td className="p-2 text-right">{row.debit ? formatMoney(row.debit, currency) : '-'}</td>
                  <td className="p-2 text-right text-emerald-700">{row.credit ? formatMoney(row.credit, currency) : '-'}</td>
                  <td className="p-2 text-right font-semibold">{formatMoney(row.running, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-400 font-mono font-bold">
                <td className="p-2" colSpan={3}>Closing balance</td>
                <td className="p-2 text-right">{formatMoney(account.charged, currency)}</td>
                <td className="p-2 text-right">{formatMoney(account.paid, currency)}</td>
                <td className="p-2 text-right">{formatMoney(account.balance, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroller>
      )}

      {account.balance > 0 && (
        <p className="mt-4 rounded-lg border border-slate-300 p-3 text-xs">
          <strong>Amount due: {formatMoneyLong(account.balance, currency)}</strong>, payable to Villaggio Del Sol.
        </p>
      )}

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Received / Acknowledged by" rightName={recipientName} />
    </PrintPortal>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Bill something that is not the monthly rent or HOA fee.
 *
 * The account matters more than it looks: it decides whose balance this lands on
 * and therefore who gets chased for it. Rent is the tenant's account, maintenance
 * is the owner's, so the form names the person rather than the category and the
 * choice cannot be made by accident.
 */
function OneOffChargeModal({
  units,
  onClose,
  onSubmit
}: {
  units: Unit[];
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [unitId, setUnitId] = useState(units[0]?.id || '');
  const [category, setCategory] = useState<ChargeCategory>('Rent');
  const [oneOffType, setOneOffType] = useState<OneOffChargeType>('Late fee');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(today());
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const unit = units.find(u => u.id === unitId);

  /*
   * The currency this account is billed in — what every figure on it is measured
   * in, and what the charge falls to unless somebody deliberately says otherwise.
   */
  const nativeCurrency = unit ? chargeCurrency(unit, category) : 'JMD';

  /**
   * The currency chosen for this one charge.
   *
   * Ro, 2026-09-28: *"the 'Bill a one-off charge' feature does not have a USD
   * currency pill whereby the currency is selected."* It did not, because the
   * charge simply took the villa's own currency.
   *
   * Offering the choice re-opens a fault this application has already been bitten
   * by once, on villa C11 in September: **a balance is computed per unit, per
   * category, per currency, and the two currencies are never combined.** A charge
   * raised in the currency an account is *not* billed in is therefore counted by
   * neither side of that balance. "Billed to date" does not move while the money
   * is genuinely owed, and the next correctly-denominated receipt then shows the
   * villa as being in credit. The books flatter themselves and warn nobody.
   *
   * So the pill is here and the other currency is reachable, but never by
   * accident: choosing it states plainly what will happen and asks for a
   * deliberate tick. That is the same house pattern as the currency guard on a
   * settled receipt, and the same reason.
   */
  const [currency, setCurrency] = useState<Currency>(nativeCurrency);
  const [acceptStranded, setAcceptStranded] = useState(false);

  /*
   * Changing the villa or the account changes which currency is the native one,
   * and a tick given for a previous account cannot stand for this one. Both the
   * choice and the acceptance go back to the safe answer.
   */
  useEffect(() => {
    setCurrency(nativeCurrency);
    setAcceptStranded(false);
  }, [nativeCurrency]);

  const mismatched = currency !== nativeCurrency;
  const payer = unit ? (category === 'Maintenance' ? unit.ownerName : unit.tenantName || unit.ownerName) : '';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!unitId) {
      setError('Choose the villa this charge belongs to.');
      return;
    }
    if (!(Number(amount) > 0)) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (mismatched && !acceptStranded) {
      setError(
        `This account is billed in ${nativeCurrency}. Tick the confirmation below to raise the charge in ${currency} anyway, or change the currency back.`
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        unitId,
        category,
        oneOffType,
        amount: Number(amount),
        currency,
        dueDate,
        description,
        // Only ever sent when the tick above was given. The server refuses the
        // mismatch without it, so the guard is enforced there and not only here.
        ...(mismatched ? { confirmCurrencyMismatch: true } : {})
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not raise the charge.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Bill a one-off charge"
      subtitle="A late fee, a recharged repair, a fine, a levy: anything outside the monthly rent and HOA fee"
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Billing…" form="vds-oneoff-form" className="flex-1">
            Bill this charge
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-oneoff-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <InfoNote>
          This is money owed, not money received. It joins the villa&apos;s balance, ages into arrears and appears on the
          statement exactly like rent, record the payment separately when it is settled.
        </InfoNote>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Villa" htmlFor="oc-unit" required>
            <select id="oc-unit" value={unitId} onChange={e => setUnitId(e.target.value)} required className={inputClass}>
              <option value="">Select villa</option>
              {units.map(u => (
                <option key={u.id} value={u.id}>
                  {getUnitDisplayName(u.number)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Charge to" htmlFor="oc-cat" required hint={payer ? `Billed to ${payer}` : undefined}>
            <select
              id="oc-cat"
              value={category}
              onChange={e => setCategory(e.target.value as ChargeCategory)}
              className={inputClass}
            >
              <option value="Rent">The tenant (rent account)</option>
              <option value="Maintenance">The owner (HOA maintenance account)</option>
            </select>
          </Field>
        </div>

        <Field label="What is it for" htmlFor="oc-type" required>
          <select
            id="oc-type"
            value={oneOffType}
            onChange={e => setOneOffType(e.target.value as OneOffChargeType)}
            className={inputClass}
          >
            {ONE_OFF_CHARGE_TYPES.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Currency"
          htmlFor="oc-currency"
          required
          hint={unit ? `This account is billed in ${nativeCurrency}.` : undefined}
        >
          <div className="flex flex-wrap gap-2" id="oc-currency">
            {CURRENCIES.map(cur => (
              <button
                key={cur}
                type="button"
                onClick={() => {
                  setCurrency(cur);
                  setAcceptStranded(false);
                  setError('');
                }}
                aria-pressed={currency === cur}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                  currency === cur ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                }`}
              >
                {cur}
                {cur === nativeCurrency && <span className="ml-1.5 text-[9px] font-normal opacity-70">account currency</span>}
              </button>
            ))}
          </div>
        </Field>

        {mismatched && (
          <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
            <p className="text-[11px] font-semibold text-amber-900">
              This account is billed in {nativeCurrency}. A {currency} charge will not join its balance.
            </p>
            <p className="text-[11px] leading-relaxed text-amber-900">
              Balances are kept per account per currency and the two are never added together. A {currency} charge on a{' '}
              {nativeCurrency} account is therefore counted by neither side: &ldquo;Billed to date&rdquo; will not move,
              the money will still be owed, and the next {nativeCurrency} receipt will make the villa read as being in
              credit. It is flagged on the account as a charge in the wrong currency rather than chased as arrears.
            </p>
            <label className="flex items-start gap-2 text-[11px] font-medium text-amber-900">
              <input
                type="checkbox"
                checked={acceptStranded}
                onChange={e => {
                  setAcceptStranded(e.target.checked);
                  setError('');
                }}
                className="mt-0.5"
              />
              <span>
                Yes, raise this charge in {currency} anyway. I know it will not be counted in the {nativeCurrency}{' '}
                balance.
              </span>
            </label>
            <p className="font-mono text-[10px] text-amber-800">
              If this account should be billed in {currency} from now on, change the villa&rsquo;s currency in the Units
              Register instead, that moves the account, rather than leaving one charge behind it.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={`Amount (${currency})`} htmlFor="oc-amount" required>
            <input
              id="oc-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              required
              className={monoInputClass}
            />
          </Field>
          <Field label="Due date" htmlFor="oc-due" required hint="Sets the month it is reported in.">
            <input id="oc-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <Field
          label="Description"
          htmlFor="oc-desc"
          hint="Shown on the ledger and the statement. Say what it is for, so it can be explained months later."
        >
          <input
            id="oc-desc"
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="e.g. Replacement of broken window, Villa 3"
            className={inputClass}
          />
        </Field>
      </form>
    </Modal>
  );
}
