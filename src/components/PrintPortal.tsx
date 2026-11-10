/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Printable document host.
 *
 * The original print stylesheet hid `body *` and re-showed only the single
 * element `#printable-receipt-area`. That id existed in exactly one component,
 * so "Print statement" (Reports), "Execute Print" (Bookings) and "Print Now"
 * (unit ledger) all produced a blank page. Its `position: absolute` also
 * collapsed long documents onto one sheet.
 *
 * This renders the document into a portal attached directly to <body>, outside
 * the React root. In print media the app root is hidden with `display: none` and
 * the portal becomes static page flow, so multi-page documents paginate normally.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';

interface PrintPortalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** Called just before the browser print dialog opens. */
  onBeforePrint?: () => void;
  /** Extra toolbar buttons (e.g. Email), shown to the left of Print and hidden when printing. */
  actions?: React.ReactNode;
  /** Constrains the on-screen preview width; printing always uses the full page. */
  maxWidthClass?: string;
  children: React.ReactNode;
}

export default function PrintPortal({
  title,
  subtitle,
  onClose,
  onBeforePrint,
  actions,
  maxWidthClass = 'max-w-4xl',
  children
}: PrintPortalProps) {
  /*
   * Null where there is no DOM.
   *
   * Every printed document in this application lives inside this component, and
   * a portal cannot be rendered by react-dom/server — which meant not one of
   * these documents could be asserted on by a test. That is not a small gap: the
   * printed record is the artefact that leaves the property and is handed to an
   * owner, a tenant or an accountant, and until now the suite could only check
   * the figures that fed it, never the document itself. Rendering the same tree
   * inline when there is no document object costs nothing in a browser — where
   * the portal is still used, unchanged — and makes every one of them testable.
   */
  const [host] = useState<HTMLElement | null>(() => (typeof document === 'undefined' ? null : document.createElement('div')));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!host) return;
    host.className = 'vds-print-root';
    document.body.appendChild(host);
    // Stop the page behind the preview from scrolling.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (host.parentNode) host.parentNode.removeChild(host);
    };
  }, [host]);

  const handlePrint = () => {
    onBeforePrint?.();
    // Let React flush any state change from onBeforePrint before the dialog blocks.
    window.setTimeout(() => window.print(), 0);
  };

  const sheet = (
    <div className="vds-print-overlay fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-xs">
      <div className={`vds-print-sheet w-full ${maxWidthClass} my-4 flex flex-col rounded-2xl border border-slate-100 bg-white shadow-2xl`}>
        <div className="vds-print-toolbar sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-slate-100 bg-slate-50 p-4">
          <div className="flex min-w-0 items-center gap-2">
            <Printer className="h-5 w-5 shrink-0 text-teal-600" />
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-900">{title}</h3>
              {subtitle && <p className="truncate text-[11px] text-slate-500">{subtitle}</p>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-xl bg-teal-600 px-4 py-2 text-xs font-medium text-white shadow-xs transition-all hover:bg-teal-700"
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close print preview"
              className="rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-200/50 hover:text-slate-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="vds-print-document p-6 font-sans text-slate-800 sm:p-8">
          {children}
          {/*
            Deliberately a footer credit and deliberately not in the letterhead.
            The letterhead answers "who issued this document", and on an owner
            statement that has to be the body corporate and nothing else — a
            second company's name up there invites a proprietor to wonder who is
            actually billing them. Down here it reads as what it is: who built
            the system the document came out of.
          */}
          <p className="vds-print-credit mt-6 border-t border-slate-200 pt-2 text-center font-mono text-[8px] uppercase tracking-[0.2em] text-slate-400">
            Powered by ISPO
          </p>
        </div>
      </div>
    </div>
  );

  // In a browser the document is portalled to <body>, outside the React root, so
  // the print stylesheet can hide the app and let the sheet paginate. With no DOM
  // there is nothing to portal into, and the same tree is returned directly.
  return host ? createPortal(sheet, host) : sheet;
}

/**
 * Shared letterhead so every printed document identifies itself the same way.
 *
 * The mark is drawn at a size that survives paper. An earlier version set it to
 * 64px tall, which put the wordmark inside the image at roughly a millimetre and
 * a half once printed — present in the DOM, illegible on the page, and a plain
 * downgrade from the bold text heading it replaced.
 *
 * The name is never carried by the image alone. If the file fails to load — a
 * stale build, an asset that did not ship, a reader with images disabled — the
 * document falls back to the typeset name rather than going out with an
 * anonymous letterhead. A statement that cannot say whose it is, is not a
 * statement.
 */
export function PrintLetterhead({
  documentTitle,
  meta,
  generatedBy
}: {
  documentTitle: string;
  meta?: string;
  generatedBy?: string;
}) {
  const [markFailed, setMarkFailed] = useState(false);

  return (
    <div className="mb-6 flex items-stretch justify-between gap-4 border-b-2 border-slate-900 pb-4">
      <div className="flex flex-col items-start justify-between">
        {markFailed ? (
          <h1 className="font-display text-xl font-bold uppercase tracking-wider text-slate-900">Villaggio Del Sol</h1>
        ) : (
          <img
            src="/vds-logo.png"
            alt="Villaggio Del Sol"
            onError={() => setMarkFailed(true)}
            /* Forced, so the gold is not dropped by a printer set to ignore
               background graphics or by a print-to-PDF default. */
            className="vds-letterhead-mark h-24 w-auto max-w-none shrink-0 object-contain"
          />
        )}
        <p className="mt-1 font-mono text-xs text-slate-500">Ocho Rios, St. Ann, Jamaica</p>
      </div>
      {/*
        Same height as the left column, so the two sides share a top and a bottom:
        the document label sits level with the top of the mark, and the name, date
        and author finish on the line the address does.
      */}
      <div className="flex flex-col items-end justify-between text-right">
        <div className="print-outline inline-block rounded-lg border border-slate-900 bg-white px-3 py-1 font-mono text-[10px] font-bold uppercase text-slate-900">
          {documentTitle}
        </div>
        <div>
          {meta && <p className="font-mono text-[10px] text-slate-500">{meta}</p>}
          <p className="mt-0.5 font-mono text-[10px] text-slate-500">
            Generated {new Date().toLocaleDateString()} {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
          {generatedBy && <p className="font-mono text-[10px] text-slate-500">by {generatedBy}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Signature block for documents that get countersigned.
 *
 * `leftName` / `rightName` print the actual person under the rule, rather than
 * only the role. A line labelled just "Prepared by" leaves no record of *who*
 * prepared it once the sheet is filed, which is the whole point of signing it.
 * Both columns keep an identical two-line structure so the rules stay on the
 * same baseline whether or not a name is supplied.
 */
export function PrintSignatures({
  left = 'Authorised Property Officer',
  right = 'Reviewed By',
  leftName,
  rightName
}: {
  left?: string;
  right?: string;
  leftName?: string;
  rightName?: string;
}) {
  return (
    /*
     * No rule across the top of this block.
     *
     * It used to carry `border-t`, which drew a line the full width of the page
     * immediately above the two signature columns — Ro, 2026-09-03: *"there is a
     * random line above the signature lines … it should be removed."* The only
     * lines that belong here are the two short ones a person signs on, and a
     * full-width rule above them reads as the end of the document rather than as
     * the head of a signature block. The spacing that separated it from the
     * content above is kept.
     */
    /*
     * `vds-print-signatures`: on paper the space above is cut and the block is
     * kept whole — see index.css. Ro, 2026-09-16: the signatures kept landing
     * alone on a second sheet of what was otherwise a one-page document.
     */
    <div className="vds-print-signatures mt-12 grid grid-cols-2 gap-8 pt-10 text-center text-xs">
      {[
        { label: left, name: leftName },
        { label: right, name: rightName }
      ].map((column, i) => (
        <div key={i}>
          <div className="mx-auto h-8 w-2/3 border-b border-slate-500" />
          <span className="mt-1 block font-mono text-[10px] uppercase text-slate-500">{column.label}</span>
          <span className="block min-h-[1.2em] font-mono text-[10px] font-semibold uppercase text-slate-800">
            {column.name || ''}
          </span>
        </div>
      ))}
    </div>
  );
}
