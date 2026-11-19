-- =============================================================================
-- SIM Management System — seed data
--
-- Zones 1-3. Zone 2 holds the four operating regions and their outlets.
-- Idempotent: re-running updates names, never duplicates rows.
-- =============================================================================

insert into public.zones (name) values
  ('Zone 1'), ('Zone 2'), ('Zone 3')
on conflict (name) do nothing;

-- Regions, each attached to its zone.
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

-- Outlets, each attached to its region.
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
