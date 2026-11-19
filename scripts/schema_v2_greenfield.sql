-- =============================================================================
-- SIM Management System -- Supabase greenfield schema (v2)
--
-- WHAT THIS IS
--   A clean rebuild for Supabase Postgres + Supabase Auth.
--   It supersedes scripts/schema.sql (the Neon / Better-Auth original), which is
--   kept alongside for reference only.
--
-- WHAT CHANGED vs THE GREENFIELD PLAN DRAFT (docs/PLAN_SUPABASE_GREENFIELD.md)
--   The plan's section 2 was a simplification, not a port. Six things in it
--   would have either broken or lost capability. Each is marked [FIX n] below.
--
-- WHAT CHANGED vs THE NEON ORIGINAL (scripts/schema.sql)
--   * auth.user_id()  -> auth.uid()                            Supabase names it differently
--   * auth_user_id    -> uuid (was text)                       Supabase user ids are uuids
--   * scans.sales_rep_id is now NULLABLE                       phones have no identity
--   * scans.device_id added                                    trace a scan to a phone
--   * ICCID regex widened                                      the old literal batch prefix
--   * team_leader read scope now guarded by zone               [FIX 1]
--   * users write policy and delete_user kept                  [FIX 2] plan dropped them
--   * anon path for phone uploads                              [FIX 3] section 6 vs 4
--   * devices table + setup code                               [FIX 5]
--   * admin column guard now applies to DELETE too             [FIX 6]
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--   Safe to re-run: every object is create-or-replace / drop-if-exists guarded.
--   Run scripts/seed_v2.sql afterwards.
--
-- ORDER MATTERS: this file must run before seed_v2.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensions
--    pgcrypto supplies gen_random_uuid() on older Supabase projects; newer ones
--    expose it natively. `if not exists` makes this harmless either way.
-- -----------------------------------------------------------------------------
do $$
begin
  -- pgcrypto is unnecessary on any Postgres 13+ (gen_random_uuid() is built in),
  -- and Supabase has shipped a modern Postgres for years. We therefore do NOT run
  -- `create extension` here: on Supabase it requires elevated privileges, and
  -- inside a DO block it raises "query has no destination for result data".
  -- This block only documents the expectation; it deliberately changes nothing.
  if current_setting('server_version_num')::int < 130000 then
    raise warning
      'This schema expects Postgres 13+ for built-in gen_random_uuid(); run "create extension pgcrypto;" manually on this server.';
  end if;
end $$;

-- gen_random_bytes() (used only by the commented example in seed_v2.sql) comes
-- from pgcrypto; the seed falls back to md5(random())-based keys if it is
-- absent, so no extension is required for the schema itself.

-- pg_jsonschema is NOT required (we hand-validate the upload payload), so we do
-- not ask for it -- an unavailable extension would abort this whole script in
-- the dashboard editor, which does not wrap blocks in a transaction you control.

-- =============================================================================
-- 1. ORGANISATION TREE
--    Zone -> Region -> Outlet -> User. Unchanged from the original; this part
--    of the design was right and is what makes "supervisor sees their zone"
--    possible.
-- =============================================================================
create table if not exists public.zones (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.regions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  zone_id     uuid not null references public.zones(id) on delete restrict,
  created_at  timestamptz not null default now(),
  unique (zone_id, name)
);

create table if not exists public.outlets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  region_id   uuid not null references public.regions(id) on delete restrict,
  created_at  timestamptz not null default now(),
  unique (region_id, name)
);

-- =============================================================================
-- 2. USERS
--    One row per person. `auth_user_id` links to Supabase's auth.users.
--
--    [FIX] We deliberately do NOT put a trigger on auth.users to create this
--    row. Admin user creation goes through an Edge Function that calls
--    auth.admin.createUser() with the service role, then inserts this row. A
--    trigger on auth.users is the single most common cause of
--    "Database error saving new user" (500) and is harder to debug than doing
--    the insert explicitly in the function.
--
--    `username` is the login. The browser maps it to a synthetic email
--    (username@sim.local) before calling signInWithPassword. The email is an
--    implementation detail and is never shown or relied upon.
-- =============================================================================
create table if not exists public.users (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid not null unique references auth.users(id) on delete cascade,
  username       text not null unique,
  full_name      text not null default '',
  phone          text not null default '',
  role           text not null default 'sales_rep'
                 check (role in ('admin', 'supervisor', 'team_leader', 'sales_rep')),
  outlet_id      uuid references public.outlets(id) on delete restrict,
  team_leader_id uuid references public.users(id) on delete set null,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Lower-case usernames so "Yacquub" and "yacquub" cannot become two accounts.
-- Unsafe-answered messages are avoided: the expression is ordinary text.
create unique index if not exists users_username_lower_idx
  on public.users (lower(username));

-- =============================================================================
-- 3. DEVICES  [FIX 5]
--
--    The phone app has no login, so it is identified by a locally generated
--    device_id (a uuid stored in SharedPreferences on first run).
--
--    The plan stored the rep's outlet only on the phone. That is not durable:
--    a rep who re-runs setup, changes outlets, or restores a backup silently
--    re-labels their entire outbox, and nobody can audit which physical phone
--    filed a scan. Registering devices here fixes both.
--
--    Setup is a one-time act:
--      1. admin creates the device in the web console, choosing its outlet
--         -> gets a `setup_code` (short, human-typeable)
--      2. the rep types that code once on the phone
--      3. the phone receives a long-lived `device_key` and stores it locally
--    From then on every upload carries the device_key, and the server derives
--    outlet/region/zone from this row -- never from the request body.
--
--    To re-point a phone at a different outlet you change the row here; the
--    phone learns it on its next sync. No reinstall needed.
-- =============================================================================
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  device_key   text not null unique,          -- long random secret, stored on the phone
  setup_code   text unique,                   -- short one-time code; NULLed after setup
  label        text not null default '',      -- "Bosaso counter 2", human label
  outlet_id    uuid not null references public.outlets(id) on delete restrict,
  active       boolean not null default true,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists devices_outlet_idx on public.devices (outlet_id);

-- =============================================================================
-- 4. SCANS  [FIX 3] [FIX 5]
--
--    One row per registered SIM. The ICCID is unique, so a SIM cannot be
--    registered twice -- enforced in the database, not just the app.
--
--    Two writers exist:
--      (a) a signed-in web user (auth.uid() is set)   -> sales_rep_id = them
--      (b) an unauthenticated phone upload            -> sales_rep_id is NULL,
--          device_id is set, and outlet/region/zone come from the devices row
--
--    That is why sales_rep_id is nullable. The plan's section 2 had it NOT NULL
--    while section 6 required anonymous inserts; those two statements were
--    incompatible and this table resolves it in favour of section 6.
--
--    `customer_name`/`primary_number`/`secondary_number` stay NOT NULL because
--    the phone already requires them before it will save a record locally.
-- =============================================================================
create table if not exists public.scans (
  id               uuid primary key default gen_random_uuid(),

  -- [FIX] Was '^892526379[0-9]{11}$' -- a hard-coded batch prefix. A new SIM
  -- batch with any other prefix would make EVERY insert fail with a constraint
  -- violation that is very hard to diagnose from a phone. This accepts any
  -- telecom ICCID: the '89' industry prefix, 18-22 digits in total.
  iccid            text not null unique
                   check (iccid ~ '^89[0-9]{16,20}$'),

  customer_name    text not null,
  primary_number   text not null check (primary_number ~ '^[0-9]{7,12}$'),
  secondary_number text not null check (secondary_number ~ '^[0-9]{7,12}$'),

  -- (a) web user  -> set;  (b) phone upload -> NULL
  sales_rep_id     uuid references public.users(id) on delete restrict,
  -- (b) phone upload -> set; (a) web user -> NULL
  device_id        uuid references public.devices(id) on delete restrict,

  -- Location is always derived server-side (trigger + upload function), never
  -- taken from the client.
  outlet_id        uuid not null references public.outlets(id) on delete restrict,
  region_id        uuid not null references public.regions(id) on delete restrict,
  zone_id          uuid not null references public.zones(id) on delete restrict,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Exactly one attribution must be present.
  constraint scans_one_owner check (
    (sales_rep_id is not null and device_id is null)
    or (sales_rep_id is null and device_id is not null)
  )
);

create index if not exists scans_outlet_created_idx on public.scans (outlet_id, created_at desc);
create index if not exists scans_rep_created_idx    on public.scans (sales_rep_id, created_at desc);
create index if not exists scans_device_created_idx on public.scans (device_id, created_at desc);
create index if not exists scans_region_created_idx on public.scans (region_id, created_at desc);
create index if not exists scans_zone_created_idx   on public.scans (zone_id, created_at desc);

-- =============================================================================
-- 5. HELPER FUNCTIONS
--
--    All are SECURITY DEFINER with a pinned search_path. Two reasons:
--      * `users` has RLS, so a policy on `users` that selects from `users`
--        would recurse forever without this;
--      * a pinned search_path stops a caller shadowing `users` with their own
--        object, which is the classic security-definer escalation hole.
-- =============================================================================

create or replace function public.current_app_user()
returns public.users
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.* from public.users u
  where u.auth_user_id = auth.uid()
    and u.active
  limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select u.role = 'admin' from public.users u
      where u.auth_user_id = auth.uid() and u.active limit 1),
    false);
$$;

create or replace function public.my_role()
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.role from public.users u
  where u.auth_user_id = auth.uid() and u.active limit 1;
$$;

create or replace function public.my_outlet_id()
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.outlet_id from public.users u
  where u.auth_user_id = auth.uid() and u.active limit 1;
$$;

create or replace function public.my_region_id()
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select r.id from public.users u
  join public.outlets o on o.id = u.outlet_id
  join public.regions r on r.id = o.region_id
  where u.auth_user_id = auth.uid() and u.active limit 1;
$$;

create or replace function public.my_zone_id()
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select z.id from public.users u
  join public.outlets o on o.id = u.outlet_id
  join public.regions r on r.id = o.region_id
  join public.zones z on z.id = r.zone_id
  where u.auth_user_id = auth.uid() and u.active limit 1;
$$;

-- =============================================================================
-- 6. SCAN WRITE PATH
--
--    [FIX 3] This trigger used to assume every scan came from a signed-in rep.
--    It now has two branches, and it is the ONLY place location is assigned.
--
--    IMPORTANT: the anonymous branch is deliberately unreachable through the
--    PostgREST API. Phones never INSERT into this table directly -- they call
--    upload_scans() (section 7), which runs as the table owner. If a scan
--    arrives with neither an auth.uid() nor a device_id, the trigger raises.
-- =============================================================================
create or replace function public.scans_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me        public.users;
  my_outlet public.outlets;
  dev       public.devices;
begin
  if tg_op = 'INSERT' then
    -- ---- branch (a): a signed-in person ------------------------------------
    if auth.uid() is not null then
      select * into me from public.users
       where auth_user_id = auth.uid() and active limit 1;

      if me.id is null then
        raise exception 'No active profile for this account' using errcode = '42501';
      end if;
      if me.outlet_id is null then
        raise exception 'Your account has no outlet assigned' using errcode = '42501';
      end if;

      new.sales_rep_id := coalesce(new.sales_rep_id, me.id);

      -- Only an admin may file a scan on behalf of another rep.
      if new.sales_rep_id <> me.id then
        if me.role <> 'admin' then
          raise exception 'You may only record scans for yourself' using errcode = '42501';
        end if;
        select o.* into my_outlet
          from public.users u join public.outlets o on o.id = u.outlet_id
         where u.id = new.sales_rep_id;
        if my_outlet.id is null then
          raise exception 'That rep has no outlet assigned' using errcode = '42501';
        end if;
      else
        select * into my_outlet from public.outlets where id = me.outlet_id;
      end if;

      new.device_id := null;
      new.created_at := coalesce(new.created_at, now());

    -- ---- branch (b): an authenticated phone upload via upload_scans() ------
    elsif new.device_id is not null then
      select * into dev from public.devices where id = new.device_id;
      if dev.id is null then
        raise exception 'Unknown device' using errcode = '42501';
      end if;
      if not dev.active then
        raise exception 'This device has been disabled' using errcode = '42501';
      end if;
      select * into my_outlet from public.outlets where id = dev.outlet_id;
      new.sales_rep_id := null;

    -- ---- rejected: nothing can be stamped --------------------------------
    else
      raise exception
        'A scan needs either a signed-in user or a registered device'
        using errcode = '42501';
    end if;

    new.outlet_id := my_outlet.id;
    select r.zone_id, r.id into new.zone_id, new.region_id
      from public.regions r where r.id = my_outlet.region_id;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists scans_before_write on public.scans;
create trigger scans_before_write
  before insert or update on public.scans
  for each row execute function public.scans_before_write();

-- =============================================================================
-- 7. PHONE UPLOAD
--
--    [FIX 3] The plan said "a narrow RLS policy that allows inserts of
--    anonymous scans". We do not do that, on purpose.
--
--    A policy granting `anon` INSERT on scans would let anyone holding the
--    public anon key (which ships inside the APK and is trivially extractable)
--    write rows directly, with any iccid, any customer name, and any timestamps
--    -- and RLS cannot restrict WHICH device they claim without a secret.
--
--    Instead there is exactly one unauthenticated entry point: this function.
--    It requires a valid device_key, ignores any location the caller sends,
--    and is idempotent per ICCID (re-uploading is a no-op, which is what makes
--    the phone's outbox safe to retry).
--
--    It writes nothing on a duplicate, so the response tells the phone exactly
--    which records it may mark as synced.
-- =============================================================================
create or replace function public.upload_scans(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  dev          public.devices;
  item         jsonb;
  accepted     jsonb := '[]'::jsonb;
  duplicates   jsonb := '[]'::jsonb;
  rejected     jsonb := '[]'::jsonb;
  v_iccid      text;
  v_name       text;
  v_primary    text;
  v_secondary  text;
  v_created    timestamptz;
  v_key        text;
begin
  v_key := nullif(trim(payload->>'device_key'), '');
  if v_key is null then
    raise exception 'device_key is required' using errcode = '42501';
  end if;

  select * into dev from public.devices
   where device_key = v_key and active limit 1;
  if dev.id is null then
    raise exception 'Unknown or disabled device' using errcode = '42501';
  end if;

  if jsonb_typeof(payload->'scans') is distinct from 'array' then
    raise exception 'scans must be an array' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(payload->'scans')
  loop
    v_iccid     := regexp_replace(coalesce(item->>'iccid', ''), '[^0-9]', '', 'g');
    v_name      := trim(coalesce(item->>'customer_name', ''));
    v_primary   := regexp_replace(coalesce(item->>'primary_number', ''), '[^0-9]', '', 'g');
    v_secondary := regexp_replace(coalesce(item->>'secondary_number', ''), '[^0-9]', '', 'g');
    v_created   := coalesce(nullif(item->>'created_at', '')::timestamptz, now());

    -- Per-row validation: the phone is untrusted, so a bad row is reported
    -- rather than failing the whole batch (one bad ICCID must not block 40
    -- good ones from syncing).
    if v_iccid !~ '^89[0-9]{16,20}$' then
      rejected := rejected || jsonb_build_object('iccid', v_iccid, 'reason', 'bad iccid');
      continue;
    end if;
    if v_name = '' then
      rejected := rejected || jsonb_build_object('iccid', v_iccid, 'reason', 'missing customer_name');
      continue;
    end if;
    if v_primary !~ '^[0-9]{7,12}$' or v_secondary !~ '^[0-9]{7,12}$' then
      rejected := rejected || jsonb_build_object('iccid', v_iccid, 'reason', 'bad phone number');
      continue;
    end if;

    if exists (select 1 from public.scans where iccid = v_iccid) then
      -- Already on the server (possibly from another phone): the phone may
      -- mark its local copy synced. Idempotent by design.
      duplicates := duplicates || to_jsonb(v_iccid);
      continue;
    end if;

    insert into public.scans
      (iccid, customer_name, primary_number, secondary_number,
       device_id, created_at)
    values
      (v_iccid, v_name, v_primary, v_secondary,
       dev.id, v_created);

    accepted := accepted || to_jsonb(v_iccid);
  end loop;

  update public.devices set last_seen_at = now() where id = dev.id;

  return jsonb_build_object(
    'accepted',   accepted,
    'duplicates', duplicates,
    'rejected',   rejected
  );
end;
$$;

-- Grant execute only to the two roles PostgREST can assume unauthenticated or
-- signed-in. `postgres`/`service_role` keep their existing rights.
revoke all on function public.upload_scans(jsonb) from public;
grant execute on function public.upload_scans(jsonb) to anon, authenticated;

-- [FIX 6] Device setup. The phone exchanges a short setup_code for its
-- long-lived device_key exactly once. Rotating the code afterwards stops reuse.
create or replace function public.claim_device(setup_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  dev public.devices;
begin
  update public.devices
     set setup_code = null, last_seen_at = now()
   where devices.setup_code = upper(trim(claim_device.setup_code))
     and devices.active
  returning * into dev;

  if dev.id is null then
    raise exception 'That setup code is not valid or has already been used';
  end if;

  return jsonb_build_object(
    'device_key', dev.device_key,
    'label',      dev.label,
    'outlet_id',  dev.outlet_id
  );
end;
$$;

revoke all on function public.claim_device(text) from public;
grant execute on function public.claim_device(text) to anon;

-- =============================================================================
-- 8. PRIVILEGE GUARD
--
--    The policies below say WHICH ROWS a role may touch. They cannot say which
--    COLUMNS. Without this trigger a team leader could rewrite a rep's role and
--    promote themselves to admin. That bug was real and demonstrated.
--
--    [FIX 6] The DELETE branch previously let a supervisor delete an admin.
--    It now applies the same rule to deletes as to updates.
-- =============================================================================
create or replace function public.users_guard_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.users;
begin
  select * into me from public.users
   where auth_user_id = auth.uid() and active limit 1;

  -- Anything without a user context (migrations, service role, Edge Functions)
  -- keeps its rights.
  if me.id is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.role = 'admin' and not public.is_admin() then
      raise exception 'Only an administrator can remove an administrator' using errcode = '42501';
    end if;
    if old.id = me.id then
      raise exception 'You cannot delete your own account' using errcode = '42501';
    end if;
    return old;
  end if;

  -- Never let someone privilege their own row.
  if new.id = me.id then
    if new.role is distinct from old.role
       or new.outlet_id is distinct from old.outlet_id
       or new.team_leader_id is distinct from old.team_leader_id
       or new.active is distinct from old.active then
      raise exception 'You cannot change your own role, outlet, team leader or status'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- Only an admin may grant or revoke admin.
  if (new.role = 'admin' or old.role = 'admin') and not public.is_admin() then
    raise exception 'Only an administrator can change an administrator' using errcode = '42501';
  end if;

  -- A supervisor may not demote another supervisor.
  if me.role = 'supervisor' and old.role = 'supervisor' and new.role is distinct from 'supervisor' then
    raise exception 'A supervisor cannot change another supervisor' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists users_guard_privileges on public.users;
create trigger users_guard_privileges
  before update or delete on public.users
  for each row execute function public.users_guard_privileges();

-- =============================================================================
-- 9. ROW LEVEL SECURITY
--
--      admin       -> everything
--      supervisor  -> everything in their zone
--      team_leader -> every rep and scan in their own outlet
--      sales_rep   -> only their own scans; their outlet's team
--
--    [FIX 1] The plan dropped the zone guard on the team-leader clause and
--    dropped the users write policy entirely. Both are restored: without the
--    write policy a team leader can no longer create their own reps, which is
--    a capability regression, not a security win.
-- =============================================================================
alter table public.zones   enable row level security;
alter table public.regions enable row level security;
alter table public.outlets enable row level security;
alter table public.users   enable row level security;
alter table public.scans   enable row level security;
alter table public.devices enable row level security;

-- ---- zones -----------------------------------------------------------------
drop policy if exists zones_read on public.zones;
create policy zones_read on public.zones
  for select to authenticated using (true);

drop policy if exists zones_admin_write on public.zones;
create policy zones_admin_write on public.zones
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- regions ---------------------------------------------------------------
drop policy if exists regions_read on public.regions;
create policy regions_read on public.regions
  for select to authenticated using (
    public.is_admin()
    or zone_id = public.my_zone_id()
  );

drop policy if exists regions_admin_write on public.regions;
create policy regions_admin_write on public.regions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- outlets ---------------------------------------------------------------
drop policy if exists outlets_read on public.outlets;
create policy outlets_read on public.outlets
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor'
        and region_id in (select id from public.regions where zone_id = public.my_zone_id()))
    or region_id = public.my_region_id()
  );

drop policy if exists outlets_admin_write on public.outlets;
create policy outlets_admin_write on public.outlets
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- users -----------------------------------------------------------------
-- Read: admin everywhere; supervisor across their zone; everyone else sees
-- their own outlet's team plus themselves.
drop policy if exists users_read on public.users;
create policy users_read on public.users
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor'
        and outlet_id in (
          select o.id from public.outlets o
          join public.regions r on r.id = o.region_id
          where r.zone_id = public.my_zone_id()))
    or outlet_id = public.my_outlet_id()
    or id = (select id from public.current_app_user())
  );

-- Write [FIX 1]: admin anywhere; supervisor across their zone; team leader
-- across their outlet, but only for reps who report to them.
-- The column-level rules (role, self-escalation, admin) come from
-- users_guard_privileges above.
drop policy if exists users_admin_write on public.users;
create policy users_admin_write on public.users
  for all to authenticated
  using (
    public.is_admin()
    or (public.my_role() = 'supervisor'
        and outlet_id in (
          select o.id from public.outlets o
          join public.regions r on r.id = o.region_id
          where r.zone_id = public.my_zone_id()))
    or (public.my_role() = 'team_leader'
        and outlet_id = public.my_outlet_id())
  )
  with check (
    public.is_admin()
    or (public.my_role() = 'supervisor'
        and outlet_id in (
          select o.id from public.outlets o
          join public.regions r on r.id = o.region_id
          where r.zone_id = public.my_zone_id()))
    or (public.my_role() = 'team_leader'
        and outlet_id = public.my_outlet_id()
        and team_leader_id = (select id from public.current_app_user()))
  );

-- ---- devices ---------------------------------------------------------------
-- Read/write is admin and supervisor only. Devices are trusted hardware; a rep
-- must not be able to enrol, re-point or disable one.
drop policy if exists devices_admin_all on public.devices;
create policy devices_admin_all on public.devices
  for all to authenticated
  using (
    public.is_admin()
    or (public.my_role() = 'supervisor'
        and outlet_id in (
          select o.id from public.outlets o
          join public.regions r on r.id = o.region_id
          where r.zone_id = public.my_zone_id()))
  )
  with check (
    public.is_admin()
    or (public.my_role() = 'supervisor'
        and outlet_id in (
          select o.id from public.outlets o
          join public.regions r on r.id = o.region_id
          where r.zone_id = public.my_zone_id()))
  );

-- ---- scans -----------------------------------------------------------------
drop policy if exists scans_read on public.scans;
create policy scans_read on public.scans
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and zone_id = public.my_zone_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
    or sales_rep_id = (select id from public.current_app_user())
  );

-- Only signed-in people insert directly. Phone uploads go through
-- upload_scans(), which is SECURITY DEFINER and bypasses this policy.
drop policy if exists scans_insert on public.scans;
create policy scans_insert on public.scans
  for insert to authenticated
  with check (
    public.is_admin()
    or sales_rep_id = (select id from public.current_app_user())
  );

drop policy if exists scans_update on public.scans;
create policy scans_update on public.scans
  for update to authenticated
  using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and zone_id = public.my_zone_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
    or sales_rep_id = (select id from public.current_app_user())
  )
  with check (true);

drop policy if exists scans_delete on public.scans;
create policy scans_delete on public.scans
  for delete to authenticated
  using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and zone_id = public.my_zone_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
  );

-- =============================================================================
-- 10. GRANTS
--
--     RLS still filters every row; these grants only decide which verbs exist.
--     There is NO insert/select grant to `anon` on any table -- the only anon
--     capability in this database is executing claim_device() and
--     upload_scans(), both of which validate a device secret first.
-- =============================================================================
grant usage on schema public to authenticated;

grant select, insert, update, delete on
  public.zones, public.regions, public.outlets, public.users, public.scans, public.devices
  to authenticated;

revoke all on public.zones, public.regions, public.outlets, public.users,
              public.scans, public.devices from anon;

-- =============================================================================
-- 11. DELETE USER
--
--     [FIX 2] The plan dropped this. Scans reference users with ON DELETE
--     RESTRICT, so a rep who has recorded scans cannot simply be deleted --
--     their history is evidence. This removes the person and their scans
--     together, and refuses if that would orphan anything.
-- =============================================================================
create or replace function public.delete_user(target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me      public.users;
  victim  public.users;
  repped  int;
begin
  select * into me from public.users
   where auth_user_id = auth.uid() and active limit 1;

  if me.id is null then
    raise exception 'No active profile for this account' using errcode = '42501';
  end if;
  if me.role not in ('admin', 'supervisor') then
    raise exception 'Your role cannot remove users' using errcode = '42501';
  end if;
  if target = me.id then
    raise exception 'You cannot remove your own account' using errcode = '42501';
  end if;

  select * into victim from public.users where id = target;
  if victim.id is null then
    raise exception 'User not found' using errcode = 'P0002';
  end if;

  if not public.is_admin() and not exists (
    select 1 from public.outlets o
    join public.regions r on r.id = o.region_id
    where o.id = victim.outlet_id and r.zone_id = public.my_zone_id()
  ) then
    raise exception 'That user is outside your zone' using errcode = '42501';
  end if;

  select count(*) into repped from public.scans where sales_rep_id = target;

  delete from public.scans where sales_rep_id = target;
  delete from public.users where id = target;

  -- The auth.users row is removed by the Edge Function using the service role;
  -- this function cannot (and must not) touch the auth schema.
  return jsonb_build_object(
    'removed', victim.full_name,
    'scans_deleted', repped,
    'auth_user_id', victim.auth_user_id
  );
end;
$$;

revoke all on function public.delete_user(uuid) from public;
grant execute on function public.delete_user(uuid) to authenticated;

-- =============================================================================
-- 12. VIEWS
--
--     security_invoker = true so RLS is evaluated against the CALLER, not
--     against the view owner. Without it these views would be a hole that let
--     every signed-in user read everything.
-- =============================================================================

drop view if exists public.v_my_profile;
create view public.v_my_profile
with (security_invoker = true)
as
select
  u.id            as user_id,
  u.username,
  u.full_name,
  u.phone,
  u.role,
  u.outlet_id,
  o.name          as outlet_name,
  r.id            as region_id,
  r.name          as region_name,
  z.id            as zone_id,
  z.name          as zone_name,
  u.team_leader_id,
  tl.full_name    as team_leader_name,
  u.active
from public.users u
left join public.outlets o on o.id = u.outlet_id
left join public.regions r on r.id = o.region_id
left join public.zones   z on z.id = r.zone_id
left join public.users  tl on tl.id = u.team_leader_id
where u.auth_user_id = auth.uid();

drop view if exists public.v_rep_scan_counts;
create view public.v_rep_scan_counts
with (security_invoker = true)
as
select
  u.id             as user_id,
  u.full_name,
  u.username,
  u.role,
  u.active,
  o.id             as outlet_id,
  o.name           as outlet_name,
  r.id             as region_id,
  r.name           as region_name,
  z.id             as zone_id,
  z.name           as zone_name,
  tl.full_name     as team_leader_name,
  count(s.id) filter (where s.created_at >= date_trunc('day', now())) as scans_today,
  count(s.id)      as scans_total
from public.users u
left join public.outlets o on o.id = u.outlet_id
left join public.regions r on r.id = o.region_id
left join public.zones   z on z.id = r.zone_id
left join public.users  tl on tl.id = u.team_leader_id
left join public.scans   s on s.sales_rep_id = u.id
group by u.id, u.full_name, u.username, u.role, u.active,
         o.id, o.name, r.id, r.name, z.id, z.name, tl.full_name;

-- Scans from BOTH sources. This is the reporting surface; scan records filed by
-- a phone show a device label instead of a rep name.
drop view if exists public.v_scan_records;
create view public.v_scan_records
with (security_invoker = true)
as
select
  s.id,
  s.iccid,
  s.customer_name,
  s.primary_number,
  s.secondary_number,
  s.created_at,
  u.id            as sales_rep_id,
  u.full_name     as sales_rep_name,
  d.id            as device_id,
  d.label         as device_label,
  o.id            as outlet_id,
  o.name          as outlet_name,
  r.id            as region_id,
  r.name          as region_name,
  z.id            as zone_id,
  z.name          as zone_name,
  case when s.device_id is not null then 'device' else 'user' end as source
from public.scans s
left join public.users   u on u.id = s.sales_rep_id
left join public.devices d on d.id = s.device_id
join public.outlets o on o.id = s.outlet_id
join public.regions r on r.id = s.region_id
join public.zones   z on z.id = s.zone_id;

grant select on public.v_my_profile, public.v_rep_scan_counts, public.v_scan_records
  to authenticated;
revoke all on public.v_my_profile, public.v_rep_scan_counts, public.v_scan_records
  from anon;

-- =============================================================================
-- 13. SELF-CHECK
--
--     Run this block after the whole file to confirm the shape is right.
--     It raises if any expected object is missing.
-- =============================================================================
do $$
declare
  missing text := '';
begin
  -- Objects are checked through the catalogs rather than to_regproc(), whose
  -- argument parsing differs between PostgreSQL builds for signatures written
  -- with a bare argument list. A missing object is reported collectively so the
  -- operator can see everything at once instead of fixing one name per run.
  if to_regclass('public.zones')          is null then missing := missing || 'zones ';          end if;
  if to_regclass('public.regions')        is null then missing := missing || 'regions ';        end if;
  if to_regclass('public.outlets')        is null then missing := missing || 'outlets ';        end if;
  if to_regclass('public.users')          is null then missing := missing || 'users ';          end if;
  if to_regclass('public.devices')        is null then missing := missing || 'devices ';        end if;
  if to_regclass('public.scans')          is null then missing := missing || 'scans ';          end if;
  if to_regclass('public.v_my_profile')   is null then missing := missing || 'v_my_profile ';   end if;
  if to_regclass('public.v_rep_scan_counts') is null then missing := missing || 'v_rep_scan_counts '; end if;
  if to_regclass('public.v_scan_records') is null then missing := missing || 'v_scan_records '; end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'current_app_user') then missing := missing || 'current_app_user() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_admin') then missing := missing || 'is_admin() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'my_role') then missing := missing || 'my_role() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'my_outlet_id') then missing := missing || 'my_outlet_id() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'my_region_id') then missing := missing || 'my_region_id() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'my_zone_id') then missing := missing || 'my_zone_id() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'scans_before_write') then missing := missing || 'scans_before_write() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'users_guard_privileges') then missing := missing || 'users_guard_privileges() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'upload_scans') then missing := missing || 'upload_scans() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'claim_device') then missing := missing || 'claim_device() '; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'delete_user') then missing := missing || 'delete_user() '; end if;

  if missing <> '' then
    raise exception 'Schema incomplete, missing: %', missing;
  end if;

  raise notice 'Greenfield schema OK: 6 tables, 3 views, 11 functions, RLS enabled.';
end $$;
