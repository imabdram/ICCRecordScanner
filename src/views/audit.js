import { banner, fmtDate, fmtTime, h, icon, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchDeletions } from '../data.js';

/**
 * Deleted records: what was removed, and by whom.
 *
 * The table is written by a trigger, so this page is read-only by design â€”
 * there is no way to edit or delete an audit row through the API, even as admin.
 * RLS scopes it: admin everywhere, supervisor their zone, team leader their
 * outlet; a sales rep sees nothing (and has no nav entry).
 */
export async function renderAudit(root, { profile, go }) {
  mount(root, h('div', {}, skeletonPanel(5)));

  try {
    const rows = await fetchDeletions(300);

    const term = h('input', { type: 'search', placeholder: 'Search ICCID, customer or who deleted itâ€¦' });
    const slot = h('div', {});

    const draw = () => {
      const q = term.value.trim().toLowerCase();
      const filtered = q
        ? rows.filter((r) =>
            [r.iccid, r.customer_name, r.deleted_by_username, r.sales_rep_name, r.outlet_name]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(q)),
          )
        : rows;

      mount(
        slot,
        table(
          [
            {
              label: 'Customer',
              value: (r) =>
                h(
                  'div',
                  {},
                  h('div', { class: 'cell-strong' }, r.customer_name ?? 'â€”'),
                  h('div', { class: 'cell-sub mono' }, r.iccid),
                ),
            },
            {
              label: 'Numbers',
              value: (r) =>
                h(
                  'div',
                  { class: 'mono', style: { fontSize: '12.5px' } },
                  `${r.primary_number ?? 'â€”'} Â· ${r.secondary_number ?? 'â€”'}`,
                ),
            },
            { label: 'Recorded by', value: (r) => r.sales_rep_name ?? 'â€”' },
            { label: 'Outlet', value: (r) => r.outlet_name ?? 'â€”' },
            {
              label: 'Deleted by',
              value: (r) =>
                h(
                  'div',
                  {},
                  h('div', { class: 'cell-strong' }, r.deleted_by_username ?? 'system'),
                  h('div', { class: 'cell-sub' }, `${fmtDate(r.deleted_at)} Â· ${fmtTime(r.deleted_at)}`),
                ),
            },
            {
              label: 'Originally recorded',
              value: (r) =>
                r.scan_created_at
                  ? h('span', { class: 'cell-sub' }, fmtDate(r.scan_created_at))
                  : 'â€”',
            },
          ],
          filtered,
          rows.length === 0
            ? 'Nothing has been deleted.'
            : `Nothing matches â€œ${term.value.trim()}â€.`,
        ),
      );
    };

    term.addEventListener('input', draw);

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
            h('h1', {}, 'Deleted records'),
            h('p', { class: 'sub' },
              `${rows.length} deletion(s) visible to you as ${roleName(profile.role)} Â· read-only`),
          ),
        ),
        h(
          'div',
          { class: 'panel' },
          h(
            'div',
            { class: 'toolbar' },
            h('div', { class: 'search' }, icon('search', 16, 'ico', true), term),
          ),
          slot,
        ),
        h(
          'p',
          { class: 'cell-sub', style: { marginTop: '12px' } },
          'Deletions are recorded automatically by the database and cannot be edited or removed.',
        ),
      ),
    );
    draw();
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h1', {}, 'Deleted records'), banner('error', error.message)));
  }
}

