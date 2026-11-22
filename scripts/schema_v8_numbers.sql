-- =============================================================================
-- SIM Management System -- v8: corrected phone number formats
--
-- RUN AFTER schema_v2 .. schema_v7. Safe to re-run.
--
-- NEW RULES
--   primary_number   : 071 followed by 7 digits  (10 total)   0716736063
--   secondary_number : 10 digits, starting 090, 061, or 63
--                      0905736063   0612345678   6312345678
--
-- These replace v6 (primary 71 + 7 = 9 digits) and the original loose
-- "7-12 digits" rule for the backup.
--
-- WHY `not valid`
--   Constraints are added NOT VALID, which means they are enforced on every new
--   insert and update but existing rows are not checked. Any scan recorded under
--   the old 9-digit rule would otherwise make this script fail outright. Once the
--   older rows are corrected, run:
--
--     alter table public.scans validate constraint scans_primary_number_check;
--     alter table public.scans validate constraint scans_secondary_number_check;
--
--   Find the rows that need fixing with the query at the bottom of this file.
-- =============================================================================

alter table public.scans drop constraint if exists scans_primary_number_check;
alter table public.scans
  add constraint scans_primary_number_check
  check (primary_number ~ '^071[0-9]{7}$') not valid;

alter table public.scans drop constraint if exists scans_secondary_number_check;
alter table public.scans
  add constraint scans_secondary_number_check
  check (secondary_number ~ '^(090[0-9]{7}|061[0-9]{7}|63[0-9]{8})$') not valid;

comment on constraint scans_primary_number_check on public.scans is
  'Primary must be 071 followed by 7 digits (10 total).';
comment on constraint scans_secondary_number_check on public.scans is
  'Backup must be 10 digits starting 090, 061 or 63.';

-- -----------------------------------------------------------------------------
-- Self-check: the constraints exist and actually bite.
-- -----------------------------------------------------------------------------
do $$
declare
  ok_primary boolean;
  ok_secondary boolean;
begin
  if not exists (select 1 from pg_constraint where conname = 'scans_primary_number_check') then
    raise exception 'v8 incomplete: primary constraint missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scans_secondary_number_check') then
    raise exception 'v8 incomplete: secondary constraint missing';
  end if;

  ok_primary   := '0716736063' ~ '^071[0-9]{7}$';
  ok_secondary := '0905736063' ~ '^(090[0-9]{7}|061[0-9]{7}|63[0-9]{8})$';

  if not ok_primary or not ok_secondary then
    raise exception 'v8 self-check failed';
  end if;

  raise notice 'v8 OK: primary 071xxxxxxx, backup 090/061/63 + 10 digits.';
end $$;

-- -----------------------------------------------------------------------------
-- Rows recorded under the old rules (run this to see what needs correcting):
--
--   select iccid, primary_number, secondary_number, created_at
--     from public.scans
--    where primary_number   !~ '^071[0-9]{7}$'
--       or secondary_number !~ '^(090[0-9]{7}|061[0-9]{7}|63[0-9]{8})$';
-- -----------------------------------------------------------------------------
