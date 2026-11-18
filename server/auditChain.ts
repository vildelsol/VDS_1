/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The audit trail's hash chain. Kept in its own file so both the writer
 * (`addAudit`) and the checker (`checkIntegrity`) use the one definition without
 * importing each other.
 */
import { createHash } from 'crypto';
import type { AuditLog } from '../src/types';

/** What an audit hash covers: everything a reader relies on, and the link to the entry before it. */
/**
 * Where the audit trail is trimmed, oldest first.
 *
 * It lived as a bare 20000 in two files: the trim in server/db.ts and the
 * "archive me" warning in server/integrity.ts. Change one and the warning
 * silently stops firing before the trim it is supposed to precede — a figure
 * pinned in two places that can go stale on either side. One definition, both
 * readers.
 */
export const AUDIT_CAP = 20000;

export function auditEntryHash(e: AuditLog): string {
  return createHash('sha256')
    .update(
      JSON.stringify([e.prevSeal || '', e.id, e.user, e.role, e.dateTime, e.action, e.recordType, e.recordId, e.previousValue, e.newValue, e.approvedBy || ''])
    )
    .digest('hex');
}
