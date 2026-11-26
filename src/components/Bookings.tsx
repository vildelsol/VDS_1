/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { useRemembered } from '../lib/screenState';
import { AppSettings, Booking, Currency, PAYMENT_METHODS, Payment, PaymentMethod, SessionUser, Unit, getUnitDisplayName } from '../types';
import { BookingClash, bookingCoversNight, bookingOverlaps, bookingsForUnit, bookingsOverlap } from '../lib/finance';
import { formatMoney, formatMoneyLong, round2 } from '../lib/money';
import { dayOfTimestamp, addDays, addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, nightsBetween, today } from '../lib/dates';
import { errorMessage } from '../lib/api';
import { filterReservations, stayOverlapsDays } from '../lib/bookingFilter';
import { buildStayReceiptEmail, openMailDraft } from '../lib/email';
import { STAY_PHASE_LABEL, StayPhase, guestGreetingName, isClosedDates, platformReservation, receiptStanding, stayMoney, stayPhase } from '../lib/stays';
import PrintPortal, { PrintLetterhead, PrintSignatures } from './PrintPortal';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  Modal,
  PermissionNote,
  SecondaryButton,
  SubmitButton,
  SuccessNote,
  TableScroller,
  inputClass,
  monoInputClass,
  tableHeadRowClass
} from './ui';
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, Lock, Mail, Plus, Printer, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';

interface BookingsProps {
  units: Unit[];
  bookings: Booking[];
  /** The receipts. What a stay has been paid is read from these (`stayMoney`), never from the reservation. */
  payments?: Payment[];
  settings: AppSettings;
  session: SessionUser;
  onAddBooking: (payload: Record<string, unknown>) => Promise<Booking>;
  onUpdateBooking: (id: string, fields: Record<string, unknown>) => Promise<unknown>;
  onSyncCalendars: (feedId?: string) => Promise<{ results: unknown[] }>;
  onHoldDamageDeposit: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
  onSettleDamageDeposit: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
}

interface SyncOutcome {
  unitNumber: string;
  source: string;
  ok: boolean;
  imported: number;
  updated: number;
  unchanged: number;
  conflicts: string[];
  error?: string;
}

export default function Bookings({
  units,
  bookings,
  payments = [],
  settings,
  session,
  onAddBooking,
  onUpdateBooking,
  onSyncCalendars,
  onHoldDamageDeposit,
  onSettleDamageDeposit
}: BookingsProps) {
  const [view, setView] = useRemembered<'calendar' | 'list'>('bookings.view', 'calendar');
  const [month, setMonth] = useRemembered('bookings.month', currentMonth);
  const [adding, setAdding] = useState<{ unitId?: string; checkIn?: string } | null>(null);
  const [editing, setEditing] = useState<Booking | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null);
  const [printing, setPrinting] = useState<{ from: string; to: string; unitId: string } | null>(null);
  const [receiptBooking, setReceiptBooking] = useState<Booking | null>(null);
  const [depositBooking, setDepositBooking] = useState<Booking | null>(null);
  const [showPrintOptions, setShowPrintOptions] = useState(false);
  const [printFrom, setPrintFrom] = useState(monthStart(currentMonth()));
  const [printTo, setPrintTo] = useState(monthEnd(currentMonth()));
  const [printUnitId, setPrintUnitId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [syncing, setSyncing] = useState(false);

  const perms = session.permissions;
  const canAdd = !!perms.addBookings;
  const canEdit = !!perms.editBookings;
  const canCancel = !!perms.cancelBookings;
  /*
   * A completed stay is a settled record (Ro, 2026-11-19): only a role allowed
   * to modify settled ledger records may open it for editing. The server refuses
   * the same edit, so this only spares the person a form they cannot save.
   */
  const canEditStay = (b: Booking) => canEdit && (stayPhase(b, today()) !== 'completed' || !!perms.modifySettledRecords);
  const COMPLETED_LOCKED = 'This stay is completed, so it is a settled record. Ask a Manager or an Administrator to change it.';
  const canHoldDeposit = !!perms.recordPayments;
  const canSettleDeposit = !!perms.reversePayments;

  const sortedUnits = useMemo(
    () => [...units].sort((a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0) || a.number.localeCompare(b.number)),
    [units]
  );

  /**
   * The villas this screen is about: the ones actually on the short-let market.
   *
   * Every villa used to appear here — the availability search, the scheduler
   * grid, the villa dropdown — so a long-term let and the proprietor's own home
   * sat in a list of things a guest could be booked into. Ro, 2026-09-02: *"if a
   * villa isnt listed in its status as short term rental it should not be listed
   * under short term bookings … this is a huge gap."*
   *
   * A villa that **carries a reservation** stays on the list whatever its status
   * is now, because a villa moved to a long-term lease still has last winter's
   * stays against it and a record that disappears is worse than one out of
   * place. It is shown, and cannot be chosen for a new booking — the server
   * refuses it too, so the filter is a courtesy rather than the control.
   */
  const shortLetUnits = useMemo(() => {
    const hasBookings = new Set(bookings.map(b => b.unitId));
    return sortedUnits.filter(u => u.status === 'short-term' || hasBookings.has(u.id));
  }, [sortedUnits, bookings]);

  /**
   * Safety net: the create/edit forms already refuse overlapping dates, but an
   * import, a data restore, or an edit on another device could still leave two
   * live reservations sharing nights on the same villa. Surface any such clash
   * loudly so staff can resolve it before a double-booking reaches a guest.
   */
  const overlapWarnings: BookingClash[] = useMemo(() => bookingOverlaps(bookings), [bookings]);

  /* ---------------- calendar ---------------- */

  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const dayKey = (day: number) => `${month}-${String(day).padStart(2, '0')}`;

  /**
   * A stay occupies the nights from arrival up to (not including) departure.
   * The original calendar used an inclusive end date, so it painted the checkout
   * day as occupied while the availability engine happily accepted a booking
   * starting that day — the two views of the same data disagreed.
   */
  const bookingOn = (unit: Unit, day: number): Booking | undefined =>
    bookingsForUnit(bookings, unit, units).find(b => bookingCoversNight(b, dayKey(day)));

  const isWeekend = (day: number) => {
    const d = new Date(year, monthIndex, day);
    return d.getDay() === 0 || d.getDay() === 6;
  };
  const dayLetter = (day: number) => ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(year, monthIndex, day).getDay()];

  /* ---------------- availability search ---------------- */

  const [searchUnitId, setSearchUnitId] = useState('');
  const [searchIn, setSearchIn] = useState('');
  const [searchOut, setSearchOut] = useState('');
  const [searchResult, setSearchResult] = useState<{ available: boolean; message: string } | null>(null);

  const runSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setSearchResult(null);
    const unit = units.find(u => u.id === searchUnitId);
    if (!unit || !searchIn || !searchOut) return;
    if (searchOut <= searchIn) {
      setSearchResult({ available: false, message: 'The departure date must be after the arrival date.' });
      return;
    }
    if (unit.status === 'unavailable') {
      setSearchResult({ available: false, message: `${getUnitDisplayName(unit.number)} is marked Unavailable and cannot be booked.` });
      return;
    }
    if (unit.status === 'long-term') {
      setSearchResult({
        available: false,
        message: `${getUnitDisplayName(unit.number)} is under a long-term lease${unit.tenantName ? ` to ${unit.tenantName}` : ''} and is not available for short stays.`
      });
      return;
    }
    const clash = bookingsForUnit(bookings, unit, units).find(
      b => b.status !== 'cancelled' && bookingsOverlap(searchIn, searchOut, b.checkIn, b.checkOut)
    );
    setSearchResult(
      clash
        ? {
            available: false,
            message: `Occupied by ${clash.guestName} from ${formatDayLabel(clash.checkIn)} to ${formatDayLabel(clash.checkOut)}.`
          }
        : {
            available: true,
            message: `${nightsBetween(searchIn, searchOut)} night(s) available. Same-day changeovers are permitted, so a stay ending on an arrival date does not clash.`
          }
    );
  };

  /* ---------------- sync ---------------- */

  const activeFeeds = settings.icalFeeds.filter(f => f.active);

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    setSuccess('');
    try {
      const response = await onSyncCalendars();
      const results = (response?.results || []) as SyncOutcome[];
      const failed = results.filter(r => !r.ok);
      const imported = results.reduce((n, r) => n + (r.imported || 0), 0);
      const updated = results.reduce((n, r) => n + (r.updated || 0), 0);
      const conflicts = results.flatMap(r => r.conflicts || []);

      const parts = [`${imported} reservation(s) imported`, `${updated} updated`];
      if (conflicts.length) parts.push(`${conflicts.length} skipped because they clash with existing reservations`);
      if (failed.length) parts.push(`${failed.length} feed(s) could not be reached`);
      setSuccess(`Calendar sync finished: ${parts.join(', ')}.`);
      if (failed.length) {
        setError(failed.map(f => `${f.unitNumber} (${f.source}): ${f.error}`).join(', '));
      }
    } catch (err) {
      setError(errorMessage(err, 'Calendar sync failed.'));
    } finally {
      setSyncing(false);
    }
  };

  /* ---------------- list ---------------- */

  /*
   * Filtered by where the stay stands on the calendar, not by the recorded status:
   * nobody checks a guest out of an Airbnb stay here, so "confirmed" covered last
   * month's stays and next month's alike. Ro, 2026-09-16: *"when a short term
   * booking has already been completed there's no way to tell."*
   */
  const [listFilter, setListFilter] = useRemembered<'all' | StayPhase>('bookings.listFilter', 'all');
  /*
   * Month and villa, so the list does not grow for ever. Ro, 2026-11-19. The
   * month is the scheduler's own `month`, so the two views always agree on which
   * month is open; "All months" is a separate switch the list alone obeys. A stay
   * is in a month when a night of it is (`stayOverlapsMonth`): the departure day
   * is not a night, so a stay leaving on 1 November is not a November stay.
   */
  const [listAllMonths, setListAllMonths] = useRemembered<boolean>('bookings.listAllMonths', false);
  const [rememberedUnitId, setListUnitId] = useRemembered('bookings.listUnitId', '');
  // A remembered villa that is no longer on this screen must not hide everything.
  const listUnitId = shortLetUnits.some(u => u.id === rememberedUnitId) ? rememberedUnitId : '';
  const listUnit = shortLetUnits.find(u => u.id === listUnitId);
  const todayKey = today();
  const listRows = useMemo(
    () =>
      filterReservations(bookings, { month: listAllMonths ? null : month, unitId: listUnitId })
        // "All" means every stay still on: a cancelled one leaves the list and is found under "Cancelled" (Ro, 2026-11-26).
        .filter(b => (listFilter === 'all' ? stayPhase(b, todayKey) !== 'cancelled' : stayPhase(b, todayKey) === listFilter))
        .sort((a, b) => b.checkIn.localeCompare(a.checkIn)),
    [bookings, listFilter, todayKey, listAllMonths, month, listUnitId]
  );
  const listFilterDescription = [
    listAllMonths ? 'all months' : formatMonthLabel(month),
    listUnit ? getUnitDisplayName(listUnit.number) : 'all villas',
    listFilter === 'all' ? '' : STAY_PHASE_LABEL[listFilter].toLowerCase()
  ]
    .filter(Boolean)
    .join(', ');
  const showListAllMonths = view === 'list' && listAllMonths;
  const stepMonth = (delta: number) => {
    // Stepping from "All months" goes back to browsing a single month.
    if (showListAllMonths) setListAllMonths(false);
    setMonth(addMonths(month, delta));
  };

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}

      {overlapWarnings.length > 0 && (
        <div role="alert" className="space-y-2 rounded-2xl border-2 border-red-200 bg-red-50 p-4 text-xs text-red-800">
          <p className="flex items-center gap-1.5 font-semibold">
            <AlertCircle className="h-4 w-4 text-red-600" />
            {overlapWarnings.length} overlapping reservation{overlapWarnings.length === 1 ? '' : 's'} detected, resolve to avoid a double-booking
          </p>
          <ul className="space-y-1">
            {overlapWarnings.map((c, i) => (
              <li key={i} className="font-mono text-[11px]">
                {getUnitDisplayName(c.unitNumber)}: <strong>{c.a.guestName}</strong> ({formatDayLabel(c.a.checkIn)}–{formatDayLabel(c.a.checkOut)}) overlaps{' '}
                <strong>{c.b.guestName}</strong> ({formatDayLabel(c.b.checkIn)}–{formatDayLabel(c.b.checkOut)}). Cancel or move one in the list below.
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-50 pb-2">
            <h3 className="font-display text-sm font-semibold text-slate-900">Availability checker</h3>
            <Search className="h-4 w-4 text-slate-400" />
          </div>

          <form onSubmit={runSearch} className="space-y-3.5">
            <Field label="Villa" htmlFor="av-unit" required>
              <select id="av-unit" value={searchUnitId} onChange={e => setSearchUnitId(e.target.value)} required className={inputClass}>
                <option value="">Select villa</option>
                {shortLetUnits.map(u => (
                  <option key={u.id} value={u.id}>
                    {getUnitDisplayName(u.number)}, {u.status}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Arrival" htmlFor="av-in" required>
              <input id="av-in" type="date" value={searchIn} onChange={e => setSearchIn(e.target.value)} required className={monoInputClass} />
            </Field>
            <Field label="Departure" htmlFor="av-out" required>
              <input id="av-out" type="date" value={searchOut} onChange={e => setSearchOut(e.target.value)} required className={monoInputClass} />
            </Field>
            <button type="submit" className="w-full rounded-xl bg-slate-900 py-2 text-xs font-medium text-white transition-all hover:bg-slate-800">
              Check availability
            </button>
          </form>

          {searchResult && (
            <div
              className={`space-y-1.5 rounded-xl border p-4 text-xs ${
                searchResult.available ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-red-100 bg-red-50 text-red-800'
              }`}
            >
              <p className="flex items-center gap-1.5 font-semibold">
                {searchResult.available ? <ShieldCheck className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                {searchResult.available ? 'Available' : 'Not available'}
              </p>
              <p className="font-mono text-[11px] leading-normal">{searchResult.message}</p>
            </div>
          )}
        </section>

        <section className="flex flex-col justify-between rounded-2xl border border-slate-100 bg-white p-6 shadow-xs lg:col-span-2">
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-slate-50 pb-2">
              <h3 className="font-display text-sm font-semibold text-slate-900">Reservations</h3>
              <div className="flex gap-1.5 rounded-lg bg-slate-100 p-1">
                {(['calendar', 'list'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setView(mode)}
                    aria-pressed={view === mode}
                    className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                      view === mode ? 'bg-white text-teal-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {mode === 'calendar' ? 'Visual scheduler' : 'Detailed list'}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-[11px] leading-relaxed text-slate-600">
              {activeFeeds.length === 0 ? (
                <>
                  <strong>No booking-platform calendars are connected.</strong> Reservations shown here were entered by
                  staff. To import Airbnb or Booking.com stays automatically, add each villa&apos;s .ics export link in
                  System Settings.
                </>
              ) : (
                <>
                  <strong>
                    {activeFeeds.length} calendar feed{activeFeeds.length === 1 ? '' : 's'} connected.
                  </strong>{' '}
                  Platform feeds publish dates only, never guest contact details or pricing, so imported stays need a
                  stay value entered manually.
                  {activeFeeds[0].lastSyncAt && (
                    <> Last synchronised {formatDayLabel(dayOfTimestamp(activeFeeds[0].lastSyncAt))}.</>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col items-start justify-between gap-3 pt-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-1.5">
              <button type="button" onClick={() => stepMonth(-1)} className="rounded-lg p-1 text-slate-600 hover:bg-slate-200" aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="w-32 text-center font-mono text-xs font-bold text-slate-700">{showListAllMonths ? 'All months' : formatMonthLabel(month)}</span>
              <button type="button" onClick={() => stepMonth(1)} className="rounded-lg p-1 text-slate-600 hover:bg-slate-200" aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </button>
              {(month !== currentMonth() || showListAllMonths) && (
                <button
                  type="button"
                  onClick={() => {
                    setMonth(currentMonth());
                    if (showListAllMonths) setListAllMonths(false);
                  }}
                  className="ml-1 text-[10px] font-medium text-teal-700 underline"
                >
                  Today
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {activeFeeds.length > 0 && canAdd && (
                <SecondaryButton onClick={() => void handleSync()} disabled={syncing} className="flex items-center gap-1.5">
                  <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing ? 'Syncing…' : 'Sync calendars'}
                </SecondaryButton>
              )}
              <SecondaryButton
                onClick={() => {
                  if (!showPrintOptions) {
                    // Open on what the screen is showing; every field can still be changed.
                    if (view === 'calendar' || !listAllMonths) {
                      setPrintFrom(monthStart(month));
                      setPrintTo(monthEnd(month));
                    }
                    setPrintUnitId(view === 'list' ? listUnitId : '');
                  }
                  setShowPrintOptions(v => !v);
                }}
                className="flex items-center gap-1.5"
              >
                <Printer className="h-4 w-4" /> Print report
              </SecondaryButton>
              {canAdd ? (
                <SubmitButton type="button" onClick={() => setAdding({})}>
                  <Plus className="h-4 w-4" /> New reservation
                </SubmitButton>
              ) : (
                <PermissionNote>Creating reservations requires additional permission.</PermissionNote>
              )}
            </div>
          </div>

          {showPrintOptions && (
            <div className="mt-4 space-y-3 rounded-xl border border-amber-100 bg-amber-50/40 p-4">
              <h4 className="text-xs font-bold uppercase tracking-wide text-amber-900">Print reservations for a date range</h4>
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
                <Field label="Villa" htmlFor="pr-unit">
                  <select id="pr-unit" value={printUnitId} onChange={e => setPrintUnitId(e.target.value)} className={inputClass}>
                    <option value="">All villas</option>
                    {shortLetUnits.map(u => (
                      <option key={u.id} value={u.id}>
                        {getUnitDisplayName(u.number)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="From" htmlFor="pr-from">
                  <input id="pr-from" type="date" value={printFrom} onChange={e => setPrintFrom(e.target.value)} className={monoInputClass} />
                </Field>
                <Field label="To" htmlFor="pr-to">
                  <input id="pr-to" type="date" value={printTo} onChange={e => setPrintTo(e.target.value)} className={monoInputClass} />
                </Field>
                <SubmitButton
                  type="button"
                  onClick={() => {
                    if (printTo < printFrom) {
                      setError('The end of the print range must fall on or after the start.');
                      return;
                    }
                    setPrinting({ from: printFrom, to: printTo, unitId: printUnitId });
                    setShowPrintOptions(false);
                  }}
                >
                  <Printer className="h-3.5 w-3.5" /> Open print preview
                </SubmitButton>
              </div>
              <p className="text-[11px] text-amber-800">
                Any stay with a night inside the range is included, whether or not it starts inside it. The departure
                day is not a night, so a stay leaving on the first day of the range is not included. The printout states
                the villa and period it covers.
              </p>
            </div>
          )}
        </section>
      </div>

      {view === 'calendar' ? (
        <section className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 p-4">
            <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-slate-900">
              <CalendarDays className="h-4 w-4 text-teal-600" />
              {formatMonthLabel(month)} occupancy
            </h3>
            <p className="hidden font-mono text-[10px] text-slate-400 sm:block">
              A stay occupies nights from arrival to the night before departure.
            </p>
          </div>
          <TableScroller>
            <table className="w-full border-collapse text-left text-[10px]">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-10 min-w-[130px] border-b border-r border-slate-100 bg-white p-2 font-mono text-[9px] uppercase text-slate-400">
                    Villa
                  </th>
                  {days.map(day => (
                    <th
                      key={day}
                      scope="col"
                      className={`border-b border-slate-100 p-1 text-center font-mono text-[9px] ${
                        dayKey(day) === today() ? 'bg-teal-50 font-bold text-teal-700' : isWeekend(day) ? 'bg-slate-50 text-slate-500' : 'text-slate-400'
                      }`}
                    >
                      <span className="block">{dayLetter(day)}</span>
                      <span className="block font-semibold">{day}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shortLetUnits.map(unit => (
                  <tr key={unit.id}>
                    <th scope="row" className="sticky left-0 z-10 border-b border-r border-slate-100 bg-white p-2 text-left font-mono text-[10px] font-semibold text-slate-700">
                      {getUnitDisplayName(unit.number)}
                      <span className="block font-sans text-[9px] font-normal text-slate-400">{unit.status}</span>
                    </th>
                    {days.map(day => {
                      const booking = bookingOn(unit, day);
                      const blocked = unit.status === 'unavailable' || unit.status === 'long-term';
                      return (
                        <td key={day} className="border-b border-slate-50 p-0">
                          <button
                            type="button"
                            title={
                              booking
                                ? `${booking.guestName}, ${formatDayLabel(booking.checkIn)} to ${formatDayLabel(booking.checkOut)} (${booking.source})`
                                : blocked
                                  ? `${getUnitDisplayName(unit.number)} is ${unit.status} and not available for short stays`
                                  : `Create a reservation for ${getUnitDisplayName(unit.number)} arriving ${formatDayLabel(dayKey(day))}`
                            }
                            onClick={() => {
                              if (booking) {
                                if (canEditStay(booking)) setEditing(booking);
                                else setError(canEdit ? COMPLETED_LOCKED : 'Your role is not permitted to modify reservations.');
                                return;
                              }
                              if (blocked) {
                                setError(`${getUnitDisplayName(unit.number)} is ${unit.status} and cannot take short stays.`);
                                return;
                              }
                              if (!canAdd) {
                                setError('Your role is not permitted to create reservations.');
                                return;
                              }
                              setAdding({ unitId: unit.id, checkIn: dayKey(day) });
                            }}
                            className={`h-8 w-full transition-colors ${
                              booking
                                ? booking.source === 'Airbnb'
                                  ? 'bg-rose-400 hover:bg-rose-500'
                                  : booking.source === 'Booking.com'
                                    ? 'bg-blue-400 hover:bg-blue-500'
                                    : booking.source === 'Blocked' || booking.source === 'Unavailable'
                                      ? 'bg-slate-400 hover:bg-slate-500'
                                      : 'bg-emerald-400 hover:bg-emerald-500'
                                : blocked
                                  ? 'bg-slate-100'
                                  : isWeekend(day)
                                    ? 'bg-slate-50 hover:bg-teal-100'
                                    : 'hover:bg-teal-100'
                            }`}
                          >
                            <span className="sr-only">
                              {getUnitDisplayName(unit.number)} on {dayKey(day)}: {booking ? booking.guestName : 'free'}
                            </span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
          <div className="flex flex-wrap gap-4 border-t border-slate-100 bg-slate-50 p-3 text-[10px]">
            {[
              ['bg-emerald-400', 'Direct'],
              ['bg-rose-400', 'Airbnb'],
              ['bg-blue-400', 'Booking.com'],
              ['bg-slate-400', 'Held / blocked'],
              ['bg-slate-100', 'Not available for short stays']
            ].map(([cls, label]) => (
              <span key={label} className="flex items-center gap-1.5 text-slate-600">
                <span className={`h-3 w-3 rounded ${cls}`} />
                {label}
              </span>
            ))}
          </div>
        </section>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
          <div className="flex flex-col gap-2 border-b border-slate-100 bg-slate-50 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <p className="text-xs text-slate-500" data-testid="list-count">
              Showing <span className="font-mono font-semibold text-slate-700">{listRows.length}</span> of{' '}
              <span className="font-mono">{bookings.length}</span> reservation{bookings.length === 1 ? '' : 's'}
              <span className="text-slate-400"> · {listFilterDescription}</span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Month"
                value={listAllMonths ? 'all' : 'month'}
                onChange={e => setListAllMonths(e.target.value === 'all')}
                className="rounded-lg border border-slate-200 p-1.5 text-xs"
              >
                <option value="month">{formatMonthLabel(month)}</option>
                <option value="all">All months</option>
              </select>
              <select
                aria-label="Villa"
                value={listUnitId}
                onChange={e => setListUnitId(e.target.value)}
                className="rounded-lg border border-slate-200 p-1.5 text-xs"
              >
                <option value="">All villas</option>
                {shortLetUnits.map(u => (
                  <option key={u.id} value={u.id}>
                    {getUnitDisplayName(u.number)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Stay status"
                value={listFilter}
                onChange={e => setListFilter(e.target.value as typeof listFilter)}
                className="rounded-lg border border-slate-200 p-1.5 text-xs"
              >
                <option value="all">All stays except cancelled</option>
                <option value="upcoming">{STAY_PHASE_LABEL.upcoming}</option>
                <option value="in-stay">{STAY_PHASE_LABEL['in-stay']}</option>
                <option value="completed">{STAY_PHASE_LABEL.completed}</option>
                <option value="cancelled">{STAY_PHASE_LABEL.cancelled}</option>
              </select>
            </div>
          </div>
          {listRows.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No reservations match these filters"
                hint={
                  bookings.length === 0
                    ? 'No reservations have been recorded yet.'
                    : `${bookings.length} reservation${bookings.length === 1 ? ' is' : 's are'} on record, none for ${listFilterDescription}. Choose another month, "All months" or "All villas" to see them.`
                }
              />
            </div>
          ) : (
            <TableScroller>
              <table className="w-full min-w-[900px] border-collapse text-left text-xs">
                <thead>
                  <tr className={tableHeadRowClass}>
                    <th scope="col" className="p-3">Villa</th>
                    <th scope="col" className="p-3">Guest</th>
                    <th scope="col" className="p-3">Dates</th>
                    <th scope="col" className="p-3 text-right">Nights</th>
                    <th scope="col" className="p-3">Channel</th>
                    <th scope="col" className="p-3 text-right">Stay value</th>
                    <th scope="col" className="p-3 text-right">Paid</th>
                    <th scope="col" className="p-3 text-right">Balance</th>
                    <th scope="col" className="p-3">Status</th>
                    <th scope="col" className="p-3">Damage held</th>
                    <th scope="col" className="p-3 text-right">Receipt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {listRows.map(b => {
                    const phase = stayPhase(b, todayKey);
                    const closed = isClosedDates(b);
                    const money = stayMoney(b, payments);
                    const standing = receiptStanding({ amount: b.amount, balanceDue: money.balance, complimentary: b.complimentary });
                    const platform = b.externalUid ? platformReservation(b.notes) : {};
                    return (
                    <tr
                      key={b.id}
                      onClick={() => (canEditStay(b) ? setEditing(b) : canEdit ? setError(COMPLETED_LOCKED) : undefined)}
                      title={canEdit && !canEditStay(b) ? COMPLETED_LOCKED : undefined}
                      className={`${canEditStay(b) ? 'cursor-pointer' : ''} transition-colors hover:bg-slate-50/60 ${
                        phase === 'cancelled' ? 'text-slate-400' : phase === 'completed' ? 'bg-slate-50/70 text-slate-500' : ''
                      }`}
                    >
                      <td className="p-3 font-mono font-semibold">{getUnitDisplayName(b.unitNumber)}</td>
                      <td className="p-3">
                        {closed ? (
                          <>
                            <p className="font-medium italic text-slate-500">Dates closed, no guest</p>
                            <p className="text-[10px] text-slate-400" title="Exactly what the calendar feed sent">
                              {b.guestName}
                            </p>
                          </>
                        ) : (
                          <p className="font-medium text-slate-900">{b.guestName}</p>
                        )}
                        {(b.guestEmail || b.guestPhone) && (
                          <p className="text-[10px] text-slate-400">{[b.guestEmail, b.guestPhone].filter(Boolean).join(' • ')}</p>
                        )}
                        {(platform.code || platform.phoneLast4) && (
                          <p className="text-[10px] text-slate-500">
                            {platform.code && (
                              <a
                                href={platform.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="font-mono text-teal-700 underline"
                                title="Open this reservation in Airbnb to see the guest's name and contact details"
                              >
                                {platform.code}
                              </a>
                            )}
                            {platform.code && platform.phoneLast4 && ' · '}
                            {platform.phoneLast4 && `phone ends ${platform.phoneLast4}`}
                          </p>
                        )}
                        {b.externalUid && <Badge tone="slate">Imported</Badge>}
                      </td>
                      <td className="p-3 font-mono text-[11px] text-slate-600">
                        {formatDayLabel(b.checkIn)} → {formatDayLabel(b.checkOut)}
                      </td>
                      <td className="p-3 text-right font-mono">{nightsBetween(b.checkIn, b.checkOut)}</td>
                      <td className="p-3">
                        <Badge tone={b.source === 'Airbnb' ? 'red' : b.source === 'Booking.com' ? 'blue' : b.source === 'Direct' ? 'green' : 'slate'}>{b.source}</Badge>
                      </td>
                      {closed ? (
                        <td colSpan={3} className="p-3 text-right text-[11px] text-slate-400">
                          No stay to charge
                        </td>
                      ) : standing === 'complimentary' ? (
                        <td colSpan={3} className="p-3 text-right text-[11px] font-medium text-violet-700" title={b.complimentaryReason}>
                          Complimentary{b.complimentaryReason ? `: ${b.complimentaryReason}` : ''}
                        </td>
                      ) : standing === 'no-value' ? (
                        <td colSpan={3} className="p-3 text-right text-[11px] font-medium text-amber-700">
                          Stay value not entered
                        </td>
                      ) : (
                        <>
                          <td className="p-3 text-right font-mono">{formatMoney(b.amount, b.currency)}</td>
                          <td className="p-3 text-right font-mono text-emerald-600">{formatMoney(money.paid, b.currency)}</td>
                          <td className="p-3 text-right font-mono font-semibold text-amber-600">{formatMoney(money.balance, b.currency)}</td>
                        </>
                      )}
                      <td className="p-3">
                        <Badge
                          tone={phase === 'in-stay' ? 'green' : phase === 'upcoming' ? 'blue' : phase === 'cancelled' ? 'red' : 'slate'}
                        >
                          {STAY_PHASE_LABEL[phase]}
                        </Badge>
                      </td>
                      {/* Optional throughout. Most stays take no damage deposit,
                          so this column is blank for them and nothing asks. */}
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        {!closed && (
                        <DamageDepositCell
                          booking={b}
                          canHold={canHoldDeposit}
                          canSettle={canSettleDeposit}
                          onOpen={() => setDepositBooking(b)}
                        />
                        )}
                      </td>
                      <td className="p-3 text-right" onClick={e => e.stopPropagation()}>
                        {/* Closed dates have no guest to give a receipt to. */}
                        {/* A stay already over is a settled record: changing it goes through the edit form and its lock. */}
                        {b.status !== 'cancelled' && canCancel && canEditStay(b) && phase !== 'completed' && (
                          <button
                            onClick={() => setCancelTarget(b)}
                            aria-label={closed ? `Unblock ${formatDayLabel(b.checkIn)} to ${formatDayLabel(b.checkOut)}` : `Cancel the reservation for ${b.guestName}`}
                            className="mr-1.5 inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1.5 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-50"
                          >
                            <XCircle className="h-3.5 w-3.5" /> {closed ? 'Unblock' : 'Cancel'}
                          </button>
                        )}
                        {b.status !== 'cancelled' && !closed && (
                          <button
                            onClick={() => setReceiptBooking(b)}
                            title="Print or email a guest stay receipt"
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-50"
                          >
                            <Printer className="h-3.5 w-3.5" /> Guest receipt
                          </button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroller>
          )}
        </section>
      )}

      {adding && (
        <BookingForm
          mode="create"
          units={shortLetUnits}
          bookings={bookings}
          initialUnitId={adding.unitId}
          initialCheckIn={adding.checkIn}
          onClose={() => setAdding(null)}
          onSubmit={async payload => {
            const booking = await onAddBooking(payload);
            setSuccess(`Reservation saved for ${booking.guestName} (${formatDayLabel(booking.checkIn)} to ${formatDayLabel(booking.checkOut)}).`);
            setError('');
            setAdding(null);
          }}
        />
      )}

      {cancelTarget && (
        <BookingForm
          mode="edit"
          units={shortLetUnits}
          bookings={bookings}
          booking={cancelTarget}
          canCancel={canCancel}
          startCancelling
          onClose={() => setCancelTarget(null)}
          onSubmit={async payload => {
            await onUpdateBooking(cancelTarget.id, payload);
            setSuccess(
              isClosedDates(cancelTarget)
                ? `Unblocked ${formatDayLabel(cancelTarget.checkIn)} to ${formatDayLabel(cancelTarget.checkOut)}. The dates are free to book.`
                : `Cancelled the reservation for ${cancelTarget.guestName}. ${formatDayLabel(cancelTarget.checkIn)} to ${formatDayLabel(cancelTarget.checkOut)} is free to book.`
            );
            setError('');
            setCancelTarget(null);
          }}
        />
      )}

      {editing && (
        <BookingForm
          mode="edit"
          units={shortLetUnits}
          bookings={bookings}
          booking={editing}
          canCancel={canCancel}
          onClose={() => setEditing(null)}
          onSubmit={async payload => {
            await onUpdateBooking(editing.id, payload);
            setSuccess(
              payload.status === 'cancelled' && editing.status !== 'cancelled'
                ? `${isClosedDates(editing) ? 'Unblocked' : `Cancelled the reservation for ${editing.guestName}:`} ${formatDayLabel(editing.checkIn)} to ${formatDayLabel(editing.checkOut)} is free to book.`
                : 'Reservation updated.'
            );
            setError('');
            setEditing(null);
          }}
        />
      )}

      {depositBooking && (
        <DamageDepositModal
          booking={depositBooking}
          canHold={canHoldDeposit}
          canSettle={canSettleDeposit}
          onClose={() => setDepositBooking(null)}
          onHold={async payload => {
            await onHoldDamageDeposit(depositBooking.id, payload);
            setSuccess(`Damage deposit recorded as held for ${depositBooking.guestName}. It is the guest's money, not income.`);
            setError('');
            setDepositBooking(null);
          }}
          onSettle={async payload => {
            await onSettleDamageDeposit(depositBooking.id, payload);
            setSuccess(`Damage deposit reconciled for ${depositBooking.guestName}.`);
            setError('');
            setDepositBooking(null);
          }}
        />
      )}

      {printing && (
        <ReservationsReport
          bookings={bookings}
          payments={payments}
          from={printing.from}
          to={printing.to}
          unit={shortLetUnits.find(u => u.id === printing.unitId)}
          generatedBy={session.name}
          onClose={() => setPrinting(null)}
        />
      )}

      {receiptBooking && (
        <GuestStayReceipt
          booking={receiptBooking}
          payments={payments}
          unit={units.find(u => u.id === receiptBooking.unitId)}
          generatedBy={session.name}
          onClose={() => setReceiptBooking(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A guest-facing document for a short-term stay — the confirmation/receipt the
 * guest keeps, distinct from the internal payment receipt in the finance ledger.
 * It shows the stay, what was paid, and any balance due on arrival.
 */
export function GuestStayReceipt({
  booking,
  payments = [],
  unit,
  generatedBy,
  onClose
}: {
  booking: Booking;
  payments?: Payment[];
  unit: Unit | undefined;
  generatedBy: string;
  onClose: () => void;
}) {
  const villa = unit ? getUnitDisplayName(unit.number) : `Unit ${booking.unitNumber}`;
  const nights = nightsBetween(booking.checkIn, booking.checkOut);
  // What the guest has paid, from the receipts and net of refunds — never the
  // reservation's own deposit field (see `stayMoney`).
  const money = stayMoney(booking, payments);
  // "Paid in full" only when there was something to pay. An imported stay with
  // no value entered has had nothing paid — see `receiptStanding`.
  const standing = receiptStanding({ amount: booking.amount, balanceDue: money.balance, complimentary: booking.complimentary, status: booking.status, overpaid: money.overpaid });
  const paidInFull = standing === 'paid';
  // Overpaid has been received in full too: a receipt, never "due on arrival".
  const received = paidInFull || standing === 'overpaid';

  return (
    <PrintPortal
      title={`Guest ${received ? 'receipt' : 'confirmation'}: ${guestGreetingName(booking) === 'Guest' ? villa : guestGreetingName(booking)}`}
      subtitle={`${villa} · ${formatDayLabel(booking.checkIn)} to ${formatDayLabel(booking.checkOut)}`}
      onClose={onClose}
      maxWidthClass="max-w-md"
      actions={
        <button
          type="button"
          onClick={() => openMailDraft(buildStayReceiptEmail(booking, unit, money))}
          disabled={!booking.guestEmail}
          title={booking.guestEmail ? `Draft an email to ${booking.guestEmail}` : 'No guest email on file'}
          className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50 disabled:opacity-50"
        >
          <Mail className="h-3.5 w-3.5" />
          Email
        </button>
      }
    >
      <PrintLetterhead
        documentTitle={received ? 'Guest Stay Receipt' : 'Guest Stay Confirmation'}
        meta={villa}
        generatedBy={generatedBy}
      />

      <p className="mb-4 text-xs text-slate-700">
        Dear {guestGreetingName(booking)}, thank you for choosing Villaggio Del Sol. Your reservation details are confirmed below.
      </p>

      <dl className="space-y-0 text-xs">
        {[
          ['Villa', villa],
          ['Booking channel', booking.source],
          ['Arrival', formatDayLabel(booking.checkIn)],
          ['Departure', formatDayLabel(booking.checkOut)],
          ['Nights', String(nights)],
          ...(booking.nightlyRate ? [['Nightly rate', formatMoneyLong(booking.nightlyRate, booking.currency)]] : [])
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-slate-200 py-2">
            <dt className="text-slate-500">{label}</dt>
            <dd className="text-right font-semibold text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      {standing === 'cancelled' ? (
        <div className="mt-4 space-y-1.5 rounded-xl border border-slate-300 bg-slate-50 p-4 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-slate-600">Reservation</span>
            <span className="font-semibold">Cancelled</span>
          </div>
          {money.paid > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-600">Paid, net of refunds</span>
              <span className="font-semibold">{formatMoneyLong(money.paid, booking.currency)}</span>
            </div>
          )}
          {money.overpaid > 0 && (
            <div className="flex justify-between border-t border-slate-300 pt-1.5 text-sm">
              <span className="font-semibold">Owed back to guest</span>
              <span className="font-bold text-amber-700">{formatMoneyLong(money.overpaid, booking.currency)}</span>
            </div>
          )}
        </div>
      ) : standing === 'complimentary' ? (
        <div className="mt-4 rounded-xl border border-slate-300 bg-slate-50 p-4 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-slate-600">Stay total</span>
            <span className="font-semibold">Complimentary, no charge</span>
          </div>
        </div>
      ) : standing === 'no-value' ? (
        <div className="mt-4 rounded-xl border border-slate-300 bg-slate-50 p-4 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-slate-600">Stay total</span>
            <span className="font-semibold">Not yet confirmed</span>
          </div>
        </div>
      ) : (
      <div className="mt-4 space-y-1.5 rounded-xl border border-slate-300 bg-slate-50 p-4 font-mono text-xs">
        <div className="flex justify-between">
          <span className="text-slate-600">Stay total</span>
          <span className="font-semibold">{formatMoneyLong(booking.amount, booking.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-600">Deposit / paid</span>
          <span className="font-semibold text-emerald-700">{formatMoneyLong(money.paid, booking.currency)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-300 pt-1.5 text-sm">
          <span className="font-semibold">{received ? 'Balance' : 'Balance due on arrival'}</span>
          <span className={`font-bold ${received ? 'text-emerald-700' : 'text-amber-700'}`}>
            {formatMoneyLong(money.balance, booking.currency)}
          </span>
        </div>
        {standing === 'overpaid' && (
          <div className="flex justify-between text-sm">
            <span className="font-semibold">Overpaid, owed back to guest</span>
            <span className="font-bold text-amber-700">{formatMoneyLong(money.overpaid, booking.currency)}</span>
          </div>
        )}
      </div>
      )}

      {paidInFull ? (
        <p className="print-emphasis mt-4 rounded-lg border border-emerald-500 bg-emerald-50 py-1.5 text-center text-xs font-bold uppercase tracking-widest text-emerald-800">
          Paid in full
        </p>
      ) : standing === 'overpaid' ? (
        <p className="mt-4 text-center text-[11px] text-slate-500">
          More than the stay total has been received. The amount overpaid is owed back to the guest. Amounts are in {booking.currency}.
        </p>
      ) : standing === 'balance-due' ? (
        <p className="mt-4 text-center text-[11px] text-slate-500">
          The balance shown is payable on arrival. Amounts are in {booking.currency}.
        </p>
      ) : null}

      <PrintSignatures left="Villaggio Del Sol" right="Guest signature" />

      <p className="mt-5 border-t border-dashed border-slate-300 pt-2 text-center font-mono text-[9px] uppercase text-slate-400">
        Villaggio Del Sol · Ocho Rios, Jamaica · we look forward to welcoming you
      </p>
    </PrintPortal>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The total a nightly rate implies, or `null` when it implies nothing.
 *
 * Pulled out of the component so the rule can be asserted without a DOM — the
 * suite renders components with `react-dom/server`, which cannot type into a
 * field or run an effect, so a rule left inside a handler is a rule no test can
 * reach. This one had a real fault in it (see `changeNightlyRate` below), and
 * the fault was invisible to every test that existed.
 *
 * `null` means "leave the total as it is": no dates yet, or a rate that has been
 * cleared. An empty rate says "I am not pricing it that way", not "the stay is
 * worth nothing", so it must never wipe a figure somebody typed.
 */
export function stayValueForRate(rate: string | number, nights: number): string | null {
  const value = Number(rate);
  if (!(nights > 0) || !Number.isFinite(value) || !(value > 0)) return null;
  return String(round2(value * nights));
}

export function BookingForm({
  mode,
  units,
  bookings,
  booking,
  initialUnitId,
  initialCheckIn,
  canCancel = true,
  startCancelling = false,
  onClose,
  onSubmit
}: {
  mode: 'create' | 'edit';
  units: Unit[];
  bookings: Booking[];
  booking?: Booking;
  initialUnitId?: string;
  initialCheckIn?: string;
  canCancel?: boolean;
  /** Opened from a Cancel / Unblock button: the form asks only what a cancel needs. */
  startCancelling?: boolean;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  /*
   * Only villas on the short-let market can take a new reservation — the server
   * enforces the same rule and will refuse anything else. An existing booking
   * keeps its own villa in the list whatever the status is now, so editing a
   * guest's phone number cannot silently move their stay to another villa.
   */
  const bookableUnits = units.filter(u => u.status === 'short-term' || (booking && u.id === booking.unitId));
  const [unitId, setUnitId] = useState(booking?.unitId || initialUnitId || bookableUnits[0]?.id || '');
  const [guestName, setGuestName] = useState(booking?.guestName || '');
  const [guestEmail, setGuestEmail] = useState(booking?.guestEmail || '');
  const [guestPhone, setGuestPhone] = useState(booking?.guestPhone || '');
  const [checkIn, setCheckIn] = useState(booking?.checkIn || initialCheckIn || '');
  const [checkOut, setCheckOut] = useState(booking?.checkOut || '');
  const [source, setSource] = useState<Booking['source']>(booking?.source || 'Direct');
  const [status, setStatus] = useState<Booking['status']>(startCancelling && booking ? 'cancelled' : booking?.status || 'confirmed');
  const [currency, setCurrency] = useState<Currency>(booking?.currency || 'USD');
  const [nightlyRate, setNightlyRate] = useState(booking?.nightlyRate ? String(booking.nightlyRate) : '');
  const [amount, setAmount] = useState(booking ? String(booking.amount) : '');
  const [deposit, setDeposit] = useState(booking ? String(booking.depositPaid) : '');
  // Cash unless somebody says otherwise: that is how guests pay here, and the
  // receipt raised from this reservation is the guest's own copy of it.
  const [depositMethod, setDepositMethod] = useState<PaymentMethod>(booking?.depositMethod || 'Cash');
  const [depositReceivedOn, setDepositReceivedOn] = useState(booking ? booking.depositReceivedOn || '' : today());
  const [notes, setNotes] = useState(booking?.notes || '');
  // Free on purpose, with a reason; any role that may save a reservation may mark it (Ro, 2026-11-19).
  const [complimentary, setComplimentary] = useState(!!booking?.complimentary);
  const [complimentaryReason, setComplimentaryReason] = useState(booking?.complimentaryReason || '');
  // Every change to a reservation says why; the server refuses one that does not (Ro, 2026-11-19).
  const [editReason, setEditReason] = useState('');
  // What happens to a received deposit when the stay is cancelled: asked, never assumed.
  // Ro, 2026-11-20: a cancelled stay's deposit is refunded; it is voided only
  // when it was entered by mistake.
  const [depositOutcome, setDepositOutcome] = useState<'' | 'refund' | 'void'>('refund');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const unit = units.find(u => u.id === unitId);
  const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : 0;

  // Default the currency to the villa's own when creating.
  React.useEffect(() => {
    if (mode === 'create' && unit) setCurrency(unit.currency);
  }, [unitId, mode, unit]);

  /**
   * The stay value follows rate × nights, and typing a total by hand overrides it.
   *
   * The override used to latch for the life of the form: one touch of the total
   * field and the nightly rate never drove it again. Ro, 2026-09-02: *"when i
   * input the nightly rate, the total is not automatically calculated in the
   * total stay value field … if the nightly rate is populated, it should
   * automatically reflect in the total stay value."*
   *
   * The worst shape of it was silent. Typing a figure into the total and then
   * deleting it leaves the field looking untouched — and latched — so entering a
   * nightly rate afterwards did nothing at all and the total stayed empty. The
   * only way out was to close the reservation and start again.
   *
   * So the latch is released by the rate itself: **changing the nightly rate
   * always recomputes the total**, because that is an explicit act on the field
   * the total is derived from and nobody types a rate expecting the total to
   * ignore it. Changing the dates still respects a hand-typed total, which is
   * what the guard was for — a stay negotiated at a flat price keeps that price
   * when a date moves.
   *
   * Clearing the rate leaves the total alone. An empty rate says "I am not
   * pricing it that way", not "the stay is worth nothing", and wiping a figure
   * somebody may have typed would be the same silent overwrite in the other
   * direction.
   */
  const [amountTouched, setAmountTouched] = useState(false);
  React.useEffect(() => {
    if (amountTouched) return;
    if (nights > 0 && Number(nightlyRate) > 0) setAmount(String(round2(Number(nightlyRate) * nights)));
  }, [nights, nightlyRate, amountTouched]);

  const changeNightlyRate = (next: string) => {
    setNightlyRate(next);
    const derived = stayValueForRate(next, nights);
    if (derived !== null) {
      setAmount(derived);
      setAmountTouched(false);
    }
  };

  const balance = round2(Math.max(0, (Number(amount) || 0) - (Number(deposit) || 0)));

  const clash = useMemo(() => {
    if (!unitId || !checkIn || !checkOut || checkOut <= checkIn) return null;
    return (
      bookings.find(
        b => b.id !== booking?.id && b.unitId === unitId && b.status !== 'cancelled' && bookingsOverlap(checkIn, checkOut, b.checkIn, b.checkOut)
      ) || null
    );
  }, [unitId, checkIn, checkOut, bookings, booking?.id]);

  const cancelling = mode === 'edit' && status === 'cancelled' && booking?.status !== 'cancelled';
  // Owner blocks and maintenance holds have no guest: cancelling one is unblocking the dates.
  const closedDates = !!booking && isClosedDates(booking);
  const canStartCancel = mode === 'edit' && !!booking && booking.status !== 'cancelled' && canCancel && !cancelling;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (checkOut <= checkIn) {
      setError('The departure date must be after the arrival date.');
      return;
    }
    if (!complimentary && Number(deposit) > Number(amount)) {
      setError('The deposit cannot exceed the total stay value.');
      return;
    }
    if (complimentary && complimentaryReason.trim().length < 5) {
      setError('Say why this stay is complimentary (at least 5 characters).');
      return;
    }
    if (clash && status !== 'cancelled') {
      setError(`Those dates clash with ${clash.guestName} (${formatDayLabel(clash.checkIn)} to ${formatDayLabel(clash.checkOut)}).`);
      return;
    }
    if (cancelling && (booking?.depositPaid || 0) > 0 && !depositOutcome) {
      setError('Say what happens to the deposit received: refund it, or void it if it was entered by mistake.');
      return;
    }
    if (mode === 'edit' && editReason.trim().length < 5) {
      setError('Say why this reservation is being changed (at least 5 characters). The reason is kept on the audit trail.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        ...(mode === 'edit' ? { editReason: editReason.trim() } : {}),
        ...(cancelling && depositOutcome ? { depositOutcome } : {}),
        unitId,
        guestName,
        guestEmail,
        guestPhone,
        checkIn,
        checkOut,
        source,
        status,
        currency,
        complimentary,
        ...(complimentary ? { complimentaryReason: complimentaryReason.trim() } : {}),
        nightlyRate: complimentary || nightlyRate === '' ? undefined : Number(nightlyRate),
        amount: complimentary ? 0 : Number(amount) || 0,
        depositPaid: complimentary ? 0 : Number(deposit) || 0,
        depositMethod,
        ...(depositReceivedOn ? { depositReceivedOn } : {}),
        notes
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the reservation.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={
        mode === 'create'
          ? 'New guest reservation'
          : cancelling
            ? closedDates
              ? 'Unblock these dates'
              : `Cancel reservation: ${booking?.guestName}`
            : `Reservation: ${booking?.guestName}`
      }
      subtitle={unit ? getUnitDisplayName(unit.number) : undefined}
      onClose={onClose}
      maxWidthClass="max-w-lg"
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-booking-form" className="flex-1">
            {mode === 'create' ? 'Save reservation' : cancelling ? (closedDates ? 'Unblock these dates' : 'Cancel this reservation') : 'Save changes'}
          </SubmitButton>
          {canStartCancel && (
            <SecondaryButton onClick={() => setStatus('cancelled')}>{closedDates ? 'Unblock dates' : 'Cancel reservation'}</SecondaryButton>
          )}
          {/* "Cancel" here would read as cancelling the reservation; this only closes the window. */}
          <SecondaryButton onClick={cancelling && !startCancelling ? () => setStatus(booking?.status || 'confirmed') : onClose}>
            {cancelling ? (closedDates ? 'Keep them blocked' : 'Keep the reservation') : 'Close'}
          </SecondaryButton>
        </div>
      }
    >
      <form id="vds-booking-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        {booking?.externalUid && (
          <InfoNote>
            Imported from the {booking.source} calendar. Platform feeds carry dates only, so guest contact details and
            the stay value must be entered here. Re-syncing will update the dates but will not overwrite what you enter.
          </InfoNote>
        )}

        {clash && status !== 'cancelled' && (
          <ErrorNote>
            These dates clash with {clash.guestName} ({formatDayLabel(clash.checkIn)} to {formatDayLabel(clash.checkOut)}).
            A stay ending on another&apos;s arrival date is fine; overlapping nights are not.
          </ErrorNote>
        )}

        {/*
          Without this the dropdown is simply empty and the reason is invisible.
          A villa has to be declared a short let before a guest can be booked
          into it, and the place to declare it is the register.
        */}
        {bookableUnits.length === 0 && (
          <ErrorNote>
            No villa is set to <strong>Short-term / Airbnb</strong> in the Units Register, so there is nothing to book.
            Set a villa&rsquo;s status there first, a long-term let, an owner&rsquo;s own home or a villa off the market
            cannot take a guest reservation.
          </ErrorNote>
        )}

        {!cancelling && (<>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Villa" htmlFor="bf-unit" required>
            <select id="bf-unit" value={unitId} onChange={e => setUnitId(e.target.value)} required className={inputClass}>
              <option value="">Select villa</option>
              {bookableUnits.map(u => (
                <option key={u.id} value={u.id}>
                  {getUnitDisplayName(u.number)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Channel" htmlFor="bf-source" required>
            <select id="bf-source" value={source} onChange={e => setSource(e.target.value as Booking['source'])} className={inputClass}>
              <option value="Direct">Direct</option>
              <option value="Airbnb">Airbnb</option>
              <option value="Booking.com">Booking.com</option>
              <option value="Blocked">Owner block / hold</option>
              <option value="Unavailable">Unavailable (maintenance)</option>
            </select>
          </Field>
        </div>

        <Field label="Guest name" htmlFor="bf-guest" required>
          <input id="bf-guest" type="text" value={guestName} onChange={e => setGuestName(e.target.value)} required className={inputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Guest email" htmlFor="bf-email">
            <input id="bf-email" type="email" value={guestEmail} onChange={e => setGuestEmail(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Guest phone" htmlFor="bf-phone">
            <input id="bf-phone" type="tel" value={guestPhone} onChange={e => setGuestPhone(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Arrival" htmlFor="bf-in" required>
            <input id="bf-in" type="date" value={checkIn} onChange={e => setCheckIn(e.target.value)} required className={monoInputClass} />
          </Field>
          <Field label="Departure" htmlFor="bf-out" required hint={nights > 0 ? `${nights} night${nights === 1 ? '' : 's'}` : undefined}>
            <input id="bf-out" type="date" value={checkOut} min={checkIn || undefined} onChange={e => setCheckOut(e.target.value)} required className={monoInputClass} />
          </Field>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700" htmlFor="bf-comp">
          <input id="bf-comp" type="checkbox" checked={complimentary} onChange={e => setComplimentary(e.target.checked)} className="mt-1" />
          <span>
            <strong>Complimentary stay</strong>, no charge. The value is J$0 on purpose and no money is taken.
          </span>
        </label>
        {complimentary && (
          <Field label="Why is this stay complimentary?" htmlFor="bf-comp-reason" required>
            <input
              id="bf-comp-reason"
              type="text"
              value={complimentaryReason}
              onChange={e => setComplimentaryReason(e.target.value)}
              required
              placeholder="e.g. Wedding party, owner's guests"
              className={inputClass}
            />
          </Field>
        )}

        {!complimentary && (<>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Nightly rate" htmlFor="bf-rate" hint="Optional. Set it and the total below follows rate × nights.">
            <input
              id="bf-rate"
              type="number"
              min="0"
              step="0.01"
              value={nightlyRate}
              onChange={e => changeNightlyRate(e.target.value)}
              className={monoInputClass}
            />
          </Field>
          <Field label="Total stay value" htmlFor="bf-amount" required>
            <input
              id="bf-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={e => {
                setAmountTouched(true);
                setAmount(e.target.value);
              }}
              required
              className={monoInputClass}
            />
          </Field>
          <Field label="Currency" htmlFor="bf-cur" required>
            <select id="bf-cur" value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={inputClass}>
              <option value="USD">USD ($)</option>
              <option value="JMD">JMD (J$)</option>
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Deposit received" htmlFor="bf-dep" hint="A receipt is raised automatically for this amount.">
            <input id="bf-dep" type="number" min="0" step="0.01" value={deposit} onChange={e => setDeposit(e.target.value)} className={monoInputClass} />
          </Field>
          <Field label="Balance due on arrival" htmlFor="bf-bal">
            <input id="bf-bal" type="text" value={formatMoneyLong(balance, currency)} readOnly className={`${monoInputClass} bg-slate-100`} />
          </Field>
        </div>

        {/*
          How the deposit arrived, on the reservation rather than on the receipt.
          The receipt is raised from here and cannot be edited on its own, so this
          is the only place the method can be stated or put right.
        */}
        {(Number(deposit) > 0 || (booking?.depositPaid || 0) > 0) && (
          <Field label="How the deposit was paid" htmlFor="bf-dep-method" hint="This is what the guest's receipt will say.">
            <select
              id="bf-dep-method"
              value={depositMethod}
              onChange={e => setDepositMethod(e.target.value as PaymentMethod)}
              className={inputClass}
            >
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        )}

        {/* The day the money was handed over dates its receipt. It used to be the
            day this form was saved, so a September deposit typed in November was
            November cash on every report. */}
        {(Number(deposit) > 0 || (booking?.depositPaid || 0) > 0) && (
          <Field
            label="Date the deposit was received"
            htmlFor="bf-dep-date"
            hint={depositReceivedOn ? 'The receipt is dated this day. Not in the future, not in a closed month.' : 'Leave empty to keep the date already on the receipt.'}
          >
            <input
              id="bf-dep-date"
              type="date"
              value={depositReceivedOn}
              max={today()}
              onChange={e => setDepositReceivedOn(e.target.value)}
              className={monoInputClass}
            />
          </Field>
        )}
        </>)}

        {mode === 'edit' && (
          <Field label="Status" htmlFor="bf-status" required>
            <select
              id="bf-status"
              value={status}
              onChange={e => setStatus(e.target.value as Booking['status'])}
              disabled={booking?.status === 'cancelled'}
              className={inputClass}
            >
              <option value="confirmed">Confirmed</option>
              <option value="checked-in">Checked in</option>
              <option value="checked-out">Checked out</option>
              <option value="cancelled" disabled={!canCancel}>
                Cancelled{canCancel ? '' : ' (requires permission)'}
              </option>
            </select>
          </Field>
        )}
        </>)}

        {cancelling && booking && (
          <InfoNote tone="amber">
            {closedDates ? 'The' : <><strong>{booking.guestName}</strong>&rsquo;s</>} {nightsBetween(booking.checkIn, booking.checkOut)} night(s),{' '}
            {formatDayLabel(booking.checkIn)} to {formatDayLabel(booking.checkOut)}, are freed on the calendar and can be booked again.
            The {closedDates ? 'block' : 'reservation'} leaves the list but is kept on record: choose <em>Cancelled</em> in the list&rsquo;s
            stay filter to see it. It cannot be reinstated, and the reason goes on the audit trail.
            {booking.externalUid && ` It came from the ${booking.source} calendar: cancel it on ${booking.source} as well, or the platform will still show it as booked.`}
          </InfoNote>
        )}

        {cancelling && (booking?.depositPaid || 0) > 0 && (
          <Field label="The deposit received on this stay" htmlFor="bf-deposit-outcome" required>
            <select
              id="bf-deposit-outcome"
              value={depositOutcome}
              onChange={e => setDepositOutcome(e.target.value as typeof depositOutcome)}
              required
              className={inputClass}
            >
              {/* Ro, 2026-11-20: "refund it", and "if entered by mistake void it". */}
              <option value="refund">Refund it to the guest (recorded as a refund on the receipt)</option>
              <option value="void">Void the receipt: the deposit was entered by mistake</option>
            </select>
          </Field>
        )}
        {cancelling && depositOutcome === 'void' && (
          <InfoNote tone="amber">
            Voiding says the money never arrived. The receipt stays in the ledger marked VOID, with the reason recorded,
            it is not deleted.
          </InfoNote>
        )}

        {booking?.status === 'cancelled' && <InfoNote>This reservation is cancelled and cannot be reinstated. Create a new one instead.</InfoNote>}

        {!cancelling && (
        <Field label="Notes" htmlFor="bf-notes">
          <textarea id="bf-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>
        )}
        {mode === 'edit' && (
          <Field label={cancelling ? (closedDates ? 'Reason for unblocking these dates' : 'Reason for cancelling') : 'Reason for this change'} htmlFor="bf-edit-reason" required>
            <textarea
              id="bf-edit-reason"
              rows={2}
              value={editReason}
              onChange={e => setEditReason(e.target.value)}
              required
              placeholder={cancelling ? (closedDates ? 'e.g. Owner no longer needs the villa those nights' : 'e.g. Guest cancelled by phone on 25 November') : 'e.g. Guest extended by one night; price agreed by phone'}
              className={inputClass}
            />
          </Field>
        )}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The damage deposit at a glance.
 *
 * Blank when there is none, which is most stays — a deposit is optional and this
 * column must not nag for one. It offers to take one only where taking one is
 * still meaningful.
 */
function DamageDepositCell({
  booking,
  canHold,
  canSettle,
  onOpen
}: {
  booking: Booking;
  canHold: boolean;
  canSettle: boolean;
  onOpen: () => void;
}) {
  const currency = booking.damageDepositCurrency ?? booking.currency;

  if (booking.damageDepositReturnedOn) {
    const withheld = booking.damageDepositWithheldAmount || 0;
    return (
      <span className="text-[10px] text-slate-500">
        <Badge tone={withheld > 0 ? 'amber' : 'slate'}>{withheld > 0 ? 'Part withheld' : 'Returned'}</Badge>
        <span className="mt-0.5 block font-mono">{formatMoney(booking.damageDepositReturnedAmount || 0, currency)} back</span>
      </span>
    );
  }

  if (booking.damageDepositAmount) {
    return (
      <button
        type="button"
        onClick={onOpen}
        disabled={!canSettle}
        title={canSettle ? 'Reconcile this deposit' : 'Reconciling a deposit requires additional permission'}
        className="text-left disabled:cursor-default"
      >
        <Badge tone="blue">Held</Badge>
        <span className="mt-0.5 block font-mono text-[10px] text-slate-600">{formatMoney(booking.damageDepositAmount, currency)}</span>
      </button>
    );
  }

  if (!canHold || booking.status === 'cancelled') return <span className="text-[10px] text-slate-300">-</span>;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
    >
      <Lock className="h-3 w-3" /> Hold one
    </button>
  );
}

/**
 * Take a damage deposit, or reconcile the one being held.
 *
 * Reconciling insists the two figures add up to what was held and that anything
 * withheld carries a reason. A deposit that half disappears is the thing a guest
 * disputes, and a chargeback follows the guest rather than the property's
 * paperwork.
 */
function DamageDepositModal({
  booking,
  canHold,
  canSettle,
  onClose,
  onHold,
  onSettle
}: {
  booking: Booking;
  canHold: boolean;
  canSettle: boolean;
  onClose: () => void;
  onHold: (payload: Record<string, unknown>) => Promise<void>;
  onSettle: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const held = booking.damageDepositAmount || 0;
  const reconciling = held > 0;
  const currency = booking.damageDepositCurrency ?? booking.currency;

  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(today());
  const [depositCurrency, setDepositCurrency] = useState<Currency>(booking.currency);
  const [withheld, setWithheld] = useState('0');
  const [withheldReason, setWithheldReason] = useState('');
  const [settledOn, setSettledOn] = useState(today());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const withheldNum = Math.max(0, Number(withheld) || 0);
  const returning = round2(held - withheldNum);
  const overWithheld = withheldNum > held;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (reconciling) {
        await onSettle({ withheldAmount: withheldNum, returnedAmount: returning, withheldReason, settledOn });
      } else {
        await onHold({ amount: Number(amount), currency: depositCurrency, receivedOn });
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not save the damage deposit.'));
    } finally {
      setBusy(false);
    }
  };

  const blocked = reconciling ? !canSettle : !canHold;

  return (
    <Modal
      title={reconciling ? 'Reconcile the damage deposit' : 'Hold a damage deposit'}
      onClose={onClose}
      maxWidthClass="max-w-md"
      footer={
        <div className="flex gap-3">
          <SubmitButton
            busy={busy}
            busyLabel="Saving…"
            form="vds-damage-deposit-form"
            disabled={blocked || (reconciling && overWithheld)}
            className="flex-1"
          >
            {reconciling ? 'Reconcile' : 'Record as held'}
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-damage-deposit-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}
        {blocked && (
          <PermissionNote>
            {reconciling
              ? 'Deciding what to keep from a guest requires additional permission.'
              : 'Taking money from a guest requires additional permission.'}
          </PermissionNote>
        )}

        <div className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-600">
          <p className="font-medium text-slate-800">
            {getUnitDisplayName(booking.unitNumber)}, {booking.guestName}
          </p>
          <p className="font-mono">
            {formatDayLabel(booking.checkIn)} → {formatDayLabel(booking.checkOut)}
          </p>
        </div>

        {reconciling ? (
          <>
            <InfoNote>
              {formatMoneyLong(held, currency)} is held, taken on {formatDayLabel(booking.damageDepositReceivedOn || '')}. What is returned
              and what is kept must add up to it.
            </InfoNote>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Withheld" htmlFor="dd-withheld" hint="Leave at zero to return it all.">
                <input
                  id="dd-withheld"
                  type="number"
                  min="0"
                  max={held}
                  step="0.01"
                  value={withheld}
                  onChange={e => setWithheld(e.target.value)}
                  className={monoInputClass}
                />
              </Field>
              <Field label="Returned to the guest" htmlFor="dd-returned">
                <input id="dd-returned" type="text" readOnly value={formatMoney(Math.max(0, returning), currency)} className={`${monoInputClass} bg-slate-50`} />
              </Field>
            </div>

            {overWithheld && <ErrorNote>You cannot withhold more than the {formatMoneyLong(held, currency)} being held.</ErrorNote>}

            {withheldNum > 0 && (
              <Field label="Reason for withholding" htmlFor="dd-reason" required hint="Kept permanently. It is what justifies the deduction.">
                <textarea id="dd-reason" rows={3} value={withheldReason} onChange={e => setWithheldReason(e.target.value)} required className={inputClass} />
              </Field>
            )}

            <Field label="Date settled" htmlFor="dd-settled" required>
              <input id="dd-settled" type="date" max={today()} value={settledOn} onChange={e => setSettledOn(e.target.value)} required className={monoInputClass} />
            </Field>

            {withheldNum > 0 && (
              <InfoNote tone="amber">
                Keeping this money is not income. If it is covering a real cost, a broken door, a replaced mattress, record that cost as an
                expense against the villa.
              </InfoNote>
            )}
          </>
        ) : (
          <>
            <InfoNote>
              This is the guest&rsquo;s money, held against damage and owed back. It raises no receipt, counts in no collection figure, and
              never reaches a proprietor&rsquo;s statement. It is separate from any deposit paid toward the stay itself.
            </InfoNote>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount held" htmlFor="dd-amount" required>
                <input id="dd-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required className={monoInputClass} />
              </Field>
              <Field label="Currency" htmlFor="dd-cur" required>
                <select id="dd-cur" value={depositCurrency} onChange={e => setDepositCurrency(e.target.value as Currency)} className={inputClass}>
                  <option value="JMD">JMD (J$)</option>
                  <option value="USD">USD ($)</option>
                </select>
              </Field>
            </div>

            <Field label="Date received" htmlFor="dd-received" required>
              <input id="dd-received" type="date" max={today()} value={receivedOn} onChange={e => setReceivedOn(e.target.value)} required className={monoInputClass} />
            </Field>
          </>
        )}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

export function ReservationsReport({
  bookings,
  payments = [],
  from,
  to,
  unit,
  generatedBy,
  onClose
}: {
  bookings: Booking[];
  /** Paid and balance are read from these (`stayMoney`), never from the reservation. */
  payments?: Payment[];
  from: string;
  to: string;
  /** One villa, or undefined for every villa. The printout says which. */
  unit?: Unit;
  generatedBy: string;
  onClose: () => void;
}) {
  // Any stay with a night in the range, not only those starting inside it. The
  // same rule as the on-screen list (`stayOverlapsDays`), so the two agree.
  const rows = bookings
    .filter(b => (!unit || b.unitId === unit.id) && stayOverlapsDays(b, from, to))
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.unitNumber.localeCompare(b.unitNumber));

  const villaLabel = unit ? getUnitDisplayName(unit.number) : 'All villas';
  /*
   * Totals count what the period actually holds (hunt, 2026-11-20): closed dates
   * are no guest and never "sold"; only the nights inside the period count; a
   * complimentary night is given, not sold; and a stay spanning the period's edge
   * contributes its value prorated by the nights inside it, labelled as such.
   * Paid and balance stay whole-stay figures, because receipts are per stay.
   */
  const periodEnd = addDays(to, 1);
  const nightsInPeriod = (b: Booking) =>
    Math.max(0, nightsBetween(b.checkIn > from ? b.checkIn : from, b.checkOut < periodEnd ? b.checkOut : periodEnd));
  const totals = rows.reduce<Record<Currency, { value: number; fullValue: number; spanning: number; deposit: number; balance: number; nights: number; compNights: number }>>(
    (acc, b) => {
      if (b.status === 'cancelled' || isClosedDates(b)) return acc;
      const inPeriod = nightsInPeriod(b);
      if (b.complimentary) {
        acc[b.currency].compNights += inPeriod;
        return acc;
      }
      const whole = nightsBetween(b.checkIn, b.checkOut);
      if (inPeriod < whole) acc[b.currency].spanning += 1;
      acc[b.currency].value = round2(acc[b.currency].value + (whole > 0 ? (b.amount * inPeriod) / whole : 0));
      acc[b.currency].fullValue = round2(acc[b.currency].fullValue + b.amount);
      const money = stayMoney(b, payments);
      acc[b.currency].deposit = round2(acc[b.currency].deposit + money.paid);
      acc[b.currency].balance = round2(acc[b.currency].balance + money.balance);
      acc[b.currency].nights += inPeriod;
      return acc;
    },
    {
      USD: { value: 0, fullValue: 0, spanning: 0, deposit: 0, balance: 0, nights: 0, compNights: 0 },
      JMD: { value: 0, fullValue: 0, spanning: 0, deposit: 0, balance: 0, nights: 0, compNights: 0 }
    }
  );

  return (
    <PrintPortal title="Reservations report" subtitle={`${formatDayLabel(from)} to ${formatDayLabel(to)} · ${villaLabel}`} onClose={onClose} maxWidthClass="max-w-5xl">
      <PrintLetterhead
        documentTitle="Guest Reservations Report"
        meta={`Period ${formatDayLabel(from)} to ${formatDayLabel(to)} · ${villaLabel}`}
        generatedBy={generatedBy}
      />

      {rows.length === 0 ? (
        <p className="text-xs italic text-slate-500">No reservations have a night in this period{unit ? ` at ${villaLabel}` : ''}.</p>
      ) : (
        <>
          <TableScroller>
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="font-mono text-[9px] uppercase text-slate-600">
                  <th className="p-2">Villa</th>
                  <th className="p-2">Guest</th>
                  <th className="p-2">Arrival</th>
                  <th className="p-2">Departure</th>
                  <th className="p-2 text-right">Nights</th>
                  <th className="p-2">Channel</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Stay value</th>
                  <th className="p-2 text-right">Paid</th>
                  <th className="p-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map(b => (
                  <tr key={b.id} className={b.status === 'cancelled' ? 'text-slate-500 line-through' : ''}>
                    <td className="p-2 font-bold">{getUnitDisplayName(b.unitNumber)}</td>
                    <td className="p-2 font-sans">
                      <span className="font-semibold">{b.guestName}</span>
                      {b.guestEmail && <span className="block text-[9px] text-slate-500">{b.guestEmail}</span>}
                    </td>
                    <td className="p-2">{formatDayLabel(b.checkIn)}</td>
                    <td className="p-2">{formatDayLabel(b.checkOut)}</td>
                    <td className="p-2 text-right">{nightsBetween(b.checkIn, b.checkOut)}</td>
                    <td className="p-2">{b.source}</td>
                    <td className="p-2 uppercase">{b.status}</td>
                    <td className="p-2 text-right font-semibold">{formatMoney(b.amount, b.currency)}</td>
                    <td className="p-2 text-right">{formatMoney(stayMoney(b, payments).paid, b.currency)}</td>
                    <td className="p-2 text-right font-semibold">{formatMoney(stayMoney(b, payments).balance, b.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>

          <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(['USD', 'JMD'] as Currency[])
              .filter(c => totals[c].value > 0 || totals[c].deposit > 0 || totals[c].compNights > 0)
              .map(c => (
                <dl key={c} className="space-y-1 rounded-xl border border-slate-300 p-3 text-xs">
                  <p className="mb-1 font-mono text-[9px] font-bold uppercase text-slate-500">{c} totals (excludes cancelled and closed dates)</p>
                  <div className="flex justify-between gap-3">
                    <dt>Nights sold in the period</dt>
                    <dd className="font-mono font-semibold">{totals[c].nights}</dd>
                  </div>
                  {totals[c].compNights > 0 && (
                    <div className="flex justify-between gap-3">
                      <dt>Complimentary nights in the period (not sold)</dt>
                      <dd className="font-mono font-semibold">{totals[c].compNights}</dd>
                    </div>
                  )}
                  <div className="flex justify-between gap-3">
                    <dt>{totals[c].spanning > 0 ? `Stay value for nights in the period (${totals[c].spanning} stay(s) spanning the period prorated by night)` : 'Stay value'}</dt>
                    <dd className="font-mono font-semibold">{formatMoney(totals[c].value, c)}</dd>
                  </div>
                  {totals[c].spanning > 0 && (
                    <div className="flex justify-between gap-3">
                      <dt>Full value of these stays</dt>
                      <dd className="font-mono font-semibold">{formatMoney(totals[c].fullValue, c)}</dd>
                    </div>
                  )}
                  <div className="flex justify-between gap-3">
                    <dt>Paid on these stays, net of refunds</dt>
                    <dd className="font-mono font-semibold">{formatMoney(totals[c].deposit, c)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-slate-300 pt-1 font-bold">
                    <dt>Balance outstanding on these stays</dt>
                    <dd className="font-mono">{formatMoney(totals[c].balance, c)}</dd>
                  </div>
                </dl>
              ))}
          </section>
        </>
      )}

      <p className="mt-8 border-t border-slate-300 pt-3 text-center font-mono text-[9px] uppercase text-slate-500">
        Confidential, Villaggio Del Sol reservations ledger
      </p>
    </PrintPortal>
  );
}
