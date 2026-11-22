// Proves the deletion audit trail works and is scoped correctly.
//
//   node validate-audit.mjs ../scripts/schema_v2_greenfield.sql \
//        ../scripts/seed_v2.sql ../scripts/schema_v5_login_only.sql \
//        ../scripts/schema_v6_numbers.sql ../scripts/schema_v7_audit.sql
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
const leaderA = await mkUser('leada', 'team_leader', outletA.id);
const repA = await mkUser('repa', 'sales_rep', outletA.id);
const repB = await mkUser('repb', 'sales_rep', outletB.id);
const supA = await mkUser('supa', 'supervisor', outletA.id);

let seq = 0;
async function makeScan(authId) {
  seq += 1;
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
  const iccid = `8925263799000000${String(3000 + seq)}`;
  await db.query(`
    insert into public.scans (iccid, customer_name, primary_number, secondary_number)
    values ($1,'Muse khalid','712345678','0907657283')
  `, [iccid]);
  return (await db.query(`select id from public.scans where iccid=$1`, [iccid])).rows[0].id;
}

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

// ---- the trail is written --------------------------------------------------
let scanId = await makeScan(repA.authId);
await as(leaderA.authId, () =>
  db.query(`delete from public.scans where id = $1`, [scanId]));

const audit = (await db.query(`select * from public.scan_deletions`)).rows;
ok('a deletion writes exactly one audit row', audit.length === 1, `${audit.length} rows`);

const a = audit[0];
ok('the snapshot keeps the ICCID and customer',
   a.iccid === '89252637990000001234'.length ? true : (a.iccid?.startsWith('8925') && a.customer_name === 'Muse khalid'),
   JSON.stringify({ iccid: a.iccid, name: a.customer_name }));
ok('the numbers are kept', a.primary_number === '712345678' && a.secondary_number === '0907657283',
   JSON.stringify({ p: a.primary_number, s: a.secondary_number }));
ok('who deleted it is recorded', a.deleted_by_username === 'leada', String(a.deleted_by_username));
ok('the rep and outlet names are resolved',
   a.sales_rep_name === 'repa' && !!a.outlet_name, JSON.stringify({ rep: a.sales_rep_name, outlet: a.outlet_name }));
ok('deleted_at is set', !!a.deleted_at, String(a.deleted_at));
ok('the original creation time is kept', !!a.scan_created_at, String(a.scan_created_at));

// ---- the scan itself is gone ----------------------------------------------
const gone = (await db.query(`select count(*)::int as n from public.scans where iccid=$1`, [a.iccid])).rows[0].n;
ok('the scan row itself is gone', gone === 0, `${gone} left`);

// ---- read scoping ----------------------------------------------------------
const readAs = (authId) => as(authId, async () =>
  (await db.query(`select count(*)::int as n from public.scan_deletions`)).rows[0].n);

ok('admin sees the audit row', (await readAs(admin.authId)) === 1, 'blocked');
ok('the outlet team leader sees it', (await readAs(leaderA.authId)) === 1, 'blocked');
ok('the supervisor sees it', (await readAs(supA.authId)) === 1, 'blocked');
ok('a sales rep sees nothing', (await readAs(repA.authId)) === 0, 'VISIBLE (bad)');

// A leader from another outlet must not see it either.
const leaderB = await mkUser('leadb', 'team_leader', outletB.id);
const before = (await readAs(admin.authId));
ok('another outlet leader sees nothing', (await readAs(leaderB.authId)) === 0, 'VISIBLE (bad)');
ok('the admin count is still right', before === 1, String(before));

// ---- append-only -----------------------------------------------------------
const tamper = await as(admin.authId, async () => {
  try {
    await db.query(`update public.scan_deletions set deleted_by_username = 'someone else'`);
    return 'updated';
  } catch (e) {
    return String(e.message);
  }
});
ok('nobody can edit the trail', tamper !== 'updated', tamper);

const wipe = await as(admin.authId, async () => {
  try {
    await db.query(`delete from public.scan_deletions`);
    return 'deleted';
  } catch (e) {
    return String(e.message);
  }
});
ok('nobody can delete the trail', wipe !== 'deleted', wipe);

// ---- a rep deleting is refused, and writes nothing -------------------------
scanId = await makeScan(repA.authId);
await as(repA.authId, () => db.query(`delete from public.scans where id = $1`, [scanId]));
const after = (await db.query(`select count(*)::int as n from public.scan_deletions`)).rows[0].n;
ok('a refused delete writes no audit row', after === 1, `${after} rows`);

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} audit checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
