/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Date helpers that work in the property's local calendar.
 *
 * Every stored date is a plain YYYY-MM-DD calendar day with no time or zone.
 * `new Date('2026-07-01')` parses as UTC midnight, which renders as June 30 in
 * Jamaica (UTC-5); `new Date(2026, 6, 1).toISOString()` shifts the other way in
 * eastern zones. Both mistakes were present in the original code, so all date
 * maths here is done on the date string or on local-noon Date objects, which are
 * immune to a whole-day shift in either direction.
 */

/**
 * Split YYYY-MM-DD into a real calendar day, or null when it is not one.
 *
 * The shape of the string is not enough. `new Date(2026, 1, 31)` does not fail on
 * 31 February — it rolls forward to 3 March — so a typo of "2026-02-31" used to
 * pass validation, get stored verbatim, and then silently mean a different day in
 * every calculation that touched it. A day the month does not have is rejected
 * here instead.
 */
function calendarParts(iso: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1) return null;
  // Day 0 of the following month is the last day of this one.
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  if (day > lastDayOfMonth) return null;
  return { year, month, day };
}

/** Parse YYYY-MM-DD to a Date at local noon, so no timezone can move it to another day. */
export function parseDay(iso: string): Date {
  const parts = calendarParts(iso);
  if (!parts) return new Date(NaN);
  return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0);
}

/** Format a Date as a local YYYY-MM-DD calendar day. */
export function toDayString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today as YYYY-MM-DD in local time. */
export function today(): string {
  return toDayString(new Date());
}

/** Current month as YYYY-MM in local time. */
export function currentMonth(): string {
  return today().substring(0, 7);
}

/** The YYYY-MM a given YYYY-MM-DD belongs to. */
export function monthOf(day: string): string {
  return String(day || '').substring(0, 7);
}

/** First calendar day of a YYYY-MM month. */
export function monthStart(month: string): string {
  return `${month}-01`;
}

/** Last calendar day of a YYYY-MM month. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** Add whole months to a YYYY-MM key. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Add whole days to a YYYY-MM-DD key. */
export function addDays(day: string, delta: number): string {
  const d = parseDay(day);
  d.setDate(d.getDate() + delta);
  return toDayString(d);
}

/** Inclusive list of YYYY-MM keys spanning two calendar days. */
export function monthsBetween(startDay: string, endDay: string): string[] {
  const months: string[] = [];
  let cursor = monthOf(startDay);
  const last = monthOf(endDay);
  let guard = 0;
  while (cursor <= last && guard < 600) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
    guard++;
  }
  return months;
}

/** Whole nights between arrival and departure. Departure day is not a night. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = parseDay(checkIn);
  const b = parseDay(checkOut);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));
}

/** Whole days from `day` until today. Negative when the day is in the future. */
export function daysSince(day: string): number {
  const d = parseDay(day);
  if (isNaN(d.getTime())) return 0;
  const now = parseDay(today());
  return Math.round((now.getTime() - d.getTime()) / 86400000);
}

/** Inclusive string range test for plain calendar days. */
export function isWithin(day: string, start: string, end: string): boolean {
  if (!day) return false;
  if (start && day < start) return false;
  if (end && day > end) return false;
  return true;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/** "July 2026" from "2026-07". */
export function formatMonthLabel(month: string): string {
  const [y, m] = String(month || '').split('-').map(Number);
  if (!y || !m) return month || '';
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** "15 Jul 2026" from "2026-07-15" — unambiguous on printed documents. */
export function formatDayLabel(day: string): string {
  const d = parseDay(day);
  if (isNaN(d.getTime())) return day || '';
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()].substring(0, 3)} ${d.getFullYear()}`;
}

export function isValidDay(day: string): boolean {
  return calendarParts(day) !== null;
}

export function isValidMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''));
}

/** Clamp a due-day-of-month (1-31) to a month that may be shorter. */
export function dueDateForMonth(month: string, dueDay: number): string {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const day = Math.min(Math.max(Number(dueDay) || 1, 1), lastDay);
  return `${month}-${String(day).padStart(2, '0')}`;
}
