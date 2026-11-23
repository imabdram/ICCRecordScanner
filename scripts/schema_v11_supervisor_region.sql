-- v11: supervisors belong to a REGION, not an outlet.
-- Run after v2..v10. Safe to re-run.

alter table public.users
  add column if not exists region_id uuid references public.regions(id) on delete set null;

-- Existing supervisors: derive a region from their outlet.
update public.users u
   set region_id = o.region_id
  from public.outlets o
 where u.region_id is null and u.outlet_id = o.id and u.role = 'supervisor';

create or replace function public.my_region_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select region_id from public.users
   where auth_user_id = auth.uid() and active
   limit 1;
$$;

grant execute on function public.my_region_id() to authenticated;

-- Scans: a supervisor sees their whole region.
drop policy if exists scans_read on public.scans;
create policy scans_read on public.scans
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and region_id = public.my_region_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
    or sales_rep_id = (select id from public.current_app_user())
  );

-- Vouchers: same rule.
drop policy if exists vouchers_read on public.vouchers;
create policy vouchers_read on public.vouchers
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and region_id = public.my_region_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
    or sales_rep_id = (select id from public.current_app_user())
  );

-- Users: a supervisor manages their region.
drop policy if exists users_read on public.users;
create policy users_read on public.users
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and (
         region_id = public.my_region_id()
         or outlet_id in (select id from public.outlets where region_id = public.my_region_id())
       ))
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
    or auth_user_id = auth.uid()
  );

drop policy if exists users_admin_write on public.users;
create policy users_admin_write on public.users
  for all to authenticated
  using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and (
         region_id = public.my_region_id()
         or outlet_id in (select id from public.outlets where region_id = public.my_region_id())
       ))
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
  )
  with check (
    (
      public.is_admin()
      or (public.my_role() = 'supervisor' and (
           region_id = public.my_region_id()
           or outlet_id in (select id from public.outlets where region_id = public.my_region_id())
         ))
      or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
    )
    and (public.is_admin() or role in ('sales_rep', 'team_leader'))
  );

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'users' and column_name = 'region_id'
  ) then
    raise exception 'v11 incomplete: users.region_id missing';
  end if;
  raise notice 'v11 OK: supervisors are scoped by region.';
end $$;
