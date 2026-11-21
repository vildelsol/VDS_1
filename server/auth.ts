/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Authentication and authorisation.
 *
 * Previously the browser told the server which role it was ("userRole" in the
 * request body) and the server believed it, so anyone could send
 * `{"userRole":"ADMINISTRATOR"}` and bypass every control, and the audit trail
 * recorded whatever name the client claimed. Roles now come only from a signed
 * server-side session.
 *
 * Password hashing uses scrypt from node's crypto module — no external
 * dependency, and resistant to GPU cracking.
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { Database, StoredUser, Session, fullPermissions, noPermissions, transaction } from './db';
import { RolePermissions, SessionUser, UserRole } from '../src/types';

const SESSION_COOKIE = 'vds_session';
/**
 * How long a session lasts after it was last used — not after it was opened.
 *
 * This used to be a fixed twelve hours from sign-in, so a screen was signed out
 * at 8pm for someone who signed in at 8am however busy they were, and a program
 * left open overnight met the login screen on the first click next morning. Ro,
 * 2026-09-16, chose "stay signed in while it's open": every signed-in request
 * pushes the expiry forward, and the open application checks in on its own
 * (`SESSION_HEARTBEAT_MS` in App.tsx) so an untouched screen keeps itself alive.
 * Twelve hours is now how long a session survives with *nothing* holding it
 * open — the window closed, or the machine it was on switched off.
 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The longest a session can live, counted from sign-in, however often it is renewed.
 *
 * Renewal used to have no ceiling, so a stolen cookie stayed good for as long as somebody kept using it (a
 * heartbeat is enough). Longer than the idle window above, so an open screen still survives a working day and
 * the evening after it; shorter than for ever. VDS_SESSION_MAX_HOURS changes it.
 */
export const SESSION_MAX_AGE_MS = (Number(process.env.VDS_SESSION_MAX_HOURS) > 0 ? Number(process.env.VDS_SESSION_MAX_HOURS) : 16) * 60 * 60 * 1000;
/** Sessions one account may hold at once; signing in again past this ends the oldest. */
export const MAX_SESSIONS_PER_USER = 20;

/**
 * Renewals are written at most this often per session.
 *
 * A renewal has to reach db.json, or an HP restarting overnight would bring back
 * the expiry from sign-in and sign the screen out anyway. But the open application
 * checks in every few minutes, and a disk write for every one of those would be
 * waste. An hour's slack against a twelve-hour lifetime costs nothing.
 */
const SESSION_RENEW_EVERY_MS = 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

const scryptAsync = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key))));

/**
 * The same check as `verifyPassword`, off the event loop. scryptSync holds the whole server still for every
 * sign-in; a few hundred unauthenticated attempts at once stalled every other request for seconds. This does the
 * identical work on the thread pool, so a flood of attempts queues up instead of freezing the application.
 */
export async function verifyPasswordAsync(password: string, hash: string, salt: string): Promise<boolean> {
  if (!hash || !salt) return false;
  const candidate = await scryptAsync(password, salt);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/** The decoy check for an unknown account, without blocking. See `burnPasswordCheck`. */
export async function burnPasswordCheckAsync(password: string): Promise<void> {
  try {
    await verifyPasswordAsync(password, DECOY_HASH, DECOY_SALT);
  } catch {
    /* the decoy comparison can fail on nothing that matters */
  }
}

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * Do the work of checking a password against an account that does not exist.
 *
 * Sign-in deliberately gives the same answer whether or not the username is
 * real, but saying the same thing is not enough if it is said faster. Checking a
 * password is expensive on purpose — scrypt takes ~30ms — while failing to find
 * the account at all took under 6ms, so the clock answered the question the
 * message was refusing to: a six-fold difference, easily measured over the
 * network, that let anyone map which of the staff usernames were real before
 * starting on the passwords.
 *
 * Burning the same work on a decoy closes the gap. The comparison can never
 * succeed — the decoy salt and hash are generated fresh at start-up and belong
 * to no account.
 */
const DECOY_SALT = crypto.randomBytes(16).toString('hex');
const DECOY_HASH = crypto.scryptSync(crypto.randomBytes(32).toString('hex'), DECOY_SALT, SCRYPT_KEYLEN).toString('hex');

export function burnPasswordCheck(password: string): void {
  try {
    verifyPassword(password, DECOY_HASH, DECOY_SALT);
  } catch {
    /* the decoy comparison can fail on nothing that matters */
  }
}

/**
 * Passwords everybody tries first, and this property's own names. Compared with every digit, symbol and case
 * stripped (after undoing the usual substitutions), so "Password123!", "P@ssw0rd!" and "Welcome1!" are all caught
 * while a long passphrase that merely contains a word is not.
 */
const COMMON_PASSWORD_WORDS = new Set([
  'password', 'passwort', 'welcome', 'admin', 'administrator', 'letmein', 'qwerty', 'qwertyuiop', 'changeme', 'secret',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'football', 'baseball', 'master', 'login', 'test', 'testing', 'guest', 'user',
  'default', 'temp', 'temporary', 'summer', 'winter', 'spring', 'autumn', 'hello', 'abc', 'abcdef', 'abcdefgh', 'trustno',
  'villaggio', 'villaggiodelsol', 'delsol', 'villaggiodel', 'sol', 'riveroaks', 'oaks', 'ochorios', 'ocho', 'rios', 'jamaica',
  'strata', 'vds', 'vdsadmin', 'newpassword'
]);

/** At least 10 characters with some variety, and not a password everybody tries. Returns null when acceptable. */
export const MAX_PASSWORD_LENGTH = 200;

export function passwordComplaint(password: unknown): string | null {
  // A non-string (an object, a number) used to be read through String() and became "[object Object]".
  if (typeof password !== 'string') return 'Password must be text.';
  const value = password;
  if (value.length > MAX_PASSWORD_LENGTH) return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  if (value.length < 10) return 'Password must be at least 10 characters long.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(value)).length;
  if (classes < 3) {
    return 'Password must combine at least three of: lower case, upper case, numbers, symbols.';
  }
  // Letters only, after undoing a substitution (@ for a, 0 for o...) wherever it sits between two letters: a digit
  // on the end ("Password123!") is just stripped, it is not read as a letter.
  const SUBS: Record<string, string> = { '@': 'a', $: 's', '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't' };
  const letters = value
    .toLowerCase()
    .replace(/(?<=[a-z])[@$03457](?=[a-z])/g, ch => SUBS[ch] ?? ch)
    .replace(/[^a-z]/g, '');
  if (COMMON_PASSWORD_WORDS.has(letters)) {
    return 'That password is one of the first anybody would try. Choose something else, such as three unrelated words.';
  }
  return null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(raw);
    } catch {
      // A malformed escape is somebody else's junk, not a reason to fail the request.
      out[part.slice(0, idx).trim()] = raw;
    }
  }
  return out;
}

/**
 * Sessions are stored by a HASH of their token, never the token itself. db.json and every backup copy hold
 * the sessions; with plain tokens in them, anyone able to read one of those files could sign in as whoever was
 * signed in. The browser keeps the real token (in its cookie); the server keeps only what identifies it.
 */
export const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(db: Database, user: StoredUser): Session {
  const now = Date.now();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const session: Session = {
    token: hashToken(rawToken),
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.min(SESSION_TTL_MS, SESSION_MAX_AGE_MS)).toISOString(),
    lastSeenAt: new Date(now).toISOString()
  };
  // Expired sessions, and any past the absolute lifetime, were never pruned: 3,000 sign-ins left 3,000 sessions.
  db.sessions = db.sessions.filter(s => new Date(s.expiresAt).getTime() > now && now - new Date(s.createdAt).getTime() < SESSION_MAX_AGE_MS);
  db.sessions.push(session);
  // One account cannot hold an unbounded number: the oldest of its sessions end.
  const mine = db.sessions.filter(s => s.userId === user.id);
  if (mine.length > MAX_SESSIONS_PER_USER) {
    const drop = new Set(mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, mine.length - MAX_SESSIONS_PER_USER).map(s => s.token));
    db.sessions = db.sessions.filter(s => !drop.has(s.token));
  }
  // The caller gets the real token to put in the cookie; the stored copy carries only its hash.
  return { ...session, token: rawToken };
}

export function destroySession(db: Database, token: string) {
  db.sessions = db.sessions.filter(s => s.token !== hashToken(token));
}

export function destroyAllSessionsFor(db: Database, userId: string) {
  db.sessions = db.sessions.filter(s => s.userId !== userId);
}

export function setSessionCookie(res: Response, token: string, secure: boolean, maxAgeMs: number = SESSION_TTL_MS) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`
  ];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res: Response) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

/* ------------------------------------------------------------------ *
 * Known devices: a random id in an HttpOnly cookie, issued at a successful sign-in and kept server-side only as a
 * hash, tied to the account it was issued for. The sign-in throttle gives such a browser a bucket of its own.
 * ------------------------------------------------------------------ */

export const DEVICE_COOKIE = 'vds_device';
const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_DEVICES_PER_USER = 8;

export function readDeviceCookie(req: Request): string | undefined {
  const v = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  return v && /^[0-9a-f]{64}$/.test(v) ? v : undefined;
}

/** The hash of the device cookie, if it was issued to THIS user and has not lapsed; otherwise null. */
export function knownDeviceKey(db: Database, userId: string, rawId: string | undefined): string | null {
  if (!rawId) return null;
  const id = hashToken(rawId);
  const cutoff = Date.now() - DEVICE_TTL_MS;
  const d = (db.knownDevices || []).find(x => x.id === id && x.userId === userId && new Date(x.lastSeenAt).getTime() > cutoff);
  return d ? id : null;
}

/**
 * Inside the sign-in transaction: refresh this browser's record, or make one. Returns the raw id to put in the
 * cookie when a new one was made, otherwise undefined.
 */
export function rememberDevice(db: Database, userId: string, rawId: string | undefined): string | undefined {
  const now = new Date().toISOString();
  const list = (db.knownDevices = (db.knownDevices || []).filter(x => new Date(x.lastSeenAt).getTime() > Date.now() - DEVICE_TTL_MS));
  const known = rawId ? list.find(x => x.id === hashToken(rawId) && x.userId === userId) : undefined;
  if (known) {
    known.lastSeenAt = now;
    return undefined;
  }
  const fresh = crypto.randomBytes(32).toString('hex');
  list.push({ id: hashToken(fresh), userId, createdAt: now, lastSeenAt: now });
  const mine = list.filter(x => x.userId === userId);
  if (mine.length > MAX_DEVICES_PER_USER) {
    const drop = new Set(mine.sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt)).slice(0, mine.length - MAX_DEVICES_PER_USER).map(x => x.id));
    db.knownDevices = list.filter(x => !drop.has(x.id));
  }
  return fresh;
}

export function setDeviceCookie(res: Response, rawId: string, secure: boolean) {
  const attrs = [`${DEVICE_COOKIE}=${rawId}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(DEVICE_TTL_MS / 1000)}`];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

/**
 * Whether to mark the session cookie `Secure`.
 *
 * A `Secure` cookie is only sent back over HTTPS. The property runs on a plain
 * HTTP LAN (Kamrui → HP over http://hp-name:3000), so forcing Secure by build
 * mode would drop the cookie and break sign-in there. Decide per request from the
 * actual connection instead: secure only when the request genuinely arrived over
 * TLS, or when an operator explicitly opts in with VDS_FORCE_SECURE_COOKIE=true.
 *
 * `req.secure` is Express's own answer and already accounts for the configured
 * proxy trust: it honours `x-forwarded-proto` from a reverse proxy the operator
 * has declared via VDS_TRUST_PROXY, and ignores that header otherwise. Reading the
 * header directly, as this used to, believed whatever an unproxied client claimed.
 */
export function isRequestSecure(req: Request): boolean {
  if (process.env.VDS_FORCE_SECURE_COOKIE === 'true') return true;
  return req.secure;
}

export function readSessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function permissionsFor(db: Database, role: UserRole): RolePermissions {
  if (role === 'ADMINISTRATOR') return fullPermissions();
  const configured = db.settings.rolePermissions?.[role as 'MANAGER' | 'FINANCE_OFFICER' | 'JUNIOR_OFFICER'];
  return { ...noPermissions(), ...(configured || {}) };
}

export function toSessionUser(db: Database, user: StoredUser): SessionUser {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    position: user.position,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    permissions: permissionsFor(db, user.role)
  };
}

export interface AuthedRequest extends Request {
  auth?: { user: StoredUser; session: Session; permissions: RolePermissions };
}

/** Resolve the current user for a request, or undefined when not signed in. */
export function resolveAuth(db: Database, req: Request): AuthedRequest['auth'] | undefined {
  const token = readSessionToken(req);
  if (!token) return undefined;
  const session = db.sessions.find(s => s.token === hashToken(token));
  if (!session) return undefined;
  if (new Date(session.expiresAt).getTime() <= Date.now() || Date.now() - new Date(session.createdAt).getTime() >= SESSION_MAX_AGE_MS) {
    destroySession(db, token);
    return undefined;
  }
  const user = db.users.find(u => u.id === session.userId);
  if (!user || !user.active) return undefined;
  session.lastSeenAt = new Date().toISOString();
  return { user, session, permissions: permissionsFor(db, user.role) };
}

/**
 * Seed the very first administrator. The password is either taken from
 * VDS_ADMIN_PASSWORD or generated and printed once to the server console; it
 * must be changed on first sign-in.
 */
export function ensureBootstrapAdmin(db: Database): string | null {
  if (db.users.length > 0) return null;
  const password = process.env.VDS_ADMIN_PASSWORD || `VdsAdmin-${crypto.randomBytes(4).toString('hex')}!`;
  const { hash, salt } = hashPassword(password);
  db.users.push({
    id: `user-${Date.now()}`,
    name: 'System Administrator',
    username: 'admin',
    email: '',
    position: 'General Administrator',
    role: 'ADMINISTRATOR',
    active: true,
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
    passwordHash: hash,
    passwordSalt: salt
  });
  return password;
}

/**
 * Reset an existing administrator's password, for when it has been lost and
 * nobody can sign in to use the normal "reset password" screen — that screen
 * itself requires being signed in as someone with permission to manage staff,
 * which is no help if the only administrator is the one locked out.
 *
 * Never touches an account that is not already an ADMINISTRATOR, so this cannot
 * be used to escalate any other role. A fresh password is generated rather than
 * accepted as an argument, so a real password is never left sitting in a file on
 * disk; the account is forced to change it at next sign-in, exactly like a brand
 * new account, and every existing session for it is ended so a stolen session
 * cannot survive the reset.
 */
export function resetAdministratorPassword(db: Database, username: string): string | null {
  const user = db.users.find(u => u.username === username.trim().toLowerCase());
  if (!user || user.role !== 'ADMINISTRATOR') return null;
  const password = `VdsReset-${crypto.randomBytes(4).toString('hex')}!`;
  const { hash, salt } = hashPassword(password);
  user.passwordHash = hash;
  user.passwordSalt = salt;
  user.mustChangePassword = true;
  user.active = true;
  destroyAllSessionsFor(db, user.id);
  return password;
}

/** Actions gated by the permission matrix. */
export type GatedAction =
  | 'record_payment'
  | 'add_booking'
  | 'edit_booking'
  | 'cancel_booking'
  | 'edit_unit'
  | 'enter_utility'
  | 'record_expense'
  | 'post_charges'
  | 'reverse_payment'
  | 'modify_settled'
  | 'take_backups'
  | 'reconcile_bank'
  | 'override_money_guard'
  | 'manage_settings'
  | 'manage_users';

const ACTION_TO_PERMISSION: Record<Exclude<GatedAction, 'manage_settings' | 'manage_users'>, keyof RolePermissions> = {
  record_payment: 'recordPayments',
  add_booking: 'addBookings',
  edit_booking: 'editBookings',
  cancel_booking: 'cancelBookings',
  edit_unit: 'editUnits',
  enter_utility: 'enterUtilities',
  record_expense: 'recordExpenses',
  post_charges: 'postCharges',
  reverse_payment: 'reversePayments',
  modify_settled: 'modifySettledRecords',
  take_backups: 'takeBackups',
  reconcile_bank: 'reconcileBank',
  override_money_guard: 'overrideMoneyGuards'
};

export function can(auth: NonNullable<AuthedRequest['auth']>, action: GatedAction): boolean {
  if (auth.user.role === 'ADMINISTRATOR') return true;
  if (action === 'manage_users') return false; // administrators only
  if (action === 'manage_settings') {
    return auth.user.role === 'MANAGER' || !!auth.permissions.hasVetoPower;
  }
  return !!auth.permissions[ACTION_TO_PERMISSION[action]];
}

export const ACTION_DENIED_MESSAGE: Record<GatedAction, string> = {
  record_payment: 'Your role is not permitted to record payments or issue receipts.',
  add_booking: 'Your role is not permitted to create reservations.',
  edit_booking: 'Your role is not permitted to modify reservations.',
  cancel_booking: 'Your role is not permitted to cancel reservations or issue refunds.',
  edit_unit: 'Your role is not permitted to edit the unit register.',
  enter_utility: 'Your role is not permitted to record utility readings.',
  record_expense: 'Your role is not permitted to record property expenses.',
  post_charges: 'Your role is not permitted to post monthly charges.',
  reverse_payment: 'Your role is not permitted to reverse payments or void receipts.',
  modify_settled: 'Your role is not permitted to modify settled ledger records.',
  take_backups: 'Your role is not permitted to take or download backups.',
  reconcile_bank: 'Your role is not permitted to tick items off against the bank statement.',
  override_money_guard: 'Only an Administrator can override this check. Ask one to record it, or correct the entry so the check passes.',
  manage_settings: 'Only Administrators and Managers can change system settings.',
  manage_users: 'Only Administrators can manage staff accounts.'
};

/** Whether this session has been used long enough since its last renewal to renew again. */
export function sessionRenewalDue(session: Session, now: number): boolean {
  const absoluteEnd = new Date(session.createdAt).getTime() + SESSION_MAX_AGE_MS;
  // Already running to its absolute end: renewing changes nothing, so nothing is written.
  if (new Date(session.expiresAt).getTime() >= absoluteEnd) return false;
  return new Date(session.expiresAt).getTime() - now <= SESSION_TTL_MS - SESSION_RENEW_EVERY_MS;
}

/**
 * Push a session's expiry forward because it has just been used.
 *
 * Three copies of the expiry have to move together, and each was a way to be
 * signed out anyway:
 *   - the live database, so the next request sees it at once;
 *   - db.json, so a server restart does not bring back the old expiry;
 *   - the browser's cookie, whose `Max-Age` was set at sign-in and would be
 *     deleted by the browser at the original time whatever the server believed.
 */
export function renewSession(req: Request, res: Response, session: Session): void {
  const now = Date.now();
  if (!sessionRenewalDue(session, now)) return;
  // Never past the absolute lifetime, whatever the renewals say.
  const expiryMs = Math.min(now + SESSION_TTL_MS, new Date(session.createdAt).getTime() + SESSION_MAX_AGE_MS);
  const expiresAt = new Date(expiryMs).toISOString();
  session.expiresAt = expiresAt;
  // The cookie carries the real token the browser already holds; the stored session only has its hash.
  const rawToken = readSessionToken(req);
  if (rawToken) setSessionCookie(res, rawToken, isRequestSecure(req), expiryMs - now);
  transaction(db => {
    /*
     * In the ordinary case the line below changes nothing: the live session was
     * already moved above, and this transaction writes a copy of it. It is for the
     * narrow race where another transaction was mid-flight, took its copy before
     * the renewal, and replaces the live database when it finishes — this one
     * runs after it and puts the renewal back. Mutation testing confirms the
     * suite does not produce that race; the save itself it does cover.
     *
     * Signed out in the meantime: nothing to renew, and nothing is resurrected.
     */
    const stored = db.sessions.find(s => s.token === session.token);
    if (stored) stored.expiresAt = expiresAt;
  }).catch(err => {
    // Not the request's failure: it is already answered, and the live copy holds
    // until the server restarts. Said out loud rather than dropped.
    console.error(`[auth] could not save a session renewal: ${(err as Error).message}`);
  });
}

/** Express middleware: require a signed-in user. */
export function requireAuth(getDb: () => Database) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const auth = resolveAuth(getDb(), req);
    if (!auth) {
      return res.status(401).json({ error: 'Not signed in.', code: 'UNAUTHENTICATED' });
    }
    renewSession(req, res, auth.session);
    req.auth = auth;
    next();
  };
}

export { SESSION_COOKIE, SESSION_TTL_MS, SESSION_RENEW_EVERY_MS };
