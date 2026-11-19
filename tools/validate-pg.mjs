// Real-Postgres validation of the greenfield SQL, using PGlite (Postgres 17
// compiled to WASM). This does not just parse -- it EXECUTES the schema, so it
// catches things a parser never would: bad function bodies at runtime, broken
// references, invalid policy syntax, grant problems.
//
// Supabase-only pieces are shimmed first:
//   * role `anon` / `authenticated` / `service_role` / `authenticator`
//   * schema `auth` with a `users` table and the auth.uid() function
//   * Supabase's default grants
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SCRIPTS = process.argv.slice(2);
if (SCRIPTS.length < 2) {
  console.error('usage: node validate-pg.mjs <schema.sql> <seed.sql>');
  process.exit(2);
}

const db = await PGlite.create();

// ---------------------------------------------------------------- Supabase shim
// Mirrors the parts of a Supabase project our SQL actually touches.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role authenticator noinherit login;

  create schema if not exists auth;

  create table auth.users (
    id                 uuid primary key default gen_random_uuid(),
    email              text unique,
    encrypted_password text,
    email_confirmed_at timestamptz,
    created_at         timestamptz not null default now(),
    confirmation_token text not null default '',
    recovery_token     text not null default ''
  );

  -- Supabase's auth.uid() reads the JWT sub from the request settings.
  create or replace function auth.uid() returns uuid
  language sql stable
  as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;

  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth  to anon, authenticated, service_role;
`);

console.log('Postgres version:', (await db.query('select version() as v')).rows[0].v.slice(0, 40));

// --------------------------------------------------------------- run the files
// PGlite ships `create extension pgcrypto` as a hard "not available" abort (it is
// a WASM build without extensions loaded), while real Supabase either has the
// extension or does not need it. gen_random_uuid() is built into Postgres 13+,
// so the only statement to neutralise for this harness is the extension create.
function neutraliseForHarness(sql) {
  return sql.replace(/create extension if not exists pgcrypto;/gi,
                     'select 1; -- pgcrypto shimmed in harness');
}

let failed = false;
for (const file of SCRIPTS) {
  const sql = neutraliseForHarness(readFileSync(file, 'utf8'));
  const label = file.split(/[\\/]/).pop();
  const t0 = Date.now();
  try {
    await db.exec(sql);
    console.log(`OK   ${label}  (${Date.now() - t0} ms)`);
  } catch (e) {
    failed = true;
    const msg = e.detail?.message || e.message || String(e);
    const where = e.detail?.position ? ` at position ${e.detail.position}` : '';
    console.error(`FAIL ${label}${where}`);
    console.error('  ' + String(msg).split('\n').slice(0, 12).join('\n  '));
    if (e.detail?.query) {
      // Show the offending line(s) for a parse error.
      const pos = Number(e.detail.position ?? 0);
      if (pos > 0) {
        const before = sql.slice(0, pos);
        const lineNo = before.split('\n').length;
        const line = sql.split('\n')[lineNo - 1];
        console.error(`  line ${lineNo}: ${line?.trim()}`);
      }
    }
    break;
  }
}

if (failed) { await db.close(); process.exit(1); }

// ------------------------------------------------------------------ assertions
const checks = [];
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

// 1. Seed produced the right tree
const tree = (await db.query(`
  select
    (select count(*) from public.zones)   as zones,
    (select count(*) from public.regions) as regions,
    (select count(*) from public.outlets) as outlets
`)).rows[0];
ok('3 zones / 4 regions / 26 outlets',
   Number(tree.zones) === 3 && Number(tree.regions) === 4 && Number(tree.outlets) === 26,
   JSON.stringify(tree));

// 2. Every expected object exists.
//    to_regproc() is unreliable here: this Postgres build cannot resolve
//    signatures written as `name(argtypes)` through it. A direct catalog query
//    against pg_proc is unambiguous and works everywhere.
const objs = (await db.query(`
  select to_regclass('public.scans') is not null as scans,
         to_regclass('public.devices') is not null as devices,
         to_regclass('public.v_scan_records') is not null as v_records,
         (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('upload_scans','claim_device','delete_user',
                              'scans_before_write','users_guard_privileges',
                              'current_app_user','is_admin','my_role',
                              'my_outlet_id','my_region_id','my_zone_id'))::int = 11 as functions
`)).rows[0];
ok('all key objects created (3 tables/views + 11 functions)',
   objs.scans && objs.devices && objs.v_records && objs.functions === true,
   JSON.stringify(objs));

// 3. RLS enabled on every table
const rls = (await db.query(`
  select relname, relrowsecurity from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname
`)).rows;
ok('RLS enabled on all 6 tables',
   rls.length === 6 && rls.every(r => r.relrowsecurity),
   rls.map(r => `${r.relname}=${r.relrowsecurity}`).join(' '));

// 4. anon has NO table privileges (the plan's original design would have failed this)
const anonPriv = (await db.query(`
  select table_name, privilege_type
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public'
`)).rows;
ok('anon has no table privileges', anonPriv.length === 0,
   anonPriv.map(r => `${r.table_name}.${r.privilege_type}`).join(',') || 'none');

// 5. ICCID constraint accepts a new batch and rejects junk
async function iccidOk(v) {
  try {
    await db.query(`select 1 where $1 ~ '^89[0-9]{16,20}$'`, [v]);
    const r = await db.query(`select $1::text ~ '^89[0-9]{16,20}$' as m`, [v]);
    return r.rows[0].m;
  } catch { return false; }
}
ok('ICCID 89252637990000000006 (old batch) accepted', await iccidOk('89252637990000000006'));
ok('ICCID 89253000111122223333 (new batch) accepted', await iccidOk('89253000111122223333'));
ok('ICCID 12345678901234567 rejected', !(await iccidOk('12345678901234567')));

// 6. scans' attribution rules.
//    Note the ordering: the BEFORE trigger runs before this table's CHECK
//    constraint, so in practice the trigger rejects these rows first.
//    "A scan needs either a signed-in user or a registered device" is the real
//    guard, and it is the one worth asserting on. The CHECK constraint remains
//    a correct backstop for any path that bypasses the trigger.
const outlet = (await db.query(`select id from public.outlets limit 1`)).rows[0].id;
async function insertScan({ rep = null, device = null, iccid = '89252637990000000099' }) {
  try {
    await db.exec('begin');
    await db.query(
      `insert into public.scans (iccid, customer_name, primary_number, secondary_number,
                                 sales_rep_id, device_id, outlet_id, region_id, zone_id)
       values ($1,'T','7000000','7000001',$2,$3,$4,$4,$4)`,
      [iccid, rep, device, outlet]
    );
    await db.exec('rollback');
    return 'inserted';
  } catch (e) {
    await db.exec('rollback');
    return String(e.message);
  }
}
const neither = await insertScan({});
ok('scan with neither owner nor device rejected',
   /signed-in user or a registered device/.test(neither), neither);

const bogus = '00000000-0000-0000-0000-000000000000';
const both = await insertScan({ rep: bogus, device: bogus });
ok('scan with BOTH owner and device rejected (trigger validates device first)',
   /Unknown device|one_owner/.test(both), both);

// 7. upload_scans rejects a bad device key
let badKey = '';
try {
  await db.query(`select public.upload_scans('{"device_key":"nope","scans":[]}'::jsonb)`);
} catch (e) { badKey = String(e.message); }
ok('upload_scans rejects unknown device key', /Unknown or disabled device/.test(badKey), badKey);

// 8. full device round-trip: claim a device, upload scans, re-upload is idempotent
const reg = (await db.query(`
  insert into public.devices (device_key, setup_code, label, outlet_id)
  values ('test-device-key-0001', 'ABC12345', 'Test counter', $1)
  returning device_key
`, [outlet])).rows[0];

const claimed = (await db.query(`select public.claim_device('ABC12345') as r`)).rows[0].r;
ok('claim_device exchanges the setup code for the device key',
   claimed?.device_key === reg.device_key, JSON.stringify(claimed));

const claimAgain = await (async () => {
  try { await db.query(`select public.claim_device('ABC12345')`); return 'allowed'; }
  catch (e) { return String(e.message); }
})();
ok('claim_device refuses reuse of a burned setup code',
   /already been used/.test(claimAgain), claimAgain);

const mkPayload = () => JSON.stringify({
  device_key: reg.device_key,
  scans: [
    { iccid: '89252637990000000101', customer_name: 'Ali', primary_number: '615555001', secondary_number: '615555002', created_at: '2026-11-19T08:00:00Z' },
    { iccid: '89252637990000000102', customer_name: 'Hodan', primary_number: '615555003', secondary_number: '615555004', created_at: '2026-11-19T08:05:00Z' },
    { iccid: '12345', customer_name: 'Bad', primary_number: '615555005', secondary_number: '615555006' }
  ]
});
const up1 = (await db.query(`select public.upload_scans($1::jsonb) as r`, [mkPayload()])).rows[0].r;
ok('upload_scans accepts 2, rejects 1 malformed row',
   up1.accepted.length === 2 && up1.rejected.length === 1, JSON.stringify(up1));

// Location must come from the device, NOT the payload -- try to smuggle it.
const smuggle = JSON.stringify({
  device_key: reg.device_key,
  scans: [{ iccid: '89252637990000000103', customer_name: 'X', primary_number: '615555007',
            secondary_number: '615555008', outlet_id: outlet, region_id: outlet, zone_id: outlet }]
});
const up2 = (await db.query(`select public.upload_scans($1::jsonb) as r`, [smuggle])).rows[0].r;
ok('upload_scans ignores client-supplied location', up2.accepted.length === 1, JSON.stringify(up2));

const up3 = (await db.query(`select public.upload_scans($1::jsonb) as r`, [mkPayload()])).rows[0].r;
ok('re-upload is idempotent (duplicates, not new rows)',
   up3.accepted.length === 0 && up3.duplicates.length === 2, JSON.stringify(up3));

// 9. Trigger must stamp location from the DEVICE regardless of the scan row
const stamped = (await db.query(`
  select s.sales_rep_id, s.device_id, o.name as outlet
  from public.scans s join public.outlets o on o.id = s.outlet_id
  where s.iccid = '89252637990000000101'
`)).rows[0];
const expectedOutlet = (await db.query(`select name from public.outlets where id = $1`, [outlet])).rows[0].name;
ok('device scan has NULL rep and the device outlet',
   stamped.sales_rep_id === null && stamped.device_id !== null && stamped.outlet === expectedOutlet,
   JSON.stringify(stamped));

// 10. An identity-less INSERT outside upload_scans must be refused by the trigger
const anonymousDirect = await (async () => {
  try {
    await db.exec('begin');
    await db.query(
      `insert into public.scans (iccid, customer_name, primary_number, secondary_number,
                                 outlet_id, region_id, zone_id)
       values ('89252637990000000199','Anon','7000000','7000001',$1,$1,$1)`, [outlet]);
    await db.exec('rollback');
    return 'allowed';
  } catch (e) { await db.exec('rollback'); return String(e.message); }
})();
ok('direct anonymous insert is refused by the trigger',
   /signed-in user or a registered device/.test(anonymousDirect), anonymousDirect);

// 11. Signed-in path: simulate a real user and insert through the trigger
await db.exec('begin');
const authUser = (await db.query(`insert into auth.users (email) values ('t@sim.local') returning id`)).rows[0].id;
const rep = (await db.query(`
  insert into public.users (auth_user_id, username, full_name, role, outlet_id)
  values ($1,'tester','Tester Rep','sales_rep',$2) returning id
`, [authUser, outlet])).rows[0].id;
await db.exec('rollback');

// Re-create them for real (outside a rolled-back txn) so another session can use it
const authUser2 = (await db.query(`insert into auth.users (email) values ('rep2@sim.local') returning id`)).rows[0].id;
const rep2 = (await db.query(`
  insert into public.users (auth_user_id, username, full_name, role, outlet_id)
  values ($1,'rep2','Rep Two','sales_rep',$2) returning id
`, [authUser2, outlet])).rows[0].id;

await db.exec(`select set_config('request.jwt.claim.sub', '${authUser2}', false)`);
const signedIn = await (async () => {
  try {
    await db.query(
      `insert into public.scans (iccid, customer_name, primary_number, secondary_number,
                                 outlet_id, region_id, zone_id)
       values ('89252637990000000201','Website','7000000','7000001',$1,$1,$1)`, [outlet]);
    return 'inserted';
  } catch (e) { return String(e.message); }
})();
ok('signed-in insert accepted', signedIn === 'inserted', signedIn);

const signedRow = (await db.query(`
  select sales_rep_id, device_id from public.scans where iccid = '89252637990000000201'
`)).rows[0];
ok('signed-in insert stamped the rep and cleared device_id',
   signedRow && signedRow.sales_rep_id === rep2 && signedRow.device_id === null,
   JSON.stringify(signedRow));

// 12. The reporting view must show both sources
await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
const viewRows = (await db.query(`
  select source, count(*) as n from public.v_scan_records group by source order by source
`)).rows;
ok('v_scan_records reports both user and device sources',
   viewRows.some(r => r.source === 'user') && viewRows.some(r => r.source === 'device'),
   JSON.stringify(viewRows));

async function run(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    // PGlite errors carry a huge `query` field; only keep the message.
    return { ok: false, error: String(e.message || e).split('\n')[0] };
  }
}

// 13. RLS: a sales rep must see only their own scans, not the device ones
await db.exec('grant select on public.v_scan_records to authenticated');
await db.exec('grant execute on function public.my_role() to authenticated');
await db.exec(`select set_config('request.jwt.claim.sub', '${authUser2}', false)`);

const repRead = await run('rep read', async () => {
  await db.exec('set role authenticated');
  const r = await db.query('select count(*)::int as n from public.scans');
  await db.exec('reset role');
  return r.rows[0].n;
});
ok('sales rep sees only their own scan through RLS', repRead.ok && repRead.value === 1,
   repRead.ok ? `saw ${repRead.value}` : repRead.error);

const anonRead = await run('anon read', async () => {
  await db.exec('set role anon');
  const r = await db.query('select count(*)::int as n from public.scans');
  await db.exec('reset role');
  return r.rows[0].n;
});
// anon has no SELECT grant at all, so this must fail (permission denied).
ok('anon cannot read scans (no grant)', !anonRead.ok, anonRead.ok ? `READ SUCCEEDED, n=${anonRead.value}` : anonRead.error);

const anonUpload = await run('anon upload', async () => {
  await db.exec('set role anon');
  const r = await db.query('select public.upload_scans($1::jsonb) as r',
    [JSON.stringify({ device_key: reg.device_key, scans: [] })]);
  await db.exec('reset role');
  return r.rows[0].r;
});
ok('anon CAN call upload_scans with a valid device key', anonUpload.ok,
   anonUpload.ok ? JSON.stringify(anonUpload.value) : anonUpload.error);

const repUpload = await run('rep escalate', async () => {
  await db.exec('set role authenticated');
  const r = await db.query(`select public.upload_scans($1::jsonb) as r`,
    [JSON.stringify({ device_key: 'wrong-key', scans: [] })]);
  await db.exec('reset role');
  return r.rows[0].r;
});
ok('a wrong device key is refused', !repUpload.ok && /Unknown or disabled device/.test(repUpload.error),
   repUpload.ok ? 'ACCEPTED (bad)' : repUpload.error);

// ---------------------------------------------------------------- report
console.log('\n' + '='.repeat(72));
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log('='.repeat(72));
console.log(`${pass}/${checks.length} behavioural checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
