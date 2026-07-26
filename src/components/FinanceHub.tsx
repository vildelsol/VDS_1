/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import {
  Charge,
  ChargeCategory,
  Currency,
  PAYMENT_CATEGORIES,
  PAYMENT_METHODS,
  Payment,
  PaymentCategory,
  PaymentMethod,
  SessionUser,
  Unit,
  getUnitDisplayName
} from '../types';
import {
  ACCOUNT_STATUS_LABEL,
  AccountBalance,
  accountBalance,
  chargeCurrency,
  chargesForUnit,
  currencyMismatchWarnings,
  isBillable,
  paymentsForUnit
} from '../lib/finance';
import { formatMoney, formatMoneyLong, round2 } from '../lib/money';
import { currentMonth, formatDayLabel, formatMonthLabel, today } from '../lib/dates';
import { errorMessage } from '../lib/api';
import { openMailDraft } from '../lib/email';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import {
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
  monoInputClass
} from './ui';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle,
  Edit,
  FileText,
  Mail,
  Plus,
  Printer,
  RotateCcw,
  Search,
  ShieldAlert
} from 'lucide-react';

interface FinanceHubProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  session: SessionUser;
  onRecordPayment: (payload: Record<string, unknown>) => Promise<Payment>;
  onReversePayment: (paymentId: string, reason: string) => Promise<unknown>;
  onUpdatePayment: (paymentId: string, fields: Record<string, unknown>) => Promise<unknown>;
  onPostMonth: (month: string) => Promise<{ message: string }>;
  onVoidCharge: (chargeId: string, reason: string) => Promise<unknown>;
  onOpenReceipt: (payment: Payment) => void;
}

const PAGE_SIZE = 25;

export default function FinanceHub({
  units,
  charges,
  payments,
  session,
  onRecordPayment,
  onReversePayment,
  onUpdatePayment,
  onPostMonth,
  onVoidCharge,
  onOpenReceipt
}: FinanceHubProps) {
  const [tab, setTab] = useState<'tenants' | 'owners' | 'transactions'>('tenants');
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

  const [payTarget, setPayTarget] = useState<{ unit: Unit; category: PaymentCategory; amount: number; currency: Currency } | null>(null);

  const openPaymentFor = (account: AccountBalance) => {
    setPayTarget({
      unit: account.unit,
      category: account.category,
      amount: Math.max(0, account.balance),
      currency: account.currency
    });
  };

  /* ---------------- receipts ledger ---------------- */

  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<'all' | PaymentCategory>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'completed' | 'reversed'>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(0);

  const filteredPayments = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return payments
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
          {perms.recordPayments && (
            <button
              onClick={() => setPayTarget({ unit: units[0], category: 'Rent', amount: 0, currency: units[0]?.currency || 'JMD' })}
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
                Post them in one click to bill every unit at once — rent for {monthCharges.rentCount} long-term lease
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
          {formatMonthLabel(thisMonth)} charges are posted — every unit is billed. Record payments as they come in.
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

      {tab === 'tenants' && (
        <AccountTable
          accounts={rentAccounts}
          category="Rent"
          asOf={asOf}
          nameOf={u => u.tenantName || '— no tenant on record —'}
          contactOf={u => u.tenantEmail}
          payments={payments}
          onReceive={openPaymentFor}
          onViewCharges={setChargesTarget}
          onPrintStatement={setStatementTarget}
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
        />
      )}

      {tab === 'transactions' && (
        <div className="space-y-4">
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
                  setFilterStatus(e.target.value as 'all' | 'completed' | 'reversed');
                  setPage(0);
                }}
                className={inputClass}
              >
                <option value="all">All statuses</option>
                <option value="completed">Completed only</option>
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
                    <tr className="border-b border-slate-200 bg-slate-100/50 font-mono text-[10px] uppercase text-slate-500">
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
                            {p.receiptNo}
                          </button>
                          {(p.printCount || 0) > 1 && <span className="ml-1 text-[9px] text-amber-600">×{p.printCount}</span>}
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
                        </td>
                        <td className="p-4 font-mono text-[11px] text-slate-500">{formatDayLabel(p.date)}</td>
                        <td className="p-4">
                          {p.status === 'completed' ? (
                            <Badge tone="green">
                              <CheckCircle className="h-3 w-3" /> Completed
                            </Badge>
                          ) : (
                            <Badge tone="red">
                              <RotateCcw className="h-3 w-3" /> Voided
                            </Badge>
                          )}
                        </td>
                        <td className="p-4">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => onOpenReceipt(p)}
                              className="rounded-lg border border-slate-200 p-1.5 text-slate-500 transition-all hover:bg-slate-50 hover:text-slate-800"
                              title="Print receipt"
                              aria-label={`Print receipt ${p.receiptNo}`}
                            >
                              <Printer className="h-4 w-4" />
                            </button>
                            {p.status === 'completed' && canReverse && (
                              <button
                                onClick={() => setReversalTarget(p)}
                                className="rounded-lg border border-red-200 p-1.5 text-red-600 transition-all hover:bg-red-50"
                                title="Void this receipt"
                                aria-label={`Void receipt ${p.receiptNo}`}
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

      {payTarget && (
        <RecordPaymentModal
          units={units}
          charges={charges}
          initial={payTarget}
          staffName={session.name}
          onClose={() => setPayTarget(null)}
          onSubmit={async payload => {
            const payment = await onRecordPayment(payload);
            setSuccess(`Receipt ${payment.receiptNo} issued for ${formatMoneyLong(payment.amount, payment.currency)}.`);
            setPayTarget(null);
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

function AccountTable({
  accounts,
  category,
  asOf,
  payments,
  nameOf,
  contactOf,
  onReceive,
  onViewCharges,
  onPrintStatement
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
}) {
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
      {noCharges && (
        <InfoNote tone="amber">
          No {category.toLowerCase()} charges have been posted yet, so every balance reads zero. Use{' '}
          <strong>Post month</strong> above to raise the charges for a billing month — that is what makes arrears
          accumulate.
        </InfoNote>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        <TableScroller>
          <table className="w-full min-w-[900px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] uppercase text-slate-500">
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
                const monthly = category === 'Rent' ? unit.monthlyRent : unit.monthlyMaintenance;
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
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => onPrintStatement(account)}
                          title="Print or email an account statement"
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 font-medium text-slate-600 transition-colors hover:bg-slate-50"
                        >
                          <Printer className="h-3.5 w-3.5" /> Statement
                        </button>
                        {overdue ? (
                          <button
                            onClick={() => onReceive(account)}
                            className="rounded-lg border border-slate-200 px-2.5 py-1.5 font-medium text-teal-700 transition-colors hover:border-teal-200 hover:text-teal-900"
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
                          <span className="text-slate-300">—</span>
                        )}
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
  initial: { unit: Unit; category: PaymentCategory; amount: number; currency: Currency };
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

  const expectedCurrency = unit && (category === 'Rent' || category === 'Maintenance') ? chargeCurrency(unit, category as ChargeCategory) : null;
  const currencyMismatch = !!expectedCurrency && expectedCurrency !== currency;

  /**
   * Nothing billed on this account yet, so this money would land as a credit on a
   * villa that reads as owing nothing — which is how a payment appears to vanish.
   */
  const noOpenCharge =
    !!unit &&
    (category === 'Rent' || category === 'Maintenance') &&
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
      title="Record payment and issue receipt"
      subtitle={`Receipt will be issued in the name of ${staffName}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Issuing receipt…" form="vds-payment-form" className="flex-1">
            Record and issue receipt
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-payment-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

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
              <span>Record it in {currency} anyway — I will reconcile the account separately.</span>
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
            placeholder="e.g. Recorded against the wrong villa — re-entered as REC-2026-0042"
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

  const locked = payment.status === 'reversed' || !!payment.bookingId || !!payment.utilityId;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({ payerName, unitId, category, amount: Number(amount), currency, date, method, reference, notes });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the correction.'));
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
              <strong>Voided</strong> by {payment.reversedBy} on {formatDayLabel(payment.reversalDate || '')} — “
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
              ['Reference', payment.reference || '—'],
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
          <InfoNote tone="amber">
            Corrections are recorded in the audit trail with the previous and new values. The receipt number and its
            void status cannot be changed here — void the receipt and re-enter it if the payment itself was wrong.
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
            <Field label="Currency" htmlFor="pe-cur" required>
              <select id="pe-cur" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={inputClass}>
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
      title={`${account.category} charges — ${getUnitDisplayName(account.unit.number)}`}
      subtitle={`Balance ${formatMoneyLong(account.balance, account.currency)}`}
      onClose={onClose}
      maxWidthClass="max-w-2xl"
    >
      <div className="space-y-4 p-6 text-xs">
        {error && <ErrorNote>{error}</ErrorNote>}

        {rows.length === 0 ? (
          <EmptyState title="No charges have been posted for this account yet" />
        ) : (
          <TableScroller>
            <table className="w-full min-w-[520px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-200 font-mono text-[10px] uppercase text-slate-400">
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
                      <td className="p-2 font-medium">{formatMonthLabel(charge.periodMonth)}</td>
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
            {account.mismatchedCurrencyPayments.map(p => `${p.receiptNo} (${formatMoneyLong(p.amount, p.currency)})`).join(', ')} —
            recorded in a different currency to the {account.currency} billed on this account.
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
      .map(c => ({ date: c.dueDate, kind: 'charge' as const, label: `${category} charge — ${formatMonthLabel(c.periodMonth)}`, ref: '', debit: c.amount, credit: 0 }));
    const credits = paymentsForUnit(payments, unit, units)
      .filter(p => p.category === category && p.status === 'completed' && p.currency === currency)
      .map(p => ({ date: p.date, kind: 'payment' as const, label: `Payment received (${p.method})`, ref: p.receiptNo, debit: 0, credit: p.amount }));
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
    openMailDraft({ to: recipientEmail || '', subject: `${category} statement — ${getUnitDisplayName(unit.number)}`, body });
  };

  return (
    <PrintPortal
      title={`${category} statement — ${getUnitDisplayName(unit.number)}`}
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
          [category === 'Maintenance' ? 'Registered owner' : 'Tenant', recipientName || '—'],
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
                  <td className="p-2">{row.ref || '—'}</td>
                  <td className="p-2 text-right">{row.debit ? formatMoney(row.debit, currency) : '—'}</td>
                  <td className="p-2 text-right text-emerald-700">{row.credit ? formatMoney(row.credit, currency) : '—'}</td>
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

      <PrintSignatures left="Prepared by" right="Received / Acknowledged by" />
    </PrintPortal>
  );
}
