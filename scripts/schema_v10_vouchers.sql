-- =============================================================================
-- SIM Management System -- v10: e-voucher totals on the website
--
-- RUN AFTER schema_v2 .. schema_v9. Safe to re-run.
--
-- WHY
--   The app totals airtime vouchers from the operator's 913 SMS messages. That
--   lives on one phone, so a team leader cannot see it. This puts the vouchers in
--   Postgres with the same shape as scans: the reporter is stamped from the login,
--   location is derived from them, and RLS scopes what each role reads.
--
-- WHAT A VOUCHER IS
--   One airtime SMS: an amount and the timestamp inside the message. It is not
--   audited money -- it is what the handset reported -- so it is stored and
--   shown as a per-rep figure, not as cash.
-- =============================================================================

create table if not exists public.vouchers (
  id             uuid primary key default gen_random_uuid(),
  -- The SMS id on the phone. Unique per rep, so re-uploading never double counts.
  message_id     text not null,
  sales_rep_id   uuid not null references public.users(id) on delete cascade,
  outlet_id      uuid not null references public.outlets(id) on delete restrict,
  region_id      uuid not null references public.regions(id) on delete restrict,
  zone_id        uuid not null references public.zones(id) on delete restrict,
  amount         numeric(12, 2) not null check (amount >= 0),
  received_at    timestamptz not null,
  created_at     timestamptz not null default now(),
  unique (sales_rep_id, message_id)
);

create index if not exists vouchers_rep_received_idx
  on public.vouchers (sales_rep_id, received_at desc);
create index if not exists vouchers_outlet_received_idx
  on public.vouchers (outlet_id, received_at desc);
create index if not exists vouchers_zone_received_idx
  on public.vouchers (zone_id, received_at desc);

-- -----------------------------------------------------------------------------
-- Stamp the reporter and the location, exactly like scans.
-- The client never supplies any of these.
-- -----------------------------------------------------------------------------
create or replace function public.vouchers_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me        public.users;
  my_outlet public.outlets;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null then
      raise exception 'A voucher must be uploaded by a signed-in user'
        using errcode = '42501';
    end if;

    select * into me from public.users
     where auth_user_id = auth.uid() and active limit 1;
    if me.id is null then
      raise exception 'No active profile for this account' using errcode = '42501';
    end if;
    if me.outlet_id is null then
      raise exception 'Your account has no outlet assigned' using errcode = '42501';
    end if;

    -- Always the caller, never the payload.
    new.sales_rep_id := me.id;

    select * into my_outlet from public.outlets where id = me.outlet_id;
    new.outlet_id := my_outlet.id;
    select r.zone_id, r.id into new.zone_id, new.region_id
      from public.regions r where r.id = my_outlet.region_id;
  end if;

  return new;
end;
$$;

drop trigger if exists vouchers_before_write on public.vouchers;
create trigger vouchers_before_write
  before insert or update on public.vouchers
  for each row execute function public.vouchers_before_write();

-- -----------------------------------------------------------------------------
-- RLS: same shape as scans.
-- -----------------------------------------------------------------------------
alter table public.vouchers enable row level security;

drop policy if exists vouchers_read on public.vouchers;
create policy vouchers_read on public.vouchers
  for select to authenticated using (
    public.is_admin()
    or (public.my_role() = 'supervisor' and zone_id = public.my_zone_id())
    or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
    or sales_rep_id = (select id from public.current_app_user())
  );

drop policy if exists vouchers_insert on public.vouchers;
create policy vouchers_insert on public.vouchers
  for insert to authenticated
  with check (sales_rep_id = (select id from public.current_app_user()));

-- No update/delete policy: a voucher is a record of what the phone received.
grant select, insert on public.vouchers to authenticated;
revoke all on public.vouchers from anon;

-- -----------------------------------------------------------------------------
-- Reporting views
-- -----------------------------------------------------------------------------

-- Per rep: today, this month, and how fresh the data is.
drop view if exists public.v_voucher_totals;
create view public.v_voucher_totals
with (security_invoker = true)
as
select
  u.id                                   as user_id,
  u.full_name,
  u.username,
  u.role,
  u.active,
  o.name                                 as outlet_name,
  r.name                                 as region_name,
  z.name                                 as zone_name,
  coalesce(sum(v.amount) filter (
    where v.received_at >= date_trunc('day', now())
  ), 0)                                  as today_amount,
  count(v.id) filter (
    where v.received_at >= date_trunc('day', now())
  )                                      as today_count,
  coalesce(sum(v.amount) filter (
    where v.received_at >= date_trunc('month', now())
  ), 0)                                  as month_amount,
  count(v.id) filter (
    where v.received_at >= date_trunc('month', now())
  )                                      as month_count,
  max(v.received_at)                     as last_received_at
from public.users u
left join public.outlets o on o.id = u.outlet_id
left join public.regions r on r.id = o.region_id
left join public.zones   z on z.id = r.zone_id
left join public.vouchers v on v.sales_rep_id = u.id
group by u.id, u.full_name, u.username, u.role, u.active,
         o.name, r.name, z.name;

-- Per rep per day, for a chart or a CSV.
drop view if exists public.v_voucher_daily;
create view public.v_voucher_daily
with (security_invoker = true)
as
select
  v.sales_rep_id,
  u.full_name                            as sales_rep_name,
  o.name                                 as outlet_name,
  date_trunc('day', v.received_at)::date as day,
  sum(v.amount)                          as amount,
  count(*)                               as vouchers
from public.vouchers v
join public.users   u on u.id = v.sales_rep_id
join public.outlets o on o.id = v.outlet_id
group by v.sales_rep_id, u.full_name, o.name, date_trunc('day', v.received_at);

grant select on public.v_voucher_totals, public.v_voucher_daily to authenticated;
revoke all on public.v_voucher_totals, public.v_voucher_daily from anon;

-- -----------------------------------------------------------------------------
-- Self-check
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.vouchers') is null then
    raise exception 'v10 incomplete: vouchers table missing';
  end if;
  if to_regclass('public.v_voucher_totals') is null then
    raise exception 'v10 incomplete: v_voucher_totals missing';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgname = 'vouchers_before_write'
       and tgrelid = 'public.vouchers'::regclass
  ) then
    raise exception 'v10 incomplete: vouchers_before_write trigger missing';
  end if;
  raise notice 'v10 OK: vouchers stored, stamped and reported per rep.';
end $$;
