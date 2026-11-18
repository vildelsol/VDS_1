/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The server refuses any money-check override (confirmDuplicate,
 * confirmCurrencyMismatch, confirmNoOpenCharge, confirmAlreadySettled) that
 * arrives without an overrideReason (400 override-reason-required). A screen
 * that sends the flag but has no reason field leaves the person with a box
 * they can tick and a form that can never be submitted. Every screen that
 * sends one of these flags must also send overrideReason and render
 * OverrideReasonField.
 */

import fs from 'node:fs';
import path from 'node:path';
import { reporter } from './harness.mjs';

export const title = 'Override reasons on every money screen';

const FLAGS = /\b(confirmDuplicate|confirmCurrencyMismatch|confirmNoOpenCharge|confirmAlreadySettled)\b\s*[,:\n]/;

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const dir = path.join(projectRoot, 'src', 'components');
  const senders = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.tsx'))
    .filter(f => {
      const s = fs.readFileSync(path.join(dir, f), 'utf-8');
      return /api\.post|onSubmit|onRecord|onSave/.test(s) && FLAGS.test(s) && /confirmDuplicate\b/.test(s);
    });
  T.check('the scan finds the money screens that send override flags (positive control)', senders.length >= 3, senders.join(', '));
  for (const f of senders) {
    const s = fs.readFileSync(path.join(dir, f), 'utf-8');
    T.check(`${f} sends overrideReason with its override flags`, /overrideReason:\s*overriding/.test(s));
    T.check(`${f} shows the reason field`, /<OverrideReasonField\b/.test(s));
  }
  return T.done();
}
