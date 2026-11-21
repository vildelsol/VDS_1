/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bank reconciliation, both directions.
 *
 * Ro, 2026-11-18: the reconciliation must cover money OUT as well as money in.
 * `reconciliation` in finance.ts answers "did the receipts arrive?"; this file
 * puts every movement the books say crossed the bank account into one list, each
 * with its direction, so the screen can show money in, money out and the net
 * movement per currency, and the server can find a statement line already used
 * by any kind of item.
 *
 * What counts as a bank movement, and why:
 *   - receipt: a completed receipt, gross (as `reconciliation` does). In.
 *   - expense: a cost with status `paid`, on the day it was paid. Pending is not
 *     money that left; void is money the books say never left. A supplier credit
 *     (a negative paid cost) is money coming back, so it is an IN movement of
 *     the credit's size, not a negative OUT.
 *   - refund: money handed back against a completed receipt. Out, on refundedOn.
 *   - deposit-received / damage-deposit-received: a tenancy or damage deposit
 *     taken, on the day it was received. In. It is the tenant's or guest's money
 *     held, never income, and raises no receipt, so without this line the money
 *     reached the bank and appeared nowhere on the reconciliation while its
 *     return appeared as money out (hunt, 2026-11-19: J$170,000 missing).
 *   - deposit-return / damage-deposit-return: the returned part of a held
 *     deposit. Out. A deposit kept in full returned nothing and is not listed.
 *
 * Kept out of finance.ts on purpose: it only reads records, and finance.ts is
 * shared by many changes at once.
 */

import type { BankMatch, Booking, Currency, Expense, ExpenseFund, Payment, Tenancy } from '../types';
import { isWithin } from './dates';
import { referenceKey } from './text';
import { fundOf } from '../types';
import { bookOfPaymentCategory, utilityRecoveryBook } from './finance';
import { round2, sumMoney } from './money';

export type BankItemKind =
  | 'receipt'
  | 'expense'
  | 'refund'
  | 'deposit-received'
  | 'damage-deposit-received'
  | 'deposit-return'
  | 'damage-deposit-return';

/*
 * Ro, 2026-11-20: the corporation and ISPO are two completely different entities
 * with separate bank accounts. Every movement therefore belongs to one book's
 * account, and a reconciliation is done one book (and one currency) at a time.
 *
 *   - a receipt: rent and bookings are ISPO's; maintenance and other receipts
 *     the corporation's; a utility recovery follows the bill it repays.
 *   - a cost: its fund. A refund: the receipt's book.
 *   - tenancy and damage deposits: ISPO's, which lets the villas and holds them.
 */
export function receiptBook(p: Payment, expenses: Expense[]): ExpenseFund {
  return p.category === 'Utility' ? utilityRecoveryBook(p, expenses) : bookOfPaymentCategory(p.category);
}

export interface BankItem {
  kind: BankItemKind;
  /** The entity whose bank account the money moved through. */
  book: ExpenseFund;
  /** The record the movement lives on (payment, expense, tenancy or booking id). */
  id: string;
  /** `${kind}:${id}` — one item, matched at most once. */
  key: string;
  direction: 'in' | 'out';
  date: string;
  currency: Currency;
  /** Always positive; `direction` carries the sign. */
  amount: number;
  /** How the item is named in a message: "receipt R-0001", "payment to Acme". */
  label: string;
  party: string;
  unitNumber: string;
  method?: string;
  match?: BankMatch;
}

export interface BankRecInput {
  payments: Payment[];
  expenses?: Expense[];
  tenancies?: Tenancy[];
  bookings?: Booking[];
}

const receiptMatch = (p: Payment): BankMatch | undefined =>
  p.reconciledOn ? { on: p.reconciledOn, by: p.reconciledBy || '', at: p.reconciledAt || '', reference: p.reconciledReference } : undefined;

/** Every movement the books say crossed the bank, any date, any currency. */
export function bankItems({ payments, expenses = [], tenancies = [], bookings = [] }: BankRecInput): BankItem[] {
  const out: BankItem[] = [];
  for (const p of payments) {
    if (p.derived || p.status !== 'completed') continue;
    const book = receiptBook(p, expenses);
    out.push({
      kind: 'receipt', book, id: p.id, key: `receipt:${p.id}`, direction: 'in', date: p.date, currency: p.currency,
      amount: round2(p.amount), label: `receipt ${p.receiptNo || p.id}`, party: p.payerName, unitNumber: p.unitNumber,
      method: p.method, match: receiptMatch(p)
    });
    if (p.refundedAmount && p.refundedAmount > 0 && p.refundedOn) {
      out.push({
        kind: 'refund', book, id: p.id, key: `refund:${p.id}`, direction: 'out', date: p.refundedOn, currency: p.currency,
        amount: round2(p.refundedAmount), label: `the refund on receipt ${p.receiptNo || p.id}`, party: p.payerName,
        unitNumber: p.unitNumber, method: p.refundMethod || p.method, match: p.refundBankMatch
      });
    }
  }
  for (const e of expenses) {
    if (e.status !== 'paid' || !e.amount) continue;
    const credit = e.amount < 0;
    out.push({
      kind: 'expense', book: fundOf(e), id: e.id, key: `expense:${e.id}`, direction: credit ? 'in' : 'out', date: e.datePaid || e.date,
      currency: e.currency, amount: round2(Math.abs(e.amount)),
      label: credit ? `the credit from ${e.vendor}` : `the payment to ${e.vendor}`, party: e.vendor, unitNumber: e.unitNumber,
      method: e.paymentMethod, match: e.bankMatch
    });
  }
  for (const t of tenancies) {
    if (t.depositReceivedOn && t.depositAmount && t.depositAmount > 0) {
      out.push({
        kind: 'deposit-received', book: 'ispo', id: t.id, key: `deposit-received:${t.id}`, direction: 'in', date: t.depositReceivedOn,
        currency: (t.depositCurrency || t.currency) as Currency, amount: round2(t.depositAmount),
        label: `the deposit received from ${t.tenantName}`, party: t.tenantName, unitNumber: t.unitNumber,
        match: t.depositBankMatch
      });
    }
    if (!t.depositReturnedOn || !(t.depositReturnedAmount && t.depositReturnedAmount > 0)) continue;
    out.push({
      kind: 'deposit-return', book: 'ispo', id: t.id, key: `deposit-return:${t.id}`, direction: 'out', date: t.depositReturnedOn,
      currency: (t.depositCurrency || t.currency) as Currency, amount: round2(t.depositReturnedAmount),
      label: `the deposit returned to ${t.tenantName}`, party: t.tenantName, unitNumber: t.unitNumber,
      match: t.depositReturnBankMatch
    });
  }
  for (const b of bookings) {
    if (b.damageDepositReceivedOn && b.damageDepositAmount && b.damageDepositAmount > 0) {
      out.push({
        kind: 'damage-deposit-received', book: 'ispo', id: b.id, key: `damage-deposit-received:${b.id}`, direction: 'in',
        date: b.damageDepositReceivedOn, currency: (b.damageDepositCurrency || b.currency) as Currency,
        amount: round2(b.damageDepositAmount), label: `the damage deposit received from ${b.guestName}`,
        party: b.guestName, unitNumber: b.unitNumber, match: b.damageDepositBankMatch
      });
    }
    if (!b.damageDepositReturnedOn || !(b.damageDepositReturnedAmount && b.damageDepositReturnedAmount > 0)) continue;
    out.push({
      kind: 'damage-deposit-return', book: 'ispo', id: b.id, key: `damage-deposit-return:${b.id}`, direction: 'out',
      date: b.damageDepositReturnedOn, currency: (b.damageDepositCurrency || b.currency) as Currency,
      amount: round2(b.damageDepositReturnedAmount), label: `the damage deposit returned to ${b.guestName}`,
      party: b.guestName, unitNumber: b.unitNumber, match: b.damageDepositReturnBankMatch
    });
  }
  return out;
}

/**
 * The item already matched to a bank reference, other than `exceptKey`.
 * Case-insensitive, across every kind: one statement line settles one item,
 * whichever way the money went.
 */
export function itemOnBankLine(items: BankItem[], reference: string, exceptKey: string): BankItem | undefined {
  const ref = referenceKey(reference);
  if (!ref) return undefined;
  // Within one entity's account only: the corporation's and ISPO's statements
  // are separate, so the same reference on each is two different lines.
  const self = items.find(i => i.key === exceptKey);
  return items.find(
    i => i.key !== exceptKey && (!self || i.book === self.book) && !!i.match && referenceKey(i.match.reference) === ref
  );
}

export interface BankSide {
  items: BankItem[];
  matched: BankItem[];
  unmatched: BankItem[];
  total: number;
  matchedTotal: number;
  unmatchedTotal: number;
}

export interface BankReconciliation {
  currency: Currency;
  /** The entity's account reconciled, or undefined for both (never shown on screen). */
  book?: ExpenseFund;
  moneyIn: BankSide;
  moneyOut: BankSide;
  /** In less out, for the ledger, for what was found on statements, and for what was not. */
  net: { total: number; matched: number; unmatched: number };
}

function side(items: BankItem[]): BankSide {
  const matched = items.filter(i => !!i.match);
  const unmatched = items.filter(i => !i.match);
  const sum = (rows: BankItem[]) => sumMoney(rows.map(i => i.amount));
  return { items, matched, unmatched, total: sum(items), matchedTotal: sum(matched), unmatchedTotal: sum(unmatched) };
}

/** One currency, one period: never combines USD and JMD. */
export function bankReconciliation(input: BankRecInput, currency: Currency, start: string, end: string, book?: ExpenseFund): BankReconciliation {
  const rows = bankItems(input)
    .filter(i => i.currency === currency && isWithin(i.date, start, end) && (!book || i.book === book))
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  const moneyIn = side(rows.filter(i => i.direction === 'in'));
  const moneyOut = side(rows.filter(i => i.direction === 'out'));
  return {
    currency,
    book,
    moneyIn,
    moneyOut,
    net: {
      total: round2(moneyIn.total - moneyOut.total),
      matched: round2(moneyIn.matchedTotal - moneyOut.matchedTotal),
      unmatched: round2(moneyIn.unmatchedTotal - moneyOut.unmatchedTotal)
    }
  };
}
