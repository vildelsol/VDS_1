/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The audit trail's hash chain. Kept in its own file so both the writer
 * (`addAudit`) and the checker (`checkIntegrity`) use the one definition without
 * importing each other.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { AuditLog } from '../src/types';

/** What an audit hash covers: everything a reader relies on, and the link to the entry before it. */
/**
 * Where the audit trail is trimmed, oldest first.
 *
 * It lived as a bare 20000 in two files: the trim in server/db.ts and the
 * "archive me" warning in server/integrity.ts. Change one and the warning
 * silently stops firing before the trim it is supposed to precede — a figure
 * pinned in two places that can go stale on either side. One definition, both
 * readers.
 */
export const AUDIT_CAP = 20000;

function entryPayload(e: AuditLog): string {
  return JSON.stringify([e.prevSeal || '', e.id, e.user, e.role, e.dateTime, e.action, e.recordType, e.recordId, e.previousValue, e.newValue, e.approvedBy || '']);
}

/**
 * The original, UNKEYED seal: plain SHA-256. Anyone who can edit db.json can read
 * this function and recompute every seal, so it only catches careless edits. Kept
 * because entries written before the key existed were sealed this way and must
 * still verify.
 */
export function auditEntryHash(e: AuditLog): string {
  return createHash('sha256').update(entryPayload(e)).digest('hex');
}

/* ------------------------------------------------------------------ *
 * The keyed seal (HMAC-SHA256).
 *
 * The key is generated on first run and kept in `audit-key.json` in the app data
 * folder, beside db.json but NOT inside it, readable by the owner only where the
 * OS allows. A backup or snapshot of db.json therefore does not carry the key,
 * and somebody who can edit db.json (a shared folder, a copied backup) cannot
 * re-seal a rewritten history without also having that file.
 *
 * The key file also records `keyedFrom`, the moment keyed sealing began: older
 * entries keep verifying the old way, any entry written after it must be keyed.
 *
 * A key file that is missing while the trail already holds keyed entries is never
 * silently regenerated over them: that would turn every genuine entry into one
 * that "fails" and hide real tampering in the noise. It is reported instead.
 * ------------------------------------------------------------------ */

export const AUDIT_KEY_FILE = 'audit-key.json';
export const KEYED_SEAL = 'hmac-sha256';

interface KeyRecord {
  version: 1;
  key: string;
  keyedFrom: string;
}
type KeyState = { ok: true; key: Buffer; keyedFrom: string } | { ok: false; problem: 'absent' | 'unreadable' };

let cachedKey: { file: string; state: Extract<KeyState, { ok: true }> } | null = null;

export function auditKeyPath(): string {
  return path.join(process.env.VDS_DATA_DIR || process.cwd(), AUDIT_KEY_FILE);
}

/** Read the key, never creating one. */
export function loadAuditKey(): KeyState {
  const file = auditKeyPath();
  if (cachedKey && cachedKey.file === file) return cachedKey.state;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, problem: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  try {
    const rec = JSON.parse(raw) as KeyRecord;
    const key = Buffer.from(String(rec.key || ''), 'hex');
    if (key.length < 32 || typeof rec.keyedFrom !== 'string' || !rec.keyedFrom) return { ok: false, problem: 'unreadable' };
    const state = { ok: true as const, key, keyedFrom: rec.keyedFrom };
    cachedKey = { file, state };
    return state;
  } catch {
    return { ok: false, problem: 'unreadable' };
  }
}

/** True when the trail holds entries that were sealed with the key. */
export function hasKeyedEntries(logs: AuditLog[]): boolean {
  return logs.some(e => e.sealKind === KEYED_SEAL);
}

/**
 * The key for writing. Generated on first run — but only when no keyed entry
 * exists yet. With keyed entries and no key, returns null (entries are then
 * sealed unkeyed, and the integrity check reports the missing key).
 */
function keyForWriting(logs: AuditLog[]): Buffer | null {
  const state = loadAuditKey();
  if (state.ok) return state.key;
  if (state.problem !== 'absent' || hasKeyedEntries(logs)) return null;
  const file = auditKeyPath();
  const rec: KeyRecord = { version: 1, key: randomBytes(32).toString('hex'), keyedFrom: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 'wx': never overwrite a key somebody else just wrote.
    fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* not supported here (Windows): the folder's own permissions apply */
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error(`[vds] could not create the audit key (${file}); audit entries stay unkeyed:`, (err as Error).message);
      return null;
    }
  }
  const after = loadAuditKey();
  return after.ok ? after.key : null;
}

export function keyedAuditHash(e: AuditLog, key: Buffer): string {
  return createHmac('sha256', key).update(KEYED_SEAL + '\u0000' + entryPayload(e)).digest('hex');
}

/** Seal a new entry onto the chain (newest-first `logs`). */
export function sealAuditEntry(entry: AuditLog, logs: AuditLog[]): void {
  entry.prevSeal = logs[0]?.seal || '';
  const key = keyForWriting(logs);
  if (key) {
    entry.sealKind = KEYED_SEAL;
    entry.seal = keyedAuditHash(entry, key);
  } else {
    delete entry.sealKind;
    entry.seal = auditEntryHash(entry);
  }
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a || '', 'utf8');
  const y = Buffer.from(b || '', 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface ChainCheck {
  /** Entries that were edited, inserted, removed or re-sealed. */
  broken: string[];
  /** Set when keyed entries exist but the key is absent or unreadable. */
  keyProblem?: 'absent' | 'unreadable';
}

/** Walk the chain oldest-first. */
export function verifyAuditChain(logs: AuditLog[]): ChainCheck {
  const key = loadAuditKey();
  const broken: string[] = [];
  let seenSealed = false;
  let seenKeyed = false;
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    const older = logs[i + 1];
    if (!e.seal) {
      if (seenSealed) broken.push(`${e.id} (added outside the audit trail's chain)`);
      continue;
    }
    seenSealed = true;
    if (e.sealKind === KEYED_SEAL) {
      seenKeyed = true;
      if (key.ok && !sameHex(keyedAuditHash(e, key.key), e.seal)) {
        broken.push(`${e.id} (its content no longer matches its seal)`);
        continue;
      }
    } else if (e.sealKind !== undefined) {
      broken.push(`${e.id} (sealed in an unknown way)`);
      continue;
    } else if (seenKeyed && key.ok) {
      // Once keyed sealing has begun, an unkeyed entry is one somebody re-sealed by hand.
      broken.push(`${e.id} (an unkeyed entry after keyed sealing began)`);
      continue;
    } else if (key.ok && e.dateTime >= key.keyedFrom) {
      broken.push(`${e.id} (dated after keyed sealing began, but not keyed)`);
      continue;
    } else if (!sameHex(auditEntryHash(e), e.seal)) {
      broken.push(`${e.id} (its content no longer matches its seal)`);
      continue;
    }
    if (older?.seal && e.prevSeal !== older.seal) broken.push(`${e.id} (an earlier entry was altered or removed)`);
  }
  const result: ChainCheck = { broken };
  if (!key.ok && seenKeyed) result.keyProblem = key.problem;
  return result;
}
