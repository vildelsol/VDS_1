/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Unit, Payment, UserRole, RolePermissions, getUnitDisplayName } from '../types';
import { DollarSign, ShieldAlert, Plus, Printer, RotateCcw, Landmark, ListCollapse, CheckCircle, RefreshCw, FileText, Calendar, Edit, Save, X } from 'lucide-react';

interface FinanceHubProps {
  units: Unit[];
  payments: Payment[];
  activeRole: UserRole;
  juniorHasAdvancedAccess: boolean;
  rolePermissions: {
    MANAGER: RolePermissions;
    FINANCE_OFFICER: RolePermissions;
    JUNIOR_OFFICER: RolePermissions;
  };
  userName: string;
  onRecordPayment: (p: any) => Promise<Payment>;
  onReversePayment: (paymentId: string, reason: string) => Promise<Payment>;
  onUpdatePayment: (paymentId: string, fields: any) => Promise<void>;
  onGenerateRecurringCharges: (month: string) => Promise<void>;
  onOpenReceipt: (payment: Payment) => void;
}

export default function FinanceHub({
  units,
  payments,
  activeRole,
  juniorHasAdvancedAccess,
  rolePermissions,
  userName,
  onRecordPayment,
  onReversePayment,
  onUpdatePayment,
  onGenerateRecurringCharges,
  onOpenReceipt
}: FinanceHubProps) {
  const [activeTab, setActiveTab] = useState<'tenants' | 'owners' | 'transactions'>('tenants');
  const [isRecording, setIsRecording] = useState(false);
  
  // Recording Form State
  const [payerName, setPayerName] = useState('');
  const [unitNumber, setUnitNumber] = useState('');
  const [category, setCategory] = useState<Payment['category']>('Rent');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'JMD'>('JMD');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [method, setMethod] = useState<Payment['method']>('Bank Transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  // Dynamic prefill and currency selection when unit number or category changes in manual posting form
  React.useEffect(() => {
    if (unitNumber) {
      const unit = units.find(u => u.number === unitNumber);
      if (unit) {
        if (category === 'Maintenance') {
          setCurrency(unit.maintCurrency || unit.currency);
          if (!payerName) setPayerName(unit.ownerName || '');
          if (!amount) setAmount(String(unit.monthlyMaintenance || ''));
        } else if (category === 'Rent') {
          setCurrency(unit.currency);
          if (!payerName) setPayerName(unit.tenantName || unit.ownerName || '');
          if (!amount) setAmount(String(unit.monthlyRent || ''));
        } else {
          setCurrency(unit.currency);
          if (!payerName) setPayerName(unit.tenantName || unit.ownerName || '');
        }
      }
    }
  }, [unitNumber, category, units]);

  // Reversal Form State
  const [reversalTarget, setReversalTarget] = useState<Payment | null>(null);
  const [reversalReason, setReversalReason] = useState('');

  const [selectedBillingMonth, setSelectedBillingMonth] = useState('2026-07');
  const [chargeLoading, setChargeLoading] = useState(false);

  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);

  // Click-to-view & editing state
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
  const [isEditingPayment, setIsEditingPayment] = useState(false);
  const [editPayerName, setEditPayerName] = useState('');
  const [editUnitNumber, setEditUnitNumber] = useState('');
  const [editCategory, setEditCategory] = useState<Payment['category']>('Rent');
  const [editAmount, setEditAmount] = useState('');
  const [editCurrency, setEditCurrency] = useState<'USD' | 'JMD'>('JMD');
  const [editDate, setEditDate] = useState('');
  const [editMethod, setEditMethod] = useState<Payment['method']>('Bank Transfer');
  const [editReference, setEditReference] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editStatus, setEditStatus] = useState<'completed' | 'reversed'>('completed');

  const canReverse = activeRole === 'ADMINISTRATOR' || activeRole === 'MANAGER' || juniorHasAdvancedAccess;
  const hasModifySettledPermission = activeRole === 'ADMINISTRATOR' || 
    activeRole === 'MANAGER' || 
    (rolePermissions?.[activeRole]?.modifySettledRecords === true) || 
    juniorHasAdvancedAccess;

  const handleSelectPaymentDetail = (p: Payment) => {
    setSelectedPayment(p);
    setIsEditingPayment(false);
    setEditPayerName(p.payerName);
    setEditUnitNumber(p.unitNumber);
    setEditCategory(p.category);
    setEditAmount(String(p.amount));
    setEditCurrency(p.currency);
    setEditDate(p.date);
    setEditMethod(p.method);
    setEditReference(p.reference || '');
    setEditNotes(p.notes || '');
    setEditStatus(p.status);
  };

  const handleSavePaymentEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPayment) return;
    if (!hasModifySettledPermission) {
      setErrorMsg('You do not have permission to modify settled ledger records.');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    try {
      await onUpdatePayment(selectedPayment.id, {
        payerName: editPayerName,
        unitNumber: editUnitNumber,
        category: editCategory,
        amount: Number(editAmount),
        currency: editCurrency,
        date: editDate,
        method: editMethod,
        reference: editReference,
        notes: editNotes,
        status: editStatus
      });
      setSuccessMsg(`Ledger record ${selectedPayment.receiptNo} updated successfully.`);
      setSelectedPayment(null);
      setIsEditingPayment(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error updating payment record.');
    } finally {
      setLoading(false);
    }
  };

  const handleRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    if (!payerName || !unitNumber || !amount || Number(amount) <= 0) {
      setErrorMsg('Payer name, valid unit, and positive payment amount are required.');
      setLoading(false);
      return;
    }

    try {
      const p = await onRecordPayment({
        payerName,
        unitNumber,
        category,
        amount: Number(amount),
        currency,
        date,
        method,
        reference,
        notes
      });
      setSuccessMsg(`Payment recorded successfully! Receipt ID: ${p.receiptNo}`);
      setIsRecording(false);
      // reset form
      setPayerName('');
      setAmount('');
      setReference('');
      setNotes('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error recording transaction.');
    } finally {
      setLoading(false);
    }
  };

  const handleTriggerReversal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reversalTarget) return;
    if (!canReverse) {
      setErrorMsg('Unauthorized: Junior Officers or Finance Officers cannot reverse completed receipts without authorized management approvals.');
      return;
    }

    if (!reversalReason || reversalReason.trim().length < 3) {
      setErrorMsg('Please specify a valid cancellation or reversal reason.');
      return;
    }

    setLoading(true);
    setErrorMsg('');

    try {
      await onReversePayment(reversalTarget.id, reversalReason);
      setSuccessMsg(`Receipt ${reversalTarget.receiptNo} reversed successfully.`);
      setReversalTarget(null);
      setReversalReason('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error processing payment reversal.');
    } finally {
      setLoading(false);
    }
  };

  const handlePostRecurringCharges = async () => {
    setChargeLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      await onGenerateRecurringCharges(selectedBillingMonth);
      setSuccessMsg(`Successfully generated base recurring charges for month: ${selectedBillingMonth}`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error posting recurring charges.');
    } finally {
      setChargeLoading(false);
    }
  };

  // Helper calculation of outstanding balance per tenant
  const tenantAccounts = units.filter(u => u.status === 'long-term').map(unit => {
    const totalCharges = unit.monthlyRent; // simple 1-month outstanding model for MVP
    const rentPaid = payments
      .filter(p => p.unitNumber === unit.number && p.category === 'Rent' && p.status === 'completed' && p.currency === unit.currency)
      .reduce((sum, p) => sum + p.amount, 0);

    const outstanding = Math.max(0, totalCharges - rentPaid);
    return {
      unit,
      rentPaid,
      outstanding,
      history: payments.filter(p => p.unitNumber === unit.number && p.category === 'Rent')
    };
  });

  // Helper calculation of outstanding balance per owner
  const ownerAccounts = units.map(unit => {
    const totalCharges = unit.monthlyMaintenance;
    const maintPaid = payments
      .filter(p => p.unitNumber === unit.number && p.category === 'Maintenance' && p.status === 'completed' && p.currency === (unit.maintCurrency || unit.currency))
      .reduce((sum, p) => sum + p.amount, 0);

    const outstanding = Math.max(0, totalCharges - maintPaid);
    return {
      unit,
      maintPaid,
      outstanding,
      history: payments.filter(p => p.unitNumber === unit.number && p.category === 'Maintenance')
    };
  });

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
        <div>
          <h2 className="text-xl font-display font-medium text-slate-900">Tenant & HOA Financial Hub</h2>
          <p className="text-xs text-slate-500 mt-0.5">Dual-currency ledger auditing, receipt generation, and manual posting controls</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setIsRecording(true)}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 shadow-xs"
          >
            <Plus className="w-4 h-4" />
            Record Payment
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 bg-red-50 border border-red-100 text-red-800 text-xs rounded-xl flex items-center gap-1.5">
          <ShieldAlert className="w-4 h-4 text-red-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3 bg-teal-50 border border-teal-100 text-teal-800 text-xs rounded-xl">
          {successMsg}
        </div>
      )}

      {/* Tabs Row */}
      <div className="flex justify-between items-center border-b border-slate-200">
        <div className="flex gap-4">
          <button
            onClick={() => { setActiveTab('tenants'); setErrorMsg(''); setSuccessMsg(''); }}
            className={`pb-3 text-xs font-medium border-b-2 transition-all ${activeTab === 'tenants' ? 'border-teal-600 text-slate-900 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            Tenant Rent Register
          </button>
          <button
            onClick={() => { setActiveTab('owners'); setErrorMsg(''); setSuccessMsg(''); }}
            className={`pb-3 text-xs font-medium border-b-2 transition-all ${activeTab === 'owners' ? 'border-teal-600 text-slate-900 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            Owner Maintenance Accounts
          </button>
          <button
            onClick={() => { setActiveTab('transactions'); setErrorMsg(''); setSuccessMsg(''); }}
            className={`pb-3 text-xs font-medium border-b-2 transition-all ${activeTab === 'transactions' ? 'border-teal-600 text-slate-900 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            Staff Receipts Ledger
          </button>
        </div>

        {/* Generate Charges Tool */}
        <div className="flex items-center gap-2 pb-2">
          <span className="text-[10px] font-mono text-slate-400">Post charges:</span>
          <input
            type="month"
            value={selectedBillingMonth}
            onChange={(e) => setSelectedBillingMonth(e.target.value)}
            className="text-[11px] p-1.5 border border-slate-200 rounded-lg font-mono"
          />
          <button
            onClick={handlePostRecurringCharges}
            disabled={chargeLoading}
            className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-[10px] font-mono font-medium hover:bg-slate-200 transition-all flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${chargeLoading ? 'animate-spin' : ''}`} />
            Post Month
          </button>
        </div>
      </div>

      {/* Tab Panels */}
      {activeTab === 'tenants' && (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-xs overflow-hidden">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 font-mono text-[10px] uppercase">
                <th className="p-4">Unit</th>
                <th className="p-4">Tenant Name</th>
                <th className="p-4">Monthly Rent Due</th>
                <th className="p-4">Currency</th>
                <th className="p-4">Paid (This Mo)</th>
                <th className="p-4">Outstanding Bal</th>
                <th className="p-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {tenantAccounts.map(({ unit, rentPaid, outstanding }) => (
                <tr key={unit.id} className="hover:bg-slate-50/50">
                  <td className="p-4 font-semibold font-mono">Villa {unit.number}</td>
                  <td className="p-4">
                    <p className="font-medium text-slate-950">{unit.tenantName}</p>
                    <p className="text-[10px] text-slate-400 font-mono">{unit.tenantEmail}</p>
                  </td>
                  <td className="p-4 font-mono">{unit.currency === 'USD' ? '$' : 'J$'}{unit.monthlyRent.toLocaleString()}</td>
                  <td className="p-4 font-mono text-slate-500">{unit.currency}</td>
                  <td className="p-4 font-mono text-emerald-600">+{unit.currency === 'USD' ? '$' : 'J$'}{rentPaid.toLocaleString()}</td>
                  <td className="p-4">
                    <span className={`px-2 py-0.5 rounded-md font-mono font-medium text-[11px] ${outstanding > 0 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
                      {outstanding > 0 ? `${unit.currency === 'USD' ? '$' : 'J$'}${outstanding.toLocaleString()}` : 'Paid'}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    {outstanding > 0 ? (
                      <button
                        onClick={() => {
                          setPayerName(unit.tenantName || '');
                          setUnitNumber(unit.number);
                          setCategory('Rent');
                          setCurrency(unit.currency);
                          setAmount(String(outstanding || unit.monthlyRent));
                          setIsRecording(true);
                        }}
                        className="px-2.5 py-1.5 border border-slate-200 hover:border-teal-200 text-teal-700 hover:text-teal-900 rounded-lg font-medium transition-colors cursor-pointer"
                      >
                        Receive Rent
                      </button>
                    ) : (
                      <span className="text-emerald-600 font-medium inline-flex items-center gap-1">
                        <CheckCircle className="w-3.5 h-3.5" /> Settled
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'owners' && (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-xs overflow-hidden">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 font-mono text-[10px] uppercase">
                <th className="p-4">Unit</th>
                <th className="p-4">Registered Owner</th>
                <th className="p-4">HOA Maintenance Due</th>
                <th className="p-4">Currency</th>
                <th className="p-4">Paid (This Mo)</th>
                <th className="p-4">Outstanding Bal</th>
                <th className="p-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ownerAccounts.map(({ unit, maintPaid, outstanding }) => (
                <tr key={unit.id} className="hover:bg-slate-50/50">
                  <td className="p-4 font-semibold font-mono">Villa {unit.number}</td>
                  <td className="p-4">
                    <p className="font-medium text-slate-950">{unit.ownerName}</p>
                    <p className="text-[10px] text-slate-400 font-mono">{unit.ownerEmail}</p>
                  </td>
                  <td className="p-4 font-mono">{(unit.maintCurrency || unit.currency) === 'USD' ? '$' : 'J$'}{unit.monthlyMaintenance.toLocaleString()}</td>
                  <td className="p-4 font-mono text-slate-500">{unit.maintCurrency || unit.currency}</td>
                  <td className="p-4 font-mono text-emerald-600">+{(unit.maintCurrency || unit.currency) === 'USD' ? '$' : 'J$'}{maintPaid.toLocaleString()}</td>
                  <td className="p-4">
                    <span className={`px-2 py-0.5 rounded-md font-mono font-medium text-[11px] ${outstanding > 0 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
                      {outstanding > 0 ? `${(unit.maintCurrency || unit.currency) === 'USD' ? '$' : 'J$'}${outstanding.toLocaleString()}` : 'Paid'}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    {outstanding > 0 ? (
                      <button
                        onClick={() => {
                          setPayerName(unit.ownerName);
                          setUnitNumber(unit.number);
                          setCategory('Maintenance');
                          setCurrency(unit.maintCurrency || unit.currency);
                          setAmount(String(outstanding || unit.monthlyMaintenance));
                          setIsRecording(true);
                        }}
                        className="px-2.5 py-1.5 border border-slate-200 hover:border-teal-200 text-teal-700 hover:text-teal-900 rounded-lg font-medium transition-colors cursor-pointer"
                      >
                        Receive Maint
                      </button>
                    ) : (
                      <span className="text-emerald-600 font-medium inline-flex items-center gap-1">
                        <CheckCircle className="w-3.5 h-3.5" /> Settled
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'transactions' && (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
            <span className="text-xs font-mono text-slate-500">Historical completed receipts and authorized voids log</span>
          </div>
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-100/50 border-b border-slate-200 text-slate-400 font-mono text-[10px] uppercase">
                <th className="p-4">Receipt No</th>
                <th className="p-4">Payer</th>
                <th className="p-4">Unit</th>
                <th className="p-4">Category</th>
                <th className="p-4">Amount</th>
                <th className="p-4">Date</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map(p => (
                <tr 
                  key={p.id} 
                  onClick={() => handleSelectPaymentDetail(p)}
                  className="hover:bg-slate-50/40 cursor-pointer transition-colors"
                >
                  <td className="p-4 font-mono font-semibold text-slate-700">{p.receiptNo}</td>
                  <td className="p-4">
                    <p className="font-medium text-slate-900">{p.payerName}</p>
                    {p.notes && (
                      <p className="text-[10px] text-slate-400 truncate max-w-xs">{p.notes}</p>
                    )}
                  </td>
                  <td className="p-4 font-mono">Villa {p.unitNumber}</td>
                  <td className="p-4">
                    <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-800 font-mono font-medium">
                      {p.category}
                    </span>
                  </td>
                  <td className="p-4 font-mono font-medium">
                    {p.currency === 'USD' ? '$' : 'J$'}{p.amount.toLocaleString()}
                  </td>
                  <td className="p-4 font-mono text-[11px] text-slate-500">{p.date}</td>
                  <td className="p-4">
                    {p.status === 'completed' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full bg-emerald-100 text-emerald-800 font-medium">
                        <CheckCircle className="w-3 h-3" /> Completed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full bg-red-100 text-red-800 font-medium">
                        <RotateCcw className="w-3 h-3" /> Reversed
                      </span>
                    )}
                  </td>
                  <td className="p-4 text-right flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => onOpenReceipt(p)}
                      className="p-1.5 border border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-50 rounded-lg transition-all"
                      title="Print PDF Receipt"
                    >
                      <Printer className="w-4 h-4" />
                    </button>
                    {p.status === 'completed' && (
                      <button
                        onClick={() => {
                          if (!canReverse) {
                            setErrorMsg('Unauthorized: Only administrators or managers can process payment reversals or void completed receipts.');
                            return;
                          }
                          setReversalTarget(p);
                        }}
                        className="p-1.5 border border-red-200 text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        title="Reverse transaction"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Record Payment Drawer / Modal */}
      {isRecording && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleRecord} className="bg-white rounded-2xl max-w-md w-full shadow-xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="text-base font-display font-semibold text-slate-900">Record Operations Payment</h3>
              <button type="button" onClick={() => setIsRecording(false)} className="text-slate-400 hover:text-slate-600">
                &times;
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Unit Number</label>
                  <select
                    value={unitNumber}
                    onChange={(e) => setUnitNumber(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="">Select Villa</option>
                    {units.map((u) => (
                      <option key={u.id} value={u.number}>{getUnitDisplayName(u.number)}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Payment Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as Payment['category'])}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="Rent">Rent Payment</option>
                    <option value="Maintenance">Maintenance HOA</option>
                    <option value="Booking">Booking Deposit/Bal</option>
                    <option value="Utility">Utility Payment</option>
                    <option value="Other">Other Approved</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Payer Full Name</label>
                <input
                  type="text"
                  value={payerName}
                  onChange={(e) => setPayerName(e.target.value)}
                  placeholder="e.g. Sarah Gordon"
                  required
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Amount</label>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="e.g. 120000"
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Payer Currency</label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value as 'USD' | 'JMD')}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="JMD">Jamaican Dollar (JMD)</option>
                    <option value="USD">US Dollar (USD)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Transaction Method</label>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as Payment['method'])}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="Bank Transfer">Bank Transfer (NCB/Sagicor)</option>
                    <option value="Cash">Cash Receipt</option>
                    <option value="Credit Card">Credit Card</option>
                    <option value="Check">Manager Check</option>
                    <option value="Other">Other Method</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Date</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Reference No / Receipt ID</label>
                <input
                  type="text"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="e.g. TXN-11938"
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Staff Notes</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                />
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all"
              >
                {loading ? 'Processing Receipt...' : 'Record Receipt'}
              </button>
              <button
                type="button"
                onClick={() => setIsRecording(false)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-100 transition-all"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Reversal Confirmation Dialog */}
      {reversalTarget && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleTriggerReversal} className="bg-white rounded-2xl max-w-sm w-full shadow-xl border border-red-100 overflow-hidden">
            <div className="p-5 border-b border-red-50 bg-red-50/50 flex justify-between items-center text-red-900">
              <h3 className="text-sm font-display font-semibold flex items-center gap-1.5">
                <RotateCcw className="w-4 h-4 text-red-600" />
                Void Completed Receipt
              </h3>
              <button type="button" onClick={() => setReversalTarget(null)} className="text-slate-400 hover:text-slate-600 font-semibold">
                &times;
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl space-y-1 font-mono text-[11px]">
                <p><strong>Receipt #:</strong> {reversalTarget.receiptNo}</p>
                <p><strong>Payer:</strong> {reversalTarget.payerName}</p>
                <p><strong>Amount:</strong> {reversalTarget.currency === 'USD' ? '$' : 'J$'}{reversalTarget.amount.toLocaleString()}</p>
                <p><strong>Recorded by:</strong> {reversalTarget.staffMember}</p>
              </div>

              <p className="text-slate-500 leading-normal">
                Voiding finalized financial records cannot be undone. The transaction remains in the audit registry as 'Reversed' with the specified manager reasoning.
              </p>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Reason for Reversal / Correction</label>
                <textarea
                  rows={2}
                  value={reversalReason}
                  onChange={(e) => setReversalReason(e.target.value)}
                  placeholder="e.g. Overpaid amount by mistake / incorrect unit number"
                  required
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl focus:ring-1 focus:ring-red-500 focus:border-red-500"
                />
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-medium transition-all"
              >
                {loading ? 'Voiding...' : 'Approve & Void Receipt'}
              </button>
              <button
                type="button"
                onClick={() => setReversalTarget(null)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-100 transition-all"
              >
                Dismiss
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Transaction View / Edit Detail Modal */}
      {selectedPayment && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-teal-600" />
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900">Receipt Details</h3>
                  <span className="text-[10px] font-mono text-slate-500">{selectedPayment.receiptNo}</span>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setSelectedPayment(null)} 
                className="text-slate-400 hover:text-slate-600 text-xl font-semibold"
              >
                &times;
              </button>
            </div>

            {!isEditingPayment ? (
              // View mode
              <div className="p-6 space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Payer Name</span>
                    <span className="font-semibold text-slate-900 text-sm">{selectedPayment.payerName}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Villa Allocation</span>
                    <span className="font-semibold text-slate-900 text-sm">Villa {selectedPayment.unitNumber}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Financial Category</span>
                    <span className="inline-block mt-0.5 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-800 font-mono font-medium">
                      {selectedPayment.category}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Amount Settled</span>
                    <span className="font-semibold font-mono text-slate-900 text-sm">
                      {selectedPayment.currency === 'USD' ? '$' : 'J$'}{selectedPayment.amount.toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Payment Date</span>
                    <span className="font-medium text-slate-700">{selectedPayment.date}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Payment Method</span>
                    <span className="font-medium text-slate-700">{selectedPayment.method}</span>
                  </div>
                </div>

                <div className="border-b border-slate-100 pb-4">
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Reference No / Receipt ID</span>
                  <span className="font-mono text-slate-800 bg-slate-50 px-2 py-1 rounded mt-1 inline-block">
                    {selectedPayment.reference || 'None'}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Complete Staff Notes / Descriptions</span>
                  <div className="p-3 bg-slate-50 rounded-xl text-slate-700 italic mt-1 leading-relaxed whitespace-pre-wrap">
                    {selectedPayment.notes || 'No description notes provided.'}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400 font-mono pt-2">
                  <p><strong>Logged by:</strong> {selectedPayment.staffMember || 'System'}</p>
                  <p><strong>Ledger Status:</strong> {selectedPayment.status.toUpperCase()}</p>
                </div>

                <div className="pt-4 flex gap-3">
                  {hasModifySettledPermission ? (
                    <button
                      type="button"
                      onClick={() => setIsEditingPayment(true)}
                      className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition-all flex items-center justify-center gap-1.5"
                    >
                      <Edit className="w-4 h-4" />
                      Edit Record Fields
                    </button>
                  ) : (
                    <div className="w-full text-center py-2 px-3 bg-amber-50 rounded-xl text-amber-700 text-[10px]">
                      🔒 Contact your Administrator or Manager to request modification permissions.
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenReceipt(selectedPayment)}
                    className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-all flex items-center gap-1.5"
                  >
                    <Printer className="w-4 h-4" />
                    Print Receipt
                  </button>
                </div>
              </div>
            ) : (
              // Edit Mode
              <form onSubmit={handleSavePaymentEdit} className="p-6 space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Payer Name</label>
                    <input
                      type="text"
                      value={editPayerName}
                      onChange={(e) => setEditPayerName(e.target.value)}
                      required
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Villa Number</label>
                    <select
                      value={editUnitNumber}
                      onChange={(e) => setEditUnitNumber(e.target.value)}
                      required
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    >
                      {units.map((u) => (
                        <option key={u.id} value={u.number}>{getUnitDisplayName(u.number)}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Financial Category</label>
                    <select
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value as Payment['category'])}
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    >
                      <option value="Rent">Rent Payment</option>
                      <option value="Maintenance">Maintenance HOA</option>
                      <option value="Booking">Booking Deposit/Bal</option>
                      <option value="Utility">Utility Payment</option>
                      <option value="Other">Other Approved</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Amount</label>
                    <input
                      type="number"
                      value={editAmount}
                      onChange={(e) => setEditAmount(e.target.value)}
                      required
                      className="w-full p-2.5 border border-slate-200 rounded-xl font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Currency</label>
                    <select
                      value={editCurrency}
                      onChange={(e) => setEditCurrency(e.target.value as 'USD' | 'JMD')}
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    >
                      <option value="JMD">JMD (J$)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Payment Method</label>
                    <select
                      value={editMethod}
                      onChange={(e) => setEditMethod(e.target.value as Payment['method'])}
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    >
                      <option value="Bank Transfer">Bank Transfer</option>
                      <option value="Cash">Cash</option>
                      <option value="Cheque">Cheque</option>
                      <option value="Credit Card">Credit/Debit Card</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Payment Date</label>
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      required
                      className="w-full p-2.5 border border-slate-200 rounded-xl font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Record Status</label>
                    <select
                      value={editStatus}
                      onChange={(e) => setEditStatus(e.target.value as 'completed' | 'reversed')}
                      className="w-full p-2.5 border border-slate-200 rounded-xl font-semibold"
                    >
                      <option value="completed">Active/Completed</option>
                      <option value="reversed">Voided/Reversed</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Reference Code</label>
                  <input
                    type="text"
                    value={editReference}
                    onChange={(e) => setEditReference(e.target.value)}
                    className="w-full p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Staff Notes / Description</label>
                  <textarea
                    rows={3}
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="w-full p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>

                <div className="pt-2 flex gap-3">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-1.5"
                  >
                    <Save className="w-4 h-4" />
                    {loading ? 'Saving Changes...' : 'Save Override'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditingPayment(false)}
                    className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
