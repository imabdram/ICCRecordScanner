-- =============================================================================
-- SIM Management System -- v7: audit trail for deleted scans
--
-- RUN AFTER schema_v2_greenfield.sql, seed_v2.sql, schema_v5_login_only.sql,
-- schema_v6_numbers.sql. Safe to re-run.
--
-- WHY
--   Deleting a scan is now possible from the website. Without a record, a
--   deletion is invisible: the row is gone and nobody can say who removed it or
--   what it contained. This keeps a full snapshot written automatically by a
--   trigger, so no code path -- website, app, or delete_user() -- can skip it.
--
-- WHAT IS STORED
--   A copy of the row as it was, plus who deleted it and when. The snapshot is
--   intentional: after the scan is gone, "8925... / Muse khalid / 717738604"
--   still has to be readable.
--
-- WHO CAN READ IT
--   Same shape as scans: admin anywhere, supervisor their zone, team leader
--   their outlet. Sales reps see nothing.
--
-- APPEND-ONLY
--   Only the trigger writes (SECURITY DEFINER). No insert/update/delete policy
--   exists, so even an admin cannot rewrite history through the API.
-- =============================================================================

create table if not exists public.scan_deletions (
  id                 uuid primary key default gen_random_uuid(),
  scan_id            uuid,                      -- original scans.id
  iccid              text not null,
  customer_name      text,
  primary_number     text,
  secondary_number   text,
  sales_rep_id       uuid,
  sales_rep_name     text,                      -- resolved at deletion time
  outlet_id          uuid,
  outlet_name        text,
  region_id          uuid,
  zone_id            uuid,
  scan_created_at    timestamptz,
  deleted_at         timestamptz not null default now(),
  deleted_by         uuid references public.users(id) on delete set null,
  deleted_by_username text
);

create index if not exists scan_deletions_deleted_at_idx
  on public.scan_deletions (deleted_at desc);
create index if not exists scan_deletions_iccid_idx
  on public.scan_deletions (iccid);

-- -----------------------------------------------------------------------------
-- Repair pass.
--
-- `create table if not exists` does nothing when a partial version of this table
-- already exists, which leaves the columns missing and the page failing with
-- "column does not exist". Adding each column individually makes this script
-- safe to re-run against a half-created table.
-- -----------------------------------------------------------------------------
alter table public.scan_deletions add column if not exists scan_id            uuid;
alter table public.scan_deletions add column if not exists iccid              text;
alter table public.scan_deletions add column if not exists customer_name      text;
alter table public.scan_deletions add column if not exists primary_number     text;
alter table public.scan_deletions add column if not exists secondary_number   text;
alter table public.scan_deletions add column if not exists sales_rep_id       uuid;
alter table public.scan_deletions add column if not exists sales_rep_name     text;
alter table public.scan_deletions add column if not exists outlet_id          uuid;
alter table public.scan_deletions add column if not exists outlet_name        text;
alter table public.scan_deletions add column if not exists region_id          uuid;
alter table public.scan_deletions add column if not exists zone_id            uuid;
alter table public.scan_deletions add column if not exists scan_created_at    timestamptz;
alter table public.scan_deletions add column if not exists deleted_at         timestamptz not null default now();
alter table public.scan_deletions add column if not exists deleted_by         uuid;
alter table public.scan_deletions add column if not exists deleted_by_username text;

-- -----------------------------------------------------------------------------
-- Trigger: snapshot the row before it disappears.
--
-- SECURITY DEFINER so the caller needs no INSERT grant on the audit table, and
-- a pinned search_path so nobody can shadow the tables it reads.
-- -----------------------------------------------------------------------------
create or replace function public.scans_audit_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me        public.users;
  rep_name  text;
  out_name  text;
begin
  -- A deletion performed by a signed-in person records who. Deletions from a
  -- migration or the service role have no user context and leave it null.
  select * into me from public.users
   where auth_user_id = auth.uid() and active limit 1;

  select u.full_name into rep_name
    from public.users u where u.id = old.sales_rep_id;
  select o.name into out_name
    from public.outlets o where o.id = old.outlet_id;

  insert into public.scan_deletions (
    scan_id, iccid, customer_name, primary_number, secondary_number,
    sales_rep_id, sales_rep_name, outlet_id, outlet_name, region_id, zone_id,
    scan_created_at, deleted_by, deleted_by_username
  ) values (
    old.id, old.iccid, old.customer_name, old.primary_number, old.secondary_number,
    old.sales_rep_id, rep_name, old.outlet_id, out_name, old.region_id, old.zone_id,
    old.created_at, me.id, me.username
  );

  return old;
end;
$$;

drop trigger if exists scans_audit_delete on public.scans;
create trigger scans_audit_delete
  before delete on public.scans
  for each row execute function public.scans_audit_delete();

-- -----------------------------------------------------------------------------
-- Row Level Security: readable by the same people who can read the scan, and
-- writable by nobody.
-- -----------------------------------------------------------------------------
alter table public.scan_deletions enable row level security;

drop policy if exists scan_deletions_read on public.scan_deletions;
create policy scan_deletions_read on public.scan_deletions
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and zone_id = public.my_zone_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
  );

grant select on public.scan_deletions to authenticated;
revoke all on public.scan_deletions from anon;

-- -----------------------------------------------------------------------------
-- Self-check
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.scan_deletions') is null then
    raise exception 'v7 incomplete: scan_deletions table missing';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgname = 'scans_audit_delete' and tgrelid = 'public.scans'::regclass
  ) then
    raise exception 'v7 incomplete: scans_audit_delete trigger missing';
  end if;
  raise notice 'v7 OK: deletions are recorded.';
end $$;
