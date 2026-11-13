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

/** Tables a usable file must carry. The rest may be absent from an older file. */
const REQUIRED_TABLES = ['units', 'charges', 'payments'] as const;

export interface RestoreSummary {
  /** When the file was made, as far as it says. */
  madeAt: string;
  schemaVersion: number;
  counts: Record<string, number>;
  /** Usernames in the file that have no account on this machine. */
  staffNotRecreated: string[];
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
  return {
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
  for (const key of RESTORED_TABLES) {
    asRecord[key] = Array.isArray(file[key]) ? structuredClone(file[key]) : [];
  }

  const keep = { backupDir: working.settings.backupDir, backupMarkerId: working.settings.backupMarkerId };
  if (file.settings && typeof file.settings === 'object' && !Array.isArray(file.settings)) {
    working.settings = { ...working.settings, ...(structuredClone(file.settings) as object), ...keep } as Database['settings'];
  }
  // Restored settings must not carry the backup folder of the machine that made them.
  if (keep.backupDir === undefined) delete working.settings.backupDir;
  if (keep.backupMarkerId === undefined) delete working.settings.backupMarkerId;

  const c = file.counters as { receiptYear?: unknown; receiptSeq?: unknown } | undefined;
  const year = new Date().getFullYear();
  const derived = counterFrom(working.payments as unknown as Raw[], year);
  if (c && Number.isFinite(Number(c.receiptYear)) && Number.isFinite(Number(c.receiptSeq))) {
    const sameYear = Number(c.receiptYear) === year;
    working.counters = {
      receiptYear: Number(c.receiptYear),
      // Never lower than the highest receipt actually present.
      receiptSeq: Math.max(Number(c.receiptSeq), sameYear ? derived.receiptSeq : 0)
    };
  } else {
    working.counters = derived;
  }
}
