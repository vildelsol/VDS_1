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
 * Renewals are written at most this often per session.
 *
 * A renewal has to reach db.json, or an HP restarting overnight would bring back
 * the expiry from sign-in and sign the screen out anyway. But the open application
 * checks in every few minutes, and a disk write for every one of those would be
 * waste. An hour's slack against a twelve-hour lifetime costs nothing.
 */
const SESSION_RENEW_EVERY_MS = 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

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

/** At least 10 characters with some variety. Returns null when acceptable. */
export function passwordComplaint(password: string): string | null {
  const value = String(password || '');
  if (value.length < 10) return 'Password must be at least 10 characters long.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(value)).length;
  if (classes < 3) {
    return 'Password must combine at least three of: lower case, upper case, numbers, symbols.';
  }
  return null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function createSession(db: Database, user: StoredUser): Session {
  const now = Date.now();
  const session: Session = {
    token: crypto.randomBytes(32).toString('hex'),
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    lastSeenAt: new Date(now).toISOString()
  };
  db.sessions = db.sessions.filter(s => new Date(s.expiresAt).getTime() > now);
  db.sessions.push(session);
  return session;
}

export function destroySession(db: Database, token: string) {
  db.sessions = db.sessions.filter(s => s.token !== token);
}

export function destroyAllSessionsFor(db: Database, userId: string) {
  db.sessions = db.sessions.filter(s => s.userId !== userId);
}

export function setSessionCookie(res: Response, token: string, secure: boolean) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
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
  const session = db.sessions.find(s => s.token === token);
  if (!session) return undefined;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
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
  modify_settled: 'modifySettledRecords'
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
  manage_settings: 'Only Administrators and Managers can change system settings.',
  manage_users: 'Only Administrators can manage staff accounts.'
};

/** Whether this session has been used long enough since its last renewal to renew again. */
export function sessionRenewalDue(session: Session, now: number): boolean {
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
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  session.expiresAt = expiresAt;
  setSessionCookie(res, session.token, isRequestSecure(req));
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
