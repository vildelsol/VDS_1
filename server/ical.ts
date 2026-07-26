/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal but correct iCalendar (RFC 5545) reader for booking-platform exports.
 *
 * The dashboard previously "synced" by running a setTimeout and printing invented
 * log lines such as "Detected 2 upcoming external reservations" — nothing was ever
 * fetched. This module actually retrieves the feed and parses it.
 *
 * Airbnb/Booking.com/VRBO exports use all-day VEVENTs with DTEND exclusive, which
 * matches the checkout convention used throughout this application.
 */

import dns from 'dns';
import net from 'net';

export interface ICalEvent {
  uid: string;
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, exclusive (checkout day)
  summary: string;
  description: string;
}

/** Unfold RFC 5545 continuation lines (a leading space or tab continues the previous line). */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Convert an iCal date value to a plain YYYY-MM-DD day.
 * Handles DATE (20260715), DATE-TIME floating/local (20260715T140000) and UTC
 * (20260715T190000Z). For UTC date-times the instant is converted to the
 * property's local day so a 19:00Z checkout does not land on the wrong date.
 */
function toDay(value: string, tzOffsetMinutes: number): string | null {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!dateTime) return null;
  const [, y, mo, d, h, mi, s, z] = dateTime;
  if (!z) return `${y}-${mo}-${d}`;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const local = new Date(utc + tzOffsetMinutes * 60000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(
    local.getUTCDate()
  ).padStart(2, '0')}`;
}

export function parseICal(text: string, tzOffsetMinutes = -5 * 60): ICalEvent[] {
  const lines = unfold(text);
  const events: ICalEvent[] = [];
  let current: Partial<ICalEvent> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      if (current && current.uid && current.start && current.end) {
        events.push({
          uid: current.uid,
          start: current.start,
          end: current.end,
          summary: current.summary || '',
          description: current.description || ''
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const sep = trimmed.indexOf(':');
    if (sep === -1) continue;
    const namePart = trimmed.slice(0, sep);
    const value = trimmed.slice(sep + 1);
    const name = namePart.split(';')[0].toUpperCase();

    switch (name) {
      case 'UID':
        current.uid = value.trim();
        break;
      case 'DTSTART': {
        const day = toDay(value, tzOffsetMinutes);
        if (day) current.start = day;
        break;
      }
      case 'DTEND': {
        const day = toDay(value, tzOffsetMinutes);
        if (day) current.end = day;
        break;
      }
      case 'SUMMARY':
        current.summary = unescapeText(value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(value);
        break;
      default:
        break;
    }
  }

  return events;
}

/**
 * Platform exports label blocks in different ways. "Not available" / "Blocked"
 * entries are owner blocks rather than paying guests, and are imported as holds.
 */
export function classifyEvent(event: ICalEvent): { isReservation: boolean; guestName: string } {
  const summary = (event.summary || '').trim();
  const lower = summary.toLowerCase();
  const isBlock =
    lower.includes('not available') ||
    lower.includes('unavailable') ||
    lower.includes('blocked') ||
    lower === 'busy' ||
    lower === '';
  if (isBlock) return { isReservation: false, guestName: summary || 'External block' };

  // Airbnb uses "Reserved - John D." or just "Reserved".
  const reserved = /^reserved\s*[-–]\s*(.+)$/i.exec(summary);
  if (reserved) return { isReservation: true, guestName: reserved[1].trim() };
  if (lower === 'reserved') return { isReservation: true, guestName: 'External guest' };
  return { isReservation: true, guestName: summary };
}

export interface FetchResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Is this a private, loopback or otherwise internal address?
 *
 * A calendar feed is a public URL at Airbnb or Booking.com. Nothing legitimate
 * points at the machine itself, at another box on the property LAN, or at a cloud
 * metadata service — but the server fetched whatever address it was given, which
 * turned the feed setting into a way to probe the internal network from outside it
 * and read the answer back off the sync result. Anything not on the public
 * internet is refused.
 */
function isInternalAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — this is Tailscale's range
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (v === '::1' || v === '::') return true;
    if (/^f[cd]/.test(v)) return true; // unique local
    if (v.startsWith('fe80')) return true; // link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isInternalAddress(mapped[1]);
    return false;
  }
  return true; // an address in no form we recognise is not one we will call
}

/**
 * Refuse a feed host that resolves anywhere internal.
 *
 * Note the limit: the name is resolved here and again by fetch, so a name that
 * answers differently between the two calls could still slip through. Closing that
 * needs the connection pinned to the address that was checked. For a setting only
 * an administrator or manager can reach, refusing the obvious cases is the
 * proportionate control; it is written down here so it is not mistaken for
 * airtight.
 */
async function assertExternalHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isInternalAddress(bare)) throw new Error(`${hostname} is an internal address.`);
    return;
  }
  let records: { address: string }[];
  try {
    records = await dns.promises.lookup(bare, { all: true });
  } catch {
    throw new Error(`${hostname} could not be resolved.`);
  }
  if (records.length === 0) throw new Error(`${hostname} could not be resolved.`);
  for (const record of records) {
    if (isInternalAddress(record.address)) throw new Error(`${hostname} resolves to the internal address ${record.address}.`);
  }
}

/** Validate a feed URL before it is stored, so a bad one is refused at the point of entry. */
export async function assertFetchableFeedUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The feed URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Feed URL must start with http:// or https://');
  }
  await assertExternalHost(parsed.hostname);
}

const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** Fetch a feed with a hard timeout so a hanging host cannot wedge the request. */
export async function fetchICal(url: string, timeoutMs = 15000): Promise<FetchResult> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { ok: false, error: 'The feed URL is not a valid URL.' };
  }
  if (current.protocol !== 'https:' && current.protocol !== 'http:') {
    return { ok: false, error: 'Feed URL must start with http:// or https://' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Redirects are followed by hand so every hop is checked. Letting fetch follow
    // them meant a public URL could bounce the request to an internal one.
    for (let hop = 0; ; hop++) {
      await assertExternalHost(current.hostname);

      const res = await fetch(current.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'text/calendar, text/plain, */*' }
      });

      if (REDIRECT_CODES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) return { ok: false, error: `Feed responded with HTTP ${res.status} but gave no destination.` };
        if (hop >= MAX_REDIRECTS) return { ok: false, error: `Feed redirected more than ${MAX_REDIRECTS} times.` };
        const next = new URL(location, current);
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          return { ok: false, error: 'The feed redirected to an address that is not http or https.' };
        }
        current = next;
        continue;
      }

      if (!res.ok) {
        return { ok: false, error: `Feed responded with HTTP ${res.status} ${res.statusText}.` };
      }
      const text = await res.text();
      if (!text.includes('BEGIN:VCALENDAR')) {
        return { ok: false, error: 'The URL did not return an iCalendar document.' };
      }
      return { ok: true, text };
    }
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? `Timed out after ${timeoutMs / 1000}s.` : (err as Error).message;
    return { ok: false, error: `Could not reach the feed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
