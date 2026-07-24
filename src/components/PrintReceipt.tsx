/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Payment } from '../types';
import { Printer, X, ShieldCheck, RefreshCw, FileText } from 'lucide-react';

interface PrintReceiptProps {
  payment: Payment;
  onClose: () => void;
}

export default function PrintReceipt({ payment, onClose }: PrintReceiptProps) {
  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 print:relative print:bg-white print:p-0">
      <div className="bg-white rounded-2xl max-w-sm w-full max-h-[95vh] overflow-y-auto shadow-2xl border border-slate-100 flex flex-col print:shadow-none print:border-none print:max-h-full print:overflow-visible">
        
        {/* Navigation / Header Buttons (will be hidden during print) */}
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 print:hidden">
          <span className="text-xs font-mono font-medium text-slate-500">Print Receipt Viewer</span>
          <div className="flex gap-2">
            <button
              onClick={handlePrint}
              className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-xs"
            >
              <Printer className="w-3.5 h-3.5" />
              Print Receipt
            </button>
            <button
              onClick={onClose}
              className="p-1.5 border border-slate-200 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Printable Document Area */}
        <div id="printable-receipt-area" className="p-6 space-y-5 bg-white font-sans text-slate-800">
          
          {/* Brand Header */}
          <div className="text-center space-y-1">
            <h2 className="text-lg font-display font-bold text-slate-900 tracking-tight">VILLAGGIO DEL SOL</h2>
            <p className="text-[10px] font-mono text-slate-500 uppercase">16-Unit HOA gated Residence</p>
            <p className="text-[11px] text-slate-400">Ocho Rios, St. Ann, Jamaica</p>
          </div>

          <div className="border-y border-dashed border-slate-200 py-3 flex justify-between text-xs font-mono">
            <div>
              <p className="text-slate-400">RECEIPT NO:</p>
              <p className="font-semibold text-slate-900">{payment.receiptNo}</p>
            </div>
            <div className="text-right">
              <p className="text-slate-400">DATE:</p>
              <p className="font-semibold text-slate-900">{payment.date}</p>
            </div>
          </div>

          {/* Core Information Grid */}
          <div className="space-y-3.5 text-xs">
            <div className="flex justify-between pb-2 border-b border-slate-100">
              <span className="text-slate-400">Received From:</span>
              <span className="font-semibold text-slate-900">{payment.payerName}</span>
            </div>
            
            <div className="flex justify-between pb-2 border-b border-slate-100">
              <span className="text-slate-400">Villa Allocation:</span>
              <span className="font-semibold text-slate-900 font-mono">Unit {payment.unitNumber}</span>
            </div>

            <div className="flex justify-between pb-2 border-b border-slate-100">
              <span className="text-slate-400">Payment Category:</span>
              <span className="font-semibold text-slate-900">{payment.category} Account</span>
            </div>

            <div className="flex justify-between pb-2 border-b border-slate-100">
              <span className="text-slate-400">Payment Method:</span>
              <span className="font-semibold text-slate-900">{payment.method}</span>
            </div>

            {payment.reference && (
              <div className="flex justify-between pb-2 border-b border-slate-100">
                <span className="text-slate-400">TXN Reference ID:</span>
                <span className="font-semibold text-slate-900 font-mono">{payment.reference}</span>
              </div>
            )}

            {payment.notes && (
              <div className="pb-2 border-b border-slate-100">
                <span className="text-slate-400 block mb-0.5">Notes:</span>
                <span className="text-slate-600 italic block">"{payment.notes}"</span>
              </div>
            )}
          </div>

          {/* Giant Amount Display */}
          <div className="p-4 bg-slate-50 rounded-xl text-center border border-slate-100">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block">Total Amount Settled</span>
            <span className="text-2xl font-mono font-bold text-slate-900 mt-1 block">
              {payment.currency === 'USD' ? 'USD $' : 'JMD J$'}{payment.amount.toLocaleString()}
            </span>
          </div>

          {/* Audit Trail Signatures */}
          <div className="border-t border-slate-100 pt-4 flex justify-between items-center text-[10px] font-mono text-slate-400">
            <div>
              <p>RECORDED BY STAFF:</p>
              <p className="font-semibold text-slate-700 uppercase mt-0.5">{payment.staffMember}</p>
            </div>
            <div className="text-right">
              <p>RECEIPT STATUS:</p>
              <p className={`font-bold uppercase mt-0.5 ${payment.status === 'completed' ? 'text-emerald-600' : 'text-red-500'}`}>
                {payment.status}
              </p>
            </div>
          </div>

          {payment.status === 'reversed' && (
            <div className="p-3 bg-red-50 border border-red-100 text-red-800 text-[10px] rounded-lg font-mono leading-normal">
              <p className="font-semibold uppercase text-red-700">⚠️ VOID RECEIPT HISTORY:</p>
              <p className="mt-0.5"><strong>Voided by:</strong> {payment.reversedBy} on {payment.reversalDate}</p>
              <p className="mt-0.5"><strong>Reason:</strong> "{payment.reversalReason}"</p>
            </div>
          )}

          {/* Professional Footer */}
          <div className="text-center pt-2 border-t border-dashed border-slate-100">
            <p className="text-[9px] font-mono text-slate-400 uppercase">Thank you for your cooperation.</p>
            <p className="text-[8px] font-mono text-slate-300 mt-0.5">VDS Property Ledger System Audit Signature verified.</p>
          </div>

        </div>

      </div>
    </div>
  );
}
