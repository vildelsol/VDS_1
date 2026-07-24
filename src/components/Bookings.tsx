/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Unit, Booking, UserRole, getUnitDisplayName } from '../types';
import { 
  Calendar, 
  Search, 
  Plus, 
  ShieldCheck, 
  X, 
  AlertCircle, 
  CalendarDays, 
  ChevronLeft, 
  ChevronRight, 
  Edit2, 
  User, 
  Phone, 
  Mail, 
  DollarSign, 
  FileText,
  Printer
} from 'lucide-react';

interface BookingsProps {
  units: Unit[];
  bookings: Booking[];
  activeRole: UserRole;
  juniorHasAdvancedAccess: boolean;
  juniorPermissions?: {
    editBookings: boolean;
    cancelBookings: boolean;
    addBookings: boolean;
    editUnits: boolean;
    reversePayments: boolean;
    enterUtilities: boolean;
    recordExpenses: boolean;
  };
  onAddBooking: (booking: any) => Promise<Booking>;
  onUpdateBookingStatus: (bookingId: string, status: Booking['status']) => Promise<void>;
  onUpdateBooking: (bookingId: string, updatedFields: any) => Promise<void>;
}

export default function Bookings({
  units,
  bookings,
  activeRole,
  juniorHasAdvancedAccess,
  juniorPermissions,
  onAddBooking,
  onUpdateBookingStatus,
  onUpdateBooking
}: BookingsProps) {
  // Navigation & View states
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>('calendar');
  const [calendarMonth, setCalendarMonth] = useState('2026-07'); // Default to peak season July 2026

  // Modal control states
  const [isAdding, setIsAdding] = useState(false);
  const [editingBooking, setEditingBooking] = useState<Booking | null>(null);

  // Availability search states
  const [searchCheckIn, setSearchCheckIn] = useState('');
  const [searchCheckOut, setSearchCheckOut] = useState('');
  const [searchUnitId, setSearchUnitId] = useState('');
  const [searchResult, setSearchResult] = useState<'idle' | 'available' | 'occupied'>('idle');
  const [conflictingBooking, setConflictingBooking] = useState<Booking | null>(null);

  // Add Booking Form states
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [unitId, setUnitId] = useState('');
  const [source, setSource] = useState<Booking['source']>('Direct');
  const [nightlyRate, setNightlyRate] = useState('');
  const [amount, setAmount] = useState('');
  const [deposit, setDeposit] = useState('');
  const [notes, setNotes] = useState('');

  // Edit Booking Form states
  const [editGuestName, setEditGuestName] = useState('');
  const [editGuestEmail, setEditGuestEmail] = useState('');
  const [editGuestPhone, setEditGuestPhone] = useState('');
  const [editCheckIn, setEditCheckIn] = useState('');
  const [editCheckOut, setEditCheckOut] = useState('');
  const [editUnitId, setEditUnitId] = useState('');
  const [editSource, setEditSource] = useState<Booking['source']>('Direct');
  const [editNightlyRate, setEditNightlyRate] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editDeposit, setEditDeposit] = useState('');
  const [editStatus, setEditStatus] = useState<Booking['status']>('confirmed');
  const [editNotes, setEditNotes] = useState('');

  // Print Range states
  const [printStart, setPrintStart] = useState('');
  const [printEnd, setPrintEnd] = useState('');
  const [showPrintOptions, setShowPrintOptions] = useState(false);

  // Stay amount real-time calculations
  React.useEffect(() => {
    if (checkIn && checkOut && nightlyRate) {
      const inDate = new Date(checkIn);
      const outDate = new Date(checkOut);
      const diffTime = outDate.getTime() - inDate.getTime();
      const nights = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (nights > 0) {
        const rate = Number(nightlyRate) || 0;
        setAmount(String(rate * nights));
      }
    }
  }, [checkIn, checkOut, nightlyRate]);

  React.useEffect(() => {
    if (unitId) {
      const u = units.find(unit => unit.id === unitId);
      if (u) {
        setNightlyRate(String(u.monthlyRent || ''));
      }
    }
  }, [unitId, units]);

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

  React.useEffect(() => {
    if (editUnitId && editingBooking && editingBooking.unitId !== editUnitId) {
      const u = units.find(unit => unit.id === editUnitId);
      if (u) {
        setEditNightlyRate(String(u.monthlyRent || ''));
      }
    }
  }, [editUnitId, units, editingBooking]);

  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);

  // Permissions gate calculations
  const canAddBookings = activeRole === 'ADMINISTRATOR' || activeRole === 'MANAGER' || (activeRole === 'JUNIOR_OFFICER' && (juniorHasAdvancedAccess || juniorPermissions?.addBookings));
  const canEditBookings = activeRole === 'ADMINISTRATOR' || activeRole === 'MANAGER' || (activeRole === 'JUNIOR_OFFICER' && (juniorHasAdvancedAccess || juniorPermissions?.editBookings));
  const canCancelBookings = activeRole === 'ADMINISTRATOR' || activeRole === 'MANAGER' || (activeRole === 'JUNIOR_OFFICER' && (juniorHasAdvancedAccess || juniorPermissions?.cancelBookings));

  // Numeric sorting of units (Villa 1 to 16)
  const sortedUnits = [...units].sort((a, b) => {
    const numA = parseInt(a.number, 10) || 0;
    const numB = parseInt(b.number, 10) || 0;
    return numA - numB;
  });

  // Calculate active month days
  const [yearStr, monthStr] = calendarMonth.split('-');
  const year = parseInt(yearStr, 10);
  const monthIndex = parseInt(monthStr, 10) - 1; // 0-indexed
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const daysArray = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const getDayOfWeekLetter = (dayNum: number) => {
    try {
      const d = new Date(year, monthIndex, dayNum);
      const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      return days[d.getDay()];
    } catch {
      return '';
    }
  };

  const isWeekendDay = (dayNum: number) => {
    try {
      const d = new Date(year, monthIndex, dayNum);
      const day = d.getDay();
      return day === 0 || day === 6;
    } catch {
      return false;
    }
  };

  // Standard month string helper
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const displayMonthYear = `${monthNames[monthIndex]} ${year}`;

  const handlePrevMonth = () => {
    const prevDate = new Date(year, monthIndex - 1, 1);
    setCalendarMonth(prevDate.toISOString().slice(0, 7));
  };

  const handleNextMonth = () => {
    const nextDate = new Date(year, monthIndex + 1, 1);
    setCalendarMonth(nextDate.toISOString().slice(0, 7));
  };

  // Check if a villa is booked on a specific day
  const getBookingForDay = (unitIdStr: string, dayNum: number) => {
    const targetDate = new Date(year, monthIndex, dayNum, 12, 0, 0); // Midday to handle timezone offsets
    return bookings.find(b => {
      if (b.unitId !== unitIdStr || b.status === 'cancelled') return false;
      const start = new Date(b.checkIn + 'T12:00:00');
      const end = new Date(b.checkOut + 'T12:00:00');
      return targetDate >= start && targetDate <= end;
    });
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchCheckIn || !searchCheckOut || !searchUnitId) {
      alert('Please fill in check-in, check-out, and choose a unit to search.');
      return;
    }

    const checkInDate = new Date(searchCheckIn);
    const checkOutDate = new Date(searchCheckOut);

    if (checkInDate >= checkOutDate) {
      alert('Check-out must be after check-in.');
      return;
    }

    // Check overlaps
    const conflict = bookings.find(b => {
      if (b.unitId === searchUnitId && b.status !== 'cancelled' && b.status !== 'checked-out') {
        const bIn = new Date(b.checkIn);
        const bOut = new Date(b.checkOut);
        return (checkInDate < bOut && checkOutDate > bIn);
      }
      return false;
    });

    if (conflict) {
      setSearchResult('occupied');
      setConflictingBooking(conflict);
    } else {
      setSearchResult('available');
      setConflictingBooking(null);
    }
  };

  const handleCreateBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');

    if (!guestName || !checkIn || !checkOut || !unitId) {
      setErrorMsg('Guest name, check-in/out, and unit selection are required.');
      return;
    }

    if (new Date(checkIn) >= new Date(checkOut)) {
      setErrorMsg('Departure date must fall after Arrival date.');
      return;
    }

    if (!canAddBookings) {
      setErrorMsg('Unauthorized: Junior Officers cannot create reservations without administrative override settings.');
      return;
    }

    const selectedUnit = units.find(u => u.id === unitId);
    if (!selectedUnit) return;

    setLoading(true);

    try {
      const amtNum = Number(amount) || 0;
      const depNum = Number(deposit) || 0;
      const balNum = Math.max(0, amtNum - depNum);

      await onAddBooking({
        unitId,
        unitNumber: selectedUnit.number,
        guestName,
        guestEmail,
        guestPhone,
        checkIn,
        checkOut,
        source,
        amount: amtNum,
        nightlyRate: Number(nightlyRate) || undefined,
        currency: selectedUnit.currency,
        depositPaid: depNum,
        balanceDue: balNum,
        status: 'confirmed',
        notes
      });

      setSuccessMsg('Booking saved successfully!');
      setIsAdding(false);
      
      // Reset form
      setGuestName('');
      setGuestEmail('');
      setGuestPhone('');
      setCheckIn('');
      setCheckOut('');
      setNightlyRate('');
      setAmount('');
      setDeposit('');
      setNotes('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error scheduling booking.');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenEditModal = (b: Booking) => {
    if (!canEditBookings) {
      alert('Unauthorized: Junior Officers do not have permission to modify reservations.');
      return;
    }
    setEditingBooking(b);
    setEditGuestName(b.guestName);
    setEditGuestEmail(b.guestEmail || '');
    setEditGuestPhone(b.guestPhone || '');
    setEditCheckIn(b.checkIn);
    setEditCheckOut(b.checkOut);
    setEditUnitId(b.unitId);
    setEditSource(b.source);
    setEditNightlyRate(b.nightlyRate ? b.nightlyRate.toString() : '');
    setEditAmount(b.amount.toString());
    setEditDeposit(b.depositPaid.toString());
    setEditStatus(b.status);
    setEditNotes(b.notes || '');
    setErrorMsg('');
    setSuccessMsg('');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBooking) return;
    setErrorMsg('');
    setSuccessMsg('');

    if (!editGuestName || !editCheckIn || !editCheckOut || !editUnitId) {
      setErrorMsg('Guest name, check-in/out, and unit selection are required.');
      return;
    }

    if (new Date(editCheckIn) >= new Date(editCheckOut)) {
      setErrorMsg('Departure date must fall after Arrival date.');
      return;
    }

    const selectedUnit = units.find(u => u.id === editUnitId);
    if (!selectedUnit) return;

    setLoading(true);

    try {
      const amtNum = Number(editAmount) || 0;
      const depNum = Number(editDeposit) || 0;
      const balNum = Math.max(0, amtNum - depNum);

      const fieldsToUpdate = {
        unitId: editUnitId,
        unitNumber: selectedUnit.number,
        guestName: editGuestName,
        guestEmail: editGuestEmail,
        guestPhone: editGuestPhone,
        checkIn: editCheckIn,
        checkOut: editCheckOut,
        source: editSource,
        nightlyRate: Number(editNightlyRate) || undefined,
        amount: amtNum,
        depositPaid: depNum,
        balanceDue: balNum,
        status: editStatus,
        notes: editNotes
      };

      await onUpdateBooking(editingBooking.id, fieldsToUpdate);
      setSuccessMsg('Reservation updated successfully!');
      setEditingBooking(null);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error updating reservation.');
    } finally {
      setLoading(false);
    }
  };

  const handleCellClick = (unit: Unit, day: number) => {
    const clickedBooking = getBookingForDay(unit.id, day);
    if (clickedBooking) {
      handleOpenEditModal(clickedBooking);
    } else {
      if (!canAddBookings) {
        alert('Unauthorized: Junior Officers do not have permission to book guests.');
        return;
      }
      // Prefill booking form
      const prefilledDate = `${calendarMonth}-${day.toString().padStart(2, '0')}`;
      setUnitId(unit.id);
      setCheckIn(prefilledDate);
      setCheckOut(''); // Leave checkout to user
      setIsAdding(true);
    }
  };

  const getSourceBadge = (src: Booking['source']) => {
    switch (src) {
      case 'Airbnb': return 'bg-rose-50 text-rose-700 border-rose-100';
      case 'Booking.com': return 'bg-blue-50 text-blue-700 border-blue-100';
      case 'Direct': return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      case 'Blocked': return 'bg-slate-100 text-slate-700 border-slate-200';
      case 'Unavailable': return 'bg-slate-200 text-slate-800 border-slate-300';
    }
  };

  const getStatusBadge = (stat: Booking['status']) => {
    switch (stat) {
      case 'confirmed': return 'bg-indigo-50 text-indigo-700 border-indigo-100';
      case 'checked-in': return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      case 'checked-out': return 'bg-slate-100 text-slate-500 border-slate-200';
      case 'cancelled': return 'bg-red-50 text-red-600 border-red-100';
    }
  };

  return (
    <>
      <div className="space-y-6 print:hidden">
      {/* Search Availability & Views Selector */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Availability Engine Panel */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-4 lg:col-span-1">
          <div className="flex justify-between items-center pb-2 border-b border-slate-50">
            <h3 className="text-sm font-display font-semibold text-slate-900">Availability Checker</h3>
            <Search className="w-4 h-4 text-slate-400" />
          </div>

          <form onSubmit={handleSearch} className="space-y-3.5 text-xs">
            <div>
              <label className="text-xs font-mono text-slate-500 block mb-1">Check-in Date</label>
              <input
                type="date"
                value={searchCheckIn}
                onChange={(e) => setSearchCheckIn(e.target.value)}
                required
                className="w-full p-2.5 border border-slate-200 rounded-xl font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-slate-500 block mb-1">Check-out Date</label>
              <input
                type="date"
                value={searchCheckOut}
                onChange={(e) => setSearchCheckOut(e.target.value)}
                required
                className="w-full p-2.5 border border-slate-200 rounded-xl font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-slate-500 block mb-1">Villa Unit</label>
              <select
                value={searchUnitId}
                onChange={(e) => setSearchUnitId(e.target.value)}
                required
                className="w-full p-2.5 border border-slate-200 rounded-xl"
              >
                <option value="">Select Villa</option>
                {sortedUnits.map(u => (
                  <option key={u.id} value={u.id}>{getUnitDisplayName(u.number)} ({u.status})</option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
            >
              Verify Availability
            </button>
          </form>

          {searchResult !== 'idle' && (
            <div className={`p-4 rounded-xl border text-xs space-y-1.5 ${
              searchResult === 'available' ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : 'bg-red-50 border-red-100 text-red-800'
            }`}>
              <div className="flex items-center gap-1.5 font-semibold">
                {searchResult === 'available' ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-600" />
                )}
                <span>{searchResult === 'available' ? 'Villa Available' : 'Villa Occupied'}</span>
              </div>
              <p className="font-mono text-[11px] text-slate-500 leading-normal">
                {searchResult === 'available' 
                  ? 'No conflicting reservations exist. You can safely record a direct booking for these dates.'
                  : `Conflicting Booking: Reserved by ${conflictingBooking?.guestName} (${conflictingBooking?.checkIn} to ${conflictingBooking?.checkOut})`}
              </p>
            </div>
          )}
        </div>

        {/* View Switcher Controls Dashboard */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs lg:col-span-2 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex justify-between items-center pb-2 border-b border-slate-50">
              <h3 className="text-sm font-display font-semibold text-slate-900">Reservations Panel</h3>
              <div className="flex gap-1.5 bg-slate-100 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={() => setViewMode('calendar')}
                  className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                    viewMode === 'calendar' ? 'bg-white text-teal-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Visual Scheduler
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                    viewMode === 'list' ? 'bg-white text-teal-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Detailed List
                </button>
              </div>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              Villaggio Del Sol gatehouse and manager reservations desk. Switch to the <strong>Visual Scheduler</strong> for a timeline representation across all 16 villas, or use the <strong>Detailed List</strong> to perform guest checks and payments processing.
            </p>
          </div>

          <div className="pt-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div className="flex items-center gap-2 bg-slate-50 px-3.5 py-1.5 rounded-xl border border-slate-100">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="p-1 hover:bg-slate-200 rounded-lg text-slate-600 transition-colors"
                title="Previous Month"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-bold text-slate-700 font-mono w-32 text-center">{displayMonthYear}</span>
              <button
                type="button"
                onClick={handleNextMonth}
                className="p-1 hover:bg-slate-200 rounded-lg text-slate-600 transition-colors"
                title="Next Month"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPrintOptions(!showPrintOptions)}
                className={`px-4 py-2 border rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all ${
                  showPrintOptions 
                    ? 'bg-amber-50 border-amber-200 text-amber-800' 
                    : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                }`}
              >
                <Printer className="w-4 h-4" /> Print Report...
              </button>
              <button
                onClick={() => {
                  if (!canAddBookings) {
                    alert('Unauthorized: Junior Officers do not have permission to book guests directly.');
                    return;
                  }
                  setIsAdding(true);
                }}
                className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all shadow-xs"
              >
                <Plus className="w-4 h-4" /> New Guest Reservation
              </button>
            </div>
          </div>

          {showPrintOptions && (
            <div className="mt-4 p-4 bg-amber-50/40 border border-amber-100 rounded-xl space-y-3">
              <div className="flex justify-between items-center">
                <h4 className="text-xs font-bold text-amber-900 uppercase tracking-wide flex items-center gap-1.5">
                  <Printer className="w-3.5 h-3.5" /> Print Reservations by Date Range
                </h4>
                <button 
                  type="button" 
                  onClick={() => setShowPrintOptions(false)} 
                  className="text-slate-400 hover:text-slate-600 text-sm font-bold"
                >
                  ✕
                </button>
              </div>
              <p className="text-[11px] text-amber-800">
                Specify a range of arrival and departure dates to filter down the generated ledger. Leave fields blank to print all records.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="text-[10px] font-mono text-slate-600 block mb-1">From Arrival Date</label>
                  <input
                    type="date"
                    value={printStart}
                    onChange={(e) => setPrintStart(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono bg-white text-slate-800"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-slate-600 block mb-1">To Departure Date</label>
                  <input
                    type="date"
                    value={printEnd}
                    onChange={(e) => setPrintEnd(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono bg-white text-slate-800"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!printStart || !printEnd) {
                        alert('Please fill both check-in (From) and check-out (To) dates for printing reservation periods.');
                        return;
                      }
                      window.print();
                    }}
                    className="flex-1 py-2.5 px-3 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 shadow-xs transition-all"
                  >
                    <Printer className="w-3.5 h-3.5" /> Execute Print
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPrintStart('');
                      setPrintEnd('');
                    }}
                    className="px-3 py-2.5 border border-slate-200 hover:bg-slate-100 text-slate-500 rounded-xl text-xs font-semibold transition-all bg-white"
                    title="Clear filter"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Success/Error Notifications */}
      {errorMsg && (
        <div className="p-4 bg-red-50 border border-red-100 text-red-800 text-xs rounded-xl flex items-center gap-2">
          <AlertCircle className="w-4.5 h-4.5 text-red-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-4 bg-teal-50 border border-teal-100 text-teal-800 text-xs rounded-xl">
          {successMsg}
        </div>
      )}

      {/* INTERACTIVE TIMELINE SCHEDULER VIEW */}
      {viewMode === 'calendar' && (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-100 flex justify-between items-center text-xs">
            <span className="text-slate-500 font-mono">
              Click any active bar to **Edit Guest reservation details**. Click any empty grid cell to **create a booking**.
            </span>
            <div className="flex items-center gap-3.5">
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded bg-emerald-500"></span>
                <span className="text-[10px] text-slate-500 font-mono">Direct</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded bg-rose-500"></span>
                <span className="text-[10px] text-slate-500 font-mono">Airbnb</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded bg-blue-500"></span>
                <span className="text-[10px] text-slate-500 font-mono">Booking.com</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded bg-slate-400"></span>
                <span className="text-[10px] text-slate-500 font-mono">Blocked</span>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[1100px]">
              {/* Calendar Grid Header */}
              <div className="grid grid-cols-[140px_repeat(31,1fr)] bg-slate-50 text-[10px] font-mono text-slate-500 border-b border-slate-100">
                <div className="p-3.5 font-bold border-r border-slate-200 sticky left-0 bg-slate-50 z-10 text-slate-700">Villa Unit</div>
                {daysArray.map(day => {
                  const weekend = isWeekendDay(day);
                  return (
                    <div 
                      key={day} 
                      className={`py-2 px-1 text-center font-bold border-r border-slate-100 flex flex-col items-center justify-center ${
                        weekend ? 'bg-amber-50/80 text-amber-900 border-r border-amber-100' : 'text-slate-600'
                      }`}
                    >
                      <span className="text-[11px] leading-tight">{day}</span>
                      <span className="text-[8px] font-semibold opacity-70 font-sans leading-none mt-0.5">{getDayOfWeekLetter(day)}</span>
                    </div>
                  );
                })}
              </div>

              {/* Rows matching each Villa */}
              <div className="divide-y divide-slate-100">
                {sortedUnits.map(unit => (
                  <div key={unit.id} className="grid grid-cols-[140px_repeat(31,1fr)] items-center group">
                    <div className="p-3 font-semibold text-xs border-r border-slate-200 sticky left-0 bg-white group-hover:bg-slate-50 z-10 flex flex-col justify-center min-h-[56px]">
                      <span className="text-slate-900 font-bold">Villa {unit.number}</span>
                      <span className="text-[8px] font-mono text-slate-400 uppercase leading-none mt-1">{unit.status}</span>
                    </div>

                    {daysArray.map(day => {
                      const b = getBookingForDay(unit.id, day);
                      const weekend = isWeekendDay(day);
                      let cellClass = `p-1 h-14 border-r border-slate-100/60 last:border-0 relative hover:bg-slate-50/50 flex items-center justify-center transition-colors ${
                        weekend ? 'bg-amber-50/20' : ''
                      }`;
                      let barClass = "";
                      
                      if (b) {
                        if (b.source === 'Airbnb') barClass = "bg-rose-500 text-white hover:bg-rose-600 ring-1 ring-rose-200";
                        else if (b.source === 'Booking.com') barClass = "bg-blue-500 text-white hover:bg-blue-600 ring-1 ring-blue-200";
                        else if (b.source === 'Blocked' || b.source === 'Unavailable') barClass = "bg-slate-400 text-white hover:bg-slate-500 ring-1 ring-slate-200";
                        else barClass = "bg-emerald-500 text-white hover:bg-emerald-600 ring-1 ring-emerald-200";
                      }

                      return (
                        <div 
                          key={day} 
                          className={cellClass}
                          onClick={() => handleCellClick(unit, day)}
                        >
                          {b ? (
                            <button
                              type="button"
                              title={`${b.guestName} (${b.checkIn} to ${b.checkOut}) - Rate: ${b.nightlyRate || 'N/A'}`}
                              className={`w-full h-11 px-1 text-[9px] font-bold rounded-lg truncate text-center cursor-pointer shadow-xs transition-all flex flex-col items-center justify-center gap-0.5 ${barClass}`}
                            >
                              <span className="truncate w-full max-w-full block leading-none">{b.guestName.split(' ')[0]}</span>
                              {b.nightlyRate && <span className="text-[8px] opacity-95 leading-none font-mono font-medium">${b.nightlyRate}</span>}
                            </button>
                          ) : (
                            <div className="opacity-0 group-hover:opacity-100 text-slate-350 hover:text-teal-600 cursor-pointer text-xs font-bold w-full h-full flex items-center justify-center">
                              +
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DETAILED LIST DIRECTORY VIEW */}
      {viewMode === 'list' && (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 font-mono text-[10px] uppercase">
                  <th className="p-3">Guest Details</th>
                  <th className="p-3">Villa No</th>
                  <th className="p-3">Check-In / Out</th>
                  <th className="p-3">Source</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Stay Budget</th>
                  <th className="p-3 text-right">Operations & Adjustments</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {bookings.map(b => (
                  <tr key={b.id} className="hover:bg-slate-50/20">
                    <td className="p-3">
                      <p className="font-semibold text-slate-900">{b.guestName}</p>
                      {b.guestEmail && <p className="text-[10px] text-slate-400 font-mono mt-0.5">{b.guestEmail}</p>}
                      {b.guestPhone && <p className="text-[10px] text-slate-400 font-mono">{b.guestPhone}</p>}
                    </td>
                    <td className="p-3 font-semibold font-mono">Villa {b.unitNumber}</td>
                    <td className="p-3 text-[11px] font-mono text-slate-600">
                      <div>{b.checkIn}</div>
                      <div className="text-[10px] text-slate-400">to {b.checkOut}</div>
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] border font-medium font-mono ${getSourceBadge(b.source)}`}>
                        {b.source}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] border font-medium ${getStatusBadge(b.status)}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-[11px]">
                      <div className="text-slate-700 font-semibold">Total: {b.currency === 'USD' ? '$' : 'J$'}{b.amount}</div>
                      <div className="text-teal-600 mt-0.5">Dep: {b.currency === 'USD' ? '$' : 'J$'}{b.depositPaid}</div>
                      <div className="text-red-500">Bal: {b.currency === 'USD' ? '$' : 'J$'}{b.balanceDue}</div>
                    </td>
                    <td className="p-3 text-right space-y-1 sm:space-y-0 sm:space-x-1">
                      {canEditBookings && (
                        <button
                          onClick={() => handleOpenEditModal(b)}
                          className="px-2 py-1 text-[10px] font-semibold bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-md inline-flex items-center gap-1 transition-colors"
                        >
                          <Edit2 className="w-3 h-3" /> Edit
                        </button>
                      )}
                      {b.status === 'confirmed' && (
                        <button
                          onClick={() => onUpdateBookingStatus(b.id, 'checked-in')}
                          className="px-2 py-1 text-[10px] font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-md transition-colors"
                        >
                          Check In
                        </button>
                      )}
                      {b.status === 'checked-in' && (
                        <button
                          onClick={() => onUpdateBookingStatus(b.id, 'checked-out')}
                          className="px-2 py-1 text-[10px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 rounded-md transition-colors"
                        >
                          Check Out
                        </button>
                      )}
                      {b.status !== 'cancelled' && b.status !== 'checked-out' && canCancelBookings && (
                        <button
                          onClick={() => onUpdateBookingStatus(b.id, 'cancelled')}
                          className="px-2 py-1 text-[10px] font-semibold bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 rounded-md transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Booking Form Dialog */}
      {isAdding && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreateBooking} className="bg-white rounded-2xl max-w-md w-full shadow-xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="text-base font-display font-semibold text-slate-900">Add New Guest Reservation</h3>
              <button type="button" onClick={() => setIsAdding(false)} className="text-slate-400 hover:text-slate-600 font-semibold text-xl">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-3.5 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Target Villa</label>
                <select
                  value={unitId}
                  onChange={(e) => setUnitId(e.target.value)}
                  required
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                >
                  <option value="">Select Villa</option>
                  {sortedUnits.map(u => (
                    <option key={u.id} value={u.id}>{getUnitDisplayName(u.number)} (HOA Curr: {u.currency})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Guest Name</label>
                <input
                  type="text"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="e.g. John Doe"
                  required
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Email</label>
                  <input
                    type="email"
                    value={guestEmail}
                    onChange={(e) => setGuestEmail(e.target.value)}
                    placeholder="john@doe.com"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Phone</label>
                  <input
                    type="text"
                    value={guestPhone}
                    onChange={(e) => setGuestPhone(e.target.value)}
                    placeholder="+1-3 Miami"
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Arrival Date</label>
                  <input
                    type="date"
                    value={checkIn}
                    onChange={(e) => setCheckIn(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Departure Date</label>
                  <input
                    type="date"
                    value={checkOut}
                    onChange={(e) => setCheckOut(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Stay Channel Source</label>
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value as Booking['source'])}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="Direct">Direct Guest</option>
                    <option value="Airbnb">Airbnb</option>
                    <option value="Booking.com">Booking.com</option>
                    <option value="Blocked">Blocked Owners</option>
                    <option value="Unavailable">Maintenance Out of Order</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Booking Notes</label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notes..."
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>
              </div>

               <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Nightly Rate</label>
                  <input
                    type="number"
                    value={nightlyRate}
                    onChange={(e) => setNightlyRate(e.target.value)}
                    placeholder="Rate/night"
                    required
                    className="w-full text-xs p-2 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Deposit Paid</label>
                  <input
                    type="number"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    placeholder="Deposit"
                    className="w-full text-xs p-2 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Total stay (Auto-calc)</label>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Total amount"
                    className="w-full text-xs p-2 bg-slate-50 border border-slate-250 rounded-xl font-mono font-bold text-teal-700"
                  />
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all"
              >
                {loading ? 'Validating Overlaps...' : 'Approve & Reserve Stay'}
              </button>
              <button
                type="button"
                onClick={() => setIsAdding(false)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-100 transition-all"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Booking Form Dialog */}
      {editingBooking && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <form onSubmit={handleSaveEdit} className="bg-white rounded-2xl max-w-md w-full shadow-xl border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <div>
                <h3 className="text-base font-display font-semibold text-slate-900">Edit Guest Reservation</h3>
                <p className="text-[10px] text-slate-400 font-mono mt-0.5">Booking Record Ref: {editingBooking.id}</p>
              </div>
              <button type="button" onClick={() => setEditingBooking(null)} className="text-slate-400 hover:text-slate-600 font-semibold text-xl">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-3.5 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Target Villa</label>
                <select
                  value={editUnitId}
                  onChange={(e) => setEditUnitId(e.target.value)}
                  required
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-semibold"
                >
                  {sortedUnits.map(u => (
                    <option key={u.id} value={u.id}>{getUnitDisplayName(u.number)} (HOA: {u.currency})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Guest Name</label>
                <input
                  type="text"
                  value={editGuestName}
                  onChange={(e) => setEditGuestName(e.target.value)}
                  required
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Email</label>
                  <input
                    type="email"
                    value={editGuestEmail}
                    onChange={(e) => setEditGuestEmail(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Phone</label>
                  <input
                    type="text"
                    value={editGuestPhone}
                    onChange={(e) => setEditGuestPhone(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Arrival Date</label>
                  <input
                    type="date"
                    value={editCheckIn}
                    onChange={(e) => setEditCheckIn(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Departure Date</label>
                  <input
                    type="date"
                    value={editCheckOut}
                    onChange={(e) => setEditCheckOut(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Stay Channel Source</label>
                  <select
                    value={editSource}
                    onChange={(e) => setEditSource(e.target.value as Booking['source'])}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl"
                  >
                    <option value="Direct">Direct Guest</option>
                    <option value="Airbnb">Airbnb</option>
                    <option value="Booking.com">Booking.com</option>
                    <option value="Blocked">Blocked Owners</option>
                    <option value="Unavailable">Maintenance Out of Order</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Reservation Status</label>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value as Booking['status'])}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-semibold"
                  >
                    <option value="confirmed">Confirmed</option>
                    <option value="checked-in">Checked In</option>
                    <option value="checked-out">Checked Out</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Nightly Rate</label>
                  <input
                    type="number"
                    value={editNightlyRate}
                    onChange={(e) => setEditNightlyRate(e.target.value)}
                    placeholder="Rate/night"
                    required
                    className="w-full text-xs p-2 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Deposit Paid</label>
                  <input
                    type="number"
                    value={editDeposit}
                    onChange={(e) => setEditDeposit(e.target.value)}
                    className="w-full text-xs p-2 border border-slate-200 rounded-xl font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-slate-500 block mb-1">Total Stay (Auto-calc)</label>
                  <input
                    type="number"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    className="w-full text-xs p-2 bg-slate-50 border border-slate-250 rounded-xl font-mono font-bold text-teal-700"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Booking Notes</label>
                <textarea
                  rows={2}
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl text-slate-700"
                />
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all"
              >
                {loading ? 'Verifying Conflict...' : 'Save Changes'}
              </button>
              <button
                type="button"
                onClick={() => setEditingBooking(null)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-100 transition-all"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      </div>

      {/* PRINT-ONLY RESERVATION REPORT SECTION */}
      <div id="print-reservations-area" className="hidden print:block p-8 bg-white font-sans text-slate-900">
        <div className="border-b-2 border-slate-950 pb-4 mb-6">
          <h1 className="text-2xl font-bold uppercase tracking-wider">Villaggio Del Sol</h1>
          <p className="text-sm font-semibold tracking-wide text-slate-600 mt-1">GUEST RESERVATIONS REPORT</p>
          <p className="text-xs font-mono text-slate-500 mt-2">
            Filter Period: {printStart || 'All Time'} to {printEnd || 'All Time'} | Generated: {new Date().toLocaleDateString()}
          </p>
        </div>

        <table className="w-full text-xs text-left border-collapse border border-slate-300">
          <thead>
            <tr className="bg-slate-100 uppercase font-bold text-[10px] border-b border-slate-300">
              <th className="p-2 border border-slate-300">Villa</th>
              <th className="p-2 border border-slate-300">Guest Name</th>
              <th className="p-2 border border-slate-300">Arrival</th>
              <th className="p-2 border border-slate-300">Departure</th>
              <th className="p-2 border border-slate-300">Channel</th>
              <th className="p-2 border border-slate-300">Status</th>
              <th className="p-2 border border-slate-300 text-right">Nightly Rate</th>
              <th className="p-2 border border-slate-300 text-right">Total Stay</th>
              <th className="p-2 border border-slate-300 text-right">Deposit Paid</th>
              <th className="p-2 border border-slate-300 text-right">Balance Due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {bookings
              .filter(b => (!printStart || b.checkIn <= printEnd) && (!printEnd || b.checkOut >= printStart))
              .map(b => (
                <tr key={b.id} className="text-[11px]">
                  <td className="p-2 border border-slate-300 font-bold font-mono">Villa {b.unitNumber}</td>
                  <td className="p-2 border border-slate-300">
                    <div className="font-semibold">{b.guestName}</div>
                    {b.guestEmail && <div className="text-[9px] text-slate-500">{b.guestEmail}</div>}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono">{b.checkIn}</td>
                  <td className="p-2 border border-slate-300 font-mono">{b.checkOut}</td>
                  <td className="p-2 border border-slate-300 font-mono">{b.source}</td>
                  <td className="p-2 border border-slate-300 uppercase">{b.status}</td>
                  <td className="p-2 border border-slate-300 text-right font-mono">${b.nightlyRate || '-'}</td>
                  <td className="p-2 border border-slate-300 text-right font-mono">{b.currency === 'USD' ? '$' : 'J$'}{b.amount}</td>
                  <td className="p-2 border border-slate-300 text-right font-mono text-emerald-700">{b.currency === 'USD' ? '$' : 'J$'}{b.depositPaid}</td>
                  <td className="p-2 border border-slate-300 text-right font-mono text-red-600 font-semibold">{b.currency === 'USD' ? '$' : 'J$'}{b.balanceDue}</td>
                </tr>
              ))}
          </tbody>
        </table>
        
        <div className="mt-8 pt-4 border-t border-slate-200 text-center text-[10px] text-slate-400 font-mono">
          Confidential - Villaggio Del Sol Reservations Management Ledger
        </div>
      </div>
    </>
  );
}
