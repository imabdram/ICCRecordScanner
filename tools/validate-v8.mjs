// Verifies the v8 number rules: primary 071xxxxxxx, backup 10 digits starting
// 090, 061 or 63.
//
//   node validate-v8.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql \
//        ../scripts/schema_v5_login_only.sql ../scripts/schema_v8_numbers.sql
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

for (const f of SCRIPTS) {
  try {
    await db.exec(readFileSync(f, 'utf8'));
  } catch (e) {
    console.log(`FAIL ${f}\n  ${String(e.message || e).split('\n')[0]}`);
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
async function tryScan(primary, secondary) {
  seq += 1;
  try {
    await db.query(`
      insert into public.scans (iccid, customer_name, primary_number, secondary_number)
      values ($1,'X',$2,$3)
    `, [`8925263799000000${String(4000 + seq)}`, primary, secondary]);
    return 'accepted';
  } catch (e) {
    return String(e.message);
  }
}

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

// primary
ok('primary 0716736063 accepted', (await tryScan('0716736063', '0905736063')) === 'accepted');
ok('primary 0710000000 accepted', (await tryScan('0710000000', '0905736063')) === 'accepted');
ok('primary 717386043 rejected (old 9-digit form)', (await tryScan('717386043', '0905736063')) !== 'accepted');
ok('primary 0723456789 rejected (wrong prefix)', (await tryScan('0723456789', '0905736063')) !== 'accepted');
ok('primary 071673606 rejected (9 digits)', (await tryScan('071673606', '0905736063')) !== 'accepted');
ok('primary 07167360631 rejected (11 digits)', (await tryScan('07167360631', '0905736063')) !== 'accepted');

// backup
ok('backup 0905736063 accepted', (await tryScan('0716736063', '0905736063')) === 'accepted');
ok('backup 0612345678 accepted', (await tryScan('0716736064', '0612345678')) === 'accepted');
ok('backup 6312345678 accepted', (await tryScan('0716736065', '6312345678')) === 'accepted');
ok('backup 090573606 rejected (9 digits)', (await tryScan('0716736066', '090573606')) !== 'accepted');
ok('backup 061234567 rejected (9 digits)', (await tryScan('0716736067', '061234567')) !== 'accepted');
ok('backup 0912345678 rejected (wrong prefix)', (await tryScan('0716736068', '0912345678')) !== 'accepted');
ok('backup 630000000 rejected (9 digits)', (await tryScan('0716736069', '630000000')) !== 'accepted');

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} number-rule checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
