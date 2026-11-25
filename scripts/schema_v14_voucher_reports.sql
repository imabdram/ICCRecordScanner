-- =============================================================================
-- v14: E-voucher reporting views in the operator's timezone
--
-- v_voucher_daily truncated days in UTC, so a voucher received at 01:00 local
-- (Africa/Mogadishu, UTC+3) was counted on the previous day. These views do the
-- conversion first, so a "day" means the day the shop saw.
--
-- Run after v10. Safe to re-run.
-- =============================================================================

drop view if exists public.v_voucher_daily_local;
create view public.v_voucher_daily_local
with (security_invoker = true)
as
select
  v.sales_rep_id,
  u.full_name                                  as sales_rep_name,
  o.name                                       as outlet_name,
  r.name                                       as region_name,
  (v.received_at at time zone 'Africa/Mogadishu')::date as day,
  sum(v.amount)                                as amount,
  count(*)::int                                as vouchers
from public.vouchers v
join public.users   u on u.id = v.sales_rep_id
left join public.outlets o on o.id = v.outlet_id
left join public.regions r on r.id = v.region_id
group by v.sales_rep_id, u.full_name, o.name, r.name,
         (v.received_at at time zone 'Africa/Mogadishu')::date;

drop view if exists public.v_voucher_range_totals;
create view public.v_voucher_range_totals
with (security_invoker = true)
as
select
  v.sales_rep_id,
  u.full_name                                  as sales_rep_name,
  coalesce(o.name, '—')                        as outlet_name,
  coalesce(r.name, '—')                        as region_name,
  min((v.received_at at time zone 'Africa/Mogadishu')::date) as first_day,
  max((v.received_at at time zone 'Africa/Mogadishu')::date) as last_day,
  count(distinct (v.received_at at time zone 'Africa/Mogadishu')::date)::int as active_days,
  sum(v.amount)                                as amount,
  count(*)::int                                as vouchers
from public.vouchers v
join public.users u on u.id = v.sales_rep_id
left join public.outlets o on o.id = v.outlet_id
left join public.regions r on r.id = v.region_id
group by v.sales_rep_id, u.full_name, o.name, r.name;

grant select on public.v_voucher_daily_local, public.v_voucher_range_totals to authenticated;
revoke all on public.v_voucher_daily_local, public.v_voucher_range_totals from anon;

do $$
begin
  if to_regclass('public.v_voucher_daily_local') is null then
    raise exception 'v14 incomplete: v_voucher_daily_local missing';
  end if;
  raise notice 'v14 OK: daily vouchers reported in Africa/Mogadishu days.';
end $$;
