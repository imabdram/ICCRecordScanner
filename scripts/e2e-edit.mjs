/**
 * Proves editing a user works, end to end, against the live database.
 *
 * Creates ONE throwaway rep, edits it through the UI (name, phone, role,
 * team leader, status, outlet via Region -> Outlet), verifies each change
 * reached Postgres, then deletes its own test user directly via SQL.
 * It never touches the demo accounts or any other user.
 *
 * Usage: npm run preview in another shell, then node scripts/e2e-edit.mjs
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
const getUser = async (email) =>
  (await fetch(`${API}/users?select=id,username,full_name,phone,role,outlet_id,team_leader_id,active&username=eq.${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${adminJwt}` },
  })).json();

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

async function signInAs(email) {
  await page.goto(`${BASE}/#users`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  if (await page.$('.sidebar')) {
    await page.click('button:has-text("Sign out")', { force: true });
    await page.waitForSelector('input[type=email]', { timeout: 20000 });
  }
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]', { force: true });
  await page.waitForSelector('.sidebar', { timeout: 30000 });
  await page.goto(`${BASE}/#users`, { waitUntil: 'networkidle' });
  await page.waitForSelector('main table tbody tr', { timeout: 20000 });
  await page.waitForTimeout(2500);
}

let createdEmail = null;
try {
  // ---------- setup: one throwaway rep with no scans ----------
  createdEmail = `edit.test.${Date.now()}@sim.example.com`;
  const su = await fetch(`${AUTH}/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: createdEmail, password: 'EditTest!42', name: 'Edit Target' }),
  });
  const { user } = await su.json();
  const outlets = await (await fetch(`${API}/outlets?select=id,name`, { headers: { Authorization: `Bearer ${adminJwt}` } })).json();
  const qardho = outlets.find((o) => o.name === 'Alla-aamin Qardho');
  await fetch(`${API}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ auth_user_id: user.id, username: createdEmail, full_name: 'Edit Target', role: 'sales_rep', outlet_id: qardho.id }),
  });
  const before = (await getUser(createdEmail))[0];
  check('setup: throwaway user created', !!before, `${before?.full_name} @ ${before?.role}`);

  // ---------- a sales rep has no edit controls; a manager does ----------
  await signInAs('rep.ali@sim.example.com');
  check('sales rep sees no edit buttons', (await page.$$('main table .icon-btn')).length === 0);

  await signInAs('admin@sim.example.com');
  const editButtons = await page.$$eval('main table tbody tr', (trs) => trs.map((tr) => !!tr.querySelector('.icon-btn')).length);
  const rows = await page.$$eval('main table tbody tr', (trs) => trs.length);
  check('admin sees an edit button on every row', editButtons === rows, `${editButtons}/${rows} rows`);

  // ---------- open the dialog, verify it is prefilled ----------
  await page.evaluate((email) => {
    const row = [...document.querySelectorAll('main table tbody tr')].find((tr) => tr.textContent.includes(email));
    row.querySelector('.icon-btn').click();
  }, createdEmail);
  await page.waitForSelector('.modal-overlay', { timeout: 15000 });
  await page.waitForTimeout(400);

  const prefill = await page.evaluate(() => ({
    name: document.querySelector('.modal input[type=text]')?.value,
    role: document.querySelectorAll('.modal select')[0]?.value,
    region: document.querySelectorAll('.modal select')[2]?.value,
    outlet: document.querySelectorAll('.modal select')[3]?.value,
    outletLabel: document.querySelectorAll('.modal select')[3]?.selectedOptions[0]?.text,
  }));
  check('dialog is prefilled with the user', prefill.name === 'Edit Target' && prefill.role === 'sales_rep', JSON.stringify(prefill));
  check('cascade preselected the current outlet', prefill.outletLabel === 'Alla-aamin Qardho', prefill.outletLabel);
  await page.screenshot({ path: 'screenshots/16-edit-user.png' });

  // ---------- change everything ----------
  await page.fill('.modal input[type=text]', 'Edited Name');
  await page.fill('.modal input[type=tel]', '0612345678');
  const sels = page.locator('.modal select');
  await sels.nth(0).selectOption('team_leader');
  await sels.nth(1).selectOption({ label: 'Bosaso Team Leader' });
  // move them to a different region + outlet, proving the cascade still filters
  await sels.nth(2).selectOption({ label: 'Bari Region' });
  await page.waitForTimeout(250);
  const outletOptions = await sels.nth(3).locator('option').allTextContents();
  check('changing region refilters the outlets', outletOptions.length === 6 && !outletOptions.includes('Galkacyo HQ'), outletOptions.slice(1).join(', '));
  await sels.nth(3).selectOption({ label: 'Customer care Bosaso' });
  // Not .check(): Playwright's check() compares state on every retry and cannot
  // settle against a custom-styled toggle, so it silently leaves it unchanged
  // (and re-asserts any event-driven change). Click once, then assert.
  await page.locator('.edit-active input[type=checkbox]').click();
  const toggledOff = await page.$eval('.edit-active input[type=checkbox]', (c) => c.checked);
  check('status toggle switched off in the dialog', toggledOff === false, String(toggledOff));
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(3000);

  // ---------- verify in the database ----------
  const after = (await getUser(createdEmail))[0];
  const leader = (await (await fetch(`${API}/users?select=id,full_name&full_name=eq.Bosaso%20Team%20Leader`, { headers: { Authorization: `Bearer ${adminJwt}` } })).json())[0];
  const outletAfter = outlets.find((o) => o.name === 'Customer care Bosaso');
  check('name updated', after?.full_name === 'Edited Name', after?.full_name);
  check('phone updated', after?.phone === '0612345678', after?.phone);
  check('role updated', after?.role === 'team_leader', after?.role);
  check('team leader assigned', after?.team_leader_id === leader?.id, after?.team_leader_id);
  check('outlet moved to the new region', after?.outlet_id === outletAfter?.id, after?.outlet_id);
  check('status set to disabled', after?.active === false, String(after?.active));

  const tableText = await page.textContent('main table');
  check('list reflects the edit', /Edited Name/.test(tableText) && /Disabled/.test(tableText));
  check('success banner shown', /updated/i.test(await page.textContent('#app')));
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await page.screenshot({ path: 'screenshots/17-after-edit.png' });
} catch (error) {
  check('edit run completed', false, error.message);
  await page.screenshot({ path: 'e2e-edit-failure.png', fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

// ---------- clean up exactly the user this run created ----------
if (createdEmail) {
  const escaped = createdEmail.replaceAll("'", "''");
  const { code, stderr } = await runSql(`
    delete from public.scans where sales_rep_id in (select id from public.users where username = '${escaped}');
    delete from public.users where username = '${escaped}';
    delete from neon_auth.session where "userId" in (select id from neon_auth.user where email = '${escaped}');
    delete from neon_auth.account where "userId" in (select id from neon_auth.user where email = '${escaped}');
    delete from neon_auth.user where email = '${escaped}';
  `);
  console.log(code === 0 ? `\ncleaned up test user ${createdEmail}` : `cleanup failed: ${stderr}`);
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
