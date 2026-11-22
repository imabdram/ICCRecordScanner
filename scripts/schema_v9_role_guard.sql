-- =============================================================================
-- SIM Management System -- v9: only an admin may create admins/supervisors
--
-- RUN AFTER schema_v2 .. schema_v8. Safe to re-run.
--
-- WHY
--   users_admin_write lets a supervisor insert and update users inside their own
--   zone. The column guard (users_guard_privileges) only runs on UPDATE and
--   DELETE, so an INSERT of a row with role = 'admin' or 'supervisor' was allowed
--   for a supervisor. The website never offered it, but a modified client could
--   call the API directly: hiding a control is not security.
--
--   The WITH CHECK below closes that: a non-admin may only insert or hand out the
--   lower roles. Everything else in the policy is unchanged.
-- =============================================================================

drop policy if exists users_admin_write on public.users;
create policy users_admin_write on public.users
  for all to authenticated
  using (
    public.is_admin()
    or (public.my_role() = 'supervisor'
        and outlet_id in (
          select o.id from public.outlets o
          join public.regions r on r.id = o.region_id
          where r.zone_id = public.my_zone_id()))
    or (public.my_role() = 'team_leader'
        and outlet_id = public.my_outlet_id())
  )
  with check (
    (
      public.is_admin()
      or (public.my_role() = 'supervisor'
          and outlet_id in (
            select o.id from public.outlets o
            join public.regions r on r.id = o.region_id
            where r.zone_id = public.my_zone_id()))
      or (public.my_role() = 'team_leader'
          and outlet_id = public.my_outlet_id()
          and team_leader_id = (select id from public.current_app_user()))
    )
    -- Only an administrator may create, or promote anyone to, an admin or
    -- supervisor. Applies to INSERT and UPDATE alike because this is a FOR ALL
    -- policy and WITH CHECK is evaluated on both.
    and (
      public.is_admin()
      or role in ('sales_rep', 'team_leader')
    )
  );

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'users' and policyname = 'users_admin_write'
  ) then
    raise exception 'v9 incomplete: users_admin_write missing';
  end if;
  raise notice 'v9 OK: non-admins cannot create admins or supervisors.';
end $$;
