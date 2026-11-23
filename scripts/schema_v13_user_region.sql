-- v13: every profile carries its region, so region scoping works for all roles.
-- Run after v12. Safe to re-run.

-- Backfill from the outlet (team leaders and reps never had a region set).
update public.users u
   set region_id = o.region_id
  from public.outlets o
 where u.region_id is null and u.outlet_id = o.id;

-- Keep it in sync on every write.
create or replace function public.users_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.outlet_id is not null then
    select region_id into new.region_id from public.outlets where id = new.outlet_id;
  end if;
  return new;
end;
$$;

drop trigger if exists users_before_write on public.users;
create trigger users_before_write
  before insert or update on public.users
  for each row execute function public.users_before_write();

do $$
begin
  raise notice 'v13 OK: users.region_id backfilled and kept in sync.';
end $$;
