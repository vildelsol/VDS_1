/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { AppSettings, Booking, Currency, SessionUser, Unit, getUnitDisplayName } from '../types';
import { BookingClash, bookingCoversNight, bookingOverlaps, bookingsForUnit, bookingsOverlap } from '../lib/finance';
import { formatMoney, formatMoneyLong, round2 } from '../lib/money';
import { addMonths, currentMonth, formatDayLabel, formatMonthLabel, monthEnd, monthStart, nightsBetween, parseDay, today } from '../lib/dates';
import { errorMessage } from '../lib/api';
import { buildStayReceiptEmail, openMailDraft } from '../lib/email';
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
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, Lock, Mail, Plus, Printer, RefreshCw, Search, ShieldCheck } from 'lucide-react';

interface BookingsProps {
  units: Unit[];
  bookings: Booking[];
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
  settings,
  session,
  onAddBooking,
  onUpdateBooking,
  onSyncCalendars,
  onHoldDamageDeposit,
  onSettleDamageDeposit
}: BookingsProps) {
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [month, setMonth] = useState(currentMonth());
  const [adding, setAdding] = useState<{ unitId?: string; checkIn?: string } | null>(null);
  const [editing, setEditing] = useState<Booking | null>(null);
  const [printing, setPrinting] = useState<{ from: string; to: string } | null>(null);
  const [receiptBooking, setReceiptBooking] = useState<Booking | null>(null);
  const [depositBooking, setDepositBooking] = useState<Booking | null>(null);
  const [showPrintOptions, setShowPrintOptions] = useState(false);
  const [printFrom, setPrintFrom] = useState(monthStart(currentMonth()));
  const [printTo, setPrintTo] = useState(monthEnd(currentMonth()));
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [syncing, setSyncing] = useState(false);

  const perms = session.permissions;
  const canAdd = !!perms.addBookings;
  const canEdit = !!perms.editBookings;
  const canHoldDeposit = !!perms.recordPayments;
  const canSettleDeposit = !!perms.reversePayments;

  const sortedUnits = useMemo(
    () => [...units].sort((a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0) || a.number.localeCompare(b.number)),
    [units]
  );

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
        setError(failed.map(f => `${f.unitNumber} (${f.source}): ${f.error}`).join(' — '));
      }
    } catch (err) {
      setError(errorMessage(err, 'Calendar sync failed.'));
    } finally {
      setSyncing(false);
    }
  };

  /* ---------------- list ---------------- */

  const [listFilter, setListFilter] = useState<'all' | Booking['status']>('all');
  const listRows = useMemo(
    () =>
      bookings
        .filter(b => listFilter === 'all' || b.status === listFilter)
        .sort((a, b) => b.checkIn.localeCompare(a.checkIn)),
    [bookings, listFilter]
  );

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}

      {overlapWarnings.length > 0 && (
        <div role="alert" className="space-y-2 rounded-2xl border-2 border-red-200 bg-red-50 p-4 text-xs text-red-800">
          <p className="flex items-center gap-1.5 font-semibold">
            <AlertCircle className="h-4 w-4 text-red-600" />
            {overlapWarnings.length} overlapping reservation{overlapWarnings.length === 1 ? '' : 's'} detected — resolve to avoid a double-booking
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
                {sortedUnits.map(u => (
                  <option key={u.id} value={u.id}>
                    {getUnitDisplayName(u.number)} — {u.status}
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
                  Platform feeds publish dates only — never guest contact details or pricing — so imported stays need a
                  stay value entered manually.
                  {activeFeeds[0].lastSyncAt && (
                    <> Last synchronised {formatDayLabel(activeFeeds[0].lastSyncAt.substring(0, 10))}.</>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col items-start justify-between gap-3 pt-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-1.5">
              <button type="button" onClick={() => setMonth(addMonths(month, -1))} className="rounded-lg p-1 text-slate-600 hover:bg-slate-200" aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="w-32 text-center font-mono text-xs font-bold text-slate-700">{formatMonthLabel(month)}</span>
              <button type="button" onClick={() => setMonth(addMonths(month, 1))} className="rounded-lg p-1 text-slate-600 hover:bg-slate-200" aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </button>
              {month !== currentMonth() && (
                <button type="button" onClick={() => setMonth(currentMonth())} className="ml-1 text-[10px] font-medium text-teal-700 underline">
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
              <SecondaryButton onClick={() => setShowPrintOptions(v => !v)} className="flex items-center gap-1.5">
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
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
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
                    setPrinting({ from: printFrom, to: printTo });
                    setShowPrintOptions(false);
                  }}
                >
                  <Printer className="h-3.5 w-3.5" /> Open print preview
                </SubmitButton>
              </div>
              <p className="text-[11px] text-amber-800">
                Any stay that overlaps the range is included, whether or not it starts inside it.
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
                {sortedUnits.map(unit => (
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
                                ? `${booking.guestName} — ${formatDayLabel(booking.checkIn)} to ${formatDayLabel(booking.checkOut)} (${booking.source})`
                                : blocked
                                  ? `${getUnitDisplayName(unit.number)} is ${unit.status} and not available for short stays`
                                  : `Create a reservation for ${getUnitDisplayName(unit.number)} arriving ${formatDayLabel(dayKey(day))}`
                            }
                            onClick={() => {
                              if (booking) {
                                if (canEdit) setEditing(booking);
                                else setError('Your role is not permitted to modify reservations.');
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
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 p-4">
            <span className="font-mono text-xs text-slate-500">{listRows.length} reservation(s)</span>
            <select value={listFilter} onChange={e => setListFilter(e.target.value as typeof listFilter)} className="rounded-lg border border-slate-200 p-1.5 text-xs">
              <option value="all">All statuses</option>
              <option value="confirmed">Confirmed</option>
              <option value="checked-in">Checked in</option>
              <option value="checked-out">Checked out</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          {listRows.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No reservations match this filter" />
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
                    <th scope="col" className="p-3 text-right">Deposit</th>
                    <th scope="col" className="p-3 text-right">Balance</th>
                    <th scope="col" className="p-3">Status</th>
                    <th scope="col" className="p-3">Damage held</th>
                    <th scope="col" className="p-3 text-right">Receipt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {listRows.map(b => (
                    <tr
                      key={b.id}
                      onClick={() => (canEdit ? setEditing(b) : undefined)}
                      className={`${canEdit ? 'cursor-pointer' : ''} transition-colors hover:bg-slate-50/60 ${b.status === 'cancelled' ? 'text-slate-400' : ''}`}
                    >
                      <td className="p-3 font-mono font-semibold">{getUnitDisplayName(b.unitNumber)}</td>
                      <td className="p-3">
                        <p className="font-medium text-slate-900">{b.guestName}</p>
                        {(b.guestEmail || b.guestPhone) && (
                          <p className="text-[10px] text-slate-400">{[b.guestEmail, b.guestPhone].filter(Boolean).join(' • ')}</p>
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
                      <td className="p-3 text-right font-mono">{formatMoney(b.amount, b.currency)}</td>
                      <td className="p-3 text-right font-mono text-emerald-600">{formatMoney(b.depositPaid, b.currency)}</td>
                      <td className="p-3 text-right font-mono font-semibold text-amber-600">{formatMoney(b.balanceDue, b.currency)}</td>
                      <td className="p-3">
                        <Badge tone={b.status === 'checked-in' ? 'green' : b.status === 'confirmed' ? 'blue' : b.status === 'cancelled' ? 'red' : 'slate'}>{b.status}</Badge>
                      </td>
                      {/* Optional throughout. Most stays take no damage deposit,
                          so this column is blank for them and nothing asks. */}
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <DamageDepositCell
                          booking={b}
                          canHold={canHoldDeposit}
                          canSettle={canSettleDeposit}
                          onOpen={() => setDepositBooking(b)}
                        />
                      </td>
                      <td className="p-3 text-right" onClick={e => e.stopPropagation()}>
                        {b.status !== 'cancelled' && (
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
                  ))}
                </tbody>
              </table>
            </TableScroller>
          )}
        </section>
      )}

      {adding && (
        <BookingForm
          mode="create"
          units={sortedUnits}
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

      {editing && (
        <BookingForm
          mode="edit"
          units={sortedUnits}
          bookings={bookings}
          booking={editing}
          canCancel={!!perms.cancelBookings}
          onClose={() => setEditing(null)}
          onSubmit={async payload => {
            await onUpdateBooking(editing.id, payload);
            setSuccess('Reservation updated.');
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
          from={printing.from}
          to={printing.to}
          generatedBy={session.name}
          onClose={() => setPrinting(null)}
        />
      )}

      {receiptBooking && (
        <GuestStayReceipt
          booking={receiptBooking}
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
function GuestStayReceipt({
  booking,
  unit,
  generatedBy,
  onClose
}: {
  booking: Booking;
  unit: Unit | undefined;
  generatedBy: string;
  onClose: () => void;
}) {
  const villa = unit ? getUnitDisplayName(unit.number) : `Unit ${booking.unitNumber}`;
  const nights = nightsBetween(booking.checkIn, booking.checkOut);
  const paidInFull = booking.balanceDue <= 0;

  return (
    <PrintPortal
      title={`Guest receipt — ${booking.guestName}`}
      subtitle={`${villa} · ${formatDayLabel(booking.checkIn)} to ${formatDayLabel(booking.checkOut)}`}
      onClose={onClose}
      maxWidthClass="max-w-md"
      actions={
        <button
          type="button"
          onClick={() => openMailDraft(buildStayReceiptEmail(booking, unit))}
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
        documentTitle={paidInFull ? 'Guest Stay Receipt' : 'Guest Stay Confirmation'}
        meta={villa}
        generatedBy={generatedBy}
      />

      <p className="mb-4 text-xs text-slate-700">
        Dear {booking.guestName}, thank you for choosing Villaggio Del Sol. Your reservation details are confirmed below.
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

      <div className="mt-4 space-y-1.5 rounded-xl border border-slate-300 bg-slate-50 p-4 font-mono text-xs">
        <div className="flex justify-between">
          <span className="text-slate-600">Stay total</span>
          <span className="font-semibold">{formatMoneyLong(booking.amount, booking.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-600">Deposit / paid</span>
          <span className="font-semibold text-emerald-700">{formatMoneyLong(booking.depositPaid, booking.currency)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-300 pt-1.5 text-sm">
          <span className="font-semibold">{paidInFull ? 'Balance' : 'Balance due on arrival'}</span>
          <span className={`font-bold ${paidInFull ? 'text-emerald-700' : 'text-amber-700'}`}>
            {formatMoneyLong(booking.balanceDue, booking.currency)}
          </span>
        </div>
      </div>

      {paidInFull ? (
        <p className="print-emphasis mt-4 rounded-lg border border-emerald-500 bg-emerald-50 py-1.5 text-center text-xs font-bold uppercase tracking-widest text-emerald-800">
          Paid in full
        </p>
      ) : (
        <p className="mt-4 text-center text-[11px] text-slate-500">
          The balance shown is payable on arrival. Amounts are in {booking.currency}.
        </p>
      )}

      <PrintSignatures left="Villaggio Del Sol" right="Guest signature" />

      <p className="mt-5 border-t border-dashed border-slate-300 pt-2 text-center font-mono text-[9px] uppercase text-slate-400">
        Villaggio Del Sol · Ocho Rios, Jamaica · we look forward to welcoming you
      </p>
    </PrintPortal>
  );
}

/* ------------------------------------------------------------------ */

function BookingForm({
  mode,
  units,
  bookings,
  booking,
  initialUnitId,
  initialCheckIn,
  canCancel = true,
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
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const bookableUnits = units.filter(u => u.status !== 'unavailable' && u.status !== 'long-term');
  const [unitId, setUnitId] = useState(booking?.unitId || initialUnitId || bookableUnits[0]?.id || '');
  const [guestName, setGuestName] = useState(booking?.guestName || '');
  const [guestEmail, setGuestEmail] = useState(booking?.guestEmail || '');
  const [guestPhone, setGuestPhone] = useState(booking?.guestPhone || '');
  const [checkIn, setCheckIn] = useState(booking?.checkIn || initialCheckIn || '');
  const [checkOut, setCheckOut] = useState(booking?.checkOut || '');
  const [source, setSource] = useState<Booking['source']>(booking?.source || 'Direct');
  const [status, setStatus] = useState<Booking['status']>(booking?.status || 'confirmed');
  const [currency, setCurrency] = useState<Currency>(booking?.currency || 'USD');
  const [nightlyRate, setNightlyRate] = useState(booking?.nightlyRate ? String(booking.nightlyRate) : '');
  const [amount, setAmount] = useState(booking ? String(booking.amount) : '');
  const [deposit, setDeposit] = useState(booking ? String(booking.depositPaid) : '');
  const [notes, setNotes] = useState(booking?.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const unit = units.find(u => u.id === unitId);
  const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : 0;

  // Default the currency to the villa's own when creating.
  React.useEffect(() => {
    if (mode === 'create' && unit) setCurrency(unit.currency);
  }, [unitId, mode, unit]);

  // Derive the stay value from rate × nights, but never silently overwrite a
  // figure the user typed themselves.
  const [amountTouched, setAmountTouched] = useState(false);
  React.useEffect(() => {
    if (amountTouched) return;
    if (nights > 0 && Number(nightlyRate) > 0) setAmount(String(round2(Number(nightlyRate) * nights)));
  }, [nights, nightlyRate, amountTouched]);

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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (checkOut <= checkIn) {
      setError('The departure date must be after the arrival date.');
      return;
    }
    if (Number(deposit) > Number(amount)) {
      setError('The deposit cannot exceed the total stay value.');
      return;
    }
    if (clash && status !== 'cancelled') {
      setError(`Those dates clash with ${clash.guestName} (${formatDayLabel(clash.checkIn)} to ${formatDayLabel(clash.checkOut)}).`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        unitId,
        guestName,
        guestEmail,
        guestPhone,
        checkIn,
        checkOut,
        source,
        status,
        currency,
        nightlyRate: nightlyRate === '' ? undefined : Number(nightlyRate),
        amount: Number(amount) || 0,
        depositPaid: Number(deposit) || 0,
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
      title={mode === 'create' ? 'New guest reservation' : `Reservation — ${booking?.guestName}`}
      subtitle={unit ? getUnitDisplayName(unit.number) : undefined}
      onClose={onClose}
      maxWidthClass="max-w-lg"
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Saving…" form="vds-booking-form" className="flex-1">
            {mode === 'create' ? 'Save reservation' : 'Save changes'}
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
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

        <div className="grid grid-cols-3 gap-3">
          <Field label="Nightly rate" htmlFor="bf-rate">
            <input id="bf-rate" type="number" min="0" step="0.01" value={nightlyRate} onChange={e => setNightlyRate(e.target.value)} className={monoInputClass} />
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

        {cancelling && (Number(deposit) > 0 || (booking?.depositPaid || 0) > 0) && (
          <InfoNote tone="amber">
            Cancelling voids the deposit receipt for this reservation. The receipt stays in the ledger marked VOID, with
            the reason recorded — it is not deleted.
          </InfoNote>
        )}

        {booking?.status === 'cancelled' && <InfoNote>This reservation is cancelled and cannot be reinstated. Create a new one instead.</InfoNote>}

        <Field label="Notes" htmlFor="bf-notes">
          <textarea id="bf-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
        </Field>
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

  if (!canHold || booking.status === 'cancelled') return <span className="text-[10px] text-slate-300">—</span>;

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
            {getUnitDisplayName(booking.unitNumber)} — {booking.guestName}
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
                Keeping this money is not income. If it is covering a real cost — a broken door, a replaced mattress — record that cost as an
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

function ReservationsReport({
  bookings,
  from,
  to,
  generatedBy,
  onClose
}: {
  bookings: Booking[];
  from: string;
  to: string;
  generatedBy: string;
  onClose: () => void;
}) {
  // Include any stay that overlaps the range, not only those starting inside it.
  const rows = bookings
    .filter(b => b.checkIn <= to && b.checkOut >= from)
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.unitNumber.localeCompare(b.unitNumber));

  const totals = rows.reduce<Record<Currency, { value: number; deposit: number; balance: number; nights: number }>>(
    (acc, b) => {
      if (b.status === 'cancelled') return acc;
      acc[b.currency].value = round2(acc[b.currency].value + b.amount);
      acc[b.currency].deposit = round2(acc[b.currency].deposit + b.depositPaid);
      acc[b.currency].balance = round2(acc[b.currency].balance + b.balanceDue);
      acc[b.currency].nights += nightsBetween(b.checkIn, b.checkOut);
      return acc;
    },
    { USD: { value: 0, deposit: 0, balance: 0, nights: 0 }, JMD: { value: 0, deposit: 0, balance: 0, nights: 0 } }
  );

  return (
    <PrintPortal title="Reservations report" subtitle={`${formatDayLabel(from)} to ${formatDayLabel(to)}`} onClose={onClose} maxWidthClass="max-w-5xl">
      <PrintLetterhead
        documentTitle="Guest Reservations Report"
        meta={`Period ${formatDayLabel(from)} — ${formatDayLabel(to)}`}
        generatedBy={generatedBy}
      />

      {rows.length === 0 ? (
        <p className="text-xs italic text-slate-500">No reservations overlap this period.</p>
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
                  <th className="p-2 text-right">Deposit</th>
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
                    <td className="p-2 text-right">{formatMoney(b.depositPaid, b.currency)}</td>
                    <td className="p-2 text-right font-semibold">{formatMoney(b.balanceDue, b.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>

          <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(['USD', 'JMD'] as Currency[])
              .filter(c => totals[c].value > 0 || totals[c].deposit > 0)
              .map(c => (
                <dl key={c} className="space-y-1 rounded-xl border border-slate-300 p-3 text-xs">
                  <p className="mb-1 font-mono text-[9px] font-bold uppercase text-slate-500">{c} totals (excludes cancelled)</p>
                  <div className="flex justify-between gap-3">
                    <dt>Nights sold</dt>
                    <dd className="font-mono font-semibold">{totals[c].nights}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Stay value</dt>
                    <dd className="font-mono font-semibold">{formatMoney(totals[c].value, c)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Deposits received</dt>
                    <dd className="font-mono font-semibold">{formatMoney(totals[c].deposit, c)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-slate-300 pt-1 font-bold">
                    <dt>Balance outstanding</dt>
                    <dd className="font-mono">{formatMoney(totals[c].balance, c)}</dd>
                  </div>
                </dl>
              ))}
          </section>
        </>
      )}

      <p className="mt-8 border-t border-slate-300 pt-3 text-center font-mono text-[9px] uppercase text-slate-500">
        Confidential — Villaggio Del Sol reservations ledger
      </p>
    </PrintPortal>
  );
}
