import { banner, card, h, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchOutletOverview, fetchRepSimReport } from '../data.js';

// A missing column is not a zero: the SIM views may not be applied yet, and
// showing 0.00 hides that. An em dash makes the gap obvious.
const num = (v) => (v === undefined || v === null ? '—' : String(v));

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
    // The outlet view has repeatedly lagged the data, so the outlet SIM figures
    // are summed from the per-rep rows instead. Both tables then agree by
    // construction: the same numbers, grouped differently.
    const [rows, repRows] = await Promise.all([
      fetchOutletOverview(),
      fetchRepSimReport().catch(() => []),
    ]);

    const simsByOutlet = new Map();
    for (const rep of repRows) {
      if (!rep.outlet_id) continue;
      const acc = simsByOutlet.get(rep.outlet_id) ?? { today: 0, month: 0, total: 0 };
      acc.today += Number(rep.sims_today ?? 0);
      acc.month += Number(rep.sims_month ?? 0);
      acc.total += Number(rep.sims_total ?? 0);
      simsByOutlet.set(rep.outlet_id, acc);
    }
    const simsOf = (outletId) => simsByOutlet.get(outletId) ?? { today: 0, month: 0, total: 0 };

    const reps = rows.reduce((s, r) => s + Number(r.reps ?? 0), 0);
    const leaders = rows.reduce((s, r) => s + Number(r.team_leaders ?? 0), 0);
    const today = rows.reduce((s, r) => s + Number(r.vouchers_today ?? 0), 0);
    const month = rows.reduce((s, r) => s + Number(r.vouchers_month ?? 0), 0);
    // undefined means the view has no SIM columns yet -- keep that distinct from 0.
    const simsToday = repRows.length ? rows.reduce((s, r) => s + simsOf(r.outlet_id).today, 0) : null;
    const simsMonth = repRows.length ? rows.reduce((s, r) => s + simsOf(r.outlet_id).month, 0) : null;

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
          card('SIMs Today', simsToday === null ? '—' : String(simsToday), { accent: 'accent-red' }),
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
              { label: 'Sales reps', value: (r) => String(r.reps ?? 0) },
              { label: 'SIMs today', value: (r) => num(simsOf(r.outlet_id).today) },
              { label: 'SIMs this month', value: (r) => num(simsOf(r.outlet_id).month) },
              { label: 'SIMs total', value: (r) => num(simsOf(r.outlet_id).total) },
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
