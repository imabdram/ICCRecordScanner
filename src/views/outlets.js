import { banner, card, h, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchOutletOverview } from '../data.js';

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * Regional outlets, SIM cards first, then e-vouchers.
 *
 * Two tables rather than one wide one: a supervisor reading SIMs should not have
 * to skip past money columns, and vice versa. RLS decides the list, so this shows
 * nothing outside the caller's region even if opened by hand.
 *
 * The per-rep SIM breakdown lives on Scan Records, next to the records it counts.
 */
export async function renderOutlets(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(5)));

  try {
    const rows = await fetchOutletOverview();

    const reps = rows.reduce((s, r) => s + Number(r.reps ?? 0), 0);
    const leaders = rows.reduce((s, r) => s + Number(r.team_leaders ?? 0), 0);
    const today = rows.reduce((s, r) => s + Number(r.vouchers_today ?? 0), 0);
    const month = rows.reduce((s, r) => s + Number(r.vouchers_month ?? 0), 0);
    const simsToday = rows.reduce((s, r) => s + Number(r.sims_today ?? 0), 0);
    const simsMonth = rows.reduce((s, r) => s + Number(r.sims_month ?? 0), 0);

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
            h('p', { class: 'sub' }, `Every outlet in your scope · you are ${roleName(profile.role)}`),
          ),
        ),
        h(
          'div',
          { class: 'cards' },
          card('Outlets', String(rows.length), { foot: 'in your region' }),
          card('Team Leaders', String(leaders)),
          card('Sales Reps', String(reps)),
          card('SIMs Today', String(simsToday), { accent: 'accent-red' }),
          card('E-Vouchers Today', money(today), { accent: 'accent-green' }),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h2', { style: { margin: '0 0 4px', fontSize: '16px' } }, 'Outlets · SIM cards opened'),
          h(
            'p',
            { class: 'sub', style: { margin: '0 0 12px' } },
            `Today ${simsToday} · this month ${simsMonth} · per outlet`,
          ),
          table(
            [
              { label: 'Outlet', value: (r) => h('span', { class: 'cell-strong' }, r.outlet_name) },
              { label: 'Region', value: (r) => r.region_name ?? '—' },
              { label: 'Team leaders', value: (r) => String(r.team_leaders ?? 0) },
              { label: 'Sales reps', value: (r) => String(r.reps ?? 0) },
              { label: 'SIMs today', value: (r) => String(r.sims_today ?? 0) },
              { label: 'SIMs this month', value: (r) => String(r.sims_month ?? 0) },
              { label: 'SIMs total', value: (r) => String(r.sims_total ?? 0) },
            ],
            rows,
            'No outlets in your scope. A supervisor needs a region assigned; ask an administrator.',
          ),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h2', { style: { margin: '0 0 4px', fontSize: '16px' } }, 'Outlets · e-vouchers'),
          h(
            'p',
            { class: 'sub', style: { margin: '0 0 12px' } },
            `Today ${money(today)} · this month ${money(month)} · per outlet`,
          ),
          table(
            [
              { label: 'Outlet', value: (r) => h('span', { class: 'cell-strong' }, r.outlet_name) },
              { label: 'Region', value: (r) => r.region_name ?? '—' },
              { label: 'Team leaders', value: (r) => String(r.team_leaders ?? 0) },
              { label: 'Sales reps', value: (r) => String(r.reps ?? 0) },
              { label: 'Active users', value: (r) => String(r.active_users ?? 0) },
              { label: 'E-vouchers today', value: (r) => money(r.vouchers_today) },
              { label: 'E-vouchers this month', value: (r) => money(r.vouchers_month) },
            ],
            rows,
            'No outlets in your scope.',
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
