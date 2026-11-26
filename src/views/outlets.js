import { banner, card, h, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchOutletOverview, fetchRepSimReport } from '../data.js';

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * Regional outlets.
 *
 * The supervisor's home view: every outlet in their region with its people and
 * voucher totals. RLS decides the list, so this page shows nothing outside the
 * caller's region even if it is opened by hand.
 */
export async function renderOutlets(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(5)));

  try {
    const [rows, reps] = await Promise.all([fetchOutletOverview(), fetchRepSimReport()]);

    const repCount = rows.reduce((s, r) => s + Number(r.reps ?? 0), 0);
    const leaders = rows.reduce((s, r) => s + Number(r.team_leaders ?? 0), 0);
    const today = rows.reduce((s, r) => s + Number(r.vouchers_today ?? 0), 0);
    const simsToday = rows.reduce((s, r) => s + Number(r.sims_today ?? 0), 0);
    const simsMonth = rows.reduce((s, r) => s + Number(r.sims_month ?? 0), 0);
    const month = rows.reduce((s, r) => s + Number(r.vouchers_month ?? 0), 0);

    mount(
      root,
      h(
        'div',
        {},
        h(
          'div',
          { class: 'page-head' },
          h(
            'div',
            {},
            h('h1', {}, 'Regional Outlets'),
            h(
              'p',
              { class: 'sub' },
              `Every outlet in your scope · you are ${roleName(profile.role)}`,
            ),
          ),
        ),
        h(
          'div',
          { class: 'cards' },
          card('Outlets', String(rows.length), { foot: 'in your region' }),
          card('Team Leaders', String(leaders)),
          card('Sales Reps', String(repCount)),
          card('E-Vouchers Today', money(today), { accent: 'accent-red' }),
          card('This Month', money(month), { accent: 'accent-green' }),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h2', { style: { margin: '0 0 4px', fontSize: '16px' } }, 'SIM cards opened by sales rep'),
          h(
            'p',
            { class: 'sub', style: { margin: '0 0 12px' } },
            'Today ' + simsToday + ' · this month ' + simsMonth + ' · every rep in your scope',
          ),
          table(
            [
              {
                label: 'Sales rep',
                value: (r) =>
                  h(
                    'div',
                    {},
                    h('div', { class: 'cell-strong' }, r.full_name || r.username),
                    h('div', { class: 'cell-sub' }, r.team_leader_name ?? '—'),
                  ),
              },
              { label: 'Outlet', value: (r) => r.outlet_name ?? '—' },
              { label: 'Today', value: (r) => String(r.sims_today ?? 0) },
              { label: 'This month', value: (r) => String(r.sims_month ?? 0) },
              { label: 'Total', value: (r) => String(r.sims_total ?? 0) },
              {
                label: 'Last scan',
                value: (r) =>
                  r.last_scan_at ? new Date(r.last_scan_at).toLocaleDateString() : 'never',
              },
            ],
            reps,
            'No SIM cards recorded in your scope yet.',
          ),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h2', { style: { margin: '0 0 4px', fontSize: '16px' } }, 'Outlets · people and e-vouchers'),
          h(
            'p',
            { class: 'sub', style: { margin: '0 0 12px' } },
            'Every outlet in your region, with its team and e-voucher totals',
          ),
          table(
            [
              { label: 'Outlet', value: (r) => h('span', { class: 'cell-strong' }, r.outlet_name) },
              { label: 'Region', value: (r) => r.region_name ?? '—' },
              { label: 'Team leaders', value: (r) => String(r.team_leaders ?? 0) },
              { label: 'Sales reps', value: (r) => String(r.reps ?? 0) },
              { label: 'Active users', value: (r) => String(r.active_users ?? 0) },
              { label: 'SIMs today', value: (r) => String(r.sims_today ?? 0) },
              { label: 'SIMs this month', value: (r) => String(r.sims_month ?? 0) },
              { label: 'E-vouchers today', value: (r) => money(r.vouchers_today) },
              { label: 'E-vouchers this month', value: (r) => money(r.vouchers_month) },
            ],
            rows,
            'No outlets in your scope. A supervisor needs a region assigned; ask an administrator.',
          ),
        ),
      ),
    );
  } catch (error) {
    mount(
      root,
      h('div', { class: 'panel' }, h('h1', {}, 'Regional Outlets'), banner('error', error.message)),
    );
  }
}
