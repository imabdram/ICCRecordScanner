-- =============================================================================
-- v16: SIM-card counts per sales rep, and per outlet
--
-- "SIM cards opened" = rows in public.scans. Days are bucketed in the operator's
-- timezone, like the e-voucher reports.
--
-- Run after v15. Safe to re-run.
-- =============================================================================

drop view if exists public.v_rep_sim_report;
create view public.v_rep_sim_report
with (security_invoker = true)
as
select
  u.id                                    as user_id,
  u.full_name,
  u.username,
  u.role,
  u.active,
  o.id                                    as outlet_id,
  o.name                                  as outlet_name,
  r.name                                  as region_name,
  tl.full_name                            as team_leader_name,
  count(s.id) filter (
    where (s.created_at at time zone 'Africa/Mogadishu')::date
        = (now() at time zone 'Africa/Mogadishu')::date
  )                                       as sims_today,
  count(s.id) filter (
    where date_trunc('month', s.created_at at time zone 'Africa/Mogadishu')
        = date_trunc('month', now() at time zone 'Africa/Mogadishu')
  )                                       as sims_month,
  count(s.id)                             as sims_total,
  max(s.created_at)                       as last_scan_at
from public.users u
left join public.outlets o on o.id = u.outlet_id
left join public.regions r on r.id = o.region_id
left join public.users  tl on tl.id = u.team_leader_id
left join public.scans   s on s.sales_rep_id = u.id
group by u.id, u.full_name, u.username, u.role, u.active,
         o.id, o.name, r.name, tl.full_name;

-- Per outlet, so the supervisor sees which branch is producing.
drop view if exists public.v_outlet_overview;
create view public.v_outlet_overview
with (security_invoker = true)
as
select
  o.id                                   as outlet_id,
  o.name                                 as outlet_name,
  r.id                                   as region_id,
  r.name                                 as region_name,
  z.name                                 as zone_name,
  count(distinct u.id) filter (where u.role = 'sales_rep')   as reps,
  count(distinct u.id) filter (where u.role = 'team_leader') as team_leaders,
  count(distinct u.id) filter (where u.active)               as active_users,
  coalesce(sum(v.amount) filter (
    where (v.received_at at time zone 'Africa/Mogadishu')::date
          = (now() at time zone 'Africa/Mogadishu')::date
  ), 0)                                  as vouchers_today,
  coalesce(sum(v.amount) filter (
    where date_trunc('month', v.received_at at time zone 'Africa/Mogadishu')
        = date_trunc('month', now() at time zone 'Africa/Mogadishu')
  ), 0)                                  as vouchers_month,
  count(distinct s.id) filter (
    where (s.created_at at time zone 'Africa/Mogadishu')::date
        = (now() at time zone 'Africa/Mogadishu')::date
  )                                      as sims_today,
  count(distinct s.id) filter (
    where date_trunc('month', s.created_at at time zone 'Africa/Mogadishu')
        = date_trunc('month', now() at time zone 'Africa/Mogadishu')
  )                                      as sims_month,
  count(distinct s.id)                   as sims_total
from public.outlets o
join public.regions r on r.id = o.region_id
join public.zones   z on z.id = r.zone_id
left join public.users  u on u.outlet_id = o.id
left join public.vouchers v on v.outlet_id = o.id
left join public.scans    s on s.outlet_id = o.id
group by o.id, o.name, r.id, r.name, z.name;

grant select on public.v_rep_sim_report, public.v_outlet_overview to authenticated;
revoke all on public.v_rep_sim_report, public.v_outlet_overview from anon;

do $$
begin
  if to_regclass('public.v_rep_sim_report') is null then
    raise exception 'v16 incomplete: v_rep_sim_report missing';
  end if;
  raise notice 'v16 OK: SIM cards per rep and per outlet.';
end $$;
