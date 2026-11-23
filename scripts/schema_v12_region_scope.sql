-- v12: a region supervisor sees the WHOLE region.
-- Run after v2..v11. Safe to re-run.

-- Regions: a supervisor with no outlet still needs to read their own region.
drop policy if exists regions_read on public.regions;
create policy regions_read on public.regions
  for select to authenticated using (
    public.is_admin()
    or zone_id = public.my_zone_id()
    or id = public.my_region_id()
  );

-- Audit trail: scoped by region, not zone. Skipped when v7 was never applied.
do $$
begin
  if to_regclass('public.scan_deletions') is not null then
    drop policy if exists scan_deletions_read on public.scan_deletions;
    create policy scan_deletions_read on public.scan_deletions
      for select to authenticated using (
        public.is_admin()
        or (public.my_role() = 'supervisor' and region_id = public.my_region_id())
        or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
      );
  end if;
end $$;

do $$
begin
  raise notice 'v12 OK: supervisors read their whole region (outlets, scans, vouchers, users, audit).';
end $$;
