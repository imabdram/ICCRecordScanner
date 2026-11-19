-- =============================================================================
-- SIM Management System — Neon Postgres schema
--
-- Hierarchy (Zone -> Region -> Outlet -> User). Every user belongs to exactly
-- one outlet, and that outlet gives them their region and zone.
--
-- Authentication is JWT based:
--   * Neon Auth (Managed Better Auth) issues the JWT after sign-in.
--   * The Neon Data API validates that JWT and switches to the Postgres role
--     named in its `role` claim, then applies the RLS policies below.
--   * auth.user_id() returns the JWT `sub` (the Neon Auth user id).
--
-- Re-runnable: safe to execute more than once.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Hierarchy
-- -----------------------------------------------------------------------------
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

-- Users are profiles linked to a Neon Auth identity (`auth_user_id` = JWT sub).
-- `username` is the sign-in email.
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  text not null unique,
  username      text not null unique,
  full_name     text not null default '',
  phone         text not null default '',
  role          text not null default 'sales_rep'
                check (role in ('admin', 'supervisor', 'team_leader', 'sales_rep')),
  outlet_id     uuid references public.outlets(id) on delete restrict,
  -- A sales rep follows one team leader; a team leader has no leader.
  team_leader_id uuid references public.users(id) on delete set null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Scans: one row per registered SIM (the ICCID is unique)
-- -----------------------------------------------------------------------------
create table if not exists public.scans (
  id              uuid primary key default gen_random_uuid(),
  iccid           text not null unique check (iccid ~ '^892526379[0-9]{11}$'),
  customer_name   text not null,
  primary_number  text not null check (primary_number ~ '^[0-9]{10}$'),
  secondary_number text not null check (secondary_number ~ '^[0-9]{10}$'),
  -- Location is derived from the sales rep at insert time and never trusted
  -- from the client, so a rep cannot write into another outlet.
  sales_rep_id    uuid not null references public.users(id) on delete restrict,
  outlet_id       uuid not null references public.outlets(id) on delete restrict,
  region_id       uuid not null references public.regions(id) on delete restrict,
  zone_id         uuid not null references public.zones(id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists scans_outlet_created_idx on public.scans (outlet_id, created_at desc);
create index if not exists scans_rep_created_idx    on public.scans (sales_rep_id, created_at desc);
create index if not exists scans_region_created_idx on public.scans (region_id, created_at desc);
create index if not exists scans_zone_created_idx   on public.scans (zone_id, created_at desc);
create index if not exists users_outlet_idx         on public.users (outlet_id);
create index if not exists users_auth_idx           on public.users (auth_user_id);

-- -----------------------------------------------------------------------------
-- Helpers (security definer so RLS on `users` does not recurse)
-- -----------------------------------------------------------------------------
create or replace function public.current_app_user()
returns public.users
language sql
stable
security definer
set search_path = public
as $$
  select u.* from public.users u
  where u.auth_user_id = auth.user_id()
    and u.active
  limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select u.role = 'admin' from public.users u
      where u.auth_user_id = auth.user_id() and u.active limit 1),
    false);
$$;

create or replace function public.my_zone_id()
returns uuid language sql stable security definer set search_path = public as $$
  select z.id from public.users u
  join public.outlets o on o.id = u.outlet_id
  join public.regions r on r.id = o.region_id
  join public.zones z on z.id = r.zone_id
  where u.auth_user_id = auth.user_id() and u.active limit 1;
$$;

create or replace function public.my_region_id()
returns uuid language sql stable security definer set search_path = public as $$
  select r.id from public.users u
  join public.outlets o on o.id = u.outlet_id
  join public.regions r on r.id = o.region_id
  where u.auth_user_id = auth.user_id() and u.active limit 1;
$$;

create or replace function public.my_outlet_id()
returns uuid language sql stable security definer set search_path = public
as $$
  select u.outlet_id from public.users u
  where u.auth_user_id = auth.user_id() and u.active limit 1;
$$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select u.role from public.users u
  where u.auth_user_id = auth.user_id() and u.active limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Scan write path: stamp the signed-in rep's own location
-- -----------------------------------------------------------------------------
create or replace function public.scans_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.users;
  my_outlet public.outlets;
begin
  if tg_op = 'INSERT' then
    select * into me from public.users
     where auth_user_id = auth.user_id() and active limit 1;
    if me.id is null then
      raise exception 'No active profile for this account' using errcode = '42501';
    end if;
    if me.outlet_id is null then
      raise exception 'Your account has no outlet assigned' using errcode = '42501';
    end if;
    select * into my_outlet from public.outlets where id = me.outlet_id;

    new.sales_rep_id := coalesce(new.sales_rep_id, me.id);
    -- Only an admin may file a scan on behalf of another rep; everyone else is
    -- locked to their own identity and therefore their own location.
    if new.sales_rep_id <> me.id then
      if me.role <> 'admin' then
        raise exception 'You may only record scans for yourself' using errcode = '42501';
      end if;
      select o.* into my_outlet
        from public.users u join public.outlets o on o.id = u.outlet_id
       where u.id = new.sales_rep_id;
    end if;

    new.outlet_id := my_outlet.id;
    select r.zone_id, r.id into new.zone_id, new.region_id
      from public.regions r where r.id = my_outlet.region_id;
    new.created_at := coalesce(new.created_at, now());
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists scans_before_write on public.scans;
create trigger scans_before_write
  before insert or update on public.scans
  for each row execute function public.scans_before_write();

-- -----------------------------------------------------------------------------
-- Row Level Security
--   admin       -> everything
--   supervisor  -> everything in their zone
--   team_leader -> every rep and scan in their own outlet
--   sales_rep   -> only their own scans; sees their outlet's team
-- -----------------------------------------------------------------------------
alter table public.zones   enable row level security;
alter table public.regions enable row level security;
alter table public.outlets enable row level security;
alter table public.users   enable row level security;
alter table public.scans   enable row level security;

-- zones: readable to any signed-in user (needed for labels only).
drop policy if exists zones_read on public.zones;
create policy zones_read on public.zones
  for select to authenticated using (true);
drop policy if exists zones_admin_write on public.zones;
create policy zones_admin_write on public.zones
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- regions: supervisor sees their zone; everyone else sees their own region.
drop policy if exists regions_read on public.regions;
create policy regions_read on public.regions
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and zone_id = public.my_zone_id())
    or zone_id = public.my_zone_id()
  );
drop policy if exists regions_admin_write on public.regions;
create policy regions_admin_write on public.regions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- outlets: same shape as regions (a supervisor controls their whole zone).
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

-- users: admin everywhere, supervisor across their zone, team leader across
-- their outlet, a rep sees their outlet's team.
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

-- Only an admin or a supervisor may create/modify users (e.g. assign a rep to
-- a team leader). A team leader manages their own team's accounts, so they may
-- also write — but only rows in their own outlet, with themselves as leader.
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

-- scans: the reporting hierarchy described above.
drop policy if exists scans_read on public.scans;
create policy scans_read on public.scans
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and zone_id = public.my_zone_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
    or sales_rep_id = (select id from public.current_app_user())
  );

drop policy if exists scans_insert on public.scans;
create policy scans_insert on public.scans
  for insert to authenticated
  with check (
    public.is_admin()
    or sales_rep_id = (select id from public.current_app_user())
  );

-- A rep may fix customer details on their own scans; leaders/supervisors may
-- correct any scan they can see.
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

-- -----------------------------------------------------------------------------
-- Grants. The Data API runs as `authenticated`; RLS still filters every row.
-- There are no grants to `anonymous`, so unauthenticated calls fail closed.
-- -----------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.zones, public.regions, public.outlets, public.users, public.scans
  to authenticated;

-- -----------------------------------------------------------------------------
-- Privilege guard.
--
-- The write policies below say WHICH ROWS a role may touch; they cannot say
-- which COLUMNS. Without this trigger a team leader could rewrite a rep's role
-- (giving themselves admin), or any manager could change their own role.
--
-- Rules enforced here for every UPDATE / DELETE of public.users:
--   * nobody may change or delete their own row's role/outlet/leader
--   * only an admin may hand out or revoke the admin role
--   * a supervisor may not edit another supervisor or an admin
-- -----------------------------------------------------------------------------
create or replace function public.users_guard_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.users;
begin
  select * into me from public.users
   where auth_user_id = auth.user_id() and active limit 1;

  -- Anything running outside the API (migrations, service role) has no user
  -- context and keeps its rights.
  if me.id is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.role = 'admin' and not public.is_admin() then
      raise exception 'Only an administrator can remove an administrator' using errcode = '42501';
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

  -- Only an admin may grant/revoke admin.
  if (new.role = 'admin' or old.role = 'admin') and not public.is_admin() then
    raise exception 'Only an administrator can change an administrator' using errcode = '42501';
  end if;

  -- A supervisor may not touch another supervisor.
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

-- Scans belong to a rep, and `scans_sales_rep_id_fkey` is ON DELETE RESTRICT, so
-- a rep who has recorded scans cannot simply be deleted: their history is
-- evidence and must not vanish. This removes the person and their scans
-- together, or refuses if any scan was recorded by anyone else.
create or replace function public.delete_user(target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me      public.users;
  victim  public.users;
  blocked int;
  repped  int;
begin
  select * into me from public.users
   where auth_user_id = auth.user_id() and active limit 1;
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

  -- A supervisor may only remove people inside their own zone.
  if not public.is_admin() and not exists (
    select 1 from public.outlets o
    join public.regions r on r.id = o.region_id
    where o.id = victim.outlet_id and r.zone_id = public.my_zone_id()
  ) then
    raise exception 'That user is outside your zone' using errcode = '42501';
  end if;

  -- Every scan owned by the user is deleted with them. A scan can only be
  -- attributed to someone else by an admin (see scans_before_write), so if one
  -- exists the deletion is refused rather than silently destroying history.
  select count(*) into blocked
    from public.scans s
   where s.sales_rep_id = target
     and s.sales_rep_id is distinct from target;
  select count(*) into repped from public.scans where sales_rep_id = target;
  if blocked > 0 then
    raise exception 'This user has % scan(s) recorded by others and cannot be removed', blocked
      using errcode = '23503';
  end if;

  delete from public.scans where sales_rep_id = target;
  delete from public.users where id = target;

  return jsonb_build_object('removed', victim.full_name, 'scans_deleted', repped);
end;
$$;

grant execute on function public.delete_user(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Views used by the apps
-- -----------------------------------------------------------------------------

-- The signed-in user's own scope (mobile profile header, drawer, dashboard).
create or replace view public.v_my_profile
with (security_invoker = true)
as
select
  u.id            as user_id,
  u.username      as email,
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
where u.auth_user_id = auth.user_id();

-- "How many has each sales rep opened", with the location rolled up from the
-- rep's outlet. This is what the web dashboard's leaderboard reads.
create or replace view public.v_rep_scan_counts
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

-- Flat reporting view for Scan Records / CSV export.
create or replace view public.v_scan_records
with (security_invoker = true)
as
select
  s.id, s.iccid, s.customer_name, s.primary_number, s.secondary_number,
  s.created_at,
  u.id as sales_rep_id, u.full_name as sales_rep_name,
  o.id as outlet_id, o.name as outlet_name,
  r.id as region_id, r.name as region_name,
  z.id as zone_id, z.name as zone_name
from public.scans s
join public.users   u on u.id = s.sales_rep_id
join public.outlets o on o.id = s.outlet_id
join public.regions r on r.id = s.region_id
join public.zones   z on z.id = s.zone_id;

grant select on public.v_my_profile, public.v_rep_scan_counts, public.v_scan_records
  to authenticated;
