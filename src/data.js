/**
 * Reads the Zone -> Region -> Outlet -> User tree and the scan counters.
 *
 * Every query goes through the Data API, so the rows returned are already
 * limited by Row Level Security to what the signed-in user may see:
 *   sales_rep   own scans, own outlet's team
 *   team_leader own outlet
 *   supervisor  whole zone
 *   admin       everything
 */
import { neon, unwrap } from './neon.js';

/** The signed-in user's own scope (outlet / region / zone names). */
export async function fetchProfile() {
  const rows = unwrap(
    await neon()
      .from('v_my_profile')
      .select('user_id,email,full_name,phone,role,outlet_id,outlet_name,region_id,region_name,zone_id,zone_name,team_leader_name,active'),
  );
  return rows?.[0] ?? null;
}

/** Zone tree, with the current user's permissions already applied. */
export async function fetchTree() {
  const [zones, regions, outlets] = await Promise.all([
    neon().from('zones').select('id,name').order('name', { ascending: true }),
    neon().from('regions').select('id,name,zone_id').order('name', { ascending: true }),
    neon().from('outlets').select('id,name,region_id').order('name', { ascending: true }),
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
      await neon()
        .from('v_rep_scan_counts')
        .select('user_id,full_name,username,role,active,outlet_id,outlet_name,region_id,region_name,zone_id,zone_name,team_leader_name,scans_today,scans_total')
        .order('scans_today', { ascending: false }),
    ) ?? []
  );
}

export async function fetchUsers() {
  return (
    unwrap(
      await neon()
        .from('users')
        .select('id,username,full_name,phone,role,outlet_id,team_leader_id,active')
        .order('full_name', { ascending: true }),
    ) ?? []
  );
}

/** Recent scans from the flat reporting view (already scoped by RLS). */
export async function fetchScans(limit = 200) {
  return (
    unwrap(
      await neon()
        .from('v_scan_records')
        .select('id,iccid,customer_name,primary_number,secondary_number,created_at,sales_rep_name,outlet_name,region_name,zone_name')
        .order('created_at', { ascending: false })
        .limit(limit),
    ) ?? []
  );
}

/** Assigns a user's status/role/outlet/team leader. Admin or supervisor only. */
export async function updateUser(userId, patch) {
  unwrap(await neon().from('users').update(patch).eq('id', userId).select());
}

/** Dashboard totals for the current scope. */
export function summarise(rows) {
  const today = rows.reduce((sum, r) => sum + Number(r.scans_today ?? 0), 0);
  const total = rows.reduce((sum, r) => sum + Number(r.scans_total ?? 0), 0);
  return { scansToday: today, scansTotal: total, people: rows.length };
}
