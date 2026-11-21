/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Putting the records back from a backup or a downloaded snapshot.
 *
 * The rule: **a restore replaces the records, never the accounts.** Whoever is
 * signed in stays signed in, every current staff account keeps its current
 * password, and nobody is locked out by going back in time. Two things follow:
 *
 *  - A downloaded snapshot carries no password hashes on purpose (it leaves the
 *    machine), so it could never restore accounts anyway.
 *  - Going back to last month must not also put last month's passwords back.
 *
 * Staff who exist in the file but not on this machine are reported, not
 * recreated, because the file cannot give them a password. An administrator
 * creates them again under Staff.
 *
 * The backup-location settings are kept too: restoring must never unplug the
 * drive the backups are written to.
 */

import type { Database } from './db';

export const RESTORED_TABLES = [
  'units',
  'ownerships',
  'tenancies',
  'bookings',
  'charges',
  'payments',
  'utilities',
  'expenses',
  'recurringExpenses',
  'annualReports',
  'auditLogs',
  'unitActivities'
] as const;

/**
 * Settings that are policy about who may do what and which months are closed, not
 * records. A restore must never roll them back: it would silently re-grant a
 * privilege withdrawn since the backup, or reopen a period already closed.
 * `closedThrough` only ever moves forward on a restore.
 */
export const PROTECTED_SETTINGS = ['rolePermissions', 'requireCosign', 'closedThrough'] as const;

const isEmptySetting = (v: unknown) => v === undefined || v === null || v === '';

/** Tables a usable file must carry. The rest may be absent from an older file. */
const REQUIRED_TABLES = ['units', 'charges', 'payments'] as const;

export interface RestoreSummary {
  /** When the file was made, as far as it says. */
  madeAt: string;
  schemaVersion: number;
  counts: Record<string, number>;
  /** Usernames in the file that have no account on this machine. */
  staffNotRecreated: string[];
  /** Records that exist now but are NOT in the file, so a restore would remove them. */
  willBeRemoved: { payments: number; charges: number; expenses: number };
  /** Control settings the restore leaves exactly as they are now (permissions, closed periods, co-signing). */
  settingsKeptAsTheyAre: string[];
  /** Settings that are empty now and will be filled in from the file. Anything already set keeps today's value. */
  settingsThatWillChange: string[];
}

export class RestoreRefused extends Error {}

type Raw = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * Row-by-row validation. A file that is well-formed JSON with the right tables can still hold a date that is an
 * object, an amount that is text, a currency that is not ours or a record with no id. Restoring replaces the books,
 * so every row of every table is checked BEFORE anything is replaced and the refusal lists what is wrong.
 * ------------------------------------------------------------------ */

interface Schema {
  /** Present and a non-empty text. */
  strings?: string[];
  /** Present and a real calendar day (YYYY-MM-DD). */
  days?: string[];
  /** A real calendar day if there is a value at all (empty, null and absent are fine). */
  optDays?: string[];
  months?: string[];
  optMonths?: string[];
  /** Present and a finite number. */
  nums?: string[];
  /** A finite number if there is a value at all. */
  optNums?: string[];
  currencies?: string[];
  optCurrencies?: string[];
  enums?: Record<string, string[]>;
}

const SCHEMAS: Record<string, Schema> = {
  units: { strings: ['id', 'number'], optNums: ['monthlyRent', 'monthlyMaintenance', 'entitlement'], optCurrencies: ['currency', 'maintCurrency'] },
  ownerships: { strings: ['id', 'unitId'], optDays: ['startedOn', 'endedOn'] },
  tenancies: {
    strings: ['id', 'unitId'],
    optNums: ['monthlyRent', 'depositAmount', 'depositReturnedAmount', 'depositWithheldAmount', 'writeOffAmount'],
    optCurrencies: ['currency', 'depositCurrency', 'writeOffCurrency'],
    optDays: ['leaseEndsOn', 'endedOn', 'depositReceivedOn', 'depositReturnedOn', 'advanceRentAppliedOn']
  },
  bookings: {
    strings: ['id', 'unitId'],
    days: ['checkIn', 'checkOut'],
    optNums: ['amount', 'nightlyRate', 'depositPaid', 'balanceDue', 'damageDepositAmount', 'damageDepositReturnedAmount', 'damageDepositWithheldAmount'],
    optCurrencies: ['currency', 'damageDepositCurrency'],
    optDays: ['depositReceivedOn', 'damageDepositReceivedOn', 'damageDepositReturnedOn']
  },
  charges: { strings: ['id', 'unitId'], months: ['periodMonth'], days: ['dueDate'], nums: ['amount'], optNums: ['rentPortion', 'maintenancePortion'], currencies: ['currency'], optMonths: ['paysForMonth'] },
  payments: {
    strings: ['id', 'unitId'],
    days: ['date'],
    nums: ['amount'],
    optNums: ['refundedAmount', 'printCount'],
    currencies: ['currency'],
    optDays: ['refundedOn', 'reconciledOn', 'reversalDate'],
    enums: { status: ['completed', 'pending', 'reversed'] }
  },
  utilities: { strings: ['id', 'unitId'], optNums: ['previousReading', 'currentReading', 'consumption', 'amountCharged', 'amountBeforeRefund'], optCurrencies: ['currency'], optMonths: ['billingPeriod'] },
  expenses: { strings: ['id'], days: ['date'], nums: ['amount'], currencies: ['currency'], optDays: ['invoiceDate', 'dueDate', 'datePaid'], enums: { status: ['paid', 'pending', 'void'] } },
  recurringExpenses: { strings: ['id'], nums: ['amount'], currencies: ['currency'], optNums: ['dueDay'] },
  annualReports: { optNums: ['year', 'proposedFee'], optCurrencies: ['currency'] },
  unitActivities: { strings: ['id'], optNums: ['costAmount'], optCurrencies: ['costCurrency'], optDays: ['completedOn'] }
};

/** A real calendar day, written out: not a date that merely looks like one ("2026-13-99"). */
function realDay(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
const realMonth = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const isCurrency = (v: unknown): boolean => v === 'JMD' || v === 'USD';
const isFiniteNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const hasValue = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/** Everything wrong with the rows of a file, in plain words (at most `limit` of them). */
export function restoreRowProblems(file: Raw, limit = 25): string[] {
  const problems: string[] = [];
  const add = (table: string, i: number, row: Raw, what: string) => {
    if (problems.length < limit) problems.push(`${table} record ${i + 1}${row.id ? ` (${String(row.id).slice(0, 40)})` : ''}: ${what}`);
  };
  for (const [table, schema] of Object.entries(SCHEMAS)) {
    const rows = file[table];
    if (!Array.isArray(rows)) continue;
    rows.forEach((raw, i) => {
      const row = raw as Raw;
      for (const f of schema.strings || []) if (typeof row[f] !== 'string' || !String(row[f]).trim()) add(table, i, row, `"${f}" is missing or is not text`);
      for (const f of schema.days || []) if (!realDay(row[f])) add(table, i, row, `"${f}" is not a valid date (${JSON.stringify(row[f])?.slice(0, 40)})`);
      for (const f of schema.optDays || []) if (hasValue(row[f]) && !realDay(row[f])) add(table, i, row, `"${f}" is not a valid date (${JSON.stringify(row[f])?.slice(0, 40)})`);
      for (const f of schema.months || []) if (!realMonth(row[f])) add(table, i, row, `"${f}" is not a valid month (${JSON.stringify(row[f])?.slice(0, 40)})`);
      for (const f of schema.optMonths || []) if (hasValue(row[f]) && !realMonth(row[f])) add(table, i, row, `"${f}" is not a valid month (${JSON.stringify(row[f])?.slice(0, 40)})`);
      for (const f of schema.nums || []) if (!isFiniteNumber(row[f])) add(table, i, row, `"${f}" is not a number (${JSON.stringify(row[f])?.slice(0, 40)})`);
      for (const f of schema.optNums || []) if (hasValue(row[f]) && !isFiniteNumber(row[f])) add(table, i, row, `"${f}" is not a number (${JSON.stringify(row[f])?.slice(0, 40)})`);
      for (const f of schema.currencies || []) if (!isCurrency(row[f])) add(table, i, row, `"${f}" is not JMD or USD (${JSON.stringify(row[f])?.slice(0, 40)})`);
      for (const f of schema.optCurrencies || []) if (hasValue(row[f]) && !isCurrency(row[f])) add(table, i, row, `"${f}" is not JMD or USD (${JSON.stringify(row[f])?.slice(0, 40)})`);
      for (const [f, allowed] of Object.entries(schema.enums || {})) if (!allowed.includes(String(row[f]))) add(table, i, row, `"${f}" is not one of ${allowed.join(', ')} (${JSON.stringify(row[f])?.slice(0, 40)})`);
    });
  }
  return problems;
}

type Totals = Record<'JMD' | 'USD', { count: number; total: number }>;
export interface MoneyTotals {
  /** Completed receipts, net of what was refunded. */
  receipts: Totals;
  /** Charges still open. */
  openCharges: Totals;
  /** Costs marked paid. */
  paidExpenses: Totals;
}

/**
 * The money in a set of records, by currency: what the restore screen shows beside the figures for the records now,
 * so a file that holds far more or less than the books do is obvious before anyone confirms.
 */
export function moneyTotals(src: { payments?: unknown; charges?: unknown; expenses?: unknown }): MoneyTotals {
  const blank = (): Totals => ({ JMD: { count: 0, total: 0 }, USD: { count: 0, total: 0 } });
  const out: MoneyTotals = { receipts: blank(), openCharges: blank(), paidExpenses: blank() };
  const add = (t: Totals, cur: unknown, cents: number) => {
    if (cur !== 'JMD' && cur !== 'USD') return;
    t[cur].count += 1;
    t[cur].total += cents;
  };
  const c = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : 0);
  const rows = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]).filter(r => r && typeof r === 'object') : []);
  for (const p of rows(src.payments)) if (p.status === 'completed') add(out.receipts, p.currency, c(p.amount) - c(p.refundedAmount));
  for (const ch of rows(src.charges)) if (ch.status === 'open') add(out.openCharges, ch.currency, c(ch.amount));
  for (const e of rows(src.expenses)) if (e.status === 'paid') add(out.paidExpenses, e.currency, c(e.amount));
  for (const t of [out.receipts, out.openCharges, out.paidExpenses]) for (const cur of ['JMD', 'USD'] as const) t[cur].total = t[cur].total / 100;
  return out;
}

/** Refuse anything that is not recognisably a Villaggio Del Sol records file. */
export function checkRestoreFile(raw: unknown, currentSchemaVersion: number): Raw {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RestoreRefused('That file is not a Villaggio Del Sol backup or snapshot.');
  }
  const file = raw as Raw;
  for (const key of REQUIRED_TABLES) {
    if (!Array.isArray(file[key])) {
      throw new RestoreRefused(`That file is not a Villaggio Del Sol backup or snapshot: it has no "${key}" list.`);
    }
  }
  for (const key of RESTORED_TABLES) {
    const rows = file[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
      throw new RestoreRefused(`That file is damaged: its "${key}" list is not a list of records.`);
    }
  }
  // A well-formed file can still be damaged inside. Checked BEFORE anything is replaced:
  // text where an amount belongs, or two records sharing an id or a receipt number.
  for (const key of ['payments', 'charges', 'expenses'] as const) {
    const rows = (file[key] as Raw[] | undefined) || [];
    const seen = new Set<string>();
    for (const r of rows) {
      if ('amount' in r && !(typeof r.amount === 'number' && Number.isFinite(r.amount))) {
        throw new RestoreRefused(`That file is damaged: a record in "${key}" has an amount that is not a number (${JSON.stringify(r.amount)}). Nothing was changed.`);
      }
      const id = String(r.id ?? '');
      if (id) {
        if (seen.has(id)) throw new RestoreRefused(`That file is damaged: "${key}" holds the record ${id} more than once. Nothing was changed.`);
        seen.add(id);
      }
    }
  }
  const receiptSeen = new Set<string>();
  for (const p of ((file.payments as Raw[] | undefined) || [])) {
    const no = String(p.receiptNo ?? '');
    if (!no) continue;
    if (receiptSeen.has(no)) throw new RestoreRefused(`That file is damaged: receipt number ${no} appears on two payments. Nothing was changed.`);
    receiptSeen.add(no);
  }
  // Every row of every table, typed: dates, amounts, currencies, ids. A forged or damaged file is refused with a list.
  const problems = restoreRowProblems(file);
  if (problems.length > 0) {
    throw new RestoreRefused(`That file is damaged or has been tampered with: ${problems.length >= 25 ? 'at least ' : ''}${problems.length} record(s) are not valid. Nothing was changed. ${problems.join('; ')}`);
  }
  if ((file.units as unknown[]).length === 0) {
    throw new RestoreRefused('That file has no villas in it, so restoring it would wipe the property. Nothing was changed.');
  }
  const version = Number(file.schemaVersion);
  if (Number.isFinite(version) && version > currentSchemaVersion) {
    throw new RestoreRefused(
      `That file was made by a newer version of this application (database format ${version}, this build understands ` +
        `${currentSchemaVersion}). Install the current version first.`
    );
  }
  return file;
}

export function summariseRestore(file: Raw, current: Database, madeAtFallback: string): RestoreSummary {
  const counts: Record<string, number> = {};
  for (const key of RESTORED_TABLES) counts[key] = Array.isArray(file[key]) ? (file[key] as unknown[]).length : 0;
  const have = new Set(current.users.map(u => u.username.toLowerCase()));
  const staffNotRecreated = (Array.isArray(file.users) ? (file.users as Raw[]) : [])
    .map(u => String(u?.username ?? '').toLowerCase())
    .filter(name => name && !have.has(name));
  const ids = (rows: unknown): Set<string> => new Set((Array.isArray(rows) ? (rows as Raw[]) : []).map(r => String(r?.id ?? '')));
  const missing = (key: 'payments' | 'charges' | 'expenses') => {
    const inFile = ids(file[key]);
    return (current[key] as unknown as Raw[]).filter(r => !inFile.has(String(r.id ?? ''))).length;
  };
  const fileSettings = file.settings && typeof file.settings === 'object' && !Array.isArray(file.settings) ? (file.settings as Raw) : {};
  const live = current.settings as unknown as Raw;
  const differing = Object.keys(fileSettings).filter(
    k => !PROTECTED_SETTINGS.includes(k as never) && k !== 'backupDir' && k !== 'backupMarkerId' && JSON.stringify(fileSettings[k]) !== JSON.stringify(live[k])
  );
  // Filled in from the file only where nothing is set now; everything else keeps today's value.
  const settingsThatWillChange = differing.filter(k => isEmptySetting(live[k]));
  return {
    willBeRemoved: { payments: missing('payments'), charges: missing('charges'), expenses: missing('expenses') },
    settingsKeptAsTheyAre: PROTECTED_SETTINGS.filter(k => k !== 'closedThrough'),
    settingsThatWillChange,
    madeAt: typeof file.exportedAt === 'string' ? file.exportedAt : madeAtFallback,
    schemaVersion: Number.isFinite(Number(file.schemaVersion)) ? Number(file.schemaVersion) : 0,
    counts,
    staffNotRecreated
  };
}

/**
 * Would restoring this file take the books back to an earlier close than the live one?
 * Returns the two closes when it would (the live one is later than the file's, or the
 * file has none), otherwise null.
 */
export function closedMonthsRolledBack(live: Database, file: Raw): { live: string; file: string } | null {
  const liveClosed = typeof live.settings?.closedThrough === 'string' ? live.settings.closedThrough : '';
  const fs = file.settings as Raw | undefined;
  const fileClosed = typeof fs?.closedThrough === 'string' ? String(fs.closedThrough) : '';
  return liveClosed && liveClosed > fileClosed ? { live: liveClosed, file: fileClosed } : null;
}

/** The highest receipt number in the restored payments, so the next one cannot collide. */
function counterFrom(payments: Raw[], year: number): { receiptYear: number; receiptSeq: number } {
  let seq = 0;
  for (const p of payments) {
    const m = /^REC-(\d{4})-(\d+)$/.exec(String(p.receiptNo ?? ''));
    if (m && Number(m[1]) === year) seq = Math.max(seq, Number(m[2]));
  }
  return { receiptYear: year, receiptSeq: seq };
}

/**
 * Overwrite the records in `working` with those in `file`. Accounts, sessions and
 * the backup-location settings stay as they are.
 */
export function applyRestore(working: Database, file: Raw): void {
  const asRecord = working as unknown as Record<string, unknown>;
  // What exists NOW, read before anything is replaced.
  const liveCounter = working.counters;
  const liveSettings = working.settings as unknown as Record<string, unknown>;
  const keptSettings: Record<string, unknown> = {};
  // The closed period is NOT kept: the restored database adopts the file's own seal (below).
  for (const k of PROTECTED_SETTINGS) if (k !== 'closedThrough' && k in liveSettings) keptSettings[k] = liveSettings[k];

  for (const key of RESTORED_TABLES) {
    // The audit trail is the history of what happened, including the work a restore rolls back;
    // replacing it would erase who did what. It stays as it is (the restore adds its own entry).
    if (key === 'auditLogs') continue;
    asRecord[key] = Array.isArray(file[key]) ? structuredClone(file[key]) : [];
  }

  const keep = { backupDir: working.settings.backupDir, backupMarkerId: working.settings.backupMarkerId };
  if (file.settings && typeof file.settings === 'object' && !Array.isArray(file.settings)) {
    // Settings are configuration, not records: what is set NOW wins, and the backup only fills what is empty
    // now (a fresh machine). A TRN or exchange rate changed since the backup must not be rolled back.
    const fromFile = structuredClone(file.settings) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...fromFile };
    for (const [k, v] of Object.entries(liveSettings)) {
      if (!isEmptySetting(v)) merged[k] = v;
    }
    working.settings = { ...merged, ...keep } as unknown as Database['settings'];
  }
  // Policy settings are not restored; a closed period never reopens.
  Object.assign(working.settings as unknown as Record<string, unknown>, keptSettings);
  /*
   * The restored database adopts the file's own sealed state, closedThrough AND its fingerprint, as a
   * pair: keeping the live close over older records left sealed months editable (the stored fingerprint
   * no longer matched, and the write guard then treated the known fault as nothing new). A restore that
   * would roll the close back is refused before it gets here unless the request confirms it
   * (closedMonthsRolledBack).
   */
  const wsettings = working.settings as unknown as Record<string, unknown>;
  const fileSettings = (file.settings && typeof file.settings === 'object' ? file.settings : {}) as Raw;
  const fileClosed = typeof fileSettings.closedThrough === 'string' ? fileSettings.closedThrough : '';
  if (fileClosed) wsettings.closedThrough = fileClosed;
  else delete wsettings.closedThrough;
  if (fileClosed && typeof fileSettings.closeFingerprint === 'string' && fileSettings.closeFingerprint) wsettings.closeFingerprint = fileSettings.closeFingerprint;
  else delete wsettings.closeFingerprint;
  // Restored settings must not carry the backup folder of the machine that made them.
  if (keep.backupDir === undefined) delete working.settings.backupDir;
  if (keep.backupMarkerId === undefined) delete working.settings.backupMarkerId;

  /*
   * The receipt counter only ever moves forward. A backup holds the counter as it was
   * then; receipts numbered after that are already on paper in tenants' hands, so
   * restoring the old counter would issue the same number to a different payer.
   */
  const c = file.counters as { receiptYear?: unknown; receiptSeq?: unknown } | undefined;
  const year = new Date().getFullYear();
  const derived = counterFrom(working.payments as unknown as Raw[], year);
  let seq = derived.receiptSeq;
  if (c && Number.isFinite(Number(c.receiptYear)) && Number.isFinite(Number(c.receiptSeq)) && Number(c.receiptYear) === year) {
    seq = Math.max(seq, Number(c.receiptSeq));
  }
  if (liveCounter && Number(liveCounter.receiptYear) === year && Number.isFinite(Number(liveCounter.receiptSeq))) {
    seq = Math.max(seq, Number(liveCounter.receiptSeq));
  }
  working.counters = { receiptYear: year, receiptSeq: seq };
}
