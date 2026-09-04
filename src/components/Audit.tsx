/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { AuditLog } from '../types';
import { Terminal, Search } from 'lucide-react';

interface AuditProps {
  auditLogs: AuditLog[];
}

export default function Audit({ auditLogs }: AuditProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterRole, setFilterRole] = useState<string>('ALL');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  // Filter logs
  const filteredLogs = auditLogs.filter(log => {
    const matchesSearch = 
      log.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.user.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.recordType.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.recordId.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesRole = filterRole === 'ALL' || log.role === filterRole;

    return matchesSearch && matchesRole;
  });

  return (
    <div className="space-y-6">
      
      {/* Search and Filters */}
      <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col md:flex-row gap-3 justify-between items-center">
        <div>
          <h2 className="text-lg font-display font-medium text-slate-900">Compliance Audit Ledger</h2>
          <p className="text-xs text-slate-500">Authorized audit log documenting security overrides and operational modifications.</p>
        </div>
        
        <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
            <input
              type="text"
              placeholder="Search audit actions..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full text-xs pl-9 pr-3 py-2.5 border border-slate-200 rounded-xl focus:ring-1 focus:ring-teal-500"
            />
          </div>
 
          <select
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value)}
            className="text-xs p-2.5 border border-slate-200 rounded-xl bg-white text-slate-700 min-w-[140px]"
          >
            <option value="ALL">All Roles</option>
            <option value="ADMINISTRATOR">Administrator</option>
            <option value="MANAGER">Manager</option>
            <option value="FINANCE_OFFICER">Finance Officer</option>
            <option value="JUNIOR_OFFICER">Junior Officer</option>
          </select>
        </div>
      </div>
 
      {/* Audit Logs Table / Feed */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-xs overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
          <span className="text-xs font-mono text-slate-500 font-medium">Compliance Log Register ({filteredLogs.length} entries)</span>
          <Terminal className="w-4 h-4 text-slate-400" />
        </div>
 
        {filteredLogs.length === 0 ? (
          <div className="text-center py-12 text-slate-400 text-xs">
            No audit logs match the current filters.
          </div>
        ) : (
          <div className="max-h-[600px] overflow-y-auto divide-y divide-slate-100 text-xs">
            {filteredLogs.map((log) => {
              const isExpanded = expandedLogId === log.id;
              return (
                <div key={log.id} className="border-b border-slate-100 last:border-b-0">
                  {/* Clickable One-Liner */}
                  <button
                    onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                    className="w-full p-3.5 hover:bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-left transition-colors font-sans"
                    title="Click to view details"
                  >
                    <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                      <span className={`px-2 py-0.5 font-semibold rounded text-[8px] uppercase shrink-0 ${
                        log.role === 'ADMINISTRATOR' ? 'bg-red-50 text-red-700 border border-red-100' :
                        log.role === 'MANAGER' ? 'bg-amber-50 text-amber-700 border border-amber-100' :
                        log.role === 'FINANCE_OFFICER' ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' :
                        'bg-slate-100 text-slate-600'
                      }`}>
                        {log.role.replace('_', ' ')}
                      </span>
                      <span className="font-semibold text-slate-700 shrink-0">{log.user}</span>
                      <span className="text-slate-300 hidden md:inline">|</span>
                      <span className="font-medium text-slate-900 truncate">{log.action}</span>
                    </div>

                    <div className="flex items-center gap-3 font-mono text-[10px] text-slate-400 shrink-0 sm:ml-auto">
                      <span className="hidden md:inline bg-slate-50 px-1.5 py-0.5 rounded text-[9px] text-slate-500 border border-slate-100 uppercase">
                        {log.recordType}: {log.recordId}
                      </span>
                      <span>{new Date(log.dateTime).toLocaleDateString()} {new Date(log.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="text-xs text-slate-400 font-sans shrink-0">{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </button>

                  {/* Expanded Detail accordion block */}
                  {isExpanded && (
                    <div className="bg-slate-50/50 px-4 py-3 border-t border-slate-100 space-y-3 font-sans animate-fade-in">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs leading-normal">
                        <div>
                          <span className="font-semibold text-slate-500 uppercase text-[9px] block">Record Target</span>
                          <p className="font-mono text-slate-700 mt-0.5">{log.recordType} ({log.recordId})</p>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-500 uppercase text-[9px] block">Authorized User</span>
                          <p className="text-slate-700 mt-0.5">{log.user} — {log.role.replace('_', ' ')}</p>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-500 uppercase text-[9px] block">Exact Date & Time</span>
                          <p className="text-slate-700 mt-0.5">{new Date(log.dateTime).toString()}</p>
                        </div>
                      </div>

                      {/* Value Diffs */}
                      {log.previousValue && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[10px] font-mono leading-relaxed bg-white p-3 rounded-xl border border-slate-100 overflow-x-auto shadow-xs">
                          <div className="space-y-1">
                            <span className="text-red-500 block font-semibold uppercase tracking-wider text-[8px]">Previous Value:</span>
                            <pre className="text-slate-600 whitespace-pre-wrap font-mono break-all">{log.previousValue}</pre>
                          </div>
                          <div className="space-y-1">
                            <span className="text-emerald-500 block font-semibold uppercase tracking-wider text-[8px]">Updated Value:</span>
                            <pre className="text-slate-600 whitespace-pre-wrap font-mono break-all">{log.newValue}</pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
