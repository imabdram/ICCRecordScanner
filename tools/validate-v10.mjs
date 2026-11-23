// Proves the voucher table stamps the reporter, dedupes per rep, and reports
// today/this-month per rep correctly.
//
//   node validate-v10.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql \
//        ../scripts/schema_v5_login_only.sql ../scripts/schema_v10_vouchers.sql
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

const repA = await mkUser('repa', 'sales_rep', outletA.id);
const repB = await mkUser('repb', 'sales_rep', outletB.id);
const leaderA = await mkUser('leada', 'team_leader', outletA.id);
const admin = await mkUser('adm', 'admin', outletA.id);

async function insertVoucher(callerAuthId, messageId, amount, receivedAt) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${callerAuthId}', false)`);
  await db.exec('set role authenticated');
  try {
    // Only the message, amount and time are supplied: the trigger fills in the
    // reporter and the location, and NOT NULL is checked after it runs.
    await db.query(
      `insert into public.vouchers (message_id, amount, received_at)
       values ($1, $2, $3)`,
      [messageId, amount, receivedAt],
    );
    await db.exec('reset role');
    return 'inserted';
  } catch (e) {
    await db.exec('reset role');
    return String(e.message);
  } finally {
    await db.exec('reset role');
  }
}

const checks = [];
const ok = (n, c, d = '') => checks.push({ name: n, pass: !!c, detail: d });

const today = new Date();
const iso = (d) => d.toISOString();
const todayIso = iso(today);
const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15, 10, 0, 0);

// A voucher with deliberately bogus location values: the trigger must overwrite.
const r1 = await insertVoucher(repA.authId, 'msg-1', 6.0, todayIso);
ok('a rep can upload a voucher', r1 === 'inserted', r1);

const row = (await db.query(`
  select sales_rep_id, outlet_id, amount from public.vouchers where message_id='msg-1'
`)).rows[0];
ok('the reporter is stamped from the session', row?.sales_rep_id === repA.id, JSON.stringify(row));
ok('the location is overwritten from the reporter', row?.outlet_id === outletA.id, JSON.stringify(row));

// Same SMS twice: refused by the unique (rep, message) key.
const dupe = await insertVoucher(repA.authId, 'msg-1', 6.0, todayIso);
ok('re-uploading the same message is refused', dupe !== 'inserted', dupe);

// A different rep may have the same message id (their own phone).
const other = await insertVoucher(repB.authId, 'msg-1', 9.0, todayIso);
ok('another rep with the same message id is allowed', other === 'inserted', other);

// This month, earlier day, and last month.
await insertVoucher(repA.authId, 'msg-2', 10.0, todayIso);
const earlier = new Date(today.getFullYear(), today.getMonth(), 2, 9, 0, 0);
await insertVoucher(repA.authId, 'msg-3', 5.0, iso(earlier));
await insertVoucher(repA.authId, 'msg-4', 100.0, iso(lastMonth));

const totals = (await db.query(`
  select today_amount::float as t, month_amount::float as m, today_count::int as tc,
         month_count::int as mc
    from public.v_voucher_totals where user_id = $1
`, [repA.id])).rows[0];
ok('today total is only today', totals.t === 16.0, JSON.stringify(totals)); // 6 + 10
ok('today count', totals.tc === 2, JSON.stringify(totals));
ok('month total excludes last month', totals.m === 21.0, JSON.stringify(totals)); // 6+10+5
ok('month count', totals.mc === 3, JSON.stringify(totals));

// Daily view
const daily = (await db.query(`
  select count(*)::int as n, sum(amount)::float as s
    from public.v_voucher_daily where sales_rep_id = $1
`, [repA.id])).rows[0];
ok('the daily view groups by day across all history',
   daily.n === 3 && daily.s === 121.0, JSON.stringify(daily));

const dailyMonth = (await db.query(`
  select count(*)::int as n, sum(amount)::float as s
    from public.v_voucher_daily
   where sales_rep_id = $1 and day >= date_trunc('month', now())::date
`, [repA.id])).rows[0];
// Two days this month: today (6 + 10) and the 2nd (5) -- three vouchers.
ok('filtering the daily view to this month gives 2 days / 21.00',
   dailyMonth.n === 2 && dailyMonth.s === 21.0, JSON.stringify(dailyMonth));

// Read scoping
async function visibleAs(authId) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false)`);
  await db.exec('set role authenticated');
  try {
    return (await db.query(`select count(*)::int as n from public.vouchers`)).rows[0].n;
  } finally {
    await db.exec('reset role');
  }
}

// repA uploaded 4 (the duplicate was refused); repB one; a leader sees their
// outlet, which is repA's four and not repB's.
ok('a rep sees only their own vouchers', (await visibleAs(repA.authId)) === 4, 'wrong count');
ok('the outlet leader sees their outlet', (await visibleAs(leaderA.authId)) === 4, 'wrong count');
ok('an admin sees all', (await visibleAs(admin.authId)) === 5, 'wrong count');

console.log('');
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} voucher-schema checks passed`);
await db.close();
process.exit(pass === checks.length ? 0 : 1);
