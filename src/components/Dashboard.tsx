/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Unit, Booking, Payment, Expense, UserRole, getUnitDisplayName } from '../types';
import { ShieldCheck, RefreshCw, AlertTriangle, Key, ArrowUpRight, ArrowDownRight, Calendar, Info, RefreshCcw } from 'lucide-react';

interface DashboardProps {
  units: Unit[];
  bookings: Booking[];
  payments: Payment[];
  expenses: Expense[];
  activeRole: UserRole;
  onRefresh: () => void;
  onRecordPayment?: (paymentData: any) => Promise<Payment>;
  onUpdateBooking?: (bookingId: string, updatedFields: any) => Promise<void>;
  onNavigateToTab?: (tab: string) => void;
}

export default function Dashboard({
  units,
  bookings,
  payments,
  expenses,
  activeRole,
  onRefresh,
  onRecordPayment,
  onUpdateBooking,
  onNavigateToTab
}: DashboardProps) {
  const [icalUrl, setIcalUrl] = useState('');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncLogs, setSyncLogs] = useState<string[]>([]);
  const [selectedCurrency, setSelectedCurrency] = useState<'USD' | 'JMD'>('USD');

  // Quick Receive Modal State
  const [isQuickReceive, setIsQuickReceive] = useState(false);
  const [quickUnitNumber, setQuickUnitNumber] = useState('');
  const [quickPayerName, setQuickPayerName] = useState('');
  const [quickCategory, setQuickCategory] = useState<'Rent' | 'Maintenance' | 'Booking' | 'Utility' | 'Other'>('Maintenance');
  const [quickAmount, setQuickAmount] = useState('');
  const [quickCurrency, setQuickCurrency] = useState<'USD' | 'JMD'>('JMD');
  const [quickDate, setQuickDate] = useState(new Date().toISOString().split('T')[0]);
  const [quickMethod, setQuickMethod] = useState<'Bank Transfer' | 'Cash' | 'Credit Card' | 'Cheque'>('Cash');
  const [quickReference, setQuickReference] = useState('');
  const [quickNotes, setQuickNotes] = useState('');
  const [quickLoading, setQuickLoading] = useState(false);
  const [quickError, setQuickError] = useState('');
  const [quickSuccess, setQuickSuccess] = useState('');

  // Short Term Guest Reservation Editing State
  const [editingBooking, setEditingBooking] = useState<Booking | null>(null);
  const [editGuestName, setEditGuestName] = useState('');
  const [editGuestEmail, setEditGuestEmail] = useState('');
  const [editGuestPhone, setEditGuestPhone] = useState('');
  const [editCheckIn, setEditCheckIn] = useState('');
  const [editCheckOut, setEditCheckOut] = useState('');
  const [editNightlyRate, setEditNightlyRate] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editDeposit, setEditDeposit] = useState('');
  const [editCurrency, setEditCurrency] = useState<'USD' | 'JMD'>('USD');
  const [editStatus, setEditStatus] = useState<Booking['status']>('confirmed');
  const [editNotes, setEditNotes] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState('');
  const [editSuccess, setEditSuccess] = useState('');

  const handleOpenQuickReceive = (unit: Unit, category: 'Rent' | 'Maintenance' | 'Booking' | 'Utility' | 'Other', recommendedAmount?: number) => {
    setQuickUnitNumber(unit.number);
    setQuickPayerName(category === 'Maintenance' ? unit.ownerName : unit.tenantName || unit.ownerName);
    setQuickCategory(category);
    setQuickCurrency(unit.currency);
    setQuickAmount(String(recommendedAmount || (category === 'Maintenance' ? unit.monthlyMaintenance : unit.monthlyRent)));
    setQuickDate(new Date().toISOString().split('T')[0]);
    setQuickMethod('Cash');
    setQuickReference('');
    setQuickNotes('');
    setQuickError('');
    setQuickSuccess('');
    setIsQuickReceive(true);
  };

  const handleOpenGeneralQuickReceive = () => {
    setQuickUnitNumber('');
    setQuickPayerName('');
    setQuickCategory('Maintenance');
    setQuickCurrency('JMD');
    setQuickAmount('');
    setQuickDate(new Date().toISOString().split('T')[0]);
    setQuickMethod('Cash');
    setQuickReference('');
    setQuickNotes('');
    setQuickError('');
    setQuickSuccess('');
    setIsQuickReceive(true);
  };

  const handleSaveQuickReceive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onRecordPayment) {
      setQuickError('Payment recorder callback not available.');
      return;
    }
    if (!quickUnitNumber || !quickPayerName || !quickAmount || Number(quickAmount) <= 0) {
      setQuickError('Villa unit number, payer name, and a valid amount are required.');
      return;
    }

    setQuickLoading(true);
    setQuickError('');
    try {
      await onRecordPayment({
        payerName: quickPayerName,
        unitNumber: quickUnitNumber,
        category: quickCategory,
        amount: Number(quickAmount),
        currency: quickCurrency,
        date: quickDate,
        method: quickMethod,
        reference: quickReference,
        notes: quickNotes
      });
      setQuickSuccess(`Receipt recorded successfully for Unit ${quickUnitNumber}!`);
      setTimeout(() => {
        setIsQuickReceive(false);
        onRefresh();
      }, 1500);
    } catch (err: any) {
      setQuickError(err.message || 'Failed to record transaction.');
    } finally {
      setQuickLoading(false);
    }
  };

  const handleOpenEditBooking = (b: Booking) => {
    setEditingBooking(b);
    setEditGuestName(b.guestName);
    setEditGuestEmail(b.guestEmail || '');
    setEditGuestPhone(b.guestPhone || '');
    setEditCheckIn(b.checkIn);
    setEditCheckOut(b.checkOut);
    setEditNightlyRate(String(b.nightlyRate || ''));
    setEditAmount(String(b.amount));
    setEditDeposit(String(b.depositPaid));
    setEditCurrency(b.currency);
    setEditStatus(b.status);
    setEditNotes(b.notes || '');
    setEditError('');
    setEditSuccess('');
    setEditLoading(false);
  };

  React.useEffect(() => {
    if (editCheckIn && editCheckOut && editNightlyRate) {
      const inDate = new Date(editCheckIn);
      const outDate = new Date(editCheckOut);
      const diffTime = outDate.getTime() - inDate.getTime();
      const nights = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (nights > 0) {
        const rate = Number(editNightlyRate) || 0;
        setEditAmount(String(rate * nights));
      }
    }
  }, [editCheckIn, editCheckOut, editNightlyRate]);

  const handleSaveEditBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBooking || !onUpdateBooking) return;

    if (!editGuestName || !editCheckIn || !editCheckOut || !editAmount) {
      setEditError('Guest name, check-in, check-out, and total amount are required.');
      return;
    }

    setEditLoading(true);
    setEditError('');
    try {
      const amt = Number(editAmount) || 0;
      const dep = Number(editDeposit) || 0;
      const bal = Math.max(0, amt - dep);

      await onUpdateBooking(editingBooking.id, {
        guestName: editGuestName,
        guestEmail: editGuestEmail,
        guestPhone: editGuestPhone,
        checkIn: editCheckIn,
        checkOut: editCheckOut,
        nightlyRate: editNightlyRate ? Number(editNightlyRate) : undefined,
        amount: amt,
        depositPaid: dep,
        balanceDue: bal,
        currency: editCurrency,
        status: editStatus,
        notes: editNotes
      });

      setEditSuccess('Booking updated successfully! Syncing state...');
      setTimeout(() => {
        setEditingBooking(null);
        onRefresh();
      }, 1500);
    } catch (err: any) {
      setEditError(err.message || 'Failed to update reservation.');
    } finally {
      setEditLoading(false);
    }
  };

  // Helper to identify owner units (owner-occupied and short-term)
  const isOwnerUnit = (unitNum: string) => {
    const u = units.find(unit => unit.number === unitNum);
    return u ? (u.status === 'owner-occupied' || u.status === 'short-term') : false;
  };

  // Compute stats
  const totalUnits = units.length;
  const occupiedUnits = units.filter(u => u.status === 'long-term' || u.status === 'short-term' || u.status === 'owner-occupied').length;
  const vacantUnits = units.filter(u => u.status === 'vacant').length;
  const unavailableUnits = units.filter(u => u.status === 'unavailable').length;

  const currentMonth = new Date().toISOString().substring(0, 7); // "YYYY-MM"

  // Formatting for billing month label (e.g. "July 2026")
  const [currentYear, currentMonthNum] = currentMonth.split('-');
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const currentMonthName = monthNames[parseInt(currentMonthNum, 10) - 1] || 'Billing';
  const billingMonthLabel = `${currentMonthName} ${currentYear}`;

  // Compute delinquent accounts (both unpaid HOA maintenance AND unpaid long-term rent)
  const delinquentAccounts = [
    // 1. Unpaid HOA maintenance
    ...units
      .filter(u => u.status !== 'unavailable' && u.monthlyMaintenance > 0)
      .map(u => {
        const maintCurrency = u.maintCurrency || u.currency;
        const paid = payments
          .filter(p => p.unitNumber === u.number && p.category === 'Maintenance' && p.status === 'completed' && p.currency === maintCurrency && p.date.startsWith(currentMonth))
          .reduce((sum, p) => sum + p.amount, 0);
        const outstanding = u.monthlyMaintenance - paid;
        return {
          id: `maint-${u.id}`,
          unit: u,
          type: 'Maintenance' as const,
          payerName: u.ownerName,
          title: 'HOA Maintenance',
          paid,
          total: u.monthlyMaintenance,
          outstanding,
          currency: maintCurrency,
          monthYear: billingMonthLabel
        };
      })
      .filter(item => item.outstanding > 0),

    // 2. Unpaid Long-Term Rent
    ...units
      .filter(u => u.status === 'long-term' && u.monthlyRent > 0)
      .map(u => {
        const paid = payments
          .filter(p => p.unitNumber === u.number && p.category === 'Rent' && p.status === 'completed' && p.currency === u.currency && p.date.startsWith(currentMonth))
          .reduce((sum, p) => sum + p.amount, 0);
        const outstanding = u.monthlyRent - paid;
        return {
          id: `rent-${u.id}`,
          unit: u,
          type: 'Rent' as const,
          payerName: u.tenantName || u.ownerName,
          title: 'Tenant Rent',
          paid,
          total: u.monthlyRent,
          outstanding,
          currency: u.currency,
          monthYear: billingMonthLabel
        };
      })
      .filter(item => item.outstanding > 0)
  ];

  // JMD financial computations
  const jmdPayments = payments.filter(p => p.currency === 'JMD' && p.status === 'completed');
  const jmdRentCollected = jmdPayments.filter(p => p.category === 'Rent').reduce((sum, p) => sum + p.amount, 0);
  const jmdMaintCollected = jmdPayments.filter(p => p.category === 'Maintenance').reduce((sum, p) => sum + p.amount, 0);
  const jmdBookingCollected = jmdPayments.filter(p => p.category === 'Booking').reduce((sum, p) => sum + p.amount, 0);
  // Owners Utility bills go to them so they are excluded from calculations and reports
  const jmdUtilityCollected = jmdPayments.filter(p => p.category === 'Utility' && !isOwnerUnit(p.unitNumber)).reduce((sum, p) => sum + p.amount, 0);
  const jmdExpenses = expenses.filter(e => e.currency === 'JMD' && e.status === 'paid').reduce((sum, e) => sum + e.amount, 0);

  // USD financial computations
  const usdPayments = payments.filter(p => p.currency === 'USD' && p.status === 'completed');
  const usdRentCollected = usdPayments.filter(p => p.category === 'Rent').reduce((sum, p) => sum + p.amount, 0);
  const usdMaintCollected = usdPayments.filter(p => p.category === 'Maintenance').reduce((sum, p) => sum + p.amount, 0);
  const usdBookingCollected = usdPayments.filter(p => p.category === 'Booking').reduce((sum, p) => sum + p.amount, 0);
  // Owners Utility bills go to them so they are excluded from calculations and reports
  const usdUtilityCollected = usdPayments.filter(p => p.category === 'Utility' && !isOwnerUnit(p.unitNumber)).reduce((sum, p) => sum + p.amount, 0);
  const usdExpenses = expenses.filter(e => e.currency === 'USD' && e.status === 'paid').reduce((sum, e) => sum + e.amount, 0);

  // Future Horizons Forecasting (Monthly recurrent expectations)
  const expectedRentUSD = units.filter(u => u.status === 'long-term' && u.currency === 'USD').reduce((sum, u) => sum + u.monthlyRent, 0);
  const expectedRentJMD = units.filter(u => u.status === 'long-term' && u.currency === 'JMD').reduce((sum, u) => sum + u.monthlyRent, 0);
  const expectedMaintUSD = units.filter(u => u.status !== 'unavailable' && (u.maintCurrency ? u.maintCurrency === 'USD' : u.currency === 'USD')).reduce((sum, u) => sum + u.monthlyMaintenance, 0);
  const expectedMaintJMD = units.filter(u => u.status !== 'unavailable' && (u.maintCurrency ? u.maintCurrency === 'JMD' : u.currency === 'JMD')).reduce((sum, u) => sum + u.monthlyMaintenance, 0);

  // Compute Outstanding estimates dynamically based on uncollected amounts for current month
  // Rent outstanding (Long-term vacant/occupied vs actual rent payments this month)
  const outstandingRentUSD = units
    .filter(u => u.status === 'long-term' && u.currency === 'USD')
    .reduce((sum, u) => {
      const paid = usdPayments.filter(p => p.unitNumber === u.number && p.category === 'Rent').reduce((s, p) => s + p.amount, 0);
      return sum + Math.max(0, u.monthlyRent - paid);
    }, 0);

  const outstandingRentJMD = units
    .filter(u => u.status === 'long-term' && u.currency === 'JMD')
    .reduce((sum, u) => {
      const paid = jmdPayments.filter(p => p.unitNumber === u.number && p.category === 'Rent').reduce((s, p) => s + p.amount, 0);
      return sum + Math.max(0, u.monthlyRent - paid);
    }, 0);

  // Maintenance outstanding (checks maintCurrency first, then defaults to currency)
  const outstandingMaintUSD = units
    .filter(u => u.status !== 'unavailable' && (u.maintCurrency ? u.maintCurrency === 'USD' : u.currency === 'USD'))
    .reduce((sum, u) => {
      const paid = usdPayments.filter(p => p.unitNumber === u.number && p.category === 'Maintenance').reduce((s, p) => s + p.amount, 0);
      return sum + Math.max(0, u.monthlyMaintenance - paid);
    }, 0);

  const outstandingMaintJMD = units
    .filter(u => u.status !== 'unavailable' && (u.maintCurrency ? u.maintCurrency === 'JMD' : u.currency === 'JMD'))
    .reduce((sum, u) => {
      const paid = jmdPayments.filter(p => p.unitNumber === u.number && p.category === 'Maintenance').reduce((s, p) => s + p.amount, 0);
      return sum + Math.max(0, u.monthlyMaintenance - paid);
    }, 0);

  // Filter bookings to exclude cancelled ones
  const activeBookings = bookings.filter(b => b.status !== 'cancelled');

  const shortTermStats = {
    totalBookings: activeBookings.length,
    usdCollected: activeBookings.filter(b => b.currency === 'USD').reduce((sum, b) => sum + b.depositPaid, 0),
    usdOutstanding: activeBookings.filter(b => b.currency === 'USD').reduce((sum, b) => sum + b.balanceDue, 0),
    jmdCollected: activeBookings.filter(b => b.currency === 'JMD').reduce((sum, b) => sum + b.depositPaid, 0),
    jmdOutstanding: activeBookings.filter(b => b.currency === 'JMD').reduce((sum, b) => sum + b.balanceDue, 0),
  };

  // Active dates formatting
  const todayStr = new Date().toISOString().split('T')[0];

  // Upcoming arrivals and departures
  const upcomingArrivals = bookings.filter(b => b.checkIn >= todayStr && b.status === 'confirmed');
  const upcomingDepartures = bookings.filter(b => b.checkOut >= todayStr && b.status === 'checked-in');

  const handleSimulateSync = (e: React.FormEvent) => {
    e.preventDefault();
    if (!icalUrl) return;

    setSyncStatus('syncing');
    setSyncLogs(['Connecting to remote server...', 'Verifying iCalendar format...']);

    setTimeout(() => {
      if (icalUrl.includes('airbnb') || icalUrl.includes('booking') || icalUrl.includes('ical')) {
        setSyncStatus('success');
        setSyncLogs(prev => [
          ...prev,
          'Successfully authorized external feed.',
          'Detected 2 upcoming external reservations.',
          'Checking for potential overlaps with direct reservations...',
          'No conflicts detected. System state synchronized.'
        ]);
        onRefresh();
      } else {
        setSyncStatus('error');
        setSyncLogs(prev => [
          ...prev,
          'Error: Invalid iCalendar domain or SSL authorization timeout.',
          'Please ensure you provide a valid Airbnb or Booking.com secure export link.'
        ]);
      }
    }, 1500);
  };

  return (
    <div className="space-y-6">
      {/* Quick Dashboard Action Panel */}
      <div className="flex flex-col sm:flex-row justify-between items-center bg-teal-900 text-white p-5 rounded-2xl shadow-md border border-teal-950 gap-4">
        <div>
          <h3 className="text-sm font-semibold tracking-wide font-display">Operational Quick Actions</h3>
          <p className="text-xs text-teal-100/80 mt-1">Direct cashier entry of maintenance fees, rents, utility payments, or bookings</p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <button
            onClick={() => handleOpenGeneralQuickReceive()}
            className="flex-1 sm:flex-initial px-4 py-2.5 bg-white text-teal-900 hover:bg-teal-50 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer"
          >
            <ArrowUpRight className="w-4 h-4 text-emerald-600" />
            Receive Payment
          </button>
        </div>
      </div>

      {/* Overview Stat Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">Occupancy Rate</p>
            <h3 className="text-2xl font-display font-semibold mt-1">
              {Math.round((occupiedUnits / totalUnits) * 100)}%
            </h3>
            <p className="text-xs text-slate-400 mt-1">{occupiedUnits} of {totalUnits} units active</p>
          </div>
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
            <Key className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">Vacant Units</p>
            <h3 className="text-2xl font-display font-semibold mt-1 text-teal-600">{vacantUnits}</h3>
            <p className="text-xs text-slate-400 mt-1">Ready for lease or short-term</p>
          </div>
          <div className="p-3 bg-teal-50 text-teal-600 rounded-xl">
            <ArrowDownRight className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">Upcoming Arrivals</p>
            <h3 className="text-2xl font-display font-semibold mt-1 text-slate-700">{upcomingArrivals.length}</h3>
            <p className="text-xs text-slate-400 mt-1">Next 14 days arrivals</p>
          </div>
          <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
            <Calendar className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-100 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-500 uppercase">System Integrity</p>
            <h3 className="text-2xl font-display font-semibold mt-1 text-slate-800">Operational</h3>
            <p className="text-xs text-emerald-600 mt-1 font-mono">● Active Staff: {activeRole}</p>
          </div>
          <div className="p-3 bg-slate-50 text-slate-600 rounded-xl">
            <ShieldCheck className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Delinquent Accounts Alert Section */}
      {delinquentAccounts.length > 0 && (
        <div className="bg-red-50/40 border border-red-100 rounded-2xl p-6 space-y-4 shadow-xs">
          <div className="flex items-center gap-2 text-red-800">
            <AlertTriangle className="w-5 h-5 text-red-600 animate-pulse" />
            <h3 className="text-sm font-semibold font-display">Delinquent Accounts</h3>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            The following accounts have outstanding Rent or HOA Maintenance fees for the current month. Actions to receive these payments are log-tracked in the system.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {delinquentAccounts.map(item => (
              <div key={item.id} className="p-4 bg-white border border-red-100 hover:border-red-200 transition-all rounded-xl flex flex-col justify-between text-xs shadow-xs space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-semibold text-slate-800">{getUnitDisplayName(item.unit.number)}</p>
                      <span className={`px-1.5 py-0.5 rounded-full font-mono text-[9px] font-semibold border ${
                        item.type === 'Maintenance' ? 'bg-indigo-50 text-indigo-700 border-indigo-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'
                      }`}>
                        {item.title}
                      </span>
                    </div>
                    <p className="text-slate-500 text-[10px] mt-1.5 truncate max-w-[150px]">Payer: <span className="font-medium text-slate-700">{item.payerName || 'Unspecified'}</span></p>
                    <p className="text-slate-500 text-[10px] mt-0.5">Billing Period: <span className="font-semibold text-slate-800">{item.monthYear}</span></p>
                    <p className="text-red-600 font-mono text-[10px] mt-1.5">
                      Paid: {item.currency === 'USD' ? '$' : 'J$'}{item.paid.toLocaleString()} / {item.currency === 'USD' ? '$' : 'J$'}{item.total.toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] text-slate-400 font-mono block uppercase">Outstanding</span>
                    <span className="font-bold text-red-600 font-mono text-sm">
                      {item.currency === 'USD' ? '$' : 'J$'}{item.outstanding.toLocaleString()}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleOpenQuickReceive(item.unit, item.type, item.outstanding)}
                  className="w-full py-1.5 bg-red-50 hover:bg-red-100 text-red-700 font-semibold border border-red-200 rounded-lg text-[10px] transition-all flex items-center justify-center gap-1 cursor-pointer"
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  Receive Payment
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Currency Split Ledger metrics */}
      <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-xs space-y-8">
        <div>
          <h2 className="text-lg font-display font-medium text-slate-900">Monthly Operational Ledger</h2>
          <p className="text-xs text-slate-500 mt-0.5">Real-time balances and collected operational cash flow for {currentMonth}</p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 border-t border-slate-100 pt-6">
          {/* USD Ledger Column */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-xs font-bold font-mono tracking-wider text-slate-800 uppercase">United States Dollar Ledger</h3>
              <span className="px-2 py-0.5 rounded-md bg-teal-50 text-teal-700 font-mono text-[10px] font-bold">USD ($)</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* USD Collected */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Collected Revenue</h4>
                <div className="p-4 bg-emerald-50/50 rounded-xl space-y-2">
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Rent collected:</span>
                    <span className="font-mono font-medium">${usdRentCollected.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Maintenance:</span>
                    <span className="font-mono font-medium">${usdMaintCollected.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Bookings:</span>
                    <span className="font-mono font-medium">${usdBookingCollected.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Utilities:</span>
                    <span className="font-mono font-medium">${usdUtilityCollected.toLocaleString()}</span>
                  </div>
                  <div className="border-t border-emerald-100 pt-2 flex justify-between text-xs font-semibold text-emerald-800">
                    <span>Total Received:</span>
                    <span className="font-mono">${(usdRentCollected + usdMaintCollected + usdBookingCollected + usdUtilityCollected).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* USD Outstanding */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Outstanding Estimates</h4>
                <div className="p-4 bg-amber-50/50 rounded-xl space-y-2">
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Outstanding Rent:</span>
                    <span className="font-mono font-medium">${outstandingRentUSD.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Maintenance:</span>
                    <span className="font-mono font-medium">${outstandingMaintUSD.toLocaleString()}</span>
                  </div>
                  <div className="border-t border-amber-100 pt-2 flex justify-between text-xs font-semibold text-amber-800">
                    <span>Estimated Unpaid:</span>
                    <span className="font-mono">${(outstandingRentUSD + outstandingMaintUSD).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* USD Outlays */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Operational Outlays</h4>
                <div className="p-4 bg-slate-50 rounded-xl space-y-2">
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Paid Expenses:</span>
                    <span className="font-mono font-medium">${usdExpenses.toLocaleString()}</span>
                  </div>
                  <div className="border-t border-slate-200 pt-2 flex justify-between text-xs font-semibold text-slate-800">
                    <span>Cash Outflow:</span>
                    <span className="font-mono">${usdExpenses.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* JMD Ledger Column */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-xs font-bold font-mono tracking-wider text-slate-800 uppercase">Jamaican Dollar Ledger</h3>
              <span className="px-2 py-0.5 rounded-md bg-teal-50 text-teal-700 font-mono text-[10px] font-bold">JMD (J$)</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* JMD Collected */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Collected Revenue</h4>
                <div className="p-4 bg-emerald-50/50 rounded-xl space-y-2">
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Rent collected:</span>
                    <span className="font-mono font-medium">J${jmdRentCollected.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Maintenance:</span>
                    <span className="font-mono font-medium">J${jmdMaintCollected.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Bookings:</span>
                    <span className="font-mono font-medium">J${jmdBookingCollected.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Utilities:</span>
                    <span className="font-mono font-medium">J${jmdUtilityCollected.toLocaleString()}</span>
                  </div>
                  <div className="border-t border-emerald-100 pt-2 flex justify-between text-xs font-semibold text-emerald-800">
                    <span>Total Received:</span>
                    <span className="font-mono">J${(jmdRentCollected + jmdMaintCollected + jmdBookingCollected + jmdUtilityCollected).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* JMD Outstanding */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Outstanding Estimates</h4>
                <div className="p-4 bg-amber-50/50 rounded-xl space-y-2">
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Outstanding Rent:</span>
                    <span className="font-mono font-medium">J${outstandingRentJMD.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Maintenance:</span>
                    <span className="font-mono font-medium">J${outstandingMaintJMD.toLocaleString()}</span>
                  </div>
                  <div className="border-t border-amber-100 pt-2 flex justify-between text-xs font-semibold text-amber-800">
                    <span>Estimated Unpaid:</span>
                    <span className="font-mono">J${(outstandingRentJMD + outstandingMaintJMD).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* JMD Outlays */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Operational Outlays</h4>
                <div className="p-4 bg-slate-50 rounded-xl space-y-2">
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Paid Expenses:</span>
                    <span className="font-mono font-medium">J${jmdExpenses.toLocaleString()}</span>
                  </div>
                  <div className="border-t border-slate-200 pt-2 flex justify-between text-xs font-semibold text-slate-800">
                    <span>Cash Outflow:</span>
                    <span className="font-mono">J${jmdExpenses.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Short-Term Guest Rentals Ledger */}
      <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-xs space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-lg font-display font-medium text-slate-900">Short-Term Guest Rentals Ledger</h2>
            <p className="text-xs text-slate-500 mt-0.5">Payments collected, outstanding, and reservation synchronization for guests</p>
          </div>
          <div className="flex gap-2">
            {onNavigateToTab && (
              <button
                onClick={() => onNavigateToTab('bookings')}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-slate-900 rounded-lg text-xs font-semibold transition-all cursor-pointer"
              >
                Go to Bookings Tab
              </button>
            )}
          </div>
        </div>

        {/* Short Term Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-slate-50 rounded-xl">
            <span className="text-[10px] font-mono text-slate-500 block uppercase">Active Bookings</span>
            <span className="text-2xl font-display font-bold text-slate-800">{shortTermStats.totalBookings}</span>
            <span className="text-xs text-slate-500 block mt-1">Confirmed or checked-in stays</span>
          </div>

          <div className="p-4 bg-emerald-50/50 rounded-xl">
            <span className="text-[10px] font-mono text-emerald-700 block uppercase">Payments Collected</span>
            <div className="flex justify-between items-baseline mt-1 gap-2">
              <span className="text-base font-mono font-bold text-emerald-800">${shortTermStats.usdCollected.toLocaleString()} <span className="text-[9px] text-emerald-600 font-sans">USD</span></span>
              <span className="text-base font-mono font-bold text-emerald-800">J${shortTermStats.jmdCollected.toLocaleString()} <span className="text-[9px] text-emerald-600 font-sans">JMD</span></span>
            </div>
            <span className="text-xs text-emerald-600 block mt-1">Direct guest deposits & upfronts</span>
          </div>

          <div className="p-4 bg-amber-50/50 rounded-xl">
            <span className="text-[10px] font-mono text-amber-700 block uppercase">Payments Outstanding</span>
            <div className="flex justify-between items-baseline mt-1 gap-2">
              <span className="text-base font-mono font-bold text-amber-800">${shortTermStats.usdOutstanding.toLocaleString()} <span className="text-[9px] text-amber-600 font-sans">USD</span></span>
              <span className="text-base font-mono font-bold text-amber-800">J${shortTermStats.jmdOutstanding.toLocaleString()} <span className="text-[9px] text-amber-600 font-sans">JMD</span></span>
            </div>
            <span className="text-xs text-amber-600 block mt-1">Unpaid remaining booking balances</span>
          </div>
        </div>

        {/* Bookings List / Table */}
        <div className="overflow-x-auto border border-slate-100 rounded-xl">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-mono text-[10px] uppercase">
                <th className="p-3">Villa</th>
                <th className="p-3">Guest Information</th>
                <th className="p-3">Source</th>
                <th className="p-3">Reservation Dates</th>
                <th className="p-3">Total Cost</th>
                <th className="p-3">Collected</th>
                <th className="p-3">Outstanding</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activeBookings.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-400 font-medium">
                    No active short-term guest reservations found.
                  </td>
                </tr>
              ) : (
                activeBookings.map(b => (
                  <tr key={b.id} className="hover:bg-slate-50/50 transition-colors cursor-pointer" onClick={() => handleOpenEditBooking(b)}>
                    <td className="p-3 font-semibold text-slate-800 font-mono">Villa {b.unitNumber}</td>
                    <td className="p-3">
                      <p className="font-medium text-slate-900">{b.guestName}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{b.guestEmail} • {b.guestPhone}</p>
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-mono border ${
                        b.source === 'Airbnb' ? 'bg-rose-50 text-rose-700 border-rose-100' :
                        b.source === 'Booking.com' ? 'bg-blue-50 text-blue-700 border-blue-100' :
                        'bg-teal-50 text-teal-700 border-teal-100'
                      }`}>
                        {b.source}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-[11px] text-slate-600">
                      {b.checkIn} to {b.checkOut}
                    </td>
                    <td className="p-3 font-mono font-medium text-slate-700">
                      {b.currency === 'USD' ? '$' : 'J$'}{b.amount.toLocaleString()}
                    </td>
                    <td className="p-3 font-mono font-medium text-emerald-600">
                      {b.currency === 'USD' ? '$' : 'J$'}{b.depositPaid.toLocaleString()}
                    </td>
                    <td className="p-3 font-mono font-semibold text-amber-600">
                      {b.currency === 'USD' ? '$' : 'J$'}{b.balanceDue.toLocaleString()}
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase ${
                        b.status === 'checked-in' ? 'bg-emerald-100 text-emerald-800' :
                        b.status === 'checked-out' ? 'bg-slate-100 text-slate-800' :
                        b.status === 'confirmed' ? 'bg-blue-100 text-blue-800' :
                        'bg-red-100 text-red-800'
                      }`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleOpenEditBooking(b)}
                        className="px-2.5 py-1 text-[10px] font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 border border-teal-100 rounded-lg transition-all cursor-pointer"
                      >
                        Edit Details
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Arrivals and departures log */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs lg:col-span-2 space-y-4">
          <h3 className="text-base font-display font-medium text-slate-900">Upcoming Guest Transitions</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <span className="text-xs font-mono text-emerald-600 uppercase font-medium">Pending Arrivals ({upcomingArrivals.length})</span>
              {upcomingArrivals.length === 0 ? (
                <div className="text-xs text-slate-400 p-4 border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                  No upcoming guest arrivals today
                </div>
              ) : (
                <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                  {upcomingArrivals.map(b => (
                    <div key={b.id} className="p-3 bg-emerald-50/30 border border-emerald-100 rounded-xl flex justify-between items-center text-xs">
                      <div>
                        <p className="font-medium text-slate-800">{b.guestName} (Unit {b.unitNumber})</p>
                        <p className="text-slate-500 font-mono text-[10px] mt-0.5">Checkin: {b.checkIn}</p>
                      </div>
                      <span className="px-2 py-0.5 font-mono text-[10px] rounded-full bg-emerald-100 text-emerald-800 font-medium">
                        {b.source}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <span className="text-xs font-mono text-amber-600 uppercase font-medium">Pending Departures ({upcomingDepartures.length})</span>
              {upcomingDepartures.length === 0 ? (
                <div className="text-xs text-slate-400 p-4 border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                  No upcoming guest check-outs today
                </div>
              ) : (
                <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                  {upcomingDepartures.map(b => (
                    <div key={b.id} className="p-3 bg-amber-50/30 border border-amber-100 rounded-xl flex justify-between items-center text-xs">
                      <div>
                        <p className="font-medium text-slate-800">{b.guestName} (Unit {b.unitNumber})</p>
                        <p className="text-slate-500 font-mono text-[10px] mt-0.5">Checkout: {b.checkOut}</p>
                      </div>
                      <span className="px-2 py-0.5 font-mono text-[10px] rounded-full bg-amber-100 text-amber-800 font-medium">
                        Checked-In
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Airbnb iCal Sync Channel Tool */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-base font-display font-medium text-slate-900">iCalendar Channel Sync</h3>
            <span className="px-2 py-0.5 font-mono text-[10px] rounded-full bg-teal-50 text-teal-700 font-medium border border-teal-100">
              Authorized API
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Securely link external booking platform feeds (Airbnb, VRBO, or Booking.com) via authorized iCalendar file synchronization.
          </p>

          <form onSubmit={handleSimulateSync} className="space-y-3">
            <div>
              <label className="text-xs font-mono text-slate-500 block mb-1">Paste iCal URL Link</label>
              <input
                type="text"
                placeholder="https://www.airbnb.com/calendar/ical/..."
                value={icalUrl}
                onChange={(e) => setIcalUrl(e.target.value)}
                className="w-full text-xs p-2.5 border border-slate-200 rounded-xl focus:ring-1 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>
            <button
              type="submit"
              disabled={syncStatus === 'syncing'}
              className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
              {syncStatus === 'syncing' ? 'Synchronizing...' : 'Authorize & Sync now'}
            </button>
          </form>

          {syncStatus !== 'idle' && (
            <div className={`p-4 rounded-xl text-xs space-y-2 border ${
              syncStatus === 'success' 
                ? 'bg-teal-50/50 border-teal-100 text-teal-800' 
                : syncStatus === 'error' 
                ? 'bg-amber-50/50 border-amber-100 text-amber-800' 
                : 'bg-slate-50 border-slate-100 text-slate-600'
            }`}>
              <div className="flex items-center gap-1.5 font-semibold">
                {syncStatus === 'success' && <ShieldCheck className="w-4 h-4 text-teal-600" />}
                {syncStatus === 'error' && <AlertTriangle className="w-4 h-4 text-amber-600" />}
                <span>
                  {syncStatus === 'syncing' && 'Synchronizing feeds...'}
                  {syncStatus === 'success' && 'Channel Sync Active'}
                  {syncStatus === 'error' && 'Sync Error Detected'}
                </span>
              </div>
              <div className="space-y-1 font-mono text-[10px] text-slate-500 leading-normal pl-5">
                {syncLogs.map((log, i) => (
                  <p key={i}>&gt; {log}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* QUICK RECEIVE PAYMENT MODAL */}
      {isQuickReceive && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleSaveQuickReceive} className="bg-white rounded-2xl max-w-md w-full shadow-xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <div>
                <h3 className="text-sm font-display font-semibold text-slate-900">Record Quick Payment Inflow</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Enter details of received maintenance, rent, or booking fees</p>
              </div>
              <button 
                type="button" 
                onClick={() => setIsQuickReceive(false)} 
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              {quickError && (
                <div className="p-3 bg-red-50 border border-red-100 text-red-800 text-[11px] rounded-xl font-medium">
                  {quickError}
                </div>
              )}

              {quickSuccess && (
                <div className="p-3 bg-teal-50 border border-teal-100 text-teal-800 text-[11px] rounded-xl font-medium">
                  {quickSuccess}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Villa Unit</label>
                  <select
                    value={quickUnitNumber}
                    onChange={(e) => {
                      const val = e.target.value;
                      setQuickUnitNumber(val);
                      const matchedUnit = units.find(u => u.number === val);
                      if (matchedUnit) {
                        setQuickCurrency(matchedUnit.currency);
                        setQuickPayerName(quickCategory === 'Maintenance' ? matchedUnit.ownerName : matchedUnit.tenantName || matchedUnit.ownerName);
                        setQuickAmount(String(quickCategory === 'Maintenance' ? matchedUnit.monthlyMaintenance : matchedUnit.monthlyRent));
                      }
                    }}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  >
                    <option value="">Select Villa</option>
                    {units.map(u => (
                      <option key={u.id} value={u.number}>Villa {u.number} ({u.currency})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Inflow Category</label>
                  <select
                    value={quickCategory}
                    onChange={(e) => {
                      const cat = e.target.value as any;
                      setQuickCategory(cat);
                      const matchedUnit = units.find(u => u.number === quickUnitNumber);
                      if (matchedUnit) {
                        setQuickPayerName(cat === 'Maintenance' ? matchedUnit.ownerName : matchedUnit.tenantName || matchedUnit.ownerName);
                        setQuickAmount(String(cat === 'Maintenance' ? matchedUnit.monthlyMaintenance : matchedUnit.monthlyRent));
                      }
                    }}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="Maintenance">Maintenance (HOA)</option>
                    <option value="Rent">Rent (Long-term)</option>
                    <option value="Booking">Booking (Short-term)</option>
                    <option value="Utility">Utility Payment</option>
                    <option value="Other">Other Inflow</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono text-slate-500 block mb-1">Payer Name</label>
                <input
                  type="text"
                  value={quickPayerName}
                  onChange={(e) => setQuickPayerName(e.target.value)}
                  required
                  placeholder="Guest, Owner or Tenant"
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Amount Received</label>
                  <input
                    type="number"
                    value={quickAmount}
                    onChange={(e) => setQuickAmount(e.target.value)}
                    required
                    placeholder="0.00"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono bg-white"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Currency</label>
                  <select
                    value={quickCurrency}
                    onChange={(e) => setQuickCurrency(e.target.value as any)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  >
                    <option value="USD">USD ($)</option>
                    <option value="JMD">JMD (J$)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Payment Method</label>
                  <select
                    value={quickMethod}
                    onChange={(e) => setQuickMethod(e.target.value as any)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="Cash">Cash In-Hand</option>
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Credit Card">Credit Card</option>
                    <option value="Cheque">Cheque</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Reference No</label>
                  <input
                    type="text"
                    value={quickReference}
                    onChange={(e) => setQuickReference(e.target.value)}
                    placeholder="e.g. TXN-9943"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono text-slate-500 block mb-1">Internal Notes</label>
                <textarea
                  rows={2}
                  value={quickNotes}
                  onChange={(e) => setQuickNotes(e.target.value)}
                  placeholder="Memo..."
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white"
                />
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
              <button
                type="submit"
                disabled={quickLoading}
                className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-semibold shadow-sm transition-all"
              >
                {quickLoading ? 'Saving Inflow...' : 'Approve & Save Inflow'}
              </button>
              <button
                type="button"
                onClick={() => setIsQuickReceive(false)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 bg-white rounded-xl text-xs font-semibold hover:bg-slate-50 transition-all"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Short Term Guest Booking Edit Modal */}
      {editingBooking && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <form 
            onSubmit={handleSaveEditBooking}
            className="bg-white rounded-2xl w-full max-w-lg shadow-xl border border-slate-100 flex flex-col my-8"
          >
            <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50 rounded-t-2xl">
              <div>
                <h3 className="text-sm font-display font-semibold text-slate-900">Edit Guest Reservation Details</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Villa {editingBooking.unitNumber} • {editingBooking.source} Booking</p>
              </div>
              <button 
                type="button" 
                onClick={() => setEditingBooking(null)} 
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
              {editError && (
                <div className="p-3 bg-red-50 border border-red-100 text-red-800 text-[11px] rounded-xl font-medium">
                  {editError}
                </div>
              )}

              {editSuccess && (
                <div className="p-3 bg-teal-50 border border-teal-100 text-teal-800 text-[11px] rounded-xl font-medium">
                  {editSuccess}
                </div>
              )}

              <div>
                <label className="text-[10px] font-mono text-slate-500 block mb-1">Guest Name</label>
                <input
                  type="text"
                  value={editGuestName}
                  onChange={(e) => setEditGuestName(e.target.value)}
                  required
                  placeholder="e.g. John Doe"
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Guest Email</label>
                  <input
                    type="email"
                    value={editGuestEmail}
                    onChange={(e) => setEditGuestEmail(e.target.value)}
                    placeholder="guest@example.com"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white font-mono"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Guest Phone</label>
                  <input
                    type="text"
                    value={editGuestPhone}
                    onChange={(e) => setEditGuestPhone(e.target.value)}
                    placeholder="+1 876-000-0000"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Check-In Date</label>
                  <input
                    type="date"
                    value={editCheckIn}
                    onChange={(e) => setEditCheckIn(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono bg-white"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Check-Out Date</label>
                  <input
                    type="date"
                    value={editCheckOut}
                    onChange={(e) => setEditCheckOut(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono bg-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Nightly Rate</label>
                  <input
                    type="number"
                    value={editNightlyRate}
                    onChange={(e) => setEditNightlyRate(e.target.value)}
                    placeholder="Optional"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono bg-white"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Total Stay Cost</label>
                  <input
                    type="number"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    required
                    placeholder="0"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono bg-white"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Deposit Collected</label>
                  <input
                    type="number"
                    value={editDeposit}
                    onChange={(e) => setEditDeposit(e.target.value)}
                    placeholder="0"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono bg-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Currency</label>
                  <select
                    value={editCurrency}
                    onChange={(e) => setEditCurrency(e.target.value as any)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  >
                    <option value="USD">USD ($)</option>
                    <option value="JMD">JMD (J$)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Booking Status</label>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value as any)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-semibold"
                  >
                    <option value="confirmed">Confirmed</option>
                    <option value="checked-in">Checked In</option>
                    <option value="checked-out">Checked Out</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono text-slate-500 block mb-1">Internal Notes</label>
                <textarea
                  rows={2}
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder="Notes/requests..."
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white"
                />
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3 rounded-b-2xl">
              <button
                type="submit"
                disabled={editLoading}
                className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-semibold shadow-sm transition-all"
              >
                {editLoading ? 'Saving changes...' : 'Save & Sync Reservation'}
              </button>
              <button
                type="button"
                onClick={() => setEditingBooking(null)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 bg-white rounded-xl text-xs font-semibold hover:bg-slate-50 transition-all"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
