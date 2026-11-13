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
export function auditEntryHash(e: AuditLog): string {
  return createHash('sha256')
    .update(
      JSON.stringify([e.prevSeal || '', e.id, e.user, e.role, e.dateTime, e.action, e.recordType, e.recordId, e.previousValue, e.newValue, e.approvedBy || ''])
    )
    .digest('hex');
}
