-- =============================================================================
-- SIM Management System -- v3: per-rep attribution on an offline phone
--
-- RUN AFTER schema_v2_greenfield.sql and seed_v2.sql.
-- Supabase Dashboard -> SQL Editor -> paste -> Run. Safe to re-run.
--
-- WHY THIS EXISTS
--   v2 could attribute a scan to a person (web) or to a phone (app), never
--   both. The field reality is: one phone, several reps, no signal. So:
--
--     * the phone still identifies itself with a device_key (v2)
--     * the rep identifies themselves with a short PIN, verified OFFLINE
--       against a hash cached on the phone
--     * a scan records BOTH: who (sales_rep_id) and which handset (device_id)
--
--   This makes "who scanned what" answerable and gives per-rep reports.
--
-- WHAT A PIN IS AND IS NOT
--   It is attribution, not authentication. A 6-digit PIN on a handset that
--   caches its hash can be brute-forced by anyone with the device. It stops
--   casual mix-ups and gives you a name on every record; it does not stop a
--   determined insider. Treat reports as "who said they were" rather than
--   proof. For proof you need online authentication, which is exactly what
--   "works with no signal" rules out.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A PIN per person, hashed. NULL = this person does not use a phone.
--    bcrypt via pgcrypto; the plain PIN is never stored.
-- -----------------------------------------------------------------------------
alter table public.users
  add column if not exists pin_hash text;

comment on column public.users.pin_hash is
  'bcrypt hash of the rep''s phone PIN. NULL = not a phone user. Set by an admin via set_rep_pin().';

-- -----------------------------------------------------------------------------
-- 2. A scan may now carry BOTH owners: a rep and a device.
--    Replaces the v2 rule (exactly one of the two).
-- -----------------------------------------------------------------------------
alter table public.scans drop constraint if exists scans_one_owner;

alter table public.scans
  drop constraint if exists scans_has_owner;
alter table public.scans
  add constraint scans_has_owner check (
    sales_rep_id is not null or device_id is not null
  );

-- Reporting by rep over a date range (the "sales records" report).
create index if not exists scans_rep_created_day_idx
  on public.scans (sales_rep_id, created_at desc)
  where sales_rep_id is not null;

-- -----------------------------------------------------------------------------
-- 2b. The trigger must let an explicit device_id win.
--
--     v2 checked "is a user signed in?" FIRST, so a phone upload that happened
--     to carry a JWT (or any session left over in the request) took the
--     signed-in branch, which nulls device_id -- losing the phone attribution.
--     Now: a device_id supplied by upload_scans() is authoritative, and the
--     signed-in branch only runs when there is no device.
--
--     A browser user still cannot abuse this: scans_insert's WITH CHECK
--     requires sales_rep_id = me, and the device branch sets sales_rep_id to
--     null, so a non-admin insert of that shape is rejected by RLS.
-- -----------------------------------------------------------------------------
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
      -- A rep may be named (v3); the device is what authenticates the upload.
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
-- 3. Admin helper: set or clear a rep's PIN.
--    Called from the website as rpc('set_rep_pin', {p_user_id, p_pin}).
--    The admin check mirrors the Edge Function: role must be 'admin'.
-- -----------------------------------------------------------------------------
create or replace function public.set_rep_pin(p_user_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me   public.users;
  victim public.users;
begin
  select * into me from public.users
   where auth_user_id = auth.uid() and active limit 1;
  if me.id is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if me.role <> 'admin' then
    raise exception 'Only an administrator can set a PIN' using errcode = '42501';
  end if;

  select * into victim from public.users where id = p_user_id;
  if victim.id is null then
    raise exception 'User not found' using errcode = 'P0002';
  end if;

  if p_pin is null or p_pin = '' then
    update public.users set pin_hash = null where id = p_user_id;
    return jsonb_build_object('user', victim.username, 'pin', 'cleared');
  end if;

  -- 4-8 digits: short enough to type on a keypad, long enough not to be one guess.
  if p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN must be 4 to 8 digits' using errcode = '22023';
  end if;

  update public.users
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
   where id = p_user_id;

  return jsonb_build_object('user', victim.username, 'pin', 'set');
end;
$$;

revoke all on function public.set_rep_pin(uuid, text) from public;
grant execute on function public.set_rep_pin(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Roster for a phone: who works at this device's outlet?
--
--    Returns the people a rep can pick from, WITH their bcrypt hashes so the
--    phone can verify a PIN with no network. That is the deliberate trade
--    described at the top: the handset must hold the hashes to work offline.
--
--    Only active users of the device's own outlet are returned, so a phone can
--    never offer a rep from another outlet.
-- -----------------------------------------------------------------------------
create or replace function public.device_roster(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  dev  public.devices;
  reps jsonb;
begin
  select * into dev from public.devices
   where device_key = nullif(trim(payload->>'device_key'), '')
     and active limit 1;
  if dev.id is null then
    raise exception 'Unknown or disabled device' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',        u.id,
           'full_name', u.full_name,
           'username',  u.username,
           'pin_hash',  u.pin_hash,
           'has_pin',   u.pin_hash is not null
         ) order by u.full_name), '[]'::jsonb)
    into reps
    from public.users u
   where u.outlet_id = dev.outlet_id
     and u.active;

  update public.devices set last_seen_at = now() where id = dev.id;

  return jsonb_build_object(
    'device', jsonb_build_object('id', dev.id, 'label', dev.label, 'outlet_id', dev.outlet_id),
    'reps', reps
  );
end;
$$;

revoke all on function public.device_roster(jsonb) from public;
grant execute on function public.device_roster(jsonb) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. upload_scans: accept an optional sales_rep_id per row.
--
--    A rep may only be attributed to a scan if they belong to the uploading
--    device's outlet and are active -- so a phone cannot file scans under
--    somebody from another outlet. Location is still derived from the device,
--    never from the payload.
-- -----------------------------------------------------------------------------
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
  v_rep        uuid;
  v_rep_ok     boolean;
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
    v_rep       := nullif(item->>'sales_rep_id', '')::uuid;

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

    -- The named rep must work at this device's outlet and be active.
    if v_rep is not null then
      select exists (
        select 1 from public.users u
         where u.id = v_rep and u.active and u.outlet_id = dev.outlet_id
      ) into v_rep_ok;
      if not v_rep_ok then
        rejected := rejected || jsonb_build_object(
          'iccid', v_iccid, 'reason', 'sales_rep_id is not a rep at this outlet');
        continue;
      end if;
    end if;

    if exists (select 1 from public.scans where iccid = v_iccid) then
      duplicates := duplicates || to_jsonb(v_iccid);
      continue;
    end if;

    insert into public.scans
      (iccid, customer_name, primary_number, secondary_number,
       sales_rep_id, device_id, created_at)
    values
      (v_iccid, v_name, v_primary, v_secondary,
       v_rep, dev.id, v_created);

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

revoke all on function public.upload_scans(jsonb) from public;
grant execute on function public.upload_scans(jsonb) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Per-rep report over a date range.
--
--    Answers "how many did each rep record?" for the website, scoped by RLS
--    because the view is security invoker.
-- -----------------------------------------------------------------------------
create or replace view public.v_rep_scan_report
with (security_invoker = true)
as
select
  u.id          as user_id,
  u.full_name,
  u.username,
  u.role,
  o.name        as outlet_name,
  r.name        as region_name,
  z.name        as zone_name,
  count(s.id)   as scans,
  count(distinct s.iccid) as unique_sims,
  min(s.created_at) as first_scan,
  max(s.created_at) as last_scan
from public.users u
left join public.outlets o on o.id = u.outlet_id
left join public.regions r on r.id = o.region_id
left join public.zones   z on z.id = r.zone_id
left join public.scans   s on s.sales_rep_id = u.id
group by u.id, u.full_name, u.username, u.role, o.name, r.name, z.name;

grant select on public.v_rep_scan_report to authenticated;
revoke all on public.v_rep_scan_report from anon;

-- -----------------------------------------------------------------------------
-- 7. Self-check
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'users' and column_name = 'pin_hash'
  ) then
    raise exception 'v3 incomplete: users.pin_hash is missing';
  end if;

  if exists (
    select 1 from pg_constraint where conname = 'scans_one_owner'
  ) then
    raise exception 'v3 incomplete: the v2 scans_one_owner constraint is still present';
  end if;

  if not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'device_roster'
  ) then
    raise exception 'v3 incomplete: device_roster is missing';
  end if;

  raise notice 'v3 OK: PIN hashes, dual attribution, roster, per-rep report.';
end $$;
