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
export const AUDIT_CAP = Number(process.env.VDS_AUDIT_CAP) > 0 ? Number(process.env.VDS_AUDIT_CAP) : 20000;
/** How many of the oldest entries move to the archive file at once when the trail passes AUDIT_CAP. */
export const AUDIT_ROTATE_BATCH = Math.max(1, Math.min(1000, Math.floor(AUDIT_CAP / 10)));

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
/**
 * An entry written while keyed sealing had begun but the key was absent or
 * unreadable. It is sealed the old, unkeyed way and SAYS so. Without the label it
 * was indistinguishable from an entry somebody re-sealed by hand: putting the key
 * back, the remedy the integrity check itself prescribes, turned every sign-in
 * made in the meantime into "the audit trail has been altered", for good.
 * Labelled entries are reported on their own (audit-sealed-without-key): they are
 * genuinely weaker, since anyone who can edit db.json could have rewritten them.
 */
export const KEY_MISSING_SEAL = 'sha256-key-missing';

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
    if (hasKeyedEntries(logs)) entry.sealKind = KEY_MISSING_SEAL;
    else delete entry.sealKind;
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
  /** Entries that verify, but were sealed without the key because it was missing when they were written. */
  sealedWithoutKey: string[];
}

/** Walk the chain oldest-first. */
export function verifyAuditChain(logs: AuditLog[]): ChainCheck {
  const key = loadAuditKey();
  const broken: string[] = [];
  const sealedWithoutKey: string[] = [];
  let seenSealed = false;
  let seenKeyed = false;
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    const older = logs[i + 1];
    if (!e.seal) {
      if (seenSealed) broken.push(`${e.id} (added outside the audit trail's chain)`);
      // Seals stripped from the newest entries leave nothing older to notice them by.
      else if (key.ok && e.dateTime >= key.keyedFrom) broken.push(`${e.id} (dated after keyed sealing began, but it has no seal)`);
      continue;
    }
    seenSealed = true;
    if (e.sealKind === KEYED_SEAL) {
      seenKeyed = true;
      if (key.ok && !sameHex(keyedAuditHash(e, key.key), e.seal)) {
        broken.push(`${e.id} (its content no longer matches its seal)`);
        continue;
      }
    } else if (e.sealKind === KEY_MISSING_SEAL) {
      if (!seenKeyed || !sameHex(auditEntryHash(e), e.seal)) {
        // Only meaningful after keyed sealing began; before it, the label is a forgery.
        broken.push(`${e.id} (${seenKeyed ? 'its content no longer matches its seal' : 'labelled as written without the key before any key existed'})`);
        continue;
      }
      sealedWithoutKey.push(e.id);
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
  const result: ChainCheck = { broken, sealedWithoutKey };
  if (!key.ok && seenKeyed) result.keyProblem = key.problem;
  return result;
}

/* ------------------------------------------------------------------ *
 * The head anchor, the archive and signed snapshots (security hardening 2).
 *
 * The chain above proves that the entries still present were not edited, and that
 * nothing was removed from the MIDDLE. It cannot see the two attacks that leave a
 * consistent chain behind: deleting the newest entries, and stripping the seals.
 * So the newest seal and the entry count are also kept in `audit-head.json`,
 * beside the key and itself sealed with it, and rewritten whenever db.json is.
 * ------------------------------------------------------------------ */

export const AUDIT_HEAD_FILE = 'audit-head.json';
export const AUDIT_ARCHIVE_FILE = 'audit-archive.jsonl';
const dataDirOf = () => process.env.VDS_DATA_DIR || process.cwd();
export const auditHeadPath = (): string => path.join(dataDirOf(), AUDIT_HEAD_FILE);
export const auditArchivePath = (): string => path.join(dataDirOf(), AUDIT_ARCHIVE_FILE);

interface HeadAnchor {
  version: 1;
  /** Seal of the newest audit entry when the file was last written. */
  headSeal: string;
  /** Entries held in db.json at that moment (the head included). */
  count: number;
  /** Entries moved to the archive file over the life of the trail. */
  archived: number;
  mac: string;
}
type AnchorRead = { state: 'absent' } | { state: 'invalid' } | { state: 'ok'; anchor: HeadAnchor };

const anchorMac = (a: Pick<HeadAnchor, 'headSeal' | 'count' | 'archived'>, key: Buffer): string =>
  createHmac('sha256', key).update('anchor\u0000' + JSON.stringify([a.headSeal, a.count, a.archived])).digest('hex');

function readAnchor(key: Buffer): AnchorRead {
  let raw: string;
  try {
    raw = fs.readFileSync(auditHeadPath(), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' };
  }
  try {
    const a = JSON.parse(raw) as HeadAnchor;
    if (!a || typeof a.headSeal !== 'string' || !Number.isFinite(a.count) || !Number.isFinite(a.archived) || typeof a.mac !== 'string') return { state: 'invalid' };
    if (!sameHex(anchorMac(a, key), a.mac)) return { state: 'invalid' };
    return { state: 'ok', anchor: a };
  } catch {
    return { state: 'invalid' };
  }
}

/** Entries just moved to the archive by the commit in progress; folded into the anchor when it is written. */
let pendingRotated = 0;
export function setPendingRotated(n: number): void {
  pendingRotated = n;
}

/**
 * Record the trail's head. Called by every write of db.json. It only ever moves the anchor FORWARD along the
 * chain it already holds: if the live trail no longer contains the anchored seal (newest entries deleted, or the
 * trail replaced) the anchor is left alone, so tampering cannot be laundered by the next ordinary write.
 */
export function commitAuditAnchor(logs: AuditLog[]): void {
  try {
    const key = loadAuditKey();
    if (!key.ok) return;
    const head = logs[0];
    if (!head || !head.seal) return;
    const cur = readAnchor(key.key);
    if (cur.state === 'invalid') return;
    let archived = 0;
    if (cur.state === 'ok') {
      if (cur.anchor.headSeal !== head.seal && !logs.some(e => e.seal === cur.anchor.headSeal)) return;
      archived = cur.anchor.archived;
    }
    archived += pendingRotated;
    pendingRotated = 0;
    const body = { headSeal: head.seal as string, count: logs.length, archived };
    const rec: HeadAnchor = { version: 1, ...body, mac: anchorMac(body, key.key) };
    const file = auditHeadPath();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[vds] could not update the audit head anchor:', (err as Error).message);
  }
}

/* ---------------- the archive ---------------- */

/** Entries newest-first (the same order as db.auditLogs), plus how many lines the file holds. */
function readArchiveFile(): { entries: AuditLog[]; lines: number; unreadable: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(auditArchivePath(), 'utf8');
  } catch (err) {
    return { entries: [], lines: 0, unreadable: (err as NodeJS.ErrnoException).code !== 'ENOENT' };
  }
  const out: AuditLog[] = [];
  let unreadable = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditLog);
    } catch {
      unreadable = true;
    }
  }
  return { entries: out.reverse(), lines: out.length, unreadable };
}

/** Append entries (given oldest-first) to the archive, fsynced. Entries already in it are skipped. Throws on failure. */
export function appendToAuditArchive(oldestFirst: AuditLog[]): void {
  const known = new Set(readArchiveFile().entries.map(e => e.seal));
  const fresh = oldestFirst.filter(e => !known.has(e.seal));
  if (fresh.length === 0) return;
  const fd = fs.openSync(auditArchivePath(), 'a', 0o600);
  try {
    fs.writeSync(fd, fresh.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

let archiveCache: { file: string; size: number; mtimeMs: number; value: ReturnType<typeof readArchiveFile> & { broken: string[] } } | null = null;
function archiveStatus() {
  const file = auditArchivePath();
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(file);
  } catch {
    st = null;
  }
  if (!st) return { entries: [] as AuditLog[], lines: 0, unreadable: false, broken: [] as string[] };
  if (archiveCache && archiveCache.file === file && archiveCache.size === st.size && archiveCache.mtimeMs === st.mtimeMs) return archiveCache.value;
  const read = readArchiveFile();
  const value = { ...read, broken: verifyAuditChain(read.entries).broken };
  archiveCache = { file, size: st.size, mtimeMs: st.mtimeMs, value };
  return value;
}

/**
 * Everything wrong with the head anchor and the archive, as record lists for the integrity report.
 * `logs` is newest-first. Reads two small files and, only when the archive changed, the archive itself.
 */
export function verifyAnchorAndArchive(logs: AuditLog[]): { broken: string[] } {
  const broken: string[] = [];
  const key = loadAuditKey();
  if (!key.ok) return { broken };
  const cur = readAnchor(key.key);
  const archive = archiveStatus();
  if (cur.state === 'invalid') broken.push(`${AUDIT_HEAD_FILE} (the head anchor was altered or is damaged)`);
  if (cur.state === 'ok') {
    const a = cur.anchor;
    const i = logs.findIndex(e => e.seal === a.headSeal);
    if (i === -1) {
      broken.push(`newest entries (the last entry recorded, sealed ${a.headSeal.slice(0, 12)}, is no longer in the trail: newer entries were removed or the trail was replaced)`);
    } else {
      const live = logs.length - i;
      if (live < a.count && archive.lines < a.archived + (a.count - live)) {
        broken.push(`oldest entries (${a.count - live} fewer entries are held than were recorded, and the archive does not account for them)`);
      }
    }
    if (a.archived > 0 && archive.lines < a.archived) broken.push(`${AUDIT_ARCHIVE_FILE} (holds ${archive.lines} entries, ${a.archived} were archived)`);
  }
  for (const b of archive.broken) broken.push(`${AUDIT_ARCHIVE_FILE}: ${b}`);
  if (archive.unreadable) broken.push(`${AUDIT_ARCHIVE_FILE} (a line in it cannot be read)`);
  if (archive.lines > 0 && logs.length > 0) {
    const oldest = logs[logs.length - 1];
    if (oldest.prevSeal && !archive.entries.some(e => e.seal === oldest.prevSeal)) {
      broken.push(`${AUDIT_ARCHIVE_FILE} (does not connect to the oldest entry still in the trail)`);
    }
  }
  return { broken };
}

/** Copy the archive into a backup folder (it only ever grows, so the latest copy is always a superset). */
export function copyAuditArchiveTo(dir: string): void {
  const src = auditArchivePath();
  if (!fs.existsSync(src)) return;
  const dest = path.join(dir, AUDIT_ARCHIVE_FILE);
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) return;
  } catch {
    /* copy anyway */
  }
  const tmp = `${dest}.partial`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* Windows */
  }
}

/* ---------------- signed snapshots ---------------- */

export type SnapshotSignature = 'valid' | 'unsigned' | 'mismatch' | 'no-key';

function snapshotMac(obj: Record<string, unknown>, key: Buffer): string {
  const rest: Record<string, unknown> = { ...obj };
  delete rest.snapshotSignature;
  return createHmac('sha256', key).update('snapshot\u0000' + JSON.stringify(rest)).digest('hex');
}

/** HMAC of a snapshot or backup with the audit key, or null when there is no key to sign with. */
export function signSnapshot(obj: Record<string, unknown>): string | null {
  const key = loadAuditKey();
  return key.ok ? snapshotMac(obj, key.key) : null;
}

export function checkSnapshotSignature(obj: Record<string, unknown>): SnapshotSignature {
  const sig = obj.snapshotSignature;
  if (typeof sig !== 'string' || !sig) return 'unsigned';
  const key = loadAuditKey();
  if (!key.ok) return 'no-key';
  return sameHex(snapshotMac(obj, key.key), sig) ? 'valid' : 'mismatch';
}

/** Set when moving old entries to the archive failed; cleared by the next rotation that succeeds. */
let rotationFailure: string | null = null;
export const auditRotationFailure = (): string | null => rotationFailure;
export const setAuditRotationFailure = (message: string | null): void => {
  rotationFailure = message;
};

/**
 * When the trail has passed AUDIT_CAP, move its oldest entries to the archive file instead of dropping them.
 * `logs` is newest-first and is trimmed in place ONLY after the archive write succeeded; on failure nothing is
 * removed, the failure is recorded, and the integrity check reports it as serious.
 */
export function rotateAuditLogs(logs: AuditLog[]): number {
  if (logs.length <= AUDIT_CAP) return 0;
  const keep = Math.max(1, AUDIT_CAP - AUDIT_ROTATE_BATCH);
  const moving = logs.slice(keep).reverse(); // oldest first
  try {
    appendToAuditArchive(moving);
  } catch (err) {
    rotationFailure = (err as Error).message || 'the archive file could not be written';
    console.error('[vds] the audit trail could not be archived; nothing was removed:', rotationFailure);
    return 0;
  }
  rotationFailure = null;
  logs.length = keep;
  return moving.length;
}
