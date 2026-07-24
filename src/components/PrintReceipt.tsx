/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Payment, Unit, getUnitDisplayName } from '../types';
import { formatMoneyLong } from '../lib/money';
import { formatDayLabel } from '../lib/dates';
import PrintPortal, { PrintLetterhead } from './PrintPortal';

interface PrintReceiptProps {
  payment: Payment;
  units: Unit[];
  onClose: () => void;
  onMarkPrinted: (paymentId: string) => Promise<unknown>;
}

export default function PrintReceipt({ payment, units, onClose, onMarkPrinted }: PrintReceiptProps) {
  const unit = units.find(u => u.id === payment.unitId);
  const unitLabel = unit ? getUnitDisplayName(unit.number) : `Unit ${payment.unitNumber}`;
  const isReprint = (payment.printCount || 0) > 0;

  return (
    <PrintPortal
      title={`Receipt ${payment.receiptNo}`}
      subtitle={`${payment.payerName} — ${formatMoneyLong(payment.amount, payment.currency)}`}
      maxWidthClass="max-w-md"
      onClose={onClose}
      onBeforePrint={() => {
        // Recorded server-side so a second copy is identifiable as a reprint.
        void onMarkPrinted(payment.id).catch(() => undefined);
      }}
    >
      <PrintLetterhead
        documentTitle="Official Receipt"
        meta={`Receipt No. ${payment.receiptNo}`}
        generatedBy={payment.staffMember}
      />

      {payment.status === 'reversed' && (
        <div className="print-emphasis mb-5 rounded-lg border-2 border-red-600 bg-red-50 p-3 text-center">
          <p className="text-base font-black uppercase tracking-[0.3em] text-red-700">VOID</p>
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-red-800">
            Voided by {payment.reversedBy} on {formatDayLabel(payment.reversalDate || '')}
            <br />
            Reason: “{payment.reversalReason}”
          </p>
        </div>
      )}

      {isReprint && payment.status !== 'reversed' && (
        <div className="print-emphasis mb-4 rounded-lg border border-amber-400 bg-amber-50 px-3 py-1.5 text-center">
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-amber-800">
            Reprint — duplicate of receipt {payment.receiptNo}
          </p>
        </div>
      )}

      <dl className="space-y-0 text-xs">
        {[
          ['Date received', formatDayLabel(payment.date)],
          ['Received from', payment.payerName],
          ['Villa allocation', unitLabel],
          ['Payment for', `${payment.category}`],
          ['Payment method', payment.method],
          ...(payment.reference ? [['Reference', payment.reference]] : [])
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-slate-200 py-2">
            <dt className="text-slate-500">{label}</dt>
            <dd className="text-right font-semibold text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      {payment.notes && (
        <div className="mt-3 border-b border-slate-200 pb-2 text-xs">
          <span className="mb-0.5 block text-slate-500">Notes</span>
          <span className="block italic text-slate-700">“{payment.notes}”</span>
        </div>
      )}

      <div className="mt-5 rounded-xl border border-slate-300 bg-slate-50 p-4 text-center">
        <span className="block font-mono text-[10px] uppercase tracking-wider text-slate-500">Amount received</span>
        <span className="mt-1 block font-mono text-2xl font-bold text-slate-900">
          {formatMoneyLong(payment.amount, payment.currency)}
        </span>
        <span className="mt-1 block font-mono text-[9px] text-slate-500">
          Received in {payment.currency}. This receipt does not convert currencies.
        </span>
      </div>

      <div className="mt-6 flex items-end justify-between gap-6 border-t border-slate-200 pt-5 text-[10px] font-mono text-slate-500">
        <div className="flex-1">
          <div className="mb-1 h-7 border-b border-slate-400" />
          <p className="uppercase">Received by</p>
          <p className="mt-0.5 font-semibold uppercase text-slate-700">{payment.staffMember}</p>
        </div>
        <div className="flex-1 text-right">
          <div className="mb-1 h-7 border-b border-slate-400" />
          <p className="uppercase">Payer signature</p>
        </div>
      </div>

      <p className="mt-5 border-t border-dashed border-slate-300 pt-2 text-center font-mono text-[9px] uppercase text-slate-400">
        Villaggio Del Sol — retain this receipt as proof of payment
      </p>
    </PrintPortal>
  );
}
