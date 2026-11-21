// Validates the login-only schema (v5): no devices, no anon write path.
//
//   node validate-v5.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql ../scripts/schema_v5_login_only.sql
//
// Deliberately separate from validate-pg.mjs: that suite exercises the device
// and PIN machinery which v5 removes, so running both in one process would
// test things that are supposed to be gone.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SCRIPTS = process.argv.slice(2);
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
  create schema if not exists extensions;
  create or replace function extensions.gen_salt(kind text) returns text language sql as $$ select 's' $$;
  create or replace function extensions.crypt(pw text, salt text) returns text language sql as $$ select 'h:'||pw $$;
`);

let failed = false;
for (const file of SCRIPTS) {
  const label = file.split(/[\\/]/).pop();
  try {
    await db.exec(readFileSync(file, 'utf8'));
    console.log(`OK   ${label}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${label}`);
    console.log('  ' + String(e.message || e).split('\n').slice(0, 8).join('\n  '));
    break;
  }
}
if (failed) { await db.close(); process.exit(1); }

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

// 1. The device model is gone.
const devices = (await db.query(`select to_regclass('public.devices') as t`)).rows[0].t;
ok('devices table is gone', devices === null, String(devices));

const deviceCol = (await db.query(`
  select count(*)::int as n from information_schema.columns
   where table_schema='public' and table_name='scans' and column_name='device_id'
`)).rows[0].n;
ok('scans.device_id is gone', deviceCol === 0, `${deviceCol} found`);

const anonFns = (await db.query(`
  select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname in ('upload_scans','claim_device','device_roster','set_rep_pin')
`)).rows[0].n;
ok('no anonymous entry points remain', anonFns === 0, `${anonFns} found`);

const pinCol = (await db.query(`
  select count(*)::int as n from information_schema.columns
   where table_schema='public' and table_name='users' and column_name='pin_hash'
`)).rows[0].n;
ok('users.pin_hash is gone', pinCol === 0, `${pinCol} found`);

// 2. Anonymous table access is still refused.
const anonRows = (await db.query(`
  select count(*)::int as n from information_schema.role_table_grants
   where grantee='anon' and table_schema='public'
`)).rows[0].n;
ok('anon holds no table privileges', anonRows === 0, `${anonRows} grants`);

// 3. A signed-in user still files scans, and the trigger stamps them.
const outlet = (await db.query(`select id from public.outlets order by name limit 1`)).rows[0].id;
const authId = (await db.query(`insert into auth.users (email) values ('rep@sim.local') returning id`)).rows[0].id;
const rep = (await db.query(`
  insert into public.users (auth_user_id, username, full_name, role, outlet_id)
  values ($1,'rep','Rep','sales_rep',$2) returning id
`, [authId, outlet])).rows[0].id;

await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
const inserted = await (async () => {
  try {
    await db.query(`
      insert into public.scans (iccid, customer_name, primary_number, secondary_number)
      values ('89252637990000000901','Ali','7000001','7000002')
    `);
    return 'inserted';
  } catch (e) { return String(e.message); }
})();
ok('a signed-in user files a scan without naming a rep', inserted === 'inserted', inserted);

const row = (await db.query(`
  select sales_rep_id, outlet_id, region_id, zone_id from public.scans
   where iccid='89252637990000000901'
`)).rows[0];
ok('the scan is attributed to the caller and stamped with their location',
   row && row.sales_rep_id === rep && row.outlet_id === outlet, JSON.stringify(row));

// 4. sales_rep_id is now mandatory.
const nullRep = await (async () => {
  try {
    await db.exec('begin');
    await db.query(`update public.scans set sales_rep_id = null where iccid='89252637990000000901'`);
    await db.exec('rollback');
    return 'allowed';
  } catch (e) { await db.exec('rollback'); return String(e.message); }
})();
ok('a scan cannot have a null rep', /not-null|null value/i.test(nullRep), nullRep);

// 5. The reporting view no longer mentions devices.
const viewCols = (await db.query(`
  select column_name from information_schema.columns
   where table_schema='public' and table_name='v_scan_records'
`)).rows.map((r) => r.column_name);
ok('v_scan_records has no device columns',
   !viewCols.some((c) => c.includes('device')), viewCols.join(','));

const viewRow = (await db.query(`select sales_rep_name, outlet_name from public.v_scan_records limit 1`)).rows[0];
ok('v_scan_records still reports the rep', !!viewRow?.sales_rep_name, JSON.stringify(viewRow));

// 6. An unauthenticated insert is refused outright.
await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
const anonInsert = await (async () => {
  try {
    await db.query(`
      insert into public.scans (iccid, customer_name, primary_number, secondary_number)
      values ('89252637990000000902','X','7000003','7000004')
    `);
    return 'inserted';
  } catch (e) { return String(e.message); }
})();
ok('an unauthenticated insert is refused',
   /signed-in user/i.test(anonInsert), anonInsert);

console.log('\n' + '='.repeat(64));
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log('='.repeat(64));
console.log(`${pass}/${checks.length} checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
