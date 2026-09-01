/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A small, dependency-free writer for real Excel workbooks.
 *
 * Every export in this application used to be CSV, and CSV cannot be made to
 * look professional however carefully it is written: it carries no column
 * widths, no bold, no number formats, no alignment and no page setup. An
 * accountant opening one gets `20000` in a narrow column beside `2026-08-01`,
 * and printing it produces a wall of unlabelled text split across pages. That is
 * what these documents looked like when they went to owners.
 *
 * An `.xlsx` is a ZIP of XML parts, so writing one properly needs neither a
 * library nor a build step. The entries are stored **uncompressed** — Excel
 * accepts that perfectly well, and it means no deflate implementation is needed
 * in the browser. The whole thing is a few hundred lines and adds nothing to the
 * dependency list, which matters: this application ships as a single Windows
 * executable and every dependency is another thing that has to survive that.
 *
 * What it gives the finished document:
 *
 *   - a title block naming the property, the document and the period;
 *   - bold, filled column headers that stay put when the reader scrolls, and
 *     repeat at the top of every printed page;
 *   - money as *numbers* with a currency format, so a column can be summed and
 *     re-totalled by whoever receives it, rather than as text that only looks
 *     like money;
 *   - dates as real dates, so they sort and filter;
 *   - sensible column widths, so nothing arrives as `####`;
 *   - page setup — landscape where it is needed, fit to one page wide, with
 *     "Page 1 of 3" in the footer.
 *
 * Nothing here converts between currencies, and each sheet's money cells carry
 * their own currency format, so a JMD column and a USD column can sit in one
 * workbook without ever implying they are addable.
 */

import { Currency } from '../types';

/* ------------------------------------------------------------------ *
 * The public shape
 * ------------------------------------------------------------------ */

/**
 * How a cell should look and behave.
 *
 * `money` and `date` are the two that matter most: they make the value a real
 * number or a real date in Excel rather than a string that resembles one, which
 * is the difference between a document an accountant can work with and one they
 * have to retype.
 */
export type CellStyle =
  | 'title'
  | 'subtitle'
  | 'metaLabel'
  | 'meta'
  | 'section'
  | 'header'
  | 'headerRight'
  | 'text'
  | 'textMuted'
  | 'number'
  | 'money'
  | 'date'
  | 'total'
  | 'totalMoney'
  | 'note';

export interface XlsxCell {
  value: string | number | null;
  style?: CellStyle;
  /** Required for `money` and `totalMoney` so the right symbol is shown. */
  currency?: Currency;
  /** Merge this cell across this many columns. */
  span?: number;
}

export interface XlsxSheet {
  name: string;
  /** Column widths in Excel's character units. One entry per column. */
  widths: number[];
  rows: XlsxCell[][];
  /** Rows to freeze at the top so headers stay visible while scrolling. */
  freezeRows?: number;
  /** 1-based row that repeats at the top of every printed page. */
  repeatRow?: number;
  landscape?: boolean;
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

/**
 * Number formats.
 *
 * Negative money is shown in red and parenthesised, which is the convention an
 * accountant expects and reads faster than a minus sign.
 */
const NUM_FMTS: { id: number; code: string }[] = [
  { id: 164, code: '#,##0.00;[Red](#,##0.00)' },
  { id: 165, code: '"J$"#,##0.00;[Red]("J$"#,##0.00)' },
  { id: 166, code: '"US$"#,##0.00;[Red]("US$"#,##0.00)' },
  { id: 167, code: 'dd mmm yyyy' }
];

/**
 * The style table, in the order Excel indexes them.
 *
 * Index 0 must be the default, so it is listed first and never used explicitly.
 */
const STYLE_ORDER: CellStyle[] = [
  'text',
  'title',
  'subtitle',
  'metaLabel',
  'meta',
  'section',
  'header',
  'headerRight',
  'textMuted',
  'number',
  'money',
  'date',
  'total',
  'totalMoney',
  'note'
];

/** Money needs one style per currency; these are appended after the table above. */
const MONEY_STYLES: { style: CellStyle; currency: Currency }[] = [
  { style: 'money', currency: 'JMD' },
  { style: 'money', currency: 'USD' },
  { style: 'totalMoney', currency: 'JMD' },
  { style: 'totalMoney', currency: 'USD' }
];

function styleIndex(style: CellStyle | undefined, currency: Currency | undefined): number {
  const name = style || 'text';
  if (name === 'money' || name === 'totalMoney') {
    const at = MONEY_STYLES.findIndex(m => m.style === name && m.currency === (currency || 'JMD'));
    return STYLE_ORDER.length + (at >= 0 ? at : 0);
  }
  const at = STYLE_ORDER.indexOf(name);
  return at >= 0 ? at : 0;
}

/**
 * `styles.xml`.
 *
 * Written out longhand rather than generated, because the schema is order- and
 * index-sensitive and a generated one is far harder to check by eye when Excel
 * refuses to open the file.
 */
function stylesXml(): string {
  const numFmts = NUM_FMTS.map(f => `<numFmt numFmtId="${f.id}" formatCode="${escapeXml(f.code)}"/>`).join('');

  // 0 normal, 1 bold, 2 title, 3 subtitle italic, 4 section, 5 header (white), 6 muted
  const fonts = [
    '<font><sz val="11"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><name val="Calibri"/></font>',
    '<font><b/><sz val="16"/><color rgb="FF1E293B"/><name val="Calibri"/></font>',
    '<font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>',
    '<font><b/><sz val="12"/><color rgb="FF0F172A"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
    '<font><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>'
  ];

  // 0 none, 1 gray125 (Excel reserves these two), 2 header dark, 3 section light, 4 total light
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>'
  ];

  // 0 none, 1 thin bottom, 2 double top (a total rule), 3 thin box
  const borders = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>',
    '<border><left/><right/><top style="double"><color rgb="FF334155"/></top><bottom/><diagonal/></border>',
    '<border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>'
  ];

  const xf = (opts: { font?: number; fill?: number; border?: number; numFmt?: number; align?: 'left' | 'right' | 'center'; wrap?: boolean }) => {
    const parts = [
      `numFmtId="${opts.numFmt ?? 0}"`,
      `fontId="${opts.font ?? 0}"`,
      `fillId="${opts.fill ?? 0}"`,
      `borderId="${opts.border ?? 0}"`,
      'xfId="0"',
      opts.numFmt ? 'applyNumberFormat="1"' : '',
      opts.font ? 'applyFont="1"' : '',
      opts.fill ? 'applyFill="1"' : '',
      opts.border ? 'applyBorder="1"' : '',
      opts.align || opts.wrap ? 'applyAlignment="1"' : ''
    ]
      .filter(Boolean)
      .join(' ');
    const alignment =
      opts.align || opts.wrap
        ? `<alignment${opts.align ? ` horizontal="${opts.align}"` : ''} vertical="center"${opts.wrap ? ' wrapText="1"' : ''}/>`
        : '';
    return alignment ? `<xf ${parts}>${alignment}</xf>` : `<xf ${parts}/>`;
  };

  const byStyle: Record<CellStyle, string> = {
    text: xf({}),
    title: xf({ font: 2 }),
    subtitle: xf({ font: 3 }),
    metaLabel: xf({ font: 1 }),
    meta: xf({}),
    section: xf({ font: 4, fill: 3, border: 1 }),
    header: xf({ font: 5, fill: 2, border: 1, align: 'left', wrap: true }),
    headerRight: xf({ font: 5, fill: 2, border: 1, align: 'right', wrap: true }),
    textMuted: xf({ font: 6 }),
    number: xf({ numFmt: 164, align: 'right' }),
    money: xf({ numFmt: 165, align: 'right' }),
    date: xf({ numFmt: 167, align: 'left' }),
    total: xf({ font: 1, fill: 4, border: 2 }),
    totalMoney: xf({ font: 1, fill: 4, border: 2, numFmt: 165, align: 'right' }),
    note: xf({ font: 6, wrap: true })
  };

  const cellXfs = STYLE_ORDER.map(name => byStyle[name]).concat(
    MONEY_STYLES.map(m =>
      m.style === 'money'
        ? xf({ numFmt: m.currency === 'USD' ? 166 : 165, align: 'right' })
        : xf({ font: 1, fill: 4, border: 2, numFmt: m.currency === 'USD' ? 166 : 165, align: 'right' })
    )
  );

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="${NUM_FMTS.length}">${numFmts}</numFmts>` +
    `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
    `<fills count="${fills.length}">${fills.join('')}</fills>` +
    `<borders count="${borders.length}">${borders.join('')}</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

/* ------------------------------------------------------------------ *
 * Worksheet
 * ------------------------------------------------------------------ */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Excel refuses a file containing control characters, and pasted data does
    // sometimes carry them.
    .replace(/[ --]/g, '');
}

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * An ISO date as an Excel serial number.
 *
 * Excel counts days from 1899-12-30 (its calendar deliberately includes a
 * non-existent 29 February 1900, and 1899-12-30 is the origin that makes modern
 * dates line up). Returning null for anything unparseable means a malformed date
 * lands in the sheet as plain text rather than as a wrong date, which is the
 * safer failure.
 */
function dateSerial(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(utc)) return null;
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86400000);
}

function sheetXml(sheet: XlsxSheet): string {
  const merges: string[] = [];
  const rowsXml: string[] = [];

  sheet.rows.forEach((cells, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cellsXml: string[] = [];
    let column = 0;

    for (const cell of cells) {
      const ref = `${columnName(column)}${rowNumber}`;
      const style = styleIndex(cell.style, cell.currency);
      const span = Math.max(1, cell.span || 1);

      if (span > 1) {
        merges.push(`<mergeCell ref="${ref}:${columnName(column + span - 1)}${rowNumber}"/>`);
      }

      if (cell.value === null || cell.value === undefined || cell.value === '') {
        cellsXml.push(`<c r="${ref}" s="${style}"/>`);
      } else if (cell.style === 'date' && typeof cell.value === 'string') {
        const serial = dateSerial(cell.value);
        if (serial === null) {
          cellsXml.push(`<c r="${ref}" s="${styleIndex('text', undefined)}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`);
        } else {
          cellsXml.push(`<c r="${ref}" s="${style}"><v>${serial}</v></c>`);
        }
      } else if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
        cellsXml.push(`<c r="${ref}" s="${style}"><v>${cell.value}</v></c>`);
      } else {
        cellsXml.push(`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell.value))}</t></is></c>`);
      }

      // Merged cells still occupy their columns.
      for (let k = 1; k < span; k++) {
        cellsXml.push(`<c r="${columnName(column + k)}${rowNumber}" s="${style}"/>`);
      }
      column += span;
    }

    rowsXml.push(`<row r="${rowNumber}">${cellsXml.join('')}</row>`);
  });

  const cols = sheet.widths
    .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
    .join('');

  const freeze = sheet.freezeRows
    ? `<pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>`
    : '';

  /*
   * Element order here is the schema's, not a preference: Excel rejects the file
   * outright if `mergeCells` comes before `sheetData`, or `pageSetup` before
   * `pageMargins`. Worth stating, because the failure is a flat refusal to open
   * with no indication of which part is wrong.
   */
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<dimension ref="A1"/>` +
    `<sheetViews><sheetView workbookViewId="0" showGridLines="0">${freeze}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '') +
    `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
    `<pageSetup orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0" paperSize="9"/>` +
    `<headerFooter><oddFooter>&amp;L${escapeXml(sheet.name)}&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>` +
    `</worksheet>`
  );
}

/* ------------------------------------------------------------------ *
 * ZIP container (stored, no compression)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Build the archive with **stored** entries.
 *
 * Uncompressed on purpose: it removes any need for a deflate implementation in
 * the browser, and Excel reads stored entries without complaint. These documents
 * are tens of kilobytes, so the size cost is irrelevant beside the dependency
 * that compressing them would require.
 */
function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const join = (parts: Uint8Array[]) => {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  for (const file of files) {
    const nameBytes = utf8(file.name);
    const crc = crc32(file.data);
    const local = join([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(0), // time
      u16(0x21), // date: 1980-01-01, so the archive is byte-identical run to run
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      file.data
    ]);
    chunks.push(local);

    central.push(
      join([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed
        u16(0),
        u16(0),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(file.data.length),
        u32(file.data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes
      ])
    );
    offset += local.length;
  }

  const centralBytes = join(central);
  const end = join([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0)
  ]);

  return join([...chunks, centralBytes, end]);
}

/* ------------------------------------------------------------------ *
 * The workbook
 * ------------------------------------------------------------------ */

/** Excel refuses sheet names over 31 characters or containing : \ / ? * [ ] */
function safeSheetName(name: string, fallback: string): string {
  const cleaned = (name || fallback).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return cleaned || fallback;
}

export function buildWorkbook(sheets: XlsxSheet[]): Uint8Array {
  const named = sheets.map((sheet, i) => ({ ...sheet, name: safeSheetName(sheet.name, `Sheet${i + 1}`) }));

  const sheetEntries = named.map((sheet, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: utf8(sheetXml(sheet))
  }));

  /*
   * Print titles: the header row repeated at the top of every printed page.
   * Without it a three-page statement has unlabelled columns on pages two and
   * three, which is precisely the complaint these documents were getting.
   */
  const definedNames = named
    .map((sheet, i) =>
      sheet.repeatRow
        ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${sheet.name.replace(/'/g, "''")}'!$${sheet.repeatRow}:$${sheet.repeatRow}</definedName>`
        : ''
    )
    .filter(Boolean)
    .join('');

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    named.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets>` +
    (definedNames ? `<definedNames>${definedNames}</definedNames>` : '') +
    `</workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    named
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('') +
    `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'xl/workbook.xml', data: utf8(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
    { name: 'xl/styles.xml', data: utf8(stylesXml()) },
    ...sheetEntries
  ]);
}

/** Build the workbook and hand it to the browser as a download. */
export function downloadWorkbook(sheets: XlsxSheet[], filename: string) {
  const bytes = buildWorkbook(sheets);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ *
 * Helpers for building a document that reads like a document
 * ------------------------------------------------------------------ */

export const cell = {
  title: (text: string, span = 8): XlsxCell => ({ value: text, style: 'title', span }),
  subtitle: (text: string, span = 8): XlsxCell => ({ value: text, style: 'subtitle', span }),
  section: (text: string, span = 8): XlsxCell => ({ value: text, style: 'section', span }),
  header: (text: string, align: 'left' | 'right' = 'left'): XlsxCell => ({ value: text, style: align === 'right' ? 'headerRight' : 'header' }),
  text: (value: string | null): XlsxCell => ({ value, style: 'text' }),
  muted: (value: string | null): XlsxCell => ({ value, style: 'textMuted' }),
  money: (value: number, currency: Currency): XlsxCell => ({ value, style: 'money', currency }),
  number: (value: number): XlsxCell => ({ value, style: 'number' }),
  date: (iso: string): XlsxCell => ({ value: iso, style: 'date' }),
  total: (label: string): XlsxCell => ({ value: label, style: 'total' }),
  totalMoney: (value: number, currency: Currency): XlsxCell => ({ value, style: 'totalMoney', currency }),
  note: (text: string, span = 8): XlsxCell => ({ value: text, style: 'note', span }),
  blank: (): XlsxCell => ({ value: null, style: 'text' })
};

/**
 * The masthead every exported document carries.
 *
 * The same block on every sheet, so a page that has been printed and separated
 * from its neighbours still says what property it belongs to, what it is, and
 * what period it covers. A statement that cannot identify itself is not much
 * use to an accountant holding six of them.
 */
export function documentHeader(opts: {
  documentTitle: string;
  period: string;
  generatedOn: string;
  generatedBy: string;
  planNumber?: string;
  span?: number;
}): XlsxCell[][] {
  const span = opts.span ?? 8;
  return [
    [cell.title('VILLAGGIO DEL SOL', span)],
    [cell.subtitle(`Ocho Rios, St. Ann, Jamaica${opts.planNumber ? ` · Strata Plan No. ${opts.planNumber}` : ''}`, span)],
    [{ value: opts.documentTitle, style: 'section', span }],
    [
      { value: 'Period', style: 'metaLabel' },
      { value: opts.period, style: 'meta', span: Math.max(1, span - 1) }
    ],
    [
      { value: 'Prepared', style: 'metaLabel' },
      { value: `${opts.generatedOn} by ${opts.generatedBy}`, style: 'meta', span: Math.max(1, span - 1) }
    ],
    [cell.blank()]
  ];
}
