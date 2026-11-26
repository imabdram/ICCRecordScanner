-- =============================================================================
-- v16: SIM-card counts per sales rep, and per outlet
--
-- "SIM cards opened" = rows in public.scans. Days are bucketed in the operator's
-- timezone, like the e-voucher reports.
--
-- Performance note: the first version joined users + vouchers + scans in one
-- query, which multiplies rows (outlets x users x vouchers x scans) before
-- aggregating and timed out on real data. These versions aggregate in scalar
-- subqueries instead, each hitting an index, so the work stays proportional to
-- the outlet/rep count rather than to the number of transactions.
--
-- Run after v15. Safe to re-run.
-- =============================================================================

-- Indexes the subqueries rely on.
create index if not exists scans_rep_created_idx on public.scans (sales_rep_id, created_at desc);
create index if not exists scans_outlet_created_idx on public.scans (outlet_id, created_at desc);
create index if not exists vouchers_outlet_received_idx2 on public.vouchers (outlet_id, received_at desc);
create index if not exists users_outlet_idx on public.users (outlet_id);

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
  (select count(*) from public.scans s
    where s.sales_rep_id = u.id
      and (s.created_at at time zone 'Africa/Mogadishu')::date
          = (now() at time zone 'Africa/Mogadishu')::date)  as sims_today,
  (select count(*) from public.scans s
    where s.sales_rep_id = u.id
      and date_trunc('month', s.created_at at time zone 'Africa/Mogadishu')
          = date_trunc('month', now() at time zone 'Africa/Mogadishu')) as sims_month,
  (select count(*) from public.scans s
    where s.sales_rep_id = u.id)                            as sims_total,
  (select max(s.created_at) from public.scans s
    where s.sales_rep_id = u.id)                            as last_scan_at
from public.users u
left join public.outlets o on o.id = u.outlet_id
left join public.regions r on r.id = o.region_id
left join public.users  tl on tl.id = u.team_leader_id;

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
  (select count(*) from public.users u
    where u.outlet_id = o.id and u.role = 'sales_rep')       as reps,
  (select count(*) from public.users u
    where u.outlet_id = o.id and u.role = 'team_leader')     as team_leaders,
  (select count(*) from public.users u
    where u.outlet_id = o.id and u.active)                   as active_users,
  (select coalesce(sum(v.amount), 0) from public.vouchers v
    where v.outlet_id = o.id
      and (v.received_at at time zone 'Africa/Mogadishu')::date
          = (now() at time zone 'Africa/Mogadishu')::date)   as vouchers_today,
  (select coalesce(sum(v.amount), 0) from public.vouchers v
    where v.outlet_id = o.id
      and date_trunc('month', v.received_at at time zone 'Africa/Mogadishu')
          = date_trunc('month', now() at time zone 'Africa/Mogadishu')) as vouchers_month,
  -- Fall back to the rep's outlet: a scan row whose outlet_id is null (or was
  -- stamped before an outlet move) must still land on a branch, otherwise an
  -- outlet shows 0 while its reps show real numbers.
  (select count(*) from public.scans s
    left join public.users su on su.id = s.sales_rep_id
    where coalesce(s.outlet_id, su.outlet_id) = o.id
      and (s.created_at at time zone 'Africa/Mogadishu')::date
          = (now() at time zone 'Africa/Mogadishu')::date)   as sims_today,
  (select count(*) from public.scans s
    left join public.users su on su.id = s.sales_rep_id
    where coalesce(s.outlet_id, su.outlet_id) = o.id
      and date_trunc('month', s.created_at at time zone 'Africa/Mogadishu')
          = date_trunc('month', now() at time zone 'Africa/Mogadishu')) as sims_month,
  (select count(*) from public.scans s
    left join public.users su on su.id = s.sales_rep_id
    where coalesce(s.outlet_id, su.outlet_id) = o.id)        as sims_total
from public.outlets o
join public.regions r on r.id = o.region_id
join public.zones   z on z.id = r.zone_id;

grant select on public.v_rep_sim_report, public.v_outlet_overview to authenticated;
revoke all on public.v_rep_sim_report, public.v_outlet_overview from anon;

do $$
begin
  if to_regclass('public.v_rep_sim_report') is null then
    raise exception 'v16 incomplete: v_rep_sim_report missing';
  end if;
  raise notice 'v16 OK: SIM cards per rep and per outlet (aggregated with indexes).';
end $$;
