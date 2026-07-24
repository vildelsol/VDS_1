/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Unit, UserRole, Payment, UtilityReading, Booking, UnitActivity, getUnitDisplayName } from '../types';
import { Home, User, Mail, Phone, ShieldAlert, Edit3, X, HelpCircle, FileText, Printer, ClipboardList, Plus, Trash2, HardHat, Waves, Wrench, Megaphone, Key } from 'lucide-react';

const getOrdinalSuffix = (day: number) => {
  if (day > 3 && day < 21) return 'th';
  switch (day % 10) {
    case 1:  return "st";
    case 2:  return "nd";
    case 3:  return "rd";
    default: return "th";
  }
};

interface UnitsProps {
  units: Unit[];
  payments: Payment[];
  utilities: UtilityReading[];
  bookings: Booking[];
  unitActivities?: UnitActivity[];
  activeRole: UserRole;
  juniorHasAdvancedAccess: boolean;
  onUpdateUnit: (unit: Unit) => Promise<void>;
  onAddUnitActivity?: (activityData: any) => Promise<UnitActivity>;
  onDeleteUnitActivity?: (id: string) => Promise<void>;
}

export default function Units({ units, payments, utilities, bookings, unitActivities = [], activeRole, juniorHasAdvancedAccess, onUpdateUnit, onAddUnitActivity, onDeleteUnitActivity }: UnitsProps) {
  const [selectedUnit, setSelectedUnit] = useState<Unit | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [printActivityUnit, setPrintActivityUnit] = useState<Unit | null>(null);
  
  // Activity Logging Modal state
  const [showLogActivityModal, setShowLogActivityModal] = useState(false);
  const [actType, setActType] = useState<UnitActivity['activityType']>('Construction Work');
  const [actResidentName, setActResidentName] = useState('');
  const [actResidentRole, setActResidentRole] = useState<'Owner' | 'Tenant' | 'Guest' | 'Other'>('Owner');
  const [actDate, setActDate] = useState(new Date().toISOString().split('T')[0]);
  const [actNotes, setActNotes] = useState('');
  const [actLoading, setActLoading] = useState(false);
  const [actError, setActError] = useState('');
  const [actSuccess, setActSuccess] = useState('');
  
  // Local form state
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [tenantEmail, setTenantEmail] = useState('');
  const [tenantPhone, setTenantPhone] = useState('');
  const [status, setStatus] = useState<Unit['status']>('vacant');
  const [monthlyRent, setMonthlyRent] = useState(0);
  const [monthlyMaintenance, setMonthlyMaintenance] = useState(0);
  const [currency, setCurrency] = useState<'USD' | 'JMD'>('JMD');
  const [maintCurrency, setMaintCurrency] = useState<'USD' | 'JMD'>('JMD');
  const [meterNumber, setMeterNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [unitNumber, setUnitNumber] = useState('');
  const [rentDueDay, setRentDueDay] = useState<number>(1);
  const [maintDueDay, setMaintDueDay] = useState<number>(1);
  
  // Emergency Contacts Form State
  const [ownerEmergencyName, setOwnerEmergencyName] = useState('');
  const [ownerEmergencyPhone, setOwnerEmergencyPhone] = useState('');
  const [ownerEmergencyEmail, setOwnerEmergencyEmail] = useState('');
  const [tenantEmergencyName, setTenantEmergencyName] = useState('');
  const [tenantEmergencyPhone, setTenantEmergencyPhone] = useState('');
  const [tenantEmergencyEmail, setTenantEmergencyEmail] = useState('');
  
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const canEdit = activeRole === 'ADMINISTRATOR' || activeRole === 'MANAGER' || activeRole === 'FINANCE_OFFICER' || juniorHasAdvancedAccess;

  const handleSelectUnit = (unit: Unit) => {
    setSelectedUnit(unit);
    setIsEditing(false);
    setErrorMsg('');
    setSuccessMsg('');
    
    // Seed edit form
    setOwnerName(unit.ownerName);
    setOwnerEmail(unit.ownerEmail);
    setOwnerPhone(unit.ownerPhone);
    setTenantName(unit.tenantName || '');
    setTenantEmail(unit.tenantEmail || '');
    setTenantPhone(unit.tenantPhone || '');
    setStatus(unit.status);
    setMonthlyRent(unit.monthlyRent);
    setMonthlyMaintenance(unit.monthlyMaintenance);
    setCurrency(unit.currency);
    setMaintCurrency(unit.maintCurrency || unit.currency);
    setMeterNumber(unit.meterNumber);
    setNotes(unit.notes || '');
    setUnitNumber(unit.number);
    setRentDueDay(unit.rentDueDay || 1);
    setMaintDueDay(unit.maintDueDay || 1);
    setOwnerEmergencyName(unit.ownerEmergencyName || '');
    setOwnerEmergencyPhone(unit.ownerEmergencyPhone || '');
    setOwnerEmergencyEmail(unit.ownerEmergencyEmail || '');
    setTenantEmergencyName(unit.tenantEmergencyName || '');
    setTenantEmergencyPhone(unit.tenantEmergencyPhone || '');
    setTenantEmergencyEmail(unit.tenantEmergencyEmail || '');
  };

  const handleSaveActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUnit || !onAddUnitActivity) return;
    if (!actNotes.trim()) {
      setActError('Please enter description notes or details.');
      return;
    }

    setActLoading(true);
    setActError('');
    setActSuccess('');

    try {
      await onAddUnitActivity({
        unitId: selectedUnit.id,
        unitNumber: selectedUnit.number,
        residentName: actResidentName || selectedUnit.ownerName,
        residentRole: actResidentRole,
        activityType: actType,
        dateCaptured: actDate,
        notes: actNotes
      });
      setActSuccess(`Activity logged successfully for Villa ${selectedUnit.number}!`);
      setActNotes('');
      setTimeout(() => {
        setShowLogActivityModal(false);
        setActSuccess('');
      }, 1000);
    } catch (err: any) {
      setActError(err.message || 'Failed to record resident activity.');
    } finally {
      setActLoading(false);
    }
  };

  const handleDeleteActivity = async (id: string) => {
    if (!onDeleteUnitActivity) return;
    if (confirm('Are you sure you want to delete this activity entry?')) {
      try {
        await onDeleteUnitActivity(id);
      } catch (err: any) {
        alert(err.message || 'Failed to delete activity log.');
      }
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUnit) return;
    if (!canEdit) {
      setErrorMsg('Unauthorized: Junior Officers cannot modify base unit rates or register owners without advanced manager override.');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const isRentAvailable = status === 'long-term' || status === 'short-term' || activeRole === 'ADMINISTRATOR';
      const isTenantAvailable = status === 'long-term' || activeRole === 'ADMINISTRATOR';
      
      const updated: Unit = {
        ...selectedUnit,
        number: unitNumber,
        ownerName,
        ownerEmail,
        ownerPhone,
        tenantName: isTenantAvailable ? tenantName : '',
        tenantEmail: isTenantAvailable ? tenantEmail : '',
        tenantPhone: isTenantAvailable ? tenantPhone : '',
        status,
        monthlyRent: isRentAvailable ? Number(monthlyRent) : 0,
        monthlyMaintenance: Number(monthlyMaintenance),
        currency,
        maintCurrency,
        meterNumber,
        notes,
        rentDueDay: Number(rentDueDay),
        maintDueDay: Number(maintDueDay),
        ownerEmergencyName,
        ownerEmergencyPhone,
        ownerEmergencyEmail,
        tenantEmergencyName,
        tenantEmergencyPhone,
        tenantEmergencyEmail,
      };

      await onUpdateUnit(updated);
      setSuccessMsg('Unit registration updated successfully!');
      setSelectedUnit(updated);
      setIsEditing(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error updating unit parameters.');
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadgeClass = (s: Unit['status']) => {
    switch (s) {
      case 'long-term':
        return 'bg-indigo-50 text-indigo-700 border-indigo-100';
      case 'short-term':
        return 'bg-teal-50 text-teal-700 border-teal-100';
      case 'owner-occupied':
        return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      case 'vacant':
        return 'bg-amber-50 text-amber-700 border-amber-100';
      case 'unavailable':
        return 'bg-slate-100 text-slate-700 border-slate-200';
      default:
        return 'bg-slate-50 text-slate-600';
    }
  };

  const getStatusLabel = (s: Unit['status']) => {
    switch (s) {
      case 'long-term': return 'Long-term Lease';
      case 'short-term': return 'Short-term / Airbnb';
      case 'owner-occupied': return 'Owner Occupied';
      case 'vacant': return 'Vacant';
      case 'unavailable': return 'Unavailable';
      default: return s;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-display font-medium text-slate-900">Villaggio Del Sol Units Register</h2>
          <p className="text-xs text-slate-500 mt-0.5">Physical inventory audit of all 16 gated villas, including tenancy and meter configs</p>
        </div>
        {!canEdit && (
          <div className="flex items-center gap-1.5 p-2 bg-amber-50 border border-amber-100 rounded-xl text-[10px] text-amber-800 font-mono">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
            <span>Read-Only mode: Junior Account</span>
          </div>
        )}
      </div>

      {/* Status Legend */}
      <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-xs flex flex-wrap gap-4 items-center justify-between text-xs">
        <span className="font-mono text-slate-400 uppercase text-[10px] tracking-wider font-semibold">Unit Status Legend:</span>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 border border-emerald-600"></span>
            <span className="font-medium text-slate-700">Long-term Lease (Green)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full bg-amber-400 border border-amber-500"></span>
            <span className="font-medium text-slate-700">Short-term / Airbnb (Yellow)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full bg-sky-400 border border-sky-500"></span>
            <span className="font-medium text-slate-700">Vacant (Blue)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full bg-slate-400 border border-slate-500"></span>
            <span className="font-medium text-slate-700">Unavailable (Grey)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full bg-purple-400 border border-purple-500"></span>
            <span className="font-medium text-slate-700">Owner Occupied (Purple)</span>
          </div>
        </div>
      </div>

      {/* Grid of 16 Units */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {units.map(unit => (
          <button
            key={unit.id}
            onClick={() => handleSelectUnit(unit)}
            className={`group text-left p-5 rounded-2xl border shadow-xs hover:shadow-md transition-all focus:outline-hidden focus:ring-1 focus:ring-teal-500 min-h-[200px] flex flex-col justify-between cursor-pointer ${
              unit.status === 'long-term' ? 'bg-emerald-50/30 border-emerald-100/80 hover:border-emerald-300' :
              unit.status === 'short-term' ? 'bg-amber-50/30 border-amber-100/80 hover:border-amber-300' :
              unit.status === 'vacant' ? 'bg-sky-50/30 border-sky-100/80 hover:border-sky-300' :
              unit.status === 'unavailable' ? 'bg-slate-50/50 border-slate-200 hover:border-slate-350' :
              'bg-purple-50/30 border-purple-100/80 hover:border-purple-300'
            }`}
          >
            <div className="flex justify-between items-start w-full">
              <div className={`p-3 rounded-xl transition-colors ${
                unit.status === 'long-term' ? 'bg-emerald-50 text-emerald-600 group-hover:bg-emerald-100 group-hover:text-emerald-700' :
                unit.status === 'short-term' ? 'bg-amber-50 text-amber-600 group-hover:bg-amber-100 group-hover:text-amber-700' :
                unit.status === 'vacant' ? 'bg-sky-50 text-sky-600 group-hover:bg-sky-100 group-hover:text-sky-700' :
                unit.status === 'unavailable' ? 'bg-slate-100 text-slate-500 group-hover:bg-slate-200 group-hover:text-slate-600' :
                'bg-purple-50 text-purple-600 group-hover:bg-purple-100 group-hover:text-purple-700'
              }`}>
                <Home className="w-5 h-5" />
              </div>
              <span className={`px-2 py-0.5 text-[10px] font-mono border rounded-full font-medium ${getStatusBadgeClass(unit.status)}`}>
                {unit.status.toUpperCase()}
              </span>
            </div>
            <div className="mt-4 flex-1 flex flex-col justify-between">
              <div>
                <h3 className="text-sm font-display font-semibold text-slate-900">{getUnitDisplayName(unit.number)}</h3>
                <p className="text-xs text-slate-500 mt-1 truncate">Owner: {unit.ownerName}</p>
                {unit.tenantName ? (
                  <p className="text-[10px] font-mono text-indigo-600 mt-0.5 truncate font-semibold">Tenant: {unit.tenantName}</p>
                ) : (
                  <p className="text-[10px] font-mono text-slate-400 mt-0.5 truncate italic">Tenant: None</p>
                )}
              </div>
              <div className="border-t border-slate-50 mt-2 pt-2 space-y-1 text-xs">
                {(unit.status === 'long-term' || unit.status === 'short-term') ? (
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-mono text-slate-400">
                      {unit.status === 'long-term' ? 'Rent' : 'Nightly'}:
                    </span>
                    <span className="font-semibold text-slate-700 font-mono">
                      {unit.currency === 'USD' ? '$' : 'J$'}{unit.monthlyRent.toLocaleString()}
                      <span className="text-[10px] text-slate-400 font-normal">
                        {unit.status === 'long-term' ? '/mo' : '/night'}
                      </span>
                    </span>
                  </div>
                ) : null}
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-mono text-slate-400">Maint:</span>
                  <span className="font-semibold text-teal-600 font-mono">
                    {(unit.maintCurrency || unit.currency) === 'USD' ? '$' : 'J$'}{unit.monthlyMaintenance.toLocaleString()}
                    <span className="text-[10px] text-slate-400 font-normal">/mo</span>
                  </span>
                </div>
                <div className="flex justify-between items-center text-[10px] text-slate-400">
                  <span className="font-mono text-[9px]">Meter: {unit.meterNumber}</span>
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Unit Detail / Edit Modal */}
      {selectedUnit && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-xl border border-slate-100 flex flex-col">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div>
                <span className="text-[10px] font-mono uppercase bg-slate-200 px-2 py-0.5 rounded-full font-medium text-slate-600">Unit Register Detail</span>
                <h3 className="text-lg font-display font-semibold text-slate-900 mt-1.5">{getUnitDisplayName(selectedUnit.number)}</h3>
              </div>
              <button
                onClick={() => setSelectedUnit(null)}
                className="p-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-200/50 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {errorMsg && (
              <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-100 text-red-800 text-xs rounded-xl flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-red-600" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="mx-6 mt-4 p-3 bg-teal-50 border border-teal-100 text-teal-800 text-xs rounded-xl">
                {successMsg}
              </div>
            )}

            {!isEditing ? (
              <div className="p-6 space-y-6 flex-1">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3.5 bg-slate-50 rounded-xl">
                    <span className="text-[10px] font-mono text-slate-400 block">OCCUPANCY STATUS</span>
                    <span className="text-xs font-semibold text-slate-700 mt-1 block">
                      {getStatusLabel(selectedUnit.status)}
                    </span>
                  </div>
                  <div className="p-3.5 bg-slate-50 rounded-xl">
                    <span className="text-[10px] font-mono text-slate-400 block">UTILITY METER NUMBER</span>
                    <span className="text-xs font-mono font-semibold text-slate-700 mt-1 block">
                      {selectedUnit.meterNumber || 'Not Configured'}
                    </span>
                  </div>
                </div>

                <div className="space-y-3.5">
                  <h4 className="text-xs font-mono text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-100">Registered Owner Info</h4>
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center gap-2 text-slate-600">
                      <User className="w-4 h-4 text-slate-400" />
                      <span className="font-semibold text-slate-800">{selectedUnit.ownerName}</span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-600">
                      <Mail className="w-4 h-4 text-slate-400" />
                      <span>{selectedUnit.ownerEmail}</span>
                    </div>
                     <div className="flex items-center gap-2 text-slate-600">
                      <Phone className="w-4 h-4 text-slate-400" />
                      <span>{selectedUnit.ownerPhone}</span>
                    </div>
                    {selectedUnit.ownerEmergencyName && (
                      <div className="mt-2.5 p-2.5 bg-rose-50/50 rounded-xl border border-rose-100/50 space-y-1">
                        <span className="text-[9px] font-mono text-rose-700 block font-bold uppercase tracking-wider">Owner Emergency Contact</span>
                        <div className="font-semibold text-slate-850 text-xs">{selectedUnit.ownerEmergencyName}</div>
                        {(selectedUnit.ownerEmergencyPhone || selectedUnit.ownerEmergencyEmail) && (
                          <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                            {selectedUnit.ownerEmergencyPhone} {selectedUnit.ownerEmergencyEmail && `• ${selectedUnit.ownerEmergencyEmail}`}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {selectedUnit.status === 'long-term' && (
                  <div className="space-y-3.5">
                    <h4 className="text-xs font-mono text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-100">Tenant & Lease Details</h4>
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center gap-2 text-slate-600">
                        <User className="w-4 h-4 text-slate-400" />
                        <span className="font-semibold text-slate-800">{selectedUnit.tenantName || 'None'}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-600">
                        <Mail className="w-4 h-4 text-slate-400" />
                        <span>{selectedUnit.tenantEmail || 'None'}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-600">
                        <Phone className="w-4 h-4 text-slate-400" />
                        <span>{selectedUnit.tenantPhone || 'None'}</span>
                      </div>
                      {selectedUnit.tenantEmergencyName && (
                        <div className="mt-2.5 p-2.5 bg-indigo-50/50 rounded-xl border border-indigo-100/50 space-y-1">
                          <span className="text-[9px] font-mono text-indigo-700 block font-bold uppercase tracking-wider">Tenant Emergency Contact</span>
                          <div className="font-semibold text-slate-850 text-xs">{selectedUnit.tenantEmergencyName}</div>
                          {(selectedUnit.tenantEmergencyPhone || selectedUnit.tenantEmergencyEmail) && (
                            <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                              {selectedUnit.tenantEmergencyPhone} {selectedUnit.tenantEmergencyEmail && `• ${selectedUnit.tenantEmergencyEmail}`}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div className="p-3 border border-slate-100 rounded-xl bg-white shadow-xs">
                    <span className="text-[10px] font-mono text-slate-400 block font-semibold uppercase">
                      {selectedUnit.status === 'short-term' ? 'Nightly Charge' : 'Monthly Rent Fee'}
                    </span>
                    <p className="text-sm font-bold text-slate-800 mt-0.5 font-mono">
                      {selectedUnit.currency === 'USD' ? 'USD $' : 'JMD J$'}{selectedUnit.monthlyRent.toLocaleString()}
                    </p>
                    <span className="text-[9px] font-mono text-slate-400 mt-0.5 block pb-1 border-b border-slate-50">
                      Converted: {selectedUnit.currency === 'USD' 
                        ? `JMD J$${(selectedUnit.monthlyRent * 155).toLocaleString()}` 
                        : `USD $${Math.round(selectedUnit.monthlyRent / 155).toLocaleString()}`}
                    </span>
                    {selectedUnit.status === 'long-term' && (
                      <p className="text-[10px] text-slate-500 mt-1.5 font-sans font-medium">
                        Due: {selectedUnit.rentDueDay || 1}{getOrdinalSuffix(selectedUnit.rentDueDay || 1)} of every month
                      </p>
                    )}
                  </div>
                  <div className="p-3 border border-slate-100 rounded-xl bg-white shadow-xs">
                    <span className="text-[10px] font-mono text-slate-400 block font-semibold uppercase">Monthly HOA Maint.</span>
                    <p className="text-sm font-bold text-slate-800 mt-0.5 font-mono">
                      {(selectedUnit.maintCurrency || selectedUnit.currency) === 'USD' ? 'USD $' : 'JMD J$'}{selectedUnit.monthlyMaintenance.toLocaleString()}
                    </p>
                    <span className="text-[9px] font-mono text-slate-400 mt-0.5 block pb-1 border-b border-slate-50">
                      Converted: {(selectedUnit.maintCurrency || selectedUnit.currency) === 'USD' 
                        ? `JMD J$${(selectedUnit.monthlyMaintenance * 155).toLocaleString()}` 
                        : `USD $${Math.round(selectedUnit.monthlyMaintenance / 155).toLocaleString()}`}
                    </span>
                    <p className="text-[10px] text-slate-500 mt-1.5 font-sans font-medium">
                      Due: {selectedUnit.maintDueDay || 1}{getOrdinalSuffix(selectedUnit.maintDueDay || 1)} of every month
                    </p>
                  </div>
                </div>

                {selectedUnit.notes && (
                  <div className="space-y-2 text-xs">
                    <span className="text-xs font-mono text-slate-400 block">UNIT ADMINISTRATIVE NOTES</span>
                    <p className="p-3 bg-slate-50 text-slate-600 rounded-xl italic leading-relaxed">
                      "{selectedUnit.notes}"
                    </p>
                  </div>
                )}

                {/* RESIDENT & PROPERTY ACTIVITY LOG SECTION */}
                <div className="space-y-3 pt-3 border-t border-slate-100">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <ClipboardList className="w-4 h-4 text-teal-600" />
                      <h4 className="text-xs font-mono text-slate-700 uppercase tracking-wider font-bold">
                        Resident & Property Activity Log
                      </h4>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setActType('Construction Work');
                        setActResidentName(selectedUnit.tenantName || selectedUnit.ownerName || '');
                        setActResidentRole(selectedUnit.tenantName ? 'Tenant' : 'Owner');
                        setActDate(new Date().toISOString().split('T')[0]);
                        setActNotes('');
                        setActError('');
                        setActSuccess('');
                        setShowLogActivityModal(true);
                      }}
                      className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-[11px] font-medium transition-all flex items-center gap-1 shadow-xs"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Log Activity
                    </button>
                  </div>

                  {unitActivities.filter(a => a.unitNumber === selectedUnit.number || a.unitId === selectedUnit.id).length === 0 ? (
                    <div className="p-4 bg-slate-50/80 border border-dashed border-slate-200 rounded-xl text-center text-xs text-slate-400">
                      No logged activities for Villa {selectedUnit.number} yet. Click "Log Activity" above to record construction, pool reservations, or notes.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                      {unitActivities
                        .filter(a => a.unitNumber === selectedUnit.number || a.unitId === selectedUnit.id)
                        .map((act) => (
                          <div key={act.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 space-y-1.5 text-xs relative group">
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-1.5">
                                <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                                  act.activityType === 'Construction Work' ? 'bg-amber-100 text-amber-800 border border-amber-200' :
                                  act.activityType === 'Pool Reservation' ? 'bg-teal-100 text-teal-800 border border-teal-200' :
                                  act.activityType === 'Maintenance Request' ? 'bg-indigo-100 text-indigo-800 border border-indigo-200' :
                                  act.activityType === 'Noise / Event Notice' ? 'bg-purple-100 text-purple-800 border border-purple-200' :
                                  act.activityType === 'Amenity Access' ? 'bg-sky-100 text-sky-800 border border-sky-200' :
                                  'bg-slate-200 text-slate-700'
                                }`}>
                                  {act.activityType}
                                </span>
                                <span className="font-semibold text-slate-800">{act.residentName} ({act.residentRole})</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono font-medium text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-100">{act.dateCaptured}</span>
                                {onDeleteUnitActivity && canEdit && (
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteActivity(act.id)}
                                    className="text-slate-300 hover:text-red-600 transition-colors p-0.5"
                                    title="Remove activity log"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                            <p className="text-slate-700 leading-relaxed text-xs font-sans bg-white p-2.5 rounded-lg border border-slate-100">
                              "{act.notes}"
                            </p>
                            <div className="text-[9px] font-mono text-slate-400 flex justify-between items-center pt-0.5">
                              <span>Logged by: {act.loggedBy}</span>
                              <span>{new Date(act.loggedAt).toLocaleDateString()} {new Date(act.loggedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-slate-100 flex flex-col gap-2.5">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setPrintActivityUnit(selectedUnit)}
                      className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5 shadow-xs"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      Print Tenant/Owner Activity Ledger
                    </button>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        if (!canEdit) {
                          setErrorMsg('Unauthorized: Junior Officers cannot modify base unit parameters or rates.');
                          return;
                        }
                        setIsEditing(true);
                      }}
                      disabled={!canEdit}
                      className="flex-1 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Modify Unit settings
                    </button>
                    <button
                      onClick={() => setSelectedUnit(null)}
                      className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-50 transition-all"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSave} className="p-6 space-y-4 flex-1">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Villa Number/Name</label>
                    <input
                      type="text"
                      value={unitNumber}
                      onChange={(e) => setUnitNumber(e.target.value)}
                      required
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-semibold text-slate-900"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Villa Status Use</label>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value as Unit['status'])}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-xl focus:ring-1 focus:ring-teal-500 focus:border-teal-500"
                    >
                      <option value="long-term">Long-term Lease</option>
                      <option value="short-term">Short-term rental</option>
                      <option value="owner-occupied">Owner Occupied</option>
                      <option value="vacant">Vacant</option>
                      <option value="unavailable">Unavailable</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">Base Currency</label>
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value as 'USD' | 'JMD')}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-xl focus:ring-1 focus:ring-teal-500 focus:border-teal-500"
                    >
                      <option value="JMD">Jamaican Dollar (JMD)</option>
                      <option value="USD">US Dollar (USD)</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-3 p-4 bg-slate-50 rounded-xl">
                  <span className="text-[10px] font-mono text-slate-400 block uppercase font-semibold">Registered Owner Details</span>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Owner Name</label>
                      <input
                        type="text"
                        value={ownerName}
                        onChange={(e) => setOwnerName(e.target.value)}
                        required
                        className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Email Address</label>
                      <input
                        type="email"
                        value={ownerEmail}
                        onChange={(e) => setOwnerEmail(e.target.value)}
                        className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Phone Number</label>
                      <input
                        type="text"
                        value={ownerPhone}
                        onChange={(e) => setOwnerPhone(e.target.value)}
                        className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-slate-200/50 mt-1">
                    <div>
                      <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Emergency Contact Name</label>
                      <input
                        type="text"
                        value={ownerEmergencyName}
                        onChange={(e) => setOwnerEmergencyName(e.target.value)}
                        className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                        placeholder="Emergency contact name"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Emergency Phone</label>
                      <input
                        type="text"
                        value={ownerEmergencyPhone}
                        onChange={(e) => setOwnerEmergencyPhone(e.target.value)}
                        className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                        placeholder="Emergency contact number"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Emergency Email</label>
                      <input
                        type="email"
                        value={ownerEmergencyEmail}
                        onChange={(e) => setOwnerEmergencyEmail(e.target.value)}
                        className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                        placeholder="Emergency contact email"
                      />
                    </div>
                  </div>
                </div>

                {(status === 'long-term' || activeRole === 'ADMINISTRATOR') && (
                  <div className="space-y-3 p-4 bg-indigo-50/50 rounded-xl border border-indigo-100/50">
                    <span className="text-[10px] font-mono text-indigo-700 block uppercase font-semibold">
                      Active Tenant Details {activeRole === 'ADMINISTRATOR' && status !== 'long-term' && '(Admin Overriding Status Lock)'}
                    </span>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Tenant Name</label>
                        <input
                          type="text"
                          value={tenantName}
                          onChange={(e) => setTenantName(e.target.value)}
                          required={status === 'long-term'}
                          className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Email Address</label>
                        <input
                          type="email"
                          value={tenantEmail}
                          onChange={(e) => setTenantEmail(e.target.value)}
                          className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Phone Number</label>
                        <input
                          type="text"
                          value={tenantPhone}
                          onChange={(e) => setTenantPhone(e.target.value)}
                          className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-indigo-200/40 mt-1">
                      <div>
                        <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Emergency Contact Name</label>
                        <input
                          type="text"
                          value={tenantEmergencyName}
                          onChange={(e) => setTenantEmergencyName(e.target.value)}
                          className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                          placeholder="Emergency contact name"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Emergency Phone</label>
                        <input
                          type="text"
                          value={tenantEmergencyPhone}
                          onChange={(e) => setTenantEmergencyPhone(e.target.value)}
                          className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                          placeholder="Emergency contact number"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-slate-500 block mb-0.5">Emergency Email</label>
                        <input
                          type="email"
                          value={tenantEmergencyEmail}
                          onChange={(e) => setTenantEmergencyEmail(e.target.value)}
                          className="w-full text-xs p-2 border border-slate-200 rounded-lg"
                          placeholder="Emergency contact email"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">
                      {status === 'short-term' ? 'Nightly Charge' : 'Monthly Rent Charge'}
                    </label>
                    {status === 'owner-occupied' || status === 'vacant' || status === 'unavailable' ? (
                      <div className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-slate-100 text-slate-400 font-mono font-medium flex items-center gap-1.5 h-[38px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span>
                        Blocked: {status === 'owner-occupied' ? 'Owner Occupied' : status === 'vacant' ? 'Vacant' : 'Unavailable'}
                      </div>
                    ) : (
                      <>
                        <input
                          type="number"
                          value={monthlyRent}
                          onChange={(e) => setMonthlyRent(Number(e.target.value))}
                          className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono font-semibold bg-white"
                        />
                        <span className="text-[9px] font-mono text-slate-400 mt-1 block">
                          Converted: {currency === 'USD' 
                            ? `JMD J$${(monthlyRent * 155).toLocaleString()}` 
                            : `USD $${Math.round(monthlyRent / 155).toLocaleString()}`}
                        </span>
                      </>
                    )}
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="text-xs font-mono text-slate-500 block">Monthly HOA Maint.</label>
                      
                      {/* Currency Toggle Switch */}
                      <div className="flex items-center gap-1 bg-slate-150 rounded-lg p-0.5 border border-slate-200">
                        <button
                          type="button"
                          onClick={() => {
                            if (maintCurrency !== 'USD') {
                              setMonthlyMaintenance(prev => Math.round(prev / 155));
                              setMaintCurrency('USD');
                            }
                          }}
                          className={`px-1.5 py-0.5 rounded text-[9px] font-bold font-mono transition-colors ${maintCurrency === 'USD' ? 'bg-slate-800 text-white shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
                        >
                          USD
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (maintCurrency !== 'JMD') {
                              setMonthlyMaintenance(prev => Math.round(prev * 155));
                              setMaintCurrency('JMD');
                            }
                          }}
                          className={`px-1.5 py-0.5 rounded text-[9px] font-bold font-mono transition-colors ${maintCurrency === 'JMD' ? 'bg-slate-800 text-white shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
                        >
                          JMD
                        </button>
                      </div>
                    </div>
                    <input
                      type="number"
                      value={monthlyMaintenance}
                      onChange={(e) => setMonthlyMaintenance(Number(e.target.value))}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono font-semibold bg-white"
                    />
                    <span className="text-[9px] font-mono text-slate-400 mt-1 block">
                      Converted: {maintCurrency === 'USD' 
                        ? `JMD J$${(monthlyMaintenance * 155).toLocaleString()}` 
                        : `USD $${Math.round(monthlyMaintenance / 155).toLocaleString()}`}
                    </span>
                  </div>

                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">
                      Utility Meter ID {activeRole !== 'ADMINISTRATOR' && '(Locked - Admin only)'}
                    </label>
                    <input
                      type="text"
                      value={meterNumber}
                      onChange={(e) => setMeterNumber(e.target.value)}
                      disabled={activeRole !== 'ADMINISTRATOR'}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono disabled:bg-slate-100 disabled:text-slate-400"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">
                      Rent Due Day of Month
                    </label>
                    {status === 'owner-occupied' ? (
                      <div className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-slate-100 text-slate-400 font-mono font-medium flex items-center gap-1.5 h-[38px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span>
                        Blocked: Owner Occupied
                      </div>
                    ) : (status === 'short-term' || status === 'vacant' || status === 'unavailable') ? (
                      <div className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-slate-100 text-slate-400 font-mono font-medium flex items-center gap-1.5 h-[38px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span>
                        Blocked: No rent due schedule
                      </div>
                    ) : (
                      <select
                        value={rentDueDay}
                        onChange={(e) => setRentDueDay(Number(e.target.value))}
                        className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white text-slate-700 font-mono font-medium"
                      >
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                          <option key={d} value={d}>
                            Day {d} of Month
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-mono text-slate-500 block mb-1">
                      HOA Maintenance Due Day of Month
                    </label>
                    <select
                      value={maintDueDay}
                      onChange={(e) => setMaintDueDay(Number(e.target.value))}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white text-slate-700 font-mono font-medium"
                    >
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                        <option key={d} value={d}>
                          Day {d} of Month
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Administrative Notes</label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl focus:ring-1 focus:ring-teal-500 focus:border-teal-500"
                  />
                </div>

                <div className="pt-4 border-t border-slate-100 flex gap-3">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all"
                  >
                    {loading ? 'Saving adjustments...' : 'Save Adjustments'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-50 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* PRINT INDIVIDUAL UNIT LEDGER OVERLAY */}
      {printActivityUnit && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 print:p-0 print:absolute print:bg-white print:inset-0">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-100 flex flex-col print:shadow-none print:border-none print:max-h-none print:overflow-visible">
            
            {/* Modal Header (Hidden on Print) */}
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50 print:hidden">
              <div className="flex items-center gap-2">
                <Printer className="w-5 h-5 text-teal-600" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Printable Activity Ledger</h3>
                  <p className="text-[11px] text-slate-500">Official ledger statement containing tenancy details, payments, utility history, and reservations.</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium rounded-xl flex items-center gap-1.5 transition-all shadow-xs"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Print Now
                </button>
                <button
                  onClick={() => setPrintActivityUnit(null)}
                  className="p-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-200/50 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Print Document Content */}
            <div className="p-8 space-y-6 flex-1 text-slate-800 print:p-0 print:text-black font-sans">
              
              {/* Document Letterhead */}
              <div className="flex justify-between items-start border-b-2 border-slate-900 pb-4">
                <div>
                  <h1 className="text-xl font-bold uppercase tracking-wider text-slate-900 print:text-black">Villaggio Del Sol</h1>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">Ocho Rios, Jamaica</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">Internal Property Operations & Compliance Ledger</p>
                </div>
                <div className="text-right">
                  <div className="bg-slate-900 text-white px-3 py-1 text-[10px] font-mono rounded-lg print:border print:border-black print:text-black print:bg-white font-bold">
                    UNIT ACTIVITY LEDGER
                  </div>
                  <p className="text-[10px] text-slate-500 font-mono mt-2">Generated: {new Date().toLocaleDateString()} {new Date().toLocaleTimeString()}</p>
                </div>
              </div>

              {/* Villa & Tenancy Metadata */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-100 print:bg-white print:border-black print:rounded-none">
                <div>
                  <span className="text-[9px] font-mono text-slate-400 block">VILLA NUMBER</span>
                  <span className="text-xs font-bold text-slate-900">Unit {printActivityUnit.number}</span>
                </div>
                <div>
                  <span className="text-[9px] font-mono text-slate-400 block">REGISTERED OWNER</span>
                  <span className="text-xs font-semibold text-slate-800">{printActivityUnit.ownerName}</span>
                </div>
                <div>
                  <span className="text-[9px] font-mono text-slate-400 block">OCCUPANT / LEASE STATUS</span>
                  <span className="text-xs font-semibold text-slate-800">
                    {printActivityUnit.status === 'long-term' ? `${printActivityUnit.tenantName || 'Tenant'} (Tenant)` : getStatusLabel(printActivityUnit.status)}
                  </span>
                </div>
                <div>
                  <span className="text-[9px] font-mono text-slate-400 block">METER REGISTER ID</span>
                  <span className="text-xs font-mono text-slate-800 font-semibold">{printActivityUnit.meterNumber || 'N/A'}</span>
                </div>
              </div>

              {/* SECTION 1: FINANCIAL LEDGER */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-1 flex items-center gap-1.5 print:text-black print:border-black">
                  <span>I. Cash Inflow Ledger (Payments & Receipts)</span>
                </h3>
                {payments.filter(p => p.unitNumber === printActivityUnit.number).length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No payments logged for this villa unit.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border border-slate-100 print:border-black print:border">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 font-mono text-[9px] text-slate-400 uppercase print:bg-white print:border-black print:border-b">
                          <th className="p-2">Date</th>
                          <th className="p-2">Receipt No</th>
                          <th className="p-2">Category</th>
                          <th className="p-2">Payer</th>
                          <th className="p-2">Method</th>
                          <th className="p-2">Status</th>
                          <th className="p-2 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono text-[10px] text-slate-600 print:divide-black print:text-black">
                        {payments.filter(p => p.unitNumber === printActivityUnit.number).map(p => (
                          <tr key={p.id} className={p.status === 'reversed' ? 'line-through text-slate-400' : ''}>
                            <td className="p-2">{p.date}</td>
                            <td className="p-2 font-semibold">{p.receiptNo}</td>
                            <td className="p-2">{p.category}</td>
                            <td className="p-2 truncate max-w-[120px]">{p.payerName}</td>
                            <td className="p-2">{p.method}</td>
                            <td className="p-2 uppercase font-bold text-[9px]">
                              <span className={p.status === 'completed' ? 'text-emerald-600' : 'text-red-500'}>
                                {p.status}
                              </span>
                            </td>
                            <td className="p-2 text-right font-semibold text-slate-900 print:text-black">
                              {p.currency === 'USD' ? '$' : 'J$'}{p.amount.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* SECTION 2: UTILITIES HISTORIC RECORD */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-1 flex items-center gap-1.5 print:text-black print:border-black">
                  <span>II. Utility Meter Reading & Billing Ledger</span>
                </h3>
                {utilities.filter(u => u.unitNumber === printActivityUnit.number).length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No utility billing logs found for this meter number.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border border-slate-100 print:border-black print:border">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 font-mono text-[9px] text-slate-400 uppercase print:bg-white print:border-black print:border-b">
                          <th className="p-2">Billing Month</th>
                          <th className="p-2">Prev Reading</th>
                          <th className="p-2">Current Reading</th>
                          <th className="p-2">Consumption</th>
                          <th className="p-2">Billing Status</th>
                          <th className="p-2 text-right">Amount Charged</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono text-[10px] text-slate-600 print:divide-black print:text-black">
                        {utilities.filter(u => u.unitNumber === printActivityUnit.number).map(u => (
                          <tr key={u.id}>
                            <td className="p-2 font-semibold">{u.billingPeriod}</td>
                            <td className="p-2">{u.previousReading.toLocaleString()}</td>
                            <td className="p-2">{u.currentReading.toLocaleString()}</td>
                            <td className="p-2 font-semibold text-teal-700 print:text-black">{u.consumption.toLocaleString()}</td>
                            <td className="p-2 uppercase font-semibold text-[9px]">
                              <span className={u.status === 'paid' ? 'text-emerald-600' : 'text-amber-600'}>
                                {u.status}
                              </span>
                            </td>
                            <td className="p-2 text-right font-semibold text-slate-900 print:text-black">
                              {u.currency === 'USD' ? '$' : 'J$'}{u.amountCharged.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* SECTION 3: SHORT-TERM RESERVATIONS */}
              {printActivityUnit.status === 'short-term' && (
                <div className="space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-1 flex items-center gap-1.5 print:text-black print:border-black">
                    <span>III. Guest Bookings & Stay Lodgings</span>
                  </h3>
                  {bookings.filter(b => b.unitNumber === printActivityUnit.number).length === 0 ? (
                    <p className="text-xs text-slate-400 italic">No short-term reservations logged on the calendar scheduler.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs border border-slate-100 print:border-black print:border">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 font-mono text-[9px] text-slate-400 uppercase print:bg-white print:border-black print:border-b">
                            <th className="p-2">Guest Name</th>
                            <th className="p-2">Check-In</th>
                            <th className="p-2">Check-Out</th>
                            <th className="p-2">Nights</th>
                            <th className="p-2">Booking Status</th>
                            <th className="p-2 text-right">Stay Cost</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono text-[10px] text-slate-600 print:divide-black print:text-black">
                          {bookings.filter(b => b.unitNumber === printActivityUnit.number).map(b => {
                            const nights = Math.max(1, Math.ceil((new Date(b.checkOut).getTime() - new Date(b.checkIn).getTime()) / (1000 * 60 * 60 * 24)));
                            return (
                              <tr key={b.id}>
                                <td className="p-2 font-semibold text-slate-900 print:text-black">{b.guestName}</td>
                                <td className="p-2">{b.checkIn}</td>
                                <td className="p-2">{b.checkOut}</td>
                                <td className="p-2">{nights}</td>
                                <td className="p-2 uppercase font-semibold text-[9px]">{b.status}</td>
                                <td className="p-2 text-right font-semibold text-slate-900 print:text-black font-mono">
                                  {b.currency === 'USD' ? '$' : 'J$'}{b.amount.toLocaleString()}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* SECTION 4: RESIDENT & PROPERTY ACTIVITIES LOG */}
              <div className="space-y-2 pt-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 border-b border-slate-300 pb-1 flex items-center gap-1.5 print:text-black print:border-black">
                  <span>IV. Resident & Villa Activities Logged</span>
                </h3>
                {unitActivities.filter(a => a.unitNumber === printActivityUnit.number || a.unitId === printActivityUnit.id).length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No resident activities logged for this villa unit.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border border-slate-100 print:border-black print:border">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 font-mono text-[9px] text-slate-400 uppercase print:bg-white print:border-black print:border-b">
                          <th className="p-2">Date Captured</th>
                          <th className="p-2">Activity Type</th>
                          <th className="p-2">Resident / Capacity</th>
                          <th className="p-2">Description & Notes</th>
                          <th className="p-2">Logged By</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono text-[10px] text-slate-600 print:divide-black print:text-black">
                        {unitActivities.filter(a => a.unitNumber === printActivityUnit.number || a.unitId === printActivityUnit.id).map(a => (
                          <tr key={a.id}>
                            <td className="p-2 font-semibold whitespace-nowrap">{a.dateCaptured}</td>
                            <td className="p-2 font-bold uppercase text-[9px]">{a.activityType}</td>
                            <td className="p-2 whitespace-nowrap">{a.residentName} ({a.residentRole})</td>
                            <td className="p-2 font-sans">{a.notes}</td>
                            <td className="p-2 whitespace-nowrap">{a.loggedBy}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Financial Sign-Off Footer */}
              <div className="pt-12 grid grid-cols-2 gap-8 text-center text-xs border-t border-slate-200 mt-12 print:border-black print:mt-8">
                <div>
                  <div className="border-b border-slate-400 h-8 w-2/3 mx-auto print:border-black"></div>
                  <span className="text-[10px] text-slate-400 block mt-1 font-mono uppercase">Authorized Property Auditor</span>
                </div>
                <div>
                  <div className="border-b border-slate-400 h-8 w-2/3 mx-auto print:border-black"></div>
                  <span className="text-[10px] text-slate-400 block mt-1 font-mono uppercase">Ocho Rios Trust Administrator</span>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* LOG RESIDENT ACTIVITY MODAL */}
      {showLogActivityModal && selectedUnit && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl border border-slate-100">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-teal-600" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Log Resident Activity</h3>
                  <p className="text-[11px] text-slate-500">Villa {selectedUnit.number} — {selectedUnit.ownerName}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowLogActivityModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {actError && (
              <div className="p-3 bg-red-50 border border-red-100 text-red-800 text-xs rounded-xl flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-red-600 shrink-0" />
                <span>{actError}</span>
              </div>
            )}

            {actSuccess && (
              <div className="p-3 bg-teal-50 border border-teal-100 text-teal-800 text-xs rounded-xl font-medium">
                {actSuccess}
              </div>
            )}

            <form onSubmit={handleSaveActivity} className="space-y-3.5">
              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Activity Category</label>
                <select
                  value={actType}
                  onChange={(e) => setActType(e.target.value as UnitActivity['activityType'])}
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white font-medium text-slate-800 focus:ring-1 focus:ring-teal-500"
                >
                  <option value="Construction Work">Construction Work / Renovation</option>
                  <option value="Pool Reservation">Pool & Gazebo Reservation</option>
                  <option value="Maintenance Request">Resident Maintenance Request</option>
                  <option value="Noise / Event Notice">Noise / Event Notice</option>
                  <option value="Amenity Access">Amenity Access / Guest Pass</option>
                  <option value="Other Activity">Other Activity / Note</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Resident Name</label>
                  <input
                    type="text"
                    value={actResidentName}
                    onChange={(e) => setActResidentName(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl text-slate-800"
                    placeholder="e.g. Yvonne Clarke"
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-slate-500 block mb-1">Resident Capacity</label>
                  <select
                    value={actResidentRole}
                    onChange={(e) => setActResidentRole(e.target.value as any)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-white text-slate-800"
                  >
                    <option value="Owner">Property Owner</option>
                    <option value="Tenant">Long-Term Tenant</option>
                    <option value="Guest">Short-Term Guest</option>
                    <option value="Other">Other / Contractor</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Date Captured / Scheduled</label>
                <input
                  type="date"
                  value={actDate}
                  onChange={(e) => setActDate(e.target.value)}
                  required
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl font-mono text-slate-800"
                />
              </div>

              <div>
                <label className="text-xs font-mono text-slate-500 block mb-1">Activity Notes & Operational Details</label>
                <textarea
                  rows={3}
                  value={actNotes}
                  onChange={(e) => setActNotes(e.target.value)}
                  required
                  placeholder="e.g., Construction work approved for balcony tiling. Work hours: 9 AM to 4 PM. Contractor: J&R Builders."
                  className="w-full text-xs p-2.5 border border-slate-200 rounded-xl focus:ring-1 focus:ring-teal-500 text-slate-800"
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="submit"
                  disabled={actLoading}
                  className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-medium transition-all shadow-xs"
                >
                  {actLoading ? 'Recording Activity...' : 'Save Activity Entry'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowLogActivityModal(false)}
                  className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-medium hover:bg-slate-50 transition-all"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
