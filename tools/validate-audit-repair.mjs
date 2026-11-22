// Proves schema_v7 repairs a half-created scan_deletions table.
//
//   node validate-audit-repair.mjs ../scripts/schema_v2_greenfield.sql \
//        ../scripts/seed_v2.sql ../scripts/schema_v5_login_only.sql \
//        ../scripts/schema_v7_audit.sql
//
// Simulates the real failure: an earlier run of v7 created the table but not all
// of its columns, so `create table if not exists` skips it and the page dies with
// "column scan_deletions.sales_rep_name does not exist".
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const [schema2, seed, v5, v7] = process.argv.slice(2);
const db = await PGlite.create();

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema if not exists auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    confirmation_token text not null default ''
  );
  create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
`);

for (const f of [schema2, seed, v5]) {
  await db.exec(readFileSync(f, 'utf8'));
}

// A partial table, as if an older/aborted v7 had created only these columns.
await db.exec(`
  create table public.scan_deletions (
    id uuid primary key default gen_random_uuid(),
    iccid text not null,
    deleted_at timestamptz not null default now()
  );
`);
console.log('simulated a partial scan_deletions table');

// Running v7 again must complete the table rather than skip it.
await db.exec(readFileSync(v7, 'utf8'));
console.log('re-ran v7');

const cols = (await db.query(`
  select column_name from information_schema.columns
   where table_schema='public' and table_name='scan_deletions'
`)).rows.map((r) => r.column_name);

const required = [
  'scan_id', 'iccid', 'customer_name', 'primary_number', 'secondary_number',
  'sales_rep_id', 'sales_rep_name', 'outlet_id', 'outlet_name', 'region_id',
  'zone_id', 'scan_created_at', 'deleted_at', 'deleted_by', 'deleted_by_username',
];

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });
for (const c of required) {
  ok(`column ${c} exists`, cols.includes(c), 'missing');
}

// And the trigger still writes a usable row into the repaired table.
const outlet = (await db.query(`select id from public.outlets order by name limit 1`)).rows[0].id;
const authId = (await db.query(`insert into auth.users (email) values ('x@sim.local') returning id`)).rows[0].id;
await db.query(`
  insert into public.users (auth_user_id, username, full_name, role, outlet_id)
  values ($1,'x','X','admin',$2)
`, [authId, outlet]);
await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);

await db.query(`
  insert into public.scans (iccid, customer_name, primary_number, secondary_number)
  values ('89252637990000007777','After repair','712345678','0907657283')
`);

await db.exec('set role authenticated');
await db.query(`delete from public.scans where iccid = '89252637990000007777'`);
await db.exec('reset role');

const row = (await db.query(`select * from public.scan_deletions order by deleted_at desc limit 1`)).rows[0];
ok('a deletion after the repair is recorded', !!row, 'no row');
ok('the repaired row has the rep name column', row && 'sales_rep_name' in row, 'missing');
ok('it records who deleted', row?.deleted_by_username === 'x', String(row?.deleted_by_username));

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} repair checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
