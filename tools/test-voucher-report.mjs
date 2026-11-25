// Tests for the daily e-voucher report maths (no browser, no database).
import { buildIndividual, buildTeam, eachDay, summariseTeam } from '../src/voucher-report.js';

const checks = [];
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

/* ------------------------------------------------------------------ days */
ok('eachDay includes both ends', eachDay('2026-11-01', '2026-11-05').length === 5,
   String(eachDay('2026-11-01', '2026-11-05').length));
ok('eachDay crosses a month boundary',
   eachDay('2026-11-29', '2026-12-02').join(',') === '2026-11-29,2026-11-30,2026-12-01,2026-12-02',
   eachDay('2026-11-29', '2026-12-02').join(','));
ok('eachDay handles a single day', eachDay('2026-11-05', '2026-11-05').length === 1);
ok('eachDay is empty when reversed', eachDay('2026-11-05', '2026-11-01').length === 0);

/* ------------------------------------------------------------- individual */
const daily = [
  { sales_rep_id: 'r1', sales_rep_name: 'Nawaal', outlet_name: 'A', day: '2026-11-01', amount: 50, vouchers: 5 },
  { sales_rep_id: 'r1', sales_rep_name: 'Nawaal', outlet_name: 'A', day: '2026-11-02', amount: 75, vouchers: 8 },
  { sales_rep_id: 'r1', sales_rep_name: 'Nawaal', outlet_name: 'A', day: '2026-11-04', amount: 60, vouchers: 6 },
  { sales_rep_id: 'r2', sales_rep_name: 'Yacquub', outlet_name: 'A', day: '2026-11-01', amount: 40, vouchers: 4 },
  { sales_rep_id: 'r2', sales_rep_name: 'Yacquub', outlet_name: 'A', day: '2026-11-03', amount: 30, vouchers: 3 },
  // outside the range, must be ignored
  { sales_rep_id: 'r1', sales_rep_name: 'Nawaal', outlet_name: 'A', day: '2026-10-31', amount: 999, vouchers: 99 },
];

const individual = buildIndividual(daily, 'r1', '2026-11-01', '2026-11-05');
ok('individual rows cover every day', individual.rows.length === 5, String(individual.rows.length));
ok('a day without sales shows zero',
   individual.rows.find((r) => r.day === '2026-11-03')?.amount === 0,
   JSON.stringify(individual.rows.find((r) => r.day === '2026-11-03')));
ok('individual total excludes other reps and other months',
   individual.totals.amount === 185, String(individual.totals.amount)); // 50+75+60
ok('individual voucher total', individual.totals.vouchers === 19, String(individual.totals.vouchers));

/* ------------------------------------------------------------------- team */
const team = buildTeam(daily, '2026-11-01', '2026-11-05');
ok('team rows cover every day', team.rows.length === 5, String(team.rows.length));
ok('team day 1 combines both reps', team.rows[0].amount === 90, JSON.stringify(team.rows[0]));
ok('team day 1 voucher count', team.rows[0].vouchers === 9, JSON.stringify(team.rows[0]));
ok('day 1 lists who contributed', team.rows[0].byRep.length === 2, JSON.stringify(team.rows[0].byRep));
ok('contributors are sorted by amount',
   team.rows[0].byRep[0].sales_rep_name === 'Nawaal', JSON.stringify(team.rows[0].byRep));
ok('an empty day has no contributors', team.rows[4].byRep.length === 0, JSON.stringify(team.rows[4]));
ok('team total', team.totals.amount === 255, String(team.totals.amount)); // 185 + 70
ok('team voucher total', team.totals.vouchers === 26, String(team.totals.vouchers));

/* -------------------------------------------------------------- summaries */
const summary = summariseTeam(team, '2026-11-01', '2026-11-05');
ok('summary amount', summary.amount === 255, String(summary.amount));
ok('summary vouchers', summary.vouchers === 26, String(summary.vouchers));
ok('summary counts active reps', summary.activeReps === 2, String(summary.activeReps));
ok('average is per day of the range',
   Math.round(summary.averagePerDay) === 51, String(summary.averagePerDay)); // 255/5
ok('summary reports the day count', summary.days === 5, String(summary.days));

/* --------------------------------------------------------------- edge cases */
const empty = buildTeam([], '2026-11-01', '2026-11-03');
ok('an empty range still yields zero rows with dates', empty.rows.length === 3);
ok('empty totals are zero', empty.totals.amount === 0 && empty.totals.vouchers === 0);

const oneDay = buildIndividual(daily, 'r2', '2026-11-03', '2026-11-03');
ok('a single-day range works', oneDay.rows.length === 1 && oneDay.rows[0].amount === 30,
   JSON.stringify(oneDay.rows));

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} report checks passed`);
process.exit(pass === checks.length ? 0 : 1);
