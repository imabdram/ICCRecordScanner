// Tests the Scan Records filter logic without a browser.
//
//   node tools/test-filters.mjs
//
// The date-range boundary is the point: "to" must include the whole end day,
// and a scan exactly at the start/end of the range must not be dropped.
import { filterScans } from '../src/filters.js';

const rows = [
  { created_at: '2026-11-19T08:30:00Z', sales_rep_id: 'r1', sales_rep_name: 'Hodan Ali',
    outlet_name: 'Customer care Bosaso', customer_name: 'Muse khalid', iccid: '89252637990000001234',
    primary_number: '717738604', secondary_number: '0907738604' },
  { created_at: '2026-11-21T00:00:00Z', sales_rep_id: 'r1', sales_rep_name: 'Hodan Ali',
    outlet_name: 'Customer care Bosaso', customer_name: 'Laylo maxmuud', iccid: '89252637990000005678',
    primary_number: '716441526', secondary_number: '0905441526' },
  { created_at: '2026-11-21T18:24:00Z', sales_rep_id: 'r2', sales_rep_name: 'Ali Abdi',
    outlet_name: 'Galkacyo HQ', customer_name: 'Canab axmed', iccid: '89252637990000009999',
    primary_number: '712345678', secondary_number: '0907657283' },
  { created_at: '2026-11-22T23:30:00Z', sales_rep_id: 'r2', sales_rep_name: 'Ali Abdi',
    outlet_name: 'Galkacyo HQ', customer_name: 'Xasan awbakar', iccid: '89252637990000002222',
    primary_number: '719999999', secondary_number: '0905590849' },
];

const checks = [];
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });
const count = (f) => filterScans(rows, f).length;

ok('no filters returns everything', count({}) === 4, String(count({})));
ok('from excludes earlier days', count({ from: '2026-11-21' }) === 3, String(count({ from: '2026-11-21' })));
ok('to INCLUDES the whole end day',
   count({ to: '2026-11-21' }) === 3,
   `${count({ to: '2026-11-21' })} (the 18:24 row must survive)`);
ok('from + to is inclusive on both ends',
   count({ from: '2026-11-21', to: '2026-11-21' }) === 2,
   String(count({ from: '2026-11-21', to: '2026-11-21' })));
ok('rep filter', count({ rep: 'r2' }) === 2, String(count({ rep: 'r2' })));
ok('outlet filter', count({ outlet: 'Galkacyo HQ' }) === 2, String(count({ outlet: 'Galkacyo HQ' })));
ok('rep + outlet + date combine',
   count({ rep: 'r2', outlet: 'Galkacyo HQ', from: '2026-11-22' }) === 1,
   String(count({ rep: 'r2', outlet: 'Galkacyo HQ', from: '2026-11-22' })));
ok('search matches customer name', count({ query: 'laylo' }) === 1, String(count({ query: 'laylo' })));
ok('search matches a full ICCID', count({ query: '89252637990000009999' }) === 1,
   String(count({ query: '89252637990000009999' })));
ok('short digit searches match numbers too (by design)',
   count({ query: '9999' }) === 2, String(count({ query: '9999' })));
ok('search matches backup number', count({ query: '0907657283' }) === 1, String(count({ query: '0907657283' })));
ok('search is case-insensitive', count({ query: 'GALKACYO' }) === 2, String(count({ query: 'GALKACYO' })));
ok('search + filter combine', count({ query: 'ali', rep: 'r2' }) === 2, String(count({ query: 'ali', rep: 'r2' })));
ok('an impossible range returns nothing', count({ from: '2027-01-01' }) === 0, String(count({ from: '2027-01-01' })));
ok('empty input is safe', filterScans([], {}).length === 0);

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} filter checks passed`);
process.exit(pass === checks.length ? 0 : 1);
