/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Unit, Booking, Payment, UtilityReading, Expense, AuditLog, UnitActivity, UserRole, RolePermissions, StaffProfile } from './types';
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
import { Home, LayoutDashboard, Key, Calendar, ShieldCheck, HelpCircle, User, RefreshCw, BarChart3, Wrench, Settings, ClipboardList, Bell } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'units' | 'finance' | 'bookings' | 'utilities' | 'reports' | 'audit' | 'settings' | 'notifications'>('dashboard');

  // Server Data states
  const [units, setUnits] = useState<Unit[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [utilities, setUtilities] = useState<UtilityReading[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [unitActivities, setUnitActivities] = useState<UnitActivity[]>([]);
  const [juniorHasAdvancedAccess, setJuniorHasAdvancedAccess] = useState(false);
  const [juniorPermissions, setJuniorPermissions] = useState<RolePermissions>({
    editBookings: false,
    cancelBookings: false,
    addBookings: false,
    editUnits: false,
    reversePayments: false,
    enterUtilities: false,
    recordExpenses: false
  });
  
  const [rolePermissions, setRolePermissions] = useState<{
    MANAGER: RolePermissions;
    FINANCE_OFFICER: RolePermissions;
    JUNIOR_OFFICER: RolePermissions;
  }>({
    MANAGER: { editBookings: true, cancelBookings: true, addBookings: true, editUnits: true, reversePayments: true, enterUtilities: true, recordExpenses: true },
    FINANCE_OFFICER: { editBookings: false, cancelBookings: false, addBookings: false, editUnits: true, reversePayments: false, enterUtilities: true, recordExpenses: true },
    JUNIOR_OFFICER: { editBookings: false, cancelBookings: false, addBookings: false, editUnits: false, reversePayments: false, enterUtilities: false, recordExpenses: false }
  });

  const [staffProfiles, setStaffProfiles] = useState<{
    ADMINISTRATOR: StaffProfile;
    MANAGER: StaffProfile;
    FINANCE_OFFICER: StaffProfile;
    JUNIOR_OFFICER: StaffProfile;
  }>({
    ADMINISTRATOR: { name: 'Administrator Andrew', position: 'General Administrator' },
    MANAGER: { name: 'Manager Matthew', position: 'Property Manager' },
    FINANCE_OFFICER: { name: 'Finance Officer Mary', position: 'Accounts Executive' },
    JUNIOR_OFFICER: { name: 'Junior Officer Kevin', position: 'Reservations Agent' }
  });

  const [vendors, setVendors] = useState<string[]>([]);

  // Active User / Role selection
  const [activeUser, setActiveUser] = useState<{ name: string; role: UserRole }>({
    name: 'Administrator Andrew',
    role: 'ADMINISTRATOR'
  });

  const [activeReceipt, setActiveReceipt] = useState<Payment | null>(null);
  const [apiError, setApiError] = useState('');
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Fetch all db data
  useEffect(() => {
    async function loadData() {
      try {
        const res = await fetch('/api/db');
        if (!res.ok) throw new Error('Database server connection error.');
        const data = await res.json();
        
        setUnits(data.units || []);
        setBookings(data.bookings || []);
        setPayments(data.payments || []);
        setUtilities(data.utilities || []);
        setExpenses(data.expenses || []);
        setAuditLogs(data.auditLogs || []);
        setUnitActivities(data.unitActivities || []);
        setJuniorHasAdvancedAccess(data.settings?.juniorHasAdvancedAccess || false);
        if (data.settings?.juniorPermissions) {
          setJuniorPermissions(data.settings.juniorPermissions);
        }
        if (data.settings?.rolePermissions) {
          setRolePermissions(data.settings.rolePermissions);
        }
        if (data.settings?.staffProfiles) {
          setStaffProfiles(data.settings.staffProfiles);
          // Sync current active user name with DB settings if available
          const profile = data.settings.staffProfiles[activeUser.role];
          if (profile && activeUser.name !== profile.name) {
            setActiveUser({ name: profile.name, role: activeUser.role });
          }
        }
        if (data.settings?.vendors) {
          setVendors(data.settings.vendors);
        }
        setApiError('');
      } catch (err: any) {
        setApiError(err.message || 'Error connecting to the Express service.');
      }
    }
    loadData();
  }, [refreshCounter]);

  const triggerRefresh = () => {
    setRefreshCounter(prev => prev + 1);
  };

  // Switch role simulation helper
  const handleUserSwitch = (val: string) => {
    setApiError('');
    const roleVal = val as UserRole;
    const profile = staffProfiles[roleVal];
    if (profile) {
      setActiveUser({ name: profile.name, role: roleVal });
    } else {
      // fallback
      switch (val) {
        case 'ADMINISTRATOR':
          setActiveUser({ name: 'Administrator Andrew', role: 'ADMINISTRATOR' });
          break;
        case 'MANAGER':
          setActiveUser({ name: 'Manager Matthew', role: 'MANAGER' });
          break;
        case 'FINANCE_OFFICER':
          setActiveUser({ name: 'Finance Officer Mary', role: 'FINANCE_OFFICER' });
          break;
        case 'JUNIOR_OFFICER':
          setActiveUser({ name: 'Junior Officer Kevin', role: 'JUNIOR_OFFICER' });
          break;
      }
    }
  };

  // API operations
  const handleUpdateUnit = async (updated: Unit) => {
    const res = await fetch(`/api/units/${updated.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updated,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to update unit parameters.');
    }
    triggerRefresh();
  };

  const handleUpdateSystemSettings = async (payload: {
    juniorHasAdvancedAccess?: boolean;
    juniorPermissions?: RolePermissions;
    rolePermissions?: {
      MANAGER: RolePermissions;
      FINANCE_OFFICER: RolePermissions;
      JUNIOR_OFFICER: RolePermissions;
    };
    staffProfiles?: {
      ADMINISTRATOR: StaffProfile;
      MANAGER: StaffProfile;
      FINANCE_OFFICER: StaffProfile;
      JUNIOR_OFFICER: StaffProfile;
    };
    vendors?: string[];
  }) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to adjust system configurations.');
    }
    triggerRefresh();
  };

  const handleUpdateBooking = async (bookingId: string, updatedFields: any) => {
    const res = await fetch(`/api/bookings/${bookingId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updatedFields,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to update guest booking.');
    }
    triggerRefresh();
  };

  const handleAddBooking = async (bookingData: any) => {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...bookingData,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Overlap or registration failure.');
    }
    const data = await res.json();
    triggerRefresh();
    return data.booking;
  };

  const handleUpdateBookingStatus = async (bookingId: string, status: Booking['status']) => {
    const res = await fetch(`/api/bookings/${bookingId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      alert(errData.error || 'Failed to cancel or check in guests.');
      return;
    }
    triggerRefresh();
  };

  const handleRecordPayment = async (paymentData: any) => {
    const res = await fetch('/api/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...paymentData,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to compile receipt.');
    }
    const data = await res.json();
    triggerRefresh();
    return data.payment;
  };

  const handleReversePayment = async (paymentId: string, reason: string) => {
    const res = await fetch(`/api/payments/${paymentId}/reverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reversalReason: reason,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to process manager reversal.');
    }
    const data = await res.json();
    triggerRefresh();
    return data.payment;
  };

  const handleUpdatePayment = async (paymentId: string, updatedFields: any) => {
    const res = await fetch(`/api/payments/${paymentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updatedFields,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to update transaction.');
    }
    triggerRefresh();
  };

  const handleUpdateExpense = async (expenseId: string, updatedFields: any) => {
    const res = await fetch(`/api/expenses/${expenseId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updatedFields,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to update outlay expense.');
    }
    triggerRefresh();
  };

  const handleAddUnitActivity = async (activityData: any) => {
    const res = await fetch('/api/unit-activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...activityData,
        userRole: activeUser.role,
        loggedBy: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to log resident activity.');
    }
    const data = await res.json();
    triggerRefresh();
    return data.activity;
  };

  const handleDeleteUnitActivity = async (id: string) => {
    const res = await fetch(`/api/unit-activities/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to remove activity record.');
    }
    triggerRefresh();
  };

  const handleAddUtilityReading = async (readingData: any) => {
    const res = await fetch('/api/utilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...readingData,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to save index.');
    }
    const data = await res.json();
    triggerRefresh();
    return data.utility;
  };

  const handleUpdateUtilityStatus = async (id: string, status: UtilityReading['status']) => {
    const res = await fetch(`/api/utilities/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      alert(errData.error || 'Failed to update reading status.');
      return;
    }
    triggerRefresh();
  };

  const handleAddExpense = async (expenseData: any) => {
    const res = await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...expenseData,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to log outlay.');
    }
    const data = await res.json();
    triggerRefresh();
    return data.expense;
  };

  const handleGenerateRecurringCharges = async (monthString: string) => {
    const res = await fetch('/api/generate-recurring-charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monthString,
        userRole: activeUser.role,
        userName: activeUser.name
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to generate month charges.');
    }
    triggerRefresh();
  };

  const currentMonthString = new Date().toISOString().substring(0, 7);
  const pendingRentCount = units
    .filter(u => u.status === 'long-term' && u.monthlyRent > 0)
    .filter(u => {
      const paid = payments
        .filter(p => p.unitNumber === u.number && p.category === 'Rent' && p.status === 'completed' && p.date.startsWith(currentMonthString))
        .reduce((sum, p) => sum + p.amount, 0);
      return paid < u.monthlyRent;
    }).length;

  const pendingMaintCount = units
    .filter(u => u.status !== 'unavailable' && u.monthlyMaintenance > 0)
    .filter(u => {
      const paid = payments
        .filter(p => p.unitNumber === u.number && p.category === 'Maintenance' && p.status === 'completed' && p.date.startsWith(currentMonthString))
        .reduce((sum, p) => sum + p.amount, 0);
      return paid < u.monthlyMaintenance;
    }).length;

  const pendingUtilCount = utilities.filter(u => u.status === 'unpaid').length;
  const pendingExpenseCount = expenses.filter(e => e.status === 'pending').length;

  const totalNotificationsCount = pendingRentCount + pendingMaintCount + pendingUtilCount + pendingExpenseCount;

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-50 font-sans text-slate-800">
      
      {/* SIDEBAR NAVIGATION (Will be hidden during print) */}
      <aside className="w-full md:w-64 bg-slate-900 text-slate-400 p-6 flex flex-col justify-between shrink-0 print:hidden">
        <div className="space-y-8">
          
          {/* Logo / Title */}
          <div>
            <h1 className="text-white text-lg font-display font-semibold tracking-tight">VILLAGGIO DEL SOL</h1>
            <p className="text-[10px] text-teal-400 font-mono tracking-wider mt-1 uppercase">Ocho Rios Operations</p>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1.5 text-xs font-medium">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'dashboard' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <LayoutDashboard className="w-4 h-4" />
              General Dashboard
            </button>

            <button
              onClick={() => setActiveTab('notifications')}
              className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl transition-all ${activeTab === 'notifications' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <div className="flex items-center gap-2.5">
                <Bell className="w-4 h-4" />
                <span>Notifications Hub</span>
              </div>
              {totalNotificationsCount > 0 && (
                <span className="bg-red-500 text-white font-bold font-mono text-[9px] px-1.5 py-0.5 rounded-full animate-pulse">
                  {totalNotificationsCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('units')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'units' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <Home className="w-4 h-4" />
              16 Units Registry
            </button>

            <button
              onClick={() => setActiveTab('finance')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'finance' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <Key className="w-4 h-4" />
              HOA & Tenants Ledger
            </button>

            <button
              onClick={() => setActiveTab('bookings')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'bookings' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <Calendar className="w-4 h-4" />
              Short-Term Bookings
            </button>

            <button
              onClick={() => setActiveTab('utilities')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'utilities' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <Wrench className="w-4 h-4" />
              Utilities & Expenses
            </button>

            <button
              onClick={() => setActiveTab('reports')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'reports' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <BarChart3 className="w-4 h-4" />
              Operational Reports
            </button>

            <button
              onClick={() => setActiveTab('audit')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'audit' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <ClipboardList className="w-4 h-4" />
              Audit Trail logs
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'settings' ? 'bg-teal-600 text-white font-semibold' : 'hover:bg-slate-800 hover:text-slate-100'}`}
            >
              <Settings className="w-4 h-4" />
              System Settings
            </button>
          </nav>
        </div>

        {/* User Role Selector Simulation */}
        <div className="pt-6 border-t border-slate-800 space-y-3">
          <div className="flex items-center gap-2 px-1">
            <User className="w-4 h-4 text-teal-400" />
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Staff Role Switcher</span>
          </div>

          <select
            value={activeUser.role}
            onChange={(e) => handleUserSwitch(e.target.value)}
            className="w-full text-xs bg-slate-850 border border-slate-800 p-2 text-slate-300 rounded-lg focus:outline-hidden focus:ring-1 focus:ring-teal-500 font-mono"
          >
            <option value="ADMINISTRATOR">{staffProfiles.ADMINISTRATOR.name} (Admin)</option>
            <option value="MANAGER">{staffProfiles.MANAGER.name} (Manager)</option>
            <option value="FINANCE_OFFICER">{staffProfiles.FINANCE_OFFICER.name} (Finance)</option>
            <option value="JUNIOR_OFFICER">{staffProfiles.JUNIOR_OFFICER.name} (Junior)</option>
          </select>
        </div>
      </aside>

      {/* MAIN VIEW AREA */}
      <main className="flex-1 p-6 md:p-8 space-y-6 overflow-x-hidden">
        
        {/* HEADER INFORMATION (Hidden during print) */}
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-200 pb-5 print:hidden">
          <div>
            <h2 className="text-xl font-display font-semibold text-slate-900 capitalize">{activeTab} Controls</h2>
            <p className="text-xs text-slate-500 mt-1">
              Active User: <strong className="text-slate-800">{activeUser.name}</strong> ({activeUser.role})
            </p>
          </div>
          <button
            onClick={triggerRefresh}
            className="p-2.5 bg-white border border-slate-200 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-all flex items-center gap-1.5 text-xs font-medium"
            title="Reload database logs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Reload Cache
          </button>
        </header>

        {apiError && (
          <div className="p-3 bg-red-50 border border-red-100 text-red-800 text-xs rounded-xl flex items-center gap-1.5 print:hidden">
            <span className="font-semibold">API Server Error:</span>
            <span>{apiError}</span>
          </div>
        )}

        {/* MOUNT ACTIVE TAB COMPONENT */}
        {activeTab === 'dashboard' && (
          <Dashboard
            units={units}
            bookings={bookings}
            payments={payments}
            expenses={expenses}
            activeRole={activeUser.role}
            onRefresh={triggerRefresh}
            onRecordPayment={handleRecordPayment}
            onUpdateBooking={handleUpdateBooking}
            onNavigateToTab={setActiveTab}
          />
        )}

        {activeTab === 'notifications' && (
          <NotificationsTab
            units={units}
            payments={payments}
            utilities={utilities}
            expenses={expenses}
            activeRole={activeUser.role}
            userName={activeUser.name}
            onRecordPayment={handleRecordPayment}
            onUpdateUtilityStatus={handleUpdateUtilityStatus}
            onUpdateExpense={handleUpdateExpense}
          />
        )}

        {activeTab === 'units' && (
          <Units
            units={units}
            payments={payments}
            utilities={utilities}
            bookings={bookings}
            unitActivities={unitActivities}
            activeRole={activeUser.role}
            juniorHasAdvancedAccess={juniorHasAdvancedAccess}
            onUpdateUnit={handleUpdateUnit}
            onAddUnitActivity={handleAddUnitActivity}
            onDeleteUnitActivity={handleDeleteUnitActivity}
          />
        )}

        {activeTab === 'finance' && (
          <FinanceHub
            units={units}
            payments={payments}
            activeRole={activeUser.role}
            juniorHasAdvancedAccess={juniorHasAdvancedAccess}
            rolePermissions={rolePermissions}
            userName={activeUser.name}
            onRecordPayment={handleRecordPayment}
            onReversePayment={handleReversePayment}
            onUpdatePayment={handleUpdatePayment}
            onGenerateRecurringCharges={handleGenerateRecurringCharges}
            onOpenReceipt={setActiveReceipt}
          />
        )}

        {activeTab === 'bookings' && (
          <Bookings
            units={units}
            bookings={bookings}
            activeRole={activeUser.role}
            juniorHasAdvancedAccess={juniorHasAdvancedAccess}
            juniorPermissions={juniorPermissions}
            onAddBooking={handleAddBooking}
            onUpdateBookingStatus={handleUpdateBookingStatus}
            onUpdateBooking={handleUpdateBooking}
          />
        )}

        {activeTab === 'utilities' && (
          <UtilitiesAndExpenses
            units={units}
            utilities={utilities}
            expenses={expenses}
            activeRole={activeUser.role}
            juniorHasAdvancedAccess={juniorHasAdvancedAccess}
            rolePermissions={rolePermissions}
            vendors={vendors}
            onAddUtilityReading={handleAddUtilityReading}
            onUpdateUtilityStatus={handleUpdateUtilityStatus}
            onAddExpense={handleAddExpense}
            onUpdateExpense={handleUpdateExpense}
          />
        )}

        {activeTab === 'reports' && (
          <Reports
            units={units}
            payments={payments}
            expenses={expenses}
            utilities={utilities}
            activeRole={activeUser.role}
          />
        )}

        {activeTab === 'audit' && (
          <Audit
            auditLogs={auditLogs}
          />
        )}

        {activeTab === 'settings' && (
          <SystemSettings
            activeRole={activeUser.role}
            juniorHasAdvancedAccess={juniorHasAdvancedAccess}
            juniorPermissions={juniorPermissions}
            rolePermissions={rolePermissions}
            staffProfiles={staffProfiles}
            vendors={vendors}
            onUpdateJuniorAccessSetting={async (hasAccess, permissions) => {
              await handleUpdateSystemSettings({
                juniorHasAdvancedAccess: hasAccess,
                juniorPermissions: permissions
              });
            }}
            onUpdateSystemSettings={handleUpdateSystemSettings}
          />
        )}
      </main>

      {/* PRINT RECEIPT OVERLAY COMPONENT */}
      {activeReceipt && (
        <PrintReceipt
          payment={activeReceipt}
          onClose={() => setActiveReceipt(null)}
        />
      )}
    </div>
  );
}
