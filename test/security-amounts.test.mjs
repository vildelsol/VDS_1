/** Hostile figures (NaN, Infinity, 1e308, negatives, strings, objects) against every route that takes an amount. */
import { reporter, localToday } from './harness.mjs';
import { boot } from './security-kit.mjs';

export const title = 'Security: hostile amounts across every money-taking route';
export const allowUnknownRoutes = true;

const HOSTILE = ['NaN', 'Infinity', '-Infinity', 1e308, '1e309', -1, -0.01, 0, 0.001, 1e9 + 1, '1e3', '0x10', [5], { a: 1 }, true, '９９', '1,2,3', ' ', '9'.repeat(400)];
const finite = v => typeof v !== 'number' || Number.isFinite(v);

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const env = await boot(port, projectRoot);
  const { admin } = env;
  const today = localToday();
  try {
    await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'T', rentDueDay: 1, maintDueDay: 1 });
    await admin.put('/api/units/unit-2', { number: '2', ownerName: 'O2', status: 'short-term', monthlyMaintenance: 5000, currency: 'USD', maintCurrency: 'USD' });
    let bk = 0;
    const routes = {
      'POST /api/charges (amount)': a => admin.post('/api/charges', { unitId: 'unit-1', category: 'Maintenance', oneOffType: 'Late fee', amount: a, dueDate: today, description: 'x' }),
      'POST /api/expenses (amount)': a => admin.post('/api/expenses', { unitId: 'unit-1', category: 'Other', vendor: 'V', amount: a, currency: 'JMD', date: today, status: 'pending', fund: 'strata' }),
      'POST /api/utilities (amountCharged)': a => admin.post('/api/utilities', { unitId: 'unit-1', billingPeriod: `20${10 + Math.floor(Math.random() * 80)}-0${1 + Math.floor(Math.random() * 9)}`, previousReading: 0, currentReading: 10, amountCharged: a, currency: 'JMD' }),
      'POST /api/utilities (currentReading)': a => admin.post('/api/utilities', { unitId: 'unit-1', billingPeriod: `20${10 + Math.floor(Math.random() * 80)}-1${Math.floor(Math.random() * 3)}`, previousReading: 0, currentReading: a, amountCharged: 10, currency: 'JMD' }),
      'POST /api/bookings (amount)': a => { const y = 2040 + bk++; return admin.post('/api/bookings', { unitId: 'unit-2', guestName: 'G', checkIn: `${y}-01-01`, checkOut: `${y}-01-03`, amount: a, currency: 'USD' }); },
      'PUT /api/units/:id (monthlyRent)': a => admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: a, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'T', rentDueDay: 1, maintDueDay: 1 }),
      'POST /api/tenancies/:id/deposit (amount)': a => admin.post('/api/tenancies/no-such/deposit', { amount: a })
    };
    for (const [name, call] of Object.entries(routes)) {
      const bad5xx = [], stored = [];
      for (const v of HOSTILE) {
        const r = await call(v);
        if (r.status >= 500) bad5xx.push(`${JSON.stringify(v).slice(0, 20)}->${r.status}`);
        else if (r.status === 200) stored.push(v);
      }
      T.check(`${name}: no hostile figure causes a 5xx`, bad5xx.length === 0, bad5xx.join('; '));
      console.log(`  info ${name}: accepted (200) values: ${JSON.stringify(stored).slice(0, 200)}`);
    }
    // Look at what actually got stored
    const d = (await admin.get('/api/db')).body;
    const nums = [...d.charges.map(c => c.amount), ...d.expenses.map(e => e.amount), ...d.utilities.flatMap(u => [u.amountCharged, u.currentReading, u.consumption]), ...d.bookings.map(b => b.amount), ...d.units.flatMap(u => [u.monthlyRent, u.monthlyMaintenance])];
    T.check('every stored figure is a finite number', nums.every(n => n === undefined || n === null || finite(n)), JSON.stringify(nums.filter(n => !finite(n))));
    T.check('no stored money figure exceeds 1,000,000,000', d.charges.every(c => c.amount <= 1e9) && d.expenses.every(e => Math.abs(e.amount) <= 1e9) && d.utilities.every(u => u.amountCharged <= 1e9) && d.bookings.every(b => b.amount <= 1e9) && d.units.every(u => (u.monthlyRent || 0) <= 1e9), '');
    T.check('no stored meter reading is absurd (> 1e12) (readings are not range-checked)', d.utilities.every(u => u.currentReading <= 1e12 && u.previousReading <= 1e12), JSON.stringify(d.utilities.map(u => u.currentReading).filter(n => n > 1e12)));
    T.check('stored charges/expenses/utilities amounts are whole cents', nums.every(n => n === undefined || n === null || Math.round(n * 100) / 100 === n), JSON.stringify(nums.filter(n => Math.round(n * 100) / 100 !== n)));
    T.check('no negative stored charge/utility/booking amount', d.charges.every(c => c.amount >= 0) && d.utilities.every(u => u.amountCharged >= 0) && d.bookings.every(b => b.amount >= 0));
    const rep = (await admin.get('/api/integrity')).body;
    T.check('the integrity report finds no serious contradiction after the abuse', (rep.serious || 0) === 0, JSON.stringify((rep.findings || []).filter(f => f.severity === 'serious').map(f => f.code)));
  } finally {
    await env.stop();
  }
  return T.done();
}
