/**
 * Reads the Zone -> Region -> Outlet -> User tree and the scan counters.
 *
 * Every query goes through PostgREST, so the rows returned are already limited
 * by Row Level Security to what the signed-in user may see:
 *   sales_rep   own scans, own outlet's team
 *   team_leader own outlet
 *   supervisor  whole zone
 *   admin       everything
 *
 * The query shapes are unchanged from the Neon build; only the client is
 * different, because both expose the same PostgREST API.
 */
import { supabase, unwrap } from './supabase.js';

/**
 * The signed-in user's own scope (outlet / region / zone names).
 *
 * `v_my_profile` exposes `username` (the login) rather than an email: accounts
 * are username-based, and the synthetic email is an implementation detail we
 * never show.
 */
export async function fetchProfile() {
  const rows = unwrap(
    await supabase()
      .from('v_my_profile')
      .select('user_id,username,full_name,phone,role,outlet_id,outlet_name,region_id,region_name,zone_id,zone_name,team_leader_id,team_leader_name,active'),
  );
  return rows?.[0] ?? null;
}

/** Zone tree, with the current user's permissions already applied. */
export async function fetchTree() {
  const [zones, regions, outlets] = await Promise.all([
    supabase().from('zones').select('id,name').order('name', { ascending: true }),
    supabase().from('regions').select('id,name,zone_id').order('name', { ascending: true }),
    supabase().from('outlets').select('id,name,region_id').order('name', { ascending: true }),
  ]);
  return {
    zones: unwrap(zones) ?? [],
    regions: unwrap(regions) ?? [],
    outlets: unwrap(outlets) ?? [],
  };
}

/**
 * Leaderboard: how many SIMs each sales rep has opened.
 * `v_rep_scan_counts` aggregates scans per rep with their outlet/region/zone.
 */
export async function fetchRepCounts() {
  return (
    unwrap(
      await supabase()
        .from('v_rep_scan_counts')
        .select('user_id,full_name,username,role,active,outlet_id,outlet_name,region_id,region_name,zone_id,zone_name,team_leader_name,scans_today,scans_total')
        .order('scans_today', { ascending: false }),
    ) ?? []
  );
}

export async function fetchUsers() {
  return (
    unwrap(
      await supabase()
        .from('users')
        .select('id,username,full_name,phone,role,outlet_id,team_leader_id,active')
        .order('full_name', { ascending: true }),
    ) ?? []
  );
}

/**
 * Recent scans from the flat reporting view (already scoped by RLS).
 *
 * `v_scan_records` has no device columns any more: v5 removed the device model,
 * so every scan belongs to a person.
 */
export async function fetchScans(limit = 200) {
  return (
    unwrap(
      await supabase()
        .from('v_scan_records')
        .select('id,iccid,customer_name,primary_number,secondary_number,created_at,updated_at,sales_rep_id,sales_rep_name,outlet_name,region_name,zone_name')
        .order('created_at', { ascending: false })
        .limit(limit),
    ) ?? []
  );
}

/**
 * Deleted scans, newest deletion first.
 *
 * Written by the scans_audit_delete trigger. Read-only by design: there is no
 * insert/update/delete policy, so nobody can rewrite history through the API.
 * RLS: admin anywhere, supervisor their zone, team leader their outlet.
 */
export async function fetchDeletions(limit = 300) {
  return (
    unwrap(
      await supabase()
        .from('scan_deletions')
        .select('id,scan_id,iccid,customer_name,primary_number,secondary_number,sales_rep_name,outlet_name,scan_created_at,deleted_at,deleted_by_username')
        .order('deleted_at', { ascending: false })
        .limit(limit),
    ) ?? []
  );
}

/**
 * E-voucher totals per rep: today, this month, and when the phone last uploaded.
 *
 * `last_received_at` doubles as a freshness signal: a rep with sales but no
 * recent voucher has a phone that is not syncing, not a rep who stopped selling.
 */
export async function fetchVoucherTotals() {
  return (
    unwrap(
      await supabase()
        .from('v_voucher_totals')
        .select('user_id,full_name,username,role,active,outlet_name,region_name,zone_name,today_amount,today_count,month_amount,month_count,last_received_at')
        .order('month_amount', { ascending: false }),
    ) ?? []
  );
}

/** Per rep per day, for a chart or a CSV export. */
export async function fetchVoucherDaily(limit = 1000) {
  return (
    unwrap(
      await supabase()
        .from('v_voucher_daily')
        .select('sales_rep_id,sales_rep_name,outlet_name,day,amount,vouchers')
        .order('day', { ascending: false })
        .limit(limit),
    ) ?? []
  );
}

/**
 * Deletes a scan.
 *
 * Who may is enforced by the `scans_delete` policy: admin anywhere, supervisor
 * in their zone, team leader in their outlet. A sales rep cannot delete at all,
 * including their own rows -- history is the office's to remove.
 */
export async function deleteScan(scanId) {
  unwrap(await supabase().from('scans').delete().eq('id', scanId));
}

/**
 * Assigns a user's profile fields (name, phone, role, outlet, team leader).
 * Admin, supervisor or team leader only — enforced by RLS and by the
 * `users_guard_privileges` trigger, which blocks self-escalation.
 *
 * Note: `active` is NOT set here. Disabling must also ban the auth login, which
 * needs the service role, so it goes through the admin-user function.
 */
export async function updateUser(userId, patch) {
  const { active, ...profilePatch } = patch ?? {};
  if (active !== undefined) {
    throw new Error('Enable or disable accounts from Users & Team, which also bans the login.');
  }
  unwrap(await supabase().from('users').update(profilePatch).eq('id', userId).select());
}

/** Dashboard totals for the current scope. */
export function summarise(rows) {
  const today = rows.reduce((sum, r) => sum + Number(r.scans_today ?? 0), 0);
  const total = rows.reduce((sum, r) => sum + Number(r.scans_total ?? 0), 0);
  return { scansToday: today, scansTotal: total, people: rows.length };
}

/** Individual voucher rows for one rep on one day (the second drill-down). */
export async function fetchVoucherEntries(repId, day) {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return (
    unwrap(
      await supabase()
        .from('vouchers')
        .select('received_at,amount')
        .eq('sales_rep_id', repId)
        .gte('received_at', start.toISOString())
        .lt('received_at', end.toISOString())
        .order('received_at', { ascending: false }),
    ) ?? []
  );
}
/**
 * Per-rep per-day vouchers already bucketed into Africa/Mogadishu days.
 * One row = one rep on one day; the report builder fills the empty days.
 */
export async function fetchVoucherDailyLocal(from, to, limit = 5000) {
  let query = supabase()
    .from('v_voucher_daily_local')
    .select('sales_rep_id,sales_rep_name,outlet_name,region_name,day,amount,vouchers')
    .order('day', { ascending: true })
    .limit(limit);

  if (from) query = query.gte('day', from);
  if (to) query = query.lte('day', to);

  return unwrap(await query) ?? [];
}