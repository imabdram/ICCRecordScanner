/**
 * Team leaders create and edit their own sales reps.
 *
 * Proves, against the live database:
 *   - a team leader sees "New sales rep"; role/outlet/team lead are fixed
 *   - the rep they create lands in their outlet with them as team leader
 *   - the leader can edit that rep (name/phone), but cannot change its role
 *   - RLS refuses a leader creating a rep for ANOTHER leader's team
 *
 * Creates its own throwaway leader + rep and deletes exactly those at the end.
 * Usage: npm run preview, then node scripts/e2e-teamleader.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { runSql } from './db.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'DemoPass!2026';
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);
const AUTH = env.NEON_AUTH_BASE_URL.replace(/\/$/, '');
const API = env.NEON_DATA_API_URL.replace(/\/$/, '');

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function apiJwt(email, password = PASSWORD) {
  const si = await fetch(`${AUTH}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (si.status !== 200) throw new Error(`sign-in ${si.status} for ${email}`);
  const cookies = si.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const gs = await fetch(`${AUTH}/get-session`, { headers: { Origin: BASE, Cookie: cookies } });
  return gs.headers.get('set-auth-jwt');
}

const adminJwt = await apiJwt('admin@sim.example.com');
const stamp = Date.now();
const leaderEmail = `tl.test.${stamp}@sim.example.com`;
const repEmail = `tl.rep.${stamp}@sim.example.com`;
const stubA = new Set([leaderEmail, repEmail]);

/** Creates an auth identity + profile row directly, returns its id. */
async function seedAccount(email, fullName, role, outletName, teamLeaderAuthId = null) {
  const su = await fetch(`${AUTH}/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email, password: 'TeamTest!42', name: fullName }),
  });
  const { user } = await su.json();
  const outlets = await (await fetch(`${API}/outlets?select=id,name`, { headers: { Authorization: `Bearer ${adminJwt}` } })).json();
  const outlet = outlets.find((o) => o.name === outletName);
  await fetch(`${API}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      auth_user_id: user.id,
      username: email,
      full_name: fullName,
      role,
      outlet_id: outlet.id,
    }),
  });
  if (teamLeaderAuthId) {
    const rows = await (await fetch(`${API}/users?select=id&username=eq.${encodeURIComponent(repEmail)}`, { headers: { Authorization: `Bearer ${adminJwt}` } })).json();
    void rows;
  }
  return user.id;
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

async function signInAs(email, password = PASSWORD) {
  await page.goto(`${BASE}/#users`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  if (await page.$('.sidebar')) {
    await page.click('button:has-text("Sign out")', { force: true });
    await page.waitForSelector('input[type=email]', { timeout: 20000 });
  }
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]', { force: true });
  await page.waitForSelector('.sidebar', { timeout: 30000 });
  await page.goto(`${BASE}/#users`, { waitUntil: 'networkidle' });
  await page.waitForSelector('main table tbody tr', { timeout: 20000 });
  await page.waitForTimeout(2500);
}

let leaderAuthId = null;
try {
  // ---------- setup: a team leader of Customer care Bosaso ----------
  leaderAuthId = await seedAccount(leaderEmail, 'Test Leader', 'team_leader', 'Customer care Bosaso');
  check('setup: team leader created', !!leaderAuthId);

  // ---------- leader sees "New sales rep" ----------
  await signInAs(leaderEmail, 'TeamTest!42');
  const whoAmI = (await page.textContent('.sidebar .who')).replace(/\s+/g, ' ');
  check('signed in as the seeded leader', /Test Leader/.test(whoAmI), whoAmI);
  const newBtn = await page.textContent('.page-head button.btn');
  check('button reads "New sales rep"', /New sales rep/.test(newBtn ?? ''), newBtn?.trim());

  // ---------- the create form is locked to them ----------
  await page.click('.page-head button.btn', { force: true });
  await page.waitForSelector('.modal-overlay input[placeholder="e.g. Ali Abdi"]');
  await page.waitForTimeout(300);
  const locked = await page.evaluate(() => {
    const sels = [...document.querySelectorAll('.modal select')];
    return {
      roleDisabled: sels[0]?.disabled,
      roleValue: sels[0]?.value,
      leaderDisabled: sels[1]?.disabled,
      leaderText: sels[1]?.selectedOptions[0]?.text,
      regionDisabled: sels[2]?.disabled,
      regionText: sels[2]?.selectedOptions[0]?.text,
      outletDisabled: sels[3]?.disabled,
      outletText: sels[3]?.selectedOptions[0]?.text,
    };
  });
  check('role locked to Sales Rep', locked.roleDisabled === true && locked.roleValue === 'sales_rep', locked.roleValue);
  check('team leader pinned to the signed-in leader', locked.leaderDisabled === true && /Test Leader/.test(locked.leaderText ?? ''), locked.leaderText);
  check('region locked to their region', locked.regionDisabled === true && /Bari Region/.test(locked.regionText ?? ''), locked.regionText);
  check('outlet locked to their outlet', locked.outletDisabled === true && /Customer care Bosaso/.test(locked.outletText ?? ''), locked.outletText);
  await page.screenshot({ path: 'screenshots/18-leader-create-rep.png' });

  // ---------- create the rep ----------
  await page.fill('.modal-overlay input[placeholder="e.g. Ali Abdi"]', 'Leader Made Rep');
  await page.fill('.modal-overlay input[placeholder="rep@example.com"]', repEmail);
  await page.fill('.modal-overlay input[placeholder="At least 8 characters"]', 'RepPass!1234');
  await page.click('.modal-overlay button[type=submit]');
  await page.waitForTimeout(6000);

  const created = await (await fetch(`${API}/users?select=id,full_name,role,outlet_id,team_leader_id&username=eq.${encodeURIComponent(repEmail)}`, { headers: { Authorization: `Bearer ${adminJwt}` } })).json();
  const leaderRow = (await (await fetch(`${API}/users?select=id,outlet_id&username=eq.${encodeURIComponent(leaderEmail)}`, { headers: { Authorization: `Bearer ${adminJwt}` } })).json())[0];
  check('rep was created', created.length === 1, JSON.stringify(created[0] ?? null));
  check('rep is a sales rep', created[0]?.role === 'sales_rep', created[0]?.role);
  check('rep is in the leader\'s outlet', created[0]?.outlet_id === leaderRow?.outlet_id);
  check('rep reports to the leader', created[0]?.team_leader_id === leaderRow?.id, created[0]?.team_leader_id);

  // ---------- the leader can edit the rep, but not change its role ----------
  await signInAs(leaderEmail, 'TeamTest!42');
  await page.evaluate((email) => {
    const row = [...document.querySelectorAll('main table tbody tr')].find((tr) => tr.textContent.includes(email));
    row.querySelector('.icon-btn').click();
  }, repEmail);
  await page.waitForSelector('.modal-overlay input[type=text]');
  await page.waitForTimeout(300);
  const editLocked = await page.evaluate(() => {
    const sels = [...document.querySelectorAll('.modal select')];
    return { roleDisabled: sels[0]?.disabled, leaderText: sels[1]?.selectedOptions[0]?.text, regionDisabled: sels[2]?.disabled };
  });
  check('edit: role is read-only for a leader', editLocked.roleDisabled === true);
  check('edit: team leader pinned to the leader', /Test Leader/.test(editLocked.leaderText ?? ''), editLocked.leaderText);
  await page.fill('.modal input[type=text]', 'Renamed By Leader');
  await page.fill('.modal input[type=tel]', '0611112222');
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(3000);
  const afterEdit = (await (await fetch(`${API}/users?select=full_name,phone,role,team_leader_id&username=eq.${encodeURIComponent(repEmail)}`, { headers: { Authorization: `Bearer ${adminJwt}` } })).json())[0];
  check('leader edit saved the name', afterEdit?.full_name === 'Renamed By Leader', afterEdit?.full_name);
  check('leader edit saved the phone', afterEdit?.phone === '0611112222', afterEdit?.phone);

  // ---------- RLS: a leader cannot create a rep for another leader ----------
  const leaderJwt = await apiJwt(leaderEmail, 'TeamTest!42');
  const otherLeader = (await (await fetch(`${API}/users?select=id&username=eq.leader.qardho@sim.example.com`, { headers: { Authorization: `Bearer ${adminJwt}` } })).json())[0];
  const forged = await fetch(`${API}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${leaderJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_user_id: `forged-${stamp}`, username: `forged.${stamp}@x.com`, full_name: 'Forged', role: 'sales_rep', outlet_id: null, team_leader_id: otherLeader?.id }),
  });
  check('leader cannot assign a rep to another team', [401, 403].includes(forged.status), `HTTP ${forged.status}`);

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  check('team leader run completed', false, error.message);
  await page.screenshot({ path: 'e2e-teamleader-failure.png', fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

// ---------- clean up exactly the accounts this run created ----------
const emails = [...stubA].map((e) => `'${e.replaceAll("'", "''")}'`).join(',');
const { code, stderr } = await runSql(`
  delete from public.scans where sales_rep_id in (select id from public.users where username in (${emails}));
  delete from public.users where username in (${emails});
  delete from neon_auth.session where "userId" in (select id from neon_auth.user where email in (${emails}));
  delete from neon_auth.account where "userId" in (select id from neon_auth.user where email in (${emails}));
  delete from neon_auth.user where email in (${emails});
`);
console.log(code === 0 ? '\ncleaned up this run\'s leader + rep' : `cleanup failed: ${stderr}`);

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
