// Proves the reporting views put a voucher on the local day, not the UTC day.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = await PGlite.create();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, confirmation_token text not null default '');
  create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
`);

for (const f of [
  '../scripts/schema_v2_greenfield.sql',
  '../scripts/seed_v2.sql',
  '../scripts/schema_v5_login_only.sql',
  '../scripts/schema_v10_vouchers.sql',
  '../scripts/schema_v14_voucher_reports.sql',
]) {
  await db.exec(readFileSync(f, 'utf8'));
}

const outlet = (await db.query(`select id from public.outlets order by name limit 1`)).rows[0].id;
const authId = (await db.query(`insert into auth.users (email) values ('rep@sim.local') returning id`)).rows[0].id;
const rep = (await db.query(`
  insert into public.users (auth_user_id, username, full_name, role, outlet_id)
  values ($1,'rep','Test Rep','sales_rep',$2) returning id
`, [authId, outlet])).rows[0].id;

// 01:30 local on 25 Nov = 22:30 UTC on 24 Nov. Must count on the 25th.
// The vouchers trigger stamps the reporter from the session, so sign in first.
await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
await db.exec('set role authenticated');
await db.query(`
  insert into public.vouchers (message_id, sales_rep_id, outlet_id, region_id, zone_id, amount, received_at)
  select 'm1', $1, o.id, o.region_id, r.zone_id, 6.00, timestamptz '2026-11-24 22:30:00+00'
  from public.outlets o join public.regions r on r.id = o.region_id where o.id = $2
`, [rep, outlet]);
await db.exec('reset role');

const rows = (await db.query(`
  select day::text as day, amount::float as amount, vouchers
    from public.v_voucher_daily_local where sales_rep_id = $1
`, [rep])).rows;

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

ok('a 01:30 local voucher lands on the local day (25 Nov)', rows[0]?.day === '2026-11-25',
   JSON.stringify(rows));
ok('the amount is kept', rows[0]?.amount === 6, JSON.stringify(rows));

const totals = (await db.query(`
  select amount::float as amount, vouchers, active_days
    from public.v_voucher_range_totals where sales_rep_id = $1
`, [rep])).rows[0];
ok('range totals aggregate the rep', totals?.amount === 6 && totals?.vouchers === 1, JSON.stringify(totals));
ok('active days counted', totals?.active_days === 1, JSON.stringify(totals));

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} timezone checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
