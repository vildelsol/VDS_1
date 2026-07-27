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
  Payment,
  SessionUser,
  Tenancy,
  UNIT_STATUSES,
  UNIT_STATUS_LABELS,
  Unit,
  UnitActivity,
  UnitStatus,
  UtilityReading,
  getUnitDisplayName
} from '../types';
import {
  AccountStatus,
  accountBalance,
  bookingsForUnit,
  expensesForUnit,
  liveUnitState,
  paymentsForUnit,
  utilitiesForUnit
} from '../lib/finance';
import { convertIndicative, formatMoney, formatMoneyLong } from '../lib/money';
import { formatDayLabel, formatMonthLabel, nightsBetween, today } from '../lib/dates';
import { errorMessage } from '../lib/api';
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
import { ClipboardList, Edit3, Home, Mail, Phone, Plus, Printer, Trash2, User } from 'lucide-react';

interface UnitsProps {
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  utilities: UtilityReading[];
  bookings: Booking[];
  tenancies: Tenancy[];
  expenses: Expense[];
  unitActivities: UnitActivity[];
  settings: AppSettings;
  session: SessionUser;
  onUpdateUnit: (unit: Record<string, unknown> & { id: string }) => Promise<unknown>;
  onUpdateTenancy: (id: string, fields: Record<string, unknown>) => Promise<unknown>;
  onEvictTenancy: (id: string, payload: Record<string, unknown>) => Promise<{ writtenOff: number; currency: string; chargesVoided: number }>;
  onAddUnitActivity: (payload: Record<string, unknown>) => Promise<unknown>;
  onDeleteUnitActivity: (id: string) => Promise<unknown>;
}

const ordinal = (day: number) => {
  if (day > 3 && day < 21) return 'th';
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
};

const STATUS_STYLES: Record<UnitStatus, { card: string; icon: string; dot: string; badge: Parameters<typeof Badge>[0]['tone'] }> = {
  'long-term': { card: 'bg-emerald-50/30 border-emerald-100/80 hover:border-emerald-300', icon: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-500', badge: 'green' },
  'short-term': { card: 'bg-amber-50/30 border-amber-100/80 hover:border-amber-300', icon: 'bg-amber-50 text-amber-600', dot: 'bg-amber-500', badge: 'amber' },
  vacant: { card: 'bg-sky-50/30 border-sky-100/80 hover:border-sky-300', icon: 'bg-sky-50 text-sky-600', dot: 'bg-sky-500', badge: 'blue' },
  unavailable: { card: 'bg-slate-50/50 border-slate-200 hover:border-slate-300', icon: 'bg-slate-100 text-slate-500', dot: 'bg-slate-400', badge: 'slate' },
  'owner-occupied': { card: 'bg-purple-50/30 border-purple-100/80 hover:border-purple-300', icon: 'bg-purple-50 text-purple-600', dot: 'bg-purple-500', badge: 'purple' }
};

export default function Units({
  units,
  charges,
  payments,
  utilities,
  bookings,
  tenancies,
  expenses,
  unitActivities,
  settings,
  session,
  onUpdateUnit,
  onUpdateTenancy,
  onEvictTenancy,
  onAddUnitActivity,
  onDeleteUnitActivity
}: UnitsProps) {
  const [selected, setSelected] = useState<Unit | null>(null);
  const [editing, setEditing] = useState(false);
  const [printUnit, setPrintUnit] = useState<Unit | null>(null);
  const [logActivityFor, setLogActivityFor] = useState<Unit | null>(null);
  const [editTenancy, setEditTenancy] = useState<Tenancy | null>(null);
  const [evictTenancy, setEvictTenancy] = useState<Tenancy | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const canEdit = !!session.permissions.editUnits;
  // Eviction writes off owed rent, so it is a veto-level action, like reversing a payment.
  const canEvict = !!session.permissions.reversePayments;
  const isAdmin = session.role === 'ADMINISTRATOR';
  const todayStr = today();

  // Keep the open detail view in step with refreshed server data.
  const live = selected ? units.find(u => u.id === selected.id) || null : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="font-display text-xl font-medium text-slate-900">Villaggio Del Sol units register</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {units.length} villa{units.length === 1 ? '' : 's'} on record, with tenancy, billing and meter configuration.
          </p>
        </div>
        {!canEdit && <PermissionNote>Read-only: your role cannot modify the unit register.</PermissionNote>}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-4 text-xs shadow-xs">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-600">Status legend</span>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {UNIT_STATUSES.map(status => (
            <span key={status} className="flex items-center gap-2">
              <span className={`h-3 w-3 shrink-0 rounded-full ${STATUS_STYLES[status].dot}`} />
              <span className="font-medium text-slate-700">{UNIT_STATUS_LABELS[status]}</span>
            </span>
          ))}
        </div>
      </div>

      {units.length === 0 ? (
        <EmptyState title="No villas in the register" icon={<Home className="h-6 w-6" />} />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {units.map(unit => {
            const styles = STATUS_STYLES[unit.status];
            const state = liveUnitState(unit, bookings, todayStr, units);
            const maintCurrency = unit.maintCurrency || unit.currency;
            return (
              <button
                key={unit.id}
                onClick={() => {
                  setSelected(unit);
                  setEditing(false);
                  setError('');
                  setSuccess('');
                }}
                className={`group flex min-h-[210px] cursor-pointer flex-col justify-between rounded-2xl border p-5 text-left shadow-xs transition-all hover:shadow-md ${styles.card}`}
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <span className={`rounded-xl p-3 transition-colors ${styles.icon}`}>
                    <Home className="h-5 w-5" />
                  </span>
                  <Badge tone={styles.badge}>{UNIT_STATUS_LABELS[unit.status]}</Badge>
                </div>
                <div className="mt-4 flex flex-1 flex-col justify-between">
                  <div>
                    <h3 className="font-display text-sm font-semibold text-slate-900">{getUnitDisplayName(unit.number)}</h3>
                    <p className="mt-1 truncate text-xs text-slate-500">Owner: {unit.ownerName}</p>
                    <p className={`mt-0.5 truncate font-mono text-[10px] ${unit.tenantName ? 'font-semibold text-indigo-600' : 'italic text-slate-400'}`}>
                      {unit.tenantName ? `Tenant: ${unit.tenantName}` : 'No tenant on record'}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-slate-400">Now: {state.label}</p>
                  </div>
                  <dl className="mt-2 space-y-1 border-t border-slate-200/60 pt-2 text-xs">
                    {(unit.status === 'long-term' || unit.status === 'short-term') && (
                      <div className="flex items-center justify-between">
                        <dt className="font-mono text-[10px] text-slate-400">{unit.status === 'long-term' ? 'Rent' : 'Nightly'}</dt>
                        <dd className="font-mono font-semibold text-slate-700">
                          {formatMoney(unit.monthlyRent, unit.currency)}
                          <span className="text-[10px] font-normal text-slate-400">{unit.status === 'long-term' ? '/mo' : '/night'}</span>
                        </dd>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <dt className="font-mono text-[10px] text-slate-400">Maintenance</dt>
                      <dd className="font-mono font-semibold text-teal-600">
                        {formatMoney(unit.monthlyMaintenance, maintCurrency)}
                        <span className="text-[10px] font-normal text-slate-400">/mo</span>
                      </dd>
                    </div>
                    <div className="truncate font-mono text-[9px] text-slate-400">Meter: {unit.meterNumber || 'not set'}</div>
                  </dl>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {live && !editing && (
        <UnitDetail
          unit={live}
          charges={charges}
          payments={payments}
          units={units}
          tenancies={tenancies}
          expenses={expenses}
          unitActivities={unitActivities}
          settings={settings}
          canEdit={canEdit}
          canEvict={canEvict}
          onClose={() => setSelected(null)}
          onEdit={() => setEditing(true)}
          onPrint={() => setPrintUnit(live)}
          onEditTenancy={setEditTenancy}
          onEvictTenancy={setEvictTenancy}
          onLogActivity={() => setLogActivityFor(live)}
          onDeleteActivity={async id => {
            try {
              await onDeleteUnitActivity(id);
              setSuccess('Activity entry removed.');
            } catch (err) {
              setError(errorMessage(err, 'Could not remove the activity entry.'));
            }
          }}
        />
      )}

      {live && editing && (
        <UnitEditor
          unit={live}
          settings={settings}
          isAdmin={isAdmin}
          onClose={() => setEditing(false)}
          onSave={async payload => {
            await onUpdateUnit({ ...payload, id: live.id });
            setSuccess('Unit register updated. Any linked payments, readings and reservations were relabelled to match.');
            setError('');
            setEditing(false);
          }}
        />
      )}

      {logActivityFor && (
        <LogActivityModal
          unit={logActivityFor}
          onClose={() => setLogActivityFor(null)}
          onSubmit={async payload => {
            await onAddUnitActivity(payload);
            setSuccess(`Activity logged for ${getUnitDisplayName(logActivityFor.number)}.`);
            setError('');
            setLogActivityFor(null);
          }}
        />
      )}

      {editTenancy && (
        <TenancyEditor
          tenancy={editTenancy}
          onClose={() => setEditTenancy(null)}
          onSave={async fields => {
            await onUpdateTenancy(editTenancy.id, fields);
            setSuccess('Tenancy record updated. The occupancy history is retained in full.');
            setError('');
            setEditTenancy(null);
          }}
        />
      )}

      {evictTenancy && (
        <EvictModal
          tenancy={evictTenancy}
          charges={charges}
          payments={payments}
          units={units}
          onClose={() => setEvictTenancy(null)}
          onSubmit={async payload => {
            const result = await onEvictTenancy(evictTenancy.id, payload);
            setSuccess(
              `${evictTenancy.tenantName} evicted from ${getUnitDisplayName(evictTenancy.unitNumber)}. ` +
                (result.writtenOff > 0
                  ? `${formatMoneyLong(result.writtenOff, result.currency as 'USD' | 'JMD')} of unpaid rent was written off and cleared from the dashboard; the record is kept.`
                  : 'There was no outstanding rent to write off.')
            );
            setError('');
            setEvictTenancy(null);
          }}
        />
      )}

      {printUnit && (
        <UnitLedgerDocument
          unit={printUnit}
          units={units}
          charges={charges}
          payments={payments}
          utilities={utilities}
          bookings={bookings}
          tenancies={tenancies}
          expenses={expenses}
          unitActivities={unitActivities}
          generatedBy={session.name}
          onClose={() => setPrintUnit(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UnitDetail({
  unit,
  charges,
  payments,
  units,
  tenancies,
  expenses,
  unitActivities,
  settings,
  canEdit,
  canEvict,
  onClose,
  onEdit,
  onPrint,
  onEditTenancy,
  onEvictTenancy,
  onLogActivity,
  onDeleteActivity
}: {
  unit: Unit;
  charges: Charge[];
  payments: Payment[];
  units: Unit[];
  tenancies: Tenancy[];
  expenses: Expense[];
  unitActivities: UnitActivity[];
  settings: AppSettings;
  canEdit: boolean;
  canEvict: boolean;
  onClose: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onEditTenancy: (t: Tenancy) => void;
  onEvictTenancy: (t: Tenancy) => void;
  onLogActivity: () => void;
  onDeleteActivity: (id: string) => Promise<void>;
}) {
  const maintCurrency = unit.maintCurrency || unit.currency;
  const rentAccount = accountBalance(unit, 'Rent', charges, payments, undefined, units);
  const maintAccount = accountBalance(unit, 'Maintenance', charges, payments, undefined, units);
  const activities = unitActivities.filter(a => a.unitId === unit.id);
  const unitExpenses = expensesForUnit(expenses, unit, units).sort((a, b) => (b.datePaid || b.date).localeCompare(a.datePaid || a.date));
  const unitTenancies = tenancies
    .filter(t => t.unitId === unit.id)
    .sort((a, b) => (b.startedOn || '').localeCompare(a.startedOn || '') || b.recordedAt.localeCompare(a.recordedAt));

  return (
    <Modal title={getUnitDisplayName(unit.number)} subtitle={UNIT_STATUS_LABELS[unit.status]} onClose={onClose} maxWidthClass="max-w-lg">
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl bg-slate-50 p-3.5">
            <span className="block font-mono text-[10px] text-slate-400">OCCUPANCY STATUS</span>
            <span className="mt-1 block text-xs font-semibold text-slate-700">{UNIT_STATUS_LABELS[unit.status]}</span>
          </div>
          <div className="rounded-xl bg-slate-50 p-3.5">
            <span className="block font-mono text-[10px] text-slate-400">UTILITY METER</span>
            <span className="mt-1 block font-mono text-xs font-semibold text-slate-700">{unit.meterNumber || 'Not configured'}</span>
          </div>
        </div>

        <section className="space-y-3">
          <h4 className="border-b border-slate-100 pb-1 font-mono text-xs uppercase tracking-wider text-slate-400">Registered owner</h4>
          <ContactBlock name={unit.ownerName} email={unit.ownerEmail} phone={unit.ownerPhone} />
          {unit.ownerEmergencyName && (
            <EmergencyBlock
              tone="rose"
              label="Owner emergency contact"
              name={unit.ownerEmergencyName}
              phone={unit.ownerEmergencyPhone}
              email={unit.ownerEmergencyEmail}
            />
          )}
        </section>

        {unit.status === 'long-term' && (
          <section className="space-y-3">
            <h4 className="border-b border-slate-100 pb-1 font-mono text-xs uppercase tracking-wider text-slate-400">Tenant</h4>
            <ContactBlock name={unit.tenantName || 'None on record'} email={unit.tenantEmail} phone={unit.tenantPhone} />
            {unit.tenantEmergencyName && (
              <EmergencyBlock
                tone="indigo"
                label="Tenant emergency contact"
                name={unit.tenantEmergencyName}
                phone={unit.tenantEmergencyPhone}
                email={unit.tenantEmergencyEmail}
              />
            )}
          </section>
        )}

        <section className="space-y-3">
          <h4 className="border-b border-slate-100 pb-1 font-mono text-xs uppercase tracking-wider text-slate-400">
            Occupancy history ({unitTenancies.length})
          </h4>
          {unitTenancies.length === 0 ? (
            <EmptyState
              title="No tenancy recorded for this villa"
              hint="A tenancy opens automatically when a tenant is entered on a long-term lease, and is kept permanently once closed."
            />
          ) : (
            <ul className="space-y-2">
              {unitTenancies.map(tenancy => (
                <li
                  key={tenancy.id}
                  className={`rounded-xl border p-3 text-xs ${
                    tenancy.status === 'active' ? 'border-indigo-100 bg-indigo-50/40' : 'border-slate-100 bg-slate-50'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-slate-900">{tenancy.tenantName}</span>
                        {tenancy.status === 'active' ? <Badge tone="green">Current</Badge> : <Badge tone="slate">Past</Badge>}
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-slate-500">
                        {tenancy.startedOn ? formatDayLabel(tenancy.startedOn) : 'move-in date not recorded'}
                        {' → '}
                        {tenancy.endedOn ? formatDayLabel(tenancy.endedOn) : 'present'}
                        {' · '}
                        {formatMoneyLong(tenancy.monthlyRent, tenancy.currency)}/month
                      </p>
                      {(tenancy.tenantEmail || tenancy.tenantPhone) && (
                        <p className="mt-0.5 text-[10px] text-slate-500">
                          {[tenancy.tenantEmail, tenancy.tenantPhone].filter(Boolean).join(' • ')}
                        </p>
                      )}
                      {tenancy.endReason && <p className="mt-0.5 text-[10px] italic text-slate-500">{tenancy.endReason}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => onEditTenancy(tenancy)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          {tenancy.status === 'active' ? 'Record move-out' : 'Correct dates'}
                        </button>
                      )}
                      {tenancy.status === 'active' && canEvict && (
                        <button
                          type="button"
                          onClick={() => onEvictTenancy(tenancy)}
                          className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[10px] font-medium text-red-600 hover:bg-red-50"
                        >
                          Evict tenant
                        </button>
                      )}
                      {tenancy.evicted && <Badge tone="red">Evicted</Badge>}
                      {tenancy.writeOffAmount !== undefined && tenancy.writeOffAmount > 0 && tenancy.writeOffCurrency && (
                        <span className="text-[9px] font-mono text-red-600">
                          {formatMoneyLong(tenancy.writeOffAmount, tenancy.writeOffCurrency)} written off
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="font-mono text-[10px] leading-relaxed text-slate-400">
            Tenancies are never deleted. Changing the tenant or taking the villa off a long-term lease closes the
            current period and keeps it here, together with every receipt issued to that tenant.
          </p>
        </section>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <BillingCard
            title={unit.status === 'short-term' ? 'Nightly charge' : 'Monthly rent'}
            amount={unit.monthlyRent}
            currency={unit.currency}
            fxRate={settings.fxRateJmdPerUsd}
            dueNote={unit.status === 'long-term' ? `Due on the ${unit.rentDueDay || 1}${ordinal(unit.rentDueDay || 1)} of each month` : undefined}
            balance={unit.status === 'long-term' ? rentAccount.balance : undefined}
            balanceCurrency={rentAccount.currency}
            status={rentAccount.status}
          />
          <BillingCard
            title="Monthly HOA maintenance"
            amount={unit.monthlyMaintenance}
            currency={maintCurrency}
            fxRate={settings.fxRateJmdPerUsd}
            dueNote={`Due on the ${unit.maintDueDay || 1}${ordinal(unit.maintDueDay || 1)} of each month`}
            balance={unit.status !== 'unavailable' ? maintAccount.balance : undefined}
            balanceCurrency={maintAccount.currency}
            status={maintAccount.status}
          />
        </div>

        {unit.notes && (
          <div className="text-xs">
            <span className="block font-mono text-[10px] uppercase text-slate-400">Administrative notes</span>
            <p className="mt-1 rounded-xl bg-slate-50 p-3 italic leading-relaxed text-slate-600">{unit.notes}</p>
          </div>
        )}

        <section className="space-y-3 border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between">
            <h4 className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wider text-slate-700">
              <ClipboardList className="h-4 w-4 text-teal-600" />
              Resident &amp; property activity
            </h4>
            <button
              type="button"
              onClick={onLogActivity}
              className="flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white shadow-xs transition-all hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" />
              Log activity
            </button>
          </div>

          {activities.length === 0 ? (
            <EmptyState title={`No activity logged for ${getUnitDisplayName(unit.number)}`} hint="Record construction work, amenity bookings, notices or maintenance requests here." />
          ) : (
            <ul className="max-h-60 space-y-2 overflow-y-auto pr-1">
              {activities.map(activity => (
                <li key={activity.id} className="space-y-1.5 rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="teal">{activity.activityType}</Badge>
                      <span className="font-semibold text-slate-800">
                        {activity.residentName} ({activity.residentRole})
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-slate-100 bg-white px-2 py-0.5 font-mono text-[10px] font-medium text-slate-500">
                        {formatDayLabel(activity.dateCaptured)}
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm('Remove this activity entry? The removal is recorded in the audit trail.')) {
                              void onDeleteActivity(activity.id);
                            }
                          }}
                          className="p-0.5 text-slate-300 transition-colors hover:text-red-600"
                          title="Remove activity entry"
                          aria-label="Remove activity entry"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="rounded-lg border border-slate-100 bg-white p-2.5 leading-relaxed text-slate-700">{activity.notes}</p>
                  <p className="font-mono text-[9px] text-slate-400">
                    Logged by {activity.loggedBy} on {formatDayLabel(activity.loggedAt.substring(0, 10))}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h4 className="border-b border-slate-100 pb-1 font-mono text-xs uppercase tracking-wider text-slate-400">
            Expenses charged to this villa ({unitExpenses.length})
          </h4>
          {unitExpenses.length === 0 ? (
            <EmptyState title="No expenses recorded against this villa" hint="Expenses allocated to this villa in the Expense register appear here." />
          ) : (
            <ul className="space-y-2">
              {unitExpenses.map(expense => (
                <li key={expense.id} className="flex items-start justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="slate">{expense.category}</Badge>
                      <span className="font-semibold text-slate-800">{expense.vendor}</span>
                      {expense.status === 'pending' ? <Badge tone="amber">Pending</Badge> : <Badge tone="green">Paid</Badge>}
                    </div>
                    {expense.description && <p className="mt-1 leading-relaxed text-slate-600">{expense.description}</p>}
                    <p className="mt-0.5 font-mono text-[10px] text-slate-400">{formatDayLabel(expense.datePaid || expense.date)}{expense.reference ? ` · ${expense.reference}` : ''}</p>
                  </div>
                  <span className="shrink-0 font-mono font-semibold text-slate-800">{formatMoney(expense.amount, expense.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-col gap-2.5 border-t border-slate-100 pt-4">
          <SubmitButton type="button" onClick={onPrint} className="w-full">
            <Printer className="h-3.5 w-3.5" />
            Print unit ledger
          </SubmitButton>
          <div className="flex gap-3">
            {canEdit ? (
              <button
                type="button"
                onClick={onEdit}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-900 py-2.5 text-xs font-medium text-white transition-all hover:bg-slate-800"
              >
                <Edit3 className="h-3.5 w-3.5" />
                Modify unit settings
              </button>
            ) : (
              <div className="flex-1">
                <PermissionNote>Editing the unit register requires additional permission.</PermissionNote>
              </div>
            )}
            <SecondaryButton onClick={onClose}>Close</SecondaryButton>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ContactBlock({ name, email, phone }: { name: string; email?: string; phone?: string }) {
  return (
    <div className="space-y-2 text-xs">
      <p className="flex items-center gap-2 text-slate-600">
        <User className="h-4 w-4 text-slate-400" />
        <span className="font-semibold text-slate-800">{name}</span>
      </p>
      <p className="flex items-center gap-2 text-slate-600">
        <Mail className="h-4 w-4 text-slate-400" />
        {email ? (
          <a href={`mailto:${email}`} className="underline-offset-2 hover:underline">
            {email}
          </a>
        ) : (
          <span className="text-slate-400">Not recorded</span>
        )}
      </p>
      <p className="flex items-center gap-2 text-slate-600">
        <Phone className="h-4 w-4 text-slate-400" />
        {phone ? (
          <a href={`tel:${phone}`} className="underline-offset-2 hover:underline">
            {phone}
          </a>
        ) : (
          <span className="text-slate-400">Not recorded</span>
        )}
      </p>
    </div>
  );
}

function EmergencyBlock({
  tone,
  label,
  name,
  phone,
  email
}: {
  tone: 'rose' | 'indigo';
  label: string;
  name: string;
  phone?: string;
  email?: string;
}) {
  const styles = tone === 'rose' ? 'bg-rose-50/50 border-rose-100/60 text-rose-700' : 'bg-indigo-50/50 border-indigo-100/60 text-indigo-700';
  return (
    <div className={`space-y-1 rounded-xl border p-2.5 ${styles}`}>
      <span className="block font-mono text-[9px] font-bold uppercase tracking-wider">{label}</span>
      <div className="text-xs font-semibold text-slate-800">{name}</div>
      {(phone || email) && (
        <div className="font-mono text-[10px] text-slate-500">
          {phone}
          {phone && email ? ' • ' : ''}
          {email}
        </div>
      )}
    </div>
  );
}

function BillingCard({
  title,
  amount,
  currency,
  fxRate,
  dueNote,
  balance,
  balanceCurrency,
  status
}: {
  title: string;
  amount: number;
  currency: Currency;
  fxRate: number;
  dueNote?: string;
  balance?: number;
  balanceCurrency: Currency;
  /** From finance.ts, so this card cannot disagree with the ledger. */
  status?: AccountStatus;
}) {
  const other: Currency = currency === 'USD' ? 'JMD' : 'USD';
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-xs">
      <span className="block font-mono text-[10px] font-semibold uppercase text-slate-400">{title}</span>
      <p className="mt-0.5 font-mono text-sm font-bold text-slate-800">{formatMoneyLong(amount, currency)}</p>
      <span className="mt-0.5 block border-b border-slate-50 pb-1 font-mono text-[9px] text-slate-400">
        ≈ {formatMoney(convertIndicative(amount, currency, other, fxRate), other)} {other} (indicative)
      </span>
      {dueNote && <p className="mt-1.5 text-[10px] font-medium text-slate-500">{dueNote}</p>}
      {balance !== undefined && (
        <p
          className={`mt-1.5 font-mono text-[10px] font-semibold ${
            balance > 0
              ? 'text-red-600'
              : balance < 0
                ? 'text-sky-600'
                : status === 'not-billed'
                  ? 'text-amber-600'
                  : status === 'settled'
                    ? 'text-emerald-600'
                    : 'text-slate-500'
          }`}
        >
          {balance > 0
            ? `${formatMoney(balance, balanceCurrency)} outstanding`
            : balance < 0
              ? `${formatMoney(Math.abs(balance), balanceCurrency)} in credit`
              : status === 'not-billed'
                ? 'Not yet billed'
                : status === 'settled'
                  ? 'Account settled'
                  : 'Not billed'}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UnitEditor({
  unit,
  settings,
  isAdmin,
  onClose,
  onSave
}: {
  unit: Unit;
  settings: AppSettings;
  isAdmin: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    number: unit.number,
    status: unit.status,
    currency: unit.currency,
    maintCurrency: unit.maintCurrency || unit.currency,
    ownerName: unit.ownerName,
    ownerEmail: unit.ownerEmail,
    ownerPhone: unit.ownerPhone,
    ownerEmergencyName: unit.ownerEmergencyName || '',
    ownerEmergencyPhone: unit.ownerEmergencyPhone || '',
    ownerEmergencyEmail: unit.ownerEmergencyEmail || '',
    tenantName: unit.tenantName,
    tenantEmail: unit.tenantEmail,
    tenantPhone: unit.tenantPhone,
    tenantEmergencyName: unit.tenantEmergencyName || '',
    tenantEmergencyPhone: unit.tenantEmergencyPhone || '',
    tenantEmergencyEmail: unit.tenantEmergencyEmail || '',
    monthlyRent: String(unit.monthlyRent),
    monthlyMaintenance: String(unit.monthlyMaintenance),
    meterNumber: unit.meterNumber,
    notes: unit.notes || '',
    rentDueDay: unit.rentDueDay || 1,
    maintDueDay: unit.maintDueDay || 1
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(prev => ({ ...prev, [key]: value }));

  const rentApplies = form.status === 'long-term' || form.status === 'short-term';
  const tenantApplies = form.status === 'long-term';
  const renaming = form.number.trim() !== unit.number;
  const currencyChanged = form.currency !== unit.currency || form.maintCurrency !== (unit.maintCurrency || unit.currency);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave({
        ...form,
        number: form.number.trim(),
        monthlyRent: Number(form.monthlyRent) || 0,
        monthlyMaintenance: Number(form.monthlyMaintenance) || 0,
        rentDueDay: Number(form.rentDueDay),
        maintDueDay: Number(form.maintDueDay)
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the unit.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit ${getUnitDisplayName(unit.number)}`}
      onClose={onClose}
      maxWidthClass="max-w-2xl"
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-unit-form" className="flex-1">
            Save changes
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-unit-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        {renaming && (
          <InfoNote tone="amber">
            Renaming this villa from <strong>{unit.number}</strong> to <strong>{form.number.trim()}</strong> will also
            relabel every payment, meter reading, expense, reservation and charge attached to it, so nothing is orphaned.
          </InfoNote>
        )}

        {currencyChanged && (
          <InfoNote tone="amber">
            Changing the billing currency does <strong>not</strong> convert the amounts below — it changes which currency
            they are billed in. Enter the correct figure in the new currency yourself. Charges already posted keep the
            currency they were raised in.
          </InfoNote>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Villa number / name" htmlFor="ue-number" required>
            <input id="ue-number" type="text" value={form.number} onChange={e => set('number', e.target.value)} required className={`${inputClass} font-semibold`} />
          </Field>
          <Field label="Villa status" htmlFor="ue-status" required>
            <select id="ue-status" value={form.status} onChange={e => set('status', e.target.value as UnitStatus)} className={inputClass}>
              {UNIT_STATUSES.map(status => (
                <option key={status} value={status}>
                  {UNIT_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Meter id" htmlFor="ue-meter" hint={isAdmin ? undefined : 'Administrators only.'}>
            <input id="ue-meter" type="text" value={form.meterNumber} disabled={!isAdmin} onChange={e => set('meterNumber', e.target.value)} className={monoInputClass} />
          </Field>
        </div>

        <fieldset className="space-y-3 rounded-xl bg-slate-50 p-4">
          <legend className="font-mono text-[10px] font-semibold uppercase text-slate-400">Registered owner</legend>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Owner name" htmlFor="ue-owner" required>
              <input id="ue-owner" type="text" value={form.ownerName} onChange={e => set('ownerName', e.target.value)} required className={inputClass} />
            </Field>
            <Field label="Email" htmlFor="ue-oemail">
              <input id="ue-oemail" type="email" value={form.ownerEmail} onChange={e => set('ownerEmail', e.target.value)} className={inputClass} />
            </Field>
            <Field label="Phone" htmlFor="ue-ophone">
              <input id="ue-ophone" type="tel" value={form.ownerPhone} onChange={e => set('ownerPhone', e.target.value)} className={inputClass} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 border-t border-slate-200/60 pt-2 md:grid-cols-3">
            <Field label="Emergency contact" htmlFor="ue-oename">
              <input id="ue-oename" type="text" value={form.ownerEmergencyName} onChange={e => set('ownerEmergencyName', e.target.value)} className={inputClass} />
            </Field>
            <Field label="Emergency phone" htmlFor="ue-oephone">
              <input id="ue-oephone" type="tel" value={form.ownerEmergencyPhone} onChange={e => set('ownerEmergencyPhone', e.target.value)} className={inputClass} />
            </Field>
            <Field label="Emergency email" htmlFor="ue-oeemail">
              <input id="ue-oeemail" type="email" value={form.ownerEmergencyEmail} onChange={e => set('ownerEmergencyEmail', e.target.value)} className={inputClass} />
            </Field>
          </div>
        </fieldset>

        {tenantApplies ? (
          <fieldset className="space-y-3 rounded-xl border border-indigo-100/60 bg-indigo-50/50 p-4">
            <legend className="font-mono text-[10px] font-semibold uppercase text-indigo-700">Active tenant</legend>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label="Tenant name" htmlFor="ue-tenant">
                <input id="ue-tenant" type="text" value={form.tenantName} onChange={e => set('tenantName', e.target.value)} className={inputClass} />
              </Field>
              <Field label="Email" htmlFor="ue-temail">
                <input id="ue-temail" type="email" value={form.tenantEmail} onChange={e => set('tenantEmail', e.target.value)} className={inputClass} />
              </Field>
              <Field label="Phone" htmlFor="ue-tphone">
                <input id="ue-tphone" type="tel" value={form.tenantPhone} onChange={e => set('tenantPhone', e.target.value)} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 border-t border-indigo-200/40 pt-2 md:grid-cols-3">
              <Field label="Emergency contact" htmlFor="ue-tename">
                <input id="ue-tename" type="text" value={form.tenantEmergencyName} onChange={e => set('tenantEmergencyName', e.target.value)} className={inputClass} />
              </Field>
              <Field label="Emergency phone" htmlFor="ue-tephone">
                <input id="ue-tephone" type="tel" value={form.tenantEmergencyPhone} onChange={e => set('tenantEmergencyPhone', e.target.value)} className={inputClass} />
              </Field>
              <Field label="Emergency email" htmlFor="ue-teemail">
                <input id="ue-teemail" type="email" value={form.tenantEmergencyEmail} onChange={e => set('tenantEmergencyEmail', e.target.value)} className={inputClass} />
              </Field>
            </div>
          </fieldset>
        ) : (
          unit.tenantName && (
            <InfoNote tone="amber">
              This villa is not on a long-term lease, so tenant details are not billed or displayed. Saving with this
              status will clear the stored tenant contact ({unit.tenantName}). Past payments and receipts for that
              tenant are unaffected and remain in the ledger.
            </InfoNote>
          )
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <fieldset className="space-y-3 rounded-xl border border-slate-100 p-4">
            <legend className="font-mono text-[10px] font-semibold uppercase text-slate-400">
              {form.status === 'short-term' ? 'Nightly rate' : 'Monthly rent'}
            </legend>
            {rentApplies ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Amount" htmlFor="ue-rent">
                    <input id="ue-rent" type="number" min="0" step="0.01" value={form.monthlyRent} onChange={e => set('monthlyRent', e.target.value)} className={monoInputClass} />
                  </Field>
                  <Field label="Currency" htmlFor="ue-rentcur">
                    <select id="ue-rentcur" value={form.currency} onChange={e => set('currency', e.target.value as Currency)} className={inputClass}>
                      <option value="JMD">JMD (J$)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </Field>
                </div>
                <p className="font-mono text-[9px] text-slate-400">
                  ≈{' '}
                  {formatMoney(
                    convertIndicative(Number(form.monthlyRent) || 0, form.currency, form.currency === 'USD' ? 'JMD' : 'USD', settings.fxRateJmdPerUsd),
                    form.currency === 'USD' ? 'JMD' : 'USD'
                  )}{' '}
                  indicative
                </p>
                {form.status === 'long-term' && (
                  <Field label="Rent due day" htmlFor="ue-rentday">
                    <select id="ue-rentday" value={form.rentDueDay} onChange={e => set('rentDueDay', Number(e.target.value))} className={monoInputClass}>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                        <option key={d} value={d}>
                          Day {d}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </>
            ) : (
              <p className="rounded-lg bg-slate-100 p-2.5 font-mono text-[11px] text-slate-500">
                Not billed while the villa is {UNIT_STATUS_LABELS[form.status].toLowerCase()}.
              </p>
            )}
          </fieldset>

          <fieldset className="space-y-3 rounded-xl border border-slate-100 p-4">
            <legend className="font-mono text-[10px] font-semibold uppercase text-slate-400">Monthly HOA maintenance</legend>
            {form.status !== 'unavailable' ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Amount" htmlFor="ue-maint">
                    <input id="ue-maint" type="number" min="0" step="0.01" value={form.monthlyMaintenance} onChange={e => set('monthlyMaintenance', e.target.value)} className={monoInputClass} />
                  </Field>
                  <Field label="Currency" htmlFor="ue-maintcur">
                    <select id="ue-maintcur" value={form.maintCurrency} onChange={e => set('maintCurrency', e.target.value as Currency)} className={inputClass}>
                      <option value="JMD">JMD (J$)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </Field>
                </div>
                <p className="font-mono text-[9px] text-slate-400">
                  ≈{' '}
                  {formatMoney(
                    convertIndicative(
                      Number(form.monthlyMaintenance) || 0,
                      form.maintCurrency,
                      form.maintCurrency === 'USD' ? 'JMD' : 'USD',
                      settings.fxRateJmdPerUsd
                    ),
                    form.maintCurrency === 'USD' ? 'JMD' : 'USD'
                  )}{' '}
                  indicative
                </p>
                <Field label="Maintenance due day" htmlFor="ue-maintday">
                  <select id="ue-maintday" value={form.maintDueDay} onChange={e => set('maintDueDay', Number(e.target.value))} className={monoInputClass}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                      <option key={d} value={d}>
                        Day {d}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              <p className="rounded-lg bg-slate-100 p-2.5 font-mono text-[11px] text-slate-500">
                Villas marked Unavailable are not billed for maintenance.
              </p>
            )}
          </fieldset>
        </div>

        <Field label="Administrative notes" htmlFor="ue-notes">
          <textarea id="ue-notes" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function EvictModal({
  tenancy,
  charges,
  payments,
  units,
  onClose,
  onSubmit
}: {
  tenancy: Tenancy;
  charges: Charge[];
  payments: Payment[];
  units: Unit[];
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(today());
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Preview the rent that would be written off: open rent charges for the unit in
  // the tenancy's currency, minus rent already received. Mirrors the server.
  const unit = units.find(u => u.id === tenancy.unitId);
  const account = unit ? accountBalance(unit, 'Rent', charges, payments, undefined, units) : null;
  const writeOff = account && account.balance > 0 ? account.balance : 0;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (reason.trim().length < 5) {
      setError('Give a reason of at least 5 characters. It is stored permanently in the record.');
      return;
    }
    if (!confirmed) {
      setError('Please confirm you understand the outstanding rent will be written off.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({ reason: reason.trim(), effectiveDate });
    } catch (err) {
      setError(errorMessage(err, 'Could not process the eviction.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Evict tenant"
      subtitle={`${tenancy.tenantName} — ${getUnitDisplayName(tenancy.unitNumber)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <button
            type="submit"
            form="vds-evict-form"
            disabled={busy}
            className="flex-1 rounded-xl bg-red-600 py-2.5 text-xs font-medium text-white transition-all hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? 'Processing…' : 'Evict and write off'}
          </button>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-evict-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <InfoNote tone="amber">
          Recording an eviction ends this tenancy, frees the villa, and <strong>writes off the tenant&apos;s unpaid
          rent</strong> so it stops appearing on the dashboard and in the notifications hub. Nothing is deleted — the
          tenancy, the receipts, and the written-off amount stay in the record and audit trail as bad debt.
        </InfoNote>

        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-center">
          <span className="block font-mono text-[10px] uppercase text-red-700">Rent to be written off</span>
          <span className="font-mono text-lg font-bold text-red-700">
            {writeOff > 0 ? formatMoneyLong(writeOff, tenancy.currency) : `${formatMoneyLong(0, tenancy.currency)} — nothing outstanding`}
          </span>
        </div>

        <Field label="Effective date of eviction" htmlFor="ev-date" required>
          <input id="ev-date" type="date" value={effectiveDate} max={today()} onChange={e => setEffectiveDate(e.target.value)} required className={monoInputClass} />
        </Field>

        <Field label="Reason / reference" htmlFor="ev-reason" required hint="e.g. Non-payment of rent for 3 months; notice served 2026-05-01; court order VDS-2026-14.">
          <textarea id="ev-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)} required className={inputClass} />
        </Field>

        <label className="flex items-start gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-0.5" />
          <span>I have the authority to evict this tenant and understand the outstanding rent will be written off as bad debt.</span>
        </label>
      </form>
    </Modal>
  );
}

function TenancyEditor({
  tenancy,
  onClose,
  onSave
}: {
  tenancy: Tenancy;
  onClose: () => void;
  onSave: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const closing = tenancy.status === 'active';
  const [startedOn, setStartedOn] = useState(tenancy.startedOn || '');
  const [endedOn, setEndedOn] = useState(tenancy.endedOn || (closing ? today() : ''));
  const [endReason, setEndReason] = useState(tenancy.endReason || '');
  const [recordEnd, setRecordEnd] = useState(!closing);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (recordEnd && startedOn && endedOn && endedOn < startedOn) {
      setError('The move-out date cannot fall before the move-in date.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave({
        startedOn,
        ...(recordEnd ? { endedOn, endReason } : {})
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not update the tenancy record.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={closing ? 'Record move-out' : 'Correct tenancy dates'}
      subtitle={`${tenancy.tenantName} — ${getUnitDisplayName(tenancy.unitNumber)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-tenancy-form" className="flex-1">
            Save tenancy record
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-tenancy-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <InfoNote>
          Record the dates the tenant actually moved in and out, not the date the paperwork was done. Receipts already
          issued to {tenancy.tenantName} are unaffected and stay in the ledger either way.
        </InfoNote>

        <Field
          label="Move-in date"
          htmlFor="tn-start"
          hint={tenancy.startedOn ? undefined : 'Not recorded — this tenancy predates occupancy tracking.'}
        >
          <input id="tn-start" type="date" value={startedOn} max={today()} onChange={e => setStartedOn(e.target.value)} className={monoInputClass} />
        </Field>

        {closing && (
          <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <input type="checkbox" checked={recordEnd} onChange={e => setRecordEnd(e.target.checked)} className="mt-0.5" />
            <span>
              <strong>Close this tenancy.</strong> The villa is marked vacant and the current tenant fields are cleared,
              but this record and all their receipts are kept permanently.
            </span>
          </label>
        )}

        {recordEnd && (
          <>
            <Field label="Move-out date" htmlFor="tn-end" required>
              <input id="tn-end" type="date" value={endedOn} min={startedOn || undefined} onChange={e => setEndedOn(e.target.value)} required className={monoInputClass} />
            </Field>
            <Field label="Reason" htmlFor="tn-reason" hint="e.g. Lease expired and not renewed; moved to Kingston.">
              <textarea id="tn-reason" rows={2} value={endReason} onChange={e => setEndReason(e.target.value)} className={inputClass} />
            </Field>
          </>
        )}
      </form>
    </Modal>
  );
}

function LogActivityModal({
  unit,
  onClose,
  onSubmit
}: {
  unit: Unit;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [activityType, setActivityType] = useState<UnitActivity['activityType']>('Construction Work');
  const [residentName, setResidentName] = useState(unit.tenantName || unit.ownerName || '');
  const [residentRole, setResidentRole] = useState<UnitActivity['residentRole']>(unit.tenantName ? 'Tenant' : 'Owner');
  const [dateCaptured, setDateCaptured] = useState(today());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ unitId: unit.id, activityType, residentName, residentRole, dateCaptured, notes });
    } catch (err) {
      setError(errorMessage(err, 'Could not record the activity.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Log resident activity"
      subtitle={`${getUnitDisplayName(unit.number)} — ${unit.ownerName}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Recording…" form="vds-activity-form" className="flex-1">
            Save activity entry
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-activity-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <Field label="Activity category" htmlFor="la-type" required>
          <select id="la-type" value={activityType} onChange={e => setActivityType(e.target.value as UnitActivity['activityType'])} className={inputClass}>
            <option value="Construction Work">Construction work / renovation</option>
            <option value="Pool Reservation">Pool &amp; gazebo reservation</option>
            <option value="Maintenance Request">Resident maintenance request</option>
            <option value="Noise / Event Notice">Noise / event notice</option>
            <option value="Amenity Access">Amenity access / guest pass</option>
            <option value="Other Activity">Other activity / note</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Resident name" htmlFor="la-name" required>
            <input id="la-name" type="text" value={residentName} onChange={e => setResidentName(e.target.value)} required className={inputClass} />
          </Field>
          <Field label="Capacity" htmlFor="la-role" required>
            <select id="la-role" value={residentRole} onChange={e => setResidentRole(e.target.value as UnitActivity['residentRole'])} className={inputClass}>
              <option value="Owner">Property owner</option>
              <option value="Tenant">Long-term tenant</option>
              <option value="Guest">Short-term guest</option>
              <option value="Other">Other / contractor</option>
            </select>
          </Field>
        </div>

        <Field label="Date captured" htmlFor="la-date" required>
          <input id="la-date" type="date" value={dateCaptured} onChange={e => setDateCaptured(e.target.value)} required className={monoInputClass} />
        </Field>

        <Field label="Details" htmlFor="la-notes" required>
          <textarea
            id="la-notes"
            rows={3}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            required
            placeholder="e.g. Balcony tiling approved. Work hours 9am–4pm weekdays. Contractor: J&R Builders."
            className={inputClass}
          />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function UnitLedgerDocument({
  unit,
  units,
  charges,
  payments,
  utilities,
  bookings,
  tenancies,
  expenses,
  unitActivities,
  generatedBy,
  onClose
}: {
  unit: Unit;
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  utilities: UtilityReading[];
  bookings: Booking[];
  tenancies: Tenancy[];
  expenses: Expense[];
  unitActivities: UnitActivity[];
  generatedBy: string;
  onClose: () => void;
}) {
  const unitPayments = useMemo(
    () => paymentsForUnit(payments, unit, units).sort((a, b) => a.date.localeCompare(b.date)),
    [payments, unit, units]
  );
  const unitUtilities = useMemo(
    () => utilitiesForUnit(utilities, unit, units).sort((a, b) => a.billingPeriod.localeCompare(b.billingPeriod)),
    [utilities, unit, units]
  );
  const unitBookings = useMemo(
    () => bookingsForUnit(bookings, unit, units).sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
    [bookings, unit, units]
  );
  const unitExpenses = useMemo(
    () => expensesForUnit(expenses, unit, units).sort((a, b) => (a.datePaid || a.date).localeCompare(b.datePaid || b.date)),
    [expenses, unit, units]
  );
  const activities = unitActivities.filter(a => a.unitId === unit.id);
  const rent = accountBalance(unit, 'Rent', charges, payments, undefined, units);
  const maint = accountBalance(unit, 'Maintenance', charges, payments, undefined, units);

  return (
    <PrintPortal title={`Unit ledger — ${getUnitDisplayName(unit.number)}`} onClose={onClose} maxWidthClass="max-w-4xl">
      <PrintLetterhead documentTitle="Unit Activity Ledger" meta={getUnitDisplayName(unit.number)} generatedBy={generatedBy} />

      <section className="mb-6 grid grid-cols-2 gap-4 rounded-xl border border-slate-300 p-4 text-xs md:grid-cols-4">
        {[
          ['Villa', getUnitDisplayName(unit.number)],
          ['Registered owner', unit.ownerName],
          ['Occupancy', unit.status === 'long-term' ? `${unit.tenantName || 'Tenant'} (tenant)` : UNIT_STATUS_LABELS[unit.status]],
          ['Meter id', unit.meterNumber || 'Not configured']
        ].map(([label, value]) => (
          <div key={label}>
            <span className="block font-mono text-[9px] uppercase text-slate-500">{label}</span>
            <span className="text-xs font-semibold text-slate-900">{value}</span>
          </div>
        ))}
      </section>

      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {[
          { title: 'Rent account', account: rent, show: unit.status === 'long-term' || rent.charged > 0 },
          { title: 'HOA maintenance account', account: maint, show: unit.status !== 'unavailable' || maint.charged > 0 }
        ]
          .filter(row => row.show)
          .map(row => (
            <dl key={row.title} className="space-y-1 rounded-xl border border-slate-300 p-3 text-xs">
              <p className="mb-1 font-mono text-[9px] font-bold uppercase text-slate-500">{row.title}</p>
              <div className="flex justify-between gap-3">
                <dt>Total billed</dt>
                <dd className="font-mono font-semibold">{formatMoney(row.account.charged, row.account.currency)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Total received</dt>
                <dd className="font-mono font-semibold">{formatMoney(row.account.paid, row.account.currency)}</dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-slate-300 pt-1 font-bold">
                <dt>Balance ({row.account.currency})</dt>
                <dd className="font-mono">{formatMoney(row.account.balance, row.account.currency)}</dd>
              </div>
            </dl>
          ))}
      </section>

      {tenancies.filter(t => t.unitId === unit.id).length > 0 && (
        <PrintSection title="I. Occupancy history">
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Tenant</th>
                  <th className="p-2">Moved in</th>
                  <th className="p-2">Moved out</th>
                  <th className="p-2 text-right">Rent agreed</th>
                  <th className="p-2">Contact</th>
                  <th className="p-2">Reason ended</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {tenancies
                  .filter(t => t.unitId === unit.id)
                  .sort((a, b) => (b.startedOn || '').localeCompare(a.startedOn || ''))
                  .map(t => (
                    <tr key={t.id}>
                      <td className="p-2 font-sans font-semibold">{t.tenantName}</td>
                      <td className="p-2">{t.startedOn ? formatDayLabel(t.startedOn) : 'not recorded'}</td>
                      <td className="p-2">{t.endedOn ? formatDayLabel(t.endedOn) : 'present'}</td>
                      <td className="p-2 text-right">{formatMoney(t.monthlyRent, t.currency)} {t.currency}</td>
                      <td className="p-2 font-sans">{[t.tenantEmail, t.tenantPhone].filter(Boolean).join(' • ') || '—'}</td>
                      <td className="p-2 font-sans">{t.endReason || '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TableScroller>
        </PrintSection>
      )}

      <PrintSection title="II. Payments received">
        {unitPayments.length === 0 ? (
          <p className="text-xs italic text-slate-500">No payments recorded for this villa.</p>
        ) : (
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Date</th>
                  <th className="p-2">Receipt</th>
                  <th className="p-2">Category</th>
                  <th className="p-2">Payer</th>
                  <th className="p-2">Method</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {unitPayments.map(p => (
                  <tr key={p.id} className={p.status === 'reversed' ? 'text-slate-500 line-through' : ''}>
                    <td className="p-2">{formatDayLabel(p.date)}</td>
                    <td className="p-2 font-semibold">{p.receiptNo}</td>
                    <td className="p-2">{p.category}</td>
                    <td className="p-2">{p.payerName}</td>
                    <td className="p-2">{p.method}</td>
                    <td className="p-2 uppercase">{p.status === 'reversed' ? 'VOID' : 'OK'}</td>
                    <td className="p-2 text-right font-semibold">{formatMoney(p.amount, p.currency)} {p.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </PrintSection>

      <PrintSection title="III. Utility meter readings">
        {unitUtilities.length === 0 ? (
          <p className="text-xs italic text-slate-500">No meter readings recorded for this villa.</p>
        ) : (
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Period</th>
                  <th className="p-2 text-right">Previous</th>
                  <th className="p-2 text-right">Current</th>
                  <th className="p-2 text-right">Consumption</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Charged</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {unitUtilities.map(u => (
                  <tr key={u.id}>
                    <td className="p-2 font-semibold">{formatMonthLabel(u.billingPeriod)}</td>
                    <td className="p-2 text-right">{u.previousReading.toLocaleString()}</td>
                    <td className="p-2 text-right">{u.currentReading.toLocaleString()}</td>
                    <td className="p-2 text-right font-semibold">{u.consumption.toLocaleString()}</td>
                    <td className="p-2 uppercase">{u.status}</td>
                    <td className="p-2 text-right font-semibold">{formatMoney(u.amountCharged, u.currency)} {u.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </PrintSection>

      {unitExpenses.length > 0 && (
        <PrintSection title="IV. Expenses charged to this villa">
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Date</th>
                  <th className="p-2">Vendor</th>
                  <th className="p-2">Category</th>
                  <th className="p-2">Description</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {unitExpenses.map(e => (
                  <tr key={e.id}>
                    <td className="p-2">{formatDayLabel(e.datePaid || e.date)}</td>
                    <td className="p-2 font-sans font-semibold">{e.vendor}</td>
                    <td className="p-2">{e.category}</td>
                    <td className="p-2 font-sans">{e.description || '—'}</td>
                    <td className="p-2 uppercase">{e.status}</td>
                    <td className="p-2 text-right font-semibold">{formatMoney(e.amount, e.currency)} {e.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </PrintSection>
      )}

      {unitBookings.length > 0 && (
        <PrintSection title="V. Guest reservations">
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Guest</th>
                  <th className="p-2">Arrival</th>
                  <th className="p-2">Departure</th>
                  <th className="p-2 text-right">Nights</th>
                  <th className="p-2">Channel</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Stay value</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {unitBookings.map(b => (
                  <tr key={b.id}>
                    <td className="p-2 font-semibold">{b.guestName}</td>
                    <td className="p-2">{formatDayLabel(b.checkIn)}</td>
                    <td className="p-2">{formatDayLabel(b.checkOut)}</td>
                    <td className="p-2 text-right">{nightsBetween(b.checkIn, b.checkOut)}</td>
                    <td className="p-2">{b.source}</td>
                    <td className="p-2 uppercase">{b.status}</td>
                    <td className="p-2 text-right font-semibold">{formatMoney(b.amount, b.currency)} {b.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </PrintSection>
      )}

      {activities.length > 0 && (
        <PrintSection title="VI. Resident &amp; property activity">
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Date</th>
                  <th className="p-2">Activity</th>
                  <th className="p-2">Resident</th>
                  <th className="p-2">Details</th>
                  <th className="p-2">Logged by</th>
                </tr>
              </thead>
              <tbody>
                {activities.map(a => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap p-2 font-mono font-semibold">{formatDayLabel(a.dateCaptured)}</td>
                    <td className="p-2 font-mono uppercase">{a.activityType}</td>
                    <td className="whitespace-nowrap p-2">{a.residentName} ({a.residentRole})</td>
                    <td className="p-2">{a.notes}</td>
                    <td className="whitespace-nowrap p-2 font-mono">{a.loggedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </PrintSection>
      )}

      <PrintSignatures left="Authorised Property Officer" right="Owner / Tenant Acknowledgement" />
    </PrintPortal>
  );
}

function PrintSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 space-y-2 break-inside-avoid">
      <h3 className="border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider text-slate-900">{title}</h3>
      {children}
    </section>
  );
}
