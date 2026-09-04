/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Persistence layer.
 *
 * The original server did `loadDb()` at the top of every handler and
 * `writeFileSync` straight over db.json at the bottom. Two requests arriving
 * together would each read the same snapshot and the second write would silently
 * discard the first one's changes, and a crash mid-write left a truncated,
 * unparseable database. Both are fixed here: writes go to a temp file and are
 * renamed into place (atomic on POSIX), a timestamped backup is kept, and every
 * read-modify-write cycle runs inside a serialized transaction.
 */

import fs from 'fs';
import path from 'path';
import {
  AppSettings,
  AuditLog,
  Booking,
  Charge,
  Expense,
  Payment,
  RecurringExpense,
  AnnualReport,
  Ownership,
  Tenancy,
  Unit,
  UnitActivity,
  User,
  UserRole,
  UtilityReading,
  RolePermissions
} from '../src/types';
import { DEFAULT_FX_RATE_JMD_PER_USD } from '../src/lib/money';

export interface StoredUser extends User {
  passwordHash: string;
  passwordSalt: string;
}

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface Database {
  schemaVersion: number;
  units: Unit[];
  /** Append-only ownership periods per villa. See Ownership in types.ts. */
  ownerships: Ownership[];
  tenancies: Tenancy[];
  bookings: Booking[];
  charges: Charge[];
  payments: Payment[];
  utilities: UtilityReading[];
  expenses: Expense[];
  recurringExpenses: RecurringExpense[];
  /** One AGM report per year: its narrative and budget. Figures are never stored. */
  annualReports: AnnualReport[];
  auditLogs: AuditLog[];
  unitActivities: UnitActivity[];
  users: StoredUser[];
  sessions: Session[];
  counters: { receiptYear: number; receiptSeq: number };
  settings: AppSettings;
}

export const SCHEMA_VERSION = 3;

const DATA_DIR = process.env.VDS_DATA_DIR || process.cwd();
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'db-backups');

/**
 * Optional second backup location. Point this at a synced folder (Dropbox,
 * iCloud Drive, OneDrive) or a mounted external drive so a copy of the records
 * leaves this machine. Backups written only to db-backups/ sit on the same disk
 * as the database they are protecting, which does not survive a disk failure or
 * the folder being deleted.
 */
const EXTERNAL_BACKUP_DIR = process.env.VDS_BACKUP_DIR || '';

/**
 * The same thing, but chosen from inside the application and saved in settings —
 * so plugging in an external drive and typing its path is enough, with no
 * environment variable to set and no restart. It takes precedence over the
 * environment variable when set. Held here rather than read from settings on
 * demand, because the backup runs on a timer that must not depend on loading the
 * database (that is what made backups run exactly once per boot before).
 */
let externalBackupOverride = '';

/** The id written into the chosen folder, so the same drive is recognised again. */
let externalBackupMarkerId = '';

/** Told when a drive turns up on a different letter, so the new path can be saved. */
let onBackupRelocated: ((dir: string) => void) | null = null;

/** Point the second backup at a folder. Empty string turns it off. */
export function setExternalBackupDir(dir: string, markerId?: string) {
  externalBackupOverride = (dir || '').trim();
  if (markerId !== undefined) externalBackupMarkerId = markerId;
}

export function setBackupRelocationHandler(fn: ((dir: string) => void) | null) {
  onBackupRelocated = fn;
}

/** Where the off-machine copy goes, if anywhere. */
function externalBackupDir(): string {
  return externalBackupOverride || EXTERNAL_BACKUP_DIR || '';
}

/* ------------------------------------------------------------------ *
 * Finding the drive somebody plugged in
 *
 * Backups used to be a folder path typed in by hand, which works right up to the
 * moment Windows hands the stick a different letter. It comes up as E: today and
 * F: next week because something else was plugged in first, the saved path stops
 * matching, and the off-machine copy quietly stops happening — recorded as a
 * failure, but only noticed by somebody who goes looking.
 *
 * So the drives attached to this machine are listed, and the chosen folder is
 * marked with a small file carrying an id. When the saved path no longer answers,
 * the marker is searched for across the attached drives: the same stick is
 * recognised whatever letter it arrives as, and the path repairs itself.
 *
 * All of this happens on the machine running the server — the HP. A stick pushed
 * into the client is invisible here, which is correct: the backup is written by
 * the server, so it is the server's drives that matter.
 * ------------------------------------------------------------------ */

const BACKUP_MARKER = '.villaggio-backup.json';

export interface DetectedDrive {
  /** The folder a backup would be written into if this drive were chosen. */
  path: string;
  /** What to call it on screen. */
  label: string;
  /** Is it writable right now? */
  writable: boolean;
  /** Does it already hold this property's backups? */
  isCurrentTarget: boolean;
  /** Roughly, is this a removable volume rather than the machine's own disk? */
  removable: boolean;
}

/** Every place a removable drive plausibly mounts on this platform. */
function driveRoots(): { root: string; label: string; removable: boolean }[] {
  const found: { root: string; label: string; removable: boolean }[] = [];

  /**
   * Extra mount points to consider, separated by the platform's path separator.
   * Linux distributions mount removable media in more places than can sensibly be
   * guessed, and it gives the tests somewhere real to stand a drive up. It only
   * widens where this machine's *own* filesystem is searched for our own marker —
   * it grants no access that the server process did not already have.
   */
  for (const extra of (process.env.VDS_DRIVE_ROOTS || '').split(path.delimiter)) {
    const root = extra.trim();
    if (!root) continue;
    try {
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        found.push({ root, label: path.basename(root) || root, removable: true });
      }
    } catch {
      /* not a directory we can read */
    }
  }

  if (process.platform === 'win32') {
    // Checking the letters is dependency-free and fast. C: is the machine's own
    // disk and is listed last, since a backup that never leaves the machine is
    // the thing this feature exists to avoid.
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZC'.split('')) {
      const root = `${letter}:\\`;
      try {
        if (fs.existsSync(root)) found.push({ root, label: `${letter}:`, removable: letter !== 'C' });
      } catch {
        /* a card reader with no card throws rather than answering */
      }
    }
    return found;
  }

  /**
   * Which volume is the machine's own disk?
   *
   * Compared by device id rather than by name. The boot volume shows up in
   * /Volumes alongside the removable ones and looks identical from the path
   * alone, and offering it as an "off-machine" backup target would defeat the
   * entire purpose — a copy on the same disk does not survive that disk failing.
   */
  let bootDevice: number | null = null;
  try {
    bootDevice = fs.statSync('/').dev;
  } catch {
    bootDevice = null;
  }

  // macOS mounts under /Volumes; Linux under /media/<user> or /mnt.
  const mountPoints = ['/Volumes', '/media', '/mnt', `/media/${process.env.USER || ''}`, `/run/media/${process.env.USER || ''}`];
  for (const base of mountPoints) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        // Hidden entries are the system's own (/Volumes/.timemachine and friends),
        // never something a person plugged in.
        if (name.startsWith('.')) continue;
        const root = path.join(base, name);
        try {
          const stat = fs.statSync(root);
          if (!stat.isDirectory()) continue;
          if (found.some(f => f.root === root)) continue;
          found.push({ root, label: name, removable: bootDevice === null ? true : stat.dev !== bootDevice });
        } catch {
          /* unreadable mount */
        }
      }
    } catch {
      /* not a directory we can list */
    }
  }
  return found;
}

/** Read the marker in a folder, if it has one. */
function readMarker(dir: string): { id?: string; property?: string } | null {
  try {
    const raw = fs.readFileSync(path.join(dir, BACKUP_MARKER), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Stamp a folder so the same drive can be recognised on a different letter.
 *
 * Creates the folder if it is not there yet: the target is usually named before
 * it exists — somebody picks a drive and the `Villaggio-Backups` folder on it has
 * never been made. Failing quietly at that point left the drive unmarked and
 * unfindable later, which is the one thing this is for.
 */
export function markBackupFolder(dir: string, id: string): boolean {
  const target = (dir || '').trim();
  if (!target || !id) return false;
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, BACKUP_MARKER),
      JSON.stringify({ id, property: 'Villaggio Del Sol', markedAt: new Date().toISOString() }, null, 2)
    );
    return true;
  } catch {
    // An unplugged or read-only drive: reported by checkBackupTarget, and tried
    // again after the next successful backup.
    return false;
  }
}

/**
 * The drives attached right now, and the folder a backup would go in on each.
 *
 * The suggested folder is named rather than the bare root, so a backup never
 * scatters dated files across the top level of somebody's stick.
 */
export function detectDrives(currentTarget: string): DetectedDrive[] {
  const current = (currentTarget || '').trim();
  const drives: DetectedDrive[] = [];

  for (const { root, label, removable } of driveRoots()) {
    const folder = path.join(root, 'Villaggio-Backups');
    let writable = false;
    try {
      const probe = path.join(root, `.vds-detect-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      writable = true;
    } catch {
      writable = false;
    }
    drives.push({
      path: folder,
      label,
      writable,
      removable,
      isCurrentTarget: !!current && (current === folder || current === root || current.startsWith(root))
    });
  }

  return drives;
}

/**
 * Find where the marked backup folder has got to, when the saved path has stopped
 * answering. Returns the new path, or null if that drive is genuinely not here.
 */
export function relocateBackupFolder(id: string): string | null {
  if (!id) return null;
  for (const { root } of driveRoots()) {
    const candidates = [path.join(root, 'Villaggio-Backups'), root];
    for (const dir of candidates) {
      const marker = readMarker(dir);
      if (marker && marker.id === id) return dir;
    }
    // One level down, for a stick organised into folders.
    try {
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const marker = readMarker(dir);
        if (marker && marker.id === id) return dir;
      }
    } catch {
      /* unreadable root */
    }
  }
  return null;
}

/**
 * Is this folder actually usable as a backup target right now?
 *
 * Genuinely writes and deletes a probe file rather than only checking the path
 * exists: an external drive that has been unplugged, a read-only volume and a
 * path that was mistyped all look similar otherwise, and the difference matters
 * when the whole point is getting a copy off this machine.
 */
export function checkBackupTarget(dir: string): { ok: boolean; message: string } {
  const target = (dir || '').trim();
  if (!target) return { ok: true, message: 'No off-machine backup folder is set.' };
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.vds-write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, message: `Folder is reachable and writable: ${target}` };
  } catch (err) {
    return {
      ok: false,
      message:
        `Could not write to ${target} — ${(err as Error).message}. ` +
        'If this is an external drive, check it is plugged in and that the drive letter is right.'
    };
  }
}

/** The last failure per backup target, so the UI can explain a missing copy. */
const backupErrors = new Map<string, string>();

const BACKUP_RETENTION_DAYS = 30;

export function fullPermissions(): RolePermissions {
  return {
    recordPayments: true,
    editBookings: true,
    cancelBookings: true,
    addBookings: true,
    editUnits: true,
    reversePayments: true,
    enterUtilities: true,
    recordExpenses: true,
    modifySettledRecords: true,
    postCharges: true,
    viewShortfall: true,
    viewIspoOperations: true
  };
}

export function noPermissions(): RolePermissions {
  return {
    recordPayments: false,
    editBookings: false,
    cancelBookings: false,
    addBookings: false,
    editUnits: false,
    reversePayments: false,
    enterUtilities: false,
    recordExpenses: false,
    modifySettledRecords: false,
    postCharges: false,
    // Granted even in the "nothing" set: every member of staff sees this report
    // by default, and a role built up from no permissions is still office staff.
    viewShortfall: true,
    // Same rule, on Ro's instruction of 2026-09-03: "Every role unless withdrawn
    // is the best option."
    viewIspoOperations: true
  };
}

function defaultRolePermissions(): AppSettings['rolePermissions'] {
  return {
    MANAGER: fullPermissions(),
    FINANCE_OFFICER: {
      ...noPermissions(),
      recordPayments: true,
      editUnits: true,
      enterUtilities: true,
      recordExpenses: true,
      postCharges: true
    },
    JUNIOR_OFFICER: {
      ...noPermissions(),
      // The junior officer covers the desk when nobody senior is on site, so
      // taking a rent payment is part of the ordinary day rather than an
      // escalation. Withdraw it in System Settings if that changes.
      recordPayments: true,
      addBookings: true
    }
  };
}

function defaultSettings(): AppSettings {
  return {
    fxRateJmdPerUsd: DEFAULT_FX_RATE_JMD_PER_USD,
    // Villaggio Del Sol is registered as strata plan 2324, confirmed by Ro on
    // 2026-08-16 against the owners' AGM report, which carries it on every page.
    // It read 2724 here until then — wrong on the letterhead and on every
    // statutory return header, which the Commission's return forms ask for.
    //
    // NOT editable from the application: this setting has never had a field in
    // System Settings, though POST /api/settings accepts it. A database that
    // already holds a value keeps it (loadDb merges stored settings over these
    // defaults), so on an existing db.json a wrong number cannot be corrected
    // without adding that field. A new database takes this value and is right.
    strataPlanNumber: '2324',
    trn: '',
    rolePermissions: defaultRolePermissions(),
    backupDir: '',
    vendors: [
      'Atlas Security Jamaica',
      'Ocho Rios Garden Services',
      'Jamaica Plumbers Ltd',
      'Sagicor Property Services',
      'National Water Commission',
      'Jamaica Public Service Company'
    ],
    icalFeeds: []
  };
}

/**
 * A brand-new database starts with the 16 villas that physically exist, so the
 * register is usable immediately. Everything about each one is editable; there
 * is deliberately no "add unit" control, because the property has a fixed number
 * of villas and inventing a seventeenth would corrupt every occupancy figure.
 *
 * Only structural facts are seeded. Owner, tenant, rates and meter numbers are
 * left blank rather than filled with invented people — placeholder names in a
 * financial system get mistaken for real records.
 */
function seedUnits(): Unit[] {
  return Array.from({ length: 16 }, (_, i) => {
    const number = String(i + 1);
    return {
      id: `unit-${number}`,
      number,
      ownerName: '',
      ownerEmail: '',
      ownerPhone: '',
      tenantName: '',
      tenantEmail: '',
      tenantPhone: '',
      status: 'vacant' as const,
      monthlyRent: 0,
      monthlyMaintenance: 0,
      currency: 'JMD' as const,
      maintCurrency: 'JMD' as const,
      meterNumber: '',
      notes: '',
      rentDueDay: 1,
      maintDueDay: 1
    };
  });
}

function emptyDb(): Database {
  return {
    schemaVersion: SCHEMA_VERSION,
    units: seedUnits(),
    ownerships: [],
    tenancies: [],
    bookings: [],
    charges: [],
    payments: [],
    utilities: [],
    expenses: [],
    recurringExpenses: [],
    annualReports: [],
    auditLogs: [],
    unitActivities: [],
    users: [],
    sessions: [],
    counters: { receiptYear: new Date().getFullYear(), receiptSeq: 0 },
    settings: defaultSettings()
  };
}

/** Write the database atomically: temp file, fsync, rename. A crash can never truncate db.json. */
function writeAtomic(db: Database) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  const payload = JSON.stringify(db, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DB_FILE);
}

export interface BackupRecord {
  file: string;
  date: string;
  sizeBytes: number;
  location: 'local' | 'external';
}

function localDayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pruneBackups(dir: string) {
  const files = fs
    .readdirSync(dir)
    .filter(f => f.startsWith('db-') && f.endsWith('.json'))
    .sort();
  while (files.length > BACKUP_RETENTION_DAYS) {
    const oldest = files.shift();
    if (oldest) fs.unlinkSync(path.join(dir, oldest));
  }
}

/**
 * The bytes to write into a backup: the database, minus anyone's live session.
 *
 * A backup is the copy that leaves the machine — onto a USB stick, into a synced
 * folder. It used to be a byte-for-byte copy of db.json, which meant every one of
 * those copies carried the `sessions` array, and a session token is a working
 * credential for twelve hours: paste one into a cookie and you are signed in as
 * whoever it belonged to. Anyone who could read yesterday's backup could sign in
 * as anyone.
 *
 * Sessions are dropped rather than kept because they have no restore value at
 * all — restoring a three-day-old file should never bring anybody's login back
 * from the dead. Password hashes stay: without them a restore loses every
 * account's password, and they are scrypt with a per-user salt. That does still
 * make the backup folder credential-bearing, so treat it as such.
 */
function backupPayload(): string {
  const snapshot = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  snapshot.sessions = [];
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Write the database into the backup folder(s) for today, if not already done.
 *
 * This used to be called only from getDb(), which caches after the first call —
 * so it ran once when the server started and never again. A server left running
 * for a month produced exactly one backup, dated the day it booted. It is now
 * driven by a timer as well (see startBackupSchedule) and by every write day
 * rollover, so an always-on server still gets a copy each day.
 */
export function runDailyBackup(force = false): BackupRecord[] {
  const written: BackupRecord[] = [];
  const stamp = localDayStamp();

  const targets: { dir: string; location: 'local' | 'external' }[] = [{ dir: BACKUP_DIR, location: 'local' }];
  let external = externalBackupDir();

  /**
   * The stick is here, just not where it was.
   *
   * Before giving up on a target that has stopped answering, look for the folder
   * by the marker written into it. Windows reassigns letters freely, and a copy
   * that silently stops being made is worse than one that never started, because
   * nobody is expecting to have to check.
   */
  if (external && !fs.existsSync(external) && externalBackupMarkerId) {
    const moved = relocateBackupFolder(externalBackupMarkerId);
    if (moved && moved !== external) {
      console.log(`[vds] the backup drive is now at ${moved} (was ${external}); following it.`);
      externalBackupOverride = moved;
      external = moved;
      try {
        onBackupRelocated?.(moved);
      } catch {
        /* persisting the new path must never break the backup itself */
      }
    }
  }

  if (external) targets.push({ dir: external, location: 'external' });

  if (!fs.existsSync(DB_FILE)) return written;

  // Prepared once: every target gets the same bytes, and a database that cannot
  // be read is a failure of the whole run rather than of one folder.
  let payload: string;
  try {
    payload = backupPayload();
  } catch (err) {
    const message = (err as Error).message;
    for (const { location } of targets) backupErrors.set(location, message);
    console.error('[vds] backup could not read the database (continuing):', message);
    return written;
  }

  for (const { dir, location } of targets) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `db-${stamp}.json`);
      if (force || !fs.existsSync(target)) {
        // Written through a temp name so a half-written backup is never mistaken
        // for a good one if the process dies mid-write.
        const tmp = `${target}.partial`;
        fs.writeFileSync(tmp, payload, 'utf-8');
        fs.renameSync(tmp, target);
        written.push({ file: `db-${stamp}.json`, date: stamp, sizeBytes: fs.statSync(target).size, location });
      }
      // The drive is demonstrably here and writable right now, so make sure it
      // carries its marker — the folder may not have existed when it was chosen.
      if (location === 'external' && externalBackupMarkerId && !fs.existsSync(path.join(dir, BACKUP_MARKER))) {
        markBackupFolder(dir, externalBackupMarkerId);
      }
      pruneBackups(dir);
      backupErrors.delete(location);
    } catch (err) {
      // A failing backup must never take the application down with it — an
      // unplugged drive is an ordinary Tuesday, not a crash. The reason is kept
      // so the Backup screen can say what went wrong instead of silently
      // showing no copy.
      const message = (err as Error).message;
      backupErrors.set(location, message);
      console.error(`[vds] backup to ${dir} failed (continuing):`, message);
    }
  }
  return written;
}

export function listBackups(): BackupRecord[] {
  const out: BackupRecord[] = [];
  const targets: { dir: string; location: 'local' | 'external' }[] = [{ dir: BACKUP_DIR, location: 'local' }];
  const external = externalBackupDir();
  if (external) targets.push({ dir: external, location: 'external' });

  for (const { dir, location } of targets) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.startsWith('db-') || !file.endsWith('.json')) continue;
        const stat = fs.statSync(path.join(dir, file));
        out.push({ file, date: file.slice(3, 13), sizeBytes: stat.size, location });
      }
    } catch {
      /* an unreadable backup folder is reported as "no backups", not a crash */
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.location.localeCompare(b.location));
}

let backupTimer: NodeJS.Timeout | null = null;

/** Check hourly whether today's backup exists yet. Cheap, and survives a long uptime. */
export function startBackupSchedule() {
  if (backupTimer) return;
  runDailyBackup();
  backupTimer = setInterval(() => runDailyBackup(), 60 * 60 * 1000);
  // Do not hold the process open purely for the backup timer.
  if (typeof backupTimer.unref === 'function') backupTimer.unref();
}

export function backupStatus() {
  const backups = listBackups();
  const external = externalBackupDir();
  const stamp = localDayStamp();
  return {
    dataFile: DB_FILE,
    localBackupDir: BACKUP_DIR,
    externalBackupDir: external || null,
    /** True when the folder is set by environment variable and cannot be edited in the app. */
    externalBackupFromEnv: !externalBackupOverride && !!EXTERNAL_BACKUP_DIR,
    externalBackupError: backupErrors.get('external') || null,
    retentionDays: BACKUP_RETENTION_DAYS,
    todayBackedUp: backups.some(b => b.date === stamp),
    /** Separated, because "today's copy exists on this disk" is not the same as
     *  "a copy of today exists somewhere other than this disk". */
    todayBackedUpExternally: backups.some(b => b.date === stamp && b.location === 'external'),
    backups: backups.slice(0, 60)
  };
}

let cache: Database | null = null;

function readFromDisk(): Database {
  if (!fs.existsSync(DB_FILE)) {
    const fresh = emptyDb();
    writeAtomic(fresh);
    return fresh;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<Database>;

  /*
   * Refuse a database written by a *newer* build than this one.
   *
   * `migrate()` moves an older file forward. Nothing can move a newer one back,
   * because this build does not know what changed — it would read the file with
   * the wrong assumptions, stamp its own version on it, and write that back. The
   * damage is silent and lands on the one file the property cannot lose.
   *
   * This is not hypothetical: the real path to it is restoring a backup taken
   * after an upgrade onto an older .exe that is still lying around, which is
   * exactly what somebody does in a hurry on the morning the disk died.
   *
   * Refusing costs an install of the current version. Not refusing costs the
   * records.
   */
  const version = Number(parsed.schemaVersion);
  if (Number.isFinite(version) && version > SCHEMA_VERSION) {
    throw new Error(
      `db.json was written by a newer version of this application (database format ${version}, ` +
        `this build understands ${SCHEMA_VERSION}). It has NOT been read or modified. ` +
        `Install the current version of Villaggio Del Sol and start it again — ` +
        `an older build cannot safely open newer records.`
    );
  }

  return { ...emptyDb(), ...parsed, settings: { ...defaultSettings(), ...(parsed.settings || {}) } } as Database;
}

/** Load the database, running the migration exactly once per process start. */
export function getDb(): Database {
  if (cache) return cache;
  runDailyBackup();
  let db: Database;
  try {
    db = readFromDisk();
  } catch (err) {
    // Never silently start from an empty database on top of a real one.
    throw new Error(
      `db.json could not be parsed (${(err as Error).message}). ` +
        `The file has NOT been overwritten. Restore it from ./db-backups and restart.`
    );
  }
  const changed = migrate(db);
  cache = db;
  if (changed) writeAtomic(db);
  return db;
}

/**
 * Serialized read-modify-write. Every mutating request runs through this, so two
 * concurrent requests can never read the same snapshot and clobber each other.
 *
 * The handler is given a *copy* of the database, and the copy only replaces the
 * live one once it has been written to disk. This is what makes a rejected request
 * leave no trace. Handlers validate as they go and throw part way through — an
 * update that set a move-in date and then rejected the move-out date used to leave
 * the new move-in date sitting in the shared cache, where the next unrelated
 * request would quietly persist it. The request returned 400 and the record
 * changed anyway. Now a throw discards the copy and the committed state is
 * untouched.
 *
 * Writing before swapping matters too: if the disk write fails, the cache still
 * matches what is actually on disk rather than drifting ahead of it.
 */
let queue: Promise<unknown> = Promise.resolve();

export function transaction<T>(fn: (db: Database) => T): Promise<T> {
  const run = queue.then(async () => {
    const committed = getDb();
    const working = structuredClone(committed);
    const result = await fn(working);
    writeAtomic(working);
    cache = working;
    return result;
  });
  // Keep the chain alive even when a transaction rejects.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Read-only access — no write, no lock. */
export function read<T>(fn: (db: Database) => T): T {
  return fn(getDb());
}

export function addAudit(
  db: Database,
  user: string,
  role: UserRole | string,
  action: string,
  recordType: string,
  recordId: string,
  previousValue: unknown,
  newValue: unknown,
  approvedBy?: string
) {
  const stringify = (v: unknown) =>
    v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  db.auditLogs.unshift({
    id: `audit-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    user,
    role: String(role),
    dateTime: new Date().toISOString(),
    action,
    recordType,
    recordId,
    previousValue: stringify(previousValue),
    newValue: stringify(newValue),
    approvedBy
  });
  // The audit trail is append-only and unbounded by design; trim only the
  // in-memory tail beyond a very high water mark to keep the file manageable.
  if (db.auditLogs.length > 20000) db.auditLogs.length = 20000;
}

/**
 * Sequential, gap-free receipt numbers: REC-2026-0001, REC-2026-0002, ...
 * The original code used `Math.floor(1000 + Math.random() * 9000)`, which can and
 * does collide — two receipts sharing a number makes the ledger unauditable.
 */
export function nextReceiptNo(db: Database): string {
  const year = new Date().getFullYear();
  if (db.counters.receiptYear !== year) {
    db.counters.receiptYear = year;
    db.counters.receiptSeq = 0;
  }
  db.counters.receiptSeq += 1;
  let candidate = `REC-${year}-${String(db.counters.receiptSeq).padStart(4, '0')}`;
  // Defensive: never hand out a number already present (e.g. after a restore).
  let guard = 0;
  while (db.payments.some(p => p.receiptNo === candidate) && guard < 100000) {
    db.counters.receiptSeq += 1;
    candidate = `REC-${year}-${String(db.counters.receiptSeq).padStart(4, '0')}`;
    guard++;
  }
  return candidate;
}

/* ------------------------------------------------------------------ *
 * Migration
 * ------------------------------------------------------------------ */

/**
 * Bring an older database up to the current schema.
 *
 * The important part is `unitId` backfill. Payments, utilities, expenses and
 * activities used to point at a unit by its *display number*. Renaming Unit "1"
 * to "A1" therefore orphaned its whole financial history — which is exactly what
 * happened in the live data, and led to a duplicate maintenance payment being
 * collected for July 2026. Records are relinked here, and every repair is written
 * to the audit trail rather than done silently.
 */
function migrate(db: Database): boolean {
  let changed = false;
  const note = (action: string, recordType: string, recordId: string, detail: string) => {
    addAudit(db, 'System Migration', 'ADMINISTRATOR', action, recordType, recordId, '', detail);
    changed = true;
  };

  if (!Array.isArray(db.charges)) {
    db.charges = [];
    changed = true;
  }
  if (!Array.isArray(db.users)) {
    db.users = [];
    changed = true;
  }
  if (!Array.isArray(db.sessions)) {
    db.sessions = [];
    changed = true;
  }
  if (!Array.isArray(db.unitActivities)) {
    db.unitActivities = [];
    changed = true;
  }
  if (!Array.isArray(db.recurringExpenses)) {
    db.recurringExpenses = [];
    changed = true;
  }
  if (!Array.isArray(db.annualReports)) {
    db.annualReports = [];
    changed = true;
  }
  if (!Array.isArray(db.ownerships)) {
    db.ownerships = [];
    changed = true;
  }
  if (!db.counters) {
    db.counters = { receiptYear: new Date().getFullYear(), receiptSeq: 0 };
    changed = true;
  }

  // Open a tenancy record for every unit that already has a tenant, so the
  // occupancy currently on file becomes the start of a retained history rather
  // than something that disappears the next time the unit is edited.
  //
  // This is written as a reconciliation rather than a one-shot version check:
  // the shape of the array cannot be used to detect "not yet migrated" (the
  // default database supplies an empty one), and a reconciliation also repairs a
  // unit whose tenancy record went missing for any other reason.
  {
    if (!Array.isArray(db.tenancies)) db.tenancies = [];
    const opened: string[] = [];
    for (const unit of db.units) {
      if (!unit.tenantName || !unit.tenantName.trim()) continue;
      const alreadyTracked = db.tenancies.some(
        t => t.unitId === unit.id && t.status === 'active' && t.tenantName.trim().toLowerCase() === unit.tenantName.trim().toLowerCase()
      );
      if (alreadyTracked) continue;
      db.tenancies.push({
        id: `ten-migrated-${unit.id}`,
        unitId: unit.id,
        unitNumber: unit.number,
        tenantName: unit.tenantName.trim(),
        tenantEmail: unit.tenantEmail || '',
        tenantPhone: unit.tenantPhone || '',
        emergencyName: unit.tenantEmergencyName || '',
        emergencyPhone: unit.tenantEmergencyPhone || '',
        emergencyEmail: unit.tenantEmergencyEmail || '',
        monthlyRent: unit.monthlyRent || 0,
        currency: unit.currency,
        rentDueDay: unit.rentDueDay || 1,
        // The true move-in date is not recorded anywhere, so it is left blank
        // rather than invented. Staff can correct it on the tenancy record.
        startedOn: '',
        status: 'active',
        recordedBy: 'System Migration',
        recordedAt: new Date().toISOString()
      });
      opened.push(`${unit.number}: ${unit.tenantName.trim()}`);
    }
    if (opened.length > 0) {
      note(
        `Opened ${opened.length} tenancy record(s) from the current unit register`,
        'Tenancy',
        'backfill',
        `Occupancy history now survives unit edits. Start dates are unknown and left blank: ${opened.join(' | ')}`
      );
    }
  }

  // The same reconciliation for proprietors. Every villa with an owner on the
  // register gets an open ownership period, so a later sale closes something
  // real instead of overwriting the only record of who held the lot. Written as
  // a reconciliation for the same reason as the tenancies above: an empty array
  // cannot be told apart from "not yet migrated".
  {
    if (!Array.isArray(db.ownerships)) db.ownerships = [];
    const opened: string[] = [];
    for (const unit of db.units) {
      if (!unit.ownerName || !unit.ownerName.trim()) continue;
      const alreadyTracked = db.ownerships.some(
        o => o.unitId === unit.id && o.status === 'active' && o.ownerName.trim().toLowerCase() === unit.ownerName.trim().toLowerCase()
      );
      if (alreadyTracked) continue;
      db.ownerships.push({
        id: `own-migrated-${unit.id}`,
        unitId: unit.id,
        unitNumber: unit.number,
        ownerName: unit.ownerName.trim(),
        ownerEmail: unit.ownerEmail || '',
        ownerPhone: unit.ownerPhone || '',
        // Not recorded anywhere, so left blank rather than invented — the same
        // rule the tenancy backfill above follows for a move-in date.
        startedOn: '',
        status: 'active',
        recordedBy: 'System Migration',
        recordedAt: new Date().toISOString()
      });
      opened.push(`${unit.number}: ${unit.ownerName.trim()}`);
    }
    if (opened.length > 0) {
      changed = true;
      note(
        `Opened ${opened.length} ownership record(s) from the current unit register`,
        'Ownership',
        'backfill',
        `Ownership history now survives unit edits, so a sale can be told from a corrected spelling. ` +
          `Acquisition dates are unknown and left blank: ${opened.join(' | ')}`
      );
    }
  }

  // Settings: drop the blanket junior override, add the new granular permission.
  const settings = db.settings;
  if (typeof settings.fxRateJmdPerUsd !== 'number' || !(settings.fxRateJmdPerUsd > 0)) {
    settings.fxRateJmdPerUsd = DEFAULT_FX_RATE_JMD_PER_USD;
    changed = true;
  }
  if (!settings.rolePermissions) {
    settings.rolePermissions = defaultRolePermissions();
    changed = true;
  }
  for (const role of ['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'] as const) {
    const base = settings.rolePermissions[role] || noPermissions();
    const merged = { ...noPermissions(), ...base };
    if (base.postCharges === undefined) merged.postCharges = role !== 'JUNIOR_OFFICER';
    // Recording a payment was not a permission before this version — every signed
    // in member of staff could issue a receipt. A database written then carries no
    // value for it, and the merge above would read that absence as "denied",
    // taking the till away from the whole team on the next restart. Absence means
    // "as it was", so grant it. Withdrawing it is a deliberate act in Settings.
    if (base.recordPayments === undefined) merged.recordPayments = true;
    /*
     * `viewShortfall` and `viewIspoOperations` need no line of their own here,
     * and adding one would be worse than useless.
     *
     * `merged` spreads `noPermissions()` first, and that set carries **both** of
     * them as `true` — so an older database, whose stored values are absent,
     * already comes back granted. An `=== undefined` check for either would be a
     * guard that can never fire, and this codebase has been bitten by exactly
     * that before: an unfirable guard is counted as coverage and hides the
     * absence of a real test. One was written here for `viewShortfall` and one
     * was added for the ISPO statement; both are gone.
     *
     * `recordPayments` and `postCharges` above are different and must stay:
     * `noPermissions()` carries those as `false`, so without their lines an
     * upgrade really would withdraw them.
     *
     * The behaviour is proved instead, on a real upgrade, by
     * `test/two-books.test.mjs` — it writes a database in the shape an older
     * version left it, restarts the server on it, and reads all four back.
     */
    if (JSON.stringify(base) !== JSON.stringify(merged)) {
      settings.rolePermissions[role] = merged;
      changed = true;
    }
  }
  if (settings.juniorHasAdvancedAccess) {
    // The old flag granted *every* privileged action at once, including voiding
    // receipts. Collapse it into explicit permissions instead of dropping it.
    settings.rolePermissions.JUNIOR_OFFICER = {
      ...settings.rolePermissions.JUNIOR_OFFICER,
      addBookings: true,
      editBookings: true,
      cancelBookings: true,
      enterUtilities: true,
      recordExpenses: true
    };
    settings.juniorHasAdvancedAccess = false;
    note(
      'Migration: replaced blanket "junior advanced access" with explicit permissions',
      'Settings',
      'global-settings',
      'The old flag also granted payment reversal and settled-record modification. Those two were NOT carried over; grant them explicitly if intended.'
    );
  }
  if (!Array.isArray(settings.icalFeeds)) {
    settings.icalFeeds = [];
    changed = true;
  }
  if (!Array.isArray(settings.vendors)) {
    settings.vendors = defaultSettings().vendors;
    changed = true;
  }

  // Resolve a unit for a legacy record that only carries a display number.
  const unitByNumber = new Map<string, Unit[]>();
  for (const u of db.units) {
    if (!unitByNumber.has(u.number)) unitByNumber.set(u.number, []);
    unitByNumber.get(u.number)!.push(u);
  }
  const resolveUnit = (unitNumber: string | undefined, unitId: string | undefined): Unit | undefined => {
    if (unitId) {
      const byId = db.units.find(u => u.id === unitId);
      if (byId) return byId;
    }
    if (!unitNumber || unitNumber === 'General') return undefined;
    const exact = unitByNumber.get(unitNumber);
    if (exact && exact.length === 1) return exact[0];
    // The label no longer matches any unit: the unit was probably renamed.
    // Fall back to the seeded id pattern (unit-1 .. unit-16).
    const byPattern = db.units.find(u => u.id === `unit-${unitNumber}`);
    if (byPattern) return byPattern;
    return undefined;
  };

  let relinked = 0;
  let orphaned = 0;
  const relinkNotes: string[] = [];

  const linkRecord = (
    record: { unitId?: string; unitNumber?: string },
    kind: string,
    id: string,
    allowGeneral = false
  ) => {
    if (record.unitId && db.units.some(u => u.id === record.unitId)) {
      const unit = db.units.find(u => u.id === record.unitId)!;
      if (record.unitNumber !== unit.number) {
        record.unitNumber = unit.number;
        changed = true;
      }
      return;
    }
    if (allowGeneral && (!record.unitNumber || record.unitNumber === 'General')) {
      if (record.unitId !== '') {
        record.unitId = '';
        changed = true;
      }
      return;
    }
    const unit = resolveUnit(record.unitNumber, record.unitId);
    if (unit) {
      const wasMislabelled = record.unitNumber !== unit.number;
      record.unitId = unit.id;
      if (wasMislabelled) {
        relinkNotes.push(`${kind} ${id}: "${record.unitNumber}" -> ${unit.id} (now labelled "${unit.number}")`);
        record.unitNumber = unit.number;
        relinked++;
      }
      changed = true;
    } else {
      if (record.unitId !== '') {
        record.unitId = '';
        changed = true;
      }
      orphaned++;
      relinkNotes.push(`${kind} ${id}: unit "${record.unitNumber}" could not be resolved — left unlinked`);
    }
  };

  db.payments.forEach(p => linkRecord(p, 'Payment', p.receiptNo || p.id));
  db.utilities.forEach(u => linkRecord(u, 'Utility', u.id));
  db.expenses.forEach(e => linkRecord(e, 'Expense', e.id, true));
  db.unitActivities.forEach(a => linkRecord(a, 'Activity', a.id));
  db.bookings.forEach(b => linkRecord(b, 'Booking', b.id));
  db.charges.forEach(c => linkRecord(c, 'Charge', c.id));

  if (relinkNotes.length > 0) {
    note(
      `Migration: relinked ${relinked} record(s) to their unit, ${orphaned} could not be resolved`,
      'System',
      'unit-links',
      relinkNotes.join(' | ')
    );
  }

  // Normalise payment methods: the UI offered "Cheque" while the stored union said "Check".
  db.payments.forEach(p => {
    if ((p.method as string) === 'Check') {
      p.method = 'Cheque';
      changed = true;
    }
    if (p.printCount === undefined) {
      p.printCount = 0;
      changed = true;
    }
  });
  db.expenses.forEach(e => {
    if ((e.paymentMethod as string) === 'Check') {
      e.paymentMethod = 'Cheque';
      changed = true;
    }
    if ((e.paymentMethod as string) === 'Credit/Debit Card') {
      e.paymentMethod = 'Credit Card';
      changed = true;
    }
  });

  // Seed the receipt counter above anything already issued.
  const highest = db.payments
    .map(p => /^REC-(\d{4})-(\d+)$/.exec(p.receiptNo || ''))
    .filter((m): m is RegExpExecArray => !!m)
    .filter(m => Number(m[1]) === db.counters.receiptYear)
    .map(m => Number(m[2]));
  const maxSeq = highest.length > 0 ? Math.max(...highest) : 0;
  if (db.counters.receiptSeq < maxSeq) {
    db.counters.receiptSeq = maxSeq;
    changed = true;
  }

  if (db.schemaVersion !== SCHEMA_VERSION) {
    db.schemaVersion = SCHEMA_VERSION;
    changed = true;
  }

  return changed;
}

/** Testing / seeding helper. */
export { DB_FILE, DATA_DIR };
