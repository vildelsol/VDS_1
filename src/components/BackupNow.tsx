/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Database, Download, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { EmptyState, ErrorNote, SubmitButton, SuccessNote } from './ui';

interface BackupRecord {
  file: string;
  date: string;
  sizeBytes: number;
  location: 'local' | 'external';
}

interface BackupStatus {
  retentionDays: number;
  todayBackedUp: boolean;
  todayBackedUpExternally: boolean;
  externalBackupDir: string | null;
  backups: BackupRecord[];
}

/**
 * The backup screen for someone who may take a backup but may not change system
 * settings (a junior officer granted "Take a backup now", Ro 2026-11-13).
 *
 * It deliberately has no folder field and no drive detection: the full panel in
 * System Settings auto-saves a drive it finds, and a backup target is a setting.
 * Restoring is not here either; that stays with the administrator.
 */
export default function BackupNow() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  React.useEffect(() => {
    api
      .get<BackupStatus>('/api/backup/status')
      .then(setStatus)
      .catch(err => setError(errorMessage(err, 'Could not read the backup status.')));
  }, []);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post<{ written: BackupRecord[]; status: BackupStatus }>('/api/backup/run');
      setStatus(result.status);
      setMessage(
        result.written.length > 0
          ? `Backup written: ${result.written.map(w => `${w.file} (${w.location === 'external' ? 'off-machine' : 'this machine'})`).join(', ')}.`
          : 'No backup location could be written to. Ask an administrator to check the backup folder.'
      );
    } catch (err) {
      setMessage('');
      setError(errorMessage(err, 'The backup could not be taken.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      {message && <SuccessNote>{message}</SuccessNote>}
      {!status && !error && <EmptyState title="Reading backup status…" />}
      {status && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-xs">
              <p className="font-mono text-[10px] uppercase text-slate-500">Today&apos;s backup</p>
              <p className={`mt-1 font-display text-lg font-semibold ${status.todayBackedUp ? 'text-emerald-700' : 'text-amber-700'}`}>
                {status.todayBackedUp ? 'Taken' : 'Not yet taken'}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-xs">
              <p className="font-mono text-[10px] uppercase text-slate-500">Copies kept</p>
              <p className="mt-1 font-display text-lg font-semibold text-slate-800">{status.backups.length}</p>
              <p className="mt-1 text-[11px] text-slate-400">Rolling {status.retentionDays} days</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-xs">
              <p className="font-mono text-[10px] uppercase text-slate-500">Off-machine copy</p>
              <p className={`mt-1 font-display text-lg font-semibold ${status.externalBackupDir ? 'text-emerald-700' : 'text-red-700'}`}>
                {status.externalBackupDir ? 'Configured' : 'Not configured'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <SubmitButton type="button" busy={busy} busyLabel="Backing up…" onClick={() => void run()}>
              <RefreshCw className="h-4 w-4" /> Back up now
            </SubmitButton>
            <a
              href="/api/backup/download"
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50"
            >
              <Download className="h-4 w-4" /> Download a snapshot
            </a>
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <Database className="h-3.5 w-3.5" /> The backup folder and restoring records are managed by an administrator.
          </p>
        </>
      )}
    </div>
  );
}
