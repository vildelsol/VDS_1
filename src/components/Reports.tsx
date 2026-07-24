/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Unit, Payment, Expense, UtilityReading, UserRole } from '../types';
import { Calendar, Download, Printer, BarChart3, TrendingUp, Sparkles, DollarSign, ArrowUpRight, ArrowDownRight, Info, AlertCircle, X } from 'lucide-react';

interface ReportsProps {
  units: Unit[];
  payments: Payment[];
  expenses: Expense[];
  utilities: UtilityReading[];
  activeRole: UserRole;
}

export default function Reports({ units, payments, expenses, utilities, activeRole }: ReportsProps) {
  const [selectedMonthsCount, setSelectedMonthsCount] = useState<1 | 3 | 6 | 12>(3);
  const [showPrintReport, setShowPrintReport] = useState(false);

  // Future Horizons Forecasting (Monthly recurrent expectations)
  const expectedRentUSD = units.filter(u => u.status === 'long-term' && u.currency === 'USD').reduce((sum, u) => sum + u.monthlyRent, 0);
  const expectedRentJMD = units.filter(u => u.status === 'long-term' && u.currency === 'JMD').reduce((sum, u) => sum + u.monthlyRent, 0);
  const expectedMaintUSD = units.filter(u => u.status !== 'unavailable' && (u.maintCurrency ? u.maintCurrency === 'USD' : u.currency === 'USD')).reduce((sum, u) => sum + u.monthlyMaintenance, 0);
  const expectedMaintJMD = units.filter(u => u.status !== 'unavailable' && (u.maintCurrency ? u.maintCurrency === 'JMD' : u.currency === 'JMD')).reduce((sum, u) => sum + u.monthlyMaintenance, 0);

  // Helper to identify owner units (owner-occupied and short-term)
  const isOwnerUnit = (unitNum: string) => {
    const u = units.find(unit => unit.number === unitNum);
    return u ? (u.status === 'owner-occupied' || u.status === 'short-term') : false;
  };

  // Generate list of months to include in the report ending in the current month
  const getMonthsRange = (count: number) => {
    const months: string[] = [];
    const date = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(date.getFullYear(), date.getMonth() - i, 1);
      months.push(d.toISOString().substring(0, 7)); // "YYYY-MM"
    }
    return months;
  };

  const activeMonths = getMonthsRange(selectedMonthsCount);

  // Calculate stats for each month in range
  const monthlyStats = activeMonths.map(month => {
    const mPayments = payments.filter(p => p.date.substring(0, 7) === month && p.status === 'completed');
    const mExpenses = expenses.filter(e => e.date.substring(0, 7) === month && e.status === 'paid');

    // JMD
    const jmdRent = mPayments.filter(p => p.currency === 'JMD' && p.category === 'Rent').reduce((s, p) => s + p.amount, 0);
    const jmdMaint = mPayments.filter(p => p.currency === 'JMD' && p.category === 'Maintenance').reduce((s, p) => s + p.amount, 0);
    const jmdBooking = mPayments.filter(p => p.currency === 'JMD' && p.category === 'Booking').reduce((s, p) => s + p.amount, 0);
    // Owners Utility bills are excluded from overall operational reports/expenses
    const jmdUtility = mPayments.filter(p => p.category === 'Utility' && !isOwnerUnit(p.unitNumber)).reduce((s, p) => s + p.amount, 0);
    const jmdIncome = jmdRent + jmdMaint + jmdBooking + jmdUtility;
    const jmdExpense = mExpenses.filter(e => e.currency === 'JMD').reduce((s, e) => s + e.amount, 0);

    // USD
    const usdRent = mPayments.filter(p => p.currency === 'USD' && p.category === 'Rent').reduce((s, p) => s + p.amount, 0);
    const usdMaint = mPayments.filter(p => p.currency === 'USD' && p.category === 'Maintenance').reduce((s, p) => s + p.amount, 0);
    const usdBooking = mPayments.filter(p => p.currency === 'USD' && p.category === 'Booking').reduce((s, p) => s + p.amount, 0);
    // Owners Utility bills are excluded from overall operational reports/expenses
    const usdUtility = mPayments.filter(p => p.category === 'Utility' && !isOwnerUnit(p.unitNumber)).reduce((s, p) => s + p.amount, 0);
    const usdIncome = usdRent + usdMaint + usdBooking + usdUtility;
    const usdExpense = mExpenses.filter(e => e.currency === 'USD').reduce((s, e) => s + e.amount, 0);

    return {
      month,
      jmdIncome,
      jmdExpense,
      jmdNet: jmdIncome - jmdExpense,
      jmdRent,
      jmdMaint,
      jmdBooking,
      jmdUtility,
      usdIncome,
      usdExpense,
      usdNet: usdIncome - usdExpense,
      usdRent,
      usdMaint,
      usdBooking,
      usdUtility
    };
  });

  // Aggregated range totals
  const totalJMDIncome = monthlyStats.reduce((sum, s) => sum + s.jmdIncome, 0);
  const totalJMDExpense = monthlyStats.reduce((sum, s) => sum + s.jmdExpense, 0);
  const totalUSDIncome = monthlyStats.reduce((sum, s) => sum + s.usdIncome, 0);
  const totalUSDExpense = monthlyStats.reduce((sum, s) => sum + s.usdExpense, 0);

  // Generate Smart Analytical Insights
  const generateInsights = () => {
    const insights: string[] = [];

    // Trend assessment (USD)
    if (monthlyStats.length > 1) {
      const first = monthlyStats[0];
      const last = monthlyStats[monthlyStats.length - 1];
      const usdTrend = last.usdIncome - first.usdIncome;
      if (usdTrend > 0) {
        insights.push(`USD monthly cash inflows grew from $${first.usdIncome.toLocaleString()} to $${last.usdIncome.toLocaleString()} over this period, driven by short-term booking velocity.`);
      } else if (usdTrend < 0) {
        insights.push(`USD monthly cash inflows decreased by $${Math.abs(usdTrend).toLocaleString()} over this period. Operational focus should shift to short-term rental occupancy.`);
      }

      const jmdTrend = last.jmdIncome - first.jmdIncome;
      if (jmdTrend > 0) {
        insights.push(`JMD operational liquidity grew by J$${jmdTrend.toLocaleString()} compared to the start of the period due to stable tenant lease collectibility.`);
      }
    }

    // Average Rent Collectibility
    const longTermUnitsCount = units.filter(u => u.status === 'long-term').length;
    if (longTermUnitsCount > 0) {
      insights.push(`Gated association is tracking rent invoices across ${longTermUnitsCount} long-term lease villas with zero owner utility cross-contamination.`);
    }

    // Top cost category highlights
    const mExpensesAll = expenses.filter(e => activeMonths.includes(e.date.substring(0, 7)) && e.status === 'paid');
    const categoryTotals: Record<string, number> = {};
    mExpensesAll.forEach(e => {
      const amt = e.currency === 'USD' ? e.amount * 150 : e.amount; // normalize to JMD for ranking
      categoryTotals[e.category] = (categoryTotals[e.category] || 0) + amt;
    });

    const sortedCats = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
    if (sortedCats.length > 0) {
      insights.push(`Highest operational disbursement category is "${sortedCats[0][0]}" representing significant outlays.`);
    }

    // General compliance check
    insights.push(`Rule Compliance: Owners' utility readings for water and electricity are billed directly to them and excluded from property overall operating statements.`);

    return insights;
  };

  const insightsList = generateInsights();

  // Export Consolidated Range Report to CSV
  const handleExportConsolidatedCSV = () => {
    const rows = [
      ['Villaggio Del Sol Property Management', 'Ocho Rios, Jamaica'],
      ['Consolidated Operating Statement', `${selectedMonthsCount}-Month Performance Summary`],
      ['Range Covered', `${activeMonths[0]} to ${activeMonths[activeMonths.length - 1]}`],
      [''],
      ['MONTH', 'JMD INFLOW', 'JMD OUTFLOW', 'JMD NET POSITION', 'USD INFLOW', 'USD OUTFLOW', 'USD NET POSITION'],
      ...monthlyStats.map(s => [
        s.month,
        s.jmdIncome.toString(),
        s.jmdExpense.toString(),
        s.jmdNet.toString(),
        s.usdIncome.toString(),
        s.usdExpense.toString(),
        s.usdNet.toString()
      ]),
      [''],
      ['AGGREGATE RANGE TOTALS'],
      ['Total JMD Inflow', totalJMDIncome.toString()],
      ['Total JMD Expense', totalJMDExpense.toString()],
      ['Consolidated JMD Net Balance', (totalJMDIncome - totalJMDExpense).toString()],
      ['Total USD Inflow', totalUSDIncome.toString()],
      ['Total USD Expense', totalUSDExpense.toString()],
      ['Consolidated USD Net Balance', (totalUSDIncome - totalUSDExpense).toString()],
      [''],
      ['Exported on', new Date().toISOString()]
    ];

    const csvContent = "data:text/csv;charset=utf-8," 
      + rows.map(e => e.map(val => `"${val.replace(/"/g, '""')}"`).join(",")).join("\n");
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `VDS_${selectedMonthsCount}Mo_Consolidated_Report.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Custom SVG Bar Chart Calculation Helper
  const renderInflowOutflowChart = (currency: 'USD' | 'JMD') => {
    const width = 600;
    const height = 180;
    const padding = 30;
    const chartWidth = width - padding * 2;
    const chartHeight = height - padding * 2;

    const values = monthlyStats.map(s => currency === 'USD' ? [s.usdIncome, s.usdExpense] : [s.jmdIncome, s.jmdExpense]).flat();
    const maxVal = Math.max(...values, 100);

    const barWidth = Math.min(40, chartWidth / (monthlyStats.length * 2.5));
    const step = chartWidth / monthlyStats.length;

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto bg-slate-50/50 rounded-xl border border-slate-100 p-2">
        {/* Y Axis Gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
          const y = padding + chartHeight * (1 - p);
          return (
            <g key={i} className="opacity-20">
              <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="#94a3b8" strokeWidth="1" strokeDasharray="3,3" />
              <text x={padding - 5} y={y + 3} textAnchor="end" className="fill-slate-400 font-mono text-[8px]">
                {currency === 'USD' ? '$' : 'J$'}{Math.round(maxVal * p).toLocaleString()}
              </text>
            </g>
          );
        })}

        {/* X Axis Line */}
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#cbd5e1" strokeWidth="1" />

        {/* Render Bars */}
        {monthlyStats.map((s, index) => {
          const x = padding + index * step + (step - barWidth * 2) / 2;
          const incomeVal = currency === 'USD' ? s.usdIncome : s.jmdIncome;
          const expenseVal = currency === 'USD' ? s.usdExpense : s.jmdExpense;

          const incomeHeight = (incomeVal / maxVal) * chartHeight;
          const expenseHeight = (expenseVal / maxVal) * chartHeight;

          const incomeY = height - padding - incomeHeight;
          const expenseY = height - padding - expenseHeight;

          return (
            <g key={s.month}>
              {/* Income Bar (Teal) */}
              <rect
                x={x}
                y={incomeY}
                width={barWidth}
                height={incomeHeight}
                className="fill-teal-500 hover:fill-teal-600 transition-colors cursor-pointer"
                rx="2"
              />
              {/* Expense Bar (Rose) */}
              <rect
                x={x + barWidth + 4}
                y={expenseY}
                width={barWidth}
                height={expenseHeight}
                className="fill-rose-400 hover:fill-rose-500 transition-colors cursor-pointer"
                rx="2"
              />
              {/* Label */}
              <text x={x + barWidth} y={height - padding + 12} textAnchor="middle" className="fill-slate-500 font-mono text-[8px] font-semibold">
                {s.month.substring(5)}
              </text>
            </g>
          );
        })}
      </svg>
    );
  };

  return (
    <div className="space-y-6">
      {/* Configuration row */}
      <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-display font-medium text-slate-900">Operational Inflows & Disbursements</h2>
          <p className="text-xs text-slate-500">Fully aggregated ledger audits across multi-month horizons.</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="inline-flex rounded-lg p-0.5 bg-slate-100">
            {([1, 3, 6, 12] as const).map(n => (
              <button
                key={n}
                onClick={() => setSelectedMonthsCount(n)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold font-mono transition-colors ${selectedMonthsCount === n ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-950'}`}
              >
                {n} Mo{n > 1 && 's'}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowPrintReport(true)}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-all shadow-xs"
          >
            <Printer className="w-3.5 h-3.5" />
            Print statement
          </button>
          <button
            onClick={handleExportConsolidatedCSV}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-all shadow-xs"
          >
            <Download className="w-3.5 h-3.5" />
            Consolidated CSV
          </button>
        </div>
      </div>

      {/* Aggregate Range Summary Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">JMD Aggregate Inflow</p>
            <h3 className="text-xl font-mono font-bold mt-1 text-slate-800">J${totalJMDIncome.toLocaleString()}</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Sum over {selectedMonthsCount} months</p>
          </div>
          <div className="p-3 bg-teal-50 text-teal-600 rounded-xl">
            <ArrowUpRight className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">JMD Aggregate Outflow</p>
            <h3 className="text-xl font-mono font-bold mt-1 text-slate-800">J${totalJMDExpense.toLocaleString()}</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Community outlays</p>
          </div>
          <div className="p-3 bg-rose-50 text-rose-500 rounded-xl">
            <ArrowDownRight className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">USD Aggregate Inflow</p>
            <h3 className="text-xl font-mono font-bold mt-1 text-slate-800">${totalUSDIncome.toLocaleString()}</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Revenues received</p>
          </div>
          <div className="p-3 bg-teal-50 text-teal-600 rounded-xl">
            <ArrowUpRight className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">USD Aggregate Outflow</p>
            <h3 className="text-xl font-mono font-bold mt-1 text-slate-800">${totalUSDExpense.toLocaleString()}</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Operational disbursements</p>
          </div>
          <div className="p-3 bg-rose-50 text-rose-500 rounded-xl">
            <ArrowDownRight className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Visual Analytics & Insights */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* JMD Visual Trends */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs space-y-3 lg:col-span-1">
          <div className="flex justify-between items-center">
            <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400">JMD Cash Flow (Inflow vs Outflow)</h4>
            <span className="text-[10px] bg-slate-100 px-2 py-0.5 rounded-full font-mono font-medium text-slate-600">J$ Statement</span>
          </div>
          {renderInflowOutflowChart('JMD')}
          <div className="flex gap-4 justify-center text-[10px] font-semibold text-slate-500 font-mono">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-teal-500 rounded"></span> Inflows</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-rose-400 rounded"></span> Outflows</span>
          </div>
        </div>

        {/* USD Visual Trends */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs space-y-3 lg:col-span-1">
          <div className="flex justify-between items-center">
            <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400">USD Cash Flow (Inflow vs Outflow)</h4>
            <span className="text-[10px] bg-slate-100 px-2 py-0.5 rounded-full font-mono font-medium text-slate-600">$ Statement</span>
          </div>
          {renderInflowOutflowChart('USD')}
          <div className="flex gap-4 justify-center text-[10px] font-semibold text-slate-500 font-mono">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-teal-500 rounded"></span> Inflows</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-rose-400 rounded"></span> Outflows</span>
          </div>
        </div>

        {/* Smart Insights Panel */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs space-y-4 lg:col-span-1">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-teal-600" />
            <h4 className="text-sm font-semibold text-slate-900">Horizon Analytical Insights</h4>
          </div>

          <div className="space-y-3 max-h-[190px] overflow-y-auto pr-1">
            {insightsList.map((ins, i) => (
              <div key={i} className="p-3 bg-teal-50/20 border border-teal-50/50 rounded-xl flex gap-2">
                <Info className="w-3.5 h-3.5 text-teal-600 shrink-0 mt-0.5" />
                <p className="text-[11px] text-teal-900 leading-normal font-sans">{ins}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* HORIZONS / FORECAST ELEMENT */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-4">
        <div>
          <h3 className="text-base font-display font-medium text-slate-900">Upcoming Revenue Horizon Forecast</h3>
          <p className="text-xs text-slate-500 mt-0.5">Contractual expectation projection model based on active long-term leases and owner HOA maintenance schedules.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* USD Horizon */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 space-y-3 font-mono">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Expected Monthly Inflow (USD)</span>
            <div className="space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between">
                <span>Tenants Expected Rent:</span>
                <span className="font-semibold text-slate-800">${expectedRentUSD.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>Owners Maintenance Fees:</span>
                <span className="font-semibold text-slate-800">${expectedMaintUSD.toLocaleString()}</span>
              </div>
              <div className="border-t border-slate-200 pt-1.5 flex justify-between font-semibold text-teal-700 text-sm font-sans">
                <span>Total Expected/Mo (USD):</span>
                <span>${(expectedRentUSD + expectedMaintUSD).toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* JMD Horizon */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 space-y-3 font-mono">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Expected Monthly Inflow (JMD)</span>
            <div className="space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between">
                <span>Tenants Expected Rent:</span>
                <span className="font-semibold text-slate-800">J${expectedRentJMD.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>Owners Maintenance Fees:</span>
                <span className="font-semibold text-slate-800">J${expectedMaintJMD.toLocaleString()}</span>
              </div>
              <div className="border-t border-slate-200 pt-1.5 flex justify-between font-semibold text-teal-700 text-sm font-sans">
                <span>Total Expected/Mo (JMD):</span>
                <span>J${(expectedRentJMD + expectedMaintJMD).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* UNIT-BY-UNIT FINANCIAL BREAKDOWN */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-4">
        <div>
          <h3 className="text-base font-display font-medium text-slate-900">Unit-by-Unit Financial Ledger Breakdown</h3>
          <p className="text-xs text-slate-500 mt-0.5">Comprehensive real-time tracking of collected payments, outstanding balances, and monthly contractual forecasts by Villa.</p>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-100 bg-white">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 font-mono text-[10px] uppercase">
                <th className="p-3">Villa</th>
                <th className="p-3">Status</th>
                <th className="p-3">Billing Currency</th>
                <th className="p-3 text-right">Collected (USD)</th>
                <th className="p-3 text-right">Collected (JMD)</th>
                <th className="p-3 text-right">Outstanding (USD)</th>
                <th className="p-3 text-right">Outstanding (JMD)</th>
                <th className="p-3 text-right">Forecast (USD/Mo)</th>
                <th className="p-3 text-right">Forecast (JMD/Mo)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 text-slate-700">
              {units.map((u) => {
                const uPayments = payments.filter(p => p.unitNumber === u.number && p.status === 'completed');
                const collectedUSD = uPayments.filter(p => p.currency === 'USD').reduce((s, p) => s + p.amount, 0);
                const collectedJMD = uPayments.filter(p => p.currency === 'JMD').reduce((s, p) => s + p.amount, 0);

                let rentPaidUSD = uPayments.filter(p => p.category === 'Rent' && p.currency === 'USD').reduce((s, p) => s + p.amount, 0);
                let rentPaidJMD = uPayments.filter(p => p.category === 'Rent' && p.currency === 'JMD').reduce((s, p) => s + p.amount, 0);
                
                let outstandingRent = 0;
                let outstandingRentUSD = 0;
                let outstandingRentJMD = 0;
                if (u.status === 'long-term') {
                  const paid = u.currency === 'USD' ? rentPaidUSD : rentPaidJMD;
                  outstandingRent = Math.max(0, u.monthlyRent - paid);
                  if (u.currency === 'USD') {
                    outstandingRentUSD = outstandingRent;
                  } else {
                    outstandingRentJMD = outstandingRent;
                  }
                }

                let maintPaidUSD = uPayments.filter(p => p.category === 'Maintenance' && p.currency === 'USD').reduce((s, p) => s + p.amount, 0);
                let maintPaidJMD = uPayments.filter(p => p.category === 'Maintenance' && p.currency === 'JMD').reduce((s, p) => s + p.amount, 0);
                
                let outstandingMaint = 0;
                let outstandingMaintUSD = 0;
                let outstandingMaintJMD = 0;
                if (u.status !== 'unavailable') {
                  const targetMaintCurrency = u.maintCurrency || u.currency;
                  const paid = targetMaintCurrency === 'USD' ? maintPaidUSD : maintPaidJMD;
                  outstandingMaint = Math.max(0, u.monthlyMaintenance - paid);
                  if (targetMaintCurrency === 'USD') {
                    outstandingMaintUSD = outstandingMaint;
                  } else {
                    outstandingMaintJMD = outstandingMaint;
                  }
                }

                const outstandingUSD = outstandingRentUSD + outstandingMaintUSD;
                const outstandingJMD = outstandingRentJMD + outstandingMaintJMD;

                const forecastRentUSD = (u.status === 'long-term' && u.currency === 'USD') ? u.monthlyRent : 0;
                const forecastRentJMD = (u.status === 'long-term' && u.currency === 'JMD') ? u.monthlyRent : 0;
                const forecastMaintUSD = (u.status !== 'unavailable' && (u.maintCurrency ? u.maintCurrency === 'USD' : u.currency === 'USD')) ? u.monthlyMaintenance : 0;
                const forecastMaintJMD = (u.status !== 'unavailable' && (u.maintCurrency ? u.maintCurrency === 'JMD' : u.currency === 'JMD')) ? u.monthlyMaintenance : 0;

                const forecastUSD = forecastRentUSD + forecastMaintUSD;
                const forecastJMD = forecastRentJMD + forecastMaintJMD;

                return (
                  <tr key={u.id} className="hover:bg-slate-50/50 animate-fade-in">
                    <td className="p-3 font-semibold text-slate-900">Villa {u.number}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wide uppercase ${
                        u.status === 'long-term' ? 'bg-teal-50 text-teal-700 border border-teal-100' :
                        u.status === 'short-term' ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' :
                        u.status === 'owner-occupied' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                        u.status === 'vacant' ? 'bg-amber-50 text-amber-700 border border-amber-100' :
                        'bg-slate-100 text-slate-600'
                      }`}>
                        {u.status.replace('-', ' ')}
                      </span>
                    </td>
                    <td className="p-3 font-mono font-medium text-slate-400">{u.currency}</td>
                    <td className={`p-3 font-mono text-right ${collectedUSD > 0 ? 'text-teal-600 font-semibold' : 'text-slate-400'}`}>
                      {collectedUSD > 0 ? `$${collectedUSD.toLocaleString()}` : '-'}
                    </td>
                    <td className={`p-3 font-mono text-right ${collectedJMD > 0 ? 'text-teal-600 font-semibold' : 'text-slate-400'}`}>
                      {collectedJMD > 0 ? `J$${collectedJMD.toLocaleString()}` : '-'}
                    </td>
                    <td className={`p-3 font-mono text-right ${outstandingUSD > 0 ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
                      {outstandingUSD > 0 ? `$${outstandingUSD.toLocaleString()}` : 'Paid'}
                    </td>
                    <td className={`p-3 font-mono text-right ${outstandingJMD > 0 ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
                      {outstandingJMD > 0 ? `J$${outstandingJMD.toLocaleString()}` : 'Paid'}
                    </td>
                    <td className={`p-3 font-mono text-right font-medium text-slate-800`}>
                      {forecastUSD > 0 ? `$${forecastUSD.toLocaleString()}` : '-'}
                    </td>
                    <td className={`p-3 font-mono text-right font-medium text-slate-800`}>
                      {forecastJMD > 0 ? `J$${forecastJMD.toLocaleString()}` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Itemized Periodic Ledger List */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-xs overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-100">
          <h3 className="text-xs font-mono uppercase tracking-wider text-slate-500">Itemized Multi-Month Ledger</h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-white border-b border-slate-100 font-mono text-[10px] uppercase text-slate-400">
                <th className="p-3">Month</th>
                <th className="p-3 text-right">JMD Inflow</th>
                <th className="p-3 text-right">JMD Outlay</th>
                <th className="p-3 text-right">Net JMD Position</th>
                <th className="p-3 text-right">USD Inflow</th>
                <th className="p-3 text-right">USD Outlay</th>
                <th className="p-3 text-right">Net USD Position</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 font-mono">
              {monthlyStats.map(s => (
                <tr key={s.month} className="hover:bg-slate-50/50">
                  <td className="p-3 font-semibold text-slate-900">{s.month}</td>
                  <td className="p-3 text-right text-emerald-600">J${s.jmdIncome.toLocaleString()}</td>
                  <td className="p-3 text-right text-rose-500">J${s.jmdExpense.toLocaleString()}</td>
                  <td className={`p-3 text-right font-bold ${s.jmdNet >= 0 ? 'text-teal-700' : 'text-rose-700'}`}>
                    J${s.jmdNet.toLocaleString()}
                  </td>
                  <td className="p-3 text-right text-emerald-600">${s.usdIncome.toLocaleString()}</td>
                  <td className="p-3 text-right text-rose-500">${s.usdExpense.toLocaleString()}</td>
                  <td className={`p-3 text-right font-bold ${s.usdNet >= 0 ? 'text-teal-700' : 'text-rose-700'}`}>
                    ${s.usdNet.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* FULL PRINTABLE MULTI-MONTH STATEMENT OVERFLOW MODAL */}
      {showPrintReport && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 print:p-0 print:absolute print:bg-white print:inset-0">
          <div className="bg-white rounded-2xl max-w-5xl w-full max-h-[95vh] overflow-y-auto shadow-2xl border border-slate-100 flex flex-col print:shadow-none print:border-none print:max-h-none print:overflow-visible">
            
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50 print:hidden">
              <div className="flex items-center gap-2">
                <Printer className="w-5 h-5 text-teal-600" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Consolidated Horizon Operating Statement</h3>
                  <p className="text-[11px] text-slate-500">Aggregated statement of cash flows for the last {selectedMonthsCount} months.</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-all shadow-xs"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Print Statement
                </button>
                <button
                  onClick={() => setShowPrintReport(false)}
                  className="p-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-200/50 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-8 space-y-8 flex-1 text-slate-800 print:p-0 print:text-black font-sans">
              
              {/* Letterhead */}
              <div className="flex justify-between items-start border-b-2 border-slate-900 pb-4">
                <div>
                  <h1 className="text-xl font-bold uppercase tracking-wider text-slate-900 print:text-black">Villaggio Del Sol</h1>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">Ocho Rios, Jamaica</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">Community Association Multi-Month Operational Audit</p>
                </div>
                <div className="text-right">
                  <div className="bg-slate-900 text-white px-3 py-1 text-[10px] font-mono rounded-lg print:border print:border-black print:text-black print:bg-white font-bold">
                    CONSOLIDATED STATISTICAL STATEMENT
                  </div>
                  <p className="text-xs font-bold text-slate-900 mt-1 uppercase">PERIOD: Last {selectedMonthsCount} Months</p>
                  <p className="text-[10px] text-slate-500 font-mono">Range: {activeMonths[0]} to {activeMonths[activeMonths.length - 1]}</p>
                </div>
              </div>

              {/* Consolidated Summaries */}
              <div className="grid grid-cols-2 gap-6 bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-white print:border-black print:rounded-none">
                <div className="space-y-1.5">
                  <h4 className="text-[9px] font-mono font-bold text-slate-400 uppercase tracking-wider">Jamaican Dollar Statement (JMD)</h4>
                  <div className="text-xs space-y-1">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Gross JMD Inflows:</span>
                      <span className="font-mono font-semibold">J${totalJMDIncome.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Gross JMD Outflows:</span>
                      <span className="font-mono font-semibold">J${totalJMDExpense.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-200 pt-1 text-teal-700 font-bold print:text-black font-semibold">
                      <span>Net JMD Position:</span>
                      <span className="font-mono">J${(totalJMDIncome - totalJMDExpense).toLocaleString()}</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <h4 className="text-[9px] font-mono font-bold text-slate-400 uppercase tracking-wider">US Dollar Statement (USD)</h4>
                  <div className="text-xs space-y-1">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Gross USD Inflows:</span>
                      <span className="font-mono font-semibold">${totalUSDIncome.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Gross USD Outflows:</span>
                      <span className="font-mono font-semibold">${totalUSDExpense.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-200 pt-1 text-teal-700 font-bold print:text-black font-semibold">
                      <span>Net USD Position:</span>
                      <span className="font-mono">${(totalUSDIncome - totalUSDExpense).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Monthly Breakdown Lists */}
              <div className="space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-1 print:text-black print:border-black">
                  Monthly Performance Ledger Details
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border border-slate-100 print:border-black print:border">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 font-mono text-[9px] text-slate-400 uppercase print:bg-white print:border-black print:border-b">
                        <th className="p-2">Billing Month</th>
                        <th className="p-2 text-right">JMD Inflow</th>
                        <th className="p-2 text-right">JMD Outflow</th>
                        <th className="p-2 text-right">Net JMD</th>
                        <th className="p-2 text-right">USD Inflow</th>
                        <th className="p-2 text-right">USD Outflow</th>
                        <th className="p-2 text-right">Net USD</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-xs">
                      {monthlyStats.map(s => (
                        <tr key={s.month}>
                          <td className="p-2 font-bold">{s.month}</td>
                          <td className="p-2 text-right">J${s.jmdIncome.toLocaleString()}</td>
                          <td className="p-2 text-right">J${s.jmdExpense.toLocaleString()}</td>
                          <td className="p-2 text-right font-semibold">J${s.jmdNet.toLocaleString()}</td>
                          <td className="p-2 text-right">${s.usdIncome.toLocaleString()}</td>
                          <td className="p-2 text-right">${s.usdExpense.toLocaleString()}</td>
                          <td className="p-2 text-right font-semibold">${s.usdNet.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Itemized Lists */}
              {activeMonths.map(month => {
                const monthPayments = payments.filter(p => p.date.substring(0, 7) === month && p.status === 'completed');
                const monthExpenses = expenses.filter(e => e.date.substring(0, 7) === month && e.status === 'paid');

                if (monthPayments.length === 0 && monthExpenses.length === 0) return null;

                return (
                  <div key={month} className="space-y-4 pt-4 border-t border-slate-200 print:border-black break-inside-avoid">
                    <h4 className="text-xs font-bold font-mono text-slate-900 print:text-black uppercase">
                      Detailed Audit for Month: {month}
                    </h4>

                    {/* Payments */}
                    {monthPayments.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-[9px] font-mono font-semibold text-slate-400 block uppercase">Collected Inflows</span>
                        <table className="w-full text-left text-[10px] border border-slate-100 print:border-black">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-150 font-mono text-[8px] uppercase text-slate-400 print:bg-white print:border-black">
                              <th className="p-1.5">Date</th>
                              <th className="p-1.5">Villa</th>
                              <th className="p-1.5">Payer Name</th>
                              <th className="p-1.5">Category</th>
                              <th className="p-1.5">Method</th>
                              <th className="p-1.5 text-right">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 font-mono print:divide-black">
                            {monthPayments.map(p => (
                              <tr key={p.id}>
                                <td className="p-1.5">{p.date}</td>
                                <td className="p-1.5 font-bold">Villa {p.unitNumber}</td>
                                <td className="p-1.5">{p.payerName}</td>
                                <td className="p-1.5">{p.category}</td>
                                <td className="p-1.5">{p.method}</td>
                                <td className="p-1.5 text-right font-semibold">
                                  {p.currency === 'USD' ? '$' : 'J$'}{p.amount.toLocaleString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Expenses */}
                    {monthExpenses.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-[9px] font-mono font-semibold text-slate-400 block uppercase">Disbursement Outlays</span>
                        <table className="w-full text-left text-[10px] border border-slate-100 print:border-black">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-150 font-mono text-[8px] uppercase text-slate-400 print:bg-white print:border-black">
                              <th className="p-1.5">Date</th>
                              <th className="p-1.5">Villa Reference</th>
                              <th className="p-1.5">Vendor</th>
                              <th className="p-1.5">Description</th>
                              <th className="p-1.5 text-right">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 font-mono print:divide-black">
                            {monthExpenses.map(e => (
                              <tr key={e.id}>
                                <td className="p-1.5">{e.date}</td>
                                <td className="p-1.5">Villa {e.unitNumber || 'Common'}</td>
                                <td className="p-1.5">{e.vendor}</td>
                                <td className="p-1.5 truncate max-w-[200px]">{e.description}</td>
                                <td className="p-1.5 text-right font-semibold">
                                  {e.currency === 'USD' ? '$' : 'J$'}{e.amount.toLocaleString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Sign-Off */}
              <div className="pt-12 grid grid-cols-2 gap-8 text-center text-xs border-t border-slate-200 mt-12 print:border-black print:mt-8">
                <div>
                  <div className="border-b border-slate-400 h-8 w-2/3 mx-auto print:border-black"></div>
                  <span className="text-[10px] text-slate-400 block mt-1 font-mono uppercase">Ocho Rios Financial Comptroller</span>
                </div>
                <div>
                  <div className="border-b border-slate-400 h-8 w-2/3 mx-auto print:border-black"></div>
                  <span className="text-[10px] text-slate-400 block mt-1 font-mono uppercase">Association Board Trustee Approval</span>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

    </div>
  );
}
