// Regional management: a supervisor may place people anywhere in his region and
// nowhere else, and every change is audited.
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
  '../scripts/schema_v11_supervisor_region.sql',
  '../scripts/schema_v12_region_scope.sql',
  '../scripts/schema_v13_user_region.sql',
  '../scripts/schema_v15_region_management.sql',
]) {
  await db.exec(readFileSync(f, 'utf8'));
}

const rows = (await db.query(`
  select o.id, o.region_id, r.name as region
    from public.outlets o join public.regions r on r.id = o.region_id
   order by r.name, o.name
`)).rows;
const inRegion = rows.filter((r) => r.region_id === rows[0].region_id);
const outside = rows.find((r) => r.region_id !== rows[0].region_id);

async function mkUser(username, role, { outletId = null, regionId = null } = {}) {
  const authId = (await db.query(`insert into auth.users (email) values ($1) returning id`,
    [`${username}@sim.local`])).rows[0].id;
  const id = (await db.query(`
    insert into public.users (auth_user_id, username, full_name, role, outlet_id, region_id)
    values ($1,$2,$3,$4,$5,$6) returning id
  `, [authId, username, username, role, outletId, regionId])).rows[0].id;
  return { id, authId };
}

const sup = await mkUser('bari', 'supervisor', { regionId: rows[0].region_id });
const rep = await mkUser('rep', 'sales_rep', { outletId: inRegion[0].id });
const leader = await mkUser('lead', 'team_leader', { outletId: inRegion[0].id });

async function as(authId, fn) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

// 1. Transfer within the region is allowed.
let result = await as(sup.authId, async () => {
  try {
    await db.query(`update public.users set outlet_id = $1, team_leader_id = $2 where id = $3`,
      [inRegion[inRegion.length - 1].id, leader.id, rep.id]);
    return 'ok';
  } catch (e) { return String(e.message); }
});
ok('supervisor transfers a rep to another outlet in his region', result === 'ok', result);

const moved = (await db.query(`select outlet_id, region_id from public.users where id = $1`, [rep.id])).rows[0];
ok('the transfer updates the outlet', moved.outlet_id === inRegion[inRegion.length - 1].id, JSON.stringify(moved));
ok('the transfer updates the region automatically', moved.region_id === rows[0].region_id, JSON.stringify(moved));

ok('assignment to a team leader is saved',
   (await db.query(`select team_leader_id from public.users where id = $1`, [rep.id])).rows[0].team_leader_id === leader.id);

// 2. Transfer to another region is refused.
result = await as(sup.authId, async () => {
  try {
    await db.query(`update public.users set outlet_id = $1 where id = $2`, [outside.id, rep.id]);
    return 'allowed';
  } catch (e) { return String(e.message); }
});
ok('supervisor CANNOT transfer a rep to another region', result !== 'allowed', result);

// 3. Supervisor cannot change his own region.
result = await as(sup.authId, async () => {
  try {
    await db.query(`update public.users set region_id = $1 where id = $2`, [outside.region_id, sup.id]);
    return 'allowed';
  } catch (e) { return String(e.message); }
});
const selfRegion = (await db.query(
  'select region_id from public.users where id = $1', [sup.id],
)).rows[0];
ok('supervisor CANNOT change his own region',
   selfRegion.region_id === rows[0].region_id, JSON.stringify({ result, selfRegion }));

// 4. A team leader is confined to their outlet.
result = await as(leader.authId, async () => {
  try {
    await db.query(`update public.users set outlet_id = $1 where id = $2`, [inRegion[inRegion.length - 1].id, rep.id]);
    return 'allowed';
  } catch (e) { return String(e.message); }
});
// RLS hides the row, so the UPDATE affects nothing rather than raising. What
// matters is the data: the rep must still be in his old outlet.
const afterLeader = (await db.query(
  'select outlet_id from public.users where id = $1', [rep.id],
)).rows[0];
ok('team leader CANNOT move a rep to another outlet',
   afterLeader.outlet_id === inRegion[inRegion.length - 1].id, JSON.stringify({ result, afterLeader }));

// 5. Audit rows exist for create + transfer.
const audit = (await db.query(`select action, count(*)::int as n from public.user_audit group by action`)).rows;
const actions = Object.fromEntries(audit.map((r) => [r.action, r.n]));
ok('a creation is audited', (actions.created ?? 0) >= 3, JSON.stringify(actions));
ok('a transfer is audited', (actions.transferred ?? 0) >= 1, JSON.stringify(actions));

// 6. Outlet overview returns the region's outlets.
const overview = (await db.query(`select count(*)::int as n from public.v_outlet_overview`)).rows[0].n;
ok('the outlet overview lists the outlets', overview === rows.length, String(overview));

// 7. An admin can do what the supervisor cannot.
const admin = await mkUser('adm', 'admin', { outletId: inRegion[0].id });
result = await as(admin.authId, async () => {
  try {
    await db.query(`update public.users set outlet_id = $1 where id = $2`, [outside.id, rep.id]);
    return 'ok';
  } catch (e) { return String(e.message); }
});
ok('an admin CAN transfer across regions', result === 'ok', result);

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} regional management checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
