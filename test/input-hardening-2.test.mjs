/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Input safeguards, second pass (QA2 area I, 2026-11-21).
 *
 * The first pass (input-hardening) made the server refuse a figure it could not read. This one closes the cases
 * where it still said yes while changing what was sent: a password longer than login would compare, a let villa with
 * no rent, a meter reading read as zero, money-out defaulting to "everything", a receipt dated in the year 1,
 * invisible characters in a name, a third decimal quietly rounded, a note quietly cut short, a string "false"
 * granting a permission, and a close-the-books month of 0000-01.
 *
 * Every refusal is paired with a positive control, so a guard that refuses everything cannot pass.
 * Dates are pinned; nothing here reads the clock except through the dates the server itself judges "future".
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Input safeguards, second pass';

/** Bundle the pure libraries the checks below call directly. */
async function loadLibs(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-ih2-'));
  const outfile = path.join(dir, 'libs.mjs');
  const root = projectRoot.split(path.sep).join('/');
  await build({
    stdin: {
      contents: `
        export * from '${root}/src/lib/text';
        export * from '${root}/src/lib/xlsx';
        export * from '${root}/src/lib/dates';
        export * from '${root}/src/lib/money';
        export { itemOnBankLine } from '${root}/src/lib/bankRec';
        export { letVillasWithNoRent } from '${root}/src/lib/finance';
        export { hubOpenItemCount } from '${root}/src/lib/notifications';
      `,
      resolveDir: projectRoot,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Read a stored-entry ZIP back into { name: text } (the workbook writer stores, never compresses). */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const compSize = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const nameStart = at + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    files[name] = new TextDecoder().decode(bytes.subarray(dataStart, dataStart + compSize));
    at = dataStart + compSize;
  }
  return files;
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Harden2-1234!', projectRoot });
  const T = reporter(title);
  const { mod: L, cleanup } = await loadLibs(projectRoot);
  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Harden2-1234!', 'Harden2New-9876!');
    const db = async () => (await admin.get('/api/db')).body;
    const err = r => `${r.status} ${r.body?.error ?? ''}`;

    /* ================================================================ *
     * 1. Passwords: a maximum, refused (never truncated), text only
     * ================================================================ */
    const P200 = 'Aa1!' + 'x'.repeat(196);
    const P201 = P200 + 'y';
    const mk = (username, password) => admin.post('/api/users', { name: `User ${username}`, username, role: 'JUNIOR_OFFICER', password });
    T.check('1 a 200-character password is accepted when a user is created (positive control)', (await mk('pw200', P200)).status === 200);
    const login200 = makeClient(srv.baseUrl);
    T.check('1 and that user can sign in with all 200 characters', (await login200.post('/api/auth/login', { username: 'pw200', password: P200 })).status === 200);
    const created201 = await mk('pw201', P201);
    T.check('1 a 201-character password is refused when a user is created', created201.status === 400 && /200 characters/.test(created201.body?.error || ''), err(created201));
    const wrongLen = await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'pw200', password: P201 });
    const wrongPw = await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'pw200', password: 'Wrong-Password-1' });
    T.check('1 login with a password over the maximum is refused with the ordinary failed-sign-in answer, not cut short to match',
      wrongLen.status === 401 && wrongLen.body?.error === wrongPw.body?.error, `${wrongLen.status} ${wrongLen.body?.error} vs ${wrongPw.body?.error}`);
    const userId = (await db()).users?.find?.(u => u.username === 'pw200')?.id || (await db()).users?.find?.(u => u.username === 'pw200')?.id;
    const reset201 = await admin.post(`/api/users/${userId}/reset-password`, { password: P201 });
    T.check('1 reset-password refuses 201 characters', reset201.status === 400, err(reset201));
    T.check('1 reset-password accepts 200', (await admin.post(`/api/users/${userId}/reset-password`, { password: 'Bb2@' + 'z'.repeat(196) })).status === 200);
    for (const bad of [{}, ['Abcdefghij1!'], 12345678901234, true]) {
      const c = await admin.post('/api/users', { name: 'NonString', username: 'nonstring', role: 'JUNIOR_OFFICER', password: bad });
      T.check(`1 a non-string password ${JSON.stringify(bad)} is refused on create`, c.status === 400, err(c));
      const r = await admin.post(`/api/users/${userId}/reset-password`, { password: bad });
      T.check(`1 a non-string password ${JSON.stringify(bad)} is refused on reset`, r.status === 400, err(r));
    }
    T.check('1 no account was created by the non-string attempts', !(await db()).users?.some?.(u => u.username === 'nonstring'));
    await mk('pwchange', 'Rotate-Key-48213!');
    const self = makeClient(srv.baseUrl);
    await self.post('/api/auth/login', { username: 'pwchange', password: 'Rotate-Key-48213!' }, { captureCookie: true });
    const chg201 = await self.post('/api/auth/change-password', { currentPassword: 'Rotate-Key-48213!', newPassword: P201 });
    T.check('1 change-password refuses 201 characters', chg201.status === 400, err(chg201));
    const chgObj = await self.post('/api/auth/change-password', { currentPassword: 'Rotate-Key-48213!', newPassword: { a: 1 } });
    T.check('1 change-password refuses a non-string new password', chgObj.status === 400, err(chgObj));
    T.check('1 the old password still signs in after the refused changes (nobody is locked out)', (await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'pwchange', password: 'Rotate-Key-48213!' })).status === 200);
    T.check('1 change-password to exactly 200 works (positive control)', (await self.post('/api/auth/change-password', { currentPassword: 'Rotate-Key-48213!', newPassword: P200 })).status === 200);
    T.check('1 and signs in with it', (await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'pwchange', password: P200 })).status === 200);

    /* ================================================================ *
     * 2. A let villa with a tenant and no rent
     * ================================================================ */
    T.check('2 setup: a let villa with rent', (await makeLongTermUnit(admin, 'unit-1')).status === 200);
    const letPut = rent => admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', tenantName: 'Tenant', status: 'long-term', currency: 'JMD', maintCurrency: 'JMD', ...rent });
    for (const rent of [{ monthlyRent: 0 }, { monthlyRent: '0' }, { monthlyRent: '0.001' }, { monthlyRent: -5 }]) {
      const r = await letPut(rent);
      T.check(`2 rent ${JSON.stringify(rent.monthlyRent)} on a let villa with a tenant is refused`, r.status === 400, err(r));
    }
    const zero = await letPut({ monthlyRent: 0 });
    T.check('2 the refusal names the villa and carries the code rent-required', zero.body?.code === 'rent-required' && /no monthly rent/.test(zero.body?.error || ''), JSON.stringify(zero.body));
    T.check('2 the rent on file was not changed by the refused saves', (await db()).units.find(u => u.id === 'unit-1').monthlyRent === 50000);
    T.check('2 saving with the rent left out keeps the old rent (positive control)', (await letPut({})).status === 200);
    T.check('2 a new positive rent is accepted', (await letPut({ monthlyRent: 52000 })).status === 200 && (await db()).units.find(u => u.id === 'unit-1').monthlyRent === 52000);
    const vacantZero = await admin.put('/api/units/unit-3', { number: '3', ownerName: 'Owner', tenantName: '', status: 'long-term', monthlyRent: 0, currency: 'JMD', maintCurrency: 'JMD' });
    T.check('2 a long-term villa with no tenant named may have no rent yet (positive control)', vacantZero.status === 200, err(vacantZero));
    const unitRows = (await db()).units;
    const legacy = unitRows.map(u => (u.id === 'unit-1' ? { ...u, monthlyRent: 0 } : u));
    T.check('2 the hub lists a villa already on file with a tenant and no rent', L.letVillasWithNoRent(legacy).map(u => u.id).join() === 'unit-1', JSON.stringify(L.letVillasWithNoRent(legacy).map(u => u.id)));
    T.check('2 and lists nothing when every let villa has rent', L.letVillasWithNoRent(unitRows).length === 0);
    const hubBase = { units: unitRows, charges: [], payments: [], utilities: [], expenses: [], bookings: [], tenancies: [] };
    T.check('2 the badge count rises by one for it, in step with the hub', L.hubOpenItemCount({ ...hubBase, units: legacy }, '2026-07-15') === L.hubOpenItemCount(hubBase, '2026-07-15') + 1);
    const notifSrc = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'NotificationsTab.tsx'), 'utf8');
    T.check('2 the Notifications hub builds an alert from it', /letVillasWithNoRent\(units\)/.test(notifSrc) && /\.\.\.noRentItems/.test(notifSrc));

    /* ================================================================ *
     * 3. Utility readings
     * ================================================================ */
    const ut = over => admin.post('/api/utilities', { unitId: 'unit-1', type: 'Water', billingPeriod: '2026-06', amountCharged: 3000, currency: 'JMD', previousReading: 100, currentReading: 140, ...over });
    for (const [label, over] of [
      ['previous "abc"', { previousReading: 'abc' }], ['previous []', { previousReading: [] }], ['previous null', { previousReading: null }],
      ['previous -50', { previousReading: -50 }], ['previous true', { previousReading: true }], ['previous "0x10"', { previousReading: '0x10' }],
      ['previous "5%"', { previousReading: '5%' }], ['previous {}', { previousReading: {} }], ['current "0x28"', { currentReading: '0x28' }],
      ['current null', { currentReading: null }], ['current ""', { currentReading: '' }], ['current []', { currentReading: [] }], ['current -1', { currentReading: -1 }]
    ]) {
      const r = await ut(over);
      T.check(`3 a reading with ${label} is refused, not zeroed`, r.status === 400, err(r));
    }
    T.check('3 no reading was stored by the refused posts', (await db()).utilities.length === 0);
    const okUt = await ut({ previousReading: '1,000', currentReading: '1,040' });
    T.check('3 readings typed "1,000" and "1,040" are read as 1000 and 1040 (positive control)', okUt.status === 200 && okUt.body?.utility?.previousReading === 1000 && okUt.body?.utility?.consumption === 40, JSON.stringify(okUt.body));
    const utId = okUt.body?.utility?.id;
    for (const [label, body] of [['previous "abc"', { previousReading: 'abc' }], ['previous null', { previousReading: null }], ['current "0x28"', { currentReading: '0x28' }], ['previous -5', { previousReading: -5 }]]) {
      const r = await admin.put(`/api/utilities/${utId}`, body);
      T.check(`3 PUT with ${label} is refused`, r.status === 400, err(r));
    }
    const putOk = await admin.put(`/api/utilities/${utId}`, { currentReading: 1050 });
    T.check('3 PUT of a good current reading works and consumption follows', putOk.status === 200 && (await db()).utilities.find(u => u.id === utId).consumption === 50, err(putOk));

    /* ================================================================ *
     * 4. Money out is never assumed
     * ================================================================ */
    await admin.post('/api/charges/post-month', { monthString: '2026-07' });
    const paid = await recordAndConfirmPayment(admin, { unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 104000, currency: 'JMD', date: '2026-07-05', method: 'Bank Transfer', advancePayment: true });
    const payId = paid.body?.payment?.id;
    T.check('4 setup: a receipt', !!payId, err(paid));
    for (const [label, body] of [['no amount', {}], ['a null amount', { amount: null }], ['an empty amount', { amount: '' }]]) {
      const r = await admin.post(`/api/payments/${payId}/refund`, { ...body, refundedOn: '2026-07-10', method: 'Bank Transfer', reason: 'Tenant left early' });
      T.check(`4 a refund with ${label} is refused, not made for the whole receipt`, r.status === 400 && /required/.test(r.body?.error || ''), err(r));
    }
    T.check('4 the receipt was not refunded by the refused requests', !(await db()).payments.find(p => p.id === payId).refundedAmount);
    const part = await admin.post(`/api/payments/${payId}/refund`, { amount: 2000, refundedOn: '2026-07-10', method: 'Bank Transfer', reason: 'Tenant left early' });
    T.check('4 a refund with an explicit amount works (positive control)', part.status === 200 && (await db()).payments.find(p => p.id === payId).refundedAmount === 2000, err(part));

    const ten = (await db()).tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    await admin.put(`/api/tenancies/${ten.id}`, { startedOn: '2026-03-01' });
    T.check('4 setup: a deposit is held', (await admin.post(`/api/tenancies/${ten.id}/deposit`, { amount: 100000, receivedOn: '2026-03-01' })).status === 200);
    const noReturn = await admin.post(`/api/tenancies/${ten.id}/deposit/settle`, { withheldAmount: 0, settledOn: '2026-08-01' });
    T.check('4 settling a deposit without the returned amount is refused, not returned in full', noReturn.status === 400 && /required/.test(noReturn.body?.error || ''), err(noReturn));
    T.check('4 the deposit is still held', !(await db()).tenancies.find(t => t.id === ten.id).depositReturnedOn);
    const settled = await admin.post(`/api/tenancies/${ten.id}/deposit/settle`, { returnedAmount: 100000, withheldAmount: 0, settledOn: '2026-08-01' });
    T.check('4 settling with the amounts stated works (positive control)', settled.status === 200, err(settled));

    /* ================================================================ *
     * 5. Dates: 2000-01-01 to 2100-12-31
     * ================================================================ */
    const pay = (date, extra = {}) => admin.post('/api/payments', { unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 100, currency: 'JMD', date, method: 'Cash', ...extra });
    for (const d of ['0001-01-01', '1900-01-01', '1999-12-31', '2101-01-01', '9999-12-31']) {
      const r = await pay(d);
      T.check(`5 a receipt dated ${d} is refused`, r.status === 400 && /valid date/.test(r.body?.error || ''), err(r));
    }
    T.check('5 a date sent as an array is refused, not read through String()', (await pay(['2026-07-06'])).status === 400);
    T.check('5 2026-07-06 is accepted (positive control)', (await pay('2026-07-06')).status === 200);
    T.check('5 the floor itself, 2000-01-01, is accepted', (await pay('2000-01-01')).status === 200);
    const clientDate = await admin.put(`/api/tenancies/${ten.id}`, { startedOn: '0001-01-01' });
    T.check('5 a tenancy cannot start in the year 1', clientDate.status === 400, err(clientDate));
    const stay = over => ({ unitId: 'unit-2', guestName: 'Guest', checkIn: '2027-01-10', checkOut: '2027-01-13', currency: 'JMD', source: 'Direct', amount: 100, ...over });
    await admin.put('/api/units/unit-2', { number: '2', ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 0, currency: 'JMD', maintCurrency: 'JMD' });
    T.check('5 a booking in 9999 is refused', (await admin.post('/api/bookings', stay({ checkIn: '9999-01-10', checkOut: '9999-01-13' }))).status === 400);
    T.check('5 a booking in 1900 is refused', (await admin.post('/api/bookings', stay({ checkIn: '1900-01-10', checkOut: '1900-01-13' }))).status === 400);
    T.check('5 a booking in 2027 is accepted (positive control)', (await admin.post('/api/bookings', stay())).status === 200);
    T.check('5 isValidDay bounds, and the months too',
      L.isValidDay('2000-01-01') && L.isValidDay('2100-12-31') && !L.isValidDay('1999-12-31') && !L.isValidDay('2101-01-01') && L.isValidMonth('2000-01') && !L.isValidMonth('1999-12') && !L.isValidMonth('2101-01'));
    const sheetOf = date => {
      const bytes = L.buildWorkbook([{ name: 'S', widths: [14], rows: [[L.cell.date(date)]] }]);
      return Object.entries(readZip(bytes)).find(([n]) => /worksheets\/sheet1\.xml$/.test(n))?.[1] || '';
    };
    const serial = d => Math.round((Date.UTC(...d) - Date.UTC(1899, 11, 30)) / 86400000);
    T.check('5 xlsx writes 2026-08-12 as its true serial (positive control)', sheetOf('2026-08-12').includes(`<v>${serial([2026, 7, 12])}</v>`), sheetOf('2026-08-12').slice(0, 400));
    for (const d of ['0001-01-01', '0050-06-01', '1850-01-01', '1900-01-15']) {
      const x = sheetOf(d);
      T.check(`5 xlsx does not misplace ${d} as a number (it stays text)`, !/<v>\d+<\/v>/.test(x) && x.includes(d), x.slice(0, 300));
    }

    /* ================================================================ *
     * 6. xlsx strips what XML cannot hold
     * ================================================================ */
    const xmlOf = text => {
      const bytes = L.buildWorkbook([{ name: 'S', widths: [30], rows: [[L.cell.text(text)]] }]);
      return Object.entries(readZip(bytes)).filter(([n]) => /\.xml$/.test(n)).map(([, v]) => v).join('\n');
    };
    const dirty = xmlOf('A\uFFFEB\uFFFFC\uD800D\uDC00E\u0001F\u000BG\u001FH ok\tTab\nNL\r');
    T.check('6 U+FFFE, U+FFFF, lone surrogates and C0 controls are stripped', !/[\uFFFE\uFFFF\uD800\uDC00\u0001\u000B\u001F]/.test(dirty) && dirty.includes('ABCDEFGH ok'), JSON.stringify(dirty.match(/ABC.{0,12}/)?.[0]));
    T.check('6 tab, newline and carriage return survive (positive control)', /ok\tTab\nNL\r/.test(dirty));
    T.check('6 a real emoji (a valid surrogate pair) survives', xmlOf('Pool \uD83C\uDFCA').includes('Pool \uD83C\uDFCA'));

    /* ================================================================ *
     * 7. Strings: text only, cleaned, matched alike
     * ================================================================ */
    const pName = (payerName, extra = {}) => admin.post('/api/payments', { unitId: 'unit-1', payerName, category: 'Rent', amount: 111, currency: 'JMD', date: '2026-07-07', method: 'Cash', ...extra });
    for (const bad of [{}, ['Tenant'], 5, true]) {
      const r = await pName(bad);
      T.check(`7 payerName ${JSON.stringify(bad)} is refused, not stored as text`, r.status === 400 && /text|required/.test(r.body?.error || ''), err(r));
    }
    T.check('7 a name that is only zero-width characters is refused as empty', (await pName('\u200B\u200B')).status === 400);
    T.check('7 a name that is only a NUL is refused as empty', (await pName('\u0000')).status === 400);
    const dirtyName = await pName('  Jane\u200B  \u00A0 Smith\u0000\u202E  ');
    const stored = dirtyName.body?.payment?.payerName;
    T.check('7 zero-width, NUL, direction override and runs of spaces are cleaned from a stored name', dirtyName.status === 200 && stored === 'Jane Smith', JSON.stringify(stored));
    const composed = await pName('Jose\u0301');
    T.check('7 text is stored in NFC (e + combining acute becomes one letter)', composed.body?.payment?.payerName === 'Jos\u00E9', JSON.stringify(composed.body?.payment?.payerName));
    const noted = await pName('Notes Payer', { notes: 'line one\nline two\u0000\u200B\twith tab' });
    T.check('7 a multi-line note keeps newline and tab but loses NUL and zero-width', noted.body?.payment?.notes === 'line one\nline two\twith tab', JSON.stringify(noted.body?.payment?.notes));
    T.check('7 a single-line reference loses a newline', (await pName('Ref Payer', { reference: 'AB\nCD' })).body?.payment?.reference === 'AB CD');
    T.check('7 nameKey treats a zero-width character, a double space and case as nothing', L.nameKey('Jane\u200B  SMITH') === L.nameKey('jane smith') && L.nameKey('jane smith') !== L.nameKey('jane smyth'));
    T.check('7 nameKey is empty for a non-string', L.nameKey({}) === '' && L.nameKey(null) === '');
    const user = await admin.post('/api/users', { name: { a: 1 }, username: 'objname', role: 'JUNIOR_OFFICER', password: 'ObjName-12345!' });
    T.check('7 a user name that is not text is refused', user.status === 400, err(user));
    const settingsStrata = await admin.post('/api/settings', { strataPlanNumber: { x: 1 } });
    T.check('7 a strata plan number that is not text is refused', settingsStrata.status === 400, err(settingsStrata));

    /* ================================================================ *
     * 8. Bank references compare by their substance
     * ================================================================ */
    const r1 = await recordAndConfirmPayment(admin, { unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 300, currency: 'JMD', date: '2026-07-08', method: 'Bank Transfer' });
    const r2 = await recordAndConfirmPayment(admin, { unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 301, currency: 'JMD', date: '2026-07-09', method: 'Bank Transfer' });
    const rec = (p, reference) => admin.post(`/api/payments/${p.body.payment.id}/reconcile`, { reconciledOn: '2026-07-10', reference });
    T.check('8 a reference is matched to the first receipt', (await rec(r1, 'ABC123')).status === 200);
    for (const lookalike of ['abc123 ', 'ABC 123', 'ABC-123', 'ABC123\u200B', 'ABC123\u200F', '\uFF21\uFF22\uFF23\uFF11\uFF12\uFF13', 'abc/123', 'A.B.C 1-2-3']) {
      const r = await rec(r2, lookalike);
      T.check(`8 the lookalike ${JSON.stringify(lookalike)} is refused as a second line`, r.status === 400 && /already matched/.test(r.body?.error || ''), err(r));
    }
    T.check('8 a genuinely different reference is accepted (positive control)', (await rec(r2, 'ABC124')).status === 200);
    const items = [
      { key: 'a', book: 'corporation', match: { reference: 'ABC123' } },
      { key: 'b', book: 'corporation', match: undefined }
    ];
    T.check('8 itemOnBankLine finds the twin through spaces, hyphens, width and case', ['abc 123', 'ABC-123', '\uFF21\uFF22\uFF23\uFF11\uFF12\uFF13', 'Abc123\u200B'].every(ref => L.itemOnBankLine(items, ref, 'b')?.key === 'a'));
    T.check('8 and finds nothing for a different reference or an empty one', !L.itemOnBankLine(items, 'ABC124', 'b') && !L.itemOnBankLine(items, ' - ', 'b'));

    /* ================================================================ *
     * 9. Refuse instead of silently changing
     * ================================================================ */
    const exp = amount => admin.post('/api/expenses', { category: 'Maintenance', description: 'probe', amount, currency: 'JMD', date: '2026-07-05', vendor: 'V' });
    for (const typed of [100.005, '100.005', '2.675', 0.005, '0.001', '12.345']) {
      const r = await exp(typed);
      T.check(`9 ${JSON.stringify(typed)} (a fraction of a cent) is refused, not rounded`, r.status === 400 && /decimal/.test(r.body?.error || ''), err(r));
    }
    for (const typed of [100.5, '100.50', '100.500', '1,234.56', 100]) {
      T.check(`9 ${JSON.stringify(typed)} is accepted (positive control)`, (await exp(typed)).status === 200);
    }
    T.check('9 0.1 + 0.2 float noise is not mistaken for a third decimal', (await exp(0.1 + 0.2)).status === 200);
    const entit = e => admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', tenantName: 'Tenant', status: 'long-term', currency: 'JMD', maintCurrency: 'JMD', entitlement: e });
    for (const bad of ['0.001', '0x10', '1e3', [5], true, '0', '-3', '1.234']) {
      const r = await entit(bad);
      T.check(`9 entitlement ${JSON.stringify(bad)} is refused`, r.status === 400, err(r));
    }
    T.check('9 entitlement "12.5" is accepted and stored as 12.5 (positive control)', (await entit('12.5')).status === 200 && (await db()).units.find(u => u.id === 'unit-1').entitlement === 12.5);
    const dueDay = d => admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', tenantName: 'Tenant', status: 'long-term', currency: 'JMD', maintCurrency: 'JMD', rentDueDay: d });
    for (const bad of ['0x10', '1e1', [5], true, '5.5']) T.check(`9 due day ${JSON.stringify(bad)} is refused`, (await dueDay(bad)).status === 400);
    T.check('9 due day "15" is accepted (positive control)', (await dueDay('15')).status === 200);
    const longNote = 'n'.repeat(2001);
    const noteOver = await pName('Long Note', { notes: longNote });
    T.check('9 a note over 2000 characters is refused with the field named, not cut', noteOver.status === 400 && /Notes must be 2000/.test(noteOver.body?.error || ''), err(noteOver));
    T.check('9 a note of exactly 2000 is kept whole (positive control)', (await pName('Exact Note', { notes: 'n'.repeat(2000) })).body?.payment?.notes?.length === 2000);
    const refOver = await pName('Long Ref', { reference: 'r'.repeat(121) });
    T.check('9 a reference over 120 is refused with the field named', refOver.status === 400 && /Reference must be 120/.test(refOver.body?.error || ''), err(refOver));
    const bb = await admin.post('/api/settings', { booksBeginOn: '2026-09-01extra' });
    T.check('9 booksBeginOn "2026-09-01extra" is refused, not cut to a date', bb.status === 400, err(bb));
    const bd = await admin.post('/api/settings', { backupDir: 'x'.repeat(401) });
    T.check('9 a backup folder over 400 characters is refused', bd.status === 400, err(bd));

    const rec1 = await admin.post('/api/recurring-expenses', { category: 'Security', vendor: 'Guard Ltd', description: 'Nights', unitNumber: 'General', amount: 96000, currency: 'JMD', paymentMethod: 'Bank Transfer', dueDay: 5 });
    const recId = rec1.body?.template?.id;
    T.check('9 setup: a recurring cost', rec1.status === 200 && !!recId, err(rec1));
    for (const bad of ['true', 'false', 1, 0, 'yes', null]) {
      const r = await admin.put(`/api/recurring-expenses/${recId}`, { active: bad });
      T.check(`9 recurring active ${JSON.stringify(bad)} is refused, not coerced`, r.status === 400, err(r));
    }
    T.check('9 the cost is still active after the refused edits', (await db()).recurringExpenses?.find?.(t => t.id === recId)?.active !== false);
    T.check('9 recurring active false (a real boolean) works (positive control)', (await admin.put(`/api/recurring-expenses/${recId}`, { active: false })).status === 200 && (await db()).recurringExpenses?.find?.(t => t.id === recId)?.active === false);
    for (const bad of ['0x5', '1e0', [3], '2.5', 29]) {
      T.check(`9 recurring due day ${JSON.stringify(bad)} is refused`, (await admin.put(`/api/recurring-expenses/${recId}`, { dueDay: bad })).status === 400);
    }

    const uId = (await db()).users?.find?.(u => u.username === 'pw200')?.id;
    for (const bad of ['false', 'true', 0, 1]) {
      const r = await admin.put(`/api/users/${uId}`, { active: bad });
      T.check(`9 user active ${JSON.stringify(bad)} is refused`, r.status === 400, err(r));
    }
    T.check('9 the user is still active', (await db()).users.find(u => u.id === uId).active === true);
    T.check('9 user active false (a real boolean) works and is honoured (positive control)', (await admin.put(`/api/users/${uId}`, { active: false })).status === 200 && (await db()).users.find(u => u.id === uId).active === false);
    const perms = (await db()).settings.rolePermissions;
    const permKey = Object.keys(perms.JUNIOR_OFFICER).find(k => perms.JUNIOR_OFFICER[k] === false && k !== 'hasVetoPower');
    const strPerm = await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...perms.JUNIOR_OFFICER, [permKey]: 'false' } } });
    T.check('9 a string "false" in the permission matrix is refused (it used to grant the permission)', strPerm.status === 400, err(strPerm));
    T.check('9 and the permission is still off', (await db()).settings.rolePermissions.JUNIOR_OFFICER[permKey] === false);
    T.check('9 the matrix with real booleans saves (positive control)', (await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...perms.JUNIOR_OFFICER } } })).status === 200);

    for (const bad of ['a\nb', { a: 1 }, 'abc', 5, null]) {
      const r = await admin.post('/api/settings', { vendors: bad });
      T.check(`9 vendors ${JSON.stringify(bad)} (not a list) is refused`, r.status === 400, err(r));
    }
    const manyVendors = await admin.post('/api/settings', { vendors: Array.from({ length: 201 }, (_, i) => `Vendor ${i}`) });
    T.check('9 201 vendors are refused, not cut to 200', manyVendors.status === 400, err(manyVendors));
    T.check('9 200 vendors are accepted (positive control)', (await admin.post('/api/settings', { vendors: Array.from({ length: 200 }, (_, i) => `Vendor ${i}`) })).status === 200 && (await db()).settings.vendors.length === 200);
    T.check('9 a vendor name over 120 is refused', (await admin.post('/api/settings', { vendors: ['v'.repeat(121)] })).status === 400);
    for (const bad of ['0x10', '1e2', [157], true, '157.123', '49', '1001']) {
      T.check(`9 exchange rate ${JSON.stringify(bad)} is refused`, (await admin.post('/api/settings', { fxRateJmdPerUsd: bad })).status === 400);
    }
    T.check('9 exchange rate "157.5" is accepted (positive control)', (await admin.post('/api/settings', { fxRateJmdPerUsd: '157.5' })).status === 200 && (await db()).settings.fxRateJmdPerUsd === 157.5);

    const report = body => admin.put('/api/annual-reports/2026', { currency: 'JMD', ...body });
    T.check('9 an annual report with known sections and categories saves (positive control)', (await report({ narrative: { }, budgetByCategory: { Maintenance: 1000 } })).status === 200);
    const badBudget = await report({ budgetByCategory: { Maintanence: 1000 } });
    T.check('9 an unknown budget category is refused, not dropped', badBudget.status === 400 && /Maintanence/.test(badBudget.body?.error || ''), err(badBudget));
    const badNarr = await report({ narrative: { madeUpSection: 'text' } });
    T.check('9 an unknown narrative section is refused, not dropped', badNarr.status === 400 && /madeUpSection/.test(badNarr.body?.error || ''), err(badNarr));
    T.check('9 a budget over-precise to the cent is refused', (await report({ budgetByCategory: { Maintenance: 100.005 } })).status === 400);

    /* ================================================================ *
     * 10. Reasons and notes have a maximum
     * ================================================================ */
    const toReverse = await recordAndConfirmPayment(admin, { unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 222, currency: 'JMD', date: '2026-07-11', method: 'Cash' });
    const revId = toReverse.body.payment.id;
    const rev501 = await admin.post(`/api/payments/${revId}/reverse`, { reversalReason: 'r'.repeat(501) });
    T.check('10 a reversal reason of 501 characters is refused', rev501.status === 400 && /500/.test(rev501.body?.error || ''), err(rev501));
    T.check('10 and the receipt is still standing', (await db()).payments.find(p => p.id === revId).status === 'completed');
    T.check('10 a reversal reason of exactly 500 works (positive control)', (await admin.post(`/api/payments/${revId}/reverse`, { reversalReason: 'r'.repeat(500) })).status === 200);
    const corr = await recordAndConfirmPayment(admin, { unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 223, currency: 'JMD', date: '2026-07-12', method: 'Cash' });
    const putLong = await admin.put(`/api/payments/${corr.body.payment.id}`, { reason: 'x'.repeat(501), notes: 'changed' });
    T.check('10 a payment correction reason over 500 is refused', putLong.status === 400, err(putLong));
    const refundLong = await admin.post(`/api/payments/${corr.body.payment.id}/refund`, { amount: 10, refundedOn: '2026-07-13', method: 'Cash', reason: 'x'.repeat(501) });
    T.check('10 a refund reason over 500 is refused', refundLong.status === 400, err(refundLong));
    const bk = (await admin.post('/api/bookings', stay({ checkIn: '2027-03-10', checkOut: '2027-03-12', guestName: 'Edit Guest' }))).body?.booking;
    const editLong = await admin.put(`/api/bookings/${bk?.id}`, { ...stay({ checkIn: '2027-03-10', checkOut: '2027-03-12', guestName: 'Edit Guest' }), editReason: 'e'.repeat(501) });
    T.check('10 a booking edit reason over 500 is refused', editLong.status === 400, err(editLong));
    const editOk = await admin.put(`/api/bookings/${bk?.id}`, { ...stay({ checkIn: '2027-03-10', checkOut: '2027-03-12', guestName: 'Edit Guest' }), editReason: 'e'.repeat(500) });
    T.check('10 a booking edit reason of 500 works (positive control)', editOk.status === 200, err(editOk));
    const settleLong = await admin.post('/api/bookings', stay({ checkIn: '2027-04-10', checkOut: '2027-04-12', guestName: 'Over Notes', notes: 'n'.repeat(2001) }));
    T.check('10 booking notes over 2000 are refused', settleLong.status === 400, err(settleLong));

    /* ================================================================ *
     * 11. A villa cannot take the name of a property location
     * ================================================================ */
    const label = number => admin.put('/api/units/unit-4', { number, ownerName: 'Owner', status: 'vacant', currency: 'JMD', maintCurrency: 'JMD' });
    for (const bad of ['General', 'general', ' Office ', 'OFFICE', 'Gen eral'.replace(' ', ''), 'Of fice']) {
      const r = await label(bad);
      T.check(`11 the villa label ${JSON.stringify(bad)} is refused`, r.status === 400 && r.body?.code === 'reserved-villa-label', err(r));
    }
    T.check('11 an ordinary label is accepted (positive control)', (await label('Villa 4')).status === 200);
    T.check('11 General Office as a longer label is fine, not a prefix match', (await label('Generals Court')).status === 200);

    /* ================================================================ *
     * 12. Close-the-books month
     * ================================================================ */
    await admin.post('/api/settings', { booksBeginOn: '2026-03-01' });
    const close = through => admin.post('/api/periods/close', { through });
    for (const bad of ['0000-01', ['2026-04'], '2026-4', '2026-13', '1999-12', '2101-01', '2026-02', { a: 1 }, null, 202604]) {
      const r = await close(bad);
      T.check(`12 close through ${JSON.stringify(bad)} is refused`, r.status === 400, err(r));
    }
    T.check('12 nothing was closed by the refused requests', !(await db()).settings.closedThrough, String((await db()).settings.closedThrough));
    const okClose = await close('2026-04');
    T.check('12 a valid month on or after the books-begin month closes (positive control)', okClose.status === 200 && okClose.body?.closedThrough === '2026-04', err(okClose));
    const reopen = await admin.post('/api/periods/reopen', { reason: 'Checking the guard', through: ['2026-03'] });
    T.check('12 reopening to an array month is refused too', reopen.status === 400, err(reopen));
    await admin.post('/api/periods/reopen', { reason: 'Putting it back for the test' });

    /* ================================================================ *
     * Bodies that are not JSON, or too large
     * ================================================================ */
    const raw = (body, headers = { 'Content-Type': 'application/json' }) => fetch(srv.baseUrl + '/api/payments', { method: 'POST', headers: { ...headers, Cookie: admin.getCookie() }, body });
    const malformed = await raw('{"amount": ');
    const malformedBody = await malformed.json().catch(() => null);
    T.check('J malformed JSON gets a 400 with a JSON error, not an HTML page', malformed.status === 400 && /application\/json/.test(malformed.headers.get('content-type') || '') && !!malformedBody?.error, `${malformed.status} ${malformed.headers.get('content-type')}`);
    const huge = await raw(JSON.stringify({ notes: 'x'.repeat(1_100_000) }));
    const hugeBody = await huge.json().catch(() => null);
    T.check('J a body over 1 MB gets a 413 with a JSON error, not an HTML page', huge.status === 413 && /application\/json/.test(huge.headers.get('content-type') || '') && !!hugeBody?.error, `${huge.status} ${huge.headers.get('content-type')}`);
    const okBody = await raw(JSON.stringify({ unitId: 'unit-1', payerName: 'Tenant', category: 'Rent', amount: 17, currency: 'JMD', date: '2026-07-14', method: 'Cash' }));
    T.check('J an ordinary body still works afterwards (positive control)', okBody.status === 200, String(okBody.status));
    const apiSrc = fs.readFileSync(path.join(projectRoot, 'src', 'lib', 'api.ts'), 'utf8');
    T.check('J the client reads the JSON error field and has a message for a 413', /'error' in payload/.test(apiSrc) && /413/.test(apiSrc));

    /* the clients never send what the server now refuses */
    const src = f => fs.readFileSync(path.join(projectRoot, 'src', 'components', f), 'utf8');
    T.check('the refund screen always sends an amount', /onSubmit\(\{ amount: parsed, refundedOn/.test(src('FinanceHub.tsx')));
    T.check('both deposit settle screens always send returnedAmount', /returnedAmount: returning/.test(src('Bookings.tsx')) && /returnedAmount: returnedNum/.test(src('Units.tsx')));
    const annual = src('AnnualReport.tsx');
    T.check('the annual report screen only builds narrative and budget keys from the known sections and categories', /ANNUAL_REPORT_SECTIONS\.map\(section/.test(annual) && /report\.categories\.map\(c =>/.test(annual) && /setNarrative\(section\.key/.test(annual));
  } finally {
    cleanup();
    await srv.stop();
  }
  return T.done();
}
