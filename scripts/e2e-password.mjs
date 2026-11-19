
import { chromium } from 'playwright';
const BASE = 'http://localhost:8080';
const results = [];
const check = (n, ok, d='') => results.push(`${ok?'PASS':'FAIL'}  ${n}${d?' — '+d:''}`);
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));

await p.goto(BASE, { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
await p.fill('input[type=email]', 'rep.hodan@sim.example.com');
await p.fill('input[type=password]', 'DemoPass!2026');
await p.click('button[type=submit]', { force: true });
await p.waitForSelector('.sidebar', { timeout: 30000 });
await p.goto(BASE + '/#settings', { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);

const pw = await p.$$('input[type=password]');
check('Settings page opens with 3 password fields', pw.length === 3, pw.length + ' fields');
check('shows the signed-in user', /Hodan/.test(await p.textContent('.page-body, #app')));

await pw[0].fill('totally-wrong');
await pw[1].fill('BrandNewPass!1');
await pw[2].fill('BrandNewPass!1');
await p.click('button[type=submit]:has-text("Change password")');
await p.waitForTimeout(3500);
check('wrong current password -> clear error', /incorrect/i.test(await p.textContent('.banner').catch(() => '')));

const pw2 = await p.$$('input[type=password]');
await pw2[0].fill('DemoPass!2026');
await pw2[1].fill('BrandNewPass!1');
await pw2[2].fill('Different!1');
await p.click('button[type=submit]:has-text("Change password")');
await p.waitForTimeout(1500);
check('mismatched confirm refused', /do not match/i.test(await p.textContent('.banner').catch(() => '')));

const pw3 = await p.$$('input[type=password]');
await pw3[0].fill('DemoPass!2026');
await pw3[1].fill('BrandNewPass!1');
await pw3[2].fill('BrandNewPass!1');
await p.click('button[type=submit]:has-text("Change password")');
await p.waitForTimeout(4000);
check('password changed', /Password changed/i.test(await p.textContent('.banner').catch(() => '')));
await p.screenshot({ path: 'screenshots/19-settings-password.png' });

const AUTH = 'https://ep-small-morning-zaojp26b.neonauth.c-2.eu-west-2.aws.neon.tech/neondb/auth';
const ORIGIN = 'https://app.neon-mobile.local';
const tryPw = async (password) => (await fetch(AUTH + '/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'rep.hodan@sim.example.com', password }) })).status;
check('old password rejected at auth layer', (await tryPw('DemoPass!2026')) === 401);
check('new password accepted at auth layer', (await tryPw('BrandNewPass!1')) === 200);
const si = await fetch(AUTH + '/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'rep.hodan@sim.example.com', password: 'BrandNewPass!1' }) });
const cookies = si.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
await fetch(AUTH + '/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookies }, body: JSON.stringify({ currentPassword: 'BrandNewPass!1', newPassword: 'DemoPass!2026' }) });
check('demo password restored', (await tryPw('DemoPass!2026')) === 200);
check('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(results.join('\n'));
