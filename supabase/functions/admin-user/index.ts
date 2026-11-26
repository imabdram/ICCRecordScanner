// =============================================================================
// admin-user  --  the only server-side code in this project.
//
// Runs on Supabase Edge Functions (Deno). It is the ONE place that holds the
// service-role key, because that key must never reach a browser.
//
// WHY THIS EXISTS
//   Two things the browser cannot safely do:
//     1. create users           -> auth.admin.createUser() needs the service role
//     2. set someone's password -> auth.admin.updateUserById() needs the service role
//   Everything else (reading data, changing your own password) happens directly
//   from the browser through PostgREST + RLS.
//
// ENDPOINTS (all POST, JSON body)
//   { "action": "bootstrap",  ... }   create the FIRST admin, no session needed.
//                                     Requires the BOOTSTRAP_ADMIN_TOKEN secret.
//   { "action": "create-user" }       admin only
//   { "action": "set-password" }      admin only
//   { "action": "set-active" }        admin only (enable / disable a login)
//
// AUTH MODEL
//   Normal actions require a valid user JWT on Authorization. The caller's
//   profile is then loaded with the service role and must have role = 'admin'.
//   We never trust a role claim from the client.
//
// WHY NO TRIGGER ON auth.users
//   Supabase's most common cause of "Database error saving new user" (500) is a
//   trigger on auth.users. We insert the public.users row explicitly here
//   instead, and clean it up if the insert fails.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

// Supabase is migrating projects from JWT-based keys to the newer
// publishable/secret pair. Projects created recently expose a secret key
// (`sb_secret_...`) rather than the legacy service_role JWT. Edge Functions
// still inject SUPABASE_SERVICE_ROLE_KEY on older projects, so accept whichever
// is present instead of hard-failing on a rename.
const SERVICE_ROLE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  Deno.env.get('SUPABASE_SECRET_KEY') ??
  '';

const BOOTSTRAP_ADMIN_TOKEN = Deno.env.get('BOOTSTRAP_ADMIN_TOKEN');

if (!SERVICE_ROLE_KEY) {
  // Fail loudly at invocation time rather than at cold start: a missing secret
  // should show up in the function logs as a clear message, not a blank 500.
  console.error(
    'admin-user: neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_SECRET_KEY is set. ' +
    'Admin actions cannot work without a service-role credential.',
  );
}

// The synthetic email suffix. The website turns "yacquub" into
// "yacquub@sim.local" before calling signInWithPassword. sim.local never
// receives mail -- that is fine, because this system never relies on email.
const EMAIL_DOMAIN = Deno.env.get('USERNAME_EMAIL_DOMAIN') ?? 'sim.local';

const ROLES = ['admin', 'supervisor', 'team_leader', 'sales_rep'];

// Service-role client: bypasses RLS. Used for admin API calls and for reading
// the caller's profile (which RLS would otherwise be able to hide).
//
// Built lazily-ish: if the credential is missing, every call throws a clear
// error instead of crashing the whole function at cold start. That keeps the
// GET health check usable while the project is still being configured.
function makeAdminClient() {
  if (!SERVICE_ROLE_KEY) {
    const boom = () => {
      throw new Error(
        'No service-role credential is configured for this function. ' +
        'Set SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in Edge Function secrets.',
      );
    };
    return {
      from: boom,
      auth: { getUser: boom, admin: { createUser: boom, updateUserById: boom, deleteUser: boom } },
    } as any;
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const admin = makeAdminClient();

// ---------------------------------------------------------------- CORS
// The website is served from a different origin, so every response needs these.
// Authorization is a header the browser preflights, hence its inclusion.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function fail(message: string, status = 400, code?: string): Response {
  return json({ ok: false, error: message, code }, status);
}

// ---------------------------------------------------------------- helpers

/** Turns a username into the synthetic email the auth service stores. */
function emailFor(username: string): string {
  return `${username}@${EMAIL_DOMAIN}`;
}

/** Lowercase, trimmed username. Mirrors the unique index on lower(username). */
function normaliseUsername(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

function validUsername(u: string): boolean {
  // Short, typo-resistant, safe as an email local part.
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u);
}

function validPassword(p: string): boolean {
  // Supabase's own floor is 6; we hold the line at 8 because these accounts
  // are created by an administrator and never self-serve a reset.
  return typeof p === 'string' && p.length >= 8;
}

/**
 * Resolves the caller to a public.users row using the caller's own JWT.
 * Returns null when the token is missing/invalid or the profile does not exist.
 */
async function callerProfile(req: Request) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { profile: null, reason: 'missing token' };

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) {
    return { profile: null, reason: 'invalid token' };
  }

  const { data, error } = await admin
    .from('users')
    .select('id, auth_user_id, username, full_name, role, outlet_id, region_id, active')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();

  if (error) return { profile: null, reason: `profile lookup failed: ${error.message}` };
  if (!data) return { profile: null, reason: 'no profile row for this account' };
  if (!data.active) return { profile: null, reason: 'this account is disabled' };
  return { profile: data, reason: null };
}

/** Loads an outlet and its region/zone, or explains why it cannot. */
async function resolveOutlet(outletId: string | null | undefined) {
  if (!outletId) return { outlet: null, error: null }; // admins may have none
  const { data, error } = await admin
    .from('outlets')
    .select('id, name, region_id, regions(id, name, zone_id, zones(id, name))')
    .eq('id', outletId)
    .maybeSingle();
  if (error) return { outlet: null, error: error.message };
  if (!data) return { outlet: null, error: 'That outlet does not exist.' };
  return { outlet: data, error: null };
}

/** Where a given user sits in the tree, or null when they have no outlet. */
async function scopeOf(userId: string) {
  const { data, error } = await admin
    .from('users')
    .select('id, role, outlet_id, region_id, outlets(id, region_id, regions(id, zone_id))')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const outlet: any = (data as any).outlets;
  return {
    id: data.id,
    role: data.role,
    outlet_id: data.outlet_id,
    // A supervisor has no outlet, so the region is the scope that matters.
    region_id: (data as any).region_id ?? outlet?.region_id ?? null,
    zone_id: outlet?.regions?.zone_id ?? null,
  };
}

/**
 * May `caller` administer `target`?
 *
 *   admin        everyone
 *   supervisor   their own zone
 *   team leader  their own outlet
 *
 * Mirrors the database policies. The UI hides what a role cannot do; this is
 * the check that actually holds, because a modified client can call the
 * function directly.
 */
async function canAdminister(caller: any, targetId: string) {
  if (caller.role === 'admin') return { ok: true, error: null };
  if (caller.id === targetId) {
    return { ok: false, error: 'Change your own account from Settings.' };
  }

  const target = await scopeOf(targetId);
  if (!target) return { ok: false, error: 'User not found.' };

  // Never let a non-admin touch an administrator.
  if (target.role === 'admin') {
    return { ok: false, error: 'Only an administrator can manage an administrator.' };
  }

  const mine = await scopeOf(caller.id);
  if (!mine) return { ok: false, error: 'Your account has no outlet assigned.' };

  if (caller.role === 'supervisor') {
    // Region first: a supervisor covers every outlet in their region. The zone
    // check stays as a fallback for accounts created before regions existed.
    const sameRegion = mine.region_id && mine.region_id === target.region_id;
    const sameZone = mine.zone_id && mine.zone_id === target.zone_id;
    return sameRegion || sameZone
      ? { ok: true, error: null }
      : { ok: false, error: 'That person is outside your region.' };
  }
  if (caller.role === 'team_leader') {
    const sameOutlet = mine.outlet_id && mine.outlet_id === target.outlet_id;
    return sameOutlet
      ? { ok: true, error: null }
      : { ok: false, error: 'That person is outside your outlet.' };
  }
  return { ok: false, error: 'Your role cannot manage accounts.' };
}

/** Constant-time-ish comparison for the bootstrap token. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- handlers

/** Creates the very first admin. Works with no session, only the bootstrap token. */
async function handleBootstrap(body: any, req: Request): Promise<Response> {
  if (!BOOTSTRAP_ADMIN_TOKEN) {
    return fail(
      'Bootstrap is closed. Set the BOOTSTRAP_ADMIN_TOKEN secret to enable it, ' +
      'and unset it again once the first admin exists.',
      403,
      'bootstrap_closed',
    );
  }

  const provided = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    || String(body.bootstrap_token ?? '');
  if (!provided || !tokensMatch(provided, BOOTSTRAP_ADMIN_TOKEN)) {
    return fail('Bootstrap token is wrong.', 401, 'bad_bootstrap_token');
  }

  // Refuse once any admin exists: bootstrap is a one-time door.
  const { count, error: countError } = await admin
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin');
  if (countError) return fail(`Could not check for existing admins: ${countError.message}`, 500);
  if ((count ?? 0) > 0) {
    return fail(
      'An administrator already exists. Sign in as that admin instead, ' +
      'and unset BOOTSTRAP_ADMIN_TOKEN.',
      409,
      'admin_exists',
    );
  }

  const username = normaliseUsername(body.username);
  if (!validUsername(username)) return fail('Username must be 3-32 chars: a-z, 0-9, dot, dash, underscore.', 400);
  if (!validPassword(body.password)) return fail('Password must be at least 8 characters.', 400);

  const { outlet, error: outletError } = await resolveOutlet(body.outlet_id);
  if (outletError) return fail(outletError, 400);

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: emailFor(username),
    password: body.password,
    email_confirm: true, // no email flow exists; confirm immediately
    user_metadata: { username },
  });
  if (createError || !created?.user) {
    return fail(`Could not create the login: ${createError?.message ?? 'unknown error'}`, 400);
  }

  const { data: profile, error: profileError } = await admin
    .from('users')
    .insert({
      auth_user_id: created.user.id,
      username,
      full_name: String(body.full_name ?? '').trim(),
      phone: String(body.phone ?? '').trim(),
      role: 'admin',
      outlet_id: outlet?.id ?? null,
      active: true,
    })
    .select('id, username, full_name, role, outlet_id')
    .single();

  if (profileError) {
    // Leaving an orphaned auth account behind would make a retry fail with
    // "email already registered", which is confusing to debug. Undo it.
    await admin.auth.admin.deleteUser(created.user.id);
    return fail(`Could not save the profile: ${profileError.message}`, 500);
  }

  return json({
    ok: true,
    user: profile,
    message: 'Administrator created. Unset BOOTSTRAP_ADMIN_TOKEN now.',
  });
}

/** Admin: create a normal user. */
async function handleCreateUser(body: any, caller: any): Promise<Response> {
  const username = normaliseUsername(body.username);
  if (!validUsername(username)) {
    return fail('Username must be 3-32 chars: a-z, 0-9, dot, dash, underscore.', 400);
  }
  const password = String(body.password ?? '');
  if (!validPassword(password)) return fail('Password must be at least 8 characters.', 400);

  const role = String(body.role ?? 'sales_rep');
  if (!ROLES.includes(role)) return fail(`Role must be one of: ${ROLES.join(', ')}.`, 400);

  const { outlet, error: outletError } = await resolveOutlet(body.outlet_id);
  if (outletError) return fail(outletError, 400);

  // Only an admin may create another admin or a supervisor. The database
  // enforces this too (schema v9), but a clear 403 beats a policy violation.
  if ((role === 'admin' || role === 'supervisor') && caller.role !== 'admin') {
    return fail('Only an administrator can create an administrator or supervisor.', 403);
  }

  // Supervisors and team leaders may only create people inside their own
  // scope. The database enforces this too, but a clear error beats a 500.
  if (caller.role !== 'admin' && outlet) {
    if (caller.role === 'supervisor') {
      // The supervisor's own region, not their (absent) outlet.
      const targetRegion = (outlet as any).region_id;
      if (!caller.region_id || String(targetRegion) !== String(caller.region_id)) {
        return fail('That outlet is outside your region.', 403);
      }
    }
    if (caller.role === 'team_leader' && caller.outlet_id !== outlet.id) {
      return fail('You can only add people to your own outlet.', 403);
    }
  }

  // A team leader may only have themselves as the leader.
  let teamLeaderId: string | null = (body.team_leader_id as string) || null;
  if (caller.role === 'team_leader') teamLeaderId = caller.id;

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: emailFor(username),
    password,
    email_confirm: true,
    user_metadata: { username },
  });
  if (createError || !created?.user) {
    const m = createError?.message ?? 'unknown error';
    if (/already been registered|already exists|duplicate/i.test(m)) {
      return fail(`The username "${username}" is already taken.`, 409, 'username_taken');
    }
    return fail(`Could not create the login: ${m}`, 400);
  }

  const { data: profile, error: profileError } = await admin
    .from('users')
    .insert({
      auth_user_id: created.user.id,
      username,
      full_name: String(body.full_name ?? '').trim(),
      phone: String(body.phone ?? '').trim(),
      role,
      outlet_id: outlet?.id ?? null,
      // A supervisor is scoped by region, not outlet.
      region_id: body.region_id ?? outlet?.region_id ?? null,
      team_leader_id: teamLeaderId,
      active: body.active === false ? false : true,
    })
    .select('id, username, full_name, role, outlet_id, team_leader_id, active')
    .single();

  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    if (/duplicate key/i.test(profileError.message)) {
      return fail(`The username "${username}" is already taken.`, 409, 'username_taken');
    }
    return fail(`Could not save the profile: ${profileError.message}`, 500);
  }

  return json({ ok: true, user: profile });
}

/** Admin/supervisor/team leader: set someone's password, inside their scope. */
async function handleSetPassword(body: any, caller: any): Promise<Response> {
  const userId = String(body.user_id ?? '');
  const password = String(body.password ?? '');
  if (!userId) return fail('user_id is required.', 400);
  if (!validPassword(password)) return fail('Password must be at least 8 characters.', 400);

  const scope = await canAdminister(caller, userId);
  if (!scope.ok) return fail(scope.error!, 403);

  const { data: target, error: targetError } = await admin
    .from('users')
    .select('id, auth_user_id, username, role')
    .eq('id', userId)
    .maybeSingle();
  if (targetError) return fail(targetError.message, 500);
  if (!target) return fail('User not found.', 404);

  const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, { password });
  if (error) return fail(`Could not set the password: ${error.message}`, 400);

  return json({ ok: true, username: target.username });
}

/** Admin/supervisor/team leader: enable or disable a login, inside their scope. */
async function handleSetActive(body: any, caller: any): Promise<Response> {
  const userId = String(body.user_id ?? '');
  const active = Boolean(body.active);
  if (!userId) return fail('user_id is required.', 400);
  if (userId === caller.id) return fail('You cannot disable your own account.', 400);

  const scope = await canAdminister(caller, userId);
  if (!scope.ok) return fail(scope.error!, 403);

  const { data: target, error: targetError } = await admin
    .from('users')
    .select('id, auth_user_id, username, role')
    .eq('id', userId)
    .maybeSingle();
  if (targetError) return fail(targetError.message, 500);
  if (!target) return fail('User not found.', 404);
  if (target.role === 'admin' && caller.role !== 'admin') {
    return fail('Only an administrator can change an administrator.', 403);
  }

  const { error: profileError } = await admin
    .from('users')
    .update({ active })
    .eq('id', userId);
  if (profileError) return fail(profileError.message, 500);

  // `active` alone hides the person from the app, but their password would
  // still work against Supabase Auth. Ban the login too so "disabled" really
  // means disabled. ('none' lifts a ban.)
  const { error: banError } = await admin.auth.admin.updateUserById(target.auth_user_id, {
    ban_duration: active ? 'none' : '876000h', // ~100 years
  });
  if (banError) {
    return fail(`Profile updated but the login could not be ${active ? 'enabled' : 'disabled'}: ${banError.message}`, 500);
  }

  return json({ ok: true, username: target.username, active });
}

// ---------------------------------------------------------------- entrypoint

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // Deployment check. Deliberately touches no data and reveals only booleans,
  // so it is safe to call while the system is still being set up.
  if (req.method === 'GET') {
    return json({
      ok: true,
      function: 'admin-user',
      hasServiceKey: Boolean(SERVICE_ROLE_KEY),
      bootstrapOpen: Boolean(BOOTSTRAP_ADMIN_TOKEN),
      actions: ['bootstrap', 'create-user', 'set-password', 'set-active'],
    });
  }

  if (req.method !== 'POST') return fail('Use POST.', 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail('Body must be JSON.', 400);
  }

  const action = String(body?.action ?? '');

  try {
    if (action === 'bootstrap') return await handleBootstrap(body, req);

    // Everything else needs a signed-in user who may manage accounts.
    const { profile, reason } = await callerProfile(req);
    if (!profile) return fail(`Not signed in${reason ? ` (${reason})` : ''}.`, 401);
    if (!['admin', 'supervisor', 'team_leader'].includes(profile.role)) {
      return fail('Your role cannot manage accounts.', 403);
    }

    switch (action) {
      case 'create-user':
        return await handleCreateUser(body, profile);
      case 'set-password':
        return await handleSetPassword(body, profile);
      case 'set-active':
        return await handleSetActive(body, profile);
      default:
        return fail(
          `Unknown action "${action}". Use bootstrap, create-user, set-password or set-active.`,
          400,
        );
    }
  } catch (e) {
    // Never leak a stack trace to the client; log it for the function logs.
    console.error('admin-user failed', e);
    return fail(`Unexpected error: ${(e as Error).message}`, 500);
  }
});
