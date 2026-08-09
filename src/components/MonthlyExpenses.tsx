/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The monthly costs run.
 *
 * Payroll, electricity, water and the security contract came round every month
 * and were re-typed by hand every month — about twenty entries, which is slow and
 * quietly lossy, because a bill nobody remembered was simply never recorded.
 *
 * The templates below hold what recurs. The run does NOT post them blindly: it
 * lays them out as a table with the usual figure filled in, and the person
 * posting corrects each line before anything is written. That is the whole point.
 * Electricity is never the same twice, so a one-click "post the month" would
 * either be wrong or would have to be corrected afterwards on twenty records.
 *
 * Anything that only came up this month is added at the bottom of the same table
 * and posted with the rest, without becoming a template.
 */

import React, { useMemo, useState } from 'react';
import {
  Currency,
  EXPENSE_CATEGORIES,
  Expense,
  ExpenseCategory,
  PAYMENT_METHODS,
  PaymentMethod,
  RecurringExpense,
  Unit,
  getUnitDisplayName
} from '../types';
import { formatMoney } from '../lib/money';
import { currentMonth, formatMonthLabel, isValidMonth } from '../lib/dates';
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
  monoInputClass,
  tableHeadRowClass
} from './ui';
import { CalendarClock, Pencil, Play, Plus, Repeat, Square, Trash2 } from 'lucide-react';

/** An allocation token: a villa id, or one of the two named locations. */
type Allocation = string;

function allocationOf(t: { unitId: string; unitNumber: string }): Allocation {
  return t.unitId || (t.unitNumber === 'Office' ? 'office' : 'general');
}

function allocationPayload(allocation: Allocation) {
  return {
    unitId: allocation === 'general' || allocation === 'office' ? undefined : allocation,
    unitNumber: allocation === 'office' ? 'Office' : allocation === 'general' ? 'General' : undefined
  };
}

function allocationLabel(allocation: Allocation, units: Unit[]): string {
  if (allocation === 'general') return 'General / common';
  if (allocation === 'office') return 'Office';
  const unit = units.find(u => u.id === allocation);
  return unit ? getUnitDisplayName(unit.number) : allocation;
}

/** One line the poster is about to raise, before it is written. */
interface ExtraLine {
  key: string;
  category: ExpenseCategory;
  vendor: string;
  description: string;
  allocation: Allocation;
  amount: string;
  currency: Currency;
  paymentMethod: PaymentMethod;
}

function blankExtra(): ExtraLine {
  return {
    key: `extra-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    category: 'Other',
    vendor: '',
    description: '',
    allocation: 'general',
    amount: '',
    currency: 'JMD',
    paymentMethod: 'Bank Transfer'
  };
}

interface MonthlyExpensesProps {
  units: Unit[];
  expenses: Expense[];
  templates: RecurringExpense[];
  vendors: string[];
  canEdit: boolean;
  onAddRecurring: (payload: Record<string, unknown>) => Promise<unknown>;
  onUpdateRecurring: (id: string, fields: Record<string, unknown>) => Promise<unknown>;
  onPostMonth: (payload: Record<string, unknown>) => Promise<{ message: string; created: number; skipped: number }>;
}

export default function MonthlyExpenses({
  units,
  expenses,
  templates,
  vendors,
  canEdit,
  onAddRecurring,
  onUpdateRecurring,
  onPostMonth
}: MonthlyExpensesProps) {
  const [month, setMonth] = useState(currentMonth());
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<RecurringExpense | null>(null);
  const [adding, setAdding] = useState(false);

  /** Per-template overrides for this run: whether to post it, and for how much. */
  const [overrides, setOverrides] = useState<Record<string, { include: boolean; amount: string }>>({});
  const [extras, setExtras] = useState<ExtraLine[]>([]);

  const active = useMemo(
    () => templates.filter(t => t.active).sort((a, b) => a.vendor.localeCompare(b.vendor)),
    [templates]
  );
  const retired = useMemo(() => templates.filter(t => !t.active), [templates]);

  /** What this month already has on file, so nothing is offered twice. */
  const postedFor = useMemo(() => {
    const byTemplate = new Map<string, Expense>();
    for (const e of expenses) {
      if (e.periodMonth === month && e.recurringId) byTemplate.set(e.recurringId, e);
    }
    return byTemplate;
  }, [expenses, month]);

  const rows = active.map(t => {
    const posted = postedFor.get(t.id);
    const override = overrides[t.id];
    return {
      template: t,
      posted,
      include: posted ? false : (override?.include ?? true),
      amount: override?.amount ?? String(t.amount)
    };
  });

  const selected = rows.filter(r => r.include);
  const readyExtras = extras.filter(x => x.vendor.trim() && Number(x.amount) > 0);

  /** Run totals, kept per currency — the two are never added together. */
  const totals = useMemo(() => {
    const acc: Record<Currency, number> = { JMD: 0, USD: 0 };
    for (const r of selected) acc[r.template.currency] += Number(r.amount) || 0;
    for (const x of readyExtras) acc[x.currency] += Number(x.amount) || 0;
    return acc;
  }, [selected, readyExtras]);

  const setOverride = (id: string, patch: Partial<{ include: boolean; amount: string }>) => {
    setOverrides(prev => {
      const current = prev[id] ?? { include: true, amount: String(templates.find(t => t.id === id)?.amount ?? '') };
      return { ...prev, [id]: { ...current, ...patch } };
    });
  };

  const post = async () => {
    if (busy) return;
    if (!isValidMonth(month)) {
      setError('Choose a month to post.');
      return;
    }
    if (selected.length === 0 && readyExtras.length === 0) {
      setError('Nothing is ticked to post.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const items = [
        ...selected.map(r => ({ recurringId: r.template.id, amount: Number(r.amount) })),
        ...readyExtras.map(x => ({
          category: x.category,
          vendor: x.vendor.trim(),
          description: x.description.trim(),
          ...allocationPayload(x.allocation),
          amount: Number(x.amount),
          currency: x.currency,
          paymentMethod: x.paymentMethod,
          dueDay: 1
        }))
      ];
      const result = await onPostMonth({ monthString: month, items });
      setSuccess(result.message);
      setOverrides({});
      setExtras([]);
    } catch (err) {
      setError(errorMessage(err, 'Could not post the monthly costs.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}

      {/* ---------------- the run ---------------- */}

      <div className="rounded-2xl border border-slate-100 bg-white shadow-xs">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-900">
              <CalendarClock className="h-5 w-5 text-teal-600" /> Post the month&rsquo;s costs
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
              Check each figure against the bill in front of you before posting — the amounts below are the usual ones, not this
              month&rsquo;s. Everything posted is raised as <span className="font-medium">awaiting payment</span>; it is marked paid in the
              expense register when the money actually leaves.
            </p>
          </div>
          <Field label="Month" htmlFor="me-month">
            <input
              id="me-month"
              type="month"
              value={month}
              max={currentMonth()}
              onChange={e => {
                setMonth(e.target.value);
                setOverrides({});
                setSuccess('');
                setError('');
              }}
              className={monoInputClass}
            />
          </Field>
        </div>

        {active.length === 0 && extras.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No monthly costs are set up yet"
              hint="Add payroll, electricity, water and the security contract below. Then each month is a review and one click."
              icon={<Repeat className="h-6 w-6" />}
            />
          </div>
        ) : (
          <>
            {/* A minimum width so a narrow screen scrolls the table rather than
                squeezing the amount boxes down to two digits. The whole screen is
                for checking figures against a bill; a figure you cannot read is
                worse than no screen at all. */}
            <TableScroller>
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className={tableHeadRowClass}>
                    <th className="w-10 px-4 py-3" />
                    <th className="px-4 py-3 text-left">Cost</th>
                    <th className="px-4 py-3 text-left">Allocation</th>
                    <th className="px-4 py-3 text-right">Amount for {formatMonthLabel(month)}</th>
                    <th className="px-4 py-3 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map(row => (
                    <tr key={row.template.id} className={row.posted ? 'bg-slate-50/60 text-slate-400' : ''}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Post ${row.template.vendor}`}
                          checked={row.include}
                          disabled={!!row.posted || !canEdit}
                          onChange={e => setOverride(row.template.id, { include: e.target.checked })}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{row.template.vendor}</div>
                        <div className="text-[11px] text-slate-500">
                          {row.template.category}
                          {row.template.description ? ` — ${row.template.description}` : ''} · due day {row.template.dueDay}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{allocationLabel(allocationOf(row.template), units)}</td>
                      <td className="px-4 py-3 text-right">
                        {row.posted ? (
                          <span className="font-mono">{formatMoney(row.posted.amount, row.posted.currency)}</span>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-[11px] text-slate-400">{row.template.currency}</span>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              aria-label={`Amount for ${row.template.vendor}`}
                              value={row.amount}
                              disabled={!row.include || !canEdit}
                              onChange={e => setOverride(row.template.id, { amount: e.target.value })}
                              className={`${monoInputClass} w-32 shrink-0 text-right`}
                            />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.posted ? (
                          <Badge tone={row.posted.status === 'paid' ? 'green' : 'amber'}>
                            {row.posted.status === 'paid' ? 'Posted & paid' : 'Posted, awaiting payment'}
                          </Badge>
                        ) : row.include ? (
                          <span className="text-[11px] text-slate-500">Will be raised</span>
                        ) : (
                          <span className="text-[11px] text-slate-400">Skipped this month</span>
                        )}
                      </td>
                    </tr>
                  ))}

                  {extras.map(extra => (
                    <tr key={extra.key} className="bg-teal-50/40 align-top">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          aria-label="Remove this item"
                          onClick={() => setExtras(prev => prev.filter(x => x.key !== extra.key))}
                          className="text-slate-400 transition-colors hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          list="vds-vendors"
                          placeholder="Vendor or payee"
                          aria-label="Vendor for the added item"
                          value={extra.vendor}
                          onChange={e =>
                            setExtras(prev => prev.map(x => (x.key === extra.key ? { ...x, vendor: e.target.value } : x)))
                          }
                          className={`${inputClass} mb-2`}
                        />
                        <select
                          aria-label="Category for the added item"
                          value={extra.category}
                          onChange={e =>
                            setExtras(prev =>
                              prev.map(x => (x.key === extra.key ? { ...x, category: e.target.value as ExpenseCategory } : x))
                            )
                          }
                          className={inputClass}
                        >
                          {EXPENSE_CATEGORIES.map(c => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          aria-label="Allocation for the added item"
                          value={extra.allocation}
                          onChange={e =>
                            setExtras(prev => prev.map(x => (x.key === extra.key ? { ...x, allocation: e.target.value } : x)))
                          }
                          className={inputClass}
                        >
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
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <select
                            aria-label="Currency for the added item"
                            value={extra.currency}
                            onChange={e =>
                              setExtras(prev =>
                                prev.map(x => (x.key === extra.key ? { ...x, currency: e.target.value as Currency } : x))
                              )
                            }
                            className={`${inputClass} w-24 shrink-0`}
                          >
                            <option value="JMD">JMD</option>
                            <option value="USD">USD</option>
                          </select>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            placeholder="0.00"
                            aria-label="Amount for the added item"
                            value={extra.amount}
                            onChange={e =>
                              setExtras(prev => prev.map(x => (x.key === extra.key ? { ...x, amount: e.target.value } : x)))
                            }
                            className={`${monoInputClass} w-32 text-right`}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[11px] text-slate-500">
                          {extra.vendor.trim() && Number(extra.amount) > 0 ? 'One-off, will be raised' : 'Needs a payee and an amount'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>

            <div className="flex flex-col gap-3 border-t border-slate-100 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-4">
                {canEdit && (
                  <SecondaryButton onClick={() => setExtras(prev => [...prev, blankExtra()])}>
                    <Plus className="h-4 w-4" /> Add another item
                  </SecondaryButton>
                )}
                <div className="text-xs text-slate-500">
                  {selected.length + readyExtras.length} line(s) to raise ·{' '}
                  <span className="font-mono text-slate-700">
                    {totals.JMD > 0 ? formatMoney(totals.JMD, 'JMD') : ''}
                    {totals.JMD > 0 && totals.USD > 0 ? ' + ' : ''}
                    {totals.USD > 0 ? formatMoney(totals.USD, 'USD') : ''}
                    {totals.JMD === 0 && totals.USD === 0 ? '—' : ''}
                  </span>
                </div>
              </div>
              {canEdit && (
                <SubmitButton
                  type="button"
                  busy={busy}
                  busyLabel="Posting…"
                  onClick={post}
                  disabled={selected.length === 0 && readyExtras.length === 0}
                >
                  Post {formatMonthLabel(month)}
                </SubmitButton>
              )}
            </div>
          </>
        )}
      </div>

      {/* ---------------- the templates ---------------- */}

      <div className="rounded-2xl border border-slate-100 bg-white shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 p-5">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-900">
              <Repeat className="h-5 w-5 text-teal-600" /> What recurs
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              The costs offered each month. The amount here is the usual figure, used to pre-fill the run.
            </p>
          </div>
          {canEdit && (
            <SubmitButton type="button" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add a monthly cost
            </SubmitButton>
          )}
        </div>

        {templates.length === 0 ? (
          <div className="p-5">
            <EmptyState title="Nothing set up yet" hint="Add the costs that come round every month." icon={<Repeat className="h-6 w-6" />} />
          </div>
        ) : (
          <TableScroller>
            <table className="w-full text-sm">
              <thead>
                <tr className={tableHeadRowClass}>
                  <th className="px-4 py-3 text-left">Vendor</th>
                  <th className="px-4 py-3 text-left">Category</th>
                  <th className="px-4 py-3 text-left">Allocation</th>
                  <th className="px-4 py-3 text-right">Usual amount</th>
                  <th className="px-4 py-3 text-left">Due day</th>
                  <th className="px-4 py-3 text-left">State</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...active, ...retired].map(t => (
                  <tr key={t.id} className={t.active ? '' : 'text-slate-400'}>
                    <td className="px-4 py-3 font-medium text-slate-800">{t.vendor}</td>
                    <td className="px-4 py-3 text-slate-600">{t.category}</td>
                    <td className="px-4 py-3 text-slate-600">{allocationLabel(allocationOf(t), units)}</td>
                    <td className="px-4 py-3 text-right font-mono">{formatMoney(t.amount, t.currency)}</td>
                    <td className="px-4 py-3 text-slate-600">{t.dueDay}</td>
                    <td className="px-4 py-3">
                      <Badge tone={t.active ? 'green' : 'slate'}>{t.active ? 'Every month' : 'Stopped'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canEdit && (
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditing(t)}
                            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                            aria-label={`Edit ${t.vendor}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              setError('');
                              try {
                                await onUpdateRecurring(t.id, { ...t, ...allocationPayload(allocationOf(t)), active: !t.active });
                                setSuccess(t.active ? `${t.vendor} will no longer be offered each month.` : `${t.vendor} is back on the monthly run.`);
                              } catch (err) {
                                setError(errorMessage(err, 'Could not change that cost.'));
                              }
                            }}
                            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                            aria-label={t.active ? `Stop ${t.vendor}` : `Resume ${t.vendor}`}
                          >
                            {t.active ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}

        <div className="border-t border-slate-100 p-5">
          <InfoNote>
            An annual cost split across the villas — the insurance premium — is not set up here. It is a different calculation and is
            entered in the expense register when the premium falls due.
          </InfoNote>
        </div>
      </div>

      <datalist id="vds-vendors">
        {vendors.map(v => (
          <option key={v} value={v} />
        ))}
      </datalist>

      {(adding || editing) && (
        <RecurringForm
          units={units}
          vendors={vendors}
          template={editing || undefined}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSubmit={async payload => {
            if (editing) {
              await onUpdateRecurring(editing.id, payload);
              setSuccess('Monthly cost updated.');
            } else {
              await onAddRecurring(payload);
              setSuccess('Monthly cost added. It will be offered on every run from now on.');
            }
            setError('');
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RecurringForm({
  units,
  vendors,
  template,
  onClose,
  onSubmit
}: {
  units: Unit[];
  vendors: string[];
  template?: RecurringExpense;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [category, setCategory] = useState<ExpenseCategory>(template?.category || 'Utilities');
  const [vendor, setVendor] = useState(template?.vendor || '');
  const [description, setDescription] = useState(template?.description || '');
  const [allocation, setAllocation] = useState<Allocation>(template ? allocationOf(template) : 'general');
  const [amount, setAmount] = useState(template ? String(template.amount) : '');
  const [currency, setCurrency] = useState<Currency>(template?.currency || 'JMD');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(template?.paymentMethod || 'Bank Transfer');
  const [dueDay, setDueDay] = useState(String(template?.dueDay ?? 1));
  const [notes, setNotes] = useState(template?.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        category,
        vendor,
        description,
        ...allocationPayload(allocation),
        amount: Number(amount),
        currency,
        paymentMethod,
        dueDay: Number(dueDay),
        active: template ? template.active : true,
        notes
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not save that monthly cost.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={template ? 'Edit monthly cost' : 'Add a monthly cost'}
      onClose={onClose}
      maxWidthClass="max-w-lg"
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-recurring-form" className="flex-1">
            {template ? 'Save' : 'Add cost'}
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-recurring-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" htmlFor="rf-cat" required>
            <select id="rf-cat" value={category} onChange={e => setCategory(e.target.value as ExpenseCategory)} className={inputClass}>
              {EXPENSE_CATEGORIES.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Allocation" htmlFor="rf-unit" hint="Charge to a specific villa, the office, or shared/common property.">
            <select id="rf-unit" value={allocation} onChange={e => setAllocation(e.target.value)} className={inputClass}>
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

        <Field label="Vendor or payee" htmlFor="rf-vendor" required>
          <input id="rf-vendor" type="text" list="vds-vendors" value={vendor} onChange={e => setVendor(e.target.value)} required className={inputClass} />
        </Field>

        <Field label="Description" htmlFor="rf-desc">
          <input id="rf-desc" type="text" value={description} onChange={e => setDescription(e.target.value)} className={inputClass} />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Usual amount" htmlFor="rf-amount" required hint="A starting figure — correct it each month.">
            <input id="rf-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Currency" htmlFor="rf-cur" required>
            <select id="rf-cur" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={inputClass}>
              <option value="JMD">JMD (J$)</option>
              <option value="USD">USD ($)</option>
            </select>
          </Field>
          <Field label="Due day" htmlFor="rf-due" required hint="1–28, so every month has it.">
            <input id="rf-due" type="number" min="1" max="28" step="1" value={dueDay} onChange={e => setDueDay(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <Field label="Usual method" htmlFor="rf-method" required>
          <select id="rf-method" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as PaymentMethod)} className={inputClass}>
            {PAYMENT_METHODS.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Notes" htmlFor="rf-notes">
          <textarea id="rf-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}
