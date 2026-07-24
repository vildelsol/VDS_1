/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Unit, UtilityReading, Expense, UserRole, RolePermissions, getUnitDisplayName } from '../types';
import { ShieldCheck, Plus, ListCollapse, FileText, CheckCircle, Clock, AlertTriangle, UploadCloud, Edit, Save, Trash, FileSpreadsheet, User, Gauge, Check } from 'lucide-react';

interface UtilitiesAndExpensesProps {
  units: Unit[];
  utilities: UtilityReading[];
  expenses: Expense[];
  activeRole: UserRole;
  juniorHasAdvancedAccess: boolean;
  rolePermissions: {
    MANAGER: RolePermissions;
    FINANCE_OFFICER: RolePermissions;
    JUNIOR_OFFICER: RolePermissions;
  };
  vendors: string[];
  onAddUtilityReading: (reading: any) => Promise<UtilityReading>;
  onUpdateUtilityStatus: (id: string, status: UtilityReading['status']) => Promise<void>;
  onAddExpense: (expense: any) => Promise<Expense>;
  onUpdateExpense: (expenseId: string, fields: any) => Promise<void>;
}

export default function UtilitiesAndExpenses({
  units,
  utilities,
  expenses,
  activeRole,
  juniorHasAdvancedAccess,
  rolePermissions,
  vendors,
  onAddUtilityReading,
  onUpdateUtilityStatus,
  onAddExpense,
  onUpdateExpense
}: UtilitiesAndExpensesProps) {
  const [activeTab, setActiveTab] = useState<'utilities' | 'expenses'>('utilities');
  
  // Utility form
  const [isAddingUtility, setIsAddingUtility] = useState(false);
  const [utilityUnit, setUtilityUnit] = useState('');
  const [utilityPeriod, setUtilityPeriod] = useState('2026-06');
  const [prevReading, setPrevReading] = useState('');
  const [currReading, setCurrReading] = useState('');
  const [utilityAmount, setUtilityAmount] = useState('');
  const [utilityCurrency, setUtilityCurrency] = useState<'USD' | 'JMD'>('JMD');
  const [utilityStatus, setUtilityStatus] = useState<'paid' | 'unpaid'>('unpaid');

  // Expense form
  const [isAddingExpense, setIsAddingExpense] = useState(false);
  const [expenseCategory, setExpenseCategory] = useState<Expense['category']>('Maintenance');
  const [expenseVendor, setExpenseVendor] = useState('');
  const [expenseDesc, setExpenseDesc] = useState('');
  const [expenseUnit, setExpenseUnit] = useState('General');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseCurrency, setExpenseCurrency] = useState<'USD' | 'JMD'>('JMD');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]);
  const [expenseDueDate, setExpenseDueDate] = useState(new Date().toISOString().split('T')[0]);
  const [expenseDatePaid, setExpenseDatePaid] = useState(new Date().toISOString().split('T')[0]);
  const [expensePaymentMethod, setExpensePaymentMethod] = useState('Bank Transfer');
  const [expenseStatus, setExpenseStatus] = useState<Expense['status']>('paid');
  const [expenseRef, setExpenseRef] = useState('');
  const [expenseNotes, setExpenseNotes] = useState('');
  const [receiptSimulatedFile, setReceiptSimulatedFile] = useState<string | null>(null);

  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);

  // Click-to-view & editing state
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [isEditingExpense, setIsEditingExpense] = useState(false);
  const [editExpenseCategory, setEditExpenseCategory] = useState<Expense['category']>('Maintenance');
  const [editExpenseVendor, setEditExpenseVendor] = useState('');
  const [editExpenseDesc, setEditExpenseDesc] = useState('');
  const [editExpenseUnit, setEditExpenseUnit] = useState('General');
  const [editExpenseAmount, setEditExpenseAmount] = useState('');
  const [editExpenseCurrency, setEditExpenseCurrency] = useState<'USD' | 'JMD'>('JMD');
  const [editExpenseDate, setEditExpenseDate] = useState('');
  const [editExpenseDueDate, setEditExpenseDueDate] = useState('');
  const [editExpenseDatePaid, setEditExpenseDatePaid] = useState('');
  const [editExpensePaymentMethod, setEditExpensePaymentMethod] = useState('Bank Transfer');
  const [editExpenseStatus, setEditExpenseStatus] = useState<Expense['status']>('paid');
  const [editExpenseRef, setEditExpenseRef] = useState('');
  const [editExpenseNotes, setEditExpenseNotes] = useState('');

  const [highlightedExpenseIds, setHighlightedExpenseIds] = useState<Record<string, boolean>>({});
  const [highlightedUtilityIds, setHighlightedUtilityIds] = useState<Record<string, boolean>>({});
  const [selectedUtility, setSelectedUtility] = useState<UtilityReading | null>(null);

  const canEdit = activeRole !== 'JUNIOR_OFFICER' || juniorHasAdvancedAccess;
  const hasModifySettledPermission = activeRole === 'ADMINISTRATOR' || 
    activeRole === 'MANAGER' || 
    (rolePermissions?.[activeRole]?.modifySettledRecords === true) || 
    juniorHasAdvancedAccess;

  const handleCreateUtility = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');

    if (!utilityUnit || !prevReading || !currReading || !utilityAmount) {
      setErrorMsg('Please enter unit, meter readings, and manual charge amount.');
      return;
    }

    const p = Number(prevReading);
    const c = Number(currReading);
    if (c < p) {
      setErrorMsg('Current reading cannot be lower than previous meter reading.');
      return;
    }

    setLoading(true);
    const matchedUnit = units.find(u => u.number === utilityUnit);

    try {
      await onAddUtilityReading({
        unitNumber: utilityUnit,
        meterNumber: matchedUnit?.meterNumber || `VDS-MET-${Math.floor(1000 + Math.random() * 9000)}`,
        billingPeriod: utilityPeriod,
        previousReading: p,
        currentReading: c,
        consumption: c - p,
        amountCharged: Number(utilityAmount),
        currency: utilityCurrency,
        status: utilityStatus
      });

      setSuccessMsg(`Utility reading saved successfully for Villa ${utilityUnit}.`);
      setIsAddingUtility(false);
      setPrevReading('');
      setCurrReading('');
      setUtilityAmount('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error recording utility logs.');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectExpenseDetail = (e: Expense) => {
    setSelectedExpense(e);
    setIsEditingExpense(false);
    setEditExpenseCategory(e.category);
    setEditExpenseVendor(e.vendor);
    setEditExpenseDesc(e.description || '');
    setEditExpenseUnit(e.unitNumber);
    setEditExpenseAmount(String(e.amount));
    setEditExpenseCurrency(e.currency);
    setEditExpenseDate(e.date);
    setEditExpenseDueDate(e.dueDate || e.date || new Date().toISOString().split('T')[0]);
    setEditExpenseDatePaid(e.datePaid || '');
    setEditExpensePaymentMethod(e.paymentMethod || 'Bank Transfer');
    setEditExpenseStatus(e.status);
    setEditExpenseRef(e.reference || '');
    setEditExpenseNotes(e.notes || '');
  };

  const handleSaveExpenseEdit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!selectedExpense) return;
    if (!hasModifySettledPermission) {
      setErrorMsg('You do not have permission to modify settled ledger records.');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    try {
      await onUpdateExpense(selectedExpense.id, {
        category: editExpenseCategory,
        vendor: editExpenseVendor,
        description: editExpenseDesc,
        unitNumber: editExpenseUnit,
        amount: Number(editExpenseAmount),
        currency: editExpenseCurrency,
        date: editExpenseDate,
        dueDate: editExpenseDueDate,
        datePaid: editExpenseStatus === 'paid' ? editExpenseDatePaid : '',
        paymentMethod: editExpensePaymentMethod,
        status: editExpenseStatus,
        reference: editExpenseRef,
        notes: editExpenseNotes
      });
      setSuccessMsg(`Expense log ${selectedExpense.id} updated successfully.`);
      setSelectedExpense(null);
      setIsEditingExpense(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error updating expense record.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');

    if (!expenseVendor || !expenseAmount) {
      setErrorMsg('Payer/Vendor and expense amount are required.');
      return;
    }

    setLoading(true);

    try {
      await onAddExpense({
        category: expenseCategory,
        vendor: expenseVendor,
        description: expenseDesc,
        unitNumber: expenseUnit,
        amount: Number(expenseAmount),
        currency: expenseCurrency,
        date: expenseDate,
        dueDate: expenseDueDate,
        datePaid: expenseStatus === 'paid' ? expenseDatePaid : '',
        paymentMethod: expensePaymentMethod,
        status: expenseStatus,
        reference: expenseRef,
        notes: expenseNotes + (receiptSimulatedFile ? ` [Receipt Attached: ${receiptSimulatedFile}]` : '')
      });

      setSuccessMsg('Operational expense logged successfully!');
      setIsAddingExpense(false);
      setExpenseVendor('');
      setExpenseDesc('');
      setExpenseAmount('');
      setExpenseRef('');
      setExpenseNotes('');
      setExpenseDueDate(new Date().toISOString().split('T')[0]);
      setExpenseDatePaid(new Date().toISOString().split('T')[0]);
      setExpensePaymentMethod('Bank Transfer');
      setReceiptSimulatedFile(null);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error recording expense.');
    } finally {
      setLoading(false);
    }
  };

  const handleSimulateUpload = () => {
    const filenames = ['invoice_9821.pdf', 'prop_tax_receipt.png', 'ncb_wire_transfer_receipt.jpg', 'contractor_contract_signed.pdf'];
    const randomName = filenames[Math.floor(Math.random() * filenames.length)];
    setReceiptSimulatedFile(randomName);
  };

  return (
    <div className="space-y-6">
      {/* Tab Select & Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex gap-4">
          <button
            onClick={() => { setActiveTab('utilities'); setErrorMsg(''); setSuccessMsg(''); }}
            className={`pb-1 text-base font-display font-medium border-b-2 transition-all ${activeTab === 'utilities' ? 'border-teal-600 text-slate-900 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            Metered Utilities
          </button>
          <button
            onClick={() => { setActiveTab('expenses'); setErrorMsg(''); setSuccessMsg(''); }}
            className={`pb-1 text-base font-display font-medium border-b-2 transition-all ${activeTab === 'expenses' ? 'border-teal-600 text-slate-900 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            Operations Expenses Register
          </button>
        </div>
        <div className="flex gap-2">
          {activeTab === 'utilities' ? (
            <button
              onClick={() => {
                if (!canEdit) {
                  alert('Unauthorized: Junior Officers cannot log utility readings.');
                  return;
                }
                setIsAddingUtility(true);
              }}
              className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> Log Meter Reading
            </button>
          ) : (
            <button
              onClick={() => {
                if (!canEdit) {
                  alert('Unauthorized: Junior Officers cannot log operational expenses.');
                  return;
                }
                setIsAddingExpense(true);
              }}
              className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> Log Property Expense
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 bg-red-50 border border-red-100 text-red-800 text-xs rounded-xl flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-red-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3 bg-teal-50 border border-teal-100 text-teal-800 text-xs rounded-xl">
          {successMsg}
        </div>
      )}

      {/* Tab Panels */}
      {activeTab === 'utilities' ? (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-xs overflow-hidden">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 font-mono text-[10px] uppercase">
                <th className="p-4 w-12 text-center">#</th>
                <th className="p-4 w-12 text-center">Select</th>
                <th className="p-4">Unit</th>
                <th className="p-4">Meter ID</th>
                <th className="p-4">Billing Month</th>
                <th className="p-4">Indices (Prev &gt; Curr)</th>
                <th className="p-4">Consumption</th>
                <th className="p-4">Charge</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono text-slate-700">
              {utilities.map((u, index) => {
                const isChecked = !!highlightedUtilityIds[u.id];
                const utilityRowColors = [
                  'bg-sky-50/50 text-sky-900 border-l-4 border-sky-400',
                  'bg-indigo-50/50 text-indigo-900 border-l-4 border-indigo-400',
                  'bg-amber-50/40 text-amber-900 border-l-4 border-amber-400',
                  'bg-emerald-50/40 text-emerald-900 border-l-4 border-emerald-400',
                  'bg-purple-50/40 text-purple-900 border-l-4 border-purple-400'
                ];
                const rowStyle = utilityRowColors[index % utilityRowColors.length];
                
                return (
                  <tr 
                    key={u.id} 
                    onClick={() => {
                      if (isChecked) {
                        setSelectedUtility(u);
                      }
                    }}
                    className={`transition-all ${isChecked ? `${rowStyle} cursor-pointer font-semibold shadow-xs` : 'bg-white hover:bg-slate-50/30 text-slate-400 cursor-not-allowed opacity-60'}`}
                    title={isChecked ? 'Click to view details' : 'Highlight checkbox first to view details'}
                  >
                    <td className="p-4 text-center font-bold font-mono text-[11px] text-slate-400">
                      {String(index + 1).padStart(2, '0')}
                    </td>
                    <td className="p-4 text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => setHighlightedUtilityIds(prev => ({ ...prev, [u.id]: !prev[u.id] }))}
                        className="rounded text-teal-600 focus:ring-teal-500 h-4 w-4 border-slate-300 cursor-pointer"
                      />
                    </td>
                    <td className="p-4 font-semibold font-sans text-slate-900">Villa {u.unitNumber}</td>
                    <td className="p-4">{u.meterNumber}</td>
                    <td className="p-4">{u.billingPeriod}</td>
                    <td className="p-4">{u.previousReading} &rarr; {u.currentReading}</td>
                    <td className="p-4 font-semibold text-slate-900">{u.consumption} units</td>
                    <td className="p-4 font-semibold text-slate-800">
                      {u.currency === 'USD' ? '$' : 'J$'}{u.amountCharged.toLocaleString()}
                    </td>
                    <td className="p-4 font-sans">
                      {u.status === 'paid' ? (
                        <span className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-100 text-emerald-800 font-medium">
                          Paid
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 text-[10px] rounded-full bg-amber-100 text-amber-800 font-medium">
                          Unpaid
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-right font-sans" onClick={(e) => e.stopPropagation()}>
                      {u.status === 'unpaid' && (
                        <button
                          onClick={() => onUpdateUtilityStatus(u.id, 'paid')}
                          disabled={!isChecked}
                          className={`px-2 py-1 text-[10px] border rounded-lg font-medium transition-all ${
                            isChecked 
                              ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200 cursor-pointer' 
                              : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                          }`}
                          title={isChecked ? 'Mark Paid' : 'Highlight checkbox first to update status'}
                        >
                          Mark Paid
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-xs overflow-hidden">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 font-mono text-[10px] uppercase">
                <th className="p-4 w-12 text-center">#</th>
                <th className="p-4 w-12 text-center">Select</th>
                <th className="p-4">Category</th>
                <th className="p-4">Vendor / Payee</th>
                <th className="p-4">Description</th>
                <th className="p-4">Allocation</th>
                <th className="p-4">Amount</th>
                <th className="p-4">Due Date</th>
                <th className="p-4">Paid Date</th>
                <th className="p-4">Method</th>
                <th className="p-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {expenses.map((e, index) => {
                const isChecked = !!highlightedExpenseIds[e.id];
                const expenseRowColors = [
                  'bg-slate-50/80 text-slate-900 border-l-4 border-slate-400',
                  'bg-rose-50/50 text-rose-900 border-l-4 border-rose-400',
                  'bg-teal-50/50 text-teal-900 border-l-4 border-teal-400',
                  'bg-violet-50/50 text-violet-900 border-l-4 border-violet-400',
                  'bg-amber-50/40 text-amber-900 border-l-4 border-amber-400'
                ];
                const rowStyle = expenseRowColors[index % expenseRowColors.length];

                return (
                  <tr 
                    key={e.id} 
                    onClick={() => {
                      if (isChecked) {
                        handleSelectExpenseDetail(e);
                      }
                    }}
                    className={`transition-colors ${isChecked ? `${rowStyle} cursor-pointer font-semibold shadow-xs` : 'bg-white hover:bg-slate-50/30 text-slate-400 cursor-not-allowed opacity-60'}`}
                    title={isChecked ? 'Click to view details' : 'Highlight checkbox first to view details'}
                  >
                    <td className="p-4 text-center font-bold font-mono text-[11px] text-slate-400">
                      {String(index + 1).padStart(2, '0')}
                    </td>
                    <td className="p-4 text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => setHighlightedExpenseIds(prev => ({ ...prev, [e.id]: !prev[e.id] }))}
                        className="rounded text-teal-600 focus:ring-teal-500 h-4 w-4 border-slate-300 cursor-pointer"
                      />
                    </td>
                    <td className="p-4 font-medium text-slate-950">{e.category}</td>
                    <td className="p-4">{e.vendor}</td>
                    <td className="p-4 text-slate-500 italic max-w-xs truncate font-sans" title={e.description}>
                      {e.description}
                    </td>
                    <td className="p-4 font-mono text-[11px]">
                      {e.unitNumber === 'General' ? 'General HOA' : `Villa ${e.unitNumber}`}
                    </td>
                    <td className="p-4 font-mono font-semibold text-slate-900">
                      {e.currency === 'USD' ? '$' : 'J$'}{e.amount.toLocaleString()}
                    </td>
                    <td className="p-4 font-mono text-[11px] text-slate-500">{e.dueDate || e.date}</td>
                    <td className="p-4 font-mono text-[11px] text-slate-500">{e.status === 'paid' ? (e.datePaid || e.date) : 'N/A'}</td>
                    <td className="p-4 font-mono text-[11px] text-slate-500">{e.paymentMethod || 'Bank Transfer'}</td>
                    <td className="p-4">
                      {e.status === 'paid' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full bg-emerald-50 text-emerald-800 font-semibold border border-emerald-100">
                          <CheckCircle className="w-3 h-3 text-emerald-600" /> Settled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full bg-amber-50 text-amber-800 font-semibold border border-amber-100">
                          <Clock className="w-3 h-3 text-amber-600" /> Pending
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Log Utility Readings Modal */}
      {isAddingUtility && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreateUtility} className="bg-white rounded-2xl max-w-sm w-full shadow-xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="text-base font-display font-semibold text-slate-900">Log Manual Utility Reading</h3>
              <button type="button" onClick={() => setIsAddingUtility(false)} className="text-slate-400 hover:text-slate-600 font-semibold text-xl">
                &times;
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Villa Unit</label>
                  <select
                    value={utilityUnit}
                    onChange={(e) => setUtilityUnit(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="">Select</option>
                    {units.map((u) => (
                      <option key={u.id} value={u.number}>{getUnitDisplayName(u.number)}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Billing Month</label>
                  <input
                    type="month"
                    value={utilityPeriod}
                    onChange={(e) => setUtilityPeriod(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 font-mono">
                <div>
                  <label className="text-[11px] font-mono text-slate-500 block mb-1">Previous Index</label>
                  <input
                    type="number"
                    value={prevReading}
                    onChange={(e) => setPrevReading(e.target.value)}
                    placeholder="12450"
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-mono text-slate-500 block mb-1">Current Index</label>
                  <input
                    type="number"
                    value={currReading}
                    onChange={(e) => setCurrReading(e.target.value)}
                    placeholder="12590"
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Calculated Charge</label>
                  <input
                    type="number"
                    value={utilityAmount}
                    onChange={(e) => setUtilityAmount(e.target.value)}
                    placeholder="e.g. 4200"
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Currency</label>
                  <select
                    value={utilityCurrency}
                    onChange={(e) => setUtilityCurrency(e.target.value as 'USD' | 'JMD')}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="JMD">JMD (J$)</option>
                    <option value="USD">USD ($)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Initial Status</label>
                <select
                  value={utilityStatus}
                  onChange={(e) => setUtilityStatus(e.target.value as 'paid' | 'unpaid')}
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                >
                  <option value="unpaid">Outstanding Bill (Unpaid)</option>
                  <option value="paid">Settled Immediately (Paid)</option>
                </select>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all"
              >
                {loading ? 'Recording Meter...' : 'Save Utility Record'}
              </button>
              <button
                type="button"
                onClick={() => setIsAddingUtility(false)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-100 transition-all"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Log Property Expenses Modal */}
      {isAddingExpense && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreateExpense} className="bg-white rounded-2xl max-w-md w-full shadow-xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="text-base font-display font-semibold text-slate-900">Log Property Operational Expense</h3>
              <button type="button" onClick={() => setIsAddingExpense(false)} className="text-slate-400 hover:text-slate-600 font-semibold text-xl">
                &times;
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Expense Category</label>
                  <select
                    value={expenseCategory}
                    onChange={(e) => setExpenseCategory(e.target.value as Expense['category'])}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="Maintenance">Maintenance Repair</option>
                    <option value="Security">Security Patrol</option>
                    <option value="Landscaping">Landscaping/Pool</option>
                    <option value="Utilities">Utilities HOA</option>
                    <option value="Payroll">Staff Payroll</option>
                    <option value="Property Taxes">Property Taxes</option>
                    <option value="Supplies">Operating Supplies</option>
                    <option value="Contractors">Third-Party Contractors</option>
                    <option value="Other">Other Category</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Allocated Unit</label>
                  <select
                    value={expenseUnit}
                    onChange={(e) => setExpenseUnit(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  >
                    <option value="General">General / Common Area</option>
                    {units.map((u) => (
                      <option key={u.id} value={u.number}>{getUnitDisplayName(u.number)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Vendor / Payee</label>
                  <select
                    value={expenseVendor}
                    onChange={(e) => setExpenseVendor(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="">-- Select Registered Vendor --</option>
                    {vendors && vendors.map((vendorName, idx) => (
                      <option key={idx} value={vendorName}>{vendorName}</option>
                    ))}
                    {(!vendors || vendors.length === 0) && (
                      <>
                        <option value="Jamaica Public Service (JPS)">Jamaica Public Service (JPS)</option>
                        <option value="National Water Commission (NWC)">National Water Commission (NWC)</option>
                        <option value="Guardian Security Services">Guardian Security Services</option>
                        <option value="Jamaica Plumbers Ltd">Jamaica Plumbers Ltd</option>
                        <option value="Island Landscaping & Gardeners">Island Landscaping & Gardeners</option>
                      </>
                    )}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Bill Description</label>
                  <input
                    type="text"
                    value={expenseDesc}
                    onChange={(e) => setExpenseDesc(e.target.value)}
                    placeholder="e.g. Fixed leaking pipes"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 font-mono">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Expense Cost</label>
                  <input
                    type="number"
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    placeholder="e.g. 120"
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>

                <div className="font-sans">
                  <label className="text-xs font-mono text-slate-500 block mb-1">Currency</label>
                  <select
                    value={expenseCurrency}
                    onChange={(e) => setExpenseCurrency(e.target.value as 'USD' | 'JMD')}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="JMD">JMD (J$)</option>
                    <option value="USD">USD ($)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Due Date</label>
                  <input
                    type="date"
                    value={expenseDueDate}
                    onChange={(e) => setExpenseDueDate(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Settlement Status</label>
                  <select
                    value={expenseStatus}
                    onChange={(e) => setExpenseStatus(e.target.value as Expense['status'])}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="paid">Settled / Paid</option>
                    <option value="pending">Pending / Invoice Outstanding</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Date Paid</label>
                  <input
                    type="date"
                    value={expenseDatePaid}
                    disabled={expenseStatus !== 'paid'}
                    onChange={(e) => setExpenseDatePaid(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono disabled:bg-slate-100 disabled:text-slate-400"
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Payment Method</label>
                  <select
                    value={expensePaymentMethod}
                    disabled={expenseStatus !== 'paid'}
                    onChange={(e) => setExpensePaymentMethod(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Cash">Cash</option>
                    <option value="Credit/Debit Card">Credit/Debit Card</option>
                    <option value="Cheque">Cheque</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Reference / Wire TXN ID</label>
                <input
                  type="text"
                  value={expenseRef}
                  onChange={(e) => setExpenseRef(e.target.value)}
                  placeholder="e.g. SAGICOR-TR-0041"
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                />
              </div>

              {/* Receipt Image File Dropper Simulation */}
              <div className="border border-dashed border-slate-200 rounded-2xl p-4 flex flex-col items-center justify-center space-y-2 bg-slate-50 hover:bg-slate-100/50 transition-colors">
                <UploadCloud className="w-8 h-8 text-slate-400" />
                <div className="text-center">
                  <button
                    type="button"
                    onClick={handleSimulateUpload}
                    className="text-xs text-teal-600 font-semibold hover:underline"
                  >
                    Upload Invoice Receipt File
                  </button>
                  <p className="text-[10px] text-slate-400 mt-0.5">Drag-and-drop or select locally (PDF, PNG, JPG)</p>
                </div>
                {receiptSimulatedFile && (
                  <div className="px-3 py-1 bg-emerald-50 border border-emerald-100 text-[10px] text-emerald-800 rounded-lg flex items-center gap-1.5 font-mono">
                    <FileText className="w-3.5 h-3.5" />
                    <span>{receiptSimulatedFile}</span>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Internal Notes</label>
                <textarea
                  rows={2}
                  value={expenseNotes}
                  onChange={(e) => setExpenseNotes(e.target.value)}
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
                {loading ? 'Logging Outlay...' : 'Save Outlay Record'}
              </button>
              <button
                type="button"
                onClick={() => setIsAddingExpense(false)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-100 transition-all"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Expense View / Edit Detail Modal */}
      {selectedExpense && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-teal-600" />
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900">Expense Log Details</h3>
                  <span className="text-[10px] font-mono text-slate-500">Log ID: {selectedExpense.id}</span>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setSelectedExpense(null)} 
                className="text-slate-400 hover:text-slate-600 text-xl font-semibold font-sans"
              >
                &times;
              </button>
            </div>

            {!isEditingExpense ? (
              // View mode
              <div className="p-6 space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Vendor / Payee</span>
                    <span className="font-semibold text-slate-900 text-sm">{selectedExpense.vendor}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Allocation Unit</span>
                    <span className="font-semibold text-slate-900 text-sm">
                      {selectedExpense.unitNumber === 'General' ? 'General HOA' : `Villa ${selectedExpense.unitNumber}`}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Expense Category</span>
                    <span className="inline-block mt-0.5 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-800 font-mono font-medium">
                      {selectedExpense.category}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Amount Billed</span>
                    <span className="font-semibold font-mono text-slate-900 text-sm">
                      {selectedExpense.currency === 'USD' ? '$' : 'J$'}{selectedExpense.amount.toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Due Date</span>
                    <span className="font-semibold text-slate-900 font-mono text-xs">{selectedExpense.dueDate || selectedExpense.date}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Date Paid</span>
                    <span className="font-semibold text-slate-900 font-mono text-xs">
                      {selectedExpense.status === 'paid' ? (selectedExpense.datePaid || selectedExpense.date) : 'Unpaid (Pending)'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Payment Method</span>
                    <span className="font-semibold text-slate-800 text-xs">{selectedExpense.paymentMethod || 'Bank Transfer'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Settlement Status</span>
                    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full font-semibold ${selectedExpense.status === 'paid' ? 'bg-emerald-50 text-emerald-800 border border-emerald-100' : 'bg-amber-50 text-amber-800 border border-amber-100'}`}>
                      {selectedExpense.status === 'paid' ? 'Paid / Settled' : 'Pending Payment'}
                    </span>
                  </div>
                </div>

                <div className="border-b border-slate-100 pb-4">
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Receipt Reference Code</span>
                  <span className="font-mono text-slate-800 bg-slate-50 px-2 py-1 rounded mt-1 inline-block text-[11px]">
                    {selectedExpense.reference || 'No reference code recorded'}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Expense Purpose & Description</span>
                  <div className="p-3 bg-slate-50 rounded-xl text-slate-700 italic mt-1 leading-relaxed whitespace-pre-wrap">
                    {selectedExpense.description || 'No description provided.'}
                  </div>
                </div>

                {selectedExpense.notes && (
                  <div>
                    <span className="text-slate-400 block font-mono text-[10px] uppercase">Internal Staff Notes</span>
                    <div className="p-3 bg-slate-100/50 rounded-xl text-slate-600 mt-1 leading-relaxed whitespace-pre-wrap">
                      {selectedExpense.notes}
                    </div>
                  </div>
                )}

                <div className="pt-4 flex gap-3">
                  {hasModifySettledPermission ? (
                    <button
                      type="button"
                      onClick={() => setIsEditingExpense(true)}
                      className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition-all flex items-center justify-center gap-1.5"
                    >
                      <Edit className="w-4 h-4" />
                      Modify Expense Details
                    </button>
                  ) : (
                    <div className="w-full text-center py-2 px-3 bg-amber-50 rounded-xl text-amber-700 text-[10px]">
                      🔒 Modification of logged expenses is restricted to authorized roles (Administrators or Property Managers).
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedExpense(null)}
                    className="px-5 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-semibold rounded-xl transition-all"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ) : (
              // Edit Mode
              <form onSubmit={handleSaveExpenseEdit} className="p-6 space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Payee / Vendor</label>
                    <input
                      type="text"
                      value={editExpenseVendor}
                      onChange={(e) => setEditExpenseVendor(e.target.value)}
                      required
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Allocation Unit</label>
                    <select
                      value={editExpenseUnit}
                      onChange={(e) => setEditExpenseUnit(e.target.value)}
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    >
                      <option value="General">General HOA</option>
                      {units.map((u) => (
                        <option key={u.id} value={u.number}>{getUnitDisplayName(u.number)}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Expense Category</label>
                    <select
                      value={editExpenseCategory}
                      onChange={(e) => setEditExpenseCategory(e.target.value as Expense['category'])}
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    >
                      <option value="Security">Security Patrols</option>
                      <option value="Maintenance">General Repairs</option>
                      <option value="Landscaping">Lush Grounds Upkeep</option>
                      <option value="Insurance">Property Insurance</option>
                      <option value="Property Tax">Government Taxes</option>
                      <option value="Other">Other Operational</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Amount</label>
                    <input
                      type="number"
                      value={editExpenseAmount}
                      onChange={(e) => setEditExpenseAmount(e.target.value)}
                      required
                      className="w-full p-2.5 border border-slate-200 rounded-xl font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Currency</label>
                    <select
                      value={editExpenseCurrency}
                      onChange={(e) => setEditExpenseCurrency(e.target.value as 'USD' | 'JMD')}
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    >
                      <option value="JMD">JMD (J$)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Payment Status</label>
                    <select
                      value={editExpenseStatus}
                      onChange={(e) => setEditExpenseStatus(e.target.value as Expense['status'])}
                      className="w-full p-2.5 border border-slate-200 rounded-xl font-semibold"
                    >
                      <option value="paid">Settled / Paid</option>
                      <option value="unpaid">Pending / Unpaid</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Due Date</label>
                    <input
                      type="date"
                      value={editExpenseDueDate}
                      onChange={(e) => setEditExpenseDueDate(e.target.value)}
                      required
                      className="w-full p-2.5 border border-slate-200 rounded-xl font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Date Paid</label>
                    <input
                      type="date"
                      value={editExpenseDatePaid}
                      disabled={editExpenseStatus !== 'paid'}
                      onChange={(e) => setEditExpenseDatePaid(e.target.value)}
                      className="w-full p-2.5 border border-slate-200 rounded-xl font-mono disabled:bg-slate-100 disabled:text-slate-400"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Payment Method</label>
                    <select
                      value={editExpensePaymentMethod}
                      onChange={(e) => setEditExpensePaymentMethod(e.target.value)}
                      className="w-full p-2.5 border border-slate-200 rounded-xl"
                    >
                      <option value="Bank Transfer">Bank Transfer</option>
                      <option value="Cash">Cash</option>
                      <option value="Credit/Debit Card">Credit/Debit Card</option>
                      <option value="Cheque">Cheque</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Reference Code / Transaction ID</label>
                    <input
                      type="text"
                      value={editExpenseRef}
                      onChange={(e) => setEditExpenseRef(e.target.value)}
                      className="w-full p-2.5 border border-slate-200 rounded-xl font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Purpose & Description</label>
                  <input
                    type="text"
                    value={editExpenseDesc}
                    onChange={(e) => setEditExpenseDesc(e.target.value)}
                    required
                    className="w-full p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Internal Staff Notes</label>
                  <textarea
                    rows={2}
                    value={editExpenseNotes}
                    onChange={(e) => setEditExpenseNotes(e.target.value)}
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
                    onClick={() => setIsEditingExpense(false)}
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

      {/* Metered Utility View Detail Modal */}
      {selectedUtility && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Gauge className="w-5 h-5 text-teal-600" />
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900">Utility Reading Details</h3>
                  <span className="text-[10px] font-mono text-slate-500">Log ID: {selectedUtility.id}</span>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setSelectedUtility(null)} 
                className="text-slate-400 hover:text-slate-600 text-xl font-semibold font-sans"
              >
                &times;
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                <div>
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Property Unit</span>
                  <span className="font-semibold text-slate-900 text-sm">Villa {selectedUtility.unitNumber}</span>
                </div>
                <div>
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Meter Number</span>
                  <span className="font-semibold text-slate-900 text-sm font-mono">{selectedUtility.meterNumber}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                <div>
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Billing Period</span>
                  <span className="font-semibold text-slate-900 text-sm font-mono">{selectedUtility.billingPeriod}</span>
                </div>
                <div>
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Consumption Volume</span>
                  <span className="font-semibold text-teal-600 text-sm font-mono">{selectedUtility.consumption} Units</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                <div>
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Index Range</span>
                  <span className="font-medium text-slate-700 font-mono">
                    {selectedUtility.previousReading} &rarr; {selectedUtility.currentReading}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block font-mono text-[10px] uppercase">Settlement Invoice</span>
                  <span className="font-semibold text-slate-900 text-sm font-mono">
                    {selectedUtility.currency === 'USD' ? '$' : 'J$'}{selectedUtility.amountCharged.toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="pb-4">
                <span className="text-slate-400 block font-mono text-[10px] uppercase">Settlement Status</span>
                <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full font-semibold mt-1 ${selectedUtility.status === 'paid' ? 'bg-emerald-50 text-emerald-800 border border-emerald-100' : 'bg-amber-50 text-amber-800 border border-amber-100'}`}>
                  {selectedUtility.status === 'paid' ? 'Settle / Paid' : 'Pending Payment'}
                </span>
              </div>

              <div className="pt-4 flex gap-3">
                {selectedUtility.status === 'unpaid' && (
                  <button
                    type="button"
                    onClick={async () => {
                      await onUpdateUtilityStatus(selectedUtility.id, 'paid');
                      setSelectedUtility(prev => prev ? { ...prev, status: 'paid' } : null);
                    }}
                    className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-1.5"
                  >
                    <Check className="w-4 h-4" /> Mark as Settled / Paid
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedUtility(null)}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-semibold rounded-xl transition-all flex-1"
                >
                  Dismiss Details
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
