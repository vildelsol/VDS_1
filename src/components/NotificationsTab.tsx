/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Unit, Payment, UtilityReading, Expense, UserRole, getUnitDisplayName } from '../types';
import { Bell, Check, Clock, AlertTriangle, ArrowDownRight, ArrowUpRight, Plus, HelpCircle, ShieldAlert, DollarSign, Wrench, User } from 'lucide-react';

interface NotificationsTabProps {
  units: Unit[];
  payments: Payment[];
  utilities: UtilityReading[];
  expenses: Expense[];
  activeRole: UserRole;
  userName: string;
  onRecordPayment: (paymentData: any) => Promise<any>;
  onUpdateUtilityStatus: (id: string, status: UtilityReading['status']) => Promise<void>;
  onUpdateExpense: (id: string, updatedFields: any) => Promise<void>;
}

export default function NotificationsTab({
  units,
  payments,
  utilities,
  expenses,
  activeRole,
  userName,
  onRecordPayment,
  onUpdateUtilityStatus,
  onUpdateExpense
}: NotificationsTabProps) {
  const [filter, setFilter] = useState<'all' | 'rent' | 'maintenance' | 'utility' | 'expense'>('all');
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);

  // Resolution modals state
  const [settleTarget, setSettleTarget] = useState<{
    type: 'rent' | 'maintenance';
    unit: Unit;
    amount: number;
  } | null>(null);

  const [settleExpenseTarget, setSettleExpenseTarget] = useState<Expense | null>(null);

  // Form states for Settle modal
  const [payMethod, setPayMethod] = useState<'Cash' | 'Bank Transfer' | 'Credit Card' | 'Check' | 'Other'>('Bank Transfer');
  const [payRef, setPayRef] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);

  const currentMonth = new Date().toISOString().substring(0, 7); // "YYYY-MM"
  const currentMonthName = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

  // 1. Compute outstanding rent notifications for long-term leases
  const rentNotifications = units
    .filter(u => u.status === 'long-term' && u.monthlyRent > 0)
    .map(u => {
      const rentPaid = payments
        .filter(p => p.unitNumber === u.number && p.category === 'Rent' && p.status === 'completed' && p.date.startsWith(currentMonth))
        .reduce((sum, p) => sum + p.amount, 0);

      const outstanding = u.monthlyRent - rentPaid;
      return {
        unit: u,
        outstanding,
        paid: rentPaid
      };
    })
    .filter(item => item.outstanding > 0)
    .map(item => ({
      id: `rent-${item.unit.id}`,
      type: 'rent' as const,
      category: 'Incoming Rent' as const,
      title: `Outstanding Rent for ${getUnitDisplayName(item.unit.number)}`,
      description: `Tenant ${item.unit.tenantName || 'N/A'} has only settled ${item.unit.currency === 'USD' ? '$' : 'J$'}${item.paid.toLocaleString()} of the monthly rent of ${item.unit.currency === 'USD' ? '$' : 'J$'}${item.unit.monthlyRent.toLocaleString()} for ${currentMonthName}.`,
      unitNumber: item.unit.number,
      amount: item.outstanding,
      currency: item.unit.currency,
      severity: 'high' as const,
      originalObject: item.unit,
      actionLabel: 'Receive Rent Payment'
    }));

  // 2. Compute outstanding maintenance notifications for owners (Due on 1st of every month)
  const maintenanceNotifications = units
    .filter(u => u.status !== 'unavailable' && u.monthlyMaintenance > 0)
    .map(u => {
      const targetMaintCurrency = u.maintCurrency || u.currency;
      const maintPaid = payments
        .filter(p => p.unitNumber === u.number && p.category === 'Maintenance' && p.status === 'completed' && p.currency === targetMaintCurrency && p.date.startsWith(currentMonth))
        .reduce((sum, p) => sum + p.amount, 0);

      const outstanding = u.monthlyMaintenance - maintPaid;
      return {
        unit: u,
        outstanding,
        paid: maintPaid,
        maintCurrency: targetMaintCurrency
      };
    })
    .filter(item => item.outstanding > 0)
    .map(item => {
      const isPastFirst = new Date().getDate() >= 1; // Always past 1st on 17th
      return {
        id: `maint-${item.unit.id}`,
        type: 'maintenance' as const,
        category: 'Incoming HOA Maintenance' as const,
        title: `Delinquent HOA Maintenance for ${getUnitDisplayName(item.unit.number)}`,
        description: `Owner ${item.unit.ownerName} has not fully paid the monthly HOA maintenance fee of ${item.maintCurrency === 'USD' ? '$' : 'J$'}${item.unit.monthlyMaintenance.toLocaleString()} (Paid: ${item.maintCurrency === 'USD' ? '$' : 'J$'}${item.paid.toLocaleString()}). Maintenance is strictly due on the 1st of every month.`,
        unitNumber: item.unit.number,
        amount: item.outstanding,
        currency: item.maintCurrency,
        severity: isPastFirst ? ('high' as const) : ('medium' as const),
        originalObject: item.unit,
        actionLabel: 'Settle Maintenance HOA'
      };
    });

  // 3. Compute unpaid utility readings
  const utilityNotifications = utilities
    .filter(u => u.status === 'unpaid')
    .map(u => {
      const unitObj = units.find(unit => unit.number === u.unitNumber);
      return {
        id: `util-${u.id}`,
        type: 'utility' as const,
        category: 'Unpaid Utility Bill' as const,
        title: `Unpaid Utility Invoice for ${getUnitDisplayName(u.unitNumber)}`,
        description: `Meter reading for billing period ${u.billingPeriod} has an outstanding consumption charge of ${u.currency === 'USD' ? '$' : 'J$'}${u.amountCharged.toLocaleString()} for consumption of ${u.consumption} units.`,
        unitNumber: u.unitNumber,
        amount: u.amountCharged,
        currency: u.currency,
        severity: 'medium' as const,
        originalObject: u,
        actionLabel: 'Mark Utility Settled'
      };
    });

  // 4. Compute outstanding operational expenses to be paid
  const expenseNotifications = expenses
    .filter(e => e.status === 'pending')
    .map(e => ({
      id: `expense-${e.id}`,
      type: 'expense' as const,
      category: 'Pending Outflow Expense' as const,
      title: `Outstanding Outlay to ${e.vendor} (${getUnitDisplayName(e.unitNumber)})`,
      description: `Pending operational expense for "${e.description}" under category "${e.category}" is outstanding to be paid to vendor ${e.vendor}. Due Date: ${e.dueDate || e.date}.`,
      unitNumber: e.unitNumber,
      amount: e.amount,
      currency: e.currency,
      severity: 'medium' as const,
      originalObject: e,
      actionLabel: 'Log Settle / Pay Expense'
    }));

  // Combine and apply filter
  const allNotifications = [
    ...rentNotifications,
    ...maintenanceNotifications,
    ...utilityNotifications,
    ...expenseNotifications
  ];

  const filteredNotifications = allNotifications.filter(n => {
    if (filter === 'all') return true;
    return n.type === filter;
  });

  const totalCount = allNotifications.length;
  const highSeverityCount = allNotifications.filter(n => n.severity === 'high').length;

  // Settle incoming Rent/Maintenance
  const handleSettleIncoming = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settleTarget) return;

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const receiptNum = `REC-${Date.now().toString().slice(-6)}`;
      const payload = {
        receiptNo: receiptNum,
        payerName: settleTarget.type === 'rent' ? (settleTarget.unit.tenantName || settleTarget.unit.ownerName) : settleTarget.unit.ownerName,
        unitNumber: settleTarget.unit.number,
        category: settleTarget.type === 'rent' ? 'Rent' : 'Maintenance',
        amount: settleTarget.amount,
        currency: settleTarget.type === 'maintenance' ? (settleTarget.unit.maintCurrency || settleTarget.unit.currency) : settleTarget.unit.currency,
        date: payDate,
        method: payMethod,
        reference: payRef || `AUTO-SETTLE-${receiptNum}`,
        notes: payNotes || `Outstanding ${settleTarget.type} settled via Notifications Panel.`,
        staffMember: userName,
        status: 'completed'
      };

      await onRecordPayment(payload);
      setSuccessMsg(`Outstanding ${settleTarget.type} payment processed successfully!`);
      setSettleTarget(null);
      // Reset form fields
      setPayRef('');
      setPayNotes('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error executing settle payment.');
    } finally {
      setLoading(false);
    }
  };

  // Settle Expense
  const handleSettleExpenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settleExpenseTarget) return;

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      await onUpdateExpense(settleExpenseTarget.id, {
        status: 'paid',
        datePaid: payDate,
        paymentMethod: payMethod,
        reference: payRef || `AUTO-PAY-${Date.now().toString().slice(-5)}`,
        notes: payNotes || `Settled via Notifications Tab.`
      });
      setSuccessMsg(`Expense recorded as paid and closed out!`);
      setSettleExpenseTarget(null);
      setPayRef('');
      setPayNotes('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error updating expense status.');
    } finally {
      setLoading(false);
    }
  };

  const handleSettleUtility = async (utilityId: string) => {
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      await onUpdateUtilityStatus(utilityId, 'paid');
      setSuccessMsg('Utility marked as settled and closed!');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error updating utility status.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Overview stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">Outstanding Notifications</p>
            <h3 className="text-2xl font-display font-semibold mt-1 text-slate-950">{totalCount}</h3>
            <p className="text-xs text-slate-400 mt-1">Pending payments and outstanding bills</p>
          </div>
          <div className="p-3 bg-teal-50 text-teal-600 rounded-xl relative">
            <Bell className="w-6 h-6" />
            {totalCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white font-bold text-[9px] w-5 h-5 flex items-center justify-center rounded-full animate-pulse">
                {totalCount}
              </span>
            )}
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">High Priority Delinquencies</p>
            <h3 className="text-2xl font-display font-semibold mt-1 text-red-600">{highSeverityCount}</h3>
            <p className="text-xs text-slate-400 mt-1">Due past the 1st / Rent overdue</p>
          </div>
          <div className="p-3 bg-red-50 text-red-600 rounded-xl">
            <AlertTriangle className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">Active Audit Logging</p>
            <h3 className="text-lg font-display font-semibold mt-1 text-emerald-700">Real-Time Sync</h3>
            <p className="text-xs text-slate-400 mt-1">Actions auto-logged to system log</p>
          </div>
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
            <Check className="w-6 h-6" />
          </div>
        </div>
      </div>

      {successMsg && (
        <div className="p-4 bg-teal-50 border border-teal-100 text-teal-800 text-xs rounded-xl font-medium">
          {successMsg}
        </div>
      )}

      {errorMsg && (
        <div className="p-4 bg-red-50 border border-red-100 text-red-800 text-xs rounded-xl flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-red-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Main List and filter bar */}
      <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-xs space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-100 pb-5">
          <div>
            <h2 className="text-base font-display font-semibold text-slate-900">Outstanding Unit Payments & Bills</h2>
            <p className="text-xs text-slate-500 mt-1">Real-time dynamic monitoring. Status changes instantly clear notifications and log to audit logs.</p>
          </div>

          <div className="flex flex-wrap gap-1 bg-slate-100 p-1 rounded-xl text-xs">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${filter === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
            >
              All ({totalCount})
            </button>
            <button
              onClick={() => setFilter('rent')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${filter === 'rent' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
            >
              Rent Overdue ({rentNotifications.length})
            </button>
            <button
              onClick={() => setFilter('maintenance')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${filter === 'maintenance' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
            >
              Maintenance HOA ({maintenanceNotifications.length})
            </button>
            <button
              onClick={() => setFilter('utility')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${filter === 'utility' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
            >
              Unpaid Utilities ({utilityNotifications.length})
            </button>
            <button
              onClick={() => setFilter('expense')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${filter === 'expense' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
            >
              Pending Expenses ({expenseNotifications.length})
            </button>
          </div>
        </div>

        {/* Notifications list */}
        {filteredNotifications.length === 0 ? (
          <div className="p-8 text-center border border-dashed border-slate-200 rounded-2xl bg-slate-50/50">
            <div className="p-3 bg-teal-50 text-teal-600 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-3">
              <Check className="w-6 h-6" />
            </div>
            <h4 className="text-sm font-semibold text-slate-900">All Settled & Clear!</h4>
            <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">No outstanding billing deficiencies, pending rent payments, unpaid utilities, or pending operational expenses currently exist.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredNotifications.map((notif) => (
              <div
                key={notif.id}
                className={`p-5 rounded-2xl border transition-all flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white hover:shadow-xs ${
                  notif.severity === 'high'
                    ? 'border-red-100 bg-red-50/10 hover:border-red-200'
                    : 'border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className="flex items-start gap-3.5 flex-1">
                  <div className={`p-2.5 rounded-xl mt-0.5 ${
                    notif.type === 'rent'
                      ? 'bg-indigo-50 text-indigo-600'
                      : notif.type === 'maintenance'
                      ? 'bg-amber-50 text-amber-600'
                      : notif.type === 'utility'
                      ? 'bg-teal-50 text-teal-600'
                      : 'bg-rose-50 text-rose-600'
                  }`}>
                    {notif.type === 'rent' && <DollarSign className="w-5 h-5" />}
                    {notif.type === 'maintenance' && <User className="w-5 h-5" />}
                    {notif.type === 'utility' && <Wrench className="w-5 h-5" />}
                    {notif.type === 'expense' && <Clock className="w-5 h-5" />}
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[9px] font-mono font-semibold px-2 py-0.5 rounded-full uppercase border ${
                        notif.type === 'rent'
                          ? 'bg-indigo-50 text-indigo-700 border-indigo-100'
                          : notif.type === 'maintenance'
                          ? 'bg-amber-50 text-amber-700 border-amber-100'
                          : notif.type === 'utility'
                          ? 'bg-teal-50 text-teal-700 border-teal-100'
                          : 'bg-rose-50 text-rose-700 border-rose-100'
                      }`}>
                        {notif.category}
                      </span>
                      {notif.severity === 'high' && (
                        <span className="bg-red-50 text-red-700 border border-red-100 text-[9px] font-mono font-bold px-2 py-0.5 rounded-full uppercase animate-pulse">
                          Immediate Overdue
                        </span>
                      )}
                      <span className="text-[10px] text-slate-400 font-mono">{getUnitDisplayName(notif.unitNumber)}</span>
                    </div>
                    <h3 className="text-sm font-semibold text-slate-900">{notif.title}</h3>
                    <p className="text-xs text-slate-500 leading-relaxed max-w-3xl">{notif.description}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4 min-w-[200px] justify-between md:justify-end border-t md:border-t-0 border-slate-50 pt-3 md:pt-0 w-full md:w-auto">
                  <div className="text-right">
                    <span className="text-[10px] font-mono text-slate-400 block uppercase">Outstanding amount</span>
                    <span className="text-sm font-bold text-slate-800 font-mono">
                      {notif.currency === 'USD' ? 'USD $' : 'JMD J$'}{notif.amount.toLocaleString()}
                    </span>
                  </div>

                  {/* Settle Action Button */}
                  {notif.type === 'utility' ? (
                    <button
                      onClick={() => handleSettleUtility(notif.originalObject.id)}
                      disabled={loading}
                      className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold shadow-xs hover:shadow-md transition-all whitespace-nowrap"
                    >
                      Mark Paid
                    </button>
                  ) : notif.type === 'expense' ? (
                    <button
                      onClick={() => {
                        setSettleExpenseTarget(notif.originalObject);
                        setPayDate(new Date().toISOString().split('T')[0]);
                      }}
                      className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold shadow-xs hover:shadow-md transition-all whitespace-nowrap"
                    >
                      Record Outflow
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setSettleTarget({
                          type: notif.type as 'rent' | 'maintenance',
                          unit: notif.originalObject,
                          amount: notif.amount
                        });
                        setPayDate(new Date().toISOString().split('T')[0]);
                      }}
                      className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-semibold shadow-xs hover:shadow-md transition-all whitespace-nowrap"
                    >
                      Receive Pmt
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MODAL: Settle Incoming Rent/HOA */}
      {settleTarget && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleSettleIncoming} className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Bell className="w-5 h-5 text-teal-600" />
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900">Settle Outstanding {settleTarget.type === 'rent' ? 'Rent' : 'HOA Maintenance'}</h3>
                  <span className="text-[10px] font-mono text-slate-500">{getUnitDisplayName(settleTarget.unit.number)} • {settleTarget.unit.ownerName}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSettleTarget(null)}
                className="text-slate-400 hover:text-slate-600 text-xl font-semibold"
              >
                &times;
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div className="p-4 bg-teal-50/50 rounded-xl space-y-1.5 border border-teal-100/50">
                <span className="text-[10px] font-mono text-teal-700 uppercase block font-semibold">Overdue Balance due</span>
                <p className="text-lg font-bold text-teal-900 font-mono">
                  {(settleTarget.type === 'maintenance' ? (settleTarget.unit.maintCurrency || settleTarget.unit.currency) : settleTarget.unit.currency) === 'USD' ? 'USD $' : 'JMD J$'}{settleTarget.amount.toLocaleString()}
                </p>
                <p className="text-[10px] text-teal-600 leading-normal">
                  Processing this cash receipt will automatically close this outstanding notification item, credit the unit's ledger, and log to the audit trail logs.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Receipt Date</label>
                  <input
                    type="date"
                    required
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    className="w-full p-2.5 border border-slate-200 rounded-xl font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Payment Method</label>
                  <select
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value as any)}
                    className="w-full p-2.5 border border-slate-200 rounded-xl text-xs"
                  >
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Cash">Cash</option>
                    <option value="Credit Card">Credit Card</option>
                    <option value="Check">Check</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono text-slate-500 block mb-1">Transaction Ref / Reference Code</label>
                <input
                  type="text"
                  placeholder="e.g. Wire reference or receipt no."
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  className="w-full p-2.5 border border-slate-200 rounded-xl font-mono text-xs"
                />
              </div>

              <div>
                <label className="text-[10px] font-mono text-slate-500 block mb-1">Add Memo / Notes</label>
                <textarea
                  placeholder="Memo detail..."
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  className="w-full p-2.5 border border-slate-200 rounded-xl text-xs"
                  rows={2}
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-all"
                >
                  {loading ? 'Processing...' : 'Settle Overdue Cash'}
                </button>
                <button
                  type="button"
                  onClick={() => setSettleTarget(null)}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: Settle Expense (Outflow) */}
      {settleExpenseTarget && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleSettleExpenseSubmit} className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-rose-600" />
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900">Settle Outflow Expense</h3>
                  <span className="text-[10px] font-mono text-slate-500">To: {settleExpenseTarget.vendor}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSettleExpenseTarget(null)}
                className="text-slate-400 hover:text-slate-600 text-xl font-semibold"
              >
                &times;
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div className="p-4 bg-rose-50/50 rounded-xl space-y-1.5 border border-rose-100/50">
                <span className="text-[10px] font-mono text-rose-700 uppercase block font-semibold">Amount to pay vendor</span>
                <p className="text-lg font-bold text-rose-950 font-mono">
                  {settleExpenseTarget.currency === 'USD' ? 'USD $' : 'JMD J$'}{settleExpenseTarget.amount.toLocaleString()}
                </p>
                <p className="text-[10px] text-rose-700 leading-normal">
                  Settle/Pay this invoice. This update triggers audit logging and is reflected instantly under Paid Outlays in reports.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Date Paid</label>
                  <input
                    type="date"
                    required
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    className="w-full p-2.5 border border-slate-200 rounded-xl font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Payment Method</label>
                  <select
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value as any)}
                    className="w-full p-2.5 border border-slate-200 rounded-xl text-xs"
                  >
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Cash">Cash</option>
                    <option value="Credit Card">Credit Card</option>
                    <option value="Check">Check</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono text-slate-500 block mb-1">Transaction Ref / Wire TXN ID</label>
                <input
                  type="text"
                  placeholder="e.g. Wire reference or receipt no."
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  className="w-full p-2.5 border border-slate-200 rounded-xl font-mono text-xs"
                />
              </div>

              <div>
                <label className="text-[10px] font-mono text-slate-500 block mb-1">Add Memo / Notes</label>
                <textarea
                  placeholder="Memo detail..."
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  className="w-full p-2.5 border border-slate-200 rounded-xl text-xs"
                  rows={2}
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-xl transition-all"
                >
                  {loading ? 'Processing...' : 'Settle & Close Outlay'}
                </button>
                <button
                  type="button"
                  onClick={() => setSettleExpenseTarget(null)}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
