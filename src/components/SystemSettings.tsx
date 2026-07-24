/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { UserRole, RolePermissions, StaffProfile } from '../types';
import { ShieldCheck, ToggleLeft, ToggleRight, Info, ShieldAlert, Edit2, Check, UserCheck, X, Plus, Trash, FileSpreadsheet } from 'lucide-react';

interface SystemSettingsProps {
  activeRole: UserRole;
  juniorHasAdvancedAccess: boolean;
  juniorPermissions: RolePermissions;
  rolePermissions: {
    MANAGER: RolePermissions;
    FINANCE_OFFICER: RolePermissions;
    JUNIOR_OFFICER: RolePermissions;
  };
  staffProfiles: {
    ADMINISTRATOR: StaffProfile;
    MANAGER: StaffProfile;
    FINANCE_OFFICER: StaffProfile;
    JUNIOR_OFFICER: StaffProfile;
  };
  vendors: string[];
  onUpdateJuniorAccessSetting: (hasAccess: boolean, permissions?: any) => Promise<void>;
  onUpdateSystemSettings: (payload: {
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
  }) => Promise<void>;
}

export default function SystemSettings({
  activeRole,
  juniorHasAdvancedAccess,
  juniorPermissions,
  rolePermissions,
  staffProfiles,
  vendors,
  onUpdateJuniorAccessSetting,
  onUpdateSystemSettings
}: SystemSettingsProps) {
  const [toggleLoading, setToggleLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Local state for role and profile edits
  const [selectedRoleToEdit, setSelectedRoleToEdit] = useState<'MANAGER' | 'FINANCE_OFFICER' | 'JUNIOR_OFFICER'>('JUNIOR_OFFICER');
  const [editingProfileRole, setEditingProfileRole] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPosition, setEditPosition] = useState('');
  const [newVendorName, setNewVendorName] = useState('');

  const isAdminOrManager = activeRole === 'ADMINISTRATOR' || activeRole === 'MANAGER' || !!(rolePermissions as any)[activeRole]?.hasVetoPower;

  const handleTogglePermission = async (key: string) => {
    if (!isAdminOrManager) {
      setErrorMsg('Unauthorized: Only Administrators or Managers are authorized to modify granular roles.');
      return;
    }
    setToggleLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const currentRolePerms = rolePermissions[selectedRoleToEdit] || {
        editBookings: false,
        cancelBookings: false,
        addBookings: false,
        editUnits: false,
        reversePayments: false,
        enterUtilities: false,
        recordExpenses: false,
        modifySettledRecords: false,
        hasVetoPower: false
      };
      
      const nextRolePerms = {
        ...currentRolePerms,
        [key]: !(currentRolePerms as any)[key]
      };
      
      const updatedRolePermissions = {
        ...rolePermissions,
        [selectedRoleToEdit]: nextRolePerms
      };

      const payload: any = { rolePermissions: updatedRolePermissions };
      if (selectedRoleToEdit === 'JUNIOR_OFFICER') {
        payload.juniorPermissions = nextRolePerms;
      }

      await onUpdateSystemSettings(payload);
      setSuccessMsg(`Granular permission for ${selectedRoleToEdit.replace('_', ' ')} updated successfully!`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error updating granular permissions.');
    } finally {
      setToggleLoading(false);
    }
  };

  const handleToggleJuniorAccess = async () => {
    if (!isAdminOrManager) return;
    setToggleLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const nextState = !juniorHasAdvancedAccess;
      await onUpdateJuniorAccessSetting(nextState, rolePermissions.JUNIOR_OFFICER);
      setSuccessMsg(`Junior advanced global override setting updated to: ${nextState ? 'ENABLED' : 'DISABLED'}`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error updating settings.');
    } finally {
      setToggleLoading(false);
    }
  };

  const handleStartEditProfile = (role: string, name: string, position: string) => {
    setEditingProfileRole(role);
    setEditName(name);
    setEditPosition(position);
  };

  const handleSaveProfile = async (role: any) => {
    if (activeRole !== 'ADMINISTRATOR') {
      setErrorMsg('Unauthorized: Only an Administrator is permitted to modify staff registry directories.');
      return;
    }
    setToggleLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const updatedProfiles = {
        ...staffProfiles,
        [role]: { name: editName, position: editPosition }
      };
      await onUpdateSystemSettings({ staffProfiles: updatedProfiles });
      setSuccessMsg(`Staff profile registry for ${role.replace('_', ' ')} saved successfully!`);
      setEditingProfileRole(null);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error saving profile.');
    } finally {
      setToggleLoading(false);
    }
  };

  const handleAddVendor = async () => {
    if (!newVendorName.trim()) return;
    if (vendors.includes(newVendorName.trim())) {
      setErrorMsg('This vendor is already registered in the directory.');
      return;
    }
    setErrorMsg('');
    setSuccessMsg('');
    setToggleLoading(true);
    try {
      const updatedVendors = [...vendors, newVendorName.trim()];
      await onUpdateSystemSettings({ vendors: updatedVendors });
      setNewVendorName('');
      setSuccessMsg(`Vendor "${newVendorName.trim()}" registered successfully!`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to add vendor.');
    } finally {
      setToggleLoading(false);
    }
  };

  const handleRemoveVendor = async (vendorToRemove: string) => {
    setErrorMsg('');
    setSuccessMsg('');
    setToggleLoading(true);
    try {
      const updatedVendors = vendors.filter(v => v !== vendorToRemove);
      await onUpdateSystemSettings({ vendors: updatedVendors });
      setSuccessMsg(`Vendor "${vendorToRemove}" removed successfully.`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to remove vendor.');
    } finally {
      setToggleLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      
      {errorMsg && (
        <div className="p-3 bg-red-50 border border-red-100 text-red-800 text-xs rounded-xl flex items-center gap-1.5 font-mono">
          <ShieldAlert className="w-4 h-4 text-red-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3 bg-teal-50 border border-teal-100 text-teal-800 text-xs rounded-xl font-mono">
          {successMsg}
        </div>
      )}

      {/* CARD 1: STAFF DIRECTORY CONFIGURATION */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-4 max-w-3xl">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <UserCheck className="w-4 h-4 text-teal-600" />
            Staff Registry Directory
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Configure names and positions of property staff members. Only the primary Administrator role may commit changes.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(['ADMINISTRATOR', 'MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'] as const).map((role) => {
            const profile = staffProfiles[role];
            const isEditingThis = editingProfileRole === role;
            return (
              <div key={role} className="p-4 border border-slate-100 rounded-xl bg-slate-50/40 flex flex-col justify-between gap-3">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[9px] font-mono font-bold bg-slate-200 px-2 py-0.5 rounded-full text-slate-600">
                      {role.replace('_', ' ')}
                    </span>
                    {isEditingThis ? (
                      <div className="space-y-2 mt-2">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Staff Name"
                          className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg font-semibold"
                        />
                        <input
                          type="text"
                          value={editPosition}
                          onChange={(e) => setEditPosition(e.target.value)}
                          placeholder="Position Suffix"
                          className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg text-slate-500"
                        />
                      </div>
                    ) : (
                      <div className="mt-1.5">
                        <h4 className="text-xs font-semibold text-slate-800">{profile.name}</h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">{profile.position}</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex justify-end border-t border-slate-100/60 pt-2">
                  {activeRole === 'ADMINISTRATOR' ? (
                    isEditingThis ? (
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => handleSaveProfile(role)}
                          disabled={toggleLoading}
                          className="px-2.5 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-[10px] font-medium flex items-center gap-1"
                        >
                          <Check className="w-3 h-3" /> Save
                        </button>
                        <button
                          onClick={() => setEditingProfileRole(null)}
                          className="px-2.5 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-[10px]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleStartEditProfile(role, profile.name, profile.position)}
                        className="text-slate-400 hover:text-slate-700 text-[10px] font-medium flex items-center gap-1"
                      >
                        <Edit2 className="w-3 h-3" /> Edit Profile
                      </button>
                    )
                  ) : (
                    <span className="text-[9px] font-mono text-slate-400 italic">Locked (Admin Only)</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* CARD 2: GRANULAR PERMISSIONS PANEL */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-6 max-w-3xl">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-teal-600" />
            Staff Role Access Level Settings
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Configure granular capability levels for operations staff. Select a role below to customize its specific permissions checklist manually.
          </p>
        </div>

        {/* Role Tab Selector */}
        <div className="flex border-b border-slate-100 pb-1 gap-2">
          {(['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'] as const).map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => setSelectedRoleToEdit(role)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                selectedRoleToEdit === role 
                  ? 'bg-slate-900 text-white shadow-xs' 
                  : 'text-slate-400 hover:text-slate-700 bg-slate-50'
              }`}
            >
              {role.replace('_', ' ')}
            </button>
          ))}
        </div>

        {selectedRoleToEdit === 'JUNIOR_OFFICER' && (
          <div className="p-4 bg-slate-50/50 border border-slate-100 rounded-2xl flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-slate-800 block">Advanced Access Master Override (Junior Role)</span>
              <p className="text-[11px] text-slate-400 mt-0.5">Enabling this grants Junior Officers total permissions across all modules (ignores checkboxes below).</p>
            </div>
            
            {isAdminOrManager ? (
              <button
                type="button"
                onClick={handleToggleJuniorAccess}
                disabled={toggleLoading}
                className="text-slate-600 hover:text-slate-800 disabled:opacity-50"
              >
                {juniorHasAdvancedAccess ? (
                  <ToggleRight className="w-12 h-12 text-teal-600" />
                ) : (
                  <ToggleLeft className="w-12 h-12 text-slate-300" />
                )}
              </button>
            ) : (
              <div className="flex items-center gap-1 text-[10px] font-mono text-red-600 bg-red-50 border border-red-100 px-2 py-1 rounded-lg">
                <ShieldAlert className="w-4 h-4 text-red-600" />
                <span>Admin / Manager Only</span>
              </div>
            )}
          </div>
        )}

        {/* Granular checklist */}
        <div className="space-y-3 pt-1">
          <div className="flex justify-between items-center">
            <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400">Granular Checklist for {selectedRoleToEdit.replace('_', ' ')}</h4>
            {selectedRoleToEdit === 'MANAGER' && (
              <span className="text-[10px] text-amber-600 font-mono bg-amber-50 px-2 py-0.5 rounded border border-amber-100">
                Caution: Adjusting Manager access affects overall operations
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500">Configure manual credential options for role-restricted property functions.</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {[
              { key: 'editBookings', label: 'Modify Guest Booking Details', desc: 'Allows editing dates, guest details, and stay prices' },
              { key: 'cancelBookings', label: 'Cancel Reservations & Issue Refunds', desc: 'Allows canceling booked guests and refunding deposits' },
              { key: 'addBookings', label: 'Add New Guest Bookings', desc: 'Allows booking new short-term reservations' },
              { key: 'editUnits', label: 'Modify Villa Rates & Configurations', desc: 'Allows renaming villas, editing owner details, and pricing' },
              { key: 'reversePayments', label: 'Reverse Cash Payments & Void Receipts', desc: 'Allows voiding receipt logs for payments' },
              { key: 'enterUtilities', label: 'Enter Utility Meter Readings', desc: 'Allows recording utility meters for water & electricity' },
              { key: 'recordExpenses', label: 'Log Operations Outlays & Expenses', desc: 'Allows logging bills, landscaping, or plumbing charges' },
              { key: 'modifySettledRecords', label: 'Modify Paid/Settled Records', desc: 'Allows editing and modifying settled operational ledger records' },
              { key: 'hasVetoPower', label: 'Administrator Veto Power Override', desc: 'Grants full veto power to modify system settings and manage staff registry profiles' }
            ].map((item) => {
              const isJuniorOverride = selectedRoleToEdit === 'JUNIOR_OFFICER' && juniorHasAdvancedAccess;
              const isChecked = isJuniorOverride || ((rolePermissions[selectedRoleToEdit] || {}) as any)[item.key];
              return (
                <label
                  key={item.key}
                  className={`p-3.5 rounded-xl border flex items-start gap-3 select-none transition-all ${
                    isChecked ? 'bg-teal-50/20 border-teal-100' : 'bg-white border-slate-100 hover:border-slate-200'
                  } ${isAdminOrManager ? 'cursor-pointer' : 'opacity-80'}`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={!isAdminOrManager || isJuniorOverride || toggleLoading}
                    onChange={() => handleTogglePermission(item.key)}
                    className="mt-0.5 rounded text-teal-600 focus:ring-teal-500 h-4 w-4 border-slate-300 disabled:opacity-50"
                  />
                  <div>
                    <span className="text-xs font-semibold text-slate-800 block">{item.label}</span>
                    <span className="text-[10px] text-slate-400 mt-0.5 block leading-normal">{item.desc}</span>
                    {isJuniorOverride && (
                      <span className="text-[9px] font-mono font-semibold text-teal-600 mt-1 block">Enabled by Master Override</span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* CARD 3: DYNAMIC ROLE ACCESS MATRIX DIRECTORY */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-4 max-w-3xl">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Dynamic System Access Directory Matrix</h3>
          <p className="text-xs text-slate-500 font-mono text-[11px] text-slate-400 mt-0.5">
            AUTHORITATIVE RUNTIME PERMISSION STATE MAP
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border border-slate-100 rounded-xl overflow-hidden">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 font-mono text-[9px] uppercase text-slate-400">
                <th className="p-3">Staff Role</th>
                <th className="p-3">Manage Bookings</th>
                <th className="p-3">Adjust Villa Rates</th>
                <th className="p-3">Log Outlays</th>
                <th className="p-3">Void/Reverse Receipts</th>
                <th className="p-3 text-right">Settings Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-600 font-mono text-[10.5px]">
              <tr>
                <td className="p-3 font-semibold text-slate-900">ADMINISTRATOR</td>
                <td className="p-3 text-emerald-600 font-semibold">✓ YES</td>
                <td className="p-3 text-emerald-600 font-semibold">✓ YES</td>
                <td className="p-3 text-emerald-600 font-semibold">✓ YES</td>
                <td className="p-3 text-emerald-600 font-semibold">✓ YES</td>
                <td className="p-3 text-emerald-600 font-semibold text-right">✓ FULL CONTROL</td>
              </tr>
              {(['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'] as const).map((role) => {
                const isJuniorOverride = role === 'JUNIOR_OFFICER' && juniorHasAdvancedAccess;
                const perms = rolePermissions[role] || {
                  addBookings: false,
                  editBookings: false,
                  editUnits: false,
                  recordExpenses: false,
                  reversePayments: false
                };
                const hasBookings = isJuniorOverride || perms.addBookings || perms.editBookings;
                const hasRates = isJuniorOverride || perms.editUnits;
                const hasOutlays = isJuniorOverride || perms.recordExpenses;
                const hasReversals = isJuniorOverride || perms.reversePayments;

                return (
                  <tr key={role}>
                    <td className="p-3 font-semibold text-slate-900">{role.replace('_', ' ')}</td>
                    <td className="p-3">
                      {hasBookings ? (
                        <span className="text-teal-600 font-semibold">✓ GRANTED</span>
                      ) : (
                        <span className="text-slate-400">✗ RESTRICTED</span>
                      )}
                    </td>
                    <td className="p-3">
                      {hasRates ? (
                        <span className="text-teal-600 font-semibold">✓ GRANTED</span>
                      ) : (
                        <span className="text-slate-400">✗ RESTRICTED</span>
                      )}
                    </td>
                    <td className="p-3">
                      {hasOutlays ? (
                        <span className="text-teal-600 font-semibold">✓ GRANTED</span>
                      ) : (
                        <span className="text-slate-400">✗ RESTRICTED</span>
                      )}
                    </td>
                    <td className="p-3">
                      {hasReversals ? (
                        <span className="text-teal-600 font-semibold">✓ GRANTED</span>
                      ) : (
                        <span className="text-slate-400">✗ RESTRICTED</span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      {role === 'MANAGER' ? (
                        <span className="text-teal-600 font-semibold">✓ GRANTED</span>
                      ) : (
                        <span className="text-slate-400">✗ BLOCKED</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* CARD 4: VENDOR REGISTRY DIRECTORY */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-4 max-w-3xl">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <FileSpreadsheet className="w-4 h-4 text-teal-600" />
            Approved Property Vendor Directory
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Maintain the official listing of authorized service contractors and material suppliers. These entries automatically populate the Payee/Vendor dropdown on expense forms.
          </p>
        </div>

        {/* Add Vendor Form */}
        {isAdminOrManager && (
          <div className="flex gap-2 bg-slate-50 p-3 rounded-xl border border-slate-100">
            <input
              type="text"
              placeholder="Enter new vendor name (e.g. Jamaica Plumbers Ltd)..."
              value={newVendorName}
              onChange={(e) => setNewVendorName(e.target.value)}
              className="flex-1 text-xs p-2.5 bg-white border border-slate-200 rounded-lg font-medium"
            />
            <button
              type="button"
              onClick={handleAddVendor}
              disabled={toggleLoading}
              className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold transition-all flex items-center gap-1"
            >
              <Plus className="w-4.5 h-4.5" /> Add
            </button>
          </div>
        )}

        <div className="border border-slate-100 rounded-xl overflow-hidden divide-y divide-slate-100">
          {!vendors || vendors.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-400 italic">No custom vendors registered. Default placeholders will be used.</div>
          ) : (
            vendors.map((vendor, index) => (
              <div key={index} className="p-3.5 flex justify-between items-center hover:bg-slate-50/40 text-xs transition-all">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-slate-400 font-bold bg-slate-100 px-2 py-0.5 rounded">
                    #{String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="font-semibold text-slate-800">{vendor}</span>
                </div>
                {isAdminOrManager && (
                  <button
                    type="button"
                    onClick={() => handleRemoveVendor(vendor)}
                    disabled={toggleLoading}
                    className="text-slate-400 hover:text-red-600 p-1 rounded-lg hover:bg-red-50 transition-all"
                    title="Remove Vendor"
                  >
                    <Trash className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}
