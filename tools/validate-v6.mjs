// Verifies the phone-number rule (v6): primary is 71 + 7 digits, backup is free.
//
//   node validate-v6.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql \
//        ../scripts/schema_v5_login_only.sql ../scripts/schema_v6_numbers.sql
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
`);

for (const file of SCRIPTS) {
  try {
    await db.exec(readFileSync(file, 'utf8'));
    console.log(`OK   ${file.split(/[\\/]/).pop()}`);
  } catch (e) {
    console.log(`FAIL ${file.split(/[\\/]/).pop()}`);
    console.log('  ' + String(e.message || e).split('\n').slice(0, 6).join('\n  '));
    await db.close();
    process.exit(1);
  }
}

const outlet = (await db.query(`select id from public.outlets order by name limit 1`)).rows[0].id;
const authId = (await db.query(`insert into auth.users (email) values ('n@sim.local') returning id`)).rows[0].id;
await db.query(`
  insert into public.users (auth_user_id, username, full_name, role, outlet_id)
  values ($1,'n','N','sales_rep',$2)
`, [authId, outlet]);
await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);

let seq = 0;
async function tryScan(primary, secondary = '615555001') {
  seq += 1;
  try {
    await db.query(`
      insert into public.scans (iccid, customer_name, primary_number, secondary_number)
      values ($1,'X',$2,$3)
    `, [`8925263799000000${String(1000 + seq)}`, primary, secondary]);
    return 'accepted';
  } catch (e) {
    return String(e.message);
  }
}

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

ok('accepts 710000001 (71 + 7 digits)', (await tryScan('710000001')) === 'accepted');
ok('accepts 719999999', (await tryScan('719999999')) === 'accepted');
ok('rejects 720000001 (wrong prefix)', (await tryScan('720000001')) !== 'accepted');
ok('rejects 71000001 (too short)', (await tryScan('71000001')) !== 'accepted');
ok('rejects 7100000001 (too long)', (await tryScan('7100000001')) !== 'accepted');
ok('rejects letters', (await tryScan('71ABCDEFG')) !== 'accepted');
ok('backup stays free-format (7-12 digits)', (await tryScan('710000002', '6155550')) === 'accepted');
ok('backup still rejects a 5-digit number', (await tryScan('710000003', '12345')) !== 'accepted');

console.log('\n' + '='.repeat(58));
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log('='.repeat(58));
console.log(`${pass}/${checks.length} checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
