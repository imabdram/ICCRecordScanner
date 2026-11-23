// A region supervisor must see every outlet in their region, and nothing outside.
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
]) {
  await db.exec(readFileSync(f, 'utf8'));
}

// Two outlets in the SAME region, one in another region.
const rows = (await db.query(`
  select o.id, o.region_id, r.name as region
    from public.outlets o join public.regions r on r.id = o.region_id
   order by r.name, o.name
`)).rows;
const sameRegion = rows.filter((r) => r.region_id === rows[0].region_id);
const other = rows.find((r) => r.region_id !== rows[0].region_id);

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
const repA = await mkUser('repa', 'sales_rep', { outletId: sameRegion[0].id });
const repB = await mkUser('repb', 'sales_rep', { outletId: sameRegion[1]?.id ?? sameRegion[0].id });
const repC = await mkUser('repc', 'sales_rep', { outletId: other.id });

async function addScan(rep, iccid) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${rep.authId}', false)`);
  await db.exec('set role authenticated');
  await db.query(`insert into public.scans (iccid, customer_name, primary_number, secondary_number)
                  values ($1, 'x', '0711234567', '0901234567')`, [iccid]);
  await db.exec('reset role');
}

await addScan(repA, '89252637990000000001');
await addScan(repB, '89252637990000000002');
await addScan(repC, '89252637990000000003');

async function visible(authId) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
  await db.exec('set role authenticated');
  try {
    return (await db.query(`select count(*)::int as n from public.scans`)).rows[0].n;
  } finally {
    await db.exec('reset role');
  }
}

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

ok('supervisor sees both outlets in their region', (await visible(sup.authId)) === 2,
   `saw ${await visible(sup.authId)}`);
ok('supervisor does not see another region', (await visible(sup.authId)) !== 3);

// Region name must be readable: the UI shows it.
await db.exec(`select set_config('request.jwt.claim.sub', '${sup.authId}', false)`);
await db.exec('set role authenticated');
const regionRows = (await db.query(`select count(*)::int as n from public.regions`)).rows[0].n;
await db.exec('reset role');
ok('supervisor can read their region row', regionRows >= 1, `saw ${regionRows}`);

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} region-scope checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
