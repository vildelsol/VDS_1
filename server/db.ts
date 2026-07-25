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
  tenancies: Tenancy[];
  bookings: Booking[];
  charges: Charge[];
  payments: Payment[];
  utilities: UtilityReading[];
  expenses: Expense[];
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

const BACKUP_RETENTION_DAYS = 30;

export function fullPermissions(): RolePermissions {
  return {
    editBookings: true,
    cancelBookings: true,
    addBookings: true,
    editUnits: true,
    reversePayments: true,
    enterUtilities: true,
    recordExpenses: true,
    modifySettledRecords: true,
    postCharges: true
  };
}

export function noPermissions(): RolePermissions {
  return {
    editBookings: false,
    cancelBookings: false,
    addBookings: false,
    editUnits: false,
    reversePayments: false,
    enterUtilities: false,
    recordExpenses: false,
    modifySettledRecords: false,
    postCharges: false
  };
}

function defaultRolePermissions(): AppSettings['rolePermissions'] {
  return {
    MANAGER: fullPermissions(),
    FINANCE_OFFICER: {
      ...noPermissions(),
      editUnits: true,
      enterUtilities: true,
      recordExpenses: true,
      postCharges: true
    },
    JUNIOR_OFFICER: {
      ...noPermissions(),
      addBookings: true
    }
  };
}

function defaultSettings(): AppSettings {
  return {
    fxRateJmdPerUsd: DEFAULT_FX_RATE_JMD_PER_USD,
    rolePermissions: defaultRolePermissions(),
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
    tenancies: [],
    bookings: [],
    charges: [],
    payments: [],
    utilities: [],
    expenses: [],
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
 * Copy the database into the backup folder(s) for today, if not already done.
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
  if (EXTERNAL_BACKUP_DIR) targets.push({ dir: EXTERNAL_BACKUP_DIR, location: 'external' });

  for (const { dir, location } of targets) {
    try {
      if (!fs.existsSync(DB_FILE)) continue;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `db-${stamp}.json`);
      if (force || !fs.existsSync(target)) {
        // Copy through a temp name so a half-written backup is never mistaken
        // for a good one if the process dies mid-copy.
        const tmp = `${target}.partial`;
        fs.copyFileSync(DB_FILE, tmp);
        fs.renameSync(tmp, target);
        written.push({ file: `db-${stamp}.json`, date: stamp, sizeBytes: fs.statSync(target).size, location });
      }
      pruneBackups(dir);
    } catch (err) {
      // A failing backup must never take the application down with it.
      console.error(`[vds] backup to ${dir} failed (continuing):`, (err as Error).message);
    }
  }
  return written;
}

export function listBackups(): BackupRecord[] {
  const out: BackupRecord[] = [];
  const targets: { dir: string; location: 'local' | 'external' }[] = [{ dir: BACKUP_DIR, location: 'local' }];
  if (EXTERNAL_BACKUP_DIR) targets.push({ dir: EXTERNAL_BACKUP_DIR, location: 'external' });

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
  return {
    dataFile: DB_FILE,
    localBackupDir: BACKUP_DIR,
    externalBackupDir: EXTERNAL_BACKUP_DIR || null,
    retentionDays: BACKUP_RETENTION_DAYS,
    todayBackedUp: backups.some(b => b.date === localDayStamp()),
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
 */
let queue: Promise<unknown> = Promise.resolve();

export function transaction<T>(fn: (db: Database) => T): Promise<T> {
  const run = queue.then(async () => {
    const db = getDb();
    const result = await fn(db);
    writeAtomic(db);
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
    if (merged.postCharges === undefined) merged.postCharges = role !== 'JUNIOR_OFFICER';
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
export function resetCacheForTests() {
  cache = null;
}

export { DB_FILE, DATA_DIR };
