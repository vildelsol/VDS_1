/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One cleaning rule for every piece of text that is stored, and one key for comparing names and bank references.
 *
 * Text arrives from forms, pasted spreadsheets and bank statements. Two strings that read the same to a person
 * ("Smith" with a zero-width space in it, "ABC 123" and "ABC-123", full-width digits) must be the same string to the
 * books, or a payer is split in two and one statement line can settle two items.
 */

/** Invisible and control characters: format (zero-width, direction marks, BOM), control, lone surrogates, noncharacters. */
const UNWANTED = /[\p{Cf}\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/gu;
/** Spaces of other widths, read as an ordinary space. */
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Tidy typed text: NFC, no invisible or control characters, odd spaces made ordinary, runs of spaces collapsed, ends
 * trimmed. A single-line field also loses its newlines and tabs; a multi-line note keeps newline and tab.
 */
export function cleanText(raw: string, multiline = false): string {
  let v = raw.normalize('NFC').replace(/\r\n?|\u2028|\u2029/g, '\n').replace(ODD_SPACES, ' ');
  if (!multiline) v = v.replace(/[\n\t\v\f]/g, ' ');
  v = v.replace(UNWANTED, ch => (multiline && (ch === '\n' || ch === '\t') ? ch : ''));
  v = v.replace(/ {2,}/g, ' ');
  if (multiline) v = v.replace(/ ?\n ?/g, '\n');
  return v.trim();
}

/** The key two spellings of one person's name share: cleaned, compatibility-folded, case-folded. */
export function nameKey(name: unknown): string {
  return typeof name === 'string' ? cleanText(name).normalize('NFKC').toLowerCase() : '';
}

/**
 * The key two spellings of one bank reference share: cleaned, NFKC (full-width digits become ASCII), case-folded, with
 * every space, hyphen and punctuation mark removed ("ABC-123", "abc 123" and "ABC123" are one reference).
 */
export function referenceKey(reference: unknown): string {
  if (typeof reference !== 'string') return '';
  return cleanText(reference).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
