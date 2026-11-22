// Proves the delete permissions match what the button offers.
//
//   node validate-delete.mjs ../scripts/schema_v2_greenfield.sql \
//        ../scripts/seed_v2.sql ../scripts/schema_v5_login_only.sql
//
// The website hides the button for sales reps, but hiding is not security: this
// checks that Postgres itself refuses them, and that a team leader is limited to
// their own outlet.
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

const outlets = (await db.query(`select id, name from public.outlets order by name`)).rows;
const [outletA, outletB] = outlets;

async function mkUser(username, role, outletId) {
  const authId = (await db.query(`insert into auth.users (email) values ($1) returning id`,
    [`${username}@sim.local`])).rows[0].id;
  const id = (await db.query(`
    insert into public.users (auth_user_id, username, full_name, role, outlet_id)
    values ($1,$2,$3,$4,$5) returning id
  `, [authId, username, username, role, outletId])).rows[0].id;
  return { id, authId };
}

const admin = await mkUser('adm', 'admin', outletA.id);
const supA = await mkUser('supa', 'supervisor', outletA.id);
const leaderA = await mkUser('leada', 'team_leader', outletA.id);
const repA = await mkUser('repa', 'sales_rep', outletA.id);
const repB = await mkUser('repb', 'sales_rep', outletB.id);

let seq = 0;
async function makeScan(authId) {
  seq += 1;
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
  const iccid = `8925263799000000${String(2000 + seq)}`;
  await db.query(`
    insert into public.scans (iccid, customer_name, primary_number, secondary_number)
    values ($1,'X','712345678','0907657283')
  `, [iccid]);
  return (await db.query(`select id from public.scans where iccid=$1`, [iccid])).rows[0].id;
}

/** Deletes as a role; returns the number of rows actually removed. */
async function tryDelete(authId, scanId) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
  try {
    await db.exec('set role authenticated');
    const res = await db.query(`delete from public.scans where id = $1 returning id`, [scanId]);
    await db.exec('reset role');
    return res.rows.length;
  } catch (e) {
    await db.exec('reset role');
    return `error: ${String(e.message).split('\n')[0]}`;
  } finally {
    await db.exec('reset role');
  }
}

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

// A sales rep cannot delete their own scan.
let scan = await makeScan(repA.authId);
ok('sales rep CANNOT delete their own scan', (await tryDelete(repA.authId, scan)) === 0, 'deleted');

// A team leader can delete a scan in their outlet.
scan = await makeScan(repA.authId);
ok('team leader CAN delete a scan in their outlet', (await tryDelete(leaderA.authId, scan)) === 1, 'not deleted');

// A team leader cannot delete a scan from another outlet.
scan = await makeScan(repB.authId);
ok('team leader CANNOT delete outside their outlet', (await tryDelete(leaderA.authId, scan)) === 0, 'deleted');

// A supervisor can delete within their zone.
scan = await makeScan(repA.authId);
ok('supervisor CAN delete a scan in their zone', (await tryDelete(supA.authId, scan)) === 1, 'not deleted');

// An admin can delete anything.
scan = await makeScan(repB.authId);
ok('admin CAN delete any scan', (await tryDelete(admin.authId, scan)) === 1, 'not deleted');

// Sanity: the rows above that were refused still exist.
const left = (await db.query(`select count(*)::int as n from public.scans`)).rows[0].n;
ok('refused deletes left the rows in place', left === 2, `${left} rows remain (expected 2)`);

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} delete-permission checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
