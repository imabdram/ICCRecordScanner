-- =============================================================================
-- SIM Management System -- v6: primary number must be 71xxxxxxx
--
-- RUN AFTER schema_v2_greenfield.sql, seed_v2.sql, schema_v5_login_only.sql.
-- Safe to re-run.
--
-- RULE
--   primary_number : exactly 9 digits, starting 71   (71 + 7 digits)
--   secondary_number: unchanged -- any 7 to 12 digits ("normal" number)
--
-- Enforced in the table, so a modified client cannot store something else.
-- The app and the website mirror this rule only to give a friendly message.
-- =============================================================================

alter table public.scans drop constraint if exists scans_primary_number_check;

alter table public.scans
  add constraint scans_primary_number_check
  check (primary_number ~ '^71[0-9]{7}$');

-- Keep the constraint name stable for the self-check and for future migrations.
comment on constraint scans_primary_number_check on public.scans is
  'Primary number must be 71 followed by 7 digits (9 total).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'scans_primary_number_check' and conrelid = 'public.scans'::regclass
  ) then
    raise exception 'v6 incomplete: primary number constraint missing';
  end if;
  raise notice 'v6 OK: primary_number must match 71xxxxxxx.';
end $$;
