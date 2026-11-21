-- =============================================================================
-- SIM Management System -- v4: filing a scan on behalf of someone else
--
-- RUN AFTER schema_v2_greenfield.sql, seed_v2.sql, schema_v3_reps.sql.
-- Supabase Dashboard -> SQL Editor -> paste -> Run. Safe to re-run.
--
-- WHY THIS EXISTS
--   The office needs to enter a record by hand (damaged SIM, missed scan).
--   A team leader filing for a rep was previously impossible: the trigger
--   raised "You may only record scans for yourself" for everyone except an
--   admin, and scans_insert enforced the same rule.
--
--   Now:
--     admin        -> may file for anyone
--     supervisor   -> someone in their zone
--     team_leader  -> someone in their outlet
--     sales_rep    -> only themselves
--
--   Location still comes from the person the scan is attributed to, never from
--   the caller and never from the client -- so filing for a rep in another
--   outlet would misattribute history, and is therefore refused.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Trigger: allow in-scope filing, and stamp the TARGET's location.
-- -----------------------------------------------------------------------------
create or replace function public.scans_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       public.users;
  target   public.users;
  my_outlet public.outlets;
  dev      public.devices;
  target_zone uuid;
  my_zone     uuid;
begin
  if tg_op = 'INSERT' then
    -- ---- branch (a): a registered device (phone upload) -------------------
    if new.device_id is not null then
      select * into dev from public.devices where id = new.device_id;
      if dev.id is null then
        raise exception 'Unknown device' using errcode = '42501';
      end if;
      if not dev.active then
        raise exception 'This device has been disabled' using errcode = '42501';
      end if;
      select * into my_outlet from public.outlets where id = dev.outlet_id;

    -- ---- branch (b): a signed-in person ----------------------------------
    elsif auth.uid() is not null then
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
        -- Filing for yourself: the ordinary case.
        select * into my_outlet from public.outlets where id = me.outlet_id;
      else
        -- Filing for someone else: allowed only inside the caller's scope.
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
          null; -- anything goes
        elsif me.role = 'supervisor' and target_zone = my_zone then
          null;
        elsif me.role = 'team_leader' and target.outlet_id = me.outlet_id then
          null;
        else
          raise exception 'You may only record scans for yourself, or for someone in your own scope'
            using errcode = '42501';
        end if;
      end if;

      new.device_id := null;
      new.created_at := coalesce(new.created_at, now());

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

-- -----------------------------------------------------------------------------
-- 2. Insert policy must allow the same in-scope filing.
--    Kept in step with the trigger above: the policy is the row-level gate,
--    the trigger is what makes the location truthful.
-- -----------------------------------------------------------------------------
drop policy if exists scans_insert on public.scans;
create policy scans_insert on public.scans
  for insert to authenticated
  with check (
    public.is_admin()
    or sales_rep_id = (select id from public.current_app_user())
    or (
      public.my_role() = 'supervisor'
      and exists (
        select 1
          from public.users u
          join public.outlets o on o.id = u.outlet_id
          join public.regions r on r.id = o.region_id
         where u.id = scans.sales_rep_id
           and r.zone_id = public.my_zone_id()
      )
    )
    or (
      public.my_role() = 'team_leader'
      and exists (
        select 1 from public.users u
         where u.id = scans.sales_rep_id
           and u.outlet_id = public.my_outlet_id()
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Self-check
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'scans' and policyname = 'scans_insert'
  ) then
    raise exception 'v4 incomplete: scans_insert policy is missing';
  end if;
  raise notice 'v4 OK: in-scope filing allowed, location still derived from the target.';
end $$;
