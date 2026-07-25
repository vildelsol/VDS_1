/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  AppSettings,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  RolePermissions,
  SessionUser,
  Unit,
  User,
  UserRole,
  getUnitDisplayName
} from '../types';
import { formatDayLabel } from '../lib/dates';
import { api, errorMessage } from '../lib/api';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  Modal,
  PermissionNote,
  SecondaryButton,
  SubmitButton,
  SuccessNote,
  TableScroller,
  inputClass,
  monoInputClass
} from './ui';
import { CalendarClock, Database, Download, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';

interface SystemSettingsProps {
  settings: AppSettings;
  users: User[];
  units: Unit[];
  session: SessionUser;
  onUpdateSettings: (payload: Record<string, unknown>) => Promise<unknown>;
  onCreateUser: (payload: Record<string, unknown>) => Promise<unknown>;
  onUpdateUser: (id: string, fields: Record<string, unknown>) => Promise<unknown>;
  onResetPassword: (id: string, password: string) => Promise<unknown>;
  onAddFeed: (payload: Record<string, unknown>) => Promise<unknown>;
  onRemoveFeed: (id: string) => Promise<unknown>;
  onSyncFeed: (id?: string) => Promise<{ results: unknown[] }>;
}

const EDITABLE_ROLES: ('MANAGER' | 'FINANCE_OFFICER' | 'JUNIOR_OFFICER')[] = ['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'];

const ROLE_LABELS: Record<UserRole, string> = {
  ADMINISTRATOR: 'Administrator',
  MANAGER: 'Manager',
  FINANCE_OFFICER: 'Finance Officer',
  JUNIOR_OFFICER: 'Junior / Reservations Officer'
};

interface SyncResult {
  ok: boolean;
  imported: number;
  updated: number;
  conflicts: string[];
  error?: string;
  unitNumber: string;
}

export default function SystemSettings({
  settings,
  users,
  units,
  session,
  onUpdateSettings,
  onCreateUser,
  onUpdateUser,
  onResetPassword,
  onAddFeed,
  onRemoveFeed,
  onSyncFeed
}: SystemSettingsProps) {
  const [tab, setTab] = useState<'permissions' | 'staff' | 'feeds' | 'backup' | 'general'>('permissions');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const isAdmin = session.role === 'ADMINISTRATOR';
  const canManageSettings = isAdmin || session.role === 'MANAGER' || !!session.permissions.hasVetoPower;

  const notify = (message: string) => {
    setSuccess(message);
    setError('');
  };
  const fail = (err: unknown, fallback: string) => {
    setError(errorMessage(err, fallback));
    setSuccess('');
  };

  if (!canManageSettings) {
    return <PermissionNote>Only Administrators and Managers can view system settings.</PermissionNote>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4 border-b border-slate-200">
        {([
          ['permissions', 'Role permissions'],
          ['staff', 'Staff accounts'],
          ['feeds', 'Calendar feeds'],
          ['backup', 'Backup & recovery'],
          ['general', 'General']
        ] as const)
          .filter(([key]) => key !== 'staff' || isAdmin)
          .map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
                setError('');
                setSuccess('');
              }}
              className={`border-b-2 pb-3 text-xs font-medium transition-all ${
                tab === key ? 'border-teal-600 font-semibold text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {success && <SuccessNote>{success}</SuccessNote>}

      {tab === 'permissions' && (
        <PermissionsPanel
          settings={settings}
          busy={busy}
          onSave={async rolePermissions => {
            setBusy(true);
            try {
              await onUpdateSettings({ rolePermissions });
              notify('Permission matrix updated. The change is enforced on the server for every request.');
            } catch (err) {
              fail(err, 'Could not save the permission matrix.');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {tab === 'staff' && isAdmin && (
        <StaffPanel
          users={users}
          currentUserId={session.id}
          onCreate={async payload => {
            await onCreateUser(payload);
            notify('Staff account created. The user must change the issued password at first sign-in.');
          }}
          onUpdate={async (id, fields) => {
            await onUpdateUser(id, fields);
            notify('Staff account updated.');
          }}
          onResetPassword={async (id, password) => {
            await onResetPassword(id, password);
            notify('Password reset. That user’s sessions were revoked and they must set a new password.');
          }}
          onError={err => fail(err, 'Could not update the staff account.')}
        />
      )}

      {tab === 'feeds' && (
        <FeedsPanel
          settings={settings}
          units={units}
          onAdd={async payload => {
            await onAddFeed(payload);
            notify('Calendar feed linked. Use “Sync now” to import reservations.');
          }}
          onRemove={async id => {
            await onRemoveFeed(id);
            notify('Calendar feed removed. Reservations already imported are left in place.');
          }}
          onSync={async id => {
            const response = await onSyncFeed(id);
            const results = (response?.results || []) as SyncResult[];
            const failed = results.filter(r => !r.ok);
            if (failed.length > 0) {
              fail(new Error(failed.map(f => `${f.unitNumber}: ${f.error}`).join(' — ')), 'Sync failed.');
              return;
            }
            const imported = results.reduce((n, r) => n + r.imported, 0);
            const updated = results.reduce((n, r) => n + r.updated, 0);
            const conflicts = results.flatMap(r => r.conflicts);
            notify(
              `Sync complete: ${imported} imported, ${updated} updated` +
                (conflicts.length ? `, ${conflicts.length} skipped because they clash with existing reservations.` : '.')
            );
          }}
          onError={err => fail(err, 'Could not update the calendar feeds.')}
        />
      )}

      {tab === 'backup' && <BackupPanel onError={err => fail(err, 'Could not read the backup status.')} onNotify={notify} />}

      {tab === 'general' && (
        <GeneralPanel
          settings={settings}
          onSave={async payload => {
            try {
              await onUpdateSettings(payload);
              notify('Settings saved.');
            } catch (err) {
              fail(err, 'Could not save the settings.');
            }
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PermissionsPanel({
  settings,
  busy,
  onSave
}: {
  settings: AppSettings;
  busy: boolean;
  onSave: (rolePermissions: AppSettings['rolePermissions']) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings.rolePermissions);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.rolePermissions);

  const toggle = (role: (typeof EDITABLE_ROLES)[number], key: keyof RolePermissions) => {
    setDraft(prev => ({ ...prev, [role]: { ...prev[role], [key]: !prev[role][key] } }));
  };

  return (
    <div className="space-y-4">
      <InfoNote>
        These permissions are enforced on the server for every request, not only in the interface. Administrators always
        hold every permission and cannot be restricted here.
      </InfoNote>

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        <TableScroller>
          <table className="w-full min-w-[700px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] uppercase text-slate-500">
                <th scope="col" className="p-4">Permission</th>
                {EDITABLE_ROLES.map(role => (
                  <th key={role} scope="col" className="p-4 text-center">
                    {ROLE_LABELS[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {PERMISSION_KEYS.map(key => (
                <tr key={key} className="hover:bg-slate-50/50">
                  <td className="p-4">
                    <span className="font-medium text-slate-800">{PERMISSION_LABELS[key]}</span>
                    {(key === 'reversePayments' || key === 'modifySettledRecords') && (
                      <span className="mt-0.5 block text-[10px] text-amber-700">
                        Financial control — grant sparingly and review it in the audit trail.
                      </span>
                    )}
                  </td>
                  {EDITABLE_ROLES.map(role => (
                    <td key={role} className="p-4 text-center">
                      <input
                        type="checkbox"
                        checked={!!draft[role][key]}
                        onChange={() => toggle(role, key)}
                        aria-label={`${PERMISSION_LABELS[key]} for ${ROLE_LABELS[role]}`}
                        className="h-4 w-4 cursor-pointer rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 p-4">
          <p className="font-mono text-[10px] text-slate-500">
            {dirty ? 'Unsaved changes' : 'No changes'} · every change is recorded in the audit trail.
          </p>
          <div className="flex gap-2">
            <SecondaryButton onClick={() => setDraft(settings.rolePermissions)} disabled={!dirty}>
              Discard
            </SecondaryButton>
            <SubmitButton type="button" busy={busy} onClick={() => void onSave(draft)} disabled={!dirty}>
              Save permissions
            </SubmitButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StaffPanel({
  users,
  currentUserId,
  onCreate,
  onUpdate,
  onResetPassword,
  onError
}: {
  users: User[];
  currentUserId: string;
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
  onUpdate: (id: string, fields: Record<string, unknown>) => Promise<void>;
  onResetPassword: (id: string, password: string) => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);

  const activeAdmins = users.filter(u => u.role === 'ADMINISTRATOR' && u.active).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-slate-900">
            <Users className="h-4 w-4 text-teal-600" />
            Staff accounts
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Each member of staff signs in with their own account, and every audit entry is attributed to it.
          </p>
        </div>
        <SubmitButton type="button" onClick={() => setCreating(true)}>
          <UserPlus className="h-4 w-4" /> Add staff account
        </SubmitButton>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        {users.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No staff accounts" />
          </div>
        ) : (
          <TableScroller>
            <table className="w-full min-w-[820px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] uppercase text-slate-500">
                  <th scope="col" className="p-4">Name</th>
                  <th scope="col" className="p-4">Username</th>
                  <th scope="col" className="p-4">Role</th>
                  <th scope="col" className="p-4">Last sign-in</th>
                  <th scope="col" className="p-4">Status</th>
                  <th scope="col" className="p-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {users.map(user => {
                  const isSelf = user.id === currentUserId;
                  const isLastAdmin = user.role === 'ADMINISTRATOR' && user.active && activeAdmins <= 1;
                  return (
                    <tr key={user.id} className="hover:bg-slate-50/50">
                      <td className="p-4">
                        <p className="font-medium text-slate-900">
                          {user.name}
                          {isSelf && <span className="ml-1.5 text-[10px] text-slate-400">(you)</span>}
                        </p>
                        {user.position && <p className="text-[10px] text-slate-400">{user.position}</p>}
                      </td>
                      <td className="p-4 font-mono">{user.username}</td>
                      <td className="p-4">
                        <select
                          value={user.role}
                          disabled={isLastAdmin}
                          title={isLastAdmin ? 'At least one active Administrator must remain' : undefined}
                          onChange={e => {
                            void onUpdate(user.id, { role: e.target.value }).catch(onError);
                          }}
                          className="rounded-lg border border-slate-200 p-1.5 text-[11px] disabled:bg-slate-100"
                        >
                          {(Object.keys(ROLE_LABELS) as UserRole[]).map(role => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-4 font-mono text-[11px] text-slate-500">
                        {user.lastLoginAt ? formatDayLabel(user.lastLoginAt.substring(0, 10)) : 'Never'}
                      </td>
                      <td className="p-4">
                        {!user.active ? (
                          <Badge tone="slate">Disabled</Badge>
                        ) : user.mustChangePassword ? (
                          <Badge tone="amber">Password change due</Badge>
                        ) : (
                          <Badge tone="green">Active</Badge>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setResetting(user)}
                            className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                          >
                            <KeyRound className="h-3 w-3" /> Reset password
                          </button>
                          <button
                            onClick={() => {
                              void onUpdate(user.id, { active: !user.active }).catch(onError);
                            }}
                            disabled={isLastAdmin || isSelf}
                            title={isSelf ? 'You cannot disable your own account' : isLastAdmin ? 'At least one active Administrator must remain' : undefined}
                            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                          >
                            {user.active ? 'Disable' : 'Enable'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroller>
        )}
      </div>

      {creating && (
        <StaffFormModal
          onClose={() => setCreating(false)}
          onSubmit={async payload => {
            await onCreate(payload);
            setCreating(false);
          }}
        />
      )}

      {resetting && (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onSubmit={async password => {
            await onResetPassword(resetting.id, password);
            setResetting(null);
          }}
        />
      )}
    </div>
  );
}

function StaffFormModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [position, setPosition] = useState('');
  const [role, setRole] = useState<UserRole>('JUNIOR_OFFICER');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ name, username, email, position, role, password });
    } catch (err) {
      setError(errorMessage(err, 'Could not create the account.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add staff account"
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Creating…" form="vds-staff-form" className="flex-1">
            Create account
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-staff-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Full name" htmlFor="sf-name" required>
            <input id="sf-name" type="text" value={name} onChange={e => setName(e.target.value)} required className={inputClass} />
          </Field>
          <Field label="Username" htmlFor="sf-user" required hint="Letters, numbers, dots, dashes and underscores.">
            <input id="sf-user" type="text" value={username} onChange={e => setUsername(e.target.value.toLowerCase())} required className={monoInputClass} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Position" htmlFor="sf-pos">
            <input id="sf-pos" type="text" value={position} onChange={e => setPosition(e.target.value)} className={inputClass} placeholder="e.g. Accounts Executive" />
          </Field>
          <Field label="Email" htmlFor="sf-email">
            <input id="sf-email" type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <Field label="Role" htmlFor="sf-role" required>
          <select id="sf-role" value={role} onChange={e => setRole(e.target.value as UserRole)} className={inputClass}>
            {(Object.keys(ROLE_LABELS) as UserRole[]).map(r => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Initial password"
          htmlFor="sf-pw"
          required
          hint="At least 10 characters using three of: lower case, upper case, numbers, symbols. The user must change it at first sign-in."
        >
          <input id="sf-pw" type="text" value={password} onChange={e => setPassword(e.target.value)} required className={monoInputClass} autoComplete="off" />
        </Field>

        <InfoNote tone="amber">
          Pass this password to the member of staff through a channel you trust. It is stored only as a hash and cannot
          be recovered — only reset.
        </InfoNote>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onSubmit }: { user: User; onClose: () => void; onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(password);
    } catch (err) {
      setError(errorMessage(err, 'Could not reset the password.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Reset password — ${user.name}`}
      subtitle={user.username}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <SubmitButton busy={busy} busyLabel="Resetting…" form="vds-reset-form" className="flex-1">
            Reset password
          </SubmitButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      }
    >
      <form id="vds-reset-form" onSubmit={handleSubmit} className="space-y-4 p-6">
        {error && <ErrorNote>{error}</ErrorNote>}
        <InfoNote tone="amber">This signs the user out everywhere and requires a new password at their next sign-in.</InfoNote>
        <Field label="New password" htmlFor="rp-pw" required>
          <input id="rp-pw" type="text" value={password} onChange={e => setPassword(e.target.value)} required className={monoInputClass} autoComplete="off" />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function FeedsPanel({
  settings,
  units,
  onAdd,
  onRemove,
  onSync,
  onError
}: {
  settings: AppSettings;
  units: Unit[];
  onAdd: (payload: Record<string, unknown>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onSync: (id?: string) => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [unitId, setUnitId] = useState('');
  const [url, setUrl] = useState('');
  const [source, setSource] = useState<'Airbnb' | 'Booking.com' | 'Other'>('Airbnb');
  const [busy, setBusy] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onAdd({ unitId, url, source });
      setUrl('');
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <InfoNote>
        Booking platforms publish an iCalendar (.ics) export per listing. It carries booked dates only — never guest
        contact details or pricing. Imported stays therefore arrive with a zero stay value until you enter one, and any
        event clashing with an existing reservation is skipped rather than overwriting it.
      </InfoNote>

      <form onSubmit={handleAdd} className="grid grid-cols-1 items-end gap-3 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs sm:grid-cols-4">
        <Field label="Villa" htmlFor="fd-unit" required>
          <select id="fd-unit" value={unitId} onChange={e => setUnitId(e.target.value)} required className={inputClass}>
            <option value="">Select villa</option>
            {units.map(u => (
              <option key={u.id} value={u.id}>
                {getUnitDisplayName(u.number)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Platform" htmlFor="fd-source" required>
          <select id="fd-source" value={source} onChange={e => setSource(e.target.value as typeof source)} className={inputClass}>
            <option value="Airbnb">Airbnb</option>
            <option value="Booking.com">Booking.com</option>
            <option value="Other">Other (VRBO, etc.)</option>
          </select>
        </Field>
        <Field label="Calendar export URL" htmlFor="fd-url" required>
          <input
            id="fd-url"
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            required
            placeholder="https://www.airbnb.com/calendar/ical/12345.ics?s=…"
            className={monoInputClass}
          />
        </Field>
        <SubmitButton busy={busy} busyLabel="Linking…">
          <Plus className="h-4 w-4" /> Link feed
        </SubmitButton>
      </form>

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 p-4">
          <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-slate-900">
            <CalendarClock className="h-4 w-4 text-teal-600" />
            Linked calendars ({settings.icalFeeds.length})
          </h3>
          {settings.icalFeeds.length > 0 && (
            <SecondaryButton
              onClick={async () => {
                setSyncingId('all');
                try {
                  await onSync();
                } finally {
                  setSyncingId(null);
                }
              }}
              disabled={syncingId !== null}
              className="flex items-center gap-1.5"
            >
              <RefreshCw className={`h-4 w-4 ${syncingId === 'all' ? 'animate-spin' : ''}`} />
              Sync all
            </SecondaryButton>
          )}
        </div>

        {settings.icalFeeds.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="No calendar feeds linked"
              hint="Nothing is imported automatically until a feed is added here. Until then, platform reservations must be entered by hand."
            />
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {settings.icalFeeds.map(feed => (
              <li key={feed.id} className="flex flex-col gap-3 p-4 text-xs sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{getUnitDisplayName(feed.unitNumber)}</span>
                    <Badge tone={feed.source === 'Airbnb' ? 'red' : feed.source === 'Booking.com' ? 'blue' : 'slate'}>{feed.source}</Badge>
                    {feed.lastStatus === 'error' && <Badge tone="red">Last sync failed</Badge>}
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-slate-400" title={feed.url}>
                    {feed.url}
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-500">
                    {feed.lastSyncAt ? `Last synced ${formatDayLabel(feed.lastSyncAt.substring(0, 10))} — ${feed.lastResult}` : 'Never synced'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <SecondaryButton
                    onClick={async () => {
                      setSyncingId(feed.id);
                      try {
                        await onSync(feed.id);
                      } finally {
                        setSyncingId(null);
                      }
                    }}
                    disabled={syncingId !== null}
                    className="flex items-center gap-1.5 px-3 py-2"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${syncingId === feed.id ? 'animate-spin' : ''}`} />
                    Sync now
                  </SecondaryButton>
                  <button
                    onClick={() => {
                      if (window.confirm(`Remove the ${feed.source} feed for ${getUnitDisplayName(feed.unitNumber)}? Reservations already imported stay in place.`)) {
                        void onRemove(feed.id).catch(onError);
                      }
                    }}
                    className="rounded-xl border border-red-200 p-2 text-red-600 transition-all hover:bg-red-50"
                    title="Remove feed"
                    aria-label="Remove feed"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface BackupRecord {
  file: string;
  date: string;
  sizeBytes: number;
  location: 'local' | 'external';
}

interface BackupStatus {
  dataFile: string;
  localBackupDir: string;
  externalBackupDir: string | null;
  retentionDays: number;
  todayBackedUp: boolean;
  backups: BackupRecord[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function BackupPanel({ onError, onNotify }: { onError: (err: unknown) => void; onNotify: (message: string) => void }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = React.useCallback(async () => {
    try {
      setStatus(await api.get<BackupStatus>('/api/backup/status'));
    } catch (err) {
      onError(err);
    }
  }, [onError]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const runBackup = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ written: BackupRecord[]; status: BackupStatus }>('/api/backup/run');
      setStatus(result.status);
      onNotify(
        result.written.length > 0
          ? `Backup written: ${result.written.map(w => `${w.file} (${w.location})`).join(', ')}.`
          : 'No backup target could be written to. Check the folder permissions.'
      );
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <EmptyState title="Reading backup status…" />;
  }

  const external = status.externalBackupDir;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-xs">
          <p className="font-mono text-[10px] uppercase text-slate-500">Today&apos;s backup</p>
          <p className={`mt-1 font-display text-lg font-semibold ${status.todayBackedUp ? 'text-emerald-700' : 'text-amber-700'}`}>
            {status.todayBackedUp ? 'Taken' : 'Not yet taken'}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">Runs automatically, checked hourly</p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-xs">
          <p className="font-mono text-[10px] uppercase text-slate-500">Copies kept</p>
          <p className="mt-1 font-display text-lg font-semibold text-slate-800">{status.backups.length}</p>
          <p className="mt-1 text-[11px] text-slate-400">Rolling {status.retentionDays} days</p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-xs">
          <p className="font-mono text-[10px] uppercase text-slate-500">Off-machine copy</p>
          <p className={`mt-1 font-display text-lg font-semibold ${external ? 'text-emerald-700' : 'text-red-700'}`}>
            {external ? 'Configured' : 'Not configured'}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">{external ? 'Second location in use' : 'Backups are on this disk only'}</p>
        </div>
      </div>

      {!external && (
        <InfoNote tone="amber">
          <strong>Every copy of your records is on this one machine.</strong> The automatic backups sit on the same disk
          as the database they protect, so a disk failure, a lost laptop or a deleted folder takes both. Set the{' '}
          <code className="rounded bg-white px-1 font-mono">VDS_BACKUP_DIR</code> environment variable to a synced folder
          (Dropbox, iCloud Drive, OneDrive) or an external drive, and a second copy is written there each day. Download
          a snapshot below in the meantime.
        </InfoNote>
      )}

      <div className="flex flex-wrap gap-2">
        <SubmitButton type="button" busy={busy} busyLabel="Backing up…" onClick={() => void runBackup()}>
          <RefreshCw className="h-4 w-4" /> Back up now
        </SubmitButton>
        <a
          href="/api/backup/download"
          className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50"
        >
          <Download className="h-4 w-4" /> Download a snapshot
        </a>
      </div>

      <div className="space-y-3 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
        <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-slate-900">
          <Database className="h-4 w-4 text-teal-600" />
          Where the records live
        </h3>
        <dl className="space-y-1.5 text-xs">
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-slate-500">Live database</dt>
            <dd className="break-all font-mono text-[11px] text-slate-800">{status.dataFile}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-slate-500">Daily backups</dt>
            <dd className="break-all font-mono text-[11px] text-slate-800">{status.localBackupDir}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-slate-500">Second location</dt>
            <dd className="break-all font-mono text-[11px] text-slate-800">{external || 'not configured'}</dd>
          </div>
        </dl>
        <InfoNote>
          <strong>To restore:</strong> stop the application, copy the backup file you want over{' '}
          <code className="rounded bg-white px-1 font-mono">db.json</code>, and start it again. If{' '}
          <code className="rounded bg-white px-1 font-mono">db.json</code> is ever damaged, the application refuses to
          start rather than overwriting it — so nothing is lost while you recover.
        </InfoNote>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        <div className="border-b border-slate-100 bg-slate-50 p-4">
          <h3 className="font-display text-sm font-semibold text-slate-900">Available backups</h3>
        </div>
        {status.backups.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No backups yet" hint="The first one is taken the day after the application starts, or immediately with “Back up now”." />
          </div>
        ) : (
          <TableScroller>
            <table className="w-full min-w-[420px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] uppercase text-slate-500">
                  <th scope="col" className="p-3">Date</th>
                  <th scope="col" className="p-3">File</th>
                  <th scope="col" className="p-3">Location</th>
                  <th scope="col" className="p-3 text-right">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {status.backups.map(b => (
                  <tr key={`${b.location}-${b.file}`} className="hover:bg-slate-50/50">
                    <td className="p-3 font-mono">{formatDayLabel(b.date)}</td>
                    <td className="p-3 font-mono text-[11px] text-slate-500">{b.file}</td>
                    <td className="p-3">
                      <Badge tone={b.location === 'external' ? 'green' : 'slate'}>
                        {b.location === 'external' ? 'Off-machine' : 'This machine'}
                      </Badge>
                    </td>
                    <td className="p-3 text-right font-mono text-slate-500">{formatBytes(b.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function GeneralPanel({ settings, onSave }: { settings: AppSettings; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [fxRate, setFxRate] = useState(String(settings.fxRateJmdPerUsd));
  const [vendors, setVendors] = useState(settings.vendors.join('\n'));
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    setBusy(true);
    try {
      await onSave({
        fxRateJmdPerUsd: Number(fxRate),
        vendors: vendors
          .split('\n')
          .map(v => v.trim())
          .filter(Boolean)
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-xs">
      <div className="flex items-center gap-1.5">
        <ShieldCheck className="h-4 w-4 text-teal-600" />
        <h3 className="font-display text-sm font-semibold text-slate-900">General configuration</h3>
      </div>

      <Field
        label="Indicative exchange rate (JMD per 1 USD)"
        htmlFor="gp-fx"
        hint="Shows an approximate second figure alongside an amount. No stored amount is ever converted with it, and no total mixes the two currencies."
      >
        <input id="gp-fx" type="number" min="0.0001" step="0.01" value={fxRate} onChange={e => setFxRate(e.target.value)} className={`${monoInputClass} max-w-[200px]`} />
      </Field>

      <Field label="Vendor list" htmlFor="gp-vendors" hint="One vendor per line. These appear as suggestions when recording an expense.">
        <textarea id="gp-vendors" rows={8} value={vendors} onChange={e => setVendors(e.target.value)} className={inputClass} />
      </Field>

      <SubmitButton type="button" busy={busy} busyLabel="Saving…" onClick={() => void handleSave()}>
        Save settings
      </SubmitButton>
    </div>
  );
}
