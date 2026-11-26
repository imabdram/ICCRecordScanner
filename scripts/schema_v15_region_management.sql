-- =============================================================================
-- v15: regional transfers, audit trail, and an outlet overview
--
-- Run after v14. Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Guard: a non-admin may only place people inside their own region.
-- The RLS policies already limit WHICH rows are writable; this limits WHERE a
-- row may be pointed, which is the transfer case (move a rep to another outlet).
-- -----------------------------------------------------------------------------
create or replace function public.users_guard_region()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me      public.users;
  target  uuid;
begin
  if auth.uid() is null then
    return new; -- service role / migrations
  end if;

  select * into me from public.users
   where auth_user_id = auth.uid() and active limit 1;
  if me.id is null then
    return new;
  end if;
  if me.role = 'admin' then
    return new;
  end if;

  -- Nobody but an admin may move themselves (or anyone) between regions.
  if new.region_id is not null and me.region_id is not null
     and new.region_id <> me.region_id then
    raise exception 'You can only manage people inside your own region'
      using errcode = '42501';
  end if;

  -- A supervisor has no outlet: the region is the boundary.
  if me.role = 'supervisor' then
    if new.outlet_id is not null then
      select region_id into target from public.outlets where id = new.outlet_id;
      if target is distinct from me.region_id then
        raise exception 'That outlet is outside your region' using errcode = '42501';
      end if;
    end if;
  end if;

  -- A team leader can only place people in their own outlet.
  if me.role = 'team_leader' then
    if new.outlet_id is distinct from me.outlet_id then
      raise exception 'You can only manage your own outlet' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists users_guard_region on public.users;
create trigger users_guard_region
  before insert or update on public.users
  for each row execute function public.users_guard_region();

-- -----------------------------------------------------------------------------
-- Audit trail for user changes: who created, edited, transferred or disabled
-- whom. Append-only, like scan_deletions.
-- -----------------------------------------------------------------------------
create table if not exists public.user_audit (
  id           bigserial primary key,
  actor_id     uuid,
  actor_name   text,
  actor_role   text,
  target_id    uuid,
  target_name  text,
  action       text not null,
  before_row   jsonb,
  after_row    jsonb,
  region_id    uuid,
  outlet_id    uuid,
  created_at   timestamptz not null default now()
);

create index if not exists user_audit_created_idx on public.user_audit (created_at desc);
create index if not exists user_audit_region_idx on public.user_audit (region_id, created_at desc);

create or replace function public.users_audit_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       public.users;
  act      text;
begin
  select * into me from public.users
   where auth_user_id = auth.uid() and active limit 1;

  if tg_op = 'INSERT' then
    act := 'created';
  elsif new.active is distinct from old.active then
    act := case when new.active then 'activated' else 'disabled' end;
  elsif new.outlet_id is distinct from old.outlet_id then
    act := 'transferred';
  elsif new.team_leader_id is distinct from old.team_leader_id then
    act := 'reassigned';
  elsif new.role is distinct from old.role then
    act := 'role_changed';
  else
    act := 'updated';
  end if;

  insert into public.user_audit (
    actor_id, actor_name, actor_role, target_id, target_name, action,
    before_row, after_row, region_id, outlet_id
  ) values (
    me.id, me.full_name, me.role,
    new.id, new.full_name, act,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new),
    new.region_id, new.outlet_id
  );

  return new;
end;
$$;

drop trigger if exists users_audit_write on public.users;
create trigger users_audit_write
  after insert or update on public.users
  for each row execute function public.users_audit_write();

alter table public.user_audit enable row level security;

drop policy if exists user_audit_read on public.user_audit;
create policy user_audit_read on public.user_audit
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and region_id = public.my_region_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
  );

grant select on public.user_audit to authenticated;
revoke all on public.user_audit from anon;

-- -----------------------------------------------------------------------------
-- Outlet overview: the region supervisor's home screen.
-- -----------------------------------------------------------------------------
drop view if exists public.v_outlet_overview;
create view public.v_outlet_overview
with (security_invoker = true)
as
select
  o.id                                   as outlet_id,
  o.name                                 as outlet_name,
  r.id                                   as region_id,
  r.name                                 as region_name,
  z.name                                 as zone_name,
  count(distinct u.id) filter (where u.role = 'sales_rep')   as reps,
  count(distinct u.id) filter (where u.role = 'team_leader') as team_leaders,
  count(distinct u.id) filter (where u.active)               as active_users,
  coalesce(sum(v.amount) filter (
    where (v.received_at at time zone 'Africa/Mogadishu')::date
          = (now() at time zone 'Africa/Mogadishu')::date
  ), 0)                                  as vouchers_today,
  coalesce(sum(v.amount) filter (
    where date_trunc('month', v.received_at at time zone 'Africa/Mogadishu')
        = date_trunc('month', now() at time zone 'Africa/Mogadishu')
  ), 0)                                  as vouchers_month
from public.outlets o
join public.regions r on r.id = o.region_id
join public.zones   z on z.id = r.zone_id
left join public.users u on u.outlet_id = o.id
left join public.vouchers v on v.outlet_id = o.id
group by o.id, o.name, r.id, r.name, z.name;

grant select on public.v_outlet_overview to authenticated;
revoke all on public.v_outlet_overview from anon;

do $$
begin
  if to_regclass('public.user_audit') is null then
    raise exception 'v15 incomplete: user_audit missing';
  end if;
  if to_regclass('public.v_outlet_overview') is null then
    raise exception 'v15 incomplete: v_outlet_overview missing';
  end if;
  raise notice 'v15 OK: regional transfers guarded, user changes audited, outlet overview ready.';
end $$;
