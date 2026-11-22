// Proves only an admin can create or promote to admin/supervisor.
//
//   node validate-v9.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql \
//        ../scripts/schema_v5_login_only.sql ../scripts/schema_v9_role_guard.sql
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

const outlets = (await db.query(`select id from public.outlets order by name`)).rows;
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
const sup = await mkUser('sup', 'supervisor', outletA.id);
const leader = await mkUser('lead', 'team_leader', outletA.id);

/** Tries to insert a user as `caller`, returns 'created' or the error text. */
async function createAs(callerAuthId, username, role, outletId) {
  const authId = (await db.query(`insert into auth.users (email) values ($1) returning id`,
    [`${username}@sim.local`])).rows[0].id;
  await db.exec(`select set_config('request.jwt.claim.sub', '${callerAuthId}', false)`);
  await db.exec('set role authenticated');
  try {
    await db.query(`
      insert into public.users (auth_user_id, username, full_name, role, outlet_id)
      values ($1,$2,$3,$4,$5)
    `, [authId, username, username, role, outletId]);
    await db.exec('reset role');
    return 'created';
  } catch (e) {
    await db.exec('reset role');
    return String(e.message);
  } finally {
    await db.exec('reset role');
  }
}

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

ok('admin CAN create an admin',
   (await createAs(admin.authId, 'adm2', 'admin', outletA.id)) === 'created');
ok('admin CAN create a supervisor',
   (await createAs(admin.authId, 'sup2', 'supervisor', outletA.id)) === 'created');

ok('supervisor CANNOT create an admin',
   (await createAs(sup.authId, 'adm3', 'admin', outletA.id)) !== 'created');
ok('supervisor CANNOT create a supervisor',
   (await createAs(sup.authId, 'sup3', 'supervisor', outletA.id)) !== 'created');
ok('supervisor CAN create a sales rep',
   (await createAs(sup.authId, 'rep1', 'sales_rep', outletA.id)) === 'created');
ok('supervisor CAN create a team leader',
   (await createAs(sup.authId, 'tl1', 'team_leader', outletA.id)) === 'created');

ok('team leader CANNOT create an admin',
   (await createAs(leader.authId, 'adm4', 'admin', outletA.id)) !== 'created');
ok('team leader CANNOT create a supervisor',
   (await createAs(leader.authId, 'sup4', 'supervisor', outletA.id)) !== 'created');

// Promotion is the same hole as creation: a supervisor editing a rep's row.
async function promoteAs(callerAuthId, targetId) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${callerAuthId}', false)`);
  await db.exec('set role authenticated');
  try {
    await db.query(`update public.users set role = 'admin' where id = $1`, [targetId]);
    await db.exec('reset role');
    return 'promoted';
  } catch (e) {
    await db.exec('reset role');
    return String(e.message);
  } finally {
    await db.exec('reset role');
  }
}

const rep = (await db.query(`select id from public.users where username='rep1'`)).rows[0].id;
ok('supervisor CANNOT promote a rep to admin', (await promoteAs(sup.authId, rep)) !== 'promoted');
ok('admin CAN promote a rep to supervisor', (await promoteAs(admin.authId, rep)) === 'promoted');

// And the zone boundary still holds: a supervisor cannot touch another zone.
// The seed data puts every outlet in Zone 2, so a genuinely foreign outlet has
// to be created for this check to mean anything.
const z9 = (await db.query(`insert into public.zones (name) values ('Zone 9') returning id`)).rows[0].id;
const r9 = (await db.query(`insert into public.regions (name, zone_id) values ('Far Region', $1) returning id`, [z9])).rows[0].id;
const o9 = (await db.query(`insert into public.outlets (name, region_id) values ('Far Outlet', $1) returning id`, [r9])).rows[0].id;
ok('supervisor CANNOT create outside their zone',
   (await createAs(sup.authId, 'repz', 'sales_rep', o9)) !== 'created');

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} role-guard checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
