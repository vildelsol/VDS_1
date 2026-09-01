/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Excel workbooks the property hands to accountants and owners.
 *
 * These exports were CSV until 2026-09-01, and CSV cannot be made to look
 * professional however carefully it is written — no column widths, no bold, no
 * number formats, no page setup. Printed, they came out as a wall of unlabelled
 * text; opened, `20000` sat in a narrow column beside a raw `2026-08-01`. Ro
 * asked for documents that can go to an accountant or an owner without
 * apologising for them.
 *
 * An `.xlsx` is a ZIP of XML parts, so this suite opens the produced file the
 * way Excel does — reading the archive and the XML — and asserts the things that
 * actually make the difference between a spreadsheet and a document:
 *
 *   - **money is a number with a currency format**, not text that looks like
 *     money, so an accountant can re-total a column;
 *   - **JMD and USD carry different formats**, so no column ever implies the two
 *     can be added;
 *   - **dates are real dates**, so they sort;
 *   - headers are bold on a filled row, frozen on screen and **repeated at the
 *     top of every printed page**;
 *   - columns have widths, so nothing arrives as `####`;
 *   - the page is set up to print — fit to one page wide, with a page footer;
 *   - and every document says what property it is, what it is, and what period
 *     it covers, because these get printed and separated.
 *
 * The ZIP reader here is deliberately its own small implementation rather than a
 * dependency: the writer produces stored (uncompressed) entries, so reading one
 * back is a matter of walking the local headers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Excel workbooks for accountants and owners';

async function loadXlsx(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-xlsx-'));
  const outfile = path.join(dir, 'xlsx.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'xlsx.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Read a stored-entry ZIP back into `{ name: text }`.
 *
 * Walks the local file headers, which is all that is needed while every entry is
 * stored. If the writer ever starts compressing, this will notice: a deflated
 * entry has method 8 and is reported rather than silently mis-read.
 */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const compSize = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const nameStart = at + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if (method !== 0) throw new Error(`entry ${name} is compressed (method ${method}); this reader only handles stored entries`);
    files[name] = new TextDecoder().decode(bytes.subarray(dataStart, dataStart + compSize));
    at = dataStart + compSize;
  }
  return files;
}

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadXlsx(projectRoot);
  const { buildWorkbook, cell, documentHeader } = mod;

  try {
    const rows = [
      ...documentHeader({
        documentTitle: 'Consolidated Operating Statement',
        period: '1 Aug 2026 to 31 Aug 2026',
        generatedOn: '1 Sep 2026',
        generatedBy: 'System Administrator',
        planNumber: '2324',
        span: 6
      }),
      [cell.section('1. Common costs paid', 6)],
      [cell.header('Date'), cell.header('Supplier'), cell.header('Description'), cell.header('Reference'), cell.header('Category'), cell.header('Amount', 'right')],
      [cell.date('2026-08-12'), cell.text('Grounds crew'), cell.text('Grounds staff — August'), cell.text('INV-1'), cell.text('Payroll'), cell.money(18500, 'JMD')],
      [cell.date('2026-08-12'), cell.text('AquaChem'), cell.text('Pool "chemicals" & <chlorine>'), cell.text(''), cell.text('Supplies'), cell.money(-3150.5, 'JMD')],
      [cell.total('Total'), cell.blank(), cell.blank(), cell.blank(), cell.blank(), cell.totalMoney(15349.5, 'JMD')],
      [cell.blank()],
      [cell.date('not-a-date'), cell.text('Imports Ltd'), cell.text('Pump part'), cell.text(''), cell.text('Supplies'), cell.money(300, 'USD')],
      [cell.note('USD and JMD are reported separately and are never combined.', 6)]
    ];

    const bytes = buildWorkbook([
      { name: 'Operating Statement', widths: [14, 26, 40, 14, 16, 16], rows, freezeRows: 8, repeatRow: 8, landscape: true },
      { name: 'A/Very:Long*Sheet[Name]That Goes On And On', widths: [20, 20], rows: [[cell.header('A'), cell.header('B')], [cell.text('x'), cell.number(12.5)]] }
    ]);

    T.check('a workbook is produced', bytes instanceof Uint8Array && bytes.length > 2000, `${bytes?.length} bytes`);
    T.check('and it is a ZIP archive, which is what an .xlsx is', bytes[0] === 0x50 && bytes[1] === 0x4b, `first bytes ${bytes[0]},${bytes[1]}`);

    const files = readZip(bytes);
    for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
      T.check(`the archive carries ${required}`, !!files[required], Object.keys(files).join(', '));
    }

    const sheet = files['xl/worksheets/sheet1.xml'];
    const styles = files['xl/styles.xml'];
    const workbook = files['xl/workbook.xml'];

    /* ---------------- money is money, not text that looks like it ---------------- */

    /*
     * The single most important assertion here. As text, a column of money
     * cannot be summed, and an accountant who receives one has to retype it.
     * `<v>` means Excel holds a number; `t="inlineStr"` would mean a string.
     */
    T.check(
      'money is written as a number, so a column can be re-totalled',
      /<c r="F9" s="\d+"><v>18500<\/v><\/c>/.test(sheet),
      (sheet.match(/<c r="F9"[^/]*?(\/>|<\/c>)/) || ['not found'])[0]
    );
    T.check('and a negative figure keeps its sign rather than becoming text', /<c r="F10" s="\d+"><v>-3150.5<\/v><\/c>/.test(sheet), (sheet.match(/<c r="F10"[^/]*?(\/>|<\/c>)/) || ['not found'])[0]);
    /*
     * The currency symbol is part of the *format*, and the format code lives in
     * an XML attribute, so its quotes are escaped as `&quot;`. Matched in that
     * form deliberately: the first version of this test looked for the raw
     * quotes, failed, and looked for a moment like the formats were missing when
     * the output was correct all along.
     */
    T.check('the Jamaican dollar format is defined', /&quot;J\$&quot;#,##0\.00/.test(styles), styles.slice(styles.indexOf('<numFmts'), styles.indexOf('</numFmts>')));
    T.check('the United States dollar format is defined separately', /&quot;US\$&quot;#,##0\.00/.test(styles));
    T.check(
      'and negatives are shown in red and parenthesised, as an accountant reads them',
      /\[Red\]\(&quot;J\$&quot;#,##0\.00\)/.test(styles)
    );

    // The JMD and USD cells must not share a style index, or one currency is
    // being displayed with the other's symbol.
    const jmdStyle = /<c r="F9" s="(\d+)"/.exec(sheet)?.[1];
    const usdStyle = /<c r="F13" s="(\d+)"/.exec(sheet)?.[1];
    T.check('a JMD cell and a USD cell use different formats', !!jmdStyle && !!usdStyle && jmdStyle !== usdStyle, `JMD style ${jmdStyle}, USD style ${usdStyle}`);

    /* ---------------- dates sort, and a bad one degrades safely ---------------- */

    T.check('a date is written as a real date serial', /<c r="A9" s="\d+"><v>46246<\/v><\/c>/.test(sheet), (sheet.match(/<c r="A9"[^/]*?(\/>|<\/c>)/) || ['not found'])[0]);
    T.check('with a readable date format', /dd mmm yyyy/.test(styles));
    T.check(
      'and an unparseable date falls back to plain text rather than becoming a wrong date',
      /<c r="A13"[^>]*t="inlineStr"><is><t[^>]*>not-a-date<\/t><\/is><\/c>/.test(sheet),
      (sheet.match(/<c r="A13"[^>]*>.*?<\/c>/) || ['not found'])[0]
    );

    /* ---------------- it is laid out like a document ---------------- */

    T.check('column widths are set, so nothing arrives as ####', /<col min="3" max="3" width="40"/.test(sheet), 'no width for column C');
    T.check('the header row is frozen on screen', /state="frozen"/.test(sheet) && /ySplit="8"/.test(sheet));
    T.check('and repeats at the top of every printed page', /_xlnm\.Print_Titles/.test(workbook) && /\$8:\$8/.test(workbook), workbook.slice(0, 400));
    T.check('the sheet is set to print landscape, fitted to one page wide', /orientation="landscape"/.test(sheet) && /fitToWidth="1"/.test(sheet) && /fitToPage="1"/.test(sheet));
    T.check('with a page number in the footer', /Page &amp;P of &amp;N/.test(sheet), (sheet.match(/<headerFooter>.*?<\/headerFooter>/) || ['none'])[0]);
    T.check('headers are bold on a filled row', /<fgColor rgb="FF1E293B"\/>/.test(styles) && /<font><b\/><sz val="11"\/><color rgb="FFFFFFFF"\/>/.test(styles));
    T.check('and the document names itself, the property and the period', /VILLAGGIO DEL SOL/.test(sheet) && /Ocho Rios/.test(sheet) && /1 Aug 2026 to 31 Aug 2026/.test(sheet) && /Strata Plan No\. 2324/.test(sheet));
    T.check('the title spans the table rather than sitting in one narrow cell', /<mergeCell ref="A1:F1"\/>/.test(sheet), (sheet.match(/<mergeCells.*?<\/mergeCells>/) || ['none'])[0].slice(0, 200));

    /* ---------------- the file is well-formed where Excel is fussy ---------------- */

    /*
     * Excel does not explain itself when it refuses a workbook — it simply
     * declines to open it — so the two things it is strictest about are asserted
     * directly: element order in the worksheet, and escaping.
     */
    const order = ['<sheetPr', '<dimension', '<sheetViews', '<sheetFormatPr', '<cols', '<sheetData', '<mergeCells', '<pageMargins', '<pageSetup', '<headerFooter'];
    let last = -1;
    let ordered = true;
    for (const tag of order) {
      const at = sheet.indexOf(tag);
      if (at === -1) continue;
      if (at < last) ordered = false;
      last = at;
    }
    T.check('the worksheet elements are in the order the schema demands', ordered, 'an element is out of sequence — Excel would refuse the file');

    T.check(
      'quotes and angle brackets in real data are escaped, not left to break the XML',
      sheet.includes('Pool &quot;chemicals&quot; &amp; &lt;chlorine&gt;'),
      'unescaped text reached the sheet'
    );
    T.check('and no raw ampersand survives outside an entity', !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(sheet), 'a bare & would make the file unreadable');

    /* ---------------- sheet names Excel will accept ---------------- */

    T.check(
      'an over-long or illegal sheet name is made safe rather than breaking the file',
      /<sheet name="[^"]{1,31}"/.test(workbook) && !/[:\\/?*[\]]/.test(/<sheet name="([^"]*)"/g.exec(workbook.slice(workbook.indexOf('Very')))?.[1] || ''),
      (workbook.match(/<sheet name="[^"]*"/g) || []).join(' ')
    );

    /* ---------------- every declared part is actually present ---------------- */

    const declared = [...files['[Content_Types].xml'].matchAll(/PartName="\/([^"]+)"/g)].map(m => m[1]);
    const missing = declared.filter(name => !files[name]);
    T.check('every part the content types declare exists in the archive', missing.length === 0, missing.join(', '));

    const rels = [...files['xl/_rels/workbook.xml.rels'].matchAll(/Target="([^"]+)"/g)].map(m => `xl/${m[1]}`);
    const brokenRels = rels.filter(name => !files[name]);
    T.check('and every relationship points at a part that is there', brokenRels.length === 0, brokenRels.join(', '));

    /* ---------------- an empty document still opens ---------------- */

    const emptyBook = buildWorkbook([{ name: 'Nothing', widths: [12], rows: [[cell.text('No records for this period.')]] }]);
    const emptyFiles = readZip(emptyBook);
    T.check('a document with nothing to report is still a valid workbook', !!emptyFiles['xl/worksheets/sheet1.xml'], 'empty workbook malformed');
  } finally {
    cleanup();
  }

  return T.done();
}
