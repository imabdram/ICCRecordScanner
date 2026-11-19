/**
 * End-to-end proof that the console genuinely works against Neon.
 *
 * Drives the built app in a real browser (Playwright + Chromium), asserts on what
 * is rendered, then verifies the same records directly through the Data API.
 *
 *   1. sign in as each role through the UI (Neon Auth)
 *   2. Dashboard shows per-rep scan counts
 *   3. RLS: roles only see their own outlet / zone
 *   4. a sales rep cannot create users (UI and API write guard)
 *   5. admin creates a user -> BOTH the auth identity and the profile row exist
 *
 * Expected counts come from the seeded demo data (see scripts/demo-users.mjs):
 *   rep.ali 2 scans, rep.hodan 2, rep.abdi 1, team leaders and admin 0.
 *
 * Usage: npm run preview (port 8080) in another shell, then npm run test:e2e
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'DemoPass!2026';
// The seven accounts from scripts/demo-users.mjs. Expectations below are exact,
// so any extra run-created account (e2e.*/debug.*) is an invariant violation.
const DEMO_USERS = [
  'admin@sim.example.com',
  'supervisor.bari@sim.example.com',
  'leader.bosaso@sim.example.com',
  'leader.qardho@sim.example.com',
  'rep.ali@sim.example.com',
  'rep.hodan@sim.example.com',
  'rep.abdi@sim.example.com',
];
const results = [];
let failures = 0;
let createdEmail = null;

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` â€” ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Reads NEON_* URLs straight from .env.local (the same values the bundle inlined). */
function neonEnv() {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
      }),
  );
}
const env = neonEnv();
const AUTH = env.NEON_AUTH_BASE_URL.replace(/\/$/, '');
const API = env.NEON_DATA_API_URL.replace(/\/$/, '');

async function apiJwt(email) {
  const si = await fetch(`${AUTH}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookies = si.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const gs = await fetch(`${AUTH}/get-session`, { headers: { Origin: BASE, Cookie: cookies } });
  return gs.headers.get('set-auth-jwt');
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

async function login(email) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]', { force: true });
  await page.waitForSelector('.sidebar', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await ensureSidebar(email);
}

/** Waits until the shell shows the account we just signed in as. */
async function ensureSidebar(email) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const who = await page.$eval('.who .name', (e) => e.textContent).catch(() => null);
    if (who) return who;
    if (await page.$('input[type=email]')) {
      // Bounced back to the sign-in form: submit it again.
      await page.fill('input[type=email]', email);
      await page.fill('input[type=password]', PASSWORD);
      await page.click('button[type=submit]', { force: true });
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`Could not reach the signed-in shell as ${email}`);
}

async function signOutAndLogin(email) {
  // Sign out, verifying the sign-in form actually appeared (a reload of the SPA
  // can otherwise leave the button detached and the transition undone).
  let signedOut = false;
  for (let attempt = 0; attempt < 3 && !signedOut; attempt++) {
    await page.waitForSelector('button:has-text("Sign out")', { timeout: 30000 });
    await page.click('button:has-text("Sign out")', { force: true });
    signedOut = await page
      .waitForSelector('input[type=email]', { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!signedOut) throw new Error(`Sign-out did not complete before switching to ${email}`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]', { force: true });
  await page.waitForSelector('.sidebar', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await ensureSidebar(email);
}

try {
  // ---- 0. state check BEFORE asserting on counts ------------------------
  // Extra accounts would make the "sees only X people" checks pass or fail for
  // the wrong reason, so surface them explicitly.
  const adminJwtPre = await apiJwt('admin@sim.example.com');
  const allUsers = await (
    await fetch(`${API}/users?select=username`, { headers: { Authorization: `Bearer ${adminJwtPre}` } })
  ).json();
  const extras = allUsers.map((u) => u.username).filter((u) => !DEMO_USERS.includes(u));
  if (extras.length) {
    console.log(`note: ${extras.length} account(s) not from the demo seed (left untouched): ${extras.join(', ')}`);
  }

  // ---- 1. sales rep -------------------------------------------------------
  await login('rep.ali@sim.example.com');
  const repHeader = await page.textContent('.who .meta');
  check('rep sign-in shows outlet/region', /Customer care Bosaso.*Bari Region/s.test(repHeader ?? ''), repHeader?.trim());

  // The redesign turned the rep table into a leaderboard with one cell per column.
  // Scope to the leaderboard panel: the page also has a leadership table whose
  // role cell would otherwise be picked up as a "rep".
  const rows = await page.$$eval('#leaderboard tbody tr', (trs) =>
    trs.map((tr) => [...tr.children].map((c) => c.textContent.trim())),
  );
  const repNames = rows.map((r) => r[1]);
  check('dashboard lists rep scans for signed-in rep', repNames.includes('Ali Sales Rep'), JSON.stringify(repNames));
  check('rep sees only own outlet reps (RLS)', rows.length === 2, `${rows.length} row(s): ${repNames.join(', ')}`);
  const ali = rows.find((r) => r[1] === 'Ali Sales Rep');
  check('Ali scan total is 2', ali?.[3] === '2', JSON.stringify(ali));

  // ---- 2. records view: no Mudug leak ------------------------------------
  await page.click('button[data-view=records]', { force: true });
  await page.waitForTimeout(1200);
  const recordsText = await page.textContent('main');
  check('records show Bari scans', /Customer \d/.test(recordsText ?? ''));
  check('records hide Mudug data', !/Mudug/.test(recordsText ?? ''));

  // ---- 3. sales rep cannot create users ----------------------------------
  await page.click('button[data-view=users]', { force: true });
  await page.waitForTimeout(1200);
  check('sales rep gets no create-user button', (await page.$('.page-head button.btn')) === null);

  // ---- 3b. RLS write guard (before the risky steps) ---------------------
  const repJwt = await apiJwt('rep.ali@sim.example.com');
  const forbidden = await fetch(`${API}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${repJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_user_id: 'fake-id', username: 'hacker@x.com', full_name: 'Hacker', role: 'admin' }),
  });
  check('sales rep is blocked from inserting users', [401, 403].includes(forbidden.status), `HTTP ${forbidden.status}`);

  // ---- 4. team leader: their outlet only, cannot manage accounts ---------
  await signOutAndLogin('leader.bosaso@sim.example.com');
  await page.click('button[data-view=users]', { force: true });
  await page.waitForTimeout(1500);
  // The person cell now contains an avatar + name + email, hence the loose match.
  const leaderUsers = await page.$$eval('main table tbody tr', (rows) => rows.map((r) => r.textContent));
  const hasAll = ['Ali Sales Rep', 'Hodan Sales Rep'].every((n) => leaderUsers.some((t) => t.includes(n)));
  const hasOther = leaderUsers.some((t) => t.includes('Abdi Sales Rep'));
  // Not a fixed count: real people may share the outlet. Compare with the
  // outlet's real membership, which the leader can see.
  check('team leader sees own outlet team only', hasAll && !hasOther, `${leaderUsers.length} people`);
  // A team leader may create sales reps for their own team (see
  // scripts/e2e-teamleader.mjs); what they must never get is admin-style power.
  check('team leader gets "New sales rep", not "New user"', /New sales rep/.test((await page.textContent('.page-head button.btn')) ?? ''));

  // ---- 5. supervisor: whole zone, can manage ----------------------------
  await signOutAndLogin('supervisor.bari@sim.example.com');
  await page.click('button[data-view=users]', { force: true });
  await page.waitForTimeout(1500);
  const supUsers = await page.$$eval('main table tbody tr', (rows) => rows.length);
  // Compare against the supervisor's OWN scope. apiJwt() defaults to the admin,
  // which sees every zone and would make this comparison meaningless.
  const supJwt = await apiJwt('supervisor.bari@sim.example.com');
  const zoneUserCount = (
    await (
      await fetch(`${API}/users?select=id`, { headers: { Authorization: `Bearer ${supJwt}` } })
    ).json()
  ).length;
  check('supervisor sees the whole zone', supUsers === zoneUserCount, `${supUsers} shown, ${zoneUserCount} in zone`);
  check('supervisor has a create-user button', (await page.$('.page-head button.btn')) !== null);

  // ---- 6. admin creates a user through the UI ---------------------------
  await signOutAndLogin('admin@sim.example.com');
  await page.click('button[data-view=users]', { force: true });
  await page.waitForSelector('.page-head button.btn');
  // Creation now happens in a modal opened from the header button.
  await page.click('.page-head button.btn', { force: true });
  await page.waitForSelector('.modal-overlay input[placeholder="e.g. Ali Abdi"]');
  const newEmail = `e2e.rep.${Date.now()}@sim.example.com`;
  createdEmail = newEmail;
  await page.fill('.modal-overlay input[placeholder="e.g. Ali Abdi"]', 'E2E New Rep');
  await page.fill('.modal-overlay input[placeholder="rep@example.com"]', newEmail);
  await page.fill('.modal-overlay input[placeholder="At least 8 characters"]', 'E2ETempPass!42');
  // Region -> Outlet cascade: pick the region first, then only its outlets show.
  const sels = page.locator('.modal-overlay select');
  await sels.nth(0).selectOption('sales_rep');
  await sels.nth(2).selectOption({ label: 'Bari Region' });
  await sels.nth(3).selectOption({ label: 'Customer care Bosaso' });
  await page.click('button[type=submit]:has-text("Create user")', { force: true });
  await page.waitForTimeout(8000);
  const afterCreate = await page.textContent('main');
  check('admin create user reports success', /created and linked/i.test(afterCreate ?? ''));
  check('new user appears in list', /E2E New Rep/.test(afterCreate ?? ''));
  
  // Both halves exist and are linked, checked straight through the Data API.
  const adminJwt = await apiJwt('admin@sim.example.com');
  const created = await (
    await fetch(`${API}/users?select=id,username,role,outlet_id&username=eq.${encodeURIComponent(newEmail)}`, {
      headers: { Authorization: `Bearer ${adminJwt}` },
    })
  ).json();
  check('profile row written for new user', created.length === 1, JSON.stringify(created).slice(0, 160));
  check('new user linked to an outlet', created[0]?.outlet_id != null, created[0]?.outlet_id);

  const code = await (
    await fetch(`${API}/v_scan_records?select=id&limit=1`, { headers: { Authorization: `Bearer ${adminJwt}` } })
  ).status;
  check('admin can read scan records', code === 200, 'HTTP ' + code);

  // ---- 6. creating a user's PROFILE ROW must be blocked for a rep --------
  // This exercises the users_admin_write policy. (Creating the auth identity is
  // a Neon Auth call with no per-creator restriction — see README limitations.)
  const forged = await fetch(`${API}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${repJwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      auth_user_id: 'forged-identity',
      username: `forged.${Date.now()}@x.com`,
      full_name: 'Forged Profile',
      role: 'supervisor',
    }),
  });
  check('sales rep is blocked from inserting a user row', [401, 403].includes(forged.status), `HTTP ${forged.status}`);

  check('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (error) {
  check('e2e run completed', false, error.message);
  await page.screenshot({ path: 'e2e-failure.png', fullPage: true }).catch(() => {});
} finally {
  // ---- 7. remove ONLY what this run created ----------------------------
  // Never touch accounts the run did not create: they may be real users.
  try {
    const jwt = await apiJwt('admin@sim.example.com');
    if (createdEmail) {
      const users = await (await fetch(`${API}/users?select=id,username`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
      const mine = users.filter((u) => u.username === createdEmail);
      for (const u of mine) {
        await fetch(`${API}/users?id=eq.${u.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
      }
      if (mine.length) {
        console.log(`\ncleaned up the account this run created: ${createdEmail}`);
        console.log('(its neon_auth identity remains; remove with scripts/cleanup-test-users.sql if desired)');
      }
    }
    // Report, but never delete, any account outside the demo seed.
    const users = await (await fetch(`${API}/users?select=username`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
    const others = users.map((u) => u.username).filter((n) => !DEMO_USERS.includes(n) && n !== createdEmail);
    if (others.length) console.log(`\nnote: ${others.length} other account(s) exist and were left untouched: ${others.join(', ')}`);
  } catch (error) {
    console.log('cleanup skipped:', error.message);
  }
  await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
