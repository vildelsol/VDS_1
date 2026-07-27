/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared presentational primitives.
 *
 * The screens previously repeated their own alert boxes, empty states, badges and
 * submit buttons with slightly different markup each time, which is why spacing,
 * wording and loading behaviour varied between tabs. These are the single
 * implementations everything now uses.
 */

import React from 'react';
import { AlertTriangle, CheckCircle, Info, Loader2, Inbox } from 'lucide-react';

export function ErrorNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="flex items-start gap-1.5 rounded-xl border border-red-100 bg-red-50 p-3 text-xs text-red-800">
      <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-red-600" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function SuccessNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div role="status" className="flex items-start gap-1.5 rounded-xl border border-teal-100 bg-teal-50 p-3 text-xs text-teal-800">
      <CheckCircle className="mt-px h-4 w-4 shrink-0 text-teal-600" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function InfoNote({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'amber' }) {
  const styles =
    tone === 'amber'
      ? 'border-amber-100 bg-amber-50 text-amber-900'
      : 'border-slate-200 bg-slate-50 text-slate-600';
  return (
    <div className={`flex items-start gap-1.5 rounded-xl border p-3 text-xs ${styles}`}>
      <Info className="mt-px h-4 w-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 leading-relaxed">{children}</span>
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-10 text-center">
      <span className="text-slate-300">{icon || <Inbox className="h-6 w-6" />}</span>
      <p className="text-xs font-medium text-slate-500">{title}</p>
      {hint && <p className="max-w-sm text-[11px] leading-relaxed text-slate-400">{hint}</p>}
    </div>
  );
}

export function SubmitButton({
  busy,
  children,
  busyLabel,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyLabel?: string }) {
  return (
    <button
      {...rest}
      type={rest.type || 'submit'}
      disabled={busy || rest.disabled}
      className={`flex items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 py-2.5 text-xs font-medium text-white transition-all hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {busy ? busyLabel || 'Working…' : children}
    </button>
  );
}

export function SecondaryButton({
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type={rest.type || 'button'}
      className={`rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50 disabled:opacity-60 ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * A modal shell with a scrollable body. The original modals put
 * `max-h-[90vh] overflow-y-auto` on the whole card, so on short viewports the
 * action buttons scrolled out of reach with no visual cue.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  maxWidthClass = 'max-w-md'
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidthClass?: string;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className={`flex max-h-[92vh] w-full ${maxWidthClass} flex-col overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-2xl`}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-slate-50 p-5">
          <div className="min-w-0">
            <h3 className="font-display text-sm font-semibold text-slate-900">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-full p-1.5 text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0 border-t border-slate-100 bg-slate-50 p-4">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  required
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'w-full rounded-xl border border-slate-200 bg-white p-2.5 text-xs text-slate-800 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 disabled:bg-slate-100 disabled:text-slate-400';

export const monoInputClass = `${inputClass} font-mono`;

/**
 * The single header-row style every on-screen data table uses. Column labels had
 * drifted to a faint slate-500 on a barely-there slate-50 fill, which read as
 * disabled text; this is a darker label on a stronger fill so the headings are
 * legible and identical on every tab.
 */
export const tableHeadRowClass =
  'border-b border-slate-200 bg-slate-100 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-700';

export function Badge({
  children,
  tone = 'slate'
}: {
  children: React.ReactNode;
  tone?: 'slate' | 'green' | 'red' | 'amber' | 'blue' | 'purple' | 'teal';
}) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700 border-slate-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    red: 'bg-red-50 text-red-700 border-red-100',
    amber: 'bg-amber-50 text-amber-800 border-amber-100',
    blue: 'bg-sky-50 text-sky-700 border-sky-100',
    purple: 'bg-purple-50 text-purple-700 border-purple-100',
    teal: 'bg-teal-50 text-teal-700 border-teal-100'
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Wide tables must scroll inside their own container, never the page body. */
export function TableScroller({ children }: { children: React.ReactNode }) {
  return <div className="w-full overflow-x-auto">{children}</div>;
}

/** Shown in place of a control the current role may not use. */
export function PermissionNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-800">
      {children}
    </div>
  );
}
