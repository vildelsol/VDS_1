/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import {
  AppSettings,
  Currency,
  EXPENSE_CATEGORIES,
  Expense,
  ExpenseCategory,
  PAYMENT_METHODS,
  PaymentMethod,
  SessionUser,
  Unit,
  UtilityReading,
  getAllocationLabel,
  getUnitDisplayName
} from '../types';
import { utilitiesForUnit } from '../lib/finance';
import { formatMoney, formatMoneyLong, sumMoney } from '../lib/money';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, isValidMonth, today } from '../lib/dates';
import { errorMessage } from '../lib/api';
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
  monoInputClass,
  tableHeadRowClass
} from './ui';
import { CheckCircle, Clock, Gauge, Plus, Search, Wrench } from 'lucide-react';

interface UtilitiesAndExpensesProps {
  units: Unit[];
  utilities: UtilityReading[];
  expenses: Expense[];
  settings: AppSettings;
  session: SessionUser;
  onAddUtilityReading: (payload: Record<string, unknown>) => Promise<unknown>;
  onUpdateUtilityReading: (id: string, fields: Record<string, unknown>) => Promise<unknown>;
  onSettleUtility: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
  onAddExpense: (payload: Record<string, unknown>) => Promise<unknown>;
  onUpdateExpense: (id: string, fields: Record<string, unknown>) => Promise<unknown>;
}

export default function UtilitiesAndExpenses({
  units,
  utilities,
  expenses,
  settings,
  session,
  onAddUtilityReading,
  onUpdateUtilityReading,
  onSettleUtility,
  onAddExpense,
  onUpdateExpense
}: UtilitiesAndExpensesProps) {
  const [tab, setTab] = useState<'utilities' | 'expenses'>('utilities');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [addingUtility, setAddingUtility] = useState(false);
  const [editingUtility, setEditingUtility] = useState<UtilityReading | null>(null);
  const [settlingUtility, setSettlingUtility] = useState<UtilityReading | null>(null);
  const [addingExpense, setAddingExpense] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  const canUtilities = !!session.permissions.enterUtilities;
  const canExpenses = !!session.permissions.recordExpenses;
  const canModifySettled = !!session.permissions.modifySettledRecords;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs sm:flex-row sm:items-center">
        <div className="flex gap-4">
          {([
            ['utilities', 'Metered utilities'],
            ['expenses', 'Expense register']
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
                setError('');
                setSuccess('');
              }}
              className={`border-b-2 pb-1 font-display text-base font-medium transition-all ${
                tab === key ? 'border-teal-600 font-semibold text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'utilities'
          ? canUtilities && (
              <SubmitButton type="button" onClick={() => setAddingUtility(true)}>
                <Plus className="h-4 w-4" /> Log meter reading
              </SubmitButton>
            )
          : canExpenses && (
              <SubmitButton type="button" onClick={() => setAddingExpense(true)}>
                <Plus className="h-4 w-4" /> Log expense
              </SubmitButton>
            )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}
      {tab === 'utilities' && !canUtilities && <PermissionNote>Recording utility readings requires additional permission.</PermissionNote>}
      {tab === 'expenses' && !canExpenses && <PermissionNote>Recording expenses requires additional permission.</PermissionNote>}

      {tab === 'utilities' ? (
        <UtilitiesPanel
          units={units}
          utilities={utilities}
          canEdit={canUtilities}
          canSettle={canUtilities && !!session.permissions.recordPayments}
          onEdit={setEditingUtility}
          onSettle={setSettlingUtility}
        />
      ) : (
        <ExpensesPanel expenses={expenses} canEdit={canExpenses} onEdit={setEditingExpense} />
      )}

      {addingUtility && (
        <UtilityForm
          units={units}
          utilities={utilities}
          onClose={() => setAddingUtility(false)}
          onSubmit={async payload => {
            await onAddUtilityReading(payload);
            setSuccess('Meter reading recorded. It appears as an unpaid bill until it is settled.');
            setError('');
            setAddingUtility(false);
          }}
        />
      )}

      {editingUtility && (
        <UtilityForm
          units={units}
          utilities={utilities}
          reading={editingUtility}
          locked={editingUtility.status === 'paid' && !canModifySettled}
          onClose={() => setEditingUtility(null)}
          onSubmit={async payload => {
            await onUpdateUtilityReading(editingUtility.id, payload);
            setSuccess('Meter reading updated.');
            setError('');
            setEditingUtility(null);
          }}
        />
      )}

      {settlingUtility && (
        <SettleUtilityForm
          utility={settlingUtility}
          units={units}
          onClose={() => setSettlingUtility(null)}
          onSubmit={async payload => {
            await onSettleUtility(settlingUtility.id, payload);
            setSuccess('Utility bill settled and a receipt issued, so it now appears in the payments ledger and reports.');
            setError('');
            setSettlingUtility(null);
          }}
        />
      )}

      {(addingExpense || editingExpense) && (
        <ExpenseForm
          units={units}
          vendors={settings.vendors}
          expense={editingExpense || undefined}
          locked={!!editingExpense && editingExpense.status === 'paid' && !canModifySettled}
          onClose={() => {
            setAddingExpense(false);
            setEditingExpense(null);
          }}
          onSubmit={async payload => {
            if (editingExpense) {
              await onUpdateExpense(editingExpense.id, payload);
              setSuccess('Expense updated.');
            } else {
              await onAddExpense(payload);
              setSuccess('Expense recorded.');
            }
            setError('');
            setAddingExpense(false);
            setEditingExpense(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UtilitiesPanel({
  units,
  utilities,
  canEdit,
  canSettle,
  onEdit,
  onSettle
}: {
  units: Unit[];
  utilities: UtilityReading[];
  canEdit: boolean;
  /** Settling takes money and issues a receipt, so it needs the payment permission too. */
  canSettle: boolean;
  onEdit: (u: UtilityReading) => void;
  onSettle: (u: UtilityReading) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<'all' | 'unpaid' | 'paid'>('all');
  const [unitFilter, setUnitFilter] = useState('all');
  const [periodFilter, setPeriodFilter] = useState('');

  const rows = useMemo(
    () =>
      utilities
        .filter(u => statusFilter === 'all' || u.status === statusFilter)
        .filter(u => unitFilter === 'all' || u.unitId === unitFilter)
        .filter(u => !periodFilter || u.billingPeriod === periodFilter)
        .sort((a, b) => b.billingPeriod.localeCompare(a.billingPeriod) || a.unitNumber.localeCompare(b.unitNumber)),
    [utilities, statusFilter, unitFilter, periodFilter]
  );

  const unpaidTotals = useMemo(() => {
    const out: Record<Currency, number> = { USD: 0, JMD: 0 };
    for (const u of utilities.filter(x => x.status === 'unpaid')) out[u.currency] = sumMoney([out[u.currency], u.amountCharged]);
    return out;
  }, [utilities]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-xs sm:grid-cols-3">
        <Field label="Status" htmlFor="ut-status">
          <select id="ut-status" value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)} className={inputClass}>
            <option value="all">All</option>
            <option value="unpaid">Unpaid only</option>
            <option value="paid">Settled only</option>
          </select>
        </Field>
        <Field label="Villa" htmlFor="ut-unit">
          <select id="ut-unit" value={unitFilter} onChange={e => setUnitFilter(e.target.value)} className={inputClass}>
            <option value="all">All villas</option>
            {units.map(u => (
              <option key={u.id} value={u.id}>
                {getUnitDisplayName(u.number)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Billing period" htmlFor="ut-period">
          <input id="ut-period" type="month" value={periodFilter} onChange={e => setPeriodFilter(e.target.value)} className={monoInputClass} />
        </Field>
      </div>

      {(unpaidTotals.JMD > 0 || unpaidTotals.USD > 0) && (
        <InfoNote tone="amber">
          Unpaid utility bills:{' '}
          {[unpaidTotals.JMD > 0 ? `${formatMoney(unpaidTotals.JMD, 'JMD')} JMD` : null, unpaidTotals.USD > 0 ? `${formatMoney(unpaidTotals.USD, 'USD')} USD` : null]
            .filter(Boolean)
            .join(' and ')}
          . Settling a bill issues a receipt so the money shows up in the ledger and reports.
        </InfoNote>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No meter readings match these filters" icon={<Gauge className="h-6 w-6" />} />
          </div>
        ) : (
          <TableScroller>
            <table className="w-full min-w-[860px] border-collapse text-left text-xs">
              <thead>
                <tr className={tableHeadRowClass}>
                  <th scope="col" className="p-4">Villa</th>
                  <th scope="col" className="p-4">Meter</th>
                  <th scope="col" className="p-4">Period</th>
                  <th scope="col" className="p-4 text-right">Previous</th>
                  <th scope="col" className="p-4 text-right">Current</th>
                  <th scope="col" className="p-4 text-right">Consumption</th>
                  <th scope="col" className="p-4 text-right">Charge</th>
                  <th scope="col" className="p-4">Status</th>
                  <th scope="col" className="p-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map(u => (
                  <tr key={u.id} className="hover:bg-slate-50/50">
                    <td className="p-4 font-mono font-semibold">{getUnitDisplayName(u.unitNumber)}</td>
                    <td className="p-4 font-mono text-[11px] text-slate-500">{u.meterNumber}</td>
                    <td className="p-4">{formatMonthLabel(u.billingPeriod)}</td>
                    <td className="p-4 text-right font-mono">{u.previousReading.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono">{u.currentReading.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono font-semibold text-teal-700">{u.consumption.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono font-semibold">{formatMoney(u.amountCharged, u.currency)}</td>
                    <td className="p-4">
                      {u.status === 'paid' ? (
                        <Badge tone="green">
                          <CheckCircle className="h-3 w-3" /> Settled
                        </Badge>
                      ) : (
                        <Badge tone="amber">
                          <Clock className="h-3 w-3" /> Unpaid
                        </Badge>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex justify-end gap-2">
                        {canEdit && (
                          <button onClick={() => onEdit(u)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
                            Edit
                          </button>
                        )}
                        {u.status === 'unpaid' && canSettle && (
                          <button onClick={() => onSettle(u)} className="rounded-lg bg-teal-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-teal-700">
                            Settle
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
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ExpensesPanel({ expenses, canEdit, onEdit }: { expenses: Expense[]; canEdit: boolean; onEdit: (e: Expense) => void }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'pending'>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | ExpenseCategory>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return expenses
      .filter(e => statusFilter === 'all' || e.status === statusFilter)
      .filter(e => categoryFilter === 'all' || e.category === categoryFilter)
      .filter(e => !fromDate || (e.datePaid || e.date) >= fromDate)
      .filter(e => !toDate || (e.datePaid || e.date) <= toDate)
      .filter(e =>
        !needle
          ? true
          : e.vendor.toLowerCase().includes(needle) ||
            e.description.toLowerCase().includes(needle) ||
            e.reference.toLowerCase().includes(needle) ||
            e.unitNumber.toLowerCase().includes(needle)
      )
      .sort((a, b) => (b.datePaid || b.date).localeCompare(a.datePaid || a.date));
  }, [expenses, search, statusFilter, categoryFilter, fromDate, toDate]);

  const totals = useMemo(() => {
    const out: Record<Currency, { paid: number; pending: number }> = { USD: { paid: 0, pending: 0 }, JMD: { paid: 0, pending: 0 } };
    for (const e of rows) {
      if (e.status === 'paid') out[e.currency].paid = sumMoney([out[e.currency].paid, e.amount]);
      else out[e.currency].pending = sumMoney([out[e.currency].pending, e.amount]);
    }
    return out;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-xs sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Search" htmlFor="ex-search">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-3.5 w-3.5 text-slate-400" />
            <input id="ex-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Vendor, description, reference" className={`${inputClass} pl-8`} />
          </div>
        </Field>
        <Field label="Status" htmlFor="ex-status">
          <select id="ex-status" value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)} className={inputClass}>
            <option value="all">All</option>
            <option value="pending">Pending only</option>
            <option value="paid">Paid only</option>
          </select>
        </Field>
        <Field label="Category" htmlFor="ex-cat">
          <select id="ex-cat" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value as typeof categoryFilter)} className={inputClass}>
            <option value="all">All categories</option>
            {EXPENSE_CATEGORIES.map(c => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From" htmlFor="ex-from">
          <input id="ex-from" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className={monoInputClass} />
        </Field>
        <Field label="To" htmlFor="ex-to">
          <input id="ex-to" type="date" value={toDate} onChange={e => setToDate(e.target.value)} className={monoInputClass} />
        </Field>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        <div className="flex flex-wrap gap-4 border-b border-slate-100 bg-slate-50 p-4 font-mono text-[11px] text-slate-500">
          <span>{rows.length} expense(s) shown</span>
          {(['JMD', 'USD'] as Currency[]).map(c =>
            totals[c].paid > 0 || totals[c].pending > 0 ? (
              <span key={c}>
                {c}: paid {formatMoney(totals[c].paid, c)}
                {totals[c].pending > 0 ? `, pending ${formatMoney(totals[c].pending, c)}` : ''}
              </span>
            ) : null
          )}
        </div>

        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No expenses match these filters" icon={<Wrench className="h-6 w-6" />} />
          </div>
        ) : (
          <TableScroller>
            <table className="w-full min-w-[900px] border-collapse text-left text-xs">
              <thead>
                <tr className={tableHeadRowClass}>
                  <th scope="col" className="p-4">Date</th>
                  <th scope="col" className="p-4">Vendor</th>
                  <th scope="col" className="p-4">Category</th>
                  <th scope="col" className="p-4">Allocation</th>
                  <th scope="col" className="p-4">Reference</th>
                  <th scope="col" className="p-4 text-right">Amount</th>
                  <th scope="col" className="p-4">Status</th>
                  {canEdit && <th scope="col" className="p-4 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map(e => (
                  <tr key={e.id} className="hover:bg-slate-50/50">
                    <td className="p-4 font-mono text-[11px] text-slate-500">{formatDayLabel(e.datePaid || e.date)}</td>
                    <td className="p-4">
                      <p className="font-medium text-slate-900">{e.vendor}</p>
                      {e.description && <p className="max-w-xs truncate text-[10px] text-slate-400">{e.description}</p>}
                    </td>
                    <td className="p-4">
                      <Badge>{e.category}</Badge>
                    </td>
                    <td className="p-4 font-mono text-[11px]">{getAllocationLabel(e.unitNumber)}</td>
                    <td className="p-4 font-mono text-[11px] text-slate-500">{e.reference || '—'}</td>
                    <td className="p-4 text-right font-mono font-semibold">
                      {formatMoney(e.amount, e.currency)}
                      <span className="ml-1 text-[9px] text-slate-400">{e.currency}</span>
                    </td>
                    <td className="p-4">
                      {e.status === 'paid' ? (
                        <Badge tone="green">
                          <CheckCircle className="h-3 w-3" /> Paid
                        </Badge>
                      ) : (
                        <Badge tone="amber">
                          <Clock className="h-3 w-3" /> Pending
                        </Badge>
                      )}
                    </td>
                    {canEdit && (
                      <td className="p-4 text-right">
                        <button onClick={() => onEdit(e)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UtilityForm({
  units,
  utilities,
  reading,
  locked,
  onClose,
  onSubmit
}: {
  units: Unit[];
  utilities: UtilityReading[];
  reading?: UtilityReading;
  locked?: boolean;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const editing = !!reading;
  const [unitId, setUnitId] = useState(reading?.unitId || '');
  const [billingPeriod, setBillingPeriod] = useState(reading?.billingPeriod || addMonths(currentMonth(), -1));
  const [previousReading, setPreviousReading] = useState(reading ? String(reading.previousReading) : '');
  const [currentReading, setCurrentReading] = useState(reading ? String(reading.currentReading) : '');
  const [amountCharged, setAmountCharged] = useState(reading ? String(reading.amountCharged) : '');
  const [currency, setCurrency] = useState<Currency>(reading?.currency || 'JMD');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const unit = units.find(u => u.id === unitId);

  /**
   * Chain each reading to the previous one for the same meter, so the opening
   * index is not retyped (and mistyped) every month.
   */
  const lastReading = useMemo(() => {
    if (!unit || editing) return null;
    const prior = utilitiesForUnit(utilities, unit, units)
      .filter(u => u.billingPeriod < billingPeriod)
      .sort((a, b) => b.billingPeriod.localeCompare(a.billingPeriod));
    return prior[0] || null;
  }, [unit, utilities, units, billingPeriod, editing]);

  React.useEffect(() => {
    if (lastReading) setPreviousReading(String(lastReading.currentReading));
  }, [lastReading]);

  React.useEffect(() => {
    if (unit && !editing) setCurrency(unit.currency);
  }, [unitId, unit, editing]);

  const duplicate = useMemo(
    () => (!editing && unitId ? utilities.find(u => u.unitId === unitId && u.billingPeriod === billingPeriod) : undefined),
    [utilities, unitId, billingPeriod, editing]
  );

  const prev = Number(previousReading);
  const curr = Number(currentReading);
  const consumption = Number.isFinite(prev) && Number.isFinite(curr) ? curr - prev : 0;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || locked) return;
    if (!editing && !unitId) {
      setError('Select the villa this meter belongs to.');
      return;
    }
    if (!isValidMonth(billingPeriod)) {
      setError('Enter a billing period as a month.');
      return;
    }
    if (duplicate) {
      setError(`A reading for ${formatMonthLabel(billingPeriod)} already exists for this villa. Edit that reading instead.`);
      return;
    }
    if (curr < prev) {
      setError('The current reading is lower than the previous one. Check the figures, or note a meter replacement.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        unitId: unitId || reading?.unitId,
        billingPeriod,
        previousReading: prev,
        currentReading: curr,
        amountCharged: Number(amountCharged),
        currency
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the reading.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? 'Edit meter reading' : 'Log meter reading'}
      subtitle={unit ? getUnitDisplayName(unit.number) : undefined}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-utility-form" disabled={locked} className="flex-1">
            {editing ? 'Save reading' : 'Record reading'}
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-utility-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}
        {locked && <PermissionNote>This bill is already settled. Editing settled records requires additional permission.</PermissionNote>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Villa" htmlFor="uf-unit" required>
            <select id="uf-unit" value={unitId} onChange={e => setUnitId(e.target.value)} required disabled={editing} className={inputClass}>
              <option value="">Select villa</option>
              {units.map(u => (
                <option key={u.id} value={u.id}>
                  {getUnitDisplayName(u.number)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Billing period" htmlFor="uf-period" required>
            <input id="uf-period" type="month" value={billingPeriod} onChange={e => setBillingPeriod(e.target.value)} required disabled={editing} className={monoInputClass} />
          </Field>
        </div>

        {unit && <p className="font-mono text-[10px] text-slate-400">Meter on file: {unit.meterNumber || 'not configured'}</p>}

        {duplicate && (
          <ErrorNote>
            A reading for {formatMonthLabel(billingPeriod)} already exists for this villa ({duplicate.previousReading.toLocaleString()} →{' '}
            {duplicate.currentReading.toLocaleString()}). Duplicate periods would double-bill the resident.
          </ErrorNote>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Previous reading"
            htmlFor="uf-prev"
            required
            hint={lastReading ? `Carried from ${formatMonthLabel(lastReading.billingPeriod)}.` : 'No earlier reading on file for this meter.'}
          >
            <input id="uf-prev" type="number" min="0" step="any" value={previousReading} onChange={e => setPreviousReading(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Current reading" htmlFor="uf-curr" required>
            <input id="uf-curr" type="number" min="0" step="any" value={currentReading} onChange={e => setCurrentReading(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <div className={`rounded-xl p-3 text-center ${consumption < 0 ? 'bg-red-50 text-red-700' : 'bg-slate-50 text-slate-700'}`}>
          <span className="block font-mono text-[10px] uppercase text-slate-400">Consumption (calculated)</span>
          <span className="font-mono text-lg font-bold">{consumption.toLocaleString()}</span>
          {consumption < 0 && <span className="mt-1 block text-[10px]">A negative reading normally means the meter was replaced or the figures were transposed.</span>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount to charge" htmlFor="uf-amount" required>
            <input id="uf-amount" type="number" min="0.01" step="0.01" value={amountCharged} onChange={e => setAmountCharged(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Currency" htmlFor="uf-cur" required>
            <select id="uf-cur" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={inputClass}>
              <option value="JMD">JMD (J$)</option>
              <option value="USD">USD ($)</option>
            </select>
          </Field>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function SettleUtilityForm({
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ payerName, date, method, reference });
    } catch (err) {
      setError(errorMessage(err, 'Could not settle the bill.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Settle utility bill"
      subtitle={`${getUnitDisplayName(utility.unitNumber)} — ${formatMoneyLong(utility.amountCharged, utility.currency)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Settling…" form="vds-settle-form" className="flex-1">
            Settle and issue receipt
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-settle-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}
        <InfoNote>A receipt is raised in the payments ledger for the full billed amount. Voiding that receipt reopens this bill.</InfoNote>

        <Field label="Payer name" htmlFor="su2-payer" required>
          <input id="su2-payer" type="text" value={payerName} onChange={e => setPayerName(e.target.value)} required className={inputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Method" htmlFor="su2-method" required>
            <select id="su2-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date received" htmlFor="su2-date" required>
            <input id="su2-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <Field label="Reference" htmlFor="su2-ref">
          <input id="su2-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function ExpenseForm({
  units,
  vendors,
  expense,
  locked,
  onClose,
  onSubmit
}: {
  units: Unit[];
  vendors: string[];
  expense?: Expense;
  locked?: boolean;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category || 'Maintenance');
  const [vendor, setVendor] = useState(expense?.vendor || '');
  const [description, setDescription] = useState(expense?.description || '');
  // Allocation is a villa id, or a named location token ("general" / "office").
  const [allocation, setAllocation] = useState<string>(
    expense?.unitId || (expense?.unitNumber === 'Office' ? 'office' : 'general')
  );
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '');
  const [currency, setCurrency] = useState<Currency>(expense?.currency || 'JMD');
  const [date, setDate] = useState(expense?.date || today());
  const [dueDate, setDueDate] = useState(expense?.dueDate || today());
  const [status, setStatus] = useState<Expense['status']>(expense?.status || 'paid');
  const [datePaid, setDatePaid] = useState(expense?.datePaid || today());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(expense?.paymentMethod || 'Bank Transfer');
  const [reference, setReference] = useState(expense?.reference || '');
  const [notes, setNotes] = useState(expense?.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || locked) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        category,
        vendor,
        description,
        unitId: allocation === 'general' || allocation === 'office' ? undefined : allocation,
        unitNumber: allocation === 'office' ? 'Office' : allocation === 'general' ? 'General' : undefined,
        amount: Number(amount),
        currency,
        date,
        dueDate,
        status,
        datePaid: status === 'paid' ? datePaid : undefined,
        paymentMethod,
        reference,
        notes
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the expense.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={expense ? 'Edit expense' : 'Log property expense'}
      onClose={onClose}
      maxWidthClass="max-w-lg"
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-expense-form" disabled={locked} className="flex-1">
            {expense ? 'Save expense' : 'Record expense'}
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-expense-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}
        {locked && <PermissionNote>This expense is already settled. Editing settled records requires additional permission.</PermissionNote>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" htmlFor="ef-cat" required>
            <select id="ef-cat" value={category} onChange={e => setCategory(e.target.value as ExpenseCategory)} className={inputClass}>
              {EXPENSE_CATEGORIES.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Allocation" htmlFor="ef-unit" hint="Charge to a specific villa, the office, or shared/common property.">
            <select id="ef-unit" value={allocation} onChange={e => setAllocation(e.target.value)} className={inputClass}>
              <optgroup label="Property-wide">
                <option value="general">General / common property</option>
                <option value="office">Office</option>
              </optgroup>
              <optgroup label="Villas">
                {units.map(u => (
                  <option key={u.id} value={u.id}>
                    {getUnitDisplayName(u.number)}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
        </div>

        <Field label="Vendor or payee" htmlFor="ef-vendor" required>
          <input id="ef-vendor" type="text" list="vds-vendors" value={vendor} onChange={e => setVendor(e.target.value)} required className={inputClass} />
          <datalist id="vds-vendors">
            {vendors.map(v => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>

        <Field label="Description" htmlFor="ef-desc">
          <input id="ef-desc" type="text" value={description} onChange={e => setDescription(e.target.value)} className={inputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" htmlFor="ef-amount" required>
            <input id="ef-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Currency" htmlFor="ef-cur" required>
            <select id="ef-cur" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={inputClass}>
              <option value="JMD">JMD (J$)</option>
              <option value="USD">USD ($)</option>
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Logged date" htmlFor="ef-date" required>
            <input id="ef-date" type="date" value={date} onChange={e => setDate(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Due date" htmlFor="ef-due">
            <input id="ef-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={monoInputClass} />
          </Field>
          <Field label="Status" htmlFor="ef-status" required>
            <select id="ef-status" value={status} onChange={e => setStatus(e.target.value as Expense['status'])} className={inputClass}>
              <option value="paid">Paid</option>
              <option value="pending">Pending</option>
            </select>
          </Field>
        </div>

        {status === 'paid' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date paid" htmlFor="ef-paid" required>
              <input id="ef-paid" type="date" value={datePaid} onChange={e => setDatePaid(e.target.value)} required className={monoInputClass} />
            </Field>
            <Field label="Method" htmlFor="ef-method" required>
              <select id="ef-method" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as PaymentMethod)} className={inputClass}>
                {PAYMENT_METHODS.map(m => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <Field
          label="Reference"
          htmlFor="ef-ref"
          hint="Invoice or voucher number. Keep the paper document filed against this reference — the system does not store attachments."
        >
          <input id="ef-ref" type="text" value={reference} onChange={e => setReference(e.target.value)} className={monoInputClass} />
        </Field>

        <Field label="Notes" htmlFor="ef-notes">
          <textarea id="ef-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}
