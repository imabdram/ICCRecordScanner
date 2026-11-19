-- =============================================================================
-- SIM Management System -- Supabase greenfield SEED (v2)
--
-- Run AFTER scripts/schema_v2_greenfield.sql.
-- Safe to re-run: every insert is conflict-guarded.
--
-- Contents:
--   1. Organisation tree  (3 zones / 4 regions / 26 outlets -- unchanged)
--   2. Bootstrap instructions for the FIRST ADMIN
--   3. Example device registration (commented out -- use the web console)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ORGANISATION TREE
-- -----------------------------------------------------------------------------
insert into public.zones (name) values
  ('Zone 1'), ('Zone 2'), ('Zone 3')
on conflict (name) do nothing;

insert into public.regions (zone_id, name)
select z.id, r.name
from (values
  ('Zone 2', 'Bari Region'),
  ('Zone 2', 'Mudug Region'),
  ('Zone 2', 'Nugaal Region'),
  ('Zone 2', 'Sool Region')
) as r(zone_name, name)
join public.zones z on z.name = r.zone_name
on conflict (zone_id, name) do nothing;

insert into public.outlets (region_id, name)
select r.id, o.name
from (values
  ('Bari Region',   'Customer care Bosaso'),
  ('Bari Region',   'Amalbank HQI Bosaso'),
  ('Bari Region',   'Amalbank-Jubba-Bosaso'),
  ('Bari Region',   'Amalbank Qardho'),
  ('Bari Region',   'Alla-aamin Qardho'),

  ('Mudug Region',  'Galkacyo HQ'),
  ('Mudug Region',  'Galkacyo Golden plaza'),
  ('Mudug Region',  'Galkacyo Isbarriije'),
  ('Mudug Region',  'Galdogobl'),
  ('Mudug Region',  'Bacaadweyn'),
  ('Mudug Region',  'Xarfo'),
  ('Mudug Region',  'Cagaaran'),
  ('Mudug Region',  'Buraalax'),
  ('Mudug Region',  'Ballibusle'),
  ('Mudug Region',  'Jarriiban'),
  ('Mudug Region',  'Garacad'),
  ('Mudug Region',  'Daarusaalam'),
  ('Mudug Region',  'Galkaio_Wadajir'),

  ('Nugaal Region', 'Opec'),
  ('Nugaal Region', 'Amal HQ'),
  ('Nugaal Region', 'Inji'),
  ('Nugaal Region', 'Amtel Buurtinle'),
  ('Nugaal Region', 'Dangoroyo'),
  ('Nugaal Region', 'Jalam'),
  ('Nugaal Region', 'Amtel_Nugaal'),

  ('Sool Region',   'Laascaano')
) as o(region_name, name)
join public.regions r on r.name = o.region_name
on conflict (region_id, name) do nothing;

-- Expect: 3 zones, 4 regions, 26 outlets.
do $$
declare z int; r int; o int;
begin
  select count(*) into z from public.zones;
  select count(*) into r from public.regions;
  select count(*) into o from public.outlets;
  raise notice 'Seeded: % zones, % regions, % outlets', z, r, o;
  if z <> 3 or r <> 4 or o <> 26 then
    raise warning 'Unexpected tree size (expected 3/4/26). Re-running seed is safe.';
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 2. THE FIRST ADMIN -- read this before you try to sign in
--
--    There is a deliberate chicken-and-egg problem: creating users needs an
--    admin, and there is no admin yet. The plan did not address this.
--
--    Do NOT try to create the first account by inserting into auth.users by
--    hand. Supabase's auth schema expects specific column formats (for example
--    confirmation_token must be '' and not NULL); a raw INSERT produces login
--    errors that are hard to trace.
--
--    Use the Edge Function instead, which is exactly what the website uses:
--
--      supabase functions deploy admin-user --project-ref <your-ref>
--      supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service_role key>
--      supabase secrets set BOOTSTRAP_ADMIN_TOKEN=<a long random string you pick>
--
--      curl -X POST https://<your-ref>.supabase.co/functions/v1/admin-user \
--        -H "Authorization: Bearer <bootstrap token>" \
--        -H "Content-Type: application/json" \
--        -d '{"kind":"bootstrap","username":"yacquub","password":"...",
--             "full_name":"Yacquub","role":"admin"}'
--
--    The function creates the auth user, then inserts the users row AND links
--    it to an outlet. An admin does not need an outlet to see everything, but
--    assigning one keeps the profile header sensible -- pick any outlet id:
--
--      select id, name from public.outlets order by name limit 5;
--
--    After the bootstrap admin exists, remove the BOOTSTRAP_ADMIN_TOKEN secret
--    so that path is closed:
--
--      supabase secrets unset BOOTSTRAP_ADMIN_TOKEN
--
--    Every later user is created from the web console's Users page, which
--    calls the same function with the admin's own session instead of the
--    bootstrap token.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- 3. REGISTERING A PHONE  (example -- normally done from the web console)
--
--    A device row is what ties an offline phone to an outlet. The web console
--    creates the row and shows the short setup_code; the rep types that code
--    once on the phone, and the phone keeps the device_key from then on.
--
--    The uncomment-and-run version below is useful for testing before the
--    console exists. device_key must be long and random.
-- -----------------------------------------------------------------------------
-- insert into public.devices (device_key, setup_code, label, outlet_id)
-- select
--   -- 64 hex chars. Uses no extension: two md5s of random entropy.
--   md5(random()::text || clock_timestamp()::text)
--     || md5(random()::text || clock_timestamp()::text),
--   'ABC12345',
--   'Bosaso counter 1',
--   o.id
-- from public.outlets o
-- where o.name = 'Customer care Bosaso'
-- on conflict (device_key) do nothing;

-- Handy after registering a device: confirm the setup code the rep should type.
-- select d.label, d.setup_code, o.name as outlet
-- from public.devices d join public.outlets o on o.id = d.outlet_id
-- order by d.created_at desc;
