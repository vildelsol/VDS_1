/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which Windows drive letters are really external.
 *
 * Until 1.16.12 every letter except C: counted as "removable". A second internal
 * disk, a card reader or a data partition on the HP would therefore be adopted as
 * the off-machine backup folder, and the screen would say "Configured" while the
 * copy sat inside the same computer it was meant to protect.
 *
 * Windows can say what a drive is, so this asks. A drive is external when it is
 * a removable volume, or when its disk sits on a USB, SD, MMC or FireWire bus
 * (a USB hard disk reports as a fixed volume, so the volume type alone misses it).
 * Anything it cannot classify is NOT external: a drive wrongly left out is chosen
 * by hand in Settings, while one wrongly let in silently defeats the backup.
 *
 * Kept free of other imports so a test can load it on its own.
 */

import { execFileSync } from 'child_process';

export interface WindowsDriveInfo {
  /** Drive letter, upper case, no colon. */
  letter: string;
  /** Win32_LogicalDisk.DriveType: 2 removable, 3 fixed, 4 network, 5 optical, 6 RAM disk. */
  driveType: number;
  /** The disk's bus (USB, SATA, NVMe, SD...), when Windows reports one. */
  bus: string;
}

const EXTERNAL_BUSES = new Set(['USB', 'SD', 'MMC', '1394']);

export function isExternalWindowsDrive(info: WindowsDriveInfo | undefined, systemLetter = 'C'): boolean {
  if (!info) return false;
  const letter = (info.letter || '').toUpperCase();
  if (!letter || letter === systemLetter.toUpperCase()) return false;
  if (info.driveType === 2) return true;
  if (info.driveType !== 3) return false; // optical, network, RAM disk, unknown
  return EXTERNAL_BUSES.has((info.bus || '').toUpperCase());
}

/** Read the JSON the PowerShell query prints. One drive prints an object, several an array. */
export function parseWindowsDriveReport(text: string): WindowsDriveInfo[] | null {
  try {
    const parsed = JSON.parse(text.trim());
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const out: WindowsDriveInfo[] = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const letter = String((r as { letter?: unknown }).letter ?? '').trim().toUpperCase();
      if (!/^[A-Z]$/.test(letter)) continue;
      out.push({
        letter,
        driveType: Number((r as { driveType?: unknown }).driveType) || 0,
        bus: String((r as { bus?: unknown }).bus ?? '').trim()
      });
    }
    return out;
  } catch {
    return null;
  }
}

const PS_HEAD = "$ErrorActionPreference='SilentlyContinue'";
const PS_BUS =
  '$bus=@{}; Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object { $bus[[string]$_.DriveLetter] = [string](Get-Disk -Number $_.DiskNumber).BusType }';
const PS_ROWS =
  '@(Get-CimInstance Win32_LogicalDisk | ForEach-Object { $l=$_.DeviceID.Substring(0,1); [pscustomobject]@{ letter=$l; driveType=[int]$_.DriveType; bus=$bus[$l] } }) | ConvertTo-Json -Compress';

/** Full query: drive types plus each disk's bus. The bus lookup is the slow part. */
const SCRIPT_FULL = [PS_HEAD, PS_BUS, PS_ROWS].join('; ');
/** Fallback: drive types only (removable still detected; USB hard disks are then not). */
const SCRIPT_TYPES_ONLY = [PS_HEAD, '$bus=@{}', PS_ROWS].join('; ');

let cache: { at: number; rows: WindowsDriveInfo[] | null } | null = null;
let lastError = '';

/** Why the last query returned null (empty when it did not). For diagnostics and tests. */
export function lastWindowsDriveError(): string {
  return lastError;
}

function runPowerShell(script: string, timeoutMs: number): WindowsDriveInfo[] | null {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const rows = parseWindowsDriveReport(out);
    if (!rows) lastError = 'unparseable output: ' + String(out).slice(0, 200);
    return rows;
  } catch (e) {
    const err = e as { message?: string; stderr?: unknown };
    lastError = (err.message || 'failed') + (err.stderr ? ' | ' + String(err.stderr).slice(0, 200) : '');
    return null;
  }
}

/**
 * Ask Windows about every drive. Null when it could not be asked (PowerShell
 * missing or blocked, a timeout). A cold PowerShell plus the disk-bus lookup can
 * take well over 6 seconds (it did on the CI runner), so the full query gets 25s
 * and, if it fails, a drive-types-only query gets another try. Cached for a few
 * seconds because the Backup screen and the drive watcher both poll.
 */
export function queryWindowsDrives(): WindowsDriveInfo[] | null {
  if (cache && Date.now() - cache.at < 10_000) return cache.rows;
  lastError = '';
  let rows = runPowerShell(SCRIPT_FULL, 25_000);
  if (!rows) {
    const firstError = lastError;
    rows = runPowerShell(SCRIPT_TYPES_ONLY, 15_000);
    if (!rows) lastError = 'full: ' + firstError + ' || types-only: ' + lastError;
    else lastError = '';
  }
  cache = { at: Date.now(), rows };
  return rows;
}
