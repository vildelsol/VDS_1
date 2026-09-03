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
  WORK_STATUSES,
  WorkStatus,
  UtilityReading,
  getUnitDisplayName
} from '../types';
import {
  AccountBalance,
  AccountStatus,
  accountBalance,
  chargeCurrency,
  entitlementShare,
  levyProportionality,
  bookingsForUnit,
  chargesForUnit,
  expensesForUnit,
  liveUnitState,
  paymentsForUnit,
  utilitiesForUnit
} from '../lib/finance';
import { convertIndicative, formatMoney, formatMoneyLong, round2, sumMoney } from '../lib/money';
import { formatDayLabel, formatMonthLabel, nightsBetween, today } from '../lib/dates';
import { errorMessage } from '../lib/api';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import ReceivePaymentModal from './ReceivePaymentModal';
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
import { ArrowUpRight, ClipboardList, Edit3, Home, Mail, Phone, Plus, Printer, Trash2, User } from 'lucide-react';

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
  onUpdateUnitActivity: (id: string, fields: Record<string, unknown>) => Promise<unknown>;
  onDeleteUnitActivity: (id: string) => Promise<unknown>;
  onRecordPayment: (payload: Record<string, unknown>) => Promise<Payment>;
  onTakeDeposit: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
  onSettleDeposit: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
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
  onUpdateUnitActivity,
  onDeleteUnitActivity,
  onRecordPayment,
  onTakeDeposit,
  onSettleDeposit
}: UnitsProps) {
  const [selected, setSelected] = useState<Unit | null>(null);
  const [editing, setEditing] = useState(false);
  const [printUnit, setPrintUnit] = useState<Unit | null>(null);
  const [logActivityFor, setLogActivityFor] = useState<Unit | null>(null);
  const [editTenancy, setEditTenancy] = useState<Tenancy | null>(null);
  const [evictTenancy, setEvictTenancy] = useState<Tenancy | null>(null);
  const [printTenancy, setPrintTenancy] = useState<Tenancy | null>(null);
  const [workOrder, setWorkOrder] = useState<UnitActivity | null>(null);
  const [depositFor, setDepositFor] = useState<Tenancy | null>(null);
  const [payTarget, setPayTarget] = useState<AccountBalance | null>(null);
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
        // One column on a phone. Two columns gave each villa card about 160px,
        // which was not enough for the figures it carries — "J$25,000.00/mo"
        // overflowed its card by up to 49px with nothing to scroll, so the rent
        // and maintenance rates were simply cut off. Two columns return as soon
        // as there is room for them.
        <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4">
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
          onPrintTenancy={setPrintTenancy}
          onManageWork={setWorkOrder}
          onManageDeposit={setDepositFor}
          onReceivePayment={session.permissions.recordPayments ? setPayTarget : undefined}
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
          charges={charges}
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

      {depositFor && (
        <DepositModal
          tenancy={depositFor}
          onClose={() => setDepositFor(null)}
          onTake={async payload => {
            await onTakeDeposit(depositFor.id, payload);
            setSuccess('Security deposit recorded. It is held on the tenant\u2019s behalf and affects no balance.');
            setError('');
            setDepositFor(null);
          }}
          onSettle={async payload => {
            await onSettleDeposit(depositFor.id, payload);
            setSuccess('Deposit reconciled and closed.');
            setError('');
            setDepositFor(null);
          }}
        />
      )}

      {workOrder && (
        <WorkOrderModal
          activity={workOrder}
          canRecordExpense={!!session.permissions.recordExpenses}
          onClose={() => setWorkOrder(null)}
          onSubmit={async fields => {
            await onUpdateUnitActivity(workOrder.id, fields);
            setSuccess('Maintenance request updated.');
            setError('');
            setWorkOrder(null);
          }}
        />
      )}

      {printTenancy && (
        <TenancyRecordDocument
          tenancy={printTenancy}
          unit={units.find(u => u.id === printTenancy.unitId) || null}
          units={units}
          charges={charges}
          payments={payments}
          generatedBy={session.name}
          onClose={() => setPrintTenancy(null)}
        />
      )}

      {payTarget && (
        <ReceivePaymentModal
          units={units}
          charges={charges}
          payments={payments}
          account={payTarget}
          onClose={() => setPayTarget(null)}
          onSubmit={async payload => {
            // Not caught here: the modal reports its own failures, and wrapping
            // the error would throw away the code that tells "already settled by
            // someone else" apart from an ordinary refusal.
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
  onPrintTenancy,
  onLogActivity,
  onDeleteActivity,
  onManageWork,
  onManageDeposit,
  onReceivePayment
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
  onPrintTenancy: (t: Tenancy) => void;
  onLogActivity: () => void;
  onDeleteActivity: (id: string) => Promise<void>;
  onManageWork: (activity: UnitActivity) => void;
  onManageDeposit: (tenancy: Tenancy) => void;
  /** Absent when the signed-in role may not receive money. */
  onReceivePayment?: (account: AccountBalance) => void;
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
                          {/*
                            Named for what the screen actually does. "Record
                            move-out" described only half of it — the same form
                            sets the move-in date, and closing the tenancy is an
                            optional tick inside it, so the old label read as a
                            one-way action people were wary of opening.
                          */}
                          {tenancy.status === 'active' ? 'Edit tenancy dates' : 'Correct dates'}
                        </button>
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => onManageDeposit(tenancy)}
                          title="Security deposit held for this tenant"
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          {tenancy.depositReturnedOn
                            ? 'Deposit returned'
                            : tenancy.depositAmount
                              ? `Deposit ${formatMoney(tenancy.depositAmount, tenancy.depositCurrency || tenancy.currency)}`
                              : 'Record deposit'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onPrintTenancy(tenancy)}
                        title="Print this tenant's own record"
                        className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
                      >
                        <Printer className="h-3 w-3" /> Print tenant record
                      </button>
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
            onReceive={onReceivePayment ? () => onReceivePayment(rentAccount) : undefined}
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
            onReceive={onReceivePayment ? () => onReceivePayment(maintAccount) : undefined}
          />
        </div>

        {/* The levy is supposed to follow the entitlement on the strata plan. This
            states the relationship outright, because "is my levy fair?" is the
            question a proprietor brings to an annual general meeting, and the
            register previously had no answer beyond "somebody typed it". */}
        <EntitlementNote unit={unit} units={units} />

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
                      {activity.workStatus && (
                        <Badge
                          tone={
                            activity.workStatus === 'Completed'
                              ? 'green'
                              : activity.workStatus === 'Cancelled'
                                ? 'slate'
                                : activity.workStatus === 'In progress'
                                  ? 'blue'
                                  : 'amber'
                          }
                        >
                          {activity.workStatus}
                        </Badge>
                      )}
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

                  {activity.activityType === 'Maintenance Request' && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-white p-2.5">
                      <div className="min-w-0 space-y-0.5 font-mono text-[10px] text-slate-500">
                        <p>
                          {activity.assignedTo ? `Assigned to ${activity.assignedTo}` : 'Not assigned to anyone yet'}
                          {activity.completedOn ? ` · closed ${formatDayLabel(activity.completedOn)}` : ''}
                        </p>
                        {activity.costAmount ? (
                          <p className="text-slate-700">
                            Cost {formatMoney(activity.costAmount, activity.costCurrency || 'JMD')}
                            {activity.expenseId ? ' · raised as an expense' : ' · not yet in the expense register'}
                          </p>
                        ) : null}
                        {activity.outcome ? <p className="italic text-slate-600">{activity.outcome}</p> : null}
                      </div>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => onManageWork(activity)}
                          className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Update work
                        </button>
                      )}
                    </div>
                  )}

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
                      {expense.status === 'pending' ? (
                        <Badge tone="amber">Pending</Badge>
                      ) : expense.status === 'paid' ? (
                        <Badge tone="green">Paid</Badge>
                      ) : (
                        <Badge tone="red">Taken back</Badge>
                      )}
                    </div>
                    {expense.description && <p className="mt-1 leading-relaxed text-slate-600">{expense.description}</p>}
                    <p className="mt-0.5 font-mono text-[10px] text-slate-400">{formatDayLabel(expense.datePaid || expense.date)}{expense.reference ? ` · ${expense.reference}` : ''}</p>
                    {expense.status === 'void' && (
                      <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
                        Taken back by {expense.voidedBy || 'unknown'}
                        {expense.voidReason ? ` — ${expense.voidReason}` : ''}. In no total.
                      </p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 font-mono font-semibold ${
                      expense.status === 'void' ? 'text-slate-400 line-through' : 'text-slate-800'
                    }`}
                  >
                    {formatMoney(expense.amount, expense.currency)}
                  </span>
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

/**
 * What this lot's entitlement is, what share of the plan that represents, and
 * whether the levy actually billed follows it.
 *
 * Says "not recorded" rather than implying fairness when there is nothing to
 * check against — an absent entitlement is unknown, not proportionate.
 */
function EntitlementNote({ unit, units }: { unit: Unit; units: Unit[] }) {
  const share = entitlementShare(unit, units);
  const row = levyProportionality(units).find(r => r.unit.id === unit.id);

  if (typeof unit.entitlement !== 'number') {
    return (
      <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
        <span className="font-semibold">No unit entitlement recorded.</span> Contributions are levied in proportion to entitlement, so
        until it is entered from the strata plan this villa&rsquo;s levy cannot be shown to be proportionate.
      </div>
    );
  }

  const off = row && row.variancePct > 0.01;
  return (
    <div
      className={`rounded-xl border p-3 text-[11px] leading-relaxed ${
        off ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-100 bg-slate-50 text-slate-600'
      }`}
    >
      <span className="font-semibold">
        Entitlement {unit.entitlement}
        {share !== null ? ` — ${(share * 100).toFixed(2)}% of the plan` : ''}
      </span>
      {unit.strataLotNumber ? <span className="font-mono"> · lot {unit.strataLotNumber}</span> : ''}
      {row && (
        <p className="mt-1">
          {off ? (
            <>
              Levied {formatMoney(row.levied, row.currency)}, against {formatMoney(row.proportionate, row.currency)} if the same total were
              struck strictly by entitlement — {row.variance > 0 ? 'more' : 'less'} than this lot&rsquo;s share by{' '}
              {formatMoney(Math.abs(row.variance), row.currency)}.
            </>
          ) : (
            <>The levy of {formatMoney(row.levied, row.currency)} matches this lot&rsquo;s share of the plan.</>
          )}
        </p>
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
  status,
  onReceive
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
  /** Offered only when this account actually owes something. */
  onReceive?: () => void;
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
      {/* The money can be taken from where the debt is shown. Before this, a
          villa's record stated what was owed and offered no way to accept it —
          you could evict the tenant from here but not receipt their payment. */}
      {onReceive && balance !== undefined && balance > 0 && (
        <button
          type="button"
          onClick={onReceive}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-1.5 text-[10px] font-semibold text-white transition-colors hover:bg-emerald-700"
        >
          <ArrowUpRight className="h-3 w-3" />
          Receive payment
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UnitEditor({
  unit,
  charges,
  settings,
  isAdmin,
  onClose,
  onSave
}: {
  unit: Unit;
  charges: Charge[];
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
    maintDueDay: unit.maintDueDay || 1,
    // Held as strings so the fields can be genuinely empty. An entitlement of ''
    // means "not recorded", which is different from an entitlement of zero.
    entitlement: unit.entitlement === undefined ? '' : String(unit.entitlement),
    strataLotNumber: unit.strataLotNumber || '',
    // Absent means no. A register written before this field existed cannot be
    // assumed to hold VDS's own villas.
    letOnOwnAccount: unit.letOnOwnAccount === true
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Which of the two things a changed tenant name means. Left unset until the
   * question is actually put, so nothing is assumed on the way in — the server
   * refuses a bare change and the answer is only ever one the user gave.
   */
  const [tenantIntent, setTenantIntent] = useState<'correction' | 'changeover' | 'moved-out' | ''>('');
  const [ownerIntent, setOwnerIntent] = useState<'correction' | 'sale' | ''>('');
  /** The day the villa changed hands, asked for only when a sale is declared. */
  const [ownerAcquiredOn, setOwnerAcquiredOn] = useState('');
  /**
   * Acknowledgement that re-denominating this villa voids the charges already
   * open in the currency it is billed in now. Never preselected.
   */
  const [currencyIntent, setCurrencyIntent] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(prev => ({ ...prev, [key]: value }));

  const rentApplies = form.status === 'long-term' || form.status === 'short-term';
  const tenantApplies = form.status === 'long-term';
  const renaming = form.number.trim() !== unit.number;
  const currencyChanged = form.currency !== unit.currency || form.maintCurrency !== (unit.maintCurrency || unit.currency);

  /**
   * Charges that would be left stranded by re-denominating this villa.
   *
   * A balance is per unit, per category, *per currency*, and the two are never
   * combined — so a charge open in the currency the villa is being changed away
   * from stops counting towards anything the moment the change is saved. The
   * villa then shows as owing less than it does, and the next payment in the new
   * currency reads as a credit. This happened on the live books on 2026-09-01,
   * when a villa's maintenance was moved to USD after the owner asked for it and
   * the JMD charges already raised quietly dropped out of the balance.
   *
   * Computed here so the consequence is on screen *before* the save, with the
   * count and the money named, rather than arriving as a server refusal.
   */
  const proposedUnit = { ...unit, currency: form.currency, maintCurrency: form.maintCurrency };
  const strandedCharges = currencyChanged
    ? (['Rent', 'Maintenance'] as const).flatMap(category => {
        const before = chargeCurrency(unit, category);
        const after = chargeCurrency(proposedUnit, category);
        if (before === after) return [];
        return chargesForUnit(charges, unit).filter(
          ch => ch.category === category && ch.status === 'open' && ch.currency === before
        );
      })
    : [];

  /**
   * A different tenant name against a villa that already had one. Asked here
   * rather than after a refusal, because the two answers do different things to
   * the ledger and the choice belongs beside the field being changed.
   */
  const tenantNameChanged =
    tenantApplies &&
    !!unit.tenantName.trim() &&
    !!form.tenantName.trim() &&
    form.tenantName.trim().toLowerCase() !== unit.tenantName.trim().toLowerCase();

  /**
   * The tenant is being taken off the villa — either by clearing the name or by
   * moving it off a long-term lease. The expensive direction: a move-out spends
   * the advance and writes off the final month, and a mis-keyed status should not.
   */
  const tenantRemoved = !!unit.tenantName.trim() && (!tenantApplies || !form.tenantName.trim());

  const ownerNameChanged =
    !!unit.ownerName.trim() &&
    !!form.ownerName.trim() &&
    form.ownerName.trim().toLowerCase() !== unit.ownerName.trim().toLowerCase();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (tenantNameChanged && !tenantIntent) {
      setError('Say whether this is a correction to the name or a new tenant, so the right thing happens to the rent.');
      return;
    }
    if (tenantRemoved && !tenantIntent) {
      setError('Say whether the tenant moved out or was entered by mistake — the two do different things to the rent.');
      return;
    }
    if (ownerNameChanged && !ownerIntent) {
      setError('Say whether the owner name is being corrected or the villa has been sold.');
      return;
    }
    if (strandedCharges.length > 0 && !currencyIntent) {
      setError(
        `${strandedCharges.length} charge(s) are still open in the currency this villa is billed in now. ` +
          'Confirm what happens to them before changing the currency.'
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave({
        ...form,
        number: form.number.trim(),
        monthlyRent: Number(form.monthlyRent) || 0,
        monthlyMaintenance: Number(form.monthlyMaintenance) || 0,
        rentDueDay: Number(form.rentDueDay),
        maintDueDay: Number(form.maintDueDay),
        ...((tenantNameChanged || tenantRemoved) && tenantIntent ? { tenantChangeIntent: tenantIntent } : {}),
        ...(ownerNameChanged && ownerIntent ? { ownerChangeIntent: ownerIntent } : {}),
        ...(ownerNameChanged && ownerIntent === 'sale' && ownerAcquiredOn ? { ownerAcquiredOn } : {}),
        ...(strandedCharges.length > 0 && currencyIntent ? { currencyChangeIntent: 'void-open-charges' } : {})
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
            they are billed in. Enter the correct figure in the new currency yourself.
          </InfoNote>
        )}

        {/*
          * This note used to say charges already posted "keep the currency they
          * were raised in", which is true and was the whole problem: they keep it
          * and stop counting, because a balance never combines two currencies. The
          * villa then reads as owing less than it does. The consequence is now
          * stated with the money named, and the change cannot be saved until it is
          * acknowledged.
          */}
        {strandedCharges.length > 0 && (
          <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
            <p className="text-xs leading-relaxed text-amber-900">
              <strong>
                {strandedCharges.length} charge{strandedCharges.length === 1 ? '' : 's'} on this villa{' '}
                {strandedCharges.length === 1 ? 'is' : 'are'} still open in the currency it is billed in now.
              </strong>{' '}
              A balance is worked out separately for each currency and the two are never added together, so if these are
              left as they are they will count towards nothing: the villa will show as owing less than it does, and the
              next payment in the new currency will look like a credit rather than settling a debt.
            </p>
            <ul className="space-y-1 font-mono text-[11px] text-amber-900">
              {strandedCharges.slice(0, 6).map(ch => (
                <li key={ch.id}>
                  {ch.category} · {formatMoneyLong(ch.amount, ch.currency)} · due {ch.dueDate}
                </li>
              ))}
              {strandedCharges.length > 6 && <li>…and {strandedCharges.length - 6} more.</li>}
            </ul>
            <p className="text-xs leading-relaxed text-amber-900">
              Nothing here can convert them — the same number in the other currency is not the same money, and no rate
              this application holds is good enough to restate what somebody owes. Saving will <strong>void</strong> them
              instead: the records stay, the reason is stored, and the audit trail keeps them. Re-post the month, or
              raise the balance again in the new currency afterwards.
            </p>
            <label className="flex cursor-pointer items-start gap-2 text-xs font-medium text-amber-900">
              <input
                type="checkbox"
                checked={currencyIntent}
                onChange={e => setCurrencyIntent(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span>
                I understand these {strandedCharges.length} charge{strandedCharges.length === 1 ? '' : 's'} will be
                voided, and I will raise the balance again in {form.maintCurrency !== (unit.maintCurrency || unit.currency) ? form.maintCurrency : form.currency}.
              </span>
            </label>
          </div>
        )}

        {/*
          * The two answers are genuinely different acts, so they are laid out as a
          * choice with the consequence written on each, rather than a checkbox
          * whose meaning has to be remembered. Nothing is preselected: a default
          * here would be the machine guessing again, which is the fault this
          * exists to remove.
          */}
        {/*
          * A villa changing hands and an owner's name typed wrong are the same
          * edit to one field and completely different events. This one reaches
          * the statutory return: Form 13B reports what each proprietor owes
          * against their strata lot, and a sale leaves the seller's arrears with
          * the seller.
          */}
        {ownerNameChanged && (
          <InfoNote tone="amber">
            <p className="font-semibold">
              This villa is on record as owned by {unit.ownerName.trim()}. What is happening?
            </p>
            <div className="mt-2 space-y-2">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="vds-owner-intent"
                  className="mt-0.5"
                  checked={ownerIntent === 'correction'}
                  onChange={() => setOwnerIntent('correction')}
                />
                <span>
                  <strong>The name was wrong — this is a correction.</strong> The spelling is put right on the existing
                  ownership record, and any outstanding maintenance follows the corrected name.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="vds-owner-intent"
                  className="mt-0.5"
                  checked={ownerIntent === 'sale'}
                  onChange={() => setOwnerIntent('sale')}
                />
                <span>
                  <strong>The villa has been sold.</strong> {unit.ownerName.trim()}&apos;s ownership is closed and kept.
                  Anything they already owe <strong>stays with them</strong> and goes on ageing, which is what the annual
                  return to the Commission has to show. {form.ownerName.trim() || 'The new owner'} is billed from the next
                  posting onwards.
                </span>
              </label>
            </div>
            {ownerIntent === 'sale' && (
              <div className="mt-3">
                <Field label="Date the villa changed hands" htmlFor="ue-acquired" hint="Leave empty if it is not known — today is used, and it can be corrected later.">
                  <input
                    id="ue-acquired"
                    type="date"
                    value={ownerAcquiredOn}
                    onChange={e => setOwnerAcquiredOn(e.target.value)}
                    className={`${monoInputClass} max-w-[220px]`}
                  />
                </Field>
              </div>
            )}
          </InfoNote>
        )}

        {/*
          * Taking the tenant off the villa. The expensive direction: a move-out
          * spends the advance and writes off the final month's rent, and a
          * mis-keyed status must not be able to do that silently.
          */}
        {tenantRemoved && (
          <InfoNote tone="amber">
            <p className="font-semibold">
              {unit.tenantName.trim()} is recorded as the tenant of this villa, and is being taken off it. What is
              happening?
            </p>
            <div className="mt-2 space-y-2">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="vds-tenant-intent"
                  className="mt-0.5"
                  checked={tenantIntent === 'moved-out'}
                  onChange={() => setTenantIntent('moved-out')}
                />
                <span>
                  <strong>They have moved out.</strong> The tenancy is closed and kept, and the last month&apos;s rent
                  they paid in advance at move-in is used for their final month, so it is not charged again.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="vds-tenant-intent"
                  className="mt-0.5"
                  checked={tenantIntent === 'correction'}
                  onChange={() => setTenantIntent('correction')}
                />
                <span>
                  <strong>They were entered by mistake.</strong> The entry is taken back: unpaid rent raised for them is
                  voided, nothing is written off, and no departure is recorded. A receipt already issued to them stands
                  and must be dealt with in the ledger.
                </span>
              </label>
            </div>
          </InfoNote>
        )}

        {tenantNameChanged && (
          <InfoNote tone="amber">
            <p className="font-semibold">
              {unit.tenantName.trim()} is recorded as the tenant of this villa. What is happening?
            </p>
            <div className="mt-2 space-y-2">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="vds-tenant-intent"
                  className="mt-0.5"
                  checked={tenantIntent === 'correction'}
                  onChange={() => setTenantIntent('correction')}
                />
                <span>
                  <strong>The name was wrong — this is a correction.</strong> The spelling is put right and the tenancy
                  carries on as it is. No rent is billed and no move-in date is recorded.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="vds-tenant-intent"
                  className="mt-0.5"
                  checked={tenantIntent === 'changeover'}
                  onChange={() => setTenantIntent('changeover')}
                />
                <span>
                  <strong>A new tenant has moved in.</strong> {unit.tenantName.trim()}&apos;s tenancy is closed and kept,
                  and {form.tenantName.trim() || 'the new tenant'} is billed first and last month&apos;s rent.
                </span>
              </label>
            </div>
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

        {/* From the registered strata plan, not from this system. The levy is
            supposed to follow the entitlement, and the Commission asks for
            balances against strata lot numbers rather than villa labels. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Unit entitlement"
            htmlFor="ue-entitlement"
            hint="From the strata plan. Contributions are levied in proportion to it. Leave blank if not yet recorded."
          >
            <input
              id="ue-entitlement"
              type="number"
              min="0"
              step="0.01"
              value={form.entitlement}
              onChange={e => set('entitlement', e.target.value)}
              className={monoInputClass}
              placeholder="not recorded"
            />
          </Field>
          <Field label="Strata lot number" htmlFor="ue-lot" hint="As registered. May differ from the villa label above.">
            <input
              id="ue-lot"
              type="text"
              value={form.strataLotNumber}
              onChange={e => set('strataLotNumber', e.target.value)}
              className={monoInputClass}
              placeholder="not recorded"
            />
          </Field>
        </div>

        {/*
          A tick box, not a name match. The shortfall report needs to know which
          villas VDS lets on its own account, and `ownerName` cannot be trusted
          to answer it — the day somebody types "Villaggio Del Sol Ltd." instead
          of "VDS" a name match drops the villa and the report understates what
          was funded, silently. This is one field, it survives a rename, and it
          is explicit.
        */}
        <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
          <input
            id="ue-own-account"
            type="checkbox"
            checked={form.letOnOwnAccount}
            onChange={e => set('letOnOwnAccount', e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold text-slate-900">Let on the corporation&rsquo;s own account.</span> Tick this
            where VDS lets the villa itself and funds the maintenance contribution out of the rent it collects. It
            changes nothing about how the villa is billed &mdash; it is what scopes the{' '}
            <strong>out-of-pocket shortfall report</strong> under Operational Reports, which sizes what VDS paid in the
            months a villa stood empty.
          </span>
        </label>

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
  const [leaseEndsOn, setLeaseEndsOn] = useState(tenancy.leaseEndsOn || '');
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
        leaseEndsOn,
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
      title={closing ? 'Edit tenancy dates' : 'Correct tenancy dates'}
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
          hint={
            tenancy.startedOn
              ? 'A move-in part way through a month is billed the whole month — rent is not prorated.'
              : 'Not recorded — this tenancy predates occupancy tracking. A mid-month move-in is billed the whole month.'
          }
        >
          <input id="tn-start" type="date" value={startedOn} max={today()} onChange={e => setStartedOn(e.target.value)} className={monoInputClass} />
        </Field>

        <Field
          label="Lease ends on"
          htmlFor="tn-lease-end"
          hint="The date the agreement runs to. You are warned 60 days before. Leave empty for a month-to-month tenancy."
        >
          <input
            id="tn-lease-end"
            type="date"
            value={leaseEndsOn}
            onChange={e => setLeaseEndsOn(e.target.value)}
            className={monoInputClass}
          />
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

export function UnitLedgerDocument({
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
  /*
   * What was billed, itemised.
   *
   * This document listed every receipt and not one charge, so it showed money
   * coming in with nothing to reconcile it against: a proprietor querying their
   * balance could be handed the villa's own record and still not see what they
   * had been billed for. The account cards above give the totals; this is what
   * makes those totals checkable.
   *
   * Voided charges are kept, marked as void. They are in no balance by design,
   * but a charge that was raised and cancelled is part of the villa's history and
   * a record that quietly drops it invites the question of what else it dropped.
   */
  const unitCharges = useMemo(
    () => chargesForUnit(charges, unit, units).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [charges, unit, units]
  );
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

      <PrintSection title="II. Charges raised">
        {unitCharges.length === 0 ? (
          <p className="text-xs italic text-slate-500">No charges have been raised against this villa.</p>
        ) : (
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Due</th>
                  <th className="p-2">Period</th>
                  <th className="p-2">Category</th>
                  <th className="p-2">Billed to</th>
                  <th className="p-2">Description</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {unitCharges.map(c => (
                  <tr key={c.id} className={c.status === 'void' ? 'text-slate-400 line-through' : ''}>
                    <td className="p-2">{formatDayLabel(c.dueDate)}</td>
                    <td className="p-2">{formatMonthLabel(c.periodMonth)}</td>
                    <td className="p-2 font-sans">{c.category}</td>
                    <td className="p-2 font-sans">{c.payerName}</td>
                    <td className="p-2 font-sans">{c.description || '—'}</td>
                    <td className="p-2 font-sans">{c.status === 'void' ? `Void${c.voidReason ? ` — ${c.voidReason}` : ''}` : 'Open'}</td>
                    <td className="p-2 text-right">
                      {formatMoney(c.amount, c.currency)} {c.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </PrintSection>

      <PrintSection title="III. Payments received">
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
                    <td className="p-2 uppercase">{p.status === 'reversed' ? 'VOID' : p.status === 'pending' ? 'PENDING' : 'OK'}</td>
                    <td className="p-2 text-right font-semibold">{formatMoney(p.amount, p.currency)} {p.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </PrintSection>

      <PrintSection title="IV. Utility meter readings">
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
        <PrintSection title="V. Expenses charged to this villa">
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
                    <td className="p-2 uppercase">{e.status === 'void' ? 'Taken back' : e.status}</td>
                    <td className={`p-2 text-right font-semibold ${e.status === 'void' ? 'line-through' : ''}`}>
                      {formatMoney(e.amount, e.currency)} {e.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </PrintSection>
      )}

      {unitBookings.length > 0 && (
        <PrintSection title="VI. Guest reservations">
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
        <PrintSection title="VII. Resident &amp; property activity">
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

/* ------------------------------------------------------------------ */

/**
 * One tenant's own record, for the period they actually occupied the villa.
 *
 * The unit ledger prints everything that has ever happened to a villa, across
 * every occupant. When a tenant moves out — for a deposit return, a reference, or
 * a dispute — what is needed is the opposite: only their months, only their
 * money. Charges and receipts are therefore filtered to the tenancy's own dates,
 * so a previous or subsequent tenant's figures can never appear on it.
 */
export function TenancyRecordDocument({
  tenancy,
  unit,
  units,
  charges,
  payments,
  generatedBy,
  onClose
}: {
  tenancy: Tenancy;
  unit: Unit | null;
  units: Unit[];
  charges: Charge[];
  payments: Payment[];
  generatedBy: string;
  onClose: () => void;
}) {
  // The occupancy window. An open-ended tenancy runs to today.
  const start = tenancy.startedOn || '';
  const end = tenancy.endedOn || today();
  const inWindow = (day: string) => (!start || day >= start) && day <= end;

  const rows = useMemo(() => {
    if (!unit) return [];
    const debits = chargesForUnit(charges, unit, units)
      .filter(c => c.category === 'Rent' && c.status === 'open' && inWindow(c.dueDate))
      .map(c => ({
        date: c.dueDate,
        kind: 'charge' as const,
        detail: `Rent charged — ${formatMonthLabel(c.periodMonth)}`,
        ref: '',
        debit: c.amount,
        credit: 0,
        currency: c.currency
      }));
    const credits = paymentsForUnit(payments, unit, units)
      .filter(p => p.category === 'Rent' && p.status === 'completed' && inWindow(p.date))
      .map(p => ({
        date: p.date,
        kind: 'payment' as const,
        detail: `Payment received (${p.method})`,
        ref: p.receiptNo,
        debit: 0,
        credit: p.amount,
        currency: p.currency
      }));
    return [...debits, ...credits].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'charge' ? -1 : 1));
  }, [charges, payments, unit, units, start, end]);

  /*
   * What this document deliberately leaves out, measured so it can be declared.
   *
   * A tenant record is a record of the tenant's own account, and maintenance is
   * the proprietor's liability — so rent is the whole of it, by design. What was
   * missing was saying so. On 2026-09-02 Ro recorded a rent payment and a
   * maintenance payment against C11, printed this document, and found only the
   * rent: the reasonable conclusion is that the maintenance receipt was never
   * saved. It was. It is simply not a tenant's business, and nothing on the page
   * said that.
   *
   * The rule this now follows is the property's own, already written down for the
   * operating statement: a document that quietly omits a class of money is not a
   * narrower document, it is a misleading one. So the amount is named, with where
   * to find it.
   */
  const excludedMaintenance = useMemo(() => {
    if (!unit) return null;
    const paid = paymentsForUnit(payments, unit, units).filter(
      p => p.category === 'Maintenance' && p.status === 'completed' && inWindow(p.date)
    );
    const billed = chargesForUnit(charges, unit, units).filter(
      c => c.category === 'Maintenance' && c.status === 'open' && inWindow(c.dueDate)
    );
    if (paid.length === 0 && billed.length === 0) return null;
    const cur = billed[0]?.currency || paid[0]?.currency || 'JMD';
    return {
      currency: cur,
      billed: sumMoney(billed.filter(c => c.currency === cur).map(c => c.amount)),
      paid: sumMoney(paid.filter(p => p.currency === cur).map(p => p.amount)),
      receipts: paid.length
    };
  }, [charges, payments, unit, units, start, end]);

  const currency = tenancy.currency || unit?.currency || 'JMD';
  const charged = sumMoney(rows.filter(r => r.currency === currency).map(r => r.debit));
  const paid = sumMoney(rows.filter(r => r.currency === currency).map(r => r.credit));
  const balance = round2(charged - paid);

  return (
    <PrintPortal
      title={`Tenant record — ${tenancy.tenantName}`}
      subtitle={getUnitDisplayName(tenancy.unitNumber)}
      onClose={onClose}
      maxWidthClass="max-w-3xl"
    >
      <PrintLetterhead
        documentTitle="Tenant Record"
        meta={`${tenancy.tenantName} — ${getUnitDisplayName(tenancy.unitNumber)}`}
        generatedBy={generatedBy}
      />

      <section className="mb-5 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
        {[
          ['Tenant', tenancy.tenantName],
          ['Villa', getUnitDisplayName(tenancy.unitNumber)],
          ['Moved in', tenancy.startedOn ? formatDayLabel(tenancy.startedOn) : 'Not recorded'],
          [
            'Moved out',
            tenancy.endedOn ? formatDayLabel(tenancy.endedOn) : tenancy.status === 'active' ? 'Still in occupancy' : 'Not recorded'
          ],
          ['Agreed rent', `${formatMoney(tenancy.monthlyRent, currency)} per month`],
          ['Rent due day', tenancy.rentDueDay ? `${tenancy.rentDueDay} of each month` : '—'],
          ['Email', tenancy.tenantEmail || 'Not recorded'],
          ['Telephone', tenancy.tenantPhone || 'Not recorded']
        ].map(([label, value]) => (
          <div key={label}>
            <span className="block font-mono text-[9px] uppercase text-slate-500">{label}</span>
            <span className="font-semibold text-slate-900">{value}</span>
          </div>
        ))}
      </section>

      {tenancy.evicted && (
        <div className="print-emphasis mb-5 rounded-lg border-2 border-red-600 bg-red-50 p-3">
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-red-700">Tenancy ended by eviction</p>
          {tenancy.writeOffAmount ? (
            <p className="mt-1 font-mono text-[10px] text-red-800">
              Rent written off as bad debt: {formatMoney(tenancy.writeOffAmount, tenancy.writeOffCurrency || currency)}
            </p>
          ) : null}
        </div>
      )}

      {tenancy.endReason && (
        <p className="mb-5 text-[11px] italic text-slate-700">Reason recorded: “{tenancy.endReason}”</p>
      )}

      <h3 className="mb-2 border-b border-slate-400 pb-1 text-xs font-bold uppercase tracking-wider">
        Rent account for this occupancy
      </h3>
      <p className="mb-2 text-[10px] italic text-slate-600">
        This is the tenant&rsquo;s own account and covers rent only. Maintenance contributions are the
        proprietor&rsquo;s liability, not the tenant&rsquo;s, and are never charged to this account.
      </p>

      {rows.length === 0 ? (
        <p className="text-xs italic text-slate-500">No rent charges or receipts fall inside this occupancy period.</p>
      ) : (
        <TableScroller>
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="font-mono text-[9px] uppercase text-slate-600">
                <th className="p-2">Date</th>
                <th className="p-2">Detail</th>
                <th className="p-2">Receipt</th>
                <th className="p-2 text-right">Charged</th>
                <th className="p-2 text-right">Paid</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((row, i) => (
                <tr key={i}>
                  <td className="p-2 whitespace-nowrap">{formatDayLabel(row.date)}</td>
                  <td className="p-2 font-sans">{row.detail}</td>
                  <td className="p-2">{row.ref || '—'}</td>
                  <td className="p-2 text-right">{row.debit ? formatMoney(row.debit, row.currency) : '—'}</td>
                  <td className="p-2 text-right">{row.credit ? formatMoney(row.credit, row.currency) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-400 font-mono font-bold">
                <td className="p-2" colSpan={3}>
                  Totals for this occupancy
                </td>
                <td className="p-2 text-right">{formatMoney(charged, currency)}</td>
                <td className="p-2 text-right">{formatMoney(paid, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroller>
      )}

      <p className="mt-4 rounded-lg border border-slate-300 p-3 text-xs print-outline">
        <strong>
          Closing position: {balance > 0 ? `${formatMoneyLong(balance, currency)} outstanding` : balance < 0 ? `${formatMoneyLong(Math.abs(balance), currency)} in credit` : 'settled in full'}
        </strong>
      </p>

      {excludedMaintenance && (
        <p className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-3 text-[11px] text-slate-700 print-outline">
          <strong>Not included on this record:</strong> maintenance contributions for this villa —{' '}
          {formatMoney(excludedMaintenance.billed, excludedMaintenance.currency)} billed
          {excludedMaintenance.receipts > 0 && (
            <>
              {' '}and {formatMoney(excludedMaintenance.paid, excludedMaintenance.currency)} received across{' '}
              {excludedMaintenance.receipts} receipt{excludedMaintenance.receipts === 1 ? '' : 's'}
            </>
          )}
          . That is the proprietor&rsquo;s account, not the tenant&rsquo;s. It is recorded, and it appears on the
          villa&rsquo;s unit ledger and on the owner&rsquo;s statement.
        </p>
      )}

      <p className="mt-4 border-t border-slate-300 pt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        This record covers {tenancy.tenantName} only, for the occupancy dates shown above. Rent charged and received
        outside those dates belongs to another occupancy and is deliberately excluded. For everything that has happened
        to this villa across all occupants — every charge, every receipt in every category, utilities, expenses and
        activity — print the unit ledger instead.
      </p>

      <PrintSignatures left="Prepared by" leftName={generatedBy} right="Tenant acknowledgement" rightName={tenancy.tenantName} />
    </PrintPortal>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Move a maintenance request along.
 *
 * The cost is captured here and raised as a property expense on request rather
 * than automatically: the person closing a job knows what it cost, but not always
 * whether it has been entered in the accounts already. Making it a deliberate tick
 * — which can only be done once — keeps the money out of the books twice.
 */
function WorkOrderModal({
  activity,
  canRecordExpense,
  onClose,
  onSubmit
}: {
  activity: UnitActivity;
  canRecordExpense: boolean;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const [workStatus, setWorkStatus] = useState<WorkStatus>(activity.workStatus || 'Reported');
  const [assignedTo, setAssignedTo] = useState(activity.assignedTo || '');
  const [costAmount, setCostAmount] = useState(activity.costAmount ? String(activity.costAmount) : '');
  const [costCurrency, setCostCurrency] = useState<Currency>(activity.costCurrency || 'JMD');
  const [completedOn, setCompletedOn] = useState(activity.completedOn || today());
  const [outcome, setOutcome] = useState(activity.outcome || '');
  const [raiseExpense, setRaiseExpense] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const closing = workStatus === 'Completed' || workStatus === 'Cancelled';
  const alreadyRaised = !!activity.expenseId;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (raiseExpense && !(Number(costAmount) > 0)) {
      setError('Enter what the work cost before raising the expense for it.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        workStatus,
        assignedTo,
        outcome,
        ...(costAmount ? { costAmount: Number(costAmount), costCurrency } : {}),
        ...(closing ? { completedOn } : {}),
        ...(raiseExpense ? { raiseExpense: true } : {})
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not update the maintenance request.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Update maintenance request"
      subtitle={`${getUnitDisplayName(activity.unitNumber)} — reported ${formatDayLabel(activity.dateCaptured)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-work-form" className="flex-1">
            Save
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-work-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <p className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
          {activity.notes}
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status" htmlFor="wo-status" required>
            <select id="wo-status" value={workStatus} onChange={e => setWorkStatus(e.target.value as WorkStatus)} className={inputClass}>
              {WORK_STATUSES.map(w => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assigned to" htmlFor="wo-assigned" hint="Contractor, caretaker or staff member.">
            <input id="wo-assigned" type="text" value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className={inputClass} />
          </Field>
        </div>

        {closing && (
          <Field label="Closed on" htmlFor="wo-done" required>
            <input id="wo-done" type="date" value={completedOn} max={today()} onChange={e => setCompletedOn(e.target.value)} required className={monoInputClass} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Cost" htmlFor="wo-cost" hint="Leave empty until it is known.">
            <input id="wo-cost" type="number" min="0.01" step="0.01" value={costAmount} onChange={e => setCostAmount(e.target.value)} className={monoInputClass} />
          </Field>
          <Field label="Currency" htmlFor="wo-cur">
            <select id="wo-cur" value={costCurrency} onChange={e => setCostCurrency(e.target.value as Currency)} className={inputClass}>
              <option value="JMD">Jamaican Dollar (JMD)</option>
              <option value="USD">US Dollar (USD)</option>
            </select>
          </Field>
        </div>

        <Field label="Outcome" htmlFor="wo-outcome" hint="What was done, or why it was closed without work.">
          <textarea id="wo-outcome" rows={2} value={outcome} onChange={e => setOutcome(e.target.value)} className={inputClass} />
        </Field>

        {alreadyRaised ? (
          <InfoNote>The cost of this work is already in the expense register. It cannot be raised twice.</InfoNote>
        ) : canRecordExpense ? (
          <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <input type="checkbox" checked={raiseExpense} onChange={e => setRaiseExpense(e.target.checked)} className="mt-0.5" />
            <span>
              <strong>Also record this cost as a property expense</strong>, allocated to{' '}
              {getUnitDisplayName(activity.unitNumber)}. Tick this only if it is not already in the expense register —
              it can only be done once.
            </span>
          </label>
        ) : (
          <PermissionNote>Recording the cost as a property expense requires the expense permission.</PermissionNote>
        )}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Take a deposit, or give it back.
 *
 * One screen for both ends of the same instrument, because they are the same
 * conversation months apart. When reconciling, the two amounts are kept in step
 * as one is typed — a deposit that does not add up is exactly the dispute this is
 * meant to prevent, so the arithmetic is done here rather than left to the person
 * at the desk.
 */
function DepositModal({
  tenancy,
  onClose,
  onTake,
  onSettle
}: {
  tenancy: Tenancy;
  onClose: () => void;
  onTake: (payload: Record<string, unknown>) => Promise<void>;
  onSettle: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const held = tenancy.depositAmount || 0;
  const settled = !!tenancy.depositReturnedOn;
  const currency = tenancy.depositCurrency || tenancy.currency || 'JMD';

  const [amount, setAmount] = useState(held ? String(held) : '');
  const [receivedOn, setReceivedOn] = useState(tenancy.depositReceivedOn || today());
  const [withheld, setWithheld] = useState('0');
  const [withheldReason, setWithheldReason] = useState('');
  const [settledOn, setSettledOn] = useState(today());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const withheldNum = Math.max(0, Number(withheld) || 0);
  const returnedNum = round2(Math.max(0, held - withheldNum));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (held && !settled) {
        await onSettle({ returnedAmount: returnedNum, withheldAmount: withheldNum, withheldReason, settledOn });
      } else {
        await onTake({ amount: Number(amount), currency, receivedOn });
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not update the deposit.'));
    } finally {
      setBusy(false);
    }
  };

  if (settled) {
    return (
      <Modal title="Security deposit" subtitle={`${tenancy.tenantName} — ${getUnitDisplayName(tenancy.unitNumber)}`} onClose={onClose}>
        <div className="space-y-3 p-6 text-xs">
          <InfoNote>This deposit has been reconciled and closed. It is kept here as a permanent record.</InfoNote>
          <dl className="space-y-1 rounded-xl bg-slate-50 p-3 font-mono text-[11px]">
            {[
              ['Held', formatMoneyLong(held, currency)],
              ['Returned', formatMoneyLong(tenancy.depositReturnedAmount || 0, currency)],
              ['Withheld', formatMoneyLong(tenancy.depositWithheldAmount || 0, currency)],
              ['Settled on', formatDayLabel(tenancy.depositReturnedOn || '')]
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-slate-500">{label}</dt>
                <dd className="font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          {tenancy.depositWithheldReason && (
            <p className="rounded-xl border border-slate-200 bg-white p-3 italic leading-relaxed text-slate-700">
              “{tenancy.depositWithheldReason}”
            </p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={held ? 'Return the security deposit' : 'Record a security deposit'}
      subtitle={`${tenancy.tenantName} — ${getUnitDisplayName(tenancy.unitNumber)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-deposit-form" className="flex-1">
            {held ? 'Reconcile and close' : 'Record the deposit'}
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-deposit-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <InfoNote>
          A deposit is the tenant&apos;s money held on their behalf, not income. It never appears in the balance, the
          arrears or the reports — and it has to be given back, less anything fairly deducted.
        </InfoNote>

        {!held ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Amount held (${currency})`} htmlFor="dp-amount" required>
              <input
                id="dp-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                required
                className={monoInputClass}
              />
            </Field>
            <Field label="Date received" htmlFor="dp-received" required>
              <input id="dp-received" type="date" value={receivedOn} max={today()} onChange={e => setReceivedOn(e.target.value)} required className={monoInputClass} />
            </Field>
          </div>
        ) : (
          <>
            <dl className="space-y-1 rounded-xl bg-slate-50 p-3 font-mono text-[11px]">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Held since {formatDayLabel(tenancy.depositReceivedOn || '')}</dt>
                <dd className="font-semibold">{formatMoneyLong(held, currency)}</dd>
              </div>
            </dl>

            <Field label={`Amount withheld (${currency})`} htmlFor="dp-withheld" hint="Leave at zero to return the deposit in full.">
              <input
                id="dp-withheld"
                type="number"
                min="0"
                max={held}
                step="0.01"
                value={withheld}
                onChange={e => setWithheld(e.target.value)}
                className={monoInputClass}
              />
            </Field>

            <div className="rounded-xl border border-teal-100 bg-teal-50 p-3 text-xs text-teal-900">
              Returning <strong>{formatMoneyLong(returnedNum, currency)}</strong> to {tenancy.tenantName}
              {withheldNum > 0 ? <> and keeping <strong>{formatMoneyLong(withheldNum, currency)}</strong></> : null}.
            </div>

            {withheldNum > 0 && (
              <Field label="Why is money being withheld" htmlFor="dp-reason" required hint="Kept permanently. This is what justifies the deduction if it is ever challenged.">
                <textarea
                  id="dp-reason"
                  rows={3}
                  value={withheldReason}
                  onChange={e => setWithheldReason(e.target.value)}
                  required
                  placeholder="e.g. Broken interior door and deep clean — quotes attached to the file"
                  className={inputClass}
                />
              </Field>
            )}

            <Field label="Date settled" htmlFor="dp-settled" required>
              <input id="dp-settled" type="date" value={settledOn} max={today()} onChange={e => setSettledOn(e.target.value)} required className={monoInputClass} />
            </Field>

            {withheldNum > 0 && (
              <InfoNote tone="amber">
                Withholding money is not income. If the property is recovering a real cost, bill it as a one-off charge
                on the ledger as well, so it shows up in the accounts as the cost it is.
              </InfoNote>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}
