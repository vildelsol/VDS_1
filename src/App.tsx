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
  RecurringExpense,
  AnnualReport as AnnualReportRecord,
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
import OwnerStatements from './components/OwnerStatements';
import ReconciliationTab from './components/Reconciliation';
import Projections from './components/Projections';
import AnnualReport from './components/AnnualReport';
import Charts from './components/Charts';
import Audit from './components/Audit';
import SystemSettings from './components/SystemSettings';
import PrintReceipt from './components/PrintReceipt';
import NotificationsTab from './components/NotificationsTab';
import Login, { ChangePasswordGate } from './components/Login';
import { VersionFooter, VersionMismatchBanner } from './components/VersionCheck';
import {
  ApiError,
  ConnectionState,
  SyncState,
  api,
  errorMessage,
  flushQueue,
  setUnauthenticatedHandler,
  startQueueWatcher,
  subscribeConnection,
  subscribeSync
} from './lib/api';
import { countBookingOverlaps, delinquentAccounts } from './lib/finance';
import { today } from './lib/dates';
import { clearSnapshot, loadSnapshot, saveSnapshot } from './lib/snapshot';
import { forgetScreenState } from './lib/screenState';
import { resetReportRange } from './lib/reportRange';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Calendar,
  ClipboardList,
  FileText,
  Home,
  Key,
  LayoutDashboard,
  Loader2,
  LogOut,
  Landmark,
  Menu,
  PieChart,
  RefreshCw,
  Settings,
  TrendingUp,
  Users,
  Wrench,
  X
} from 'lucide-react';

export type TabKey =
  | 'dashboard'
  | 'notifications'
  | 'units'
  | 'finance'
  | 'bookings'
  | 'utilities'
  | 'reports'
  | 'reconciliation'
  | 'owner-statements'
  | 'charts'
  | 'projections'
  | 'annual-report'
  | 'audit'
  | 'settings';

/**
 * How often an open screen checks in to keep its session alive. Far inside the
 * twelve-hour lifetime, and above the once-a-minute floor browsers throttle a
 * background tab's timers to, so a minimised window keeps checking in too.
 */
const SESSION_HEARTBEAT_MS = 5 * 60 * 1000;

const TAB_TITLES: Record<TabKey, string> = {
  dashboard: 'General Dashboard',
  notifications: 'Notifications Hub',
  units: 'Units Register',
  finance: 'Tenant & HOA Ledger',
  bookings: 'Short-Term Bookings',
  utilities: 'Utilities & Expenses',
  reports: 'Operational Reports',
  reconciliation: 'Bank Reconciliation',
  'owner-statements': 'Owners Statements',
  charts: 'Charts & Visual Snapshots',
  projections: 'Financial Projections',
  'annual-report': 'Annual Report',
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
  recurringExpenses: RecurringExpense[];
  annualReports: AnnualReportRecord[];
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
  recurringExpenses: [],
  annualReports: [],
  tenancies: [],
  auditLogs: [],
  unitActivities: [],
  users: []
};

export default function App() {
  const [session, setSession] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [bootError, setBootError] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [data, setData] = useState<Omit<DbSnapshot, 'settings' | 'currentUser'>>(EMPTY);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeReceipt, setActiveReceipt] = useState<Payment | null>(null);
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(false);
  const [connection, setConnectionState] = useState<ConnectionState>('online');
  const [pendingWrites, setPendingWrites] = useState(0);
  const [sync, setSync] = useState<SyncState>({ phase: 'idle', pending: 0 });
  /**
   * When the records on screen were actually taken from the server, or null when
   * they are live. Set only while falling back to the stored copy.
   */
  const [recordsAsOf, setRecordsAsOf] = useState<number | null>(null);

  useEffect(() => subscribeConnection((state, pending) => {
    setConnectionState(state);
    setPendingWrites(pending);
  }), []);

  // Anything entered while the server was away is sent as soon as it is back,
  // including work queued before this page was even loaded.
  useEffect(() => subscribeSync(setSync), []);
  useEffect(() => {
    startQueueWatcher();
  }, []);

  // A completed sync means the server now holds work this screen does not show.
  useEffect(() => {
    if (sync.phase === 'done') void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.phase]);

  /* ---------------- session ---------------- */

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setSession(null);
      setData(EMPTY);
      setSettings(null);
      setRecordsAsOf(null);
      void clearSnapshot();
    });
  }, []);

  /**
   * Probe for an existing session on start-up.
   *
   * This fails fast rather than sitting in the reconnect loop: until it settles the
   * application can only show a loading spinner, and a spinner that never resolves
   * is indistinguishable from a broken program. A server that is not up yet is
   * reported as exactly that, with a way to try again.
   */
  const checkSession = useCallback(async () => {
    setBootError('');
    setAuthChecked(false);
    try {
      const res = await api.get<{ user: SessionUser }>('/api/auth/me', { failFast: true });
      setSession(res.user);
    } catch (err) {
      // 401 is the ordinary "nobody is signed in" answer — show the login screen.
      if (!(err instanceof ApiError && err.isAuthError)) {
        setBootError(
          errorMessage(err, 'Could not reach the server.') +
            ' If the program has just been started it may still be starting up.'
        );
      }
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  /**
   * Keep an open screen signed in.
   *
   * Ro, 2026-09-16: *"if i leave the program open, say overnight, eventually it
   * times out."* Sessions now last twelve hours from last use rather than from
   * sign-in (see `server/auth.ts`), but a screen nobody touches sends nothing
   * that counts as use — the connection watcher only asks /api/health, which
   * needs no session. So the application checks in by itself.
   *
   * Also on returning to the window: a laptop asleep all night runs no timers,
   * and the first thing it should do on waking is renew, before anyone clicks.
   * A session that genuinely lapsed while the machine was off answers 401, and
   * the ordinary unauthenticated handler shows the sign-in screen as before.
   * Anything else — the server restarting, the network dropping — is ignored
   * here; the connection watcher already reports that, and this must never sign
   * anybody out for it.
   */
  useEffect(() => {
    if (!session) return;
    const checkIn = () => {
      api.get('/api/auth/me', { failFast: true }).catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkIn();
    };
    const timer = window.setInterval(checkIn, SESSION_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', checkIn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', checkIn);
    };
    // The identity, not every copy of the session object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  /* ---------------- data ---------------- */

  /** Spread one /api/db payload into the shape the screens consume. */
  const applySnapshot = useCallback((snapshot: DbSnapshot) => {
    setData({
      units: snapshot.units || [],
      bookings: snapshot.bookings || [],
      charges: snapshot.charges || [],
      payments: snapshot.payments || [],
      utilities: snapshot.utilities || [],
      expenses: snapshot.expenses || [],
      recurringExpenses: snapshot.recurringExpenses || [],
      annualReports: snapshot.annualReports || [],
      tenancies: snapshot.tenancies || [],
      auditLogs: snapshot.auditLogs || [],
      unitActivities: snapshot.unitActivities || [],
      users: snapshot.users || []
    });
    setSettings(snapshot.settings);
  }, []);

  const refresh = useCallback(async () => {
    if (!session || session.mustChangePassword) return;
    setLoading(true);
    try {
      // failFast because this is a read. The reconnect loop exists to protect
      // *writes* — work that exists nowhere else and must not be lost. A read has
      // nothing to lose: if the server is away there is a stored copy to fall
      // back on, and ninety seconds of spinner before showing it is ninety
      // seconds of someone standing at the gate with no answer.
      const snapshot = await api.get<DbSnapshot>('/api/db', { failFast: true });
      applySnapshot(snapshot);
      if (snapshot.currentUser) setSession(snapshot.currentUser);
      setApiError('');
      setRecordsAsOf(null);
      // Kept for the next outage. Deliberately not awaited: writing the copy must
      // never delay records that are already on screen.
      void saveSnapshot(session.id, snapshot);
    } catch (err) {
      // The server is unreachable — fall back to the last load rather than
      // showing nothing. An office that cannot look anything up has stopped, and
      // stale records answer most of what anyone needs at the desk.
      const cached = await loadSnapshot<DbSnapshot>(session.id);
      if (cached) {
        applySnapshot(cached.data);
        setRecordsAsOf(cached.fetchedAt);
        // Not an error the person can act on, and the stale banner already says
        // what is true. Two warnings about one outage is one too many.
        setApiError('');
      } else {
        setRecordsAsOf(null);
        setApiError(errorMessage(err, 'Could not load data from the server.'));
      }
    } finally {
      setLoading(false);
    }
  }, [session, applySnapshot]);

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
    setRecordsAsOf(null);
    // Records must not outlive the session that loaded them: the desk machine is
    // shared, and the next person to sign in is not owed the last one's view.
    // The same goes for where each screen was left — the months and periods
    // remembered across tabs belong to the person who chose them.
    forgetScreenState();
    resetReportRange();
    void clearSnapshot();
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
   * Enter a payment — either money taken right now, or one merely expected.
   *
   * The caller decides which by setting `receivedNow` in the payload: a "Receive
   * payment" button means the money is in hand, so a receipt exists and is
   * offered immediately; a "Record payment" logs an expectation that has no
   * receipt to print until `confirmPayment` below is used.
   */
  const recordPayment = useCallback(
    async (payload: Record<string, unknown>): Promise<Payment> => {
      const result = await api.post<{ payment: Payment }>('/api/payments', payload);
      await refresh();
      if (result.payment.status === 'completed') setActiveReceipt(result.payment);
      return result.payment;
    },
    [refresh]
  );

  /**
   * Confirm that an expected payment actually arrived, then open its receipt.
   *
   * This is the point at which a receipt exists at all, so it is also the point
   * at which one is offered for printing or emailing.
   */
  const confirmPayment = useCallback(
    async (paymentId: string, fields: Record<string, unknown> = {}): Promise<Payment> => {
      const result = await api.post<{ payment: Payment }>(`/api/payments/${paymentId}/confirm`, fields);
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
    // As of today, so a charge posted for a month but not yet due does not
    // count against the badge. Posting the month is not the same as the money
    // falling due, and the badge is a count of things needing doing now.
    const accounts = delinquentAccounts(data.units, data.charges, data.payments, today());
    const unpaidUtilities = data.utilities.filter(u => u.status === 'unpaid').length;
    const pendingExpenses = data.expenses.filter(e => e.status === 'pending').length;
    return accounts.length + unpaidUtilities + pendingExpenses + countBookingOverlaps(data.bookings);
  }, [session, data.units, data.charges, data.payments, data.utilities, data.expenses, data.bookings]);

  /* ---------------- gates ---------------- */

  if (!authChecked) {
    return <StartingUp />;
  }

  if (!session && bootError) {
    return <CannotReachServer message={bootError} onRetry={() => void checkSession()} />;
  }

  if (!session) {
    return (
      <>
        <ConnectionBanner connection={connection} pendingWrites={pendingWrites} recordsAsOf={recordsAsOf} />
        <SyncBanner sync={sync} onRetry={() => void flushQueue()} />
        <Login onSignedIn={user => setSession(user)} />
      </>
    );
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
        {/* Loading the first snapshot is also a moment the link can drop, so the
            reconnect banner has to be reachable from here too. */}
        <ConnectionBanner connection={connection} pendingWrites={pendingWrites} recordsAsOf={recordsAsOf} />
        <SyncBanner sync={sync} onRetry={() => void flushQueue()} />
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

  /**
   * Grouped by how often the screen is actually opened.
   *
   * Thirteen items in one flat list gave a screen opened every morning the same
   * weight as one opened once a quarter, so every trip to the menu meant reading
   * all thirteen. The order within each group is unchanged, and nothing has been
   * hidden or renamed — only sorted into the rhythm the work has.
   */
  const navGroups: { heading: string; items: { key: TabKey; label: string; icon: React.ReactNode; badge?: number; visible: boolean }[] }[] = [
    {
      heading: 'Daily',
      items: [
        { key: 'dashboard', label: 'General Dashboard', icon: <LayoutDashboard className="h-4 w-4" />, visible: true },
        { key: 'notifications', label: 'Notifications Hub', icon: <Bell className="h-4 w-4" />, badge: outstandingCount, visible: true },
        { key: 'units', label: 'Units Register', icon: <Home className="h-4 w-4" />, visible: true },
        { key: 'finance', label: 'HOA & Tenants Ledger', icon: <Key className="h-4 w-4" />, visible: true },
        { key: 'bookings', label: 'Short-Term Bookings', icon: <Calendar className="h-4 w-4" />, visible: true }
      ]
    },
    {
      heading: 'Financial',
      items: [
        { key: 'utilities', label: 'Utilities & Expenses', icon: <Wrench className="h-4 w-4" />, visible: true },
        { key: 'reports', label: 'Operational Reports', icon: <BarChart3 className="h-4 w-4" />, visible: true },
        { key: 'reconciliation', label: 'Bank Reconciliation', icon: <Landmark className="h-4 w-4" />, visible: true },
        { key: 'owner-statements', label: 'Owners Statements', icon: <Users className="h-4 w-4" />, visible: true },
        { key: 'charts', label: 'Charts & Snapshots', icon: <PieChart className="h-4 w-4" />, visible: true },
        { key: 'projections', label: 'Financial Projections', icon: <TrendingUp className="h-4 w-4" />, visible: true },
        { key: 'annual-report', label: 'Annual Report', icon: <FileText className="h-4 w-4" />, visible: true }
      ]
    },
    {
      heading: 'Records',
      items: [
        { key: 'audit', label: 'Audit Trail', icon: <ClipboardList className="h-4 w-4" />, visible: true },
        {
          key: 'settings',
          label: 'System Settings',
          icon: <Settings className="h-4 w-4" />,
          // Hidden rather than shown-then-refused for roles that cannot use it.
          visible: session.role === 'ADMINISTRATOR' || session.role === 'MANAGER' || !!permissions?.hasVetoPower
        }
      ]
    }
  ];

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 font-sans text-slate-800 md:flex-row">
      <ConnectionBanner connection={connection} pendingWrites={pendingWrites} recordsAsOf={recordsAsOf} />
        <SyncBanner sync={sync} onRetry={() => void flushQueue()} />

      {/*
        On a phone the sidebar used to stack above the content at full height, so
        every screen began with ten menu items and the actual page started below
        the fold. It is a slide-over there instead, and the unchanged fixed
        sidebar from md upwards.
      */}
      <div className="flex items-center justify-between gap-3 bg-slate-900 p-4 text-white print:hidden md:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/vds-logo.png" alt="Villaggio Del Sol" className="h-9 w-auto shrink-0" />
          <div className="min-w-0">
            <h1 className="truncate font-display text-sm font-semibold tracking-tight">VILLAGGIO DEL SOL</h1>
            <p className="truncate font-mono text-[10px] uppercase tracking-wider text-teal-400">{TAB_TITLES[activeTab]}</p>
          </div>
        </div>
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          aria-expanded={navOpen}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200"
        >
          <Menu className="h-4 w-4" />
          Menu
          {outstandingCount > 0 && (
            <span className="rounded-full bg-red-500 px-1.5 py-0.5 font-mono text-[9px] font-bold text-white">
              {outstandingCount}
            </span>
          )}
        </button>
      </div>

      {navOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-slate-900/60 backdrop-blur-xs md:hidden"
        />
      )}

      <aside
        className={`z-40 flex shrink-0 flex-col justify-between bg-slate-900 p-6 text-slate-400 print:hidden md:static md:w-64 md:translate-x-0 ${
          navOpen
            ? 'fixed inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto'
            : 'hidden md:flex'
        }`}
      >
        <div className="space-y-8">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-2">
              <img src="/vds-logo.png" alt="Villaggio Del Sol" className="w-32" />
              <p className="font-mono text-[10px] uppercase tracking-wider text-teal-400">Ocho Rios Operations</p>
            </div>
            <button
              onClick={() => setNavOpen(false)}
              aria-label="Close menu"
              className="-mr-1 rounded-lg p-1 text-slate-400 hover:text-white md:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <nav className="space-y-5 text-xs font-medium" aria-label="Main">
            {navGroups
              .map(group => ({ ...group, items: group.items.filter(item => item.visible) }))
              .filter(group => group.items.length > 0)
              .map(group => (
                <div key={group.heading} className="space-y-1.5">
                  <p className="px-4 font-mono text-[9px] uppercase tracking-[0.15em] text-slate-600">{group.heading}</p>
                  {group.items.map(item => (
                    <button
                      key={item.key}
                      onClick={() => {
                        setActiveTab(item.key);
                        setNavOpen(false);
                      }}
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
                </div>
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
          <VersionFooter className="pt-1" />
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

        <VersionMismatchBanner />

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
            tenancies={data.tenancies}
            settings={settings}
            session={session}
            onRecordPayment={recordPayment}
            onNavigateToTab={setActiveTab}
          />
        )}

        {activeTab === 'notifications' && (
          <NotificationsTab
            units={data.units}
            settings={settings}
            charges={data.charges}
            payments={data.payments}
            utilities={data.utilities}
            expenses={data.expenses}
            bookings={data.bookings}
            tenancies={data.tenancies}
            session={session}
            onNavigateToTab={setActiveTab}
            onRecordPayment={recordPayment}
            onSettleUtility={(id, payload) => mutate(() => api.post(`/api/utilities/${id}/settle`, payload))}
            onUpdateExpense={(id, fields) => mutate(() => api.put(`/api/expenses/${id}`, fields))}
            onPostMonth={month => mutate(() => api.post<{ message: string }>('/api/charges/post-month', { monthString: month }))}
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
            expenses={data.expenses}
            unitActivities={data.unitActivities}
            settings={settings}
            session={session}
            onUpdateUnit={unit => mutate(() => api.put(`/api/units/${unit.id}`, unit))}
            onUpdateTenancy={(id, fields) => mutate(() => api.put(`/api/tenancies/${id}`, fields))}
            onEvictTenancy={(id, payload) => mutate(() => api.post<{ writtenOff: number; currency: string; chargesVoided: number }>(`/api/tenancies/${id}/evict`, payload))}
            onAddUnitActivity={payload => mutate(() => api.post('/api/unit-activities', payload))}
            onUpdateUnitActivity={(id, fields) => mutate(() => api.put(`/api/unit-activities/${id}`, fields))}
            onDeleteUnitActivity={id => mutate(() => api.del(`/api/unit-activities/${id}`))}
            onRecordPayment={recordPayment}
            onTakeDeposit={(id, payload) => mutate(() => api.post(`/api/tenancies/${id}/deposit`, payload))}
            onSettleDeposit={(id, payload) => mutate(() => api.post(`/api/tenancies/${id}/deposit/settle`, payload))}
          />
        )}

        {activeTab === 'finance' && (
          <FinanceHub
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            bookings={data.bookings}
            session={session}
            onRecordPayment={recordPayment}
            onConfirmPayment={confirmPayment}
            onReversePayment={(id, reason) => mutate(() => api.post(`/api/payments/${id}/reverse`, { reversalReason: reason }))}
            onRefundPayment={(id, fields) => mutate(() => api.post(`/api/payments/${id}/refund`, fields))}
            onUpdatePayment={(id, fields) => mutate(() => api.put(`/api/payments/${id}`, fields))}
            onPostMonth={month => mutate(() => api.post<{ message: string }>('/api/charges/post-month', { monthString: month }))}
            onVoidCharge={(id, reason) => mutate(() => api.post(`/api/charges/${id}/void`, { reason }))}
            onAddCharge={payload => mutate(() => api.post('/api/charges', payload))}
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
            onHoldDamageDeposit={(id, payload) => mutate(() => api.post(`/api/bookings/${id}/damage-deposit`, payload))}
            onSettleDamageDeposit={(id, payload) => mutate(() => api.post(`/api/bookings/${id}/damage-deposit/settle`, payload))}
          />
        )}

        {activeTab === 'utilities' && (
          <UtilitiesAndExpenses
            units={data.units}
            utilities={data.utilities}
            expenses={data.expenses}
            recurringExpenses={data.recurringExpenses}
            settings={settings}
            session={session}
            onAddUtilityReading={payload => mutate(() => api.post('/api/utilities', payload))}
            onUpdateUtilityReading={(id, fields) => mutate(() => api.put(`/api/utilities/${id}`, fields))}
            onSettleUtility={(id, payload) => mutate(() => api.post(`/api/utilities/${id}/settle`, payload))}
            onAddExpense={payload => mutate(() => api.post('/api/expenses', payload))}
            onUpdateExpense={(id, fields) => mutate(() => api.put(`/api/expenses/${id}`, fields))}
            onVoidExpense={(id, payload) => mutate(() => api.post(`/api/expenses/${id}/void`, payload))}
            onAddRecurring={payload => mutate(() => api.post('/api/recurring-expenses', payload))}
            onUpdateRecurring={(id, fields) => mutate(() => api.put(`/api/recurring-expenses/${id}`, fields))}
            onDeleteRecurring={id => mutate(() => api.del(`/api/recurring-expenses/${id}`))}
            onRecallMonthlyExpenses={payload =>
              mutate(() => api.post<{ message: string; recalled: number }>('/api/expenses/recall-month', payload))
            }
            onPostMonthlyExpenses={payload =>
              mutate(() => api.post<{ message: string; created: number; skipped: number }>('/api/expenses/post-month', payload))
            }
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
            tenancies={data.tenancies}
            settings={settings}
            session={session}
          />
        )}

        {activeTab === 'reconciliation' && (
          <ReconciliationTab
            payments={data.payments}
            units={data.units}
            session={session}
            onReconcile={(id, fields) => mutate(() => api.post(`/api/payments/${id}/reconcile`, fields))}
          />
        )}

        {activeTab === 'owner-statements' && (
          <OwnerStatements
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            expenses={data.expenses}
            utilities={data.utilities}
            settings={settings}
            session={session}
          />
        )}

        {activeTab === 'charts' && (
          <Charts
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            expenses={data.expenses}
            tenancies={data.tenancies}
            bookings={data.bookings}
            settings={settings}
            session={session}
          />
        )}

        {activeTab === 'projections' && (
          <Projections
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            expenses={data.expenses}
            settings={settings}
            session={session}
          />
        )}

        {activeTab === 'annual-report' && (
          <AnnualReport
            units={data.units}
            charges={data.charges}
            payments={data.payments}
            expenses={data.expenses}
            settings={settings}
            reports={data.annualReports}
            currentUserName={session.name}
            canEdit={!!permissions?.postCharges}
            onSave={(year, patch) => mutate(() => api.put(`/api/annual-reports/${year}`, patch))}
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

/**
 * The start-up screen.
 *
 * A bare spinner on its own was the whole of this screen, which meant a server
 * that was slow to answer looked identical to a program that had failed. If the
 * wait runs past a couple of seconds it now says what it is waiting for, so the
 * operator knows to leave it alone rather than wonder whether it is broken.
 */
function StartingUp() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-900 px-6 text-center text-slate-400">
      <Loader2 className="h-5 w-5 animate-spin" />
      {slow && (
        <>
          <p className="text-sm font-medium text-slate-200">Starting up…</p>
          <p className="max-w-sm text-xs leading-relaxed text-slate-500">
            Waiting for the property server to answer. The first start after an update takes longer than usual, this
            screen will move on by itself.
          </p>
        </>
      )}
    </div>
  );
}

/** Shown when the server could not be reached at all, with a way to try again. */
function CannotReachServer({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-900 px-6 text-center">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-6">
        <h1 className="font-display text-base font-semibold text-white">The program is not ready yet</h1>
        <p className="text-xs leading-relaxed text-slate-400">{message}</p>
        <p className="text-[11px] leading-relaxed text-slate-500">
          Leave the green “Villaggio Del Sol” window open, closing it shuts the program down. If this keeps happening,
          restart the computer and start the program again.
        </p>
        <button
          onClick={onRetry}
          className="w-full rounded-xl bg-teal-600 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-teal-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * A fixed banner that appears only when the link to the server is interrupted.
 * It reassures the user their in-progress save is being retried, not lost.
 */
/**
 * The state of the connection, and — when the server is away — how old the
 * records on screen are.
 *
 * Both facts share one banner on purpose. They are one situation, and two
 * stacked warnings about a single outage teach people to ignore banners.
 *
 * The wording is the important part. Records restored from the stored copy are
 * genuinely useful — they answer most of what anyone needs at the desk — but a
 * balance that is an hour old presented as current is how somebody takes a
 * payment that was already taken. So the time they were read is stated outright,
 * and this does not go away until the server answers again.
 */
function ConnectionBanner({
  connection,
  pendingWrites,
  recordsAsOf
}: {
  connection: ConnectionState;
  pendingWrites: number;
  recordsAsOf: number | null;
}) {
  if (connection === 'online' && recordsAsOf === null) return null;

  const queued =
    pendingWrites > 0
      ? ` ${pendingWrites} entr${pendingWrites === 1 ? 'y is' : 'ies are'} held on this machine and will be sent when it returns.`
      : '';

  if (recordsAsOf !== null) {
    const takenAt = new Date(recordsAsOf);
    const sameDay = takenAt.toDateString() === new Date().toDateString();
    const when = sameDay
      ? takenAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : `${takenAt.toLocaleDateString()} ${takenAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    return (
      <div
        role="alert"
        className="fixed inset-x-0 top-0 z-[200] flex items-center justify-center gap-2 bg-red-600 px-4 py-2 text-center text-xs font-medium text-white shadow-md print:hidden"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>
          <strong>The server cannot be reached.</strong> You are looking at records saved on this machine at {when}, anything entered
          elsewhere since then is not shown.{queued}
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[200] flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-center text-xs font-medium text-amber-950 shadow-md print:hidden"
    >
      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
      <span>
        Reconnecting to the server…
        {pendingWrites > 0
          ? ` ${pendingWrites} entr${pendingWrites === 1 ? 'y is' : 'ies are'} being saved and will complete automatically when the connection returns.`
          : ' The application will resume automatically.'}
      </span>
    </div>
  );
}

/**
 * Work entered while the server was away, and its journey to the server.
 *
 * Deliberately loud and specific. An entry sitting in this queue is *not* banked
 * — the receptionist has typed it and this machine has kept it, but the HP has
 * never seen it. Saying "saved" without qualification there would be the single
 * most dangerous sentence in the application, so it says what is actually true:
 * held here, not yet sent.
 */
function SyncBanner({ sync, onRetry }: { sync: SyncState; onRetry: () => void }) {
  if (sync.phase === 'idle' && sync.pending === 0) return null;

  if (sync.phase === 'syncing') {
    return (
      <div
        role="status"
        className="fixed inset-x-0 top-0 z-[201] flex items-center justify-center gap-2 bg-sky-600 px-4 py-2 text-center text-xs font-medium text-white shadow-md print:hidden"
      >
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        <span>
          Synchronising… sending {sync.current.toLowerCase()} ({sync.done + 1} of {sync.total})
        </span>
      </div>
    );
  }

  if (sync.phase === 'done') {
    return (
      <div
        role="status"
        className="fixed inset-x-0 top-0 z-[201] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-emerald-600 px-4 py-2 text-center text-xs font-medium text-white shadow-md print:hidden"
      >
        <span className="font-semibold">Synchronised.</span>
        {sync.uploaded.map((label, i) => (
          <span key={i}>✓ {label}</span>
        ))}
      </div>
    );
  }

  const pending = sync.phase === 'failed' ? sync.pending : sync.pending;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[201] flex flex-wrap items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-center text-xs font-medium text-amber-950 shadow-md print:hidden"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        <strong>
          {pending} entr{pending === 1 ? 'y is' : 'ies are'} held on this computer and not yet sent to the server.
        </strong>{' '}
        Nothing is lost, they will be sent automatically when it is reachable.
      </span>
      <button onClick={onRetry} className="rounded-lg bg-amber-950/20 px-2 py-0.5 font-semibold underline-offset-2 hover:bg-amber-950/30">
        Try now
      </button>
    </div>
  );
}
