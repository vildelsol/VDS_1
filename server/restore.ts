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
    settingsKeptAsTheyAre: [...PROTECTED_SETTINGS],
    settingsThatWillChange,
    madeAt: typeof file.exportedAt === 'string' ? file.exportedAt : madeAtFallback,
    schemaVersion: Number.isFinite(Number(file.schemaVersion)) ? Number(file.schemaVersion) : 0,
    counts,
    staffNotRecreated
  };
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
  for (const k of PROTECTED_SETTINGS) if (k in liveSettings) keptSettings[k] = liveSettings[k];
  const liveClosed = typeof liveSettings.closedThrough === 'string' ? liveSettings.closedThrough : '';

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
  const fileClosed = typeof (file.settings as Raw | undefined)?.closedThrough === 'string' ? String((file.settings as Raw).closedThrough) : '';
  const closed = liveClosed > fileClosed ? liveClosed : fileClosed;
  if (closed) (working.settings as unknown as Record<string, unknown>).closedThrough = closed;
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
