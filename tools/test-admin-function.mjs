// Exercises the built Edge Function against an in-memory fake of the Supabase
// Auth admin API and the PostgREST query builder the function uses.
//
//   node build-admin-function.mjs <root>   # compile first
//   node test-admin-function.mjs <root>
//
// What this CAN prove: the function's own logic -- routing, auth, role rules,
// validation, ordering, cleanup on failure, ban-on-disable.
// What it CANNOT prove: that Supabase's real API accepts these exact calls.
// Only the deployed function against the real project settles that.
import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ?? '.';
const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let loadCount = 0;

// ---------------------------------------------------------------- fake world
const db = {
  users: [], authUsers: [], outlets: [], seq: 0,
  reset() {
    this.users = []; this.authUsers = []; this.seq = 0;
    this.outlets = [
      { id: 'outlet-bosaso', name: 'Customer care Bosaso', region_id: 'r-bari',
        regions: { id: 'r-bari', name: 'Bari Region', zone_id: 'z2' } },
      { id: 'outlet-galkacyo', name: 'Galkacyo HQ', region_id: 'r-mudug',
        regions: { id: 'r-mudug', name: 'Mudug Region', zone_id: 'z2' } },
      { id: 'outlet-far', name: 'Laascaano', region_id: 'r-sool',
        regions: { id: 'r-sool', name: 'Sool Region', zone_id: 'z9' } },
    ];
  },
};
const nextId = (p) => `${p}-${++db.seq}`;

// Minimal PostgREST builder: just the chains the function uses.
function makeQuery(table) {
  const st = { filters: [], head: false };
  const rows = () => db[table].filter((r) => st.filters.every(([c, v]) => r[c] === v));

  // The function joins users -> outlets -> regions to work out scope. The fake
  // flattens that into nested objects the way PostgREST would return them.
  const decorate = (row) => {
    if (!row || table !== 'users') return row;
    const outlet = db.outlets.find((o) => o.id === row.outlet_id) ?? null;
    return {
      ...row,
      outlets: outlet ? { id: outlet.id, regions: { zone_id: outlet.regions?.zone_id ?? null } } : null,
    };
  };

  const q = {
    select(_c, opts) { st.head = opts?.head === true; return q; },
    eq(c, v) { st.filters.push([c, v]); return q; },
    maybeSingle() {
      const r = rows();
      return Promise.resolve(r.length > 1
        ? { data: null, error: { message: 'multiple rows' } }
        : { data: decorate(r[0] ?? null), error: null });
    },
    single() {
      const r = rows();
      return Promise.resolve(r.length === 1
        ? { data: decorate(r[0]), error: null }
        : { data: null, error: { message: r.length ? 'multiple rows' : 'no rows' } });
    },
    insert(row) {
      if (table === 'users' &&
          db.users.some((u) => u.username.toLowerCase() === String(row.username).toLowerCase())) {
        const error = { message: 'duplicate key value violates unique constraint "users_username_key"' };
        return {
          select() { return { single: () => Promise.resolve({ data: null, error }) }; },
          then(r) { return Promise.resolve({ data: null, error }).then(r); },
        };
      }
      const saved = { id: nextId('u'), team_leader_id: null, active: true, ...row };
      db.users.push(saved);
      return {
        select() { return { single: () => Promise.resolve({ data: saved, error: null }) }; },
        then(r) { return Promise.resolve({ data: saved, error: null }).then(r); },
      };
    },
    update(patch) {
      return {
        eq(c, v) {
          db.users.filter((r) => r[c] === v).forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    then(resolve) {
      const r = rows();
      return Promise.resolve(st.head
        ? { data: null, count: r.length, error: null }
        : { data: r, error: null }).then(resolve);
    },
  };
  return q;
}

const fakeAdminClient = {
  from: (t) => makeQuery(t),
  auth: {
    getUser: async (token) => {
      const u = db.authUsers.find((a) => a.email === token);
      return u
        ? { data: { user: { id: u.id, email: u.email } }, error: null }
        : { data: { user: null }, error: { message: 'invalid JWT' } };
    },
    admin: {
      createUser: async ({ email, password }) => {
        if (db.authUsers.some((a) => a.email === email)) {
          return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
        }
        const u = { id: nextId('auth'), email, password, banned: false };
        db.authUsers.push(u);
        return { data: { user: { id: u.id, email } }, error: null };
      },
      updateUserById: async (id, patch) => {
        const u = db.authUsers.find((a) => a.id === id);
        if (!u) return { data: null, error: { message: 'user not found' } };
        if (patch.password) u.password = patch.password;
        if (patch.ban_duration !== undefined) u.banned = patch.ban_duration !== 'none';
        return { data: { user: u }, error: null };
      },
      deleteUser: async (id) => {
        const i = db.authUsers.findIndex((a) => a.id === id);
        if (i >= 0) db.authUsers.splice(i, 1);
        return { error: null };
      },
    },
  },
};

// ---------------------------------------------------------------- load
function loadWith(envVars) {
  // The build is a separate step (node build-admin-function.mjs <root>).
  // Spawning a child process from here is blocked by the sandbox.
  const file = join(HERE, '.fnbuild', 'stage.js');
  if (!existsSync(file)) {
    console.error(`Not built: ${file}\nRun: node build-admin-function.mjs ${ROOT}`);
    process.exit(2);
  }

  // Node will not re-evaluate the same module URL, so each load gets its own
  // copy. Without this, a second load silently keeps the first module's env.
  const copy = join(HERE, '.fnbuild', `run-${++loadCount}.mjs`);
  copyFileSync(file, copy);

  globalThis.__createClient = () => fakeAdminClient;
  globalThis.Deno = {
    env: { get: (k) => envVars[k] },
    serve: (h) => { globalThis.__handler = h; },
  };
  delete globalThis.__handler;

  return import(pathToFileURL(copy).href).then((mod) => {
    // The builder rewrites Deno.serve(...) into an assignment, so the handler is
    // available as soon as the module finishes evaluating.
    if (typeof globalThis.__handler !== 'function' && typeof mod.handler === 'function') {
      globalThis.__handler = mod.handler;
    }
    return mod;
  });
}

const call = (handler, body, headers = {}) =>
  handler(new Request('http://fn.test/admin-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
const readJson = async (res) => ({ status: res.status, body: await res.json() });

// ---------------------------------------------------------------- assertions
const checks = [];
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

db.reset();
const ENV = {
  SUPABASE_URL: 'fake',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-fake',
  BOOTSTRAP_ADMIN_TOKEN: 'bootstrap-secret',
};

// ---------- type-check guarantee is separate; this file tests behaviour ----
await loadWith(ENV);
let handler = globalThis.__handler;
ok('the function registers a Deno.serve handler', typeof handler === 'function');

// ---- bootstrap -------------------------------------------------------------
let r = await readJson(await call(handler, { action: 'bootstrap', username: 'x', password: 'longenough1' },
  { Authorization: 'Bearer wrong' }));
ok('bootstrap rejects a wrong token', r.status === 401 && r.body.code === 'bad_bootstrap_token', JSON.stringify(r.body));

r = await readJson(await call(handler, { action: 'bootstrap', username: 'yacquub', password: 'short' },
  { Authorization: 'Bearer bootstrap-secret' }));
ok('bootstrap rejects a short password', r.status === 400, JSON.stringify(r.body));

r = await readJson(await call(handler,
  { action: 'bootstrap', username: 'yacquub', password: 'Adm1nPass!2026', full_name: 'Yacquub Admin', outlet_id: 'outlet-bosaso' },
  { Authorization: 'Bearer bootstrap-secret' }));
ok('bootstrap creates the first admin', r.status === 200 && r.body.ok && r.body.user.role === 'admin', JSON.stringify(r.body));
ok('one users row and one auth user exist', db.users.length === 1 && db.authUsers.length === 1,
   `users=${db.users.length} auth=${db.authUsers.length}`);
ok('the auth email is username@sim.local', db.authUsers[0].email === 'yacquub@sim.local', db.authUsers[0]?.email);

r = await readJson(await call(handler, { action: 'bootstrap', username: 'second', password: 'Adm1nPass!2026' },
  { Authorization: 'Bearer bootstrap-secret' }));
ok('bootstrap refuses once an admin exists', r.status === 409 && r.body.code === 'admin_exists', JSON.stringify(r.body));

// ---- auth ------------------------------------------------------------------
r = await readJson(await call(handler, { action: 'create-user', username: 'ali', password: 'Rep1Pass!' }));
ok('create-user without a token is refused', r.status === 401, JSON.stringify(r.body));

const ADMIN_TOKEN = 'yacquub@sim.local';
const ADMIN_ID = db.users[0].id;

db.users.push({ id: 'u-rep', auth_user_id: 'auth-rep', username: 'rep', full_name: 'Rep',
                role: 'sales_rep', outlet_id: 'outlet-bosaso', team_leader_id: null, active: true });
db.authUsers.push({ id: 'auth-rep', email: 'rep@sim.local', password: 'x', banned: false });

r = await readJson(await call(handler, { action: 'create-user', username: 'ali', password: 'Rep1Pass!' },
  { Authorization: 'Bearer rep@sim.local' }));
ok('a sales rep cannot create users', r.status === 403, JSON.stringify(r.body));

db.users.find((u) => u.id === 'u-rep').active = false;
r = await readJson(await call(handler, { action: 'set-active', user_id: ADMIN_ID, active: false },
  { Authorization: 'Bearer rep@sim.local' }));
ok('a disabled profile is refused even with a valid token', r.status === 401, JSON.stringify(r.body));
db.users.find((u) => u.id === 'u-rep').active = true;

// ---- create-user rules -----------------------------------------------------
const asAdmin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

r = await readJson(await call(handler, { action: 'create-user', username: 'Bad Name!', password: 'Rep1Pass!' }, asAdmin));
ok('rejects an invalid username', r.status === 400, JSON.stringify(r.body));

r = await readJson(await call(handler, { action: 'create-user', username: 'ali', password: 'Rep1Pass!', role: 'superuser' }, asAdmin));
ok('rejects an unknown role', r.status === 400, JSON.stringify(r.body));

r = await readJson(await call(handler, { action: 'create-user', username: 'ali', password: 'Rep1Pass!', outlet_id: 'nope' }, asAdmin));
ok('rejects a non-existent outlet', r.status === 400, JSON.stringify(r.body));

r = await readJson(await call(handler,
  { action: 'create-user', username: 'Ali.REP', password: 'Rep1Pass!', role: 'sales_rep', outlet_id: 'outlet-bosaso', full_name: 'Ali Rep' }, asAdmin));
ok('creates a sales rep', r.status === 200 && r.body.user?.role === 'sales_rep', JSON.stringify(r.body));
ok('the username is lowercased', r.body.user?.username === 'ali.rep', r.body.user?.username);
const REP_ID = r.body.user.id;

const before = db.authUsers.length;
r = await readJson(await call(handler, { action: 'create-user', username: 'ALI.REP', password: 'Rep1Pass!' }, asAdmin));
ok('a duplicate username gets a clear code', r.status === 409 && r.body.code === 'username_taken', JSON.stringify(r.body));
ok('a refused duplicate leaves no orphaned auth user', db.authUsers.length === before, `${before} -> ${db.authUsers.length}`);

// ---- set-password ----------------------------------------------------------
r = await readJson(await call(handler, { action: 'set-password', user_id: REP_ID, password: 'BrandNew1!' }, asAdmin));
ok("admin sets another user's password", r.status === 200 && r.body.ok, JSON.stringify(r.body));
ok('the stored password really changed',
   db.authUsers.find((a) => a.email === 'ali.rep@sim.local').password === 'BrandNew1!');

r = await readJson(await call(handler, { action: 'set-password', user_id: 'u-missing', password: 'BrandNew1!' }, asAdmin));
ok('set-password on an unknown user is a clean 404', r.status === 404, JSON.stringify(r.body));

// ---- set-active ------------------------------------------------------------
r = await readJson(await call(handler, { action: 'set-active', user_id: REP_ID, active: false }, asAdmin));
ok('disabling a user succeeds', r.status === 200 && r.body.active === false, JSON.stringify(r.body));
ok('disabling also bans the login', db.authUsers.find((a) => a.email === 'ali.rep@sim.local').banned === true);
ok('the profile row is inactive', db.users.find((u) => u.id === REP_ID).active === false);

r = await readJson(await call(handler, { action: 'set-active', user_id: REP_ID, active: true }, asAdmin));
ok('re-enabling lifts the ban',
   r.status === 200 && db.authUsers.find((a) => a.email === 'ali.rep@sim.local').banned === false);

r = await readJson(await call(handler, { action: 'set-active', user_id: ADMIN_ID, active: false }, asAdmin));
ok('an admin cannot disable themselves', r.status === 400, JSON.stringify(r.body));

r = await readJson(await call(handler, { action: 'nonsense' }, asAdmin));
ok('an unknown action is rejected', r.status === 400, JSON.stringify(r.body));

// ---- bootstrap closed when the secret is unset -----------------------------
db.reset();
await loadWith({ SUPABASE_URL: 'fake', SUPABASE_SERVICE_ROLE_KEY: 'k' }); // no bootstrap token
handler = globalThis.__handler;
r = await readJson(await call(handler, { action: 'bootstrap', username: 'anyone', password: 'Adm1nPass!2026' },
  { Authorization: 'Bearer anything' }));
ok('bootstrap is closed when BOOTSTRAP_ADMIN_TOKEN is unset',
   r.status === 403 && r.body.code === 'bootstrap_closed', JSON.stringify(r.body));

// ---- health check + missing credential ------------------------------------
db.reset();
await loadWith(ENV);
handler = globalThis.__handler;
const health = await handler(new Request('http://fn.test/admin-user', { method: 'GET' }));
const healthBody = await health.json();
ok('GET health check reports readiness without touching data',
   health.status === 200 && healthBody.ok && healthBody.hasServiceKey === true
     && healthBody.bootstrapOpen === true,
   JSON.stringify(healthBody));

db.reset();
await loadWith({ SUPABASE_URL: 'fake' }); // no service credential at all
handler = globalThis.__handler;
const noKeyHealth = await (await handler(new Request('http://fn.test/admin-user', { method: 'GET' }))).json();
ok('health check survives a missing service credential',
   noKeyHealth.ok === true && noKeyHealth.hasServiceKey === false,
   JSON.stringify(noKeyHealth));

// bootstrap still works without a service key only if it never touches auth;
// it does, so it must fail with a clear message rather than crash.
db.reset();
await loadWith({ SUPABASE_URL: 'fake', BOOTSTRAP_ADMIN_TOKEN: 't' });
handler = globalThis.__handler;
r = await readJson(await call(handler, { action: 'bootstrap', username: 'someone', password: 'longenough1' },
  { Authorization: 'Bearer t' }));
ok('a missing service credential yields a clear error, not a crash',
   r.status === 500 && /service-role credential/i.test(r.body.error), JSON.stringify(r.body));

// ---- scoped management: supervisors and team leaders ---------------------
db.reset();
await loadWith(ENV);
handler = globalThis.__handler;

// Admin bootstrap, then a leader and an outsider rep in another outlet.
let boot = await readJson(await call(handler,
  { action: 'bootstrap', username: 'boss', password: 'Adm1nPass!2026', full_name: 'Boss', outlet_id: 'outlet-bosaso' },
  { Authorization: 'Bearer bootstrap-secret' }));
ok('scoped: admin bootstrapped for the scope tests', boot.body.ok === true, JSON.stringify(boot.body));

const BOSS = 'boss@sim.local';
const mk = async (username, role, outlet) => {
  const r = await readJson(await call(handler,
    { action: 'create-user', username, password: 'Pass1234!', role, outlet_id: outlet },
    { Authorization: `Bearer ${BOSS}` }));
  return r.body?.user?.id;
};
const leaderId = await mk('lead1', 'team_leader', 'outlet-bosaso');
// Same zone, DIFFERENT outlet: a team leader must be refused, a supervisor
// must be allowed. That pair is what proves the two scopes are distinct.
const farId = await mk('farrep', 'sales_rep', 'outlet-galkacyo');
ok('scoped: admin created a team leader and a far-outlet rep',
   !!leaderId && !!farId, `${leaderId} / ${farId}`);

db.authUsers.push({ id: 'auth-lead1', email: 'lead1@sim.local', password: 'Pass1234!', banned: false });

const CREATE_SAME = { action: 'create-user', username: 'repa', password: 'Pass1234!', role: 'sales_rep', outlet_id: 'outlet-bosaso' };
let r2 = await readJson(await call(handler, CREATE_SAME, { Authorization: 'Bearer lead1@sim.local' }));
ok('scoped: a team leader creates a rep in their own outlet', r2.status === 200, JSON.stringify(r2.body));
const repInOutlet = r2.body?.user?.id;

r2 = await readJson(await call(handler,
  { action: 'create-user', username: 'other', password: 'Pass1234!', role: 'sales_rep', outlet_id: 'outlet-far' },
  { Authorization: 'Bearer lead1@sim.local' }));
ok('scoped: a team leader cannot create in another outlet',
   r2.status === 403, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'create-user', username: 'super2', password: 'Pass1234!', role: 'admin', outlet_id: 'outlet-bosaso' },
  { Authorization: 'Bearer lead1@sim.local' }));
ok('scoped: a team leader cannot create an admin', r2.status === 403, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'set-password', user_id: repInOutlet, password: 'NewPass123!' },
  { Authorization: 'Bearer lead1@sim.local' }));
ok('scoped: a team leader sets a password for their own rep', r2.status === 200, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'set-password', user_id: farId, password: 'NewPass123!' },
  { Authorization: 'Bearer lead1@sim.local' }));
ok('scoped: a team leader cannot set a password outside their outlet',
   r2.status === 403, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'set-active', user_id: farId, active: false },
  { Authorization: 'Bearer lead1@sim.local' }));
ok('scoped: a team leader cannot disable someone outside their outlet',
   r2.status === 403, JSON.stringify(r2.body));

// A supervisor covers the whole zone: both outlets above are in zone z2.
db.authUsers.push({ id: 'auth-sup', email: 'sup@sim.local', password: 'x', banned: false });
db.users.push({ id: 'u-sup', auth_user_id: 'auth-sup', username: 'sup', full_name: 'Sup',
                role: 'supervisor', outlet_id: 'outlet-bosaso', team_leader_id: null, active: true });
r2 = await readJson(await call(handler,
  { action: 'set-password', user_id: farId, password: 'NewPass123!' },
  { Authorization: 'Bearer sup@sim.local' }));
ok('scoped: a supervisor manages anyone in their zone', r2.status === 200, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'create-user', username: 'adm2', password: 'Pass1234!', role: 'admin', outlet_id: 'outlet-bosaso' },
  { Authorization: 'Bearer sup@sim.local' }));
ok('scoped: a supervisor cannot create an admin', r2.status === 403, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'create-user', username: 'sup3', password: 'Pass1234!', role: 'supervisor', outlet_id: 'outlet-bosaso' },
  { Authorization: 'Bearer sup@sim.local' }));
ok('scoped: a supervisor cannot create a supervisor', r2.status === 403, JSON.stringify(r2.body));

// A REGION supervisor has no outlet at all -- this is the shape the website
// creates now, and the thing that used to fail with "outside your zone".
db.authUsers.push({ id: 'auth-bari', email: 'bari@sim.local', password: 'x', banned: false });
db.users.push({ id: 'u-bari', auth_user_id: 'auth-bari', username: 'bari', full_name: 'Bari Sup',
                role: 'supervisor', outlet_id: null, region_id: 'r-bari',
                team_leader_id: null, active: true });

r2 = await readJson(await call(handler,
  { action: 'create-user', username: 'bari_lead', password: 'Pass1234!', role: 'team_leader',
    outlet_id: 'outlet-bosaso' },
  { Authorization: 'Bearer bari@sim.local' }));
ok('region: a supervisor with no outlet creates a team leader in his region',
   r2.status === 200, JSON.stringify(r2.body));
const bariLeader = r2.body?.user?.id;

r2 = await readJson(await call(handler,
  { action: 'create-user', username: 'mudug_rep', password: 'Pass1234!', role: 'sales_rep',
    outlet_id: 'outlet-galkacyo' },
  { Authorization: 'Bearer bari@sim.local' }));
ok('region: a supervisor cannot create in another region (same zone)',
   r2.status === 403, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'create-user', username: 'sool_rep', password: 'Pass1234!', role: 'sales_rep',
    outlet_id: 'outlet-far' },
  { Authorization: 'Bearer bari@sim.local' }));
ok('region: a supervisor cannot create in another zone',
   r2.status === 403, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'set-password', user_id: bariLeader, password: 'NewPass123!' },
  { Authorization: 'Bearer bari@sim.local' }));
ok('region: a supervisor manages a leader he created', r2.status === 200, JSON.stringify(r2.body));

r2 = await readJson(await call(handler,
  { action: 'set-active', user_id: farId, active: false },
  { Authorization: 'Bearer bari@sim.local' }));
ok('region: a supervisor cannot disable someone in another region',
   r2.status === 403, JSON.stringify(r2.body));

// ---------------------------------------------------------------- report
console.log('\n' + '='.repeat(72));
let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '\n        ' + c.detail}`);
  if (c.pass) pass++;
}
console.log('='.repeat(72));
console.log(`${pass}/${checks.length} checks passed`);
process.exit(pass === checks.length ? 0 : 1);
