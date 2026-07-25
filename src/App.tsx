/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppSettings,
  AuditLog,
  Booking,
  Charge,
  Expense,
  Payment,
  SessionUser,
  Tenancy,
  Unit,
  UnitActivity,
  User,
  UtilityReading
} from './types';
import Dashboard from './components/Dashboard';
import Units from './components/Units';
import FinanceHub from './components/FinanceHub';
import Bookings from './components/Bookings';
import UtilitiesAndExpenses from './components/UtilitiesAndExpenses';
import Reports from './components/Reports';
import Audit from './components/Audit';
import SystemSettings from './components/SystemSettings';
import PrintReceipt from './components/PrintReceipt';
import NotificationsTab from './components/NotificationsTab';
import Login, { ChangePasswordGate } from './components/Login';
import { api, errorMessage, setUnauthenticatedHandler } from './lib/api';
import { delinquentAccounts } from './lib/finance';
import {
  BarChart3,
  Bell,
  Calendar,
  ClipboardList,
  Home,
  Key,
  LayoutDashboard,
  Loader2,
  LogOut,
  RefreshCw,
  Settings,
  Wrench
} from 'lucide-react';

export type TabKey =
  | 'dashboard'
  | 'notifications'
  | 'units'
  | 'finance'
  | 'bookings'
  | 'utilities'
  | 'reports'
  | 'audit'
  | 'settings';

const TAB_TITLES: Record<TabKey, string> = {
  dashboard: 'General Dashboard',
  notifications: 'Notifications Hub',
  units: 'Units Register',
  finance: 'Tenant & HOA Ledger',
  bookings: 'Short-Term Bookings',
  utilities: 'Utilities & Expenses',
  reports: 'Operational Reports',
  audit: 'Audit Trail',
  settings: 'System Settings'
};

interface DbSnapshot {
  units: Unit[];
  bookings: Booking[];
  charges: Charge[];
  payments: Payment[];
  utilities: UtilityReading[];
  expenses: Expense[];
  tenancies: Tenancy[];
  auditLogs: AuditLog[];
  unitActivities: UnitActivity[];
  settings: AppSettings;
  users: User[];
  currentUser: SessionUser;
}

const EMPTY: Omit<DbSnapshot, 'settings' | 'currentUser'> = {
  units: [],
  bookings: [],
  charges: [],
  payments: [],
  utilities: [],
  expenses: [],
  tenancies: [],
  auditLogs: [],
  unitActivities: [],
  users: []
};

export default function App() {
  const [session, setSession] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [data, setData] = useState<Omit<DbSnapshot, 'settings' | 'currentUser'>>(EMPTY);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeReceipt, setActiveReceipt] = useState<Payment | null>(null);
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(false);

  /* ---------------- session ---------------- */

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setSession(null);
      setData(EMPTY);
      setSettings(null);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ user: SessionUser }>('/api/auth/me')
      .then(res => {
        if (!cancelled) setSession(res.user);
      })
      .catch(() => {
        /* not signed in — the login screen is the expected outcome */
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- data ---------------- */

  const refresh = useCallback(async () => {
    if (!session || session.mustChangePassword) return;
    setLoading(true);
    try {
      const snapshot = await api.get<DbSnapshot>('/api/db');
      setData({
        units: snapshot.units || [],
        bookings: snapshot.bookings || [],
        charges: snapshot.charges || [],
        payments: snapshot.payments || [],
        utilities: snapshot.utilities || [],
        expenses: snapshot.expenses || [],
        tenancies: snapshot.tenancies || [],
        auditLogs: snapshot.auditLogs || [],
        unitActivities: snapshot.unitActivities || [],
        users: snapshot.users || []
      });
      setSettings(snapshot.settings);
      if (snapshot.currentUser) setSession(snapshot.currentUser);
      setApiError('');
    } catch (err) {
      setApiError(errorMessage(err, 'Could not load data from the server.'));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
    // Only re-run when the identity actually changes, not on every session object copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.mustChangePassword]);

  const handleLogout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* signing out locally regardless */
    }
    setSession(null);
    setData(EMPTY);
    setSettings(null);
    setActiveTab('dashboard');
  }, []);

  /**
   * Wrap a mutating call so the caller gets the error to display, and the local
   * snapshot is always refreshed from the server afterwards. Optimistic local
   * state was the source of screens disagreeing with each other.
   */
  const mutate = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      const result = await fn();
      await refresh();
      return result;
    },
    [refresh]
  );

  /**
   * Record a payment, refresh, and open its receipt so staff can print or email
   * it straight away. Every "receive payment" entry point routes through this, so
   * a receipt is always one step away the moment money is taken.
   */
  const recordPayment = useCallback(
    async (payload: Record<string, unknown>): Promise<Payment> => {
      const result = await api.post<{ payment: Payment }>('/api/payments', payload);
      await refresh();
      setActiveReceipt(result.payment);
      return result.payment;
    },
    [refresh]
  );

  /* ---------------- derived ---------------- */

  const permissions = session?.permissions;

  const outstandingCount = useMemo(() => {
    if (!session) return 0;
    const accounts = delinquentAccounts(data.units, data.charges, data.payments);
    const unpaidUtilities = data.utilities.filter(u => u.status === 'unpaid').length;
    const pendingExpenses = data.expenses.filter(e => e.status === 'pending').length;
    return accounts.length + unpaidUtilities + pendingExpenses;
  }, [session, data.units, data.charges, data.payments, data.utilities, data.expenses]);

  /* ---------------- gates ---------------- */

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <Login onSignedIn={user => setSession(user)} />;
  }

  if (session.mustChangePassword) {
    return (
      <ChangePasswordGate
        user={session}
        onDone={() => setSession({ ...session, mustChangePassword: false })}
      />
    );
  }

  if (!settings) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 text-slate-500">
        {apiError ? (
          <>
            <p className="max-w-md text-center text-sm text-red-700">{apiError}</p>
            <button
              onClick={() => void refresh()}
              className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
            >
              Try again
            </button>
            <button onClick={() => void handleLogout()} className="text-xs text-slate-500 underline">
              Sign out
            </button>
          </>
        ) : (
          <Loader2 className="h-5 w-5 animate-spin" />
        )}
      </div>
    );
  }

  const navItems: { key: TabKey; label: string; icon: React.ReactNode; badge?: number; visible: boolean }[] = [
    { key: 'dashboard', label: 'General Dashboard', icon: <LayoutDashboard className="h-4 w-4" />, visible: true },
    { key: 'notifications', label: 'Notifications Hub', icon: <Bell className="h-4 w-4" />, badge: outstandingCount, visible: true },
    { key: 'units', label: 'Units Register', icon: <Home className="h-4 w-4" />, visible: true },
    { key: 'finance', label: 'HOA & Tenants Ledger', icon: <Key className="h-4 w-4" />, visible: true },
    { key: 'bookings', label: 'Short-Term Bookings', icon: <Calendar className="h-4 w-4" />, visible: true },
    { key: 'utilities', label: 'Utilities & Expenses', icon: <Wrench className="h-4 w-4" />, visible: true },
    { key: 'reports', label: 'Operational Reports', icon: <BarChart3 className="h-4 w-4" />, visible: true },
    { key: 'audit', label: 'Audit Trail', icon: <ClipboardList className="h-4 w-4" />, visible: true },
    {
      key: 'settings',
      label: 'System Settings',
      icon: <Settings className="h-4 w-4" />,
      // Hidden rather than shown-then-refused for roles that cannot use it.
      visible: session.role === 'ADMINISTRATOR' || session.role === 'MANAGER' || !!permissions?.hasVetoPower
    }
  ];

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 font-sans text-slate-800 md:flex-row">
      <aside className="flex w-full shrink-0 flex-col justify-between bg-slate-900 p-6 text-slate-400 print:hidden md:w-64">
        <div className="space-y-8">
          <div>
            <h1 className="font-display text-lg font-semibold tracking-tight text-white">VILLAGGIO DEL SOL</h1>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-teal-400">Ocho Rios Operations</p>
          </div>

          <nav className="space-y-1.5 text-xs font-medium" aria-label="Main">
            {navItems
              .filter(item => item.visible)
              .map(item => (
                <button
                  key={item.key}
                  onClick={() => setActiveTab(item.key)}
                  aria-current={activeTab === item.key ? 'page' : undefined}
                  className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 transition-all ${
                    activeTab === item.key
                      ? 'bg-teal-600 font-semibold text-white'
                      : 'hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    {item.icon}
                    {item.label}
                  </span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="rounded-full bg-red-500 px-1.5 py-0.5 font-mono text-[9px] font-bold text-white">
                      {item.badge}
                    </span>
                  )}
                </button>
              ))}
          </nav>
        </div>

        <div className="space-y-3 border-t border-slate-800 pt-6">
          <div className="px-1">
            <p className="truncate text-xs font-semibold text-slate-200">{session.name}</p>
            <p className="truncate font-mono text-[10px] uppercase tracking-wider text-slate-500">
              {session.role.replace('_', ' ')}
            </p>
            {session.position && <p className="truncate text-[10px] text-slate-500">{session.position}</p>}
          </div>
          <button
            onClick={() => void handleLogout()}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-800 py-2 text-[11px] font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 space-y-6 overflow-x-hidden p-6 md:p-8">
        <header className="flex flex-col items-start justify-between gap-4 border-b border-slate-200 pb-5 print:hidden sm:flex-row sm:items-center">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-900">{TAB_TITLES[activeTab]}</h2>
            <p className="mt-1 text-xs text-slate-500">
              Signed in as <strong className="text-slate-800">{session.name}</strong> ({session.role.replace('_', ' ')})
            </p>
          </div>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-2.5 text-xs font-medium text-slate-500 transition-all hover:bg-slate-50 hover:text-slate-800 disabled:opacity-60"
            title="Reload data from the server"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </header>

        {apiError && (
          <div role="alert" className="flex items-center gap-1.5 rounded-xl border border-red-100 bg-red-50 p-3 text-xs text-red-800 print:hidden">
            <span className="font-semibold">Server error:</span>
            <span>{apiError}</span>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <Dashboard
            units={data.units}
            bookings={data.bookings}
            charges={data.charges}
            payments={data.payments}
            expenses={data.expenses}
            settings={settings}
            session={session}
            onRefresh={refresh}
            onRecordPayment={recordPayment}
            onNavigateToTab={setActiveTab}
          />
        )}

        {activeTab === 'notifications' && (
          <NotificationsTab
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            utilities={data.utilities}
            expenses={data.expenses}
            session={session}
            onRecordPayment={recordPayment}
            onSettleUtility={(id, payload) => mutate(() => api.post(`/api/utilities/${id}/settle`, payload))}
            onUpdateExpense={(id, fields) => mutate(() => api.put(`/api/expenses/${id}`, fields))}
          />
        )}

        {activeTab === 'units' && (
          <Units
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            utilities={data.utilities}
            bookings={data.bookings}
            tenancies={data.tenancies}
            unitActivities={data.unitActivities}
            settings={settings}
            session={session}
            onUpdateUnit={unit => mutate(() => api.put(`/api/units/${unit.id}`, unit))}
            onUpdateTenancy={(id, fields) => mutate(() => api.put(`/api/tenancies/${id}`, fields))}
            onEvictTenancy={(id, payload) => mutate(() => api.post<{ writtenOff: number; currency: string; chargesVoided: number }>(`/api/tenancies/${id}/evict`, payload))}
            onAddUnitActivity={payload => mutate(() => api.post('/api/unit-activities', payload))}
            onDeleteUnitActivity={id => mutate(() => api.del(`/api/unit-activities/${id}`))}
          />
        )}

        {activeTab === 'finance' && (
          <FinanceHub
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            session={session}
            onRecordPayment={recordPayment}
            onReversePayment={(id, reason) => mutate(() => api.post(`/api/payments/${id}/reverse`, { reversalReason: reason }))}
            onUpdatePayment={(id, fields) => mutate(() => api.put(`/api/payments/${id}`, fields))}
            onPostMonth={month => mutate(() => api.post<{ message: string }>('/api/charges/post-month', { monthString: month }))}
            onVoidCharge={(id, reason) => mutate(() => api.post(`/api/charges/${id}/void`, { reason }))}
            onOpenReceipt={setActiveReceipt}
          />
        )}

        {activeTab === 'bookings' && (
          <Bookings
            units={data.units}
            bookings={data.bookings}
            settings={settings}
            session={session}
            onAddBooking={payload => mutate(() => api.post<{ booking: Booking }>('/api/bookings', payload).then(r => r.booking))}
            onUpdateBooking={(id, fields) => mutate(() => api.put(`/api/bookings/${id}`, fields))}
            onSyncCalendars={feedId => mutate(() => api.post<{ results: unknown[] }>('/api/ical/sync', feedId ? { feedId } : {}))}
          />
        )}

        {activeTab === 'utilities' && (
          <UtilitiesAndExpenses
            units={data.units}
            utilities={data.utilities}
            expenses={data.expenses}
            settings={settings}
            session={session}
            onAddUtilityReading={payload => mutate(() => api.post('/api/utilities', payload))}
            onUpdateUtilityReading={(id, fields) => mutate(() => api.put(`/api/utilities/${id}`, fields))}
            onSettleUtility={(id, payload) => mutate(() => api.post(`/api/utilities/${id}/settle`, payload))}
            onAddExpense={payload => mutate(() => api.post('/api/expenses', payload))}
            onUpdateExpense={(id, fields) => mutate(() => api.put(`/api/expenses/${id}`, fields))}
          />
        )}

        {activeTab === 'reports' && (
          <Reports
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            expenses={data.expenses}
            utilities={data.utilities}
            bookings={data.bookings}
            settings={settings}
            session={session}
          />
        )}

        {activeTab === 'audit' && <Audit auditLogs={data.auditLogs} />}

        {activeTab === 'settings' && (
          <SystemSettings
            settings={settings}
            users={data.users}
            units={data.units}
            session={session}
            onUpdateSettings={payload => mutate(() => api.post('/api/settings', payload))}
            onCreateUser={payload => mutate(() => api.post('/api/users', payload))}
            onUpdateUser={(id, fields) => mutate(() => api.put(`/api/users/${id}`, fields))}
            onResetPassword={(id, password) => mutate(() => api.post(`/api/users/${id}/reset-password`, { password }))}
            onAddFeed={payload => mutate(() => api.post('/api/ical/feeds', payload))}
            onRemoveFeed={id => mutate(() => api.del(`/api/ical/feeds/${id}`))}
            onSyncFeed={id => mutate(() => api.post<{ results: unknown[] }>('/api/ical/sync', id ? { feedId: id } : {}))}
          />
        )}
      </main>

      {activeReceipt && (
        <PrintReceipt
          payment={activeReceipt}
          units={data.units}
          bookings={data.bookings}
          onClose={() => setActiveReceipt(null)}
          onMarkPrinted={id => api.post(`/api/payments/${id}/mark-printed`).then(() => refresh())}
        />
      )}
    </div>
  );
}
