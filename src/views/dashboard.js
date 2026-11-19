import { barChart, banner, card, h, mount, pill, roleName, skeletonPanel, table } from '../ui.js';
import { fetchRepCounts, fetchTree, summarise } from '../data.js';

/**
 * "How many SIMs has each sales rep opened?" — the console's main question.
 *
 * Counts come from `v_rep_scan_counts`; labels come from the zone tree. Both are
 * already filtered by RLS (rep: own outlet, team leader: outlet, supervisor:
 * zone, admin: everything).
 */
export async function renderDashboard(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(5), skeletonPanel(3)));

  try {
    const [rows, tree] = await Promise.all([fetchRepCounts(), fetchTree()]);

    const outletName = new Map(tree.outlets.map((o) => [o.id, o.name]));
    const regionById = new Map(tree.regions.map((r) => [r.id, r]));
    const zoneName = new Map(tree.zones.map((z) => [z.id, z.name]));
    const regionName = (id) => regionById.get(id)?.name ?? '—';
    const zoneOf = (regionId) => {
      const zid = regionId ? regionById.get(regionId)?.zone_id : null;
      return zid ? zoneName.get(zid) ?? '—' : '—';
    };

    const labelled = rows.map((r) => ({
      ...r,
      outlet_display: outletName.get(r.outlet_id) ?? '—',
      region_display: regionName(r.region_id),
      zone_display: zoneOf(r.region_id),
    }));

    const totals = summarise(labelled);
    const reps = labelled
      .filter((r) => r.role === 'sales_rep')
      .sort((a, b) => Number(b.scans_total) - Number(a.scans_total));
    const leaders = labelled.filter((r) => r.role === 'team_leader');
    const supervisors = labelled.filter((r) => r.role === 'supervisor');
    const activeReps = reps.filter((r) => r.active).length;
    const top = reps[0];

    const scope = [profile.zone_name, profile.region_name, profile.outlet_name].filter(Boolean).join('  ›  ');

    mount(
      root,
      h(
        'div',
        {},
        h(
          'div',
          { class: 'page-head' },
          h('div', {}, h('h1', {}, 'Dashboard'), h('p', { class: 'sub' }, `${roleName(profile.role)} · ${scope || 'No scope assigned'}`)),
        ),

        h(
          'div',
          { class: 'cards' },
          card('Scans today', totals.scansToday, { accent: 'accent-red', foot: totals.scansToday ? 'Across your scope' : 'No scans logged yet today' }),
          card('Scans total', totals.scansTotal, { foot: 'All time' }),
          card('Active sales reps', `${activeReps}`, { accent: 'accent-green', foot: `of ${reps.length} in scope` }),
          card('Team leaders', leaders.length, { accent: 'accent-amber', foot: `${supervisors.length} supervisor(s)` }),
        ),

        h(
          'section',
          { class: 'panel' },
          h(
            'div',
            { class: 'panel-head' },
            h('h2', {}, 'SIMs opened per sales rep'),
            h('span', { class: 'hint' }, top && Number(top.scans_total) > 0 ? `Top: ${top.full_name} · ${top.scans_total}` : 'No scans yet'),
          ),
          reps.length
            ? barChart(reps.map((r) => ({ label: r.full_name, value: Number(r.scans_total) })), { red: true })
            : h('div', { class: 'empty' }, 'No sales reps in your scope yet.'),
        ),

        h(
          'section',
          { class: 'panel', id: 'leaderboard' },
          h('div', { class: 'panel-head' }, h('h2', {}, 'Sales rep leaderboard'), h('span', { class: 'hint' }, 'Newest numbers first')),
          table(
            [
              { label: '#', value: (_r, i) => h('span', { class: `rank${i < 3 ? ' top' : ''}` }, String(i + 1)) },
              { label: 'Sales rep', value: (r) => h('span', { class: 'cell-strong' }, r.full_name || r.username) },
              { label: 'Today', value: (r) => h('span', { class: 'num big' }, String(r.scans_today)) },
              { label: 'Total', value: (r) => h('span', { class: 'num big' }, String(r.scans_total)) },
              { label: 'Outlet', value: (r) => r.outlet_display },
              { label: 'Region', value: (r) => r.region_display },
              { label: 'Zone', value: (r) => r.zone_display },
              { label: 'Team leader', value: (r) => (r.team_leader_name ? h('span', { class: 'cell-sub' }, r.team_leader_name) : '—') },
              { label: 'Status', value: (r) => pill(r.active ? 'Active' : 'Disabled', r.active ? 'ok' : 'off') },
            ],
            reps,
            'No sales reps in your scope yet.',
          ),
        ),

        h(
          'div',
          { class: 'panel' },
          h('h2', {}, 'Structure in your scope'),
          h(
            'div',
            { class: 'tree' },
            ...tree.zones.map((zone) => {
              const regions = tree.regions.filter((r) => r.zone_id === zone.id);
              return h(
                'details',
                { open: regions.length > 0 },
                h(
                  'summary',
                  {},
                  zone.name,
                  h('span', { class: 'count' }, `${regions.length} region(s) · ${tree.outlets.filter((o) => regions.some((r) => r.id === o.region_id)).length} outlet(s)`),
                ),
                ...regions.map((region) => {
                  const outlets = tree.outlets.filter((o) => o.region_id === region.id);
                  return h(
                    'div',
                    { class: 'region' },
                    h('div', { class: 'region-name' }, region.name),
                    outlets.length
                      ? h('ul', { class: 'outlet-list' }, ...outlets.map((o) => h('li', {}, o.name)))
                      : h('div', { class: 'cell-sub' }, 'No outlets yet'),
                  );
                }),
              );
            }),
          ),
        ),

        supervisors.length || leaders.length
          ? h(
              'div',
              { class: 'panel' },
              h('h2', {}, 'Team leaders & supervisors'),
              table(
                [
                  { label: 'Name', value: (r) => h('span', { class: 'cell-strong' }, r.full_name || r.username) },
                  { label: 'Role', value: (r) => roleName(r.role) },
                  { label: 'Outlet', value: (r) => r.outlet_display },
                  { label: 'Region', value: (r) => r.region_display },
                  { label: 'Total scans in scope', value: (r) => h('span', { class: 'num big' }, String(r.scans_total)) },
                ],
                [...supervisors, ...leaders],
              ),
            )
          : null,
      ),
    );
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h1', {}, 'Dashboard'), banner('error', error.message)));
  }
}
