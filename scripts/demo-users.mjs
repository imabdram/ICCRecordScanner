/**
 * Creates demo accounts that exercise every permission level.
 *
 * Each account is created through the real Managed Better Auth sign-up
 * endpoint, so it gets a genuine Neon Auth identity. The script then writes the
 * matching public.users row (role + outlet), which is what gives the account its
 * Region and Zone.
 *
 * Run after the schema and seed:
 *   npm run db:schema && npm run db:seed && npm run db:demo-users
 *
 * Credentials are printed at the end; override the password with DEMO_PASSWORD.
 * Requires DATABASE_URL (direct) for the profile rows.
 */
import { runSql } from './db.mjs';
import { readFileSync } from 'node:fs';

const password = process.env.DEMO_PASSWORD ?? 'DemoPass!2026';

function authBaseUrl() {
  if (process.env.NEON_AUTH_BASE_URL) return process.env.NEON_AUTH_BASE_URL.replace(/\/$/, '');
  const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('NEON_AUTH_BASE_URL='));
  if (!line) throw new Error('NEON_AUTH_BASE_URL is not set. Run `neon deploy` first.');
  return line.slice('NEON_AUTH_BASE_URL='.length).trim().replace(/^"|"$/g, '').replace(/\/$/, '');
}

const ACCOUNTS = [
  { email: 'admin@sim.example.com', name: 'System Administrator', role: 'admin', outlet: 'Customer care Bosaso', leader: null },
  { email: 'supervisor.bari@sim.example.com', name: 'Bari Supervisor', role: 'supervisor', outlet: 'Amalbank HQI Bosaso', leader: null },
  { email: 'leader.bosaso@sim.example.com', name: 'Bosaso Team Leader', role: 'team_leader', outlet: 'Customer care Bosaso', leader: null },
  { email: 'leader.qardho@sim.example.com', name: 'Qardho Team Leader', role: 'team_leader', outlet: 'Alla-aamin Qardho', leader: null },
  { email: 'rep.ali@sim.example.com', name: 'Ali Sales Rep', role: 'sales_rep', outlet: 'Customer care Bosaso', leader: 'leader.bosaso@sim.example.com' },
  { email: 'rep.hodan@sim.example.com', name: 'Hodan Sales Rep', role: 'sales_rep', outlet: 'Customer care Bosaso', leader: 'leader.bosaso@sim.example.com' },
  { email: 'rep.abdi@sim.example.com', name: 'Abdi Sales Rep', role: 'sales_rep', outlet: 'Alla-aamin Qardho', leader: 'leader.qardho@sim.example.com' },
];

/** Sign up, or sign in if the account already exists. Returns the auth user id. */
async function ensureIdentity(base, account) {
  const signUp = await fetch(`${base}/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8080' },
    body: JSON.stringify({ email: account.email, password, name: account.name }),
  });
  const body = await signUp.json().catch(() => ({}));
  if (signUp.status === 200 && body?.user?.id) return body.user.id;

  // Already registered: sign in instead.
  const signIn = await fetch(`${base}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8080' },
    body: JSON.stringify({ email: account.email, password }),
  });
  const inBody = await signIn.json().catch(() => ({}));
  if (signIn.status === 200 && inBody?.user?.id) return inBody.user.id;
  throw new Error(`Could not create or sign in ${account.email}: ${JSON.stringify(body).slice(0, 200)}`);
}

const base = authBaseUrl();
console.log(`Auth: ${base}`);

const ids = {};
for (const account of ACCOUNTS) {
  ids[account.email] = await ensureIdentity(base, account);
  console.log(`  identity  ${account.email.padEnd(36)} ${ids[account.email]}`);
}

// Write the profile rows. Two passes so a team leader can be referenced.
const statements = [];
for (const account of ACCOUNTS) {
  const leaderId = account.leader ? `'${ids[account.leader]}'` : 'null';
  statements.push(`
insert into public.users (auth_user_id, username, full_name, role, outlet_id, team_leader_id)
select '${ids[account.email]}', '${account.email}', '${account.name}', '${account.role}', o.id,
       (select id from public.users where auth_user_id = ${leaderId})
from public.outlets o where o.name = '${account.outlet}'
on conflict (auth_user_id) do update
  set username = excluded.username, full_name = excluded.full_name, role = excluded.role,
      outlet_id = excluded.outlet_id, team_leader_id = excluded.team_leader_id, active = true;`);
}
// Leaders first, then reps, so team_leader_id resolves.
statements.sort((a, b) => (a.includes('team_leader') ? -1 : 1) - (b.includes('team_leader') ? -1 : 1));

const result = await runSql(statements.join('\n'));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.code !== 0) {
  console.error('Profile rows failed.');
  process.exit(1);
}

console.log('\nDemo accounts (password: ' + password + ')');
for (const a of ACCOUNTS) console.log(`  ${a.role.padEnd(12)} ${a.email.padEnd(36)} ${a.outlet}`);
