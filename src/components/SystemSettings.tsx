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
  getUnitDisplayName,
  IntegrityReport
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
import { CalendarClock, Database, Download, HardDrive, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';

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
            notify('Calendar feed linked. Use "Sync now" to import reservations.');
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
              fail(new Error(failed.map(f => `${f.unitNumber}: ${f.error}`).join(', ')), 'Sync failed.');
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

      {tab === 'backup' && (
        <BackupPanel
          onError={err => fail(err, 'Could not read the backup status.')}
          onNotify={notify}
          onSaveBackupDir={dir => onUpdateSettings({ backupDir: dir })}
        />
      )}

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
                        Financial control, grant sparingly and review it in the audit trail.
                      </span>
                    )}
                    {/*
                      Said here so nobody withdraws this expecting it to be a
                      lock. It hides a screen; it does not hide the receipts the
                      screen is built from, which are on the ledger already.
                    */}
                    {key === 'viewShortfall' && (
                      <span className="mt-0.5 block text-[10px] text-slate-500">
                        ISPO&rsquo;s own position as a landlord, never an owner or council document. On for everyone by default.
                        Withdrawing it hides the screen, not the receipts underneath.
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
          be recovered, only reset.
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
      title={`Reset password, ${user.name}`}
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
        Booking platforms publish an iCalendar (.ics) export per listing. It carries booked dates only, never guest
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
                    {feed.lastSyncAt ? `Last synced ${formatDayLabel(feed.lastSyncAt.substring(0, 10))}, ${feed.lastResult}` : 'Never synced'}
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
  externalBackupFromEnv: boolean;
  externalBackupError: string | null;
  retentionDays: number;
  todayBackedUp: boolean;
  todayBackedUpExternally: boolean;
  backups: BackupRecord[];
}

/** A drive attached to the machine running the server, as reported by it. */
interface DetectedDrive {
  path: string;
  label: string;
  writable: boolean;
  isCurrentTarget: boolean;
  removable: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function BackupPanel({
  onError,
  onNotify,
  onSaveBackupDir
}: {
  onError: (err: unknown) => void;
  onNotify: (message: string) => void;
  onSaveBackupDir: (dir: string) => Promise<unknown>;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderResult, setFolderResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [drives, setDrives] = useState<DetectedDrive[] | null>(null);
  const [drivesBusy, setDrivesBusy] = useState(false);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [integrityBusy, setIntegrityBusy] = useState(false);

  const refreshStatus = async () => {
    const s = await api.get<BackupStatus>('/api/backup/status');
    setStatus(s);
    return s;
  };

  const refreshDrives = async () => {
    const res = await api.get<{ drives: DetectedDrive[] }>('/api/backup/drives');
    setDrives(res.drives);
    return res.drives;
  };

  /**
   * Select a drive folder and immediately save + run a backup — one tap, done.
   *
   * The old flow was: click a drive → path fills a text box → click Save. Two
   * steps, and the second was easy to miss. This collapses them into one.
   */
  const useDrive = async (dir: string) => {
    setFolder(dir);
    setFolderBusy(true);
    setFolderResult(null);
    try {
      const check = await api.post<{ ok: boolean; message: string }>('/api/backup/check-folder', { dir });
      await onSaveBackupDir(dir);
      if (check.ok && dir.trim()) await api.post('/api/backup/run');
      await Promise.all([refreshStatus(), refreshDrives()]);
      setFolderResult({ ok: check.ok, message: check.message });
      onNotify(
        check.ok
          ? `Drive selected. A copy has been written to ${dir.trim()} and one will follow every day.`
          : `Drive saved, but could not write to it right now. ${check.message}`
      );
    } catch (err) {
      onError(err);
    } finally {
      setFolderBusy(false);
    }
  };

  const findDrives = React.useCallback(async () => {
    setDrivesBusy(true);
    try {
      return await refreshDrives();
    } catch (err) {
      onError(err);
      return null;
    } finally {
      setDrivesBusy(false);
    }
  }, [onError]);

  const load = React.useCallback(async () => {
    try {
      const [s, detectedDrives] = await Promise.all([
        api.get<BackupStatus>('/api/backup/status'),
        api.get<{ drives: DetectedDrive[] }>('/api/backup/drives').then(r => r.drives).catch(() => [] as DetectedDrive[])
      ]);
      setStatus(s);
      setDrives(detectedDrives);
      if (!s.externalBackupDir) {
        setFolder('');
        // Auto-configure: if exactly one removable writable drive is found and no
        // backup is set, select and save it without any further interaction.
        const removable = detectedDrives.filter(d => d.writable && d.removable);
        if (removable.length === 1) {
          void useDrive(removable[0].path);
          return;
        }
      } else {
        setFolder(s.externalBackupDir);
      }
    } catch (err) {
      onError(err);
    }
    // useDrive is intentionally excluded — it is stable and including it would
    // cause the effect to re-run after every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onError]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /*
   * Watch for a drive being plugged in while this screen is open. Detection used to
   * run only when the screen opened or "Look again" was pressed, so a stick
   * plugged in afterwards was invisible until somebody went and asked.
   */
  const backupSet = !!status?.externalBackupDir;
  React.useEffect(() => {
    const timer = window.setInterval(async () => {
      if (folderBusy) return;
      try {
        const res = await api.get<{ drives: DetectedDrive[] }>('/api/backup/drives');
        setDrives(res.drives);
        const removable = res.drives.filter(d => d.writable && d.removable);
        if (!backupSet && removable.length === 1) void useDrive(removable[0].path);
      } catch {
        /* the next tick tries again */
      }
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupSet, folderBusy]);

  const testFolder = async () => {
    setFolderBusy(true);
    setFolderResult(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>('/api/backup/check-folder', { dir: folder });
      setFolderResult({ ok: res.ok, message: res.message });
    } catch (err) {
      onError(err);
    } finally {
      setFolderBusy(false);
    }
  };

  const saveFolder = async () => {
    setFolderBusy(true);
    setFolderResult(null);
    try {
      const check = await api.post<{ ok: boolean; message: string }>('/api/backup/check-folder', { dir: folder });
      await onSaveBackupDir(folder);
      if (check.ok && folder.trim()) await api.post('/api/backup/run');
      await Promise.all([refreshStatus(), refreshDrives()]);
      setFolderResult({ ok: check.ok, message: check.message });
      onNotify(
        !folder.trim()
          ? 'Off-machine backup turned off. Copies are kept on this disk only.'
          : check.ok
            ? `Saved. A copy has been written to ${folder.trim()} and one will follow every day.`
            : `Saved, but that folder could not be written to right now. ${check.message}`
      );
    } catch (err) {
      onError(err);
    } finally {
      setFolderBusy(false);
    }
  };

  /**
   * Ask the application to check its own records.
   *
   * It lives beside backup and recovery because that is where somebody already
   * goes when they are worried about the records, and because the answer to a
   * serious finding is usually a restore.
   */
  const runIntegrity = async () => {
    setIntegrityBusy(true);
    try {
      setIntegrity(await api.get<IntegrityReport>('/api/integrity'));
    } catch (err) {
      onError(err);
    } finally {
      setIntegrityBusy(false);
    }
  };

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
      <IntegritySection report={integrity} busy={integrityBusy} onRun={() => void runIntegrity()} />

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
          as the database they protect, so a disk failure, a theft or a deleted folder takes both. Set a folder below -
          an external drive is ideal, and a second copy is written there every day, automatically.
        </InfoNote>
      )}

      {external && status.externalBackupError && (
        <ErrorNote>
          <strong>Today&apos;s off-machine copy could not be written.</strong> {status.externalBackupError}
        </ErrorNote>
      )}

      {external && !status.externalBackupError && !status.todayBackedUpExternally && (
        <InfoNote tone="amber">
          No copy has reached <code className="rounded bg-white px-1 font-mono">{external}</code> today yet. If that is an
          external drive, check it is plugged in, then use <strong>Back up now</strong>.
        </InfoNote>
      )}

      <div className="space-y-3 rounded-2xl border border-slate-100 bg-white p-5 shadow-xs">
        <div>
          <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-slate-900">
            <HardDrive className="h-4 w-4 text-teal-600" />
            Back up to an external drive
          </h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            Plug in a USB or external drive, leave it connected, and put its folder here. A dated copy is written there
            every day on top of the one kept on this machine. A synced folder (OneDrive, Dropbox, iCloud Drive) works
            just as well.
          </p>
        </div>

        {status.externalBackupFromEnv ? (
          <InfoNote>
            This is currently set outside the application, by the{' '}
            <code className="rounded bg-white px-1 font-mono">VDS_BACKUP_DIR</code> environment variable, to{' '}
            <code className="rounded bg-white px-1 font-mono">{external}</code>. Saving a folder here takes over from it.
          </InfoNote>
        ) : null}

        <Field
          label="Backup folder"
          htmlFor="bk-folder"
          hint="On Windows, e.g. E:\Villaggio-Backups, open the drive in File Explorer and copy the address bar. Leave empty to turn this off."
        >
          <input
            id="bk-folder"
            type="text"
            value={folder}
            onChange={e => {
              setFolder(e.target.value);
              setFolderResult(null);
            }}
            placeholder="E:\Villaggio-Backups"
            className={monoInputClass}
          />
        </Field>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">Drives plugged into the office server</p>
            <SecondaryButton onClick={() => void findDrives()} disabled={drivesBusy}>
              {drivesBusy ? 'Looking…' : 'Look again'}
            </SecondaryButton>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Plug a USB drive into the computer running this system, then choose it below. A drive plugged into any other
            computer cannot be used, the backup is written by the server itself.
          </p>

          {drives && drives.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {drives.map(d => (
                <li key={d.path}>
                  <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium text-slate-900">{d.label}</span>
                      <span className="ml-2 block font-mono text-[11px] text-slate-400 sm:inline">{d.path}</span>
                    </span>
                    <span className="shrink-0">
                      {d.isCurrentTarget ? (
                        <span className="font-semibold text-emerald-700">✓ in use</span>
                      ) : !d.writable ? (
                        <span className="text-xs text-rose-600">not writable</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void useDrive(d.path)}
                          disabled={folderBusy}
                          className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-teal-700 disabled:opacity-50"
                        >
                          Use this drive
                        </button>
                      )}
                    </span>
                  </div>
                  {!d.removable && !d.isCurrentTarget && d.writable && (
                    <p className="ml-1 mt-0.5 text-[10px] text-amber-600">This is the machine's own disk, an external drive is safer.</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              {drives ? 'No drives found. Plug one into the office server and choose "Look again".' : 'Looking for drives…'}
            </p>
          )}
        </div>

        {folderResult && (folderResult.ok ? <SuccessNote>{folderResult.message}</SuccessNote> : <ErrorNote>{folderResult.message}</ErrorNote>)}

        <div className="flex flex-wrap gap-2">
          <SubmitButton type="button" busy={folderBusy} busyLabel="Saving…" onClick={() => void saveFolder()}>
            Save and back up now
          </SubmitButton>
          <SecondaryButton onClick={() => void testFolder()} disabled={folderBusy}>
            Test this folder
          </SecondaryButton>
        </div>
      </div>

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
          <strong>To go back to an earlier day,</strong> use <em>Restore records</em> below: pick a backup from the list
          or choose a snapshot file you downloaded. Nothing is changed until you have seen what the file holds and typed
          RESTORE. If <code className="rounded bg-white px-1 font-mono">db.json</code> is ever damaged, the application
          refuses to start rather than overwriting it, so nothing is lost while you recover.
        </InfoNote>
      </div>

      <RestorePanel backups={status.backups} onError={onError} />

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
        <div className="border-b border-slate-100 bg-slate-50 p-4">
          <h3 className="font-display text-sm font-semibold text-slate-900">Available backups</h3>
        </div>
        {status.backups.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No backups yet" hint={'The first one is taken the day after the application starts, or immediately with “Back up now”.'} />
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

interface RestorePreview {
  summary: { madeAt: string; counts: Record<string, number>; staffNotRecreated: string[] };
  present: { units: number; charges: number; payments: number; expenses: number };
}

type RestoreSource = { source: 'backup'; file: string; location: 'local' | 'external' } | { source: 'snapshot'; snapshot: unknown };

/**
 * Going back to an earlier day, from a daily backup or a downloaded snapshot.
 * The file is read and described first; nothing changes until RESTORE is typed.
 */
function RestorePanel({ backups, onError }: { backups: BackupRecord[]; onError: (err: unknown) => void }) {
  const [source, setSource] = useState<RestoreSource | null>(null);
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState<{ safetyCopy: string; findings: number } | null>(null);

  const reset = () => {
    setSource(null);
    setPreview(null);
    setWord('');
    setProblem('');
  };

  const look = async (src: RestoreSource, name: string) => {
    setBusy(true);
    setProblem('');
    setDone(null);
    try {
      const res = await api.post<RestorePreview>('/api/backup/restore', { ...src, dryRun: true });
      setSource(src);
      setLabel(name);
      setPreview(res);
      setWord('');
    } catch (err) {
      reset();
      setProblem(errorMessage(err, 'That file could not be read.'));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      reset();
      setProblem('That file is not a snapshot or backup. It could not be read as records.');
      return;
    }
    await look({ source: 'snapshot', snapshot: parsed }, file.name);
  };

  const restore = async () => {
    if (!source) return;
    setBusy(true);
    setProblem('');
    try {
      const res = await api.post<{ safetyCopy: string; integrity: { findings: unknown[] } }>('/api/backup/restore', {
        ...source,
        confirm: word.trim()
      });
      setDone({ safetyCopy: res.safetyCopy, findings: res.integrity.findings.length });
      reset();
    } catch (err) {
      setProblem(errorMessage(err, 'The restore failed. Nothing was changed.'));
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const c = preview?.summary.counts;
  return (
    <div className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-xs sm:p-6">
      <h3 className="font-display text-sm font-semibold text-slate-900">Restore records</h3>
      <p className="text-xs text-slate-600">
        Go back to how the records stood on an earlier day. Staff accounts and passwords are not touched, so everyone
        can still sign in. A copy of today&apos;s records is kept first, so a restore can itself be undone.
      </p>

      {done && (
        <SuccessNote>
          Records restored. Reload the page to see them.{' '}
          {done.findings > 0 ? `${done.findings} item(s) on the integrity check are worth a look. ` : ''}
          The earlier records were kept at {done.safetyCopy}.{' '}
          <button type="button" className="font-semibold underline" onClick={() => window.location.reload()}>
            Reload now
          </button>
        </SuccessNote>
      )}
      {problem && <ErrorNote>{problem}</ErrorNote>}

      {!preview && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50">
            Choose a snapshot file…
            <input
              type="file"
              accept=".json,application/json"
              className="sr-only"
              disabled={busy}
              onChange={e => {
                const f = e.target.files?.[0];
                e.target.value = '';
                void chooseFile(f);
              }}
            />
          </label>
          <span className="text-xs text-slate-500">or use “Restore” beside a backup in the list below.</span>
        </div>
      )}

      {!preview && backups.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          {backups.slice(0, 14).map(b => (
            <li key={`${b.location}-${b.file}`} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <span className="min-w-0">
                <span className="font-medium text-slate-800">{formatDayLabel(b.date)}</span>
                <span className="ml-2 text-slate-400">{b.location === 'external' ? 'off-machine' : 'this machine'}</span>
              </span>
              <SecondaryButton onClick={() => void look({ source: 'backup', file: b.file, location: b.location }, `${formatDayLabel(b.date)} backup`)} disabled={busy}>
                Restore…
              </SecondaryButton>
            </li>
          ))}
        </ul>
      )}

      {preview && c && (
        <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
          <p className="text-sm font-semibold">Go back to: {label}</p>
          <p>
            That file was made {preview.summary.madeAt.slice(0, 10)} and holds {c.units} {c.units === 1 ? 'villa' : 'villas'},{' '}
            {c.charges} {c.charges === 1 ? 'charge' : 'charges'}, {c.payments} {c.payments === 1 ? 'payment' : 'payments'} and{' '}
            {c.expenses} {c.expenses === 1 ? 'expense' : 'expenses'}. The records today hold {preview.present.charges}{' '}
            {preview.present.charges === 1 ? 'charge' : 'charges'}, {preview.present.payments}{' '}
            {preview.present.payments === 1 ? 'payment' : 'payments'} and {preview.present.expenses}{' '}
            {preview.present.expenses === 1 ? 'expense' : 'expenses'}.
          </p>
          <p>
            <strong>Everything entered after that day will be removed from the records</strong>, including payments and
            receipts. A copy of today&apos;s records is kept first.
          </p>
          {preview.summary.staffNotRecreated.length > 0 && (
            <p>
              These staff are in the file but have no account here and are not recreated (the file cannot give them a
              password): {preview.summary.staffNotRecreated.join(', ')}. Add them again under Staff if needed.
            </p>
          )}
          <label className="block">
            <span className="font-semibold">Type RESTORE to go ahead</span>
            <input
              value={word}
              onChange={e => setWord(e.target.value)}
              className={`${inputClass} mt-1 max-w-[12rem]`}
              autoComplete="off"
              aria-label="Type RESTORE to confirm"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <SubmitButton type="button" busy={busy} busyLabel="Restoring…" disabled={word.trim() !== 'RESTORE'} onClick={() => void restore()}>
              Restore these records
            </SubmitButton>
            <SecondaryButton onClick={reset} disabled={busy}>
              Cancel
            </SecondaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function GeneralPanel({ settings, onSave }: { settings: AppSettings; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [fxRate, setFxRate] = useState(String(settings.fxRateJmdPerUsd));
  const [vendors, setVendors] = useState(settings.vendors.join('\n'));
  const [booksBeginOn, setBooksBeginOn] = useState(settings.booksBeginOn || '');
  // Held as "show" here because that is what the checkbox says; stored the
  // opposite way round so an older database keeps the card. See AppSettings.
  const [showHealth, setShowHealth] = useState(settings.hidePropertyHealth !== true);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    setBusy(true);
    try {
      await onSave({
        fxRateJmdPerUsd: Number(fxRate),
        booksBeginOn: booksBeginOn || '',
        hidePropertyHealth: !showHealth,
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
        hint="Between 50 and 1000 JMD per USD. Shows an approximate second figure alongside an amount. No stored amount is ever converted with it, and no total mixes the two currencies."
      >
        <input id="gp-fx" type="number" min="50" max="1000" step="0.01" value={fxRate} onChange={e => setFxRate(e.target.value)} className={`${monoInputClass} max-w-[200px]`} />
      </Field>

      <Field
        label="The books begin on"
        htmlFor="gp-books-begin"
        hint="The day this application took over the records. Months before it were billed in whatever system came before, so the application will not report them as unbilled, which lets a tenancy carry its real start date without producing an alert for every month back to it. It does not excuse anything genuinely owed: a balance carried over is entered as a dated charge and ages normally. Leave empty if the records go all the way back."
      >
        <input
          id="gp-books-begin"
          type="date"
          value={booksBeginOn}
          onChange={e => setBooksBeginOn(e.target.value)}
          className={`${monoInputClass} max-w-[220px]`}
        />
      </Field>

      <Field
        label="Property health grade on the dashboard"
        htmlFor="gp-health"
        hint="A single letter for how the property is running, from collection, cost coverage, debt ageing and cash position, each shown with the figures behind it. Turn it off if a graded summary is not wanted on the front page; every underlying figure stays available on its own screen either way."
      >
        {/*
          * Deliberately NOT wrapped in a second <label>. `Field` already renders
          * one with htmlFor="gp-health", and nesting another around the input
          * meant a click on the visible text was forwarded by both — toggling
          * the box twice and landing back where it started, so the setting
          * looked broken while the code was fine. Found by clicking it in a
          * browser; every test passed throughout.
          */}
        <span className="flex items-center gap-2 text-sm text-slate-700">
          <input
            id="gp-health"
            type="checkbox"
            checked={showHealth}
            onChange={e => setShowHealth(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
          />
          <span>Show the property health grade</span>
        </span>
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

/**
 * The application checking its own records, and saying so in plain words.
 *
 * The check itself is worthless if its answer only reaches a console log on a
 * machine in a cupboard. This is the part that makes it a safeguard: whoever is
 * worried about the records can press a button and get a straight answer, and a
 * serious finding names the records so somebody can go and look at them.
 *
 * It deliberately does **not** offer to fix anything. An automatic repair to a
 * ledger is a second, unaudited author of the accounts.
 */
function IntegritySection({
  report,
  busy,
  onRun
}: {
  report: IntegrityReport | null;
  busy: boolean;
  onRun: () => void;
}) {
  const tone = !report
    ? 'border-slate-100 bg-white'
    : report.ok
      ? 'border-emerald-200 bg-emerald-50/50'
      : report.serious > 0
        ? 'border-rose-200 bg-rose-50/50'
        : 'border-amber-200 bg-amber-50/50';

  return (
    <section className={`space-y-3 rounded-2xl border p-6 shadow-xs ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-sm font-semibold text-slate-900">Check the records</h3>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">
            Reads every record and reports anything that contradicts itself, a receipt number issued twice, a month
            billed twice, a villa sold to two guests on one night, money refunded beyond what was received. It changes
            nothing: a fault is reported so a person can decide, never repaired automatically. This also runs on its own
            each time the program starts.
          </p>
        </div>
        <SubmitButton type="button" busy={busy} busyLabel="Checking…" onClick={onRun}>
          Check now
        </SubmitButton>
      </div>

      {report && report.ok && (
        <p className="text-sm font-medium text-emerald-800">
          No contradictions found, {report.counts.payments} payments, {report.counts.charges} charges,{' '}
          {report.counts.bookings} stays and {report.counts.expenses} costs were checked.
        </p>
      )}

      {report && !report.ok && (
        <div className="space-y-3">
          <p className={`text-sm font-semibold ${report.serious > 0 ? 'text-rose-800' : 'text-amber-800'}`}>
            {report.serious > 0
              ? `${report.serious} serious problem${report.serious === 1 ? '' : 's'} found in the records.`
              : `${report.warnings} thing${report.warnings === 1 ? '' : 's'} worth looking at.`}
            {report.serious > 0 && ' Money is misstated somewhere. Do not take a backup over a good one until this is understood.'}
          </p>
          <ul className="space-y-2">
            {report.findings.map(f => (
              <li key={f.code} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-start gap-2">
                  <Badge tone={f.severity === 'serious' ? 'red' : 'amber'}>
                    {f.severity === 'serious' ? 'Serious' : 'Worth checking'}
                  </Badge>
                  <p className="text-xs text-slate-800">{f.message}</p>
                </div>
                {f.records.length > 0 && (
                  <p className="mt-2 break-words font-mono text-[10px] text-slate-500">{f.records.join(' · ')}</p>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-slate-500">
            Nothing has been changed. If a serious finding cannot be explained, restore the most recent backup taken
            before it appeared and re-enter the work since.
          </p>
        </div>
      )}
    </section>
  );
}
