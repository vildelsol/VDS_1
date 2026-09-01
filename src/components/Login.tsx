/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { KeyRound, LogIn, ShieldAlert, ShieldCheck, Loader2 } from 'lucide-react';
import { SessionUser } from '../types';
import { api, errorMessage } from '../lib/api';
import { VersionFooter, VersionMismatchBanner } from './VersionCheck';

interface LoginProps {
  onSignedIn: (user: SessionUser) => void;
}

export default function Login({ onSignedIn }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.post<{ user: SessionUser }>('/api/auth/login', { username, password });
      setPassword('');
      onSignedIn(result.user);
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center">
          <img
            src="/vds-logo.png"
            alt="Villaggio Del Sol"
            className="w-48"
          />
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-teal-400">Ocho Rios Operations</p>
          <VersionFooter className="mt-1" />
        </div>

        <VersionMismatchBanner />

        <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-850 bg-slate-800/60 p-6 shadow-2xl">
          <div className="flex items-center gap-2 border-b border-slate-700 pb-3">
            <KeyRound className="h-4 w-4 text-teal-400" />
            <h2 className="text-sm font-semibold text-white">Staff sign-in</h2>
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-1.5 rounded-xl border border-red-900/60 bg-red-950/50 p-3 text-xs text-red-200">
              <ShieldAlert className="mt-px h-4 w-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="vds-username" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-400">
              Username
            </label>
            <input
              id="vds-username"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              className="w-full rounded-xl border border-slate-700 bg-slate-900 p-2.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
              placeholder="e.g. mmatthews"
            />
          </div>

          <div>
            <label htmlFor="vds-password" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-400">
              Password
            </label>
            <input
              id="vds-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="w-full rounded-xl border border-slate-700 bg-slate-900 p-2.5 text-xs text-slate-100 focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-teal-600 py-2.5 text-xs font-semibold text-white transition-all hover:bg-teal-700 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="flex items-start gap-1.5 border-t border-slate-700 pt-3 text-[10px] leading-relaxed text-slate-500">
            <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-slate-600" />
            <span>
              Every action you take is recorded against your account in the audit trail. Do not share your credentials.
            </span>
          </p>
        </form>
      </div>
    </div>
  );
}

/** Forced password change, shown when an account still holds an issued password. */
export function ChangePasswordGate({ user, onDone }: { user: SessionUser; onDone: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/change-password', { currentPassword, newPassword });
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not change the password.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-800 bg-slate-800/60 p-6 shadow-2xl">
        <div className="border-b border-slate-700 pb-3">
          <h2 className="text-sm font-semibold text-white">Choose a new password</h2>
          <p className="mt-1 text-[11px] text-slate-400">
            Signed in as <strong className="text-slate-200">{user.name}</strong>. You must replace the password you were
            issued before continuing.
          </p>
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-red-900/60 bg-red-950/50 p-3 text-xs text-red-200">
            {error}
          </div>
        )}

        {[
          { id: 'cur', label: 'Current password', value: currentPassword, set: setCurrentPassword, autoComplete: 'current-password' },
          { id: 'new', label: 'New password', value: newPassword, set: setNewPassword, autoComplete: 'new-password' },
          { id: 'cnf', label: 'Confirm new password', value: confirmPassword, set: setConfirmPassword, autoComplete: 'new-password' }
        ].map(field => (
          <div key={field.id}>
            <label htmlFor={`vds-pw-${field.id}`} className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-400">
              {field.label}
            </label>
            <input
              id={`vds-pw-${field.id}`}
              type="password"
              autoComplete={field.autoComplete}
              value={field.value}
              onChange={e => field.set(e.target.value)}
              required
              className="w-full rounded-xl border border-slate-700 bg-slate-900 p-2.5 text-xs text-slate-100 focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
            />
          </div>
        ))}

        <p className="text-[10px] leading-relaxed text-slate-500">
          At least 10 characters, combining at least three of: lower case, upper case, numbers, symbols.
        </p>

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-teal-600 py-2.5 text-xs font-semibold text-white transition-all hover:bg-teal-700 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? 'Saving…' : 'Set password and continue'}
        </button>
      </form>
    </div>
  );
}
