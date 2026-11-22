// Tests the Users & Team filter logic without a browser.
//
//   node tools/test-filters.mjs
//
// Covers both filterScans (Scan Records) and filterUsers (Users & Team).
import { filterScans, filterUsers } from '../src/filters.js';

/* ------------------------------------------------------------------ scans */
const rows = [
  { created_at: '2026-11-19T08:30:00Z', sales_rep_id: 'r1', sales_rep_name: 'Hodan Ali',
    outlet_name: 'Customer care Bosaso', customer_name: 'Muse khalid', iccid: '89252637990000001234',
    primary_number: '0717738604', secondary_number: '0907738604' },
  { created_at: '2026-11-21T00:00:00Z', sales_rep_id: 'r1', sales_rep_name: 'Hodan Ali',
    outlet_name: 'Customer care Bosaso', customer_name: 'Laylo maxmuud', iccid: '89252637990000005678',
    primary_number: '0716441526', secondary_number: '0905441526' },
  { created_at: '2026-11-21T18:24:00Z', sales_rep_id: 'r2', sales_rep_name: 'Ali Abdi',
    outlet_name: 'Galkacyo HQ', customer_name: 'Canab axmed', iccid: '89252637990000009999',
    primary_number: '0712345678', secondary_number: '0907657283' },
  { created_at: '2026-11-22T23:30:00Z', sales_rep_id: 'r2', sales_rep_name: 'Ali Abdi',
    outlet_name: 'Galkacyo HQ', customer_name: 'Xasan awbakar', iccid: '89252637990000002222',
    primary_number: '0719999999', secondary_number: '0905590849' },
];

const checks = [];
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });
const count = (f) => filterScans(rows, f).length;

ok('scans: no filters returns everything', count({}) === 4, String(count({})));
ok('scans: from excludes earlier days', count({ from: '2026-11-21' }) === 3, String(count({ from: '2026-11-21' })));
ok('scans: to INCLUDES the whole end day', count({ to: '2026-11-21' }) === 3,
   `${count({ to: '2026-11-21' })} (the 18:24 row must survive)`);
ok('scans: from + to is inclusive on both ends',
   count({ from: '2026-11-21', to: '2026-11-21' }) === 2,
   String(count({ from: '2026-11-21', to: '2026-11-21' })));
ok('scans: rep filter', count({ rep: 'r2' }) === 2, String(count({ rep: 'r2' })));
ok('scans: outlet filter', count({ outlet: 'Galkacyo HQ' }) === 2, String(count({ outlet: 'Galkacyo HQ' })));
ok('scans: rep + outlet + date combine',
   count({ rep: 'r2', outlet: 'Galkacyo HQ', from: '2026-11-22' }) === 1,
   String(count({ rep: 'r2', outlet: 'Galkacyo HQ', from: '2026-11-22' })));
ok('scans: search matches customer name', count({ query: 'laylo' }) === 1, String(count({ query: 'laylo' })));
ok('scans: search matches a full ICCID', count({ query: '89252637990000009999' }) === 1,
   String(count({ query: '89252637990000009999' })));
ok('scans: short digit searches match numbers too (by design)',
   count({ query: '9999' }) === 2, String(count({ query: '9999' })));
ok('scans: search matches backup number', count({ query: '0907657283' }) === 1, String(count({ query: '0907657283' })));
ok('scans: search is case-insensitive', count({ query: 'GALKACYO' }) === 2, String(count({ query: 'GALKACYO' })));
ok('scans: search + filter combine', count({ query: 'ali', rep: 'r2' }) === 2, String(count({ query: 'ali', rep: 'r2' })));
ok('scans: an impossible range returns nothing', count({ from: '2027-01-01' }) === 0, String(count({ from: '2027-01-01' })));
ok('scans: empty input is safe', filterScans([], {}).length === 0);

/* ------------------------------------------------------------------ users */
const outlets = { o1: 'Customer care Bosaso', o2: 'Galkacyo HQ' };
const outletName = (id) => outlets[id] ?? '—';

const people = [
  { id: 'u1', full_name: 'Yacquub Gelle', username: 'yacquub', role: 'admin', outlet_id: 'o1', active: true },
  { id: 'u2', full_name: 'Abdi Hassan', username: 'abdi', role: 'team_leader', outlet_id: 'o1', active: true },
  { id: 'u3', full_name: 'Hodan Ali', username: 'hodan', role: 'sales_rep', outlet_id: 'o1', active: true },
  { id: 'u4', full_name: 'Maria Abdirashiid', username: 'maria', role: 'sales_rep', outlet_id: 'o2', active: false },
  { id: 'u5', full_name: 'Sahro Khaalid', username: 'sahro', role: 'supervisor', outlet_id: 'o2', active: true },
];

const uCount = (f) => filterUsers(people, { outletName, ...f }).length;

ok('users: no filters returns everything', uCount({}) === 5, String(uCount({})));
ok('users: role filter', uCount({ role: 'sales_rep' }) === 2, String(uCount({ role: 'sales_rep' })));
ok('users: admin only', uCount({ role: 'admin' }) === 1, String(uCount({ role: 'admin' })));
ok('users: active only', uCount({ status: 'active' }) === 4, String(uCount({ status: 'active' })));
ok('users: disabled only', uCount({ status: 'disabled' }) === 1, String(uCount({ status: 'disabled' })));
ok('users: outlet filter', uCount({ outlet: 'o1' }) === 3, String(uCount({ outlet: 'o1' })));
ok('users: search by name', uCount({ query: 'maria' }) === 1, String(uCount({ query: 'maria' })));
ok('users: search by username', uCount({ query: 'sahro' }) === 1, String(uCount({ query: 'sahro' })));
ok('users: search by outlet name', uCount({ query: 'galkacyo' }) === 2, String(uCount({ query: 'galkacyo' })));
ok('users: role + outlet combine', uCount({ role: 'sales_rep', outlet: 'o2' }) === 1,
   String(uCount({ role: 'sales_rep', outlet: 'o2' })));
ok('users: disabled + outlet combine', uCount({ status: 'disabled', outlet: 'o2' }) === 1,
   String(uCount({ status: 'disabled', outlet: 'o2' })));
ok('users: impossible combination is empty', uCount({ role: 'admin', outlet: 'o2' }) === 0,
   String(uCount({ role: 'admin', outlet: 'o2' })));
ok('users: empty input is safe', filterUsers([], { outletName }).length === 0);

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} filter checks passed`);
process.exit(pass === checks.length ? 0 : 1);
