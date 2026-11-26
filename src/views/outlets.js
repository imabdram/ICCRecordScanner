import { banner, card, h, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchOutletOverview } from '../data.js';

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
    const rows = await fetchOutletOverview();

    const reps = rows.reduce((s, r) => s + Number(r.reps ?? 0), 0);
    const leaders = rows.reduce((s, r) => s + Number(r.team_leaders ?? 0), 0);
    const today = rows.reduce((s, r) => s + Number(r.vouchers_today ?? 0), 0);
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
          card('Sales Reps', String(reps)),
          card('E-Vouchers Today', money(today), { accent: 'accent-red' }),
          card('This Month', money(month), { accent: 'accent-green' }),
        ),
        h(
          'div',
          { class: 'panel' },
          table(
            [
              { label: 'Outlet', value: (r) => h('span', { class: 'cell-strong' }, r.outlet_name) },
              { label: 'Region', value: (r) => r.region_name ?? '—' },
              { label: 'Team leaders', value: (r) => String(r.team_leaders ?? 0) },
              { label: 'Sales reps', value: (r) => String(r.reps ?? 0) },
              { label: 'Active users', value: (r) => String(r.active_users ?? 0) },
              { label: 'Today', value: (r) => money(r.vouchers_today) },
              { label: 'This month', value: (r) => money(r.vouchers_month) },
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
