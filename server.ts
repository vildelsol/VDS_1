/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Villaggio Del Sol — property operations API.
 *
 * Design rules enforced here:
 *  - The client never states its own role. Identity comes from the session cookie.
 *  - Every mutating route checks a permission and writes an audit entry.
 *  - Every write runs inside a serialized transaction with an atomic file write.
 *  - Money is rounded to cents on write; USD and JMD are never combined.
 *  - Records reference units by stable id, and renaming a unit cascades.
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  Booking,
  Charge,
  ChargeCategory,
  Currency,
  Expense,
  EXPENSE_CATEGORIES,
  PAYMENT_CATEGORIES,
  PAYMENT_METHODS,
  Payment,
  PaymentCategory,
  PaymentMethod,
  Tenancy,
  Unit,
  UNIT_STATUSES,
  UnitActivity,
  UtilityReading,
  UserRole,
  RolePermissions,
  ICalFeed
} from './src/types';
import { round2, toMoney } from './src/lib/money';
import { isValidDay, isValidMonth, today, dueDateForMonth, monthStart, nightsBetween } from './src/lib/dates';
import { bookingsOverlap, chargeAmount, chargeCurrency, chargePayer, isBillable } from './src/lib/finance';
import {
  Database,
  addAudit,
  backupStatus,
  getDb,
  nextReceiptNo,
  noPermissions,
  read,
  runDailyBackup,
  startBackupSchedule,
  transaction
} from './server/db';
import {
  ACTION_DENIED_MESSAGE,
  AuthedRequest,
  GatedAction,
  can,
  clearSessionCookie,
  createSession,
  destroyAllSessionsFor,
  destroySession,
  ensureBootstrapAdmin,
  hashPassword,
  passwordComplaint,
  permissionsFor,
  readSessionToken,
  requireAuth,
  resolveAuth,
  setSessionCookie,
  toSessionUser,
  verifyPassword
} from './server/auth';
import { classifyEvent, fetchICal, parseICal } from './server/ical';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

/**
 * Liveness probe. Deliberately unauthenticated and dependency-free, so the client
 * can tell "the server is reachable" apart from "my session expired" when a
 * connection drops. Used by the reconnect logic to know when the network is back.
 */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * Idempotency for mutating requests.
 *
 * On a flaky link a client may resend a request whose response was lost — without
 * this, "record payment" retried after a dropped response would create a second
 * receipt. The client attaches a stable `Idempotency-Key` per logical action and
 * reuses it across retries. The first success is remembered and replayed verbatim
 * for any repeat of the same key, so a retry is a safe no-op.
 *
 * Kept in memory with a TTL: retries happen within seconds, so this covers the
 * real case. It intentionally does not survive a server restart — a restart in the
 * middle of a client's retry window is rare, and persisting every key would bloat
 * the database. Only successful (2xx) responses are cached; a failed attempt can
 * always be retried.
 */
interface IdempotentEntry {
  status: number;
  body: unknown;
  at: number;
}
const idempotencyCache = new Map<string, IdempotentEntry>();
const IDEMPOTENCY_TTL_MS = 6 * 60 * 60 * 1000;
const idempotencyInFlight = new Set<string>();

function pruneIdempotency() {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [key, entry] of idempotencyCache) {
    if (entry.at < cutoff) idempotencyCache.delete(key);
  }
}

const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function idempotency(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.header('Idempotency-Key');
  if (!key || !MUTATING.has(req.method)) return next();

  const cached = idempotencyCache.get(key);
  if (cached) {
    res.setHeader('Idempotent-Replayed', 'true');
    return res.status(cached.status).json(cached.body);
  }
  // A duplicate that arrives while the first is still processing: tell the client
  // to back off rather than run the action twice concurrently.
  if (idempotencyInFlight.has(key)) {
    return res.status(409).json({ error: 'This action is still being processed. Please wait.' });
  }
  idempotencyInFlight.add(key);

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      idempotencyCache.set(key, { status: res.statusCode, body, at: Date.now() });
      if (idempotencyCache.size > 5000) pruneIdempotency();
    }
    idempotencyInFlight.delete(key);
    return originalJson(body);
  };
  res.on('close', () => idempotencyInFlight.delete(key));
  next();
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const bad = (message: string) => {
  throw new ApiError(400, message);
};

function requirePermission(req: AuthedRequest, action: GatedAction) {
  if (!req.auth) throw new ApiError(401, 'Not signed in.');
  if (!can(req.auth, action)) throw new ApiError(403, ACTION_DENIED_MESSAGE[action]);
}

function actor(req: AuthedRequest): { name: string; role: UserRole } {
  return { name: req.auth!.user.name, role: req.auth!.user.role };
}

/** Wrap an async handler so thrown ApiErrors become clean JSON responses. */
function handler(fn: (req: AuthedRequest, res: express.Response) => Promise<unknown> | unknown) {
  return async (req: AuthedRequest, res: express.Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ApiError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('[vds] unhandled error:', err);
      return res.status(500).json({ error: 'An unexpected server error occurred. Nothing was saved.' });
    }
  };
}

function requireString(value: unknown, field: string, max = 500): string {
  const v = String(value ?? '').trim();
  if (!v) bad(`${field} is required.`);
  if (v.length > max) bad(`${field} must be ${max} characters or fewer.`);
  return v;
}

function optionalString(value: unknown, max = 2000): string {
  const v = String(value ?? '').trim();
  return v.length > max ? v.slice(0, max) : v;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const v = String(value ?? '') as T;
  if (!allowed.includes(v)) bad(`${field} must be one of: ${allowed.join(', ')}.`);
  return v;
}

function requireCurrency(value: unknown, field = 'Currency'): Currency {
  return requireEnum(value, ['USD', 'JMD'] as const, field);
}

function requirePositiveAmount(value: unknown, field: string): number {
  const amount = toMoney(value);
  if (!(amount > 0)) bad(`${field} must be greater than zero.`);
  if (amount > 1_000_000_000) bad(`${field} is implausibly large. Please check the figure.`);
  return amount;
}

function requireDay(value: unknown, field: string): string {
  const v = String(value ?? '').trim();
  if (!isValidDay(v)) bad(`${field} must be a valid date (YYYY-MM-DD).`);
  return v;
}

function findUnitOrFail(db: Database, unitId: unknown): Unit {
  const unit = db.units.find(u => u.id === String(unitId ?? ''));
  if (!unit) throw new ApiError(400, 'The selected villa unit could not be found.');
  return unit;
}

/**
 * Accept either a unitId (preferred) or a legacy unitNumber, and always return
 * the unit. Client code sends unitId; this keeps old integrations working.
 */
function resolveUnit(db: Database, body: { unitId?: unknown; unitNumber?: unknown }): Unit {
  if (body.unitId) return findUnitOrFail(db, body.unitId);
  const number = String(body.unitNumber ?? '').trim();
  const matches = db.units.filter(u => u.number === number);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new ApiError(400, `More than one villa is labelled "${number}". Select it by unit instead.`);
  throw new ApiError(400, 'The selected villa unit could not be found.');
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

let bootstrapPassword: string | null = null;

function bootstrap() {
  const db = getDb();
  bootstrapPassword = ensureBootstrapAdmin(db);
  if (bootstrapPassword) {
    // Persist the seeded administrator.
    void transaction(inner => {
      if (inner.users.length === 0) {
        inner.users = db.users;
      }
      addAudit(inner, 'System', 'ADMINISTRATOR', 'Created bootstrap administrator account', 'User', 'admin', '', 'username: admin');
    });
    console.log('\n' + '='.repeat(72));
    console.log('  FIRST RUN — an administrator account has been created.');
    console.log('    username: admin');
    console.log(`    password: ${bootstrapPassword}`);
    console.log('  You will be required to change this password at first sign-in.');
    console.log('='.repeat(72) + '\n');
  }
}

/* ------------------------------------------------------------------ *
 * Auth routes (unauthenticated)
 * ------------------------------------------------------------------ */

const loginAttempts = new Map<string, { count: number; first: number }>();

function throttleLogin(key: string) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > 15 * 60 * 1000) {
    loginAttempts.set(key, { count: 1, first: now });
    return;
  }
  entry.count += 1;
  if (entry.count > 10) {
    throw new ApiError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  }
}

app.post(
  '/api/auth/login',
  handler(async (req, res) => {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!username || !password) bad('Username and password are required.');
    throttleLogin(`${req.ip}:${username}`);

    const result = await transaction(db => {
      const user = db.users.find(u => u.username.toLowerCase() === username);
      // Same message and comparable work either way, so the response does not
      // reveal whether the username exists.
      if (!user || !user.active || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
        return null;
      }
      const session = createSession(db, user);
      user.lastLoginAt = new Date().toISOString();
      addAudit(db, user.name, user.role, 'Signed in', 'Session', user.username, '', '');
      return { token: session.token, user: toSessionUser(db, user) };
    });

    if (!result) throw new ApiError(401, 'Incorrect username or password.');
    loginAttempts.delete(`${req.ip}:${username}`);
    setSessionCookie(res, result.token, IS_PROD);
    res.json({ user: result.user });
  })
);

app.post(
  '/api/auth/logout',
  handler(async (req, res) => {
    const token = readSessionToken(req);
    if (token) {
      await transaction(db => {
        const session = db.sessions.find(s => s.token === token);
        const user = session && db.users.find(u => u.id === session.userId);
        if (user) addAudit(db, user.name, user.role, 'Signed out', 'Session', user.username, '', '');
        destroySession(db, token);
      });
    }
    clearSessionCookie(res);
    res.json({ success: true });
  })
);

app.get(
  '/api/auth/me',
  handler((req, res) => {
    const db = getDb();
    const auth = resolveAuth(db, req);
    if (!auth) return res.status(401).json({ error: 'Not signed in.', code: 'UNAUTHENTICATED' });
    res.json({ user: toSessionUser(db, auth.user) });
  })
);

/* ------------------------------------------------------------------ *
 * Everything below requires a session
 * ------------------------------------------------------------------ */

app.use('/api', requireAuth(getDb));
app.use('/api', idempotency);

app.post(
  '/api/auth/change-password',
  handler(async (req: AuthedRequest, res) => {
    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');
    const complaint = passwordComplaint(newPassword);
    if (complaint) bad(complaint);
    if (currentPassword === newPassword) bad('The new password must be different from the current one.');

    await transaction(db => {
      const user = db.users.find(u => u.id === req.auth!.user.id);
      if (!user) throw new ApiError(404, 'Account not found.');
      if (!verifyPassword(currentPassword, user.passwordHash, user.passwordSalt)) {
        throw new ApiError(400, 'Your current password is incorrect.');
      }
      const { hash, salt } = hashPassword(newPassword);
      user.passwordHash = hash;
      user.passwordSalt = salt;
      user.mustChangePassword = false;
      addAudit(db, user.name, user.role, 'Changed own password', 'User', user.username, '', '');
    });
    res.json({ success: true });
  })
);

/** Full database snapshot for the signed-in user. Password material never leaves the server. */
app.get(
  '/api/db',
  handler((req: AuthedRequest, res) => {
    const db = getDb();
    res.json({
      units: db.units,
      bookings: db.bookings,
      charges: db.charges,
      payments: db.payments,
      utilities: db.utilities,
      expenses: db.expenses,
      tenancies: db.tenancies,
      auditLogs: db.auditLogs.slice(0, 2000),
      unitActivities: db.unitActivities,
      settings: db.settings,
      users: db.users.map(u => ({
        id: u.id,
        name: u.name,
        username: u.username,
        email: u.email,
        position: u.position,
        role: u.role,
        active: u.active,
        mustChangePassword: u.mustChangePassword,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt
      })),
      currentUser: toSessionUser(db, req.auth!.user)
    });
  })
);

/* ------------------------------------------------------------------ *
 * Staff accounts (administrators only)
 * ------------------------------------------------------------------ */

app.post(
  '/api/users',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'manage_users');
    const name = requireString(req.body?.name, 'Full name', 120);
    const username = requireString(req.body?.username, 'Username', 40).toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(username)) bad('Username may only contain letters, numbers, dots, dashes and underscores.');
    const role = requireEnum(req.body?.role, ['ADMINISTRATOR', 'MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'] as const, 'Role');
    const password = String(req.body?.password ?? '');
    const complaint = passwordComplaint(password);
    if (complaint) bad(complaint);

    const created = await transaction(db => {
      if (db.users.some(u => u.username.toLowerCase() === username)) {
        throw new ApiError(400, `The username "${username}" is already in use.`);
      }
      const { hash, salt } = hashPassword(password);
      const user = {
        id: `user-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name,
        username,
        email: optionalString(req.body?.email, 200),
        position: optionalString(req.body?.position, 120) || 'Staff',
        role,
        active: true,
        mustChangePassword: true,
        createdAt: new Date().toISOString(),
        passwordHash: hash,
        passwordSalt: salt
      };
      db.users.push(user);
      const who = actor(req);
      addAudit(db, who.name, who.role, `Created staff account "${username}" with role ${role}`, 'User', user.id, '', {
        name,
        username,
        role
      });
      return user;
    });
    res.json({ success: true, user: { id: created.id, name: created.name, username: created.username, role: created.role } });
  })
);

app.put(
  '/api/users/:id',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'manage_users');
    const { id } = req.params;

    await transaction(db => {
      const user = db.users.find(u => u.id === id);
      if (!user) throw new ApiError(404, 'Staff account not found.');
      const before = { name: user.name, role: user.role, active: user.active, position: user.position };

      if (req.body?.name !== undefined) user.name = requireString(req.body.name, 'Full name', 120);
      if (req.body?.email !== undefined) user.email = optionalString(req.body.email, 200);
      if (req.body?.position !== undefined) user.position = optionalString(req.body.position, 120);
      if (req.body?.role !== undefined) {
        user.role = requireEnum(req.body.role, ['ADMINISTRATOR', 'MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'] as const, 'Role');
      }
      if (req.body?.active !== undefined) user.active = !!req.body.active;

      // Never allow the last active administrator to be removed or demoted.
      const activeAdmins = db.users.filter(u => u.role === 'ADMINISTRATOR' && u.active);
      if (activeAdmins.length === 0) {
        throw new ApiError(400, 'At least one active Administrator account must remain.');
      }
      if (!user.active) destroyAllSessionsFor(db, user.id);

      const who = actor(req);
      addAudit(db, who.name, who.role, `Updated staff account "${user.username}"`, 'User', user.id, before, {
        name: user.name,
        role: user.role,
        active: user.active,
        position: user.position
      });
    });
    res.json({ success: true });
  })
);

app.post(
  '/api/users/:id/reset-password',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'manage_users');
    const { id } = req.params;
    const password = String(req.body?.password ?? '');
    const complaint = passwordComplaint(password);
    if (complaint) bad(complaint);

    await transaction(db => {
      const user = db.users.find(u => u.id === id);
      if (!user) throw new ApiError(404, 'Staff account not found.');
      const { hash, salt } = hashPassword(password);
      user.passwordHash = hash;
      user.passwordSalt = salt;
      user.mustChangePassword = true;
      destroyAllSessionsFor(db, user.id);
      const who = actor(req);
      addAudit(db, who.name, who.role, `Reset the password for "${user.username}"`, 'User', user.id, '', 'Password reset; all sessions revoked.');
    });
    res.json({ success: true });
  })
);

/* ------------------------------------------------------------------ *
 * Backup and recovery
 * ------------------------------------------------------------------ */

app.get(
  '/api/backup/status',
  handler((req: AuthedRequest, res) => {
    requirePermission(req, 'manage_settings');
    res.json(backupStatus());
  })
);

/** Take a backup now, on top of the scheduled daily one. */
app.post(
  '/api/backup/run',
  handler((req: AuthedRequest, res) => {
    requirePermission(req, 'manage_settings');
    const written = runDailyBackup(true);
    const who = actor(req);
    void transaction(db => {
      addAudit(db, who.name, who.role, 'Took a manual backup', 'Backup', 'manual', '', written.map(w => `${w.location}: ${w.file}`).join(', ') || 'no target writable');
    });
    res.json({ success: true, written, status: backupStatus() });
  })
);

/**
 * Download a full snapshot. This is the copy that leaves the machine — the point
 * of it is that a disk failure, a stolen laptop or a deleted folder does not take
 * the records with it. Password hashes and live sessions are stripped, so the
 * file is safe to store off-site and cannot be used to sign in as anyone.
 */
app.get(
  '/api/backup/download',
  handler((req: AuthedRequest, res) => {
    requirePermission(req, 'manage_settings');
    const db = getDb();
    const snapshot = {
      exportedAt: new Date().toISOString(),
      exportedBy: req.auth!.user.name,
      schemaVersion: db.schemaVersion,
      note: 'Villaggio Del Sol records export. Credentials and sessions are deliberately excluded.',
      units: db.units,
      tenancies: db.tenancies,
      bookings: db.bookings,
      charges: db.charges,
      payments: db.payments,
      utilities: db.utilities,
      expenses: db.expenses,
      unitActivities: db.unitActivities,
      auditLogs: db.auditLogs,
      counters: db.counters,
      settings: db.settings,
      users: db.users.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active }))
    };
    const stamp = today();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="villaggio-del-sol-records-${stamp}.json"`);
    const who = actor(req);
    void transaction(db2 => {
      addAudit(db2, who.name, who.role, 'Downloaded a records snapshot', 'Backup', 'download', '', `Snapshot dated ${stamp}`);
    });
    res.send(JSON.stringify(snapshot, null, 2));
  })
);

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

app.post(
  '/api/settings',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'manage_settings');
    const { rolePermissions, vendors, fxRateJmdPerUsd } = req.body || {};

    const settings = await transaction(db => {
      const before = JSON.parse(JSON.stringify(db.settings));

      if (rolePermissions) {
        const next = { ...db.settings.rolePermissions };
        for (const role of ['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'] as const) {
          if (!rolePermissions[role]) continue;
          const clean: RolePermissions = { ...noPermissions() };
          for (const key of Object.keys(clean) as (keyof RolePermissions)[]) {
            (clean[key] as boolean) = !!rolePermissions[role][key];
          }
          clean.hasVetoPower = !!rolePermissions[role].hasVetoPower;
          next[role] = clean;
        }
        db.settings.rolePermissions = next;
      }

      if (Array.isArray(vendors)) {
        db.settings.vendors = vendors.map((v: unknown) => optionalString(v, 120)).filter(Boolean).slice(0, 200);
      }

      if (fxRateJmdPerUsd !== undefined) {
        const rate = Number(fxRateJmdPerUsd);
        if (!(rate > 0) || rate > 100000) bad('The indicative exchange rate must be a positive number.');
        db.settings.fxRateJmdPerUsd = round2(rate);
      }

      const who = actor(req);
      addAudit(db, who.name, who.role, 'Updated system settings', 'Settings', 'global-settings', before, db.settings);
      return db.settings;
    });
    res.json({ success: true, settings });
  })
);

/* ------------------------------------------------------------------ *
 * Units and tenancies
 * ------------------------------------------------------------------ */

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function activeTenancy(db: Database, unitId: string): Tenancy | undefined {
  return db.tenancies.find(t => t.unitId === unitId && t.status === 'active');
}

function closeTenancy(db: Database, tenancy: Tenancy, endedOn: string, reason: string, closedBy: string) {
  tenancy.status = 'ended';
  tenancy.endedOn = endedOn;
  tenancy.endReason = reason;
  tenancy.closedBy = closedBy;
}

/**
 * Keep the tenancy history in step with an edit to the unit register.
 *
 * The unit record holds only the *current* occupant. Overwriting the tenant
 * fields, or moving the unit off a long-term lease, previously discarded that
 * person outright — so the system could not answer who occupied a villa last
 * year or what they were paying. Nothing is erased here: the open tenancy is
 * closed with a reason and a new one is opened.
 */
function syncTenancy(db: Database, unit: Unit, original: Unit, staffName: string, role: UserRole): string {
  const current = activeTenancy(db, unit.id);
  const wantsTenant = unit.status === 'long-term' && !!unit.tenantName.trim();
  const stamp = today();

  if (!wantsTenant) {
    if (current) {
      const reason =
        unit.status !== 'long-term'
          ? `Unit status changed from ${original.status} to ${unit.status}.`
          : 'Tenant removed from the unit register.';
      closeTenancy(db, current, stamp, reason, staffName);
      addAudit(
        db,
        staffName,
        role,
        `Closed tenancy for ${current.tenantName} at ${unit.number}`,
        'Tenancy',
        current.id,
        current,
        `Ended ${stamp}. ${reason} The tenancy record and all their receipts are retained.`
      );
      return `tenancy for ${current.tenantName} closed and retained in history`;
    }
    return '';
  }

  if (current && sameName(current.tenantName, unit.tenantName)) {
    // Same person: keep the open tenancy and refresh their details on it.
    const before = { ...current };
    current.tenantName = unit.tenantName.trim();
    current.tenantEmail = unit.tenantEmail;
    current.tenantPhone = unit.tenantPhone;
    current.emergencyName = unit.tenantEmergencyName || '';
    current.emergencyPhone = unit.tenantEmergencyPhone || '';
    current.emergencyEmail = unit.tenantEmergencyEmail || '';
    current.monthlyRent = unit.monthlyRent;
    current.currency = unit.currency;
    current.rentDueDay = unit.rentDueDay || 1;
    if (JSON.stringify(before) !== JSON.stringify(current)) {
      addAudit(db, staffName, role, `Updated tenancy details for ${current.tenantName} at ${unit.number}`, 'Tenancy', current.id, before, current);
    }
    return '';
  }

  if (current) {
    closeTenancy(db, current, stamp, `Replaced by ${unit.tenantName.trim()}.`, staffName);
    addAudit(
      db,
      staffName,
      role,
      `Closed tenancy for ${current.tenantName} at ${unit.number}`,
      'Tenancy',
      current.id,
      current,
      `Ended ${stamp}, replaced by ${unit.tenantName.trim()}. The tenancy record and all their receipts are retained.`
    );
  }

  const tenancy: Tenancy = {
    id: `ten-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    unitId: unit.id,
    unitNumber: unit.number,
    tenantName: unit.tenantName.trim(),
    tenantEmail: unit.tenantEmail,
    tenantPhone: unit.tenantPhone,
    emergencyName: unit.tenantEmergencyName || '',
    emergencyPhone: unit.tenantEmergencyPhone || '',
    emergencyEmail: unit.tenantEmergencyEmail || '',
    monthlyRent: unit.monthlyRent,
    currency: unit.currency,
    rentDueDay: unit.rentDueDay || 1,
    startedOn: stamp,
    status: 'active',
    recordedBy: staffName,
    recordedAt: new Date().toISOString()
  };
  db.tenancies.push(tenancy);
  addAudit(db, staffName, role, `Opened tenancy for ${tenancy.tenantName} at ${unit.number}`, 'Tenancy', tenancy.id, '', tenancy);
  return current ? `tenant changed to ${tenancy.tenantName}` : `tenancy opened for ${tenancy.tenantName}`;
}

/**
 * Correct a tenancy's dates or close it on the date the tenant actually left.
 * Without this, a move-out recorded a fortnight late would be dated the day the
 * paperwork was done rather than the day it happened.
 */
app.put(
  '/api/tenancies/:id',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'edit_unit');
    const { id } = req.params;
    const body = req.body || {};

    const tenancy = await transaction(db => {
      const record = db.tenancies.find(t => t.id === id);
      if (!record) throw new ApiError(404, 'Tenancy record not found.');
      const before = { ...record };

      if (body.startedOn !== undefined) {
        record.startedOn = body.startedOn === '' ? '' : requireDay(body.startedOn, 'Move-in date');
      }
      if (body.endedOn !== undefined && body.endedOn !== '') {
        const endedOn = requireDay(body.endedOn, 'Move-out date');
        if (record.startedOn && endedOn < record.startedOn) {
          bad('The move-out date cannot fall before the move-in date.');
        }
        record.endedOn = endedOn;
        record.status = 'ended';
        record.endReason = optionalString(body.endReason, 500) || record.endReason || 'Tenancy ended.';
        record.closedBy = req.auth!.user.name;

        // The unit only shows a current tenant while a tenancy is open.
        const unit = db.units.find(u => u.id === record.unitId);
        if (unit && sameName(unit.tenantName, record.tenantName)) {
          unit.tenantName = '';
          unit.tenantEmail = '';
          unit.tenantPhone = '';
          unit.tenantEmergencyName = '';
          unit.tenantEmergencyPhone = '';
          unit.tenantEmergencyEmail = '';
          if (unit.status === 'long-term') unit.status = 'vacant';
        }
      }
      if (body.endReason !== undefined && record.status === 'ended') {
        record.endReason = optionalString(body.endReason, 500);
      }

      const who = actor(req);
      addAudit(db, who.name, who.role, `Updated tenancy record for ${record.tenantName} at ${record.unitNumber}`, 'Tenancy', id, before, record);
      return record;
    });
    res.json({ success: true, tenancy });
  })
);

/**
 * Evict a tenant and write off the rent they owe.
 *
 * An eviction is a financial decision, not routine data entry: the outstanding
 * rent leaves the dashboard and the notifications hub, which are driven by open
 * charges. So this is gated behind the same veto-level permission as reversing a
 * payment (Managers and Administrators), voids the tenant's open rent charges as
 * bad debt, and records the written-off total on the tenancy and in the audit
 * trail. Nothing is deleted — the debt is retained as history, it simply stops
 * counting as collectable.
 */
app.post(
  '/api/tenancies/:id/evict',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'reverse_payment');
    const { id } = req.params;
    const body = req.body || {};
    const reason = requireString(body.reason, 'A reason for the eviction', 800);
    if (reason.length < 5) bad('Give a reason of at least 5 characters. It is stored permanently.');
    const effectiveDate = requireDay(body.effectiveDate || today(), 'Effective date');
    if (effectiveDate > today()) bad('The effective date cannot be in the future.');

    const result = await transaction(db => {
      const record = db.tenancies.find(t => t.id === id);
      if (!record) throw new ApiError(404, 'Tenancy record not found.');
      if (record.status === 'ended') throw new ApiError(400, 'That tenancy has already ended.');
      if (record.startedOn && effectiveDate < record.startedOn) {
        bad('The eviction date cannot fall before the move-in date.');
      }
      const before = { ...record };
      const who = actor(req);

      // Void the tenant's open rent charges. They are matched on the unit, in the
      // tenancy's own currency, so a USD and a JMD account are never mixed.
      const openRent = db.charges.filter(
        c => c.unitId === record.unitId && c.category === 'Rent' && c.status === 'open' && c.currency === record.currency
      );
      let writtenOff = 0;
      for (const charge of openRent) {
        writtenOff = round2(writtenOff + charge.amount);
        charge.status = 'void';
        charge.voidedBy = who.name;
        charge.voidedAt = new Date().toISOString();
        charge.voidReason = `Written off — tenant evicted (${reason}).`;
      }

      record.status = 'ended';
      record.evicted = true;
      record.endedOn = effectiveDate;
      record.endReason = `Evicted: ${reason}`;
      record.writeOffAmount = writtenOff;
      record.writeOffCurrency = record.currency;
      record.closedBy = who.name;

      // Clear the current tenant from the unit and free it.
      const unit = db.units.find(u => u.id === record.unitId);
      if (unit && sameName(unit.tenantName, record.tenantName)) {
        unit.tenantName = '';
        unit.tenantEmail = '';
        unit.tenantPhone = '';
        unit.tenantEmergencyName = '';
        unit.tenantEmergencyPhone = '';
        unit.tenantEmergencyEmail = '';
        if (unit.status === 'long-term') unit.status = 'vacant';
      }

      addAudit(
        db,
        who.name,
        who.role,
        `Evicted ${record.tenantName} from ${record.unitNumber} and wrote off ${record.writeOffCurrency} ${writtenOff}`,
        'Tenancy',
        id,
        before,
        record,
        who.name
      );

      return { tenancy: record, writtenOff, currency: record.currency, chargesVoided: openRent.length };
    });

    res.json({ success: true, ...result });
  })
);

app.put(
  '/api/units/:id',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'edit_unit');
    const { id } = req.params;
    const body = req.body || {};

    const updated = await transaction(db => {
      const idx = db.units.findIndex(u => u.id === id);
      if (idx === -1) throw new ApiError(404, 'Unit not found.');
      const original = db.units[idx];

      const number = requireString(body.number ?? original.number, 'Villa number', 40);
      if (db.units.some(u => u.id !== id && u.number.toLowerCase() === number.toLowerCase())) {
        throw new ApiError(400, `Another villa is already labelled "${number}". Unit labels must be unique.`);
      }

      const status = requireEnum(body.status ?? original.status, UNIT_STATUSES, 'Villa status');
      const currency = requireCurrency(body.currency ?? original.currency, 'Base currency');
      const maintCurrency = requireCurrency(body.maintCurrency ?? original.maintCurrency ?? currency, 'Maintenance currency');

      const rentApplies = status === 'long-term' || status === 'short-term';
      const monthlyRent = rentApplies ? Math.max(0, toMoney(body.monthlyRent ?? original.monthlyRent)) : 0;
      const monthlyMaintenance = status === 'unavailable' ? 0 : Math.max(0, toMoney(body.monthlyMaintenance ?? original.monthlyMaintenance));

      const clampDay = (v: unknown, fallback: number) => {
        const n = Math.round(Number(v ?? fallback));
        return Number.isFinite(n) ? Math.min(Math.max(n, 1), 31) : fallback;
      };

      // Meter id is administrator-only, mirroring the disabled field in the UI —
      // the client control alone was not an enforcement point.
      const meterNumber =
        req.auth!.user.role === 'ADMINISTRATOR' ? optionalString(body.meterNumber ?? original.meterNumber, 60) : original.meterNumber;

      const keepsTenant = status === 'long-term';
      const updatedUnit: Unit = {
        ...original,
        number,
        ownerName: requireString(body.ownerName ?? original.ownerName, 'Owner name', 120),
        ownerEmail: optionalString(body.ownerEmail ?? original.ownerEmail, 200),
        ownerPhone: optionalString(body.ownerPhone ?? original.ownerPhone, 60),
        tenantName: keepsTenant ? optionalString(body.tenantName ?? original.tenantName, 120) : '',
        tenantEmail: keepsTenant ? optionalString(body.tenantEmail ?? original.tenantEmail, 200) : '',
        tenantPhone: keepsTenant ? optionalString(body.tenantPhone ?? original.tenantPhone, 60) : '',
        status,
        monthlyRent,
        monthlyMaintenance,
        currency,
        maintCurrency,
        meterNumber,
        notes: optionalString(body.notes ?? original.notes, 4000),
        rentDueDay: clampDay(body.rentDueDay, original.rentDueDay || 1),
        maintDueDay: clampDay(body.maintDueDay, original.maintDueDay || 1),
        ownerEmergencyName: optionalString(body.ownerEmergencyName ?? original.ownerEmergencyName, 120),
        ownerEmergencyPhone: optionalString(body.ownerEmergencyPhone ?? original.ownerEmergencyPhone, 60),
        ownerEmergencyEmail: optionalString(body.ownerEmergencyEmail ?? original.ownerEmergencyEmail, 200),
        tenantEmergencyName: keepsTenant ? optionalString(body.tenantEmergencyName ?? original.tenantEmergencyName, 120) : '',
        tenantEmergencyPhone: keepsTenant ? optionalString(body.tenantEmergencyPhone ?? original.tenantEmergencyPhone, 60) : '',
        tenantEmergencyEmail: keepsTenant ? optionalString(body.tenantEmergencyEmail ?? original.tenantEmergencyEmail, 200) : ''
      };

      db.units[idx] = updatedUnit;

      // Renaming a unit must carry its whole history with it. This is the defect
      // that orphaned Unit 1's payments when it became "A1" and caused a
      // duplicate maintenance collection.
      let cascaded = 0;
      if (original.number !== number) {
        const relabel = (rows: { unitId?: string; unitNumber: string }[]) => {
          for (const row of rows) {
            if (row.unitId === id && row.unitNumber !== number) {
              row.unitNumber = number;
              cascaded++;
            }
          }
        };
        relabel(db.payments);
        relabel(db.utilities);
        relabel(db.expenses);
        relabel(db.bookings);
        relabel(db.charges);
        relabel(db.unitActivities);
        relabel(db.tenancies);
        for (const feed of db.settings.icalFeeds) {
          if (feed.unitId === id) feed.unitNumber = number;
        }
      }

      const who = actor(req);
      const tenancyNote = syncTenancy(db, updatedUnit, original, who.name, who.role);

      const parts: string[] = [];
      if (original.number !== number) parts.push(`renamed "${original.number}" to "${number}" (${cascaded} linked record(s) relabelled)`);
      if (original.ownerName !== updatedUnit.ownerName) parts.push('new owner');
      if (tenancyNote) parts.push(tenancyNote);
      if (original.status !== status) parts.push(`status ${original.status} to ${status}`);
      if (original.monthlyRent !== monthlyRent) parts.push('rent changed');
      if (original.monthlyMaintenance !== monthlyMaintenance) parts.push('maintenance fee changed');

      addAudit(
        db,
        who.name,
        who.role,
        `Updated unit register${parts.length ? ` [${parts.join('; ')}]` : ''}`,
        'Unit',
        id,
        original,
        updatedUnit
      );
      return updatedUnit;
    });
    res.json({ success: true, unit: updated });
  })
);

/* ------------------------------------------------------------------ *
 * Charges (the recurring billing ledger)
 * ------------------------------------------------------------------ */

/**
 * Post rent and maintenance charges for a month.
 *
 * The previous implementation counted units and returned a success message
 * without writing anything at all, so arrears could never accumulate. This
 * writes real dated charge rows and is idempotent: re-posting a month tops up
 * only what is missing and never duplicates.
 */
app.post(
  '/api/charges/post-month',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'post_charges');
    const monthString = String(req.body?.monthString ?? '').trim();
    if (!isValidMonth(monthString)) bad('Billing month is required in YYYY-MM format.');
    if (monthString > today().substring(0, 7)) bad('You cannot post charges for a future month.');

    const result = await transaction(db => {
      const who = actor(req);
      const created: Charge[] = [];
      const skipped: string[] = [];

      for (const unit of db.units) {
        for (const category of ['Rent', 'Maintenance'] as ChargeCategory[]) {
          if (!isBillable(unit, category)) continue;
          const exists = db.charges.some(
            c => c.unitId === unit.id && c.category === category && c.periodMonth === monthString && c.status === 'open'
          );
          if (exists) {
            skipped.push(`${unit.number}/${category}`);
            continue;
          }
          const dueDay = category === 'Rent' ? unit.rentDueDay || 1 : unit.maintDueDay || 1;
          const charge: Charge = {
            id: `chg-${monthString}-${unit.id}-${category.toLowerCase()}`,
            unitId: unit.id,
            unitNumber: unit.number,
            category,
            periodMonth: monthString,
            dueDate: dueDateForMonth(monthString, dueDay),
            amount: chargeAmount(unit, category),
            currency: chargeCurrency(unit, category),
            status: 'open',
            payerName: chargePayer(unit, category),
            createdAt: new Date().toISOString(),
            createdBy: who.name
          };
          db.charges.push(charge);
          created.push(charge);
        }
      }

      addAudit(
        db,
        who.name,
        who.role,
        `Posted recurring charges for ${monthString}`,
        'Charge',
        monthString,
        `${skipped.length} already posted`,
        `${created.length} charge(s) created: ${created.map(c => `${c.unitNumber}/${c.category} ${c.currency} ${c.amount}`).join(', ') || 'none'}`
      );

      return { created: created.length, skipped: skipped.length };
    });

    res.json({
      success: true,
      ...result,
      message:
        result.created > 0
          ? `Posted ${result.created} charge(s) for ${monthString}.` +
            (result.skipped > 0 ? ` ${result.skipped} were already posted and were left untouched.` : '')
          : `Nothing to post — all ${result.skipped} billable charge(s) for ${monthString} already exist.`
    });
  })
);

/** Void a charge that was raised in error. Charges are never deleted. */
app.post(
  '/api/charges/:id/void',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'modify_settled');
    const { id } = req.params;
    const reason = requireString(req.body?.reason, 'A reason', 500);
    if (reason.length < 5) bad('Please give a reason of at least 5 characters.');

    await transaction(db => {
      const charge = db.charges.find(c => c.id === id);
      if (!charge) throw new ApiError(404, 'Charge not found.');
      if (charge.status === 'void') throw new ApiError(400, 'That charge has already been voided.');
      const before = { ...charge };
      const who = actor(req);
      charge.status = 'void';
      charge.voidedBy = who.name;
      charge.voidedAt = new Date().toISOString();
      charge.voidReason = reason;
      addAudit(db, who.name, who.role, 'Voided a billed charge', 'Charge', id, before, charge, who.name);
    });
    res.json({ success: true });
  })
);

/* ------------------------------------------------------------------ *
 * Bookings
 * ------------------------------------------------------------------ */

function assertBookableUnit(unit: Unit) {
  if (unit.status === 'unavailable') {
    throw new ApiError(400, `${unit.number} is marked Unavailable and cannot accept reservations.`);
  }
  if (unit.status === 'long-term') {
    throw new ApiError(
      400,
      `${unit.number} is under a long-term lease and is not available for short stays. Change the unit status first if this is intended.`
    );
  }
}

function assertNoOverlap(db: Database, unitId: string, checkIn: string, checkOut: string, ignoreId?: string) {
  const clash = db.bookings.find(b => {
    if (b.id === ignoreId) return false;
    if (b.unitId !== unitId) return false;
    if (b.status === 'cancelled') return false;
    return bookingsOverlap(checkIn, checkOut, b.checkIn, b.checkOut);
  });
  if (clash) {
    throw new ApiError(
      400,
      `Those dates clash with an existing reservation for ${clash.guestName} (${clash.checkIn} to ${clash.checkOut}). Same-day changeovers are allowed; overlapping nights are not.`
    );
  }
}

/**
 * Keep the booking deposit and the cash ledger in step.
 *
 * The original version spliced the payment row out of the ledger when a deposit
 * was reduced to zero, destroying an issued receipt. Receipts are financial
 * records: this reverses them instead, leaving the void visible and audited.
 */
function syncBookingDepositReceipt(db: Database, booking: Booking, staffName: string, role: UserRole) {
  const existing = db.payments.find(p => p.bookingId === booking.id);

  if (booking.status === 'cancelled' || booking.depositPaid <= 0) {
    if (existing && existing.status === 'completed') {
      const before = { ...existing };
      existing.status = 'reversed';
      existing.reversedBy = staffName;
      existing.reversalDate = today();
      existing.reversalReason =
        booking.status === 'cancelled'
          ? 'Reservation cancelled — deposit receipt voided.'
          : 'Reservation deposit reduced to zero — deposit receipt voided.';
      addAudit(db, staffName, role, 'Voided booking deposit receipt', 'Payment', existing.id, before, existing, staffName);
    }
    return;
  }

  if (existing) {
    if (existing.amount !== booking.depositPaid || existing.currency !== booking.currency || existing.status !== 'completed') {
      const before = { ...existing };
      existing.amount = booking.depositPaid;
      existing.currency = booking.currency;
      existing.payerName = booking.guestName;
      existing.unitId = booking.unitId;
      existing.unitNumber = booking.unitNumber;
      existing.status = 'completed';
      delete existing.reversedBy;
      delete existing.reversalDate;
      delete existing.reversalReason;
      addAudit(db, staffName, role, 'Adjusted booking deposit receipt to match the reservation', 'Payment', existing.id, before, existing);
    }
    return;
  }

  const payment: Payment = {
    id: `p-booking-${booking.id}`,
    receiptNo: nextReceiptNo(db),
    payerName: booking.guestName,
    unitId: booking.unitId,
    unitNumber: booking.unitNumber,
    category: 'Booking',
    amount: booking.depositPaid,
    currency: booking.currency,
    date: today(),
    method: 'Bank Transfer',
    reference: `BOOK-${booking.id.slice(-6).toUpperCase()}`,
    notes: `Deposit for reservation by ${booking.guestName} (${booking.checkIn} to ${booking.checkOut}).`,
    staffMember: staffName,
    status: 'completed',
    printCount: 0,
    bookingId: booking.id
  };
  db.payments.push(payment);
  addAudit(db, staffName, role, 'Raised booking deposit receipt', 'Payment', payment.id, '', payment);
}

function readBookingFields(body: Record<string, unknown>, unit: Unit, existing?: Booking) {
  const checkIn = requireDay(body.checkIn ?? existing?.checkIn, 'Arrival date');
  const checkOut = requireDay(body.checkOut ?? existing?.checkOut, 'Departure date');
  if (checkOut <= checkIn) bad('The departure date must be after the arrival date.');
  if (nightsBetween(checkIn, checkOut) > 365) bad('A single reservation cannot exceed 365 nights.');

  const currency = requireCurrency(body.currency ?? existing?.currency ?? unit.currency, 'Currency');
  const amount = Math.max(0, toMoney(body.amount ?? existing?.amount ?? 0));
  const depositPaid = Math.max(0, toMoney(body.depositPaid ?? existing?.depositPaid ?? 0));
  if (depositPaid > amount) {
    bad('The deposit cannot exceed the total stay cost. Record the surplus as a separate payment if it is an overpayment.');
  }
  const nightlyRateRaw = body.nightlyRate ?? existing?.nightlyRate;
  const nightlyRate = nightlyRateRaw === undefined || nightlyRateRaw === null || nightlyRateRaw === '' ? undefined : Math.max(0, toMoney(nightlyRateRaw));

  return {
    checkIn,
    checkOut,
    currency,
    amount,
    depositPaid,
    balanceDue: round2(amount - depositPaid),
    nightlyRate,
    guestName: requireString(body.guestName ?? existing?.guestName, 'Guest name', 120),
    guestEmail: optionalString(body.guestEmail ?? existing?.guestEmail, 200),
    guestPhone: optionalString(body.guestPhone ?? existing?.guestPhone, 60),
    source: requireEnum(body.source ?? existing?.source ?? 'Direct', ['Direct', 'Airbnb', 'Booking.com', 'Blocked', 'Unavailable'] as const, 'Booking source'),
    status: requireEnum(body.status ?? existing?.status ?? 'confirmed', ['confirmed', 'checked-in', 'checked-out', 'cancelled'] as const, 'Booking status'),
    notes: optionalString(body.notes ?? existing?.notes, 2000)
  };
}

app.post(
  '/api/bookings',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'add_booking');

    const booking = await transaction(db => {
      const unit = resolveUnit(db, req.body || {});
      assertBookableUnit(unit);
      const fields = readBookingFields(req.body || {}, unit);
      assertNoOverlap(db, unit.id, fields.checkIn, fields.checkOut);

      const who = actor(req);
      const created: Booking = {
        id: `b-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        unitId: unit.id,
        unitNumber: unit.number,
        ...fields
      };
      db.bookings.push(created);
      syncBookingDepositReceipt(db, created, who.name, who.role);
      addAudit(db, who.name, who.role, 'Created reservation', 'Booking', created.id, '', created);
      return created;
    });
    res.json({ success: true, booking });
  })
);

app.put(
  '/api/bookings/:id',
  handler(async (req: AuthedRequest, res) => {
    const { id } = req.params;
    const body = req.body || {};

    const booking = await transaction(db => {
      const idx = db.bookings.findIndex(b => b.id === id);
      if (idx === -1) throw new ApiError(404, 'Reservation not found.');
      const original = db.bookings[idx];

      const cancelling = body.status === 'cancelled' && original.status !== 'cancelled';
      requirePermission(req, cancelling ? 'cancel_booking' : 'edit_booking');
      if (cancelling && original.depositPaid > 0 && !can(req.auth!, 'cancel_booking')) {
        throw new ApiError(403, ACTION_DENIED_MESSAGE.cancel_booking);
      }
      if (original.status === 'cancelled' && body.status && body.status !== 'cancelled') {
        throw new ApiError(400, 'A cancelled reservation cannot be reinstated. Create a new reservation instead.');
      }

      const unit = body.unitId || body.unitNumber ? resolveUnit(db, body) : findUnitOrFail(db, original.unitId);
      if (unit.id !== original.unitId) assertBookableUnit(unit);

      const fields = readBookingFields(body, unit, original);
      if (fields.status !== 'cancelled') {
        assertNoOverlap(db, unit.id, fields.checkIn, fields.checkOut, id);
      }

      const who = actor(req);
      const updated: Booking = { ...original, unitId: unit.id, unitNumber: unit.number, ...fields };
      db.bookings[idx] = updated;
      syncBookingDepositReceipt(db, updated, who.name, who.role);
      addAudit(db, who.name, who.role, cancelling ? 'Cancelled reservation' : 'Updated reservation', 'Booking', id, original, updated);
      return updated;
    });
    res.json({ success: true, booking });
  })
);

/* ------------------------------------------------------------------ *
 * Payments and receipts
 * ------------------------------------------------------------------ */

app.post(
  '/api/payments',
  handler(async (req: AuthedRequest, res) => {
    const body = req.body || {};

    const payment = await transaction(db => {
      const unit = resolveUnit(db, body);
      const category = requireEnum(body.category, PAYMENT_CATEGORIES, 'Payment category') as PaymentCategory;
      const amount = requirePositiveAmount(body.amount, 'Payment amount');
      const currency = requireCurrency(body.currency);
      const date = requireDay(body.date || today(), 'Payment date');
      if (date > today()) bad('A payment cannot be dated in the future.');
      const method = requireEnum(body.method, PAYMENT_METHODS, 'Payment method') as PaymentMethod;

      // Warn loudly rather than quietly mis-filing money in the wrong currency.
      if (category === 'Rent' || category === 'Maintenance') {
        const expected = chargeCurrency(unit, category as ChargeCategory);
        if (currency !== expected && !body.confirmCurrencyMismatch) {
          throw new ApiError(
            400,
            `${unit.number} is billed for ${category.toLowerCase()} in ${expected}, but this receipt is in ${currency}. ` +
              `A payment in a different currency will not reduce the ${expected} balance. Re-enter it in ${expected}, or confirm to record it anyway.`
          );
        }
      }

      const who = actor(req);
      const created: Payment = {
        id: `p-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        receiptNo: nextReceiptNo(db),
        payerName: requireString(body.payerName, 'Payer name', 120),
        unitId: unit.id,
        unitNumber: unit.number,
        category,
        amount,
        currency,
        date,
        method,
        reference: optionalString(body.reference, 120),
        notes: optionalString(body.notes, 2000),
        staffMember: who.name,
        status: 'completed',
        printCount: 0
      };
      db.payments.push(created);
      addAudit(db, who.name, who.role, `Recorded payment and issued receipt ${created.receiptNo}`, 'Payment', created.id, '', created);
      return created;
    });
    res.json({ success: true, payment });
  })
);

/**
 * Correct a settled record.
 *
 * Status is deliberately NOT editable here. The original edit form let a user
 * flip a voided receipt back to "completed", silently un-voiding it and leaving
 * the reversal reason attached to a live receipt. Voiding has its own audited
 * endpoint and is one-way.
 */
app.put(
  '/api/payments/:id',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'modify_settled');
    const { id } = req.params;
    const body = req.body || {};

    const payment = await transaction(db => {
      const idx = db.payments.findIndex(p => p.id === id);
      if (idx === -1) throw new ApiError(404, 'Payment not found.');
      const original = db.payments[idx];
      if (original.status === 'reversed') {
        throw new ApiError(400, 'A voided receipt cannot be edited. Record a new payment instead.');
      }
      if (original.bookingId) {
        throw new ApiError(
          400,
          'This receipt is generated from a reservation deposit. Edit the reservation and the receipt will follow.'
        );
      }

      const unit = body.unitId || body.unitNumber ? resolveUnit(db, body) : findUnitOrFail(db, original.unitId);
      const updated: Payment = {
        ...original,
        payerName: requireString(body.payerName ?? original.payerName, 'Payer name', 120),
        unitId: unit.id,
        unitNumber: unit.number,
        category: requireEnum(body.category ?? original.category, PAYMENT_CATEGORIES, 'Payment category'),
        amount: requirePositiveAmount(body.amount ?? original.amount, 'Payment amount'),
        currency: requireCurrency(body.currency ?? original.currency),
        date: requireDay(body.date ?? original.date, 'Payment date'),
        method: requireEnum(body.method ?? original.method, PAYMENT_METHODS, 'Payment method'),
        reference: optionalString(body.reference ?? original.reference, 120),
        notes: optionalString(body.notes ?? original.notes, 2000)
      };
      if (updated.date > today()) bad('A payment cannot be dated in the future.');

      db.payments[idx] = updated;
      const who = actor(req);
      addAudit(db, who.name, who.role, `Corrected settled receipt ${original.receiptNo}`, 'Payment', id, original, updated, who.name);
      return updated;
    });
    res.json({ success: true, payment });
  })
);

app.post(
  '/api/payments/:id/reverse',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'reverse_payment');
    const { id } = req.params;
    const reversalReason = String(req.body?.reversalReason ?? '').trim();
    if (reversalReason.length < 5) bad('A reversal reason of at least 5 characters is required.');

    const payment = await transaction(db => {
      const target = db.payments.find(p => p.id === id);
      if (!target) throw new ApiError(404, 'Payment not found.');
      if (target.status === 'reversed') throw new ApiError(400, 'That receipt has already been voided.');

      const before = { ...target };
      const who = actor(req);
      target.status = 'reversed';
      target.reversedBy = who.name;
      target.reversalReason = reversalReason;
      target.reversalDate = today();

      // Keep linked records honest.
      if (target.bookingId) {
        const booking = db.bookings.find(b => b.id === target.bookingId);
        if (booking) {
          const bBefore = { ...booking };
          booking.depositPaid = 0;
          booking.balanceDue = booking.amount;
          addAudit(db, who.name, who.role, 'Cleared reservation deposit after receipt was voided', 'Booking', booking.id, bBefore, booking);
        }
      }
      if (target.utilityId) {
        const utility = db.utilities.find(u => u.id === target.utilityId);
        if (utility) {
          utility.status = 'unpaid';
          delete utility.paymentId;
          addAudit(db, who.name, who.role, 'Reopened utility bill after receipt was voided', 'Utility', utility.id, 'paid', 'unpaid');
        }
      }

      addAudit(db, who.name, who.role, `Voided receipt ${target.receiptNo}`, 'Payment', id, before, target, who.name);
      return target;
    });
    res.json({ success: true, payment });
  })
);

/** Record that a receipt was rendered, so reprints are marked as such. */
app.post(
  '/api/payments/:id/mark-printed',
  handler(async (req: AuthedRequest, res) => {
    const { id } = req.params;
    const count = await transaction(db => {
      const payment = db.payments.find(p => p.id === id);
      if (!payment) throw new ApiError(404, 'Payment not found.');
      payment.printCount = (payment.printCount || 0) + 1;
      if (payment.printCount > 1) {
        const who = actor(req);
        addAudit(db, who.name, who.role, `Reprinted receipt ${payment.receiptNo} (copy #${payment.printCount})`, 'Payment', id, '', `printCount=${payment.printCount}`);
      }
      return payment.printCount;
    });
    res.json({ success: true, printCount: count });
  })
);

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

app.post(
  '/api/utilities',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'enter_utility');
    const body = req.body || {};

    const reading = await transaction(db => {
      const unit = resolveUnit(db, body);
      const billingPeriod = String(body.billingPeriod ?? '').trim();
      if (!isValidMonth(billingPeriod)) bad('Billing period is required in YYYY-MM format.');

      const duplicate = db.utilities.find(u => u.unitId === unit.id && u.billingPeriod === billingPeriod);
      if (duplicate) {
        throw new ApiError(400, `A reading for ${unit.number} covering ${billingPeriod} already exists. Edit that reading instead of adding a second one.`);
      }

      const previousReading = Math.max(0, Number(body.previousReading) || 0);
      const currentReading = Number(body.currentReading);
      if (!Number.isFinite(currentReading)) bad('The current meter reading is required.');
      if (currentReading < previousReading) {
        bad('The current reading is lower than the previous reading. Check the figures, or record a meter replacement in the notes.');
      }

      // Consumption is derived, never taken from the client.
      const consumption = round2(currentReading - previousReading);

      const who = actor(req);
      const created: UtilityReading = {
        id: `ut-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        unitId: unit.id,
        unitNumber: unit.number,
        meterNumber: unit.meterNumber || optionalString(body.meterNumber, 60),
        billingPeriod,
        previousReading,
        currentReading,
        consumption,
        amountCharged: requirePositiveAmount(body.amountCharged, 'Charge amount'),
        currency: requireCurrency(body.currency),
        status: 'unpaid'
      };
      db.utilities.push(created);
      addAudit(db, who.name, who.role, `Recorded utility reading for ${unit.number} (${billingPeriod})`, 'Utility', created.id, '', created);
      return created;
    });
    res.json({ success: true, utility: reading });
  })
);

app.put(
  '/api/utilities/:id',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'enter_utility');
    const { id } = req.params;
    const body = req.body || {};

    const reading = await transaction(db => {
      const idx = db.utilities.findIndex(u => u.id === id);
      if (idx === -1) throw new ApiError(404, 'Utility record not found.');
      const original = db.utilities[idx];
      if (original.status === 'paid' && !can(req.auth!, 'modify_settled')) {
        throw new ApiError(403, 'This utility bill is settled. Modifying settled records requires additional permission.');
      }

      const previousReading = Math.max(0, Number(body.previousReading ?? original.previousReading) || 0);
      const currentReading = Number(body.currentReading ?? original.currentReading);
      if (!Number.isFinite(currentReading)) bad('The current meter reading is required.');
      if (currentReading < previousReading) bad('The current reading cannot be lower than the previous reading.');

      const updated: UtilityReading = {
        ...original,
        previousReading,
        currentReading,
        consumption: round2(currentReading - previousReading),
        amountCharged: requirePositiveAmount(body.amountCharged ?? original.amountCharged, 'Charge amount'),
        currency: requireCurrency(body.currency ?? original.currency)
      };
      db.utilities[idx] = updated;
      const who = actor(req);
      addAudit(db, who.name, who.role, 'Updated utility reading', 'Utility', id, original, updated);
      return updated;
    });
    res.json({ success: true, utility: reading });
  })
);

/**
 * Settle a utility bill.
 *
 * Marking a bill "paid" used to change a flag and nothing else, so the money
 * never appeared in the receipts ledger, the dashboard or any report. Settling
 * now issues a real receipt, which is what makes the figure reconcilable.
 */
app.post(
  '/api/utilities/:id/settle',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'enter_utility');
    const { id } = req.params;
    const body = req.body || {};

    const result = await transaction(db => {
      const utility = db.utilities.find(u => u.id === id);
      if (!utility) throw new ApiError(404, 'Utility record not found.');
      if (utility.status === 'paid') throw new ApiError(400, 'That utility bill is already settled.');

      const unit = db.units.find(u => u.id === utility.unitId);
      const date = requireDay(body.date || today(), 'Payment date');
      if (date > today()) bad('A payment cannot be dated in the future.');
      const method = requireEnum(body.method || 'Cash', PAYMENT_METHODS, 'Payment method') as PaymentMethod;

      const who = actor(req);
      const payment: Payment = {
        id: `p-utility-${utility.id}`,
        receiptNo: nextReceiptNo(db),
        payerName: optionalString(body.payerName, 120) || unit?.ownerName || 'Resident',
        unitId: utility.unitId,
        unitNumber: utility.unitNumber,
        category: 'Utility',
        amount: utility.amountCharged,
        currency: utility.currency,
        date,
        method,
        reference: optionalString(body.reference, 120) || `UTIL-${utility.billingPeriod}`,
        notes:
          optionalString(body.notes, 2000) ||
          `Utility settlement for ${utility.billingPeriod} — ${utility.consumption} units on meter ${utility.meterNumber}.`,
        staffMember: who.name,
        status: 'completed',
        printCount: 0,
        utilityId: utility.id
      };
      db.payments.push(payment);
      utility.status = 'paid';
      utility.paymentId = payment.id;

      addAudit(db, who.name, who.role, `Settled utility bill for ${utility.unitNumber} (${utility.billingPeriod}) and issued receipt ${payment.receiptNo}`, 'Utility', utility.id, 'unpaid', 'paid');
      return { utility, payment };
    });
    res.json({ success: true, ...result });
  })
);

/* ------------------------------------------------------------------ *
 * Expenses
 * ------------------------------------------------------------------ */

function readExpenseFields(db: Database, body: Record<string, unknown>, existing?: Expense) {
  const isGeneral = !body.unitId && (!body.unitNumber || body.unitNumber === 'General');
  const unit = isGeneral ? undefined : resolveUnit(db, body);

  const status = requireEnum(body.status ?? existing?.status ?? 'paid', ['paid', 'pending'] as const, 'Expense status');
  const date = requireDay(body.date ?? existing?.date ?? today(), 'Expense date');
  const dueDate = body.dueDate || existing?.dueDate ? requireDay(body.dueDate ?? existing?.dueDate, 'Due date') : date;
  const datePaidRaw = body.datePaid ?? existing?.datePaid;
  const datePaid = status === 'paid' ? requireDay(datePaidRaw || date, 'Date paid') : undefined;

  return {
    category: requireEnum(body.category ?? existing?.category, EXPENSE_CATEGORIES, 'Expense category'),
    vendor: requireString(body.vendor ?? existing?.vendor, 'Vendor or payee', 160),
    description: optionalString(body.description ?? existing?.description, 1000),
    unitId: unit?.id ?? '',
    unitNumber: unit?.number ?? 'General',
    amount: requirePositiveAmount(body.amount ?? existing?.amount, 'Expense amount'),
    currency: requireCurrency(body.currency ?? existing?.currency),
    date,
    dueDate,
    datePaid,
    paymentMethod: requireEnum(body.paymentMethod ?? existing?.paymentMethod ?? 'Bank Transfer', PAYMENT_METHODS, 'Payment method') as PaymentMethod,
    status,
    reference: optionalString(body.reference ?? existing?.reference, 120),
    notes: optionalString(body.notes ?? existing?.notes, 2000)
  };
}

app.post(
  '/api/expenses',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'record_expense');
    const expense = await transaction(db => {
      const fields = readExpenseFields(db, req.body || {});
      const who = actor(req);
      const created: Expense = { id: `ex-${Date.now()}-${Math.floor(Math.random() * 1000)}`, ...fields };
      db.expenses.push(created);
      addAudit(db, who.name, who.role, 'Recorded property expense', 'Expense', created.id, '', created);
      return created;
    });
    res.json({ success: true, expense });
  })
);

app.put(
  '/api/expenses/:id',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'record_expense');
    const { id } = req.params;
    const expense = await transaction(db => {
      const idx = db.expenses.findIndex(e => e.id === id);
      if (idx === -1) throw new ApiError(404, 'Expense not found.');
      const original = db.expenses[idx];
      if (original.status === 'paid' && !can(req.auth!, 'modify_settled')) {
        throw new ApiError(403, 'This expense is already settled. Modifying settled records requires additional permission.');
      }
      const updated: Expense = { ...original, ...readExpenseFields(db, req.body || {}, original) };
      db.expenses[idx] = updated;
      const who = actor(req);
      addAudit(db, who.name, who.role, 'Updated property expense', 'Expense', id, original, updated);
      return updated;
    });
    res.json({ success: true, expense });
  })
);

/* ------------------------------------------------------------------ *
 * Unit activity log
 * ------------------------------------------------------------------ */

app.post(
  '/api/unit-activities',
  handler(async (req: AuthedRequest, res) => {
    const body = req.body || {};
    const activity = await transaction(db => {
      const unit = resolveUnit(db, body);
      const who = actor(req);
      const created: UnitActivity = {
        id: `act-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        unitId: unit.id,
        unitNumber: unit.number,
        residentName: requireString(body.residentName, 'Resident name', 120),
        residentRole: requireEnum(body.residentRole ?? 'Owner', ['Owner', 'Tenant', 'Guest', 'Other'] as const, 'Resident capacity'),
        activityType: requireEnum(
          body.activityType,
          ['Construction Work', 'Pool Reservation', 'Maintenance Request', 'Noise / Event Notice', 'Amenity Access', 'Other Activity'] as const,
          'Activity type'
        ),
        dateCaptured: requireDay(body.dateCaptured, 'Date captured'),
        notes: requireString(body.notes, 'Activity notes', 4000),
        loggedBy: who.name,
        loggedAt: new Date().toISOString()
      };
      db.unitActivities.unshift(created);
      addAudit(db, who.name, who.role, `Logged resident activity (${created.activityType}) for ${unit.number}`, 'UnitActivity', created.id, '', created);
      return created;
    });
    res.json({ success: true, activity });
  })
);

app.delete(
  '/api/unit-activities/:id',
  handler(async (req: AuthedRequest, res) => {
    const { id } = req.params;
    await transaction(db => {
      const idx = db.unitActivities.findIndex(a => a.id === id);
      if (idx === -1) throw new ApiError(404, 'Activity entry not found.');
      const removed = db.unitActivities[idx];
      if (removed.loggedBy !== req.auth!.user.name && !can(req.auth!, 'edit_unit')) {
        throw new ApiError(403, 'You can only remove activity entries that you logged.');
      }
      db.unitActivities.splice(idx, 1);
      const who = actor(req);
      addAudit(db, who.name, who.role, `Deleted resident activity (${removed.activityType}) for ${removed.unitNumber}`, 'UnitActivity', id, removed, '');
    });
    res.json({ success: true });
  })
);

/* ------------------------------------------------------------------ *
 * iCalendar feeds
 * ------------------------------------------------------------------ */

app.post(
  '/api/ical/feeds',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'manage_settings');
    const body = req.body || {};
    const feed = await transaction(db => {
      const unit = resolveUnit(db, body);
      const url = requireString(body.url, 'Feed URL', 2000);
      if (!/^https?:\/\//i.test(url)) bad('The feed URL must start with http:// or https://');
      if (db.settings.icalFeeds.some(f => f.url === url && f.unitId === unit.id)) {
        throw new ApiError(400, 'That feed is already linked to this villa.');
      }
      const created: ICalFeed = {
        id: `feed-${Date.now()}`,
        unitId: unit.id,
        unitNumber: unit.number,
        url,
        source: requireEnum(body.source ?? 'Airbnb', ['Airbnb', 'Booking.com', 'Other'] as const, 'Feed source'),
        active: true
      };
      db.settings.icalFeeds.push(created);
      const who = actor(req);
      addAudit(db, who.name, who.role, `Linked a ${created.source} calendar feed to ${unit.number}`, 'ICalFeed', created.id, '', { unit: unit.number, source: created.source });
      return created;
    });
    res.json({ success: true, feed });
  })
);

app.delete(
  '/api/ical/feeds/:id',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'manage_settings');
    const { id } = req.params;
    await transaction(db => {
      const idx = db.settings.icalFeeds.findIndex(f => f.id === id);
      if (idx === -1) throw new ApiError(404, 'Feed not found.');
      const [removed] = db.settings.icalFeeds.splice(idx, 1);
      const who = actor(req);
      addAudit(db, who.name, who.role, `Removed the calendar feed for ${removed.unitNumber}`, 'ICalFeed', id, removed, '');
    });
    res.json({ success: true });
  })
);

interface SyncOutcome {
  feedId: string;
  unitNumber: string;
  source: string;
  ok: boolean;
  imported: number;
  updated: number;
  unchanged: number;
  conflicts: string[];
  error?: string;
}

/**
 * Pull one feed and reconcile it into the reservations table.
 * Idempotent: an event is matched by its UID, so re-syncing updates rather than duplicates.
 */
async function syncFeed(feedId: string, staffName: string, role: UserRole): Promise<SyncOutcome> {
  const feed = read(db => db.settings.icalFeeds.find(f => f.id === feedId));
  if (!feed) throw new ApiError(404, 'Feed not found.');

  const fetched = await fetchICal(feed.url);
  if (!fetched.ok || !fetched.text) {
    const outcome: SyncOutcome = {
      feedId,
      unitNumber: feed.unitNumber,
      source: feed.source,
      ok: false,
      imported: 0,
      updated: 0,
      unchanged: 0,
      conflicts: [],
      error: fetched.error
    };
    await transaction(db => {
      const live = db.settings.icalFeeds.find(f => f.id === feedId);
      if (live) {
        live.lastSyncAt = new Date().toISOString();
        live.lastStatus = 'error';
        live.lastResult = fetched.error || 'Unknown error';
      }
      addAudit(db, staffName, role, `Calendar sync failed for ${feed.unitNumber}`, 'ICalFeed', feedId, '', fetched.error || '');
    });
    return outcome;
  }

  const events = parseICal(fetched.text);

  return transaction(db => {
    const live = db.settings.icalFeeds.find(f => f.id === feedId)!;
    const unit = db.units.find(u => u.id === live.unitId);
    if (!unit) throw new ApiError(400, 'The villa linked to this feed no longer exists.');

    let imported = 0;
    let updated = 0;
    let unchanged = 0;
    const conflicts: string[] = [];

    for (const event of events) {
      if (!event.start || !event.end || event.end <= event.start) continue;
      const { isReservation, guestName } = classifyEvent(event);

      const existing = db.bookings.find(b => b.externalUid === event.uid && b.unitId === unit.id);

      // Does it clash with something that did not come from this feed?
      const clash = db.bookings.find(
        b =>
          b.unitId === unit.id &&
          b.status !== 'cancelled' &&
          b.externalUid !== event.uid &&
          bookingsOverlap(event.start, event.end, b.checkIn, b.checkOut)
      );
      if (clash) {
        conflicts.push(`${event.start} to ${event.end} clashes with ${clash.guestName} (${clash.source})`);
        continue;
      }

      if (existing) {
        if (existing.checkIn === event.start && existing.checkOut === event.end && existing.guestName === guestName) {
          unchanged++;
          continue;
        }
        const before = { ...existing };
        existing.checkIn = event.start;
        existing.checkOut = event.end;
        existing.guestName = guestName;
        existing.importedAt = new Date().toISOString();
        updated++;
        addAudit(db, staffName, role, `Updated imported reservation from ${live.source}`, 'Booking', existing.id, before, existing);
      } else {
        const created: Booking = {
          id: `b-ical-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          unitId: unit.id,
          unitNumber: unit.number,
          guestName,
          guestEmail: '',
          guestPhone: '',
          checkIn: event.start,
          checkOut: event.end,
          source: live.source === 'Booking.com' ? 'Booking.com' : live.source === 'Airbnb' ? 'Airbnb' : 'Blocked',
          amount: 0,
          currency: unit.currency,
          depositPaid: 0,
          balanceDue: 0,
          status: isReservation ? 'confirmed' : 'confirmed',
          notes:
            (isReservation
              ? `Imported from the ${live.source} calendar. The platform feed does not carry pricing — enter the stay value manually.`
              : `Owner block imported from the ${live.source} calendar.`) + (event.description ? `\n${event.description}` : ''),
          externalUid: event.uid,
          externalFeedId: live.id,
          importedAt: new Date().toISOString()
        };
        if (!isReservation) created.source = 'Blocked';
        db.bookings.push(created);
        imported++;
      }
    }

    live.lastSyncAt = new Date().toISOString();
    live.lastStatus = 'ok';
    live.lastResult = `${imported} imported, ${updated} updated, ${unchanged} unchanged, ${conflicts.length} conflict(s).`;

    addAudit(db, staffName, role, `Synchronised the ${live.source} calendar for ${unit.number}`, 'ICalFeed', feedId, '', live.lastResult);

    return {
      feedId,
      unitNumber: unit.number,
      source: live.source,
      ok: true,
      imported,
      updated,
      unchanged,
      conflicts
    };
  });
}

app.post(
  '/api/ical/sync',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'add_booking');
    const who = actor(req);
    const feedId = req.body?.feedId ? String(req.body.feedId) : undefined;
    const feeds = read(db => db.settings.icalFeeds.filter(f => f.active && (!feedId || f.id === feedId)));
    if (feeds.length === 0) {
      throw new ApiError(400, 'There are no active calendar feeds to synchronise. Add one in System Settings first.');
    }
    const results: SyncOutcome[] = [];
    for (const feed of feeds) {
      results.push(await syncFeed(feed.id, who.name, who.role));
    }
    res.json({ success: true, results });
  })
);

/* ------------------------------------------------------------------ *
 * Static / dev server
 * ------------------------------------------------------------------ */

app.use('/api', (req, res) => res.status(404).json({ error: `Unknown API route: ${req.method} ${req.path}` }));

async function startServer() {
  bootstrap();
  // Backups run on a timer, not only at boot, so an always-on server still gets
  // a daily copy.
  startBackupSchedule();

  if (!IS_PROD) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Villaggio Del Sol operations server running at http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('[vds] failed to start:', err);
  process.exit(1);
});
