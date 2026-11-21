-- =============================================================================
-- SIM Management System -- v5: remove the device/PIN model
--
-- RUN AFTER schema_v2_greenfield.sql, seed_v2.sql.
-- If you already ran v3/v4, that is fine -- this removes what they added.
-- Safe to re-run.
--
-- WHY
--   The phone now signs in with a real username + password, so none of the
--   anonymous machinery is needed any more:
--
--     removed: devices table, claim_device(), upload_scans(), device_roster(),
--              set_rep_pin(), users.pin_hash, scans.device_id
--
--   A signed-in upload is stamped by scans_before_write from auth.uid(), so
--   attribution and location keep working with no extra credential.
--
-- WHAT REPLACES IT
--   Nothing. Login is the credential. This is simpler and safer: there is no
--   public write path at all, so no anon key can insert scans.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Drop the anonymous entry points.
-- -----------------------------------------------------------------------------
drop function if exists public.upload_scans(jsonb);
drop function if exists public.claim_device(text);
drop function if exists public.device_roster(jsonb);
drop function if exists public.set_rep_pin(uuid, text);

-- -----------------------------------------------------------------------------
-- 2. Drop device_id from scans, then the devices table itself.
--    The reporting view references both, so it must go first -- Postgres will
--    not drop a column that a view depends on.
-- -----------------------------------------------------------------------------
drop view if exists public.v_scan_records;

drop index if exists public.scans_device_created_idx;

alter table public.scans drop constraint if exists scans_has_owner;
alter table public.scans drop constraint if exists scans_one_owner;
alter table public.scans drop column if exists device_id;

-- Every scan now belongs to a person. This replaces the "at least one owner"
-- rule from v3: a scan with no rep would be unattributable, and there is no
-- device to fall back on.
alter table public.scans
  alter column sales_rep_id set not null;

drop table if exists public.devices;

-- PINs were only for phone-side rep switching; login replaces them.
alter table public.users drop column if exists pin_hash;

-- -----------------------------------------------------------------------------
-- 3. Trigger: signed-in insert only.
-- -----------------------------------------------------------------------------
create or replace function public.scans_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me        public.users;
  target    public.users;
  my_outlet public.outlets;
  target_zone uuid;
  my_zone     uuid;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null then
      raise exception 'A scan must be filed by a signed-in user' using errcode = '42501';
    end if;

    select * into me from public.users
     where auth_user_id = auth.uid() and active limit 1;
    if me.id is null then
      raise exception 'No active profile for this account' using errcode = '42501';
    end if;
    if me.outlet_id is null then
      raise exception 'Your account has no outlet assigned' using errcode = '42501';
    end if;

    new.sales_rep_id := coalesce(new.sales_rep_id, me.id);

    if new.sales_rep_id = me.id then
      select * into my_outlet from public.outlets where id = me.outlet_id;
    else
      -- Filing for someone else: only inside the caller's scope (see v4).
      select * into target from public.users
       where id = new.sales_rep_id and active;
      if target.id is null then
        raise exception 'That person does not exist or is disabled' using errcode = '42501';
      end if;
      if target.outlet_id is null then
        raise exception 'That person has no outlet assigned' using errcode = '42501';
      end if;

      select * into my_outlet from public.outlets where id = target.outlet_id;

      select r.zone_id into target_zone
        from public.regions r where r.id = my_outlet.region_id;
      select r.zone_id into my_zone
        from public.outlets o join public.regions r on r.id = o.region_id
       where o.id = me.outlet_id;

      if me.role = 'admin' then
        null;
      elsif me.role = 'supervisor' and target_zone = my_zone then
        null;
      elsif me.role = 'team_leader' and target.outlet_id = me.outlet_id then
        null;
      else
        raise exception 'You may only record scans for yourself, or for someone in your own scope'
          using errcode = '42501';
      end if;
    end if;

    new.created_at := coalesce(new.created_at, now());

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

-- -----------------------------------------------------------------------------
-- 4. Views: drop the device columns.
--    v3's v_scan_records referenced device_label, so it must be recreated --
--    a dropped table cannot back a live view.
-- -----------------------------------------------------------------------------
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
  s.updated_at,
  u.id            as sales_rep_id,
  u.full_name     as sales_rep_name,
  o.id            as outlet_id,
  o.name          as outlet_name,
  r.id            as region_id,
  r.name          as region_name,
  z.id            as zone_id,
  z.name          as zone_name
from public.scans s
join public.users   u on u.id = s.sales_rep_id
join public.outlets o on o.id = s.outlet_id
join public.regions r on r.id = s.region_id
join public.zones   z on z.id = s.zone_id;

grant select on public.v_scan_records to authenticated;
revoke all on public.v_scan_records from anon;

-- -----------------------------------------------------------------------------
-- 5. No anon write path should remain.
-- -----------------------------------------------------------------------------
revoke all on public.zones, public.regions, public.outlets, public.users, public.scans
  from anon;

-- -----------------------------------------------------------------------------
-- 6. Self-check
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.devices') is not null then
    raise exception 'v5 incomplete: devices table still exists';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='scans' and column_name='device_id'
  ) then
    raise exception 'v5 incomplete: scans.device_id still exists';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname in ('upload_scans','claim_device','device_roster','set_rep_pin')
  ) then
    raise exception 'v5 incomplete: an anonymous entry point still exists';
  end if;

  raise notice 'v5 OK: login-only writes, no devices, no PINs.';
end $$;
