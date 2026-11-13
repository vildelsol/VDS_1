/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The strata corporation's forward projection, as plain arithmetic.
 * Kept out of the screen so a test can hold it against the ledger.
 */

import { Charge, Currency, Expense, Payment, Unit } from '../types';
import {
  accountBalance,
  chargeAmount,
  chargeCurrency,
  chargedInPeriod,
  collectedInPeriod,
  collectionRate,
  expensesInPeriod,
  strataExpenses,
  isBillable
} from './finance';
import { round2, sumMoney } from './money';
import { addMonths, currentMonth, today } from './dates';

/** A month of the straight-line forecast. */
export interface ForecastMonth {
  month: string; // YYYY-MM
  income: number;
  expenditure: number;
  net: number;
  cumulative: number;
}

/** Everything projected for one currency. */
export interface CurrencyProjection {
  currency: Currency;
  /** Number of completed months the run-rate is averaged over. */
  lookback: number;
  from: string;
  to: string;
  /** Maintenance contributions actually received over the look-back window. */
  maintReceived: number;
  /** Maintenance billed over the look-back window. */
  maintBilled: number;
  /** Operating expenses paid over the look-back window. */
  expensesPaid: number;
  avgReceived: number;
  avgExpense: number;
  /** Collection rate over the window, or null when nothing was billed. */
  rate: number | null;
  /** Current monthly maintenance assessment across contributing proprietors. */
  contractedMonthly: number;
  contributingUnits: number;
  /** Forward projection. */
  projectedIncome: number;
  projectedExpense: number;
  projectedNet: number;
  forecast: ForecastMonth[];
  horizonIncome: number;
  horizonExpense: number;
  horizonNet: number;
  /** Maintenance arrears outstanding today. */
  arrears: number;
  arrearsAccounts: number;
  arrearsOver60: number;
  /** Whether this currency has enough activity to be worth showing. */
  active: boolean;
}

/** The historical window a projection is averaged over. */
export interface LookbackWindow {
  from: string;
  to: string;
  /** Whole months in the window — the divisor for every average below. */
  months: number;
}

export function buildProjection(
  currency: Currency,
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  expenses: Expense[],
  window: LookbackWindow,
  horizon: number
): CurrencyProjection {
  const { from, to } = window;
  // Never divide by zero if a range somehow collapses to nothing.
  const lookback = Math.max(1, window.months);

  const maintReceived = collectedInPeriod(payments, currency, from, to).maintenance;
  const maintBilled = chargedInPeriod(charges, currency, from, to).maintenance;
  /*
   * The corporation's costs only.
   *
   * This projection already excludes rent and booking income "because they
   * belong to individual proprietors, not to the corporation" — see the note at
   * the head of this file. Counting ISPO's costs against contributions while
   * excluding ISPO's income would project a deficit for the fund out of money
   * that was never the fund's, which is the same fault as the annual report's
   * and worse for being on a page that says what it excludes.
   */
  const expensesPaid = expensesInPeriod(strataExpenses(expenses), currency, from, to);

  const avgReceived = round2(maintReceived / lookback);
  const avgExpense = round2(expensesPaid / lookback);
  const rate = collectionRate(maintBilled, maintReceived);

  // Current fee schedule: what every contributing proprietor is assessed per month.
  const contributing = units.filter(u => isBillable(u, 'Maintenance') && chargeCurrency(u, 'Maintenance') === currency);
  const contractedMonthly = sumMoney(contributing.map(u => chargeAmount(u, 'Maintenance')));

  // Projected monthly contributions: the current assessment tempered by the recent
  // collection rate (a rate above 100% is arrears catch-up, not a sustainable
  // run-rate, so it is capped). With no assessment on file, fall back to the plain
  // average actually received.
  const effRate = rate === null ? 1 : Math.min(rate, 100) / 100;
  const projectedIncome = contractedMonthly > 0 ? round2(contractedMonthly * effRate) : avgReceived;
  const projectedExpense = avgExpense;
  const projectedNet = round2(projectedIncome - projectedExpense);

  const forecast: ForecastMonth[] = [];
  let cumulative = 0;
  for (let i = 1; i <= horizon; i++) {
    cumulative = round2(cumulative + projectedNet);
    forecast.push({
      month: addMonths(currentMonth(), i),
      income: projectedIncome,
      expenditure: projectedExpense,
      net: projectedNet,
      cumulative
    });
  }

  // Maintenance arrears outstanding today — money owed to the corporation, and the
  // clearest upside to the projected position if collected.
  const arrearsBalances = units
    .map(u => accountBalance(u, 'Maintenance', charges, payments, today(), units))
    .filter(a => a.currency === currency && a.balance > 0);
  const arrears = sumMoney(arrearsBalances.map(a => a.balance));

  const active = contractedMonthly > 0 || maintBilled > 0 || maintReceived > 0 || expensesPaid > 0;

  return {
    currency,
    lookback,
    from,
    to,
    maintReceived,
    maintBilled,
    expensesPaid,
    avgReceived,
    avgExpense,
    rate,
    contractedMonthly,
    contributingUnits: contributing.length,
    projectedIncome,
    projectedExpense,
    projectedNet,
    forecast,
    horizonIncome: round2(projectedIncome * horizon),
    horizonExpense: round2(projectedExpense * horizon),
    horizonNet: round2(projectedNet * horizon),
    arrears,
    arrearsAccounts: arrearsBalances.length,
    arrearsOver60: arrearsBalances.filter(a => a.oldestUnpaidDays > 60).length,
    active
  };
}

