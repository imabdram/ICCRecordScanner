// SIM cards per rep and per outlet, bucketed in local days.
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
  '../scripts/schema_v16_sim_reports.sql',
]) {
  await db.exec(readFileSync(f, 'utf8'));
}

const outlet = (await db.query(`select id from public.outlets order by name limit 1`)).rows[0].id;

async function mkUser(username, role, outletId) {
  const authId = (await db.query(`insert into auth.users (email) values ($1) returning id`,
    [`${username}@sim.local`])).rows[0].id;
  const id = (await db.query(`
    insert into public.users (auth_user_id, username, full_name, role, outlet_id)
    values ($1,$2,$3,$4,$5) returning id
  `, [authId, username, username, role, outletId])).rows[0].id;
  return { id, authId };
}

const rep = await mkUser('rep', 'sales_rep', outlet);

async function addScan(authId, iccid, when) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
  await db.exec('set role authenticated');
  await db.query(
    `insert into public.scans (iccid, customer_name, primary_number, secondary_number, created_at)
     values ($1, 'x', '0711234567', '0901234567', $2)`,
    [iccid, when],
  );
  await db.exec('reset role');
}

const now = new Date();
const today = now.toISOString();
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 10, 0, 0).toISOString();

await addScan(rep.authId, '89252637990000000001', today);
await addScan(rep.authId, '89252637990000000002', today);
await addScan(rep.authId, '89252637990000000003', lastMonth);

const repRow = (await db.query(`
  select sims_today, sims_month, sims_total, outlet_name, region_name
    from public.v_rep_sim_report where user_id = $1
`, [rep.id])).rows[0];

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

ok('today counts only today', Number(repRow.sims_today) === 2, JSON.stringify(repRow));
ok('month excludes last month', Number(repRow.sims_month) === 2, JSON.stringify(repRow));
ok('total includes everything', Number(repRow.sims_total) === 3, JSON.stringify(repRow));
ok('the rep row carries the outlet', !!repRow.outlet_name, JSON.stringify(repRow));

const outletRow = (await db.query(`
  select sims_today, sims_month, sims_total, reps
    from public.v_outlet_overview where outlet_id = $1
`, [outlet])).rows[0];
ok('outlet sims today', Number(outletRow.sims_today) === 2, JSON.stringify(outletRow));
ok('outlet sims month', Number(outletRow.sims_month) === 2, JSON.stringify(outletRow));
ok('outlet sims total', Number(outletRow.sims_total) === 3, JSON.stringify(outletRow));
ok('outlet still reports its reps', Number(outletRow.reps) >= 1, JSON.stringify(outletRow));

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} SIM report checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
