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
import fs from 'fs';
import { execFileSync, spawn } from 'child_process';
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
  PROPERTY_LOCATIONS,
  Tenancy,
  Unit,
  ONE_OFF_CHARGE_TYPES,
  OneOffChargeType,
  UNIT_STATUSES,
  WORK_STATUSES,
  WorkStatus,
  UNIT_STATUS_LABELS,
  UnitActivity,
  UtilityReading,
  UserRole,
  RolePermissions,
  ICalFeed,
  getUnitDisplayName
} from './src/types';
import { formatMoneyLong, round2, toMoney } from './src/lib/money';
import { formatDayLabel, isValidDay, isValidMonth, today, dueDateForMonth, monthOf, monthStart, nightsBetween } from './src/lib/dates';
import { accountBalance, bookingsOverlap, chargeAmount, chargeCurrency, chargePayer, isBillable } from './src/lib/finance';
import {
  DATA_DIR,
  DB_FILE,
  Database,
  addAudit,
  backupStatus,
  checkBackupTarget,
  getDb,
  nextReceiptNo,
  noPermissions,
  read,
  runDailyBackup,
  setExternalBackupDir,
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
  isRequestSecure,
  passwordComplaint,
  permissionsFor,
  readSessionToken,
  requireAuth,
  resetAdministratorPassword,
  resolveAuth,
  setSessionCookie,
  toSessionUser,
  verifyPassword
} from './server/auth';
import { assertFetchableFeedUrl, classifyEvent, fetchICal, parseICal } from './server/ical';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

/**
 * Proxy trust is OFF unless an operator turns it on.
 *
 * This used to be `trust proxy: true` unconditionally, so Express believed the
 * `X-Forwarded-For` header on every request. On the property's direct LAN there is
 * no proxy to set that header — which meant any client could invent one. Since the
 * sign-in throttle is keyed on the client address, an attacker got a fresh bucket
 * per request and could guess passwords without limit (measured: 25 of 25 spoofed
 * attempts sailed past a throttle that had already fired).
 *
 * Set VDS_TRUST_PROXY only when the server genuinely sits behind a reverse proxy
 * you control: `true` (trust any hop), a hop count such as `1`, or a comma
 * separated list of trusted proxy addresses/subnets.
 */
const TRUST_PROXY = String(process.env.VDS_TRUST_PROXY || '').trim();
if (!TRUST_PROXY || TRUST_PROXY === 'false') {
  app.set('trust proxy', false);
} else if (TRUST_PROXY === 'true') {
  app.set('trust proxy', true);
} else if (/^\d+$/.test(TRUST_PROXY)) {
  app.set('trust proxy', Number(TRUST_PROXY));
} else {
  app.set('trust proxy', TRUST_PROXY);
}

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
  /**
   * `code` marks a refusal the browser has to do something about beyond showing
   * the text — offering the override that turns it into a deliberate act. Matching
   * on the wording instead would break the moment anyone rephrased the sentence.
   */
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
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

/**
 * Run a transaction whose result the response does not wait for — an audit note
 * attached to an action that has already happened.
 *
 * These were written as `void transaction(...)`, which leaves the rejection
 * unhandled. Node treats an unhandled rejection as fatal, so a failure to write
 * the audit note (a full disk, a read-only data folder) would take the whole
 * server down rather than logging and carrying on.
 */
function auditInBackground(label: string, fn: (db: Database) => void) {
  transaction(fn).catch(err => {
    console.error(`[vds] could not record the audit entry for ${label}:`, (err as Error).message);
  });
}

/** Wrap an async handler so thrown ApiErrors become clean JSON responses. */
function handler(fn: (req: AuthedRequest, res: express.Response) => Promise<unknown> | unknown) {
  return async (req: AuthedRequest, res: express.Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ApiError) {
        return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
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

/**
 * A readable id derived from a parent record, guaranteed not to collide.
 *
 * Charges and the receipts raised from a booking or a utility bill take their id
 * from the record they belong to (`chg-2026-07-unit-1-rent`, `p-utility-ut-123`),
 * which reads well in the audit trail. But those ids are only unique while the
 * parent is settled once. Voiding a charge and re-posting the month, or voiding a
 * utility receipt and settling the bill again, both produced a *second* row with
 * the *same* id — and every lookup here uses `.find()`, which returns the voided
 * one. The live charge or receipt then became impossible to void through the API.
 *
 * The base id is still used whenever it is free, so existing records keep the ids
 * they already have; a repeat gets `-r2`, `-r3`, and so on.
 */
function uniqueRecordId(rows: { id: string }[], baseId: string): string {
  if (!rows.some(r => r.id === baseId)) return baseId;
  let revision = 2;
  while (rows.some(r => r.id === `${baseId}-r${revision}`)) revision++;
  return `${baseId}-r${revision}`;
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

/**
 * Seed the first administrator, inside a transaction.
 *
 * This used to create the account by mutating the loaded database directly and
 * then rely on a later write to persist it. Transactions now hand the handler a
 * copy and only commit it on success, so an edit made outside one is not part of
 * any write — the seeded administrator would have existed in memory only and been
 * gone at the next restart. Creating it in the transaction means the account is on
 * disk before the port opens.
 */
async function bootstrap() {
  await transaction(db => {
    bootstrapPassword = ensureBootstrapAdmin(db);
    if (bootstrapPassword) {
      addAudit(db, 'System', 'ADMINISTRATOR', 'Created bootstrap administrator account', 'User', 'admin', '', 'username: admin');
    }
  });
  if (bootstrapPassword) {
    console.log('\n' + '='.repeat(72));
    console.log('  FIRST RUN — an administrator account has been created.');
    console.log('    username: admin');
    console.log(`    password: ${bootstrapPassword}`);
    console.log('  You will be required to change this password at first sign-in.');
    console.log('='.repeat(72) + '\n');
  }
}

const RESET_ADMIN_MARKER = 'RESET-ADMIN-PASSWORD.txt';

/**
 * Recover a lost administrator password — the one gap the normal "reset
 * password" screen cannot cover, since that screen itself requires being signed
 * in as an administrator.
 *
 * Triggered only by a marker file dropped into the data folder, on this
 * machine's own file system — never over the network, so nothing reachable from
 * the Kamrui or from Tailscale can set this off. The file's content, if any, is
 * the username to reset (blank or missing defaults to "admin"). It is deleted
 * the instant it is read, before the reset is even attempted, so leaving it
 * behind by accident cannot repeat the reset on a later restart, and a failed
 * attempt does not loop.
 */
async function resetAdminPasswordIfRequested() {
  const markerPath = path.join(DATA_DIR, RESET_ADMIN_MARKER);
  if (!fs.existsSync(markerPath)) return;

  let requested = 'admin';
  try {
    const content = fs.readFileSync(markerPath, 'utf-8').trim();
    if (content) requested = content;
  } catch {
    /* fall back to 'admin' */
  }
  try {
    fs.unlinkSync(markerPath);
  } catch {
    /* best effort — proceed with the reset regardless */
  }

  const password = await transaction(db => {
    const result = resetAdministratorPassword(db, requested);
    if (result) {
      addAudit(
        db,
        'System',
        'ADMINISTRATOR',
        `Administrator password reset from the console for "${requested}"`,
        'User',
        requested,
        '',
        `Reset via ${RESET_ADMIN_MARKER}`
      );
    }
    return result;
  });

  if (password) {
    console.log('\n' + '='.repeat(72));
    console.log('  ADMINISTRATOR PASSWORD RESET');
    console.log(`    username: ${requested}`);
    console.log(`    password: ${password}`);
    console.log('  You will be required to change this password at next sign-in.');
    console.log('='.repeat(72) + '\n');
  } else {
    console.log(
      `\n  [vds] ${RESET_ADMIN_MARKER} was found, but no administrator account named "${requested}" exists.\n` +
        '  Nothing was reset. The file has been removed.\n'
    );
  }
}

/* ------------------------------------------------------------------ *
 * Auth routes (unauthenticated)
 * ------------------------------------------------------------------ */

const loginAttempts = new Map<string, { count: number; first: number }>();
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Count a failed sign-in against a bucket, refusing once it is over its limit.
 *
 * Two buckets are checked per attempt: one per (address, username) and a looser
 * one per username. The second exists because an attacker on the LAN can hold more
 * than one address, and the account being guessed at is the thing worth protecting.
 * Its limit is set well above anything a person mistyping their own password will
 * reach.
 */
function bumpAttempt(key: string, limit: number) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > THROTTLE_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    throw new ApiError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  }
}

/** Drop buckets whose window has closed, so the map cannot grow without bound. */
function pruneLoginAttempts() {
  const cutoff = Date.now() - THROTTLE_WINDOW_MS;
  for (const [key, entry] of loginAttempts) {
    if (entry.first < cutoff) loginAttempts.delete(key);
  }
}

function throttleLogin(ip: string, username: string) {
  if (loginAttempts.size > 1000) pruneLoginAttempts();
  bumpAttempt(`ip:${ip}:${username}`, 10);
  bumpAttempt(`user:${username}`, 30);
}

function clearLoginAttempts(ip: string, username: string) {
  loginAttempts.delete(`ip:${ip}:${username}`);
  loginAttempts.delete(`user:${username}`);
}

app.post(
  '/api/auth/login',
  handler(async (req, res) => {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!username || !password) bad('Username and password are required.');
    throttleLogin(req.ip || 'unknown', username);

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
    clearLoginAttempts(req.ip || 'unknown', username);
    setSessionCookie(res, result.token, isRequestSecure(req));
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

/**
 * Hold an account to its forced password change.
 *
 * A new or reset account is issued a password by whoever created it, and that
 * person knows it. The sign-in screen sends such a user straight to "choose a new
 * password", but that was the only thing standing in the way — the API itself was
 * happy to accept work from an account still on its handed-over password, so
 * anyone who knew it could record payments as that member of staff.
 *
 * Reads stay open so the app can render, and so does signing out. Everything that
 * writes is refused until the password has actually been changed.
 */
const PASSWORD_CHANGE_ALLOWED = new Set(['/auth/change-password', '/auth/logout']);

app.use('/api', (req: AuthedRequest, res, next) => {
  if (!req.auth?.user.mustChangePassword) return next();
  if (!MUTATING.has(req.method)) return next();
  if (PASSWORD_CHANGE_ALLOWED.has(req.path)) return next();
  return res.status(403).json({
    error: 'Choose a new password before recording anything. Your account is still on the password it was issued with.',
    code: 'PASSWORD_CHANGE_REQUIRED'
  });
});

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

/**
 * Test whether a folder can be used for off-machine backups, without saving it.
 *
 * Actually writes and deletes a probe file: an unplugged external drive, a
 * read-only volume and a mistyped drive letter are indistinguishable from a
 * path check alone, and the difference is the whole point of the feature.
 */
app.post(
  '/api/backup/check-folder',
  handler((req: AuthedRequest, res) => {
    requirePermission(req, 'manage_settings');
    const dir = optionalString(req.body?.dir, 400);
    res.json({ success: true, ...checkBackupTarget(dir) });
  })
);

/** Take a backup now, on top of the scheduled daily one. */
app.post(
  '/api/backup/run',
  handler((req: AuthedRequest, res) => {
    requirePermission(req, 'manage_settings');
    const written = runDailyBackup(true);
    const who = actor(req);
    auditInBackground('a manual backup', db => {
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
    auditInBackground('a records snapshot download', db2 => {
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
    const { rolePermissions, vendors, fxRateJmdPerUsd, backupDir } = req.body || {};

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

      if (backupDir !== undefined) {
        // Saved even when the folder is not reachable this second: an external
        // drive is routinely unplugged, and refusing to remember its path would
        // mean re-typing it every time it comes back. The response reports
        // reachability so the screen can say so, and each daily attempt records
        // its own outcome.
        db.settings.backupDir = optionalString(backupDir, 400);
        setExternalBackupDir(db.settings.backupDir || '');
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

/**
 * Raise the move-in rent: this month, plus the tenant's final month in advance.
 *
 * "First and last" is how a tenancy starts here — two months' rent up front,
 * where the second one buys the last month of occupancy rather than this one. Both
 * are ordinary Rent charges so they land in the ledger, the arrears list, the
 * dashboard and the notifications hub the moment the move-in date is known,
 * without waiting for anyone to press Post month. What makes the advance different
 * is only that closing the tenancy spends it instead of charging that month again.
 *
 * Does nothing without a move-in date (the month would be a guess), without a rent
 * figure, or if this tenancy has already had it — so it is safe to call again when
 * a date is corrected later.
 */
function raiseFirstAndLastRent(db: Database, tenancy: Tenancy, staffName: string, role: UserRole): boolean {
  if (!tenancy.startedOn) return false;
  if (tenancy.advanceRentChargeId) return false;
  const amount = round2(tenancy.monthlyRent);
  if (!(amount > 0)) return false;

  const unit = db.units.find(u => u.id === tenancy.unitId);
  if (!unit) return false;

  const month = monthOf(tenancy.startedOn);
  const dueDay = tenancy.rentDueDay || unit.rentDueDay || 1;
  const currency = tenancy.currency || unit.currency;

  // The tenant's first month. Skipped if a charge for it already exists, so a
  // month posted before the tenant was recorded is not billed twice.
  const alreadyBilled = db.charges.some(
    c => c.unitId === unit.id && c.category === 'Rent' && c.periodMonth === month && c.status === 'open'
  );
  if (!alreadyBilled) {
    const first: Charge = {
      id: uniqueRecordId(db.charges, `chg-${month}-${unit.id}-rent`),
      unitId: unit.id,
      unitNumber: unit.number,
      category: 'Rent',
      periodMonth: month,
      dueDate: dueDateForMonth(month, dueDay),
      amount,
      currency,
      status: 'open',
      payerName: tenancy.tenantName,
      description: `First month's rent — ${month}`,
      createdAt: new Date().toISOString(),
      createdBy: staffName
    };
    db.charges.push(first);
    addAudit(db, staffName, role, `Billed first month's rent for ${tenancy.tenantName} at ${unit.number}`, 'Charge', first.id, '', first);
  }

  const advance: Charge = {
    id: uniqueRecordId(db.charges, `chg-${month}-${unit.id}-rent-advance`),
    unitId: unit.id,
    unitNumber: unit.number,
    category: 'Rent',
    periodMonth: month,
    dueDate: dueDateForMonth(month, dueDay),
    amount,
    currency,
    status: 'open',
    payerName: tenancy.tenantName,
    kind: 'advance-final-month',
    description: "Last month's rent, held in advance",
    createdAt: new Date().toISOString(),
    createdBy: staffName
  };
  db.charges.push(advance);
  tenancy.advanceRentChargeId = advance.id;
  addAudit(
    db,
    staffName,
    role,
    `Billed last month's rent in advance for ${tenancy.tenantName} at ${unit.number} — their final month will not be charged again`,
    'Charge',
    advance.id,
    '',
    advance
  );
  return true;
}

/**
 * Spend the advance on the month the tenant actually leaves.
 *
 * They paid for their last month at move-in, so that month must not be charged a
 * second time. If a charge for it has already been raised — because the month was
 * posted before they gave notice — it is voided with the reason recorded, which
 * removes it from the balance, the arrears list and the hub. If it has not been
 * raised yet, there is nothing to void and the advance is simply marked as spent.
 */
function applyAdvanceRentOnMoveOut(db: Database, tenancy: Tenancy, endedOn: string, staffName: string, role: UserRole) {
  if (!tenancy.advanceRentChargeId || tenancy.advanceRentAppliedOn) return;

  const finalMonth = monthOf(endedOn);
  const advance = db.charges.find(c => c.id === tenancy.advanceRentChargeId);
  // An advance that was voided (a correction, or an eviction write-off) was never
  // really held, so there is nothing to spend.
  if (!advance || advance.status !== 'open') return;

  const finalCharge = db.charges.find(
    c =>
      c.unitId === tenancy.unitId &&
      c.category === 'Rent' &&
      c.periodMonth === finalMonth &&
      c.status === 'open' &&
      c.kind !== 'advance-final-month'
  );

  tenancy.advanceRentAppliedOn = endedOn;

  if (finalCharge) {
    finalCharge.status = 'void';
    finalCharge.voidedBy = staffName;
    finalCharge.voidedAt = new Date().toISOString();
    finalCharge.voidReason = "Covered by last month's rent paid in advance at move-in.";
    addAudit(
      db,
      staffName,
      role,
      `Applied ${tenancy.tenantName}'s advance to their final month (${finalMonth}) at ${tenancy.unitNumber} — that month is not charged again`,
      'Charge',
      finalCharge.id,
      'open',
      'void — covered by rent paid in advance'
    );
  } else {
    addAudit(
      db,
      staffName,
      role,
      `${tenancy.tenantName}'s final month (${finalMonth}) at ${tenancy.unitNumber} is covered by rent paid in advance and will not be charged`,
      'Tenancy',
      tenancy.id,
      '',
      `Advance applied on ${endedOn}`
    );
  }
}

function closeTenancy(
  db: Database,
  tenancy: Tenancy,
  endedOn: string,
  reason: string,
  closedBy: string,
  role: UserRole = 'ADMINISTRATOR'
) {
  tenancy.status = 'ended';
  tenancy.endedOn = endedOn;
  tenancy.endReason = reason;
  tenancy.closedBy = closedBy;
  // Their last month was paid for at move-in; do not charge it twice.
  applyAdvanceRentOnMoveOut(db, tenancy, endedOn, closedBy, role);
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
function syncTenancy(
  db: Database,
  unit: Unit,
  original: Unit,
  staffName: string,
  role: UserRole,
  /** The real move-in date, when whoever is recording the tenant knows it. */
  movedInOn?: string
): string {
  const current = activeTenancy(db, unit.id);
  const wantsTenant = unit.status === 'long-term' && !!unit.tenantName.trim();
  const stamp = today();

  if (!wantsTenant) {
    if (current) {
      const reason =
        unit.status !== 'long-term'
          ? `Unit status changed from ${original.status} to ${unit.status}.`
          : 'Tenant removed from the unit register.';
      closeTenancy(db, current, stamp, reason, staffName, role);
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
    closeTenancy(db, current, stamp, `Replaced by ${unit.tenantName.trim()}.`, staffName, role);
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
    // Only a changeover genuinely starts today. The first time a tenant is
    // recorded against a villa, the register is usually being filled in for
    // people who already live there — stamping today invented a move-in date for
    // tenants of several years, and then refused to backdate their move-out or
    // eviction to the day it actually happened ("cannot fall before the move-in
    // date"). Unknown is left unknown, exactly as the migration does, and staff
    // can set the real date on the tenancy record.
    startedOn: movedInOn || (current ? stamp : ''),
    status: 'active',
    recordedBy: staffName,
    recordedAt: new Date().toISOString()
  };
  db.tenancies.push(tenancy);
  addAudit(db, staffName, role, `Opened tenancy for ${tenancy.tenantName} at ${unit.number}`, 'Tenancy', tenancy.id, '', tenancy);

  // First and last month's rent, owed from the moment the move-in date is known.
  const billed = raiseFirstAndLastRent(db, tenancy, staffName, role);
  const opened = current ? `tenant changed to ${tenancy.tenantName}` : `tenancy opened for ${tenancy.tenantName}`;
  return billed ? `${opened}; first and last month's rent billed` : opened;
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
      if (body.leaseEndsOn !== undefined) {
        if (body.leaseEndsOn === '') {
          delete record.leaseEndsOn;
        } else {
          const leaseEndsOn = requireDay(body.leaseEndsOn, 'Lease end date');
          if (record.startedOn && leaseEndsOn < record.startedOn) {
            bad('The lease cannot end before the tenant moved in.');
          }
          record.leaseEndsOn = leaseEndsOn;
        }
      }

      // A tenant recorded without a move-in date has no billable month yet. The
      // moment that date is supplied, the first and last month's rent is owed —
      // which is the point at which it should appear on the ledger and the hub.
      if (record.status === 'active' && record.startedOn) {
        const w = actor(req);
        raiseFirstAndLastRent(db, record, w.name, w.role);
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
        // Their final month was bought at move-in — do not charge it again.
        const closer = actor(req);
        applyAdvanceRentOnMoveOut(db, record, endedOn, closer.name, closer.role);

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
/**
 * Record a refundable security deposit taken from a tenant.
 *
 * A deposit is not rent and not income. It is the tenant's money the property
 * holds and is obliged to give back, less whatever is fairly deducted at the end.
 * So it is kept on the tenancy rather than raised as a charge or booked as a
 * payment: it must never reduce arrears, never appear in collections, and never
 * flatter an operating statement or a projection.
 */
app.post(
  '/api/tenancies/:id/deposit',
  handler(async (req: AuthedRequest, res) => {
    // Taking money from a tenant is the payment permission.
    requirePermission(req, 'record_payment');
    const { id } = req.params;
    const body = req.body || {};

    const tenancy = await transaction(db => {
      const record = db.tenancies.find(t => t.id === id);
      if (!record) throw new ApiError(404, 'Tenancy record not found.');
      if (record.depositReturnedOn) {
        throw new ApiError(400, 'This deposit has already been reconciled and returned. Record a new tenancy for a new deposit.');
      }

      const before = { ...record };
      const amount = requirePositiveAmount(body.amount, 'Deposit amount');
      const receivedOn = requireDay(body.receivedOn || today(), 'Date received');
      if (receivedOn > today()) bad('A deposit cannot be dated in the future.');

      record.depositAmount = amount;
      record.depositCurrency = requireCurrency(body.currency ?? record.currency ?? 'JMD');
      record.depositReceivedOn = receivedOn;

      const who = actor(req);
      addAudit(
        db,
        who.name,
        who.role,
        `Recorded a ${record.depositCurrency} ${amount} security deposit held for ${record.tenantName} at ${record.unitNumber}`,
        'Tenancy',
        record.id,
        before,
        record
      );
      return record;
    });
    res.json({ success: true, tenancy });
  })
);

/**
 * Reconcile the deposit when the tenant leaves: what goes back, what is kept.
 *
 * The two must add up to what was held — a deposit that half disappears is the
 * thing tenants take to a tribunal — and anything withheld needs a reason on the
 * record, because "we kept some of it" is not a defence. Withholding money does
 * not create income here either: if the property is recovering a real cost, that
 * cost is billed as a one-off charge and settled, which is where it belongs.
 */
app.post(
  '/api/tenancies/:id/deposit/settle',
  handler(async (req: AuthedRequest, res) => {
    // Deciding to keep someone's money is a veto-level act, like a write-off.
    requirePermission(req, 'reverse_payment');
    const { id } = req.params;
    const body = req.body || {};

    const tenancy = await transaction(db => {
      const record = db.tenancies.find(t => t.id === id);
      if (!record) throw new ApiError(404, 'Tenancy record not found.');
      if (!record.depositAmount) throw new ApiError(400, 'No deposit is held for this tenancy.');
      if (record.depositReturnedOn) throw new ApiError(400, 'This deposit has already been reconciled.');

      const before = { ...record };
      const withheld = Math.max(0, toMoney(body.withheldAmount ?? 0));
      const returned = Math.max(0, toMoney(body.returnedAmount ?? round2(record.depositAmount - withheld)));
      const settledOn = requireDay(body.settledOn || today(), 'Date settled');
      if (settledOn > today()) bad('A deposit cannot be settled in the future.');

      if (round2(withheld + returned) !== round2(record.depositAmount)) {
        bad(
          `Returned and withheld must add up to the ${record.depositCurrency} ${record.depositAmount} held. ` +
            `That is ${record.depositCurrency} ${round2(withheld + returned)}.`
        );
      }
      const reason = optionalString(body.withheldReason, 1000);
      if (withheld > 0 && reason.length < 5) {
        bad('Give a reason for the amount withheld. It is kept permanently and is what justifies the deduction.');
      }

      record.depositReturnedOn = settledOn;
      record.depositReturnedAmount = returned;
      record.depositWithheldAmount = withheld;
      record.depositWithheldReason = reason;

      const who = actor(req);
      addAudit(
        db,
        who.name,
        who.role,
        `Reconciled the deposit for ${record.tenantName} at ${record.unitNumber}: ` +
          `${record.depositCurrency} ${returned} returned, ${record.depositCurrency} ${withheld} withheld`,
        'Tenancy',
        record.id,
        before,
        record
      );
      return record;
    });
    res.json({ success: true, tenancy });
  })
);

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
      const movedInOn = body.tenantMovedInOn ? requireDay(body.tenantMovedInOn, 'Move-in date') : undefined;
      if (movedInOn && movedInOn > today()) bad('The move-in date cannot be in the future.');
      const tenancyNote = syncTenancy(db, updatedUnit, original, who.name, who.role, movedInOn);

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
          // Only an ordinary monthly charge counts as "this month is posted".
          // A one-off (a late fee, a recharged repair) and the move-in advance
          // both carry the same period month, and counting them here would make
          // posting believe the month was already billed and silently skip the
          // actual rent.
          const exists = db.charges.some(
            c =>
              c.unitId === unit.id &&
              c.category === category &&
              c.periodMonth === monthString &&
              c.status === 'open' &&
              c.kind === undefined
          );
          if (exists) {
            skipped.push(`${unit.number}/${category}`);
            continue;
          }
          const dueDay = category === 'Rent' ? unit.rentDueDay || 1 : unit.maintDueDay || 1;
          const charge: Charge = {
            // Re-posting a month after a charge was voided must raise a *new*
            // charge, not a second row wearing the voided one's id.
            id: uniqueRecordId(db.charges, `chg-${monthString}-${unit.id}-${category.toLowerCase()}`),
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
/**
 * Raise a one-off charge against a villa's account.
 *
 * Posting a month covers the rent and the HOA fee. Everything else a property
 * actually bills — a late fee, a repair recharged to the tenant who caused it, a
 * breach fine, an amenity fee, legal costs, a special assessment — had no home at
 * all, so that money was either lost or tracked on paper beside the system.
 *
 * These are billed onto an existing account rather than becoming accounts of
 * their own. A late fee lands on the tenant's rent balance; a special assessment
 * lands on the owner's maintenance balance. That keeps one balance per villa per
 * account, which is the rule everything else is built on, and means a one-off
 * ages into arrears and chases itself exactly like rent does.
 */
app.post(
  '/api/charges',
  handler(async (req: AuthedRequest, res) => {
    // Raising an obligation is the same authority as posting a month.
    requirePermission(req, 'post_charges');
    const body = req.body || {};

    const charge = await transaction(db => {
      const unit = resolveUnit(db, body);
      const category = requireEnum(body.category, ['Rent', 'Maintenance'] as const, 'Account') as ChargeCategory;
      const oneOffType = requireEnum(body.oneOffType, ONE_OFF_CHARGE_TYPES, 'Charge type') as OneOffChargeType;
      const amount = requirePositiveAmount(body.amount, 'Charge amount');
      const dueDate = requireDay(body.dueDate || today(), 'Due date');
      const description = optionalString(body.description, 300);

      // The account is billed in one currency; a charge in the other would sit on
      // the balance without ever being settleable by a payment against it.
      const expected = chargeCurrency(unit, category);
      const currency = body.currency ? requireCurrency(body.currency) : expected;
      if (currency !== expected) {
        bad(
          `${unit.number} is billed for ${category.toLowerCase()} in ${expected}. ` +
            `A ${currency} charge could never be settled against that balance, because the two are never combined.`
        );
      }

      const who = actor(req);
      const created: Charge = {
        id: uniqueRecordId(db.charges, `chg-oneoff-${unit.id}-${Date.now()}`),
        unitId: unit.id,
        unitNumber: unit.number,
        category,
        // Dated by its due date, so it lands in the right month's reporting.
        periodMonth: monthOf(dueDate),
        dueDate,
        amount,
        currency,
        status: 'open',
        payerName: chargePayer(unit, category),
        kind: 'one-off',
        oneOffType,
        description: description || oneOffType,
        createdAt: new Date().toISOString(),
        createdBy: who.name
      };
      db.charges.push(created);
      addAudit(
        db,
        who.name,
        who.role,
        `Raised a one-off ${oneOffType.toLowerCase()} of ${currency} ${amount} on ${unit.number} ${category.toLowerCase()} account`,
        'Charge',
        created.id,
        '',
        created
      );
      return created;
    });
    res.json({ success: true, charge });
  })
);

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
 *
 * Only the *live* receipt is ever touched. Matching on the booking alone found
 * voided receipts too, so restoring a deposit after its receipt was voided flipped
 * that receipt back to "completed" and deleted the reversal reason off it — a void
 * silently undone, which `PUT /api/payments/:id` explicitly refuses to allow.
 * Voiding is one-way here as well: a booking that regains a deposit gets a new
 * receipt with its own number, and the voided one stays voided.
 */
function syncBookingDepositReceipt(db: Database, booking: Booking, staffName: string, role: UserRole) {
  // Anything not voided counts as the live deposit receipt — including one that
  // is still awaiting confirmation. Matching only completed receipts would raise a
  // second one alongside every pending deposit.
  const live = db.payments.find(p => p.bookingId === booking.id && p.status !== 'reversed');

  if (booking.status === 'cancelled' || booking.depositPaid <= 0) {
    if (live) {
      const before = { ...live };
      live.status = 'reversed';
      live.reversedBy = staffName;
      live.reversalDate = today();
      live.reversalReason =
        booking.status === 'cancelled'
          ? 'Reservation cancelled — deposit receipt voided.'
          : 'Reservation deposit reduced to zero — deposit receipt voided.';
      addAudit(db, staffName, role, 'Voided booking deposit receipt', 'Payment', live.id, before, live, staffName);
    }
    return;
  }

  if (live) {
    if (live.amount !== booking.depositPaid || live.currency !== booking.currency) {
      const before = { ...live };
      live.amount = booking.depositPaid;
      live.currency = booking.currency;
      live.payerName = booking.guestName;
      live.unitId = booking.unitId;
      live.unitNumber = booking.unitNumber;
      addAudit(db, staffName, role, 'Adjusted booking deposit receipt to match the reservation', 'Payment', live.id, before, live);
    }
    return;
  }

  const payment: Payment = {
    id: uniqueRecordId(db.payments, `p-booking-${booking.id}`),
    receiptNo: '',
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
    status: 'pending',
    printCount: 0,
    bookingId: booking.id
  };
  db.payments.push(payment);
  addAudit(db, staffName, role, 'Logged an expected booking deposit — awaiting confirmation of receipt', 'Payment', payment.id, '', payment);
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

/**
 * Refuse money the account does not owe, judged at the moment it is banked.
 *
 * Two people working the same arrears list — or one person with the page open in
 * two tabs — both saw the same debt, both pressed "Receive payment", and both
 * were accepted: each request was checked against a world where the other had not
 * happened yet. The villa then read as being in credit for money that was only
 * ever collected once, which is the most expensive kind of wrong this application
 * can be. The idempotency key does not help, because these are two genuinely
 * different actions with two different keys, not one action retried.
 *
 * The check has to happen *here*, inside the transaction, against what the ledger
 * says right now. Anything the browser knew was fetched before the other person
 * saved.
 *
 * It is a refusal with an override rather than a hard block: paying two months up
 * front, or settling a debt the office knows about but has not posted yet, are
 * real things. What must not happen is either of them occurring by accident.
 *
 * Only Rent and Maintenance are covered — they are the only categories the charge
 * ledger models. A booking or utility receipt has its own record to answer to.
 */
const ALREADY_SETTLED = 'account-already-settled';

function assertAccountStillOwes(
  db: Database,
  unit: Unit,
  category: PaymentCategory,
  currency: Currency,
  amount: number,
  confirmed: boolean,
  { excludePaymentId, verb = 'This receipt is' }: { excludePaymentId?: string; verb?: string } = {}
) {
  if (confirmed) return;
  if (category !== 'Rent' && category !== 'Maintenance') return;
  // A payment in the wrong currency does not reduce this balance at all; the
  // currency-mismatch check owns that case and gives better advice than this one.
  if (currency !== chargeCurrency(unit, category)) return;

  // The same helper every screen derives from, so the refusal and the balance the
  // user is looking at can never disagree. The entry being confirmed is excluded
  // so it is not weighed against itself.
  const payments = excludePaymentId ? db.payments.filter(p => p.id !== excludePaymentId) : db.payments;
  const account = accountBalance(unit, category, db.charges, payments, undefined, db.units);

  // Nothing has ever been billed here, so this is not a debt paid twice — it is
  // money arriving on an account that owes nothing, which the check above already
  // stops and already has its own acknowledgement. Asking a second time for the
  // same fact is how a warning becomes something people tick without reading.
  if (account.charged <= 0) return;

  const outstanding = account.balance;
  if (amount <= outstanding) return;

  const villa = getUnitDisplayName(unit.number);
  const money = (value: number) => formatMoneyLong(value, currency);

  // Name who banked it and when. "Someone already took this" is only actionable
  // if you can go and ask them.
  const lastReceipt = payments
    .filter(p => p.unitId === unit.id && p.category === category && p.status === 'completed' && p.currency === currency)
    .sort((a, b) => (b.receivedAt || b.date).localeCompare(a.receivedAt || a.date))[0];
  const alreadyTaken = lastReceipt
    ? ` The most recent was ${money(lastReceipt.amount)} on ${formatDayLabel(lastReceipt.date)}` +
      `${lastReceipt.receiptNo ? `, receipt ${lastReceipt.receiptNo}` : ''}` +
      `${lastReceipt.receivedBy ? `, taken by ${lastReceipt.receivedBy}` : ''}.`
    : '';

  const position =
    outstanding <= 0
      ? `${villa}'s ${category.toLowerCase()} account owes nothing — ${money(account.charged)} has been billed and ` +
        `${money(account.paid)} received.${alreadyTaken}`
      : `${villa}'s ${category.toLowerCase()} account only owes ${money(outstanding)}, but ${verb.toLowerCase()} for ` +
        `${money(amount)}.${alreadyTaken}`;

  throw new ApiError(
    400,
    `${position} Recording it would leave the account ${money(round2(amount - outstanding))} in credit. ` +
      `If somebody else has just taken this payment, do not record it again. ` +
      `If it is genuinely separate money — rent paid in advance, or a debt not yet posted — confirm to record it as a credit.`,
    ALREADY_SETTLED
  );
}

app.post(
  '/api/payments',
  handler(async (req: AuthedRequest, res) => {
    // Granted to every role by default, so the desk keeps working when nobody
    // senior is on site — but it is a permission, so it can be withdrawn.
    requirePermission(req, 'record_payment');
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

        // Money taken against an account with nothing billed becomes a credit
        // sitting on a villa that reads as owing nothing — the payment looks lost.
        // Say so before it happens rather than after.
        const hasOpenCharge = db.charges.some(
          c => c.unitId === unit.id && c.category === category && c.status === 'open' && c.currency === currency
        );
        if (!hasOpenCharge && !body.confirmNoOpenCharge) {
          // A villa that is not billed for this category at all needs different
          // advice from one that is simply not posted yet: telling someone to
          // post the month's charges is useless for an owner-occupied villa,
          // because posting would never raise a rent charge against it.
          const message = !isBillable(unit, category as ChargeCategory)
            ? `${unit.number} is ${UNIT_STATUS_LABELS[unit.status].toLowerCase()} and is not billed for ${category.toLowerCase()}. ` +
              (category === 'Rent'
                ? 'Owners pay HOA maintenance rather than rent — record it under Maintenance, or confirm to hold it as a credit.'
                : 'Set a monthly fee on the villa first, or confirm to hold it as a credit.')
            : `Nothing has been billed to ${unit.number} for ${category.toLowerCase()} yet, so this payment would be recorded as a credit ` +
              `rather than settling anything. Post the month's charges first, or confirm to record it as a credit on the account.`;
          throw new ApiError(400, message);
        }

        // And, last, the one the browser cannot possibly know: has this debt
        // already been settled while this form was open?
        assertAccountStillOwes(db, unit, category, currency, amount, body.confirmAlreadySettled === true);
      }

      const who = actor(req);

      /**
       * Two entry points, two different claims about reality.
       *
       * "Receive payment" — used on an arrears alert or a ledger row — means the
       * money is in hand right now, so the receipt is issued immediately and the
       * account stops being in arrears. "Record payment" logs something expected
       * but not yet arrived (a cheque, a promised transfer); it counts for
       * nothing until someone confirms it. The caller says which this is, because
       * only the person taking the money knows.
       */
      const receivedNow = body.receivedNow === true;

      const created: Payment = {
        id: `p-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        // A receipt number is proof money was received, so it exists only for
        // money that has been.
        receiptNo: receivedNow ? nextReceiptNo(db) : '',
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
        status: receivedNow ? 'completed' : 'pending',
        printCount: 0,
        ...(receivedNow ? { receivedBy: who.name, receivedAt: new Date().toISOString() } : {})
      };
      db.payments.push(created);
      addAudit(
        db,
        who.name,
        who.role,
        receivedNow
          ? `Received ${created.currency} ${created.amount} for ${unit.number} and issued receipt ${created.receiptNo}`
          : `Logged an expected ${created.category.toLowerCase()} payment of ${created.currency} ${created.amount} for ${unit.number} — awaiting confirmation of receipt`,
        'Payment',
        created.id,
        '',
        created
      );
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

/**
 * Confirm that an expected payment has actually been received.
 *
 * This is the moment money becomes real to the system: only now does the entry
 * get a receipt number, reduce a balance, count as income in the reports, and
 * settle any utility bill it was raised against. Everything before this is an
 * expectation, and every figure in the application is derived from confirmed
 * receipts alone.
 */
app.post(
  '/api/payments/:id/confirm',
  handler(async (req: AuthedRequest, res) => {
    requirePermission(req, 'record_payment');
    const { id } = req.params;
    const body = req.body || {};

    const payment = await transaction(db => {
      const target = db.payments.find(p => p.id === id);
      if (!target) throw new ApiError(404, 'Payment not found.');
      if (target.status === 'reversed') {
        throw new ApiError(400, 'That entry has been voided. Record a new payment instead.');
      }
      if (target.status === 'completed') {
        throw new ApiError(400, `That payment is already confirmed as received (receipt ${target.receiptNo}).`);
      }

      // The date money actually arrived may differ from the date it was logged.
      const receivedOn = requireDay(body.date || target.date, 'Date received');
      if (receivedOn > today()) bad('A payment cannot be dated in the future.');

      // Confirming is the moment an expectation becomes money on the ledger, so
      // it is also a moment the debt can already have been settled by someone
      // else — two expected cheques logged for one month, both then confirmed.
      // The entry being confirmed is excluded from the balance it is judged
      // against, or it would be counted as its own reason for refusal.
      const payee = db.units.find(u => u.id === target.unitId);
      if (payee) {
        assertAccountStillOwes(db, payee, target.category, target.currency, target.amount, body.confirmAlreadySettled === true, {
          excludePaymentId: target.id,
          verb: 'This entry is'
        });
      }

      const before = { ...target };
      const who = actor(req);
      target.status = 'completed';
      target.receiptNo = nextReceiptNo(db);
      target.date = receivedOn;
      target.receivedBy = who.name;
      target.receivedAt = new Date().toISOString();
      if (body.method !== undefined) {
        target.method = requireEnum(body.method, PAYMENT_METHODS, 'Payment method') as PaymentMethod;
      }
      if (body.reference !== undefined) target.reference = optionalString(body.reference, 120);

      // A utility bill is only settled once its payment is confirmed.
      if (target.utilityId) {
        const utility = db.utilities.find(u => u.id === target.utilityId);
        if (utility && utility.status !== 'paid') {
          utility.status = 'paid';
          utility.paymentId = target.id;
          addAudit(db, who.name, who.role, `Utility bill for ${utility.unitNumber} (${utility.billingPeriod}) settled by confirmed receipt ${target.receiptNo}`, 'Utility', utility.id, 'unpaid', 'paid');
        }
      }

      addAudit(
        db,
        who.name,
        who.role,
        `Confirmed receipt of ${target.currency} ${target.amount} and issued receipt ${target.receiptNo}`,
        'Payment',
        id,
        before,
        target,
        who.name
      );
      return target;
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
      if (target.status === 'reversed') throw new ApiError(400, 'That entry has already been voided.');
      const wasPending = target.status === 'pending';

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
          const wasPaid = utility.status === 'paid';
          utility.status = 'unpaid';
          delete utility.paymentId;
          addAudit(
            db,
            who.name,
            who.role,
            wasPaid ? 'Reopened utility bill after receipt was voided' : 'Cleared the expected payment from the utility bill',
            'Utility',
            utility.id,
            wasPaid ? 'paid' : 'unpaid (payment expected)',
            'unpaid'
          );
        }
      }

      addAudit(
        db,
        who.name,
        who.role,
        wasPending
          ? 'Cancelled an expected payment that was never received'
          : `Voided receipt ${target.receiptNo}`,
        'Payment',
        id,
        before,
        target,
        who.name
      );
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
    // Settling takes money and issues a receipt, so it needs the payment
    // permission as well — otherwise withdrawing "record payments" from a role
    // would leave this as an open side door to the same thing.
    requirePermission(req, 'enter_utility');
    requirePermission(req, 'record_payment');
    const { id } = req.params;
    const body = req.body || {};

    const result = await transaction(db => {
      const utility = db.utilities.find(u => u.id === id);
      if (!utility) throw new ApiError(404, 'Utility record not found.');
      if (utility.status === 'paid') throw new ApiError(400, 'That utility bill is already settled.');

      /**
       * The bill deliberately stays "unpaid" until its receipt is confirmed, so
       * the status check above does not catch a second person settling it in the
       * meantime — both would raise their own receipt for the same bill, and both
       * would then be confirmable. The live entry is what has to be checked.
       */
      const existing = db.payments.find(p => p.utilityId === utility.id && p.status !== 'reversed');
      if (existing) {
        throw new ApiError(
          400,
          existing.status === 'completed'
            ? `That utility bill has already been settled by receipt ${existing.receiptNo}` +
              `${existing.receivedBy ? `, taken by ${existing.receivedBy}` : ''}.`
            : `A payment for that utility bill has already been logged by ${existing.staffMember} and is awaiting ` +
              `confirmation that the money arrived. Confirm that entry from the receipts ledger rather than raising a second one.`,
          ALREADY_SETTLED
        );
      }

      const unit = db.units.find(u => u.id === utility.unitId);
      const date = requireDay(body.date || today(), 'Payment date');
      if (date > today()) bad('A payment cannot be dated in the future.');
      const method = requireEnum(body.method || 'Cash', PAYMENT_METHODS, 'Payment method') as PaymentMethod;

      const who = actor(req);
      const payment: Payment = {
        // Settling again after the first receipt was voided raises a fresh entry;
        // it must not reuse the voided one's id.
        id: uniqueRecordId(db.payments, `p-utility-${utility.id}`),
        // Issued at confirmation, not here — see the confirm route. Taking a
        // number now burned one on an entry that had received nothing.
        receiptNo: '',
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
        status: 'pending',
        printCount: 0,
        utilityId: utility.id
      };
      db.payments.push(payment);
      // The bill is NOT settled yet. Recording a settlement used to mark the bill
      // paid and issue a receipt in one move, which asserted that money had
      // arrived on the strength of someone opening a form. It stays unpaid, with
      // the expected receipt attached, until that receipt is confirmed.
      utility.paymentId = payment.id;

      addAudit(
        db,
        who.name,
        who.role,
        `Logged an expected utility payment for ${utility.unitNumber} (${utility.billingPeriod}) — awaiting confirmation of receipt`,
        'Utility',
        utility.id,
        'unpaid',
        'unpaid (payment expected)'
      );
      return { utility, payment };
    });
    res.json({ success: true, ...result });
  })
);

/* ------------------------------------------------------------------ *
 * Expenses
 * ------------------------------------------------------------------ */

function readExpenseFields(db: Database, body: Record<string, unknown>, existing?: Expense) {
  // A non-villa allocation ("General" / "Office") is identified by unitNumber with
  // no unitId; anything else must resolve to a real villa.
  const rawLocation = String(body.unitNumber ?? '').trim();
  const isNamedLocation = !body.unitId && (PROPERTY_LOCATIONS as readonly string[]).includes(rawLocation);
  const isUnspecified = !body.unitId && (!rawLocation || rawLocation === '');
  const unit = isNamedLocation || isUnspecified ? undefined : resolveUnit(db, body);
  const location: string = unit ? unit.number : isNamedLocation ? rawLocation : 'General';

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
    unitNumber: location,
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
        loggedAt: new Date().toISOString(),
        // Only a maintenance request is work to be tracked; everything else is a
        // record of something that already happened.
        ...(body.activityType === 'Maintenance Request'
          ? { workStatus: 'Reported' as WorkStatus, assignedTo: optionalString(body.assignedTo, 160) }
          : {})
      };
      db.unitActivities.unshift(created);
      addAudit(db, who.name, who.role, `Logged resident activity (${created.activityType}) for ${unit.number}`, 'UnitActivity', created.id, '', created);
      return created;
    });
    res.json({ success: true, activity });
  })
);

/**
 * Move a maintenance request along, and close it out.
 *
 * A request that can only be logged and deleted is a note. This is what turns it
 * into work: who has it, where it has got to, what it cost, and how it ended.
 * Recording a cost optionally raises the property expense at the same time, so
 * the money appears in the accounts without being typed twice — and the link is
 * kept so it cannot be raised again.
 */
app.put(
  '/api/unit-activities/:id',
  handler(async (req: AuthedRequest, res) => {
    const { id } = req.params;
    const body = req.body || {};

    const result = await transaction(db => {
      const activity = db.unitActivities.find(a => a.id === id);
      if (!activity) throw new ApiError(404, 'Activity entry not found.');
      if (activity.activityType !== 'Maintenance Request') {
        throw new ApiError(400, 'Only a maintenance request is tracked as work. Other activity entries are a record of something that happened.');
      }
      // The same rule as deleting one: your own, or the unit-register permission.
      if (activity.loggedBy !== req.auth!.user.name && !can(req.auth!, 'edit_unit')) {
        throw new ApiError(403, 'You can only update maintenance requests that you logged.');
      }

      const before = { ...activity };
      const who = actor(req);

      if (body.workStatus !== undefined) {
        activity.workStatus = requireEnum(body.workStatus, WORK_STATUSES, 'Work status') as WorkStatus;
      }
      if (body.assignedTo !== undefined) activity.assignedTo = optionalString(body.assignedTo, 160);
      if (body.outcome !== undefined) activity.outcome = optionalString(body.outcome, 2000);
      if (body.notes !== undefined) activity.notes = requireString(body.notes, 'Activity notes', 4000);

      if (body.costAmount !== undefined && body.costAmount !== '' && body.costAmount !== null) {
        activity.costAmount = requirePositiveAmount(body.costAmount, 'Cost');
        activity.costCurrency = requireCurrency(body.costCurrency ?? activity.costCurrency ?? 'JMD');
      }

      // Closing it needs a date; an open one must not carry a completion date.
      const closed = activity.workStatus === 'Completed' || activity.workStatus === 'Cancelled';
      if (closed) {
        activity.completedOn = requireDay(body.completedOn || activity.completedOn || today(), 'Completion date');
      } else {
        delete activity.completedOn;
      }

      /**
       * Raise the expense for the work, once.
       *
       * The cost of a repair is a property expense; without this it is recorded
       * on the request and then typed again into the expense register, or worse,
       * not at all. `expenseId` makes it idempotent — asking twice does nothing.
       */
      let expense: Expense | null = null;
      if (body.raiseExpense && !activity.expenseId) {
        if (!can(req.auth!, 'record_expense')) {
          throw new ApiError(403, 'Recording property expenses requires additional permission.');
        }
        // Thrown directly rather than through bad(), so the type narrows and the
        // amount below is known to exist.
        if (!activity.costAmount) {
          throw new ApiError(400, 'Enter what the work cost before raising the expense for it.');
        }
        const spentOn = activity.completedOn || today();
        const raised: Expense = {
          id: uniqueRecordId(db.expenses, `ex-work-${activity.id}`),
          category: 'Maintenance',
          vendor: activity.assignedTo || 'Maintenance',
          description: `Maintenance request at ${activity.unitNumber}: ${activity.notes}`.slice(0, 1000),
          unitId: activity.unitId,
          unitNumber: activity.unitNumber,
          amount: activity.costAmount,
          currency: activity.costCurrency || 'JMD',
          date: spentOn,
          dueDate: spentOn,
          datePaid: spentOn,
          paymentMethod: 'Bank Transfer',
          status: 'paid',
          reference: '',
          notes: activity.outcome || ''
        };
        db.expenses.push(raised);
        activity.expenseId = raised.id;
        expense = raised;
        addAudit(db, who.name, who.role, `Raised the property expense for maintenance work at ${activity.unitNumber}`, 'Expense', raised.id, '', raised);
      }

      addAudit(
        db,
        who.name,
        who.role,
        `Updated the maintenance request for ${activity.unitNumber} (${activity.workStatus || 'Reported'})`,
        'UnitActivity',
        activity.id,
        before,
        activity
      );
      return { activity, expense };
    });
    res.json({ success: true, ...result });
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

    // Checked here rather than inside the transaction: it does a DNS lookup, and
    // the transaction queue is serialized — every other write would wait on it.
    const url = requireString(body.url, 'Feed URL', 2000);
    if (!/^https?:\/\//i.test(url)) bad('The feed URL must start with http:// or https://');
    try {
      await assertFetchableFeedUrl(url);
    } catch (err) {
      throw new ApiError(400, `That feed URL cannot be used: ${(err as Error).message}`);
    }

    const feed = await transaction(db => {
      const unit = resolveUnit(db, body);
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

/**
 * Single Executable Application (SEA) support.
 *
 * `node:sea` is only meaningful once a build has actually been packaged with
 * Node's `--experimental-sea-config` step and had its client assets injected;
 * every other way of running this file — `npm run dev`, `npm start`, the
 * Windows `.bat` launcher, the automated tests — has no such packaging and must
 * carry on exactly as before. `isSea()` is the one call that tells the two
 * apart, so it gates everything below it. Guarded with a try/catch because the
 * module does not exist at all on Node versions old enough that a user's
 * machine could still be running one.
 */
async function loadSeaAssets(): Promise<typeof import('node:sea') | null> {
  try {
    const sea = await import('node:sea');
    return sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

const EMBEDDED_ASSET_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/** Serve the client shell from assets embedded in the executable, not disk. */
function serveEmbeddedAssets(sea: typeof import('node:sea')) {
  const indexHtml = Buffer.from(sea.getAsset('index.html'));
  return (req: express.Request, res: express.Response) => {
    // Express has already normalised req.path (collapsing "..", decoding
    // percent-escapes), so this is a defence-in-depth check, not the only one.
    const key = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
    if (!key.includes('..')) {
      try {
        const asset = sea.getAsset(key);
        res.setHeader('Content-Type', EMBEDDED_ASSET_MIME[path.extname(key)] || 'application/octet-stream');
        res.send(Buffer.from(asset));
        return;
      } catch {
        // Not an embedded file — fall through to the SPA shell below, exactly
        // like express.static() falling through to the "*" route today.
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(indexHtml);
  };
}

/**
 * Whether this process is a packaged single-file executable, resolved once at
 * start-up. Kept at module scope so the branch selection, the browser launcher
 * and the fatal-error handler all agree, including the top-level catch that runs
 * if bootstrap itself throws. Determined before bootstrap so even that failure
 * is handled the packaged way (window held open) rather than vanishing.
 */
let packagedExe = false;
let seaModule: Awaited<ReturnType<typeof loadSeaAssets>> = null;

/**
 * Require an explicit keypress before creating a brand new database.
 *
 * Only reached for a packaged executable with an interactive console and no
 * existing db.json — i.e. exactly the "just double-clicked somewhere new" case,
 * never the ordinary .bat/npm-start/test paths, and never a headless run (an
 * automated build's smoke test has no TTY, so this never blocks it).
 */
function confirmNewDatabase(): Promise<void> {
  return new Promise(resolve => {
    console.log(
      '\n' +
        '  ============================================================\n' +
        '     NEW DATABASE\n' +
        '  ============================================================\n\n' +
        '  No existing records were found in this folder:\n' +
        `    ${DATA_DIR}\n\n` +
        '  Continuing will create a brand new, EMPTY set of records here.\n\n' +
        '  Only do this on the ONE computer that should hold the real\n' +
        '  records (usually the office server). If you meant to connect\n' +
        "  to that computer's existing records instead, close this window\n" +
        '  now and open a web browser to its address — do not continue.\n'
    );
    process.stdout.write('  Press Enter to create a new database here, or close this window to cancel: ');
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function startServer() {
  seaModule = await loadSeaAssets();
  packagedExe = !!seaModule;

  // A double-clicked executable is easy to run on the wrong machine — most
  // dangerously, on a second PC that was only ever meant to be a client of the
  // one real office server. That silently starts a brand new, empty database
  // there, with no link back to the real records. Caught here, before bootstrap
  // creates anything: if no database exists yet and a person is actually sitting
  // at a real console (not a script or a CI run), make them confirm first.
  if (packagedExe && !fs.existsSync(DB_FILE) && process.stdin.isTTY) {
    await confirmNewDatabase();
  }

  await bootstrap();
  // Skipped when bootstrap just created the account fresh in this same start —
  // there is nothing to recover from a database that is seconds old.
  if (!bootstrapPassword) {
    await resetAdminPasswordIfRequested();
  }
  // Apply the backup folder chosen in settings before the schedule starts, so the
  // very first copy of the day already goes to the external drive rather than
  // waiting for someone to re-save settings.
  setExternalBackupDir(read(db => db.settings.backupDir || ''));

  // Backups run on a timer, not only at boot, so an always-on server still gets
  // a daily copy.
  startBackupSchedule();

  if (!IS_PROD && !packagedExe) {
    // Imported dynamically, and only here, so a production run — including one
    // packaged as a single executable with no node_modules alongside it — never
    // has to resolve the `vite` package at all. A static top-level import is
    // hoisted and evaluated unconditionally by the bundler regardless of which
    // branch runs, which used to mean dist/server.cjs required `vite` even in
    // production; that is why it was listed as a production dependency rather
    // than a dev one. This makes the dev server the only thing that needs it.
    //
    // `packagedExe` is checked as well as IS_PROD because double-clicking the
    // executable sets no environment variables at all: NODE_ENV is then unset,
    // IS_PROD is false, and without this guard the executable would take this
    // dev branch and try to import Vite — which is deliberately not bundled into
    // it — and crash on start-up. A packaged build is always production.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else if (packagedExe && seaModule) {
    // Packaged as a single executable: the client shell (index.html, JS, CSS,
    // icons) was embedded into the binary at build time rather than shipped as
    // a dist/ folder next to it. Nothing here touches the filesystem for
    // these files.
    app.use(serveEmbeddedAssets(seaModule));
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Villaggio Del Sol operations server running at http://localhost:${PORT}`);
    createDesktopShortcutIfNeeded();
    openBrowserIfAsked();
  });

  // A leftover copy of the program still holding the port is the single most
  // common start-up failure on the office PC. Say so in plain words rather than
  // printing a stack trace at someone who cannot act on it.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      void endFatally(
        `The program appears to be running already (port ${PORT} is in use).\n` +
          '  Close the other Villaggio Del Sol window, or restart this computer,\n' +
          '  then start the program again.'
      );
      return;
    }
    void fatalStartupError(err);
  });
}

/**
 * Create a Desktop shortcut to the packaged executable, the first time it runs.
 *
 * Only the old .bat launcher did this (via the same PowerShell technique). A
 * plain double-clicked .exe has no equivalent step, so day-to-day use meant
 * re-finding the file each time. Never overwrites an existing shortcut —
 * matching the .bat's own behaviour — so a shortcut someone made or repointed
 * themselves is left alone; this is purely a first-run convenience.
 */
function createDesktopShortcutIfNeeded() {
  if (!packagedExe || process.platform !== 'win32') return;
  const desktop = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : '';
  if (!desktop || !fs.existsSync(desktop)) return;
  const shortcutPath = path.join(desktop, 'Villaggio Del Sol.lnk');
  if (fs.existsSync(shortcutPath)) return;

  const exePath = process.execPath;
  const workDir = path.dirname(exePath);
  const esc = (s: string) => s.replace(/'/g, "''");
  const script =
    `$w = New-Object -ComObject WScript.Shell; ` +
    `$s = $w.CreateShortcut('${esc(shortcutPath)}'); ` +
    `$s.TargetPath = '${esc(exePath)}'; ` +
    `$s.WorkingDirectory = '${esc(workDir)}'; ` +
    `$s.Description = 'Villaggio Del Sol Property Operations'; ` +
    `$s.Save()`;

  try {
    // Run this to completion rather than detached-and-forgotten. A detached child
    // is not guaranteed to outlive its parent's process tree — that is why the
    // first attempt silently produced no shortcut at all — and swallowing the
    // error meant nothing ever said so. It costs about a second, once, before the
    // first request can arrive, and any failure is now reported.
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 20_000,
      stdio: 'ignore',
      windowsHide: true
    });
    console.log(`[vds] Desktop shortcut created: ${shortcutPath}`);
  } catch (err) {
    // A shortcut is a convenience, never a requirement — the program is already
    // running and must stay running.
    console.log(
      `[vds] could not create the Desktop shortcut (${err instanceof Error ? err.message : String(err)}).\n` +
        '      The program still works — right-click the file and choose "Send to → Desktop" if you want one.'
    );
  }
}

/**
 * Open the operator's browser, but only once the port is genuinely accepting
 * connections.
 *
 * The Windows launcher used to open the browser on a blind five-second timer in a
 * second console window, started *before* this process. On a first run — where the
 * database is created and the administrator password is hashed before the port
 * opens — the browser regularly arrived first and was left staring at a server
 * that was not answering yet. Waiting for the real "listening" callback removes
 * the race, and removes the mystery second window with it.
 *
 * A packaged executable opens the browser by default: it is double-clicked with
 * no wrapper to set VDS_OPEN_BROWSER, and a console window of server logs with no
 * app on screen reads as "it did not launch". Every other run opens the browser
 * only when explicitly asked (the .bat sets VDS_OPEN_BROWSER=1), so tests and
 * headless/service runs never do. VDS_OPEN_BROWSER=0 forces it off in all cases.
 *
 * When a Chromium browser (Chrome, or Edge — always present on Windows 10/11) is
 * available, it is opened in "app mode": a single clean window with no tabs and
 * no address bar, so the program looks and behaves like a desktop application
 * rather than a web page in a browser. If none is found, or app mode is turned
 * off with VDS_APP_MODE=0, it falls back to the default browser in an ordinary
 * window. Either way the server underneath is identical.
 */
function openBrowserIfAsked() {
  const explicit = process.env.VDS_OPEN_BROWSER;
  const shouldOpen = explicit === '1' || (packagedExe && explicit !== '0');
  if (!shouldOpen) return;
  const url = `http://localhost:${PORT}`;

  const chromium = process.env.VDS_APP_MODE === '0' ? null : findChromiumBrowser();
  if (chromium) {
    try {
      const child = spawn(chromium, [`--app=${url}`, '--window-size=1360,900'], { detached: true, stdio: 'ignore' });
      // If the app-mode launch itself errors, fall back to an ordinary window
      // rather than leave the user with a running server and nothing on screen.
      child.on('error', () => openInDefaultBrowser(url));
      child.unref();
      return;
    } catch {
      /* fall through to the default browser */
    }
  }
  openInDefaultBrowser(url);
}

/**
 * The path to an installed Chromium-based browser that supports `--app` windows,
 * or null if none is found. Chrome is preferred; Edge is the reliable fallback
 * because it ships with Windows. Paths are checked on disk rather than launched
 * speculatively, so the caller knows before it spawns anything.
 */
function findChromiumBrowser(): string | null {
  const exists = (p: string) => {
    try {
      return !!p && fs.existsSync(p);
    } catch {
      return false;
    }
  };
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    const candidates = [
      path.join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      path.join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
      path.join(localAppData, 'Google/Chrome/Application/chrome.exe'),
      path.join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(programFiles, 'Microsoft/Edge/Application/msedge.exe')
    ];
    return candidates.find(exists) || null;
  }
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
    return candidates.find(exists) || null;
  }
  return null;
}

/** Open a URL in the machine's default browser, in an ordinary window. */
function openInDefaultBrowser(url: string) {
  try {
    const [command, args] =
      process.platform === 'win32'
        ? // ComSpec is the authoritative path to the command interpreter; the bare
          // name is only a fallback. `start ""` needs the empty title argument, or
          // it treats the URL as the window title and opens nothing.
          [process.env.ComSpec || 'cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // A machine with no default browser must not take the server down with it.
    child.on('error', () => console.log(`[vds] could not open a browser — open ${url} yourself.`));
    child.unref();
  } catch {
    console.log(`[vds] could not open a browser — open ${url} yourself.`);
  }
}

/**
 * End the process on a fatal start-up problem, but leave a trace a person can
 * actually read.
 *
 * A double-clicked executable is given its own console window that closes the
 * instant the process exits — so an unhandled start-up error just makes the
 * window "flash and vanish", with nothing to go on. This writes the message to a
 * file next to the data as well, and, when running as that double-clicked
 * executable, holds the window open until a key is pressed so the error can be
 * read. Every non-packaged run (tests, npm start, the .bat, a service) exits
 * immediately as before.
 */
async function endFatally(message: string): Promise<never> {
  console.error('\n  ' + message + '\n');
  try {
    const logPath = path.join(process.env.VDS_DATA_DIR || process.cwd(), 'last-run-error.txt');
    fs.writeFileSync(logPath, `${new Date().toISOString()}\n${message}\n`);
    console.error(`  A copy of this was saved to:\n    ${logPath}\n`);
  } catch {
    /* best effort — the message is already on screen */
  }
  if (packagedExe && process.stdin.isTTY) {
    process.stderr.write('  Press Enter to close this window...');
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.once('data', () => resolve());
    });
  }
  process.exit(1);
}

function fatalStartupError(err: unknown): Promise<never> {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  return endFatally('The program could not start.\n\n  ' + detail);
}

startServer().catch(fatalStartupError);
