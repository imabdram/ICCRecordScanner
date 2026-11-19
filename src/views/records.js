import { banner, card, fmtDate, fmtTime, h, icon, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchScans } from '../data.js';

/** Recent scans, newest first, filtered by RLS for this user's role. */
export async function renderRecords(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(6)));

  try {
    const scans = await fetchScans(200);

    const month = (value) => {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    };
    const months = [...new Set(scans.map((s) => month(s.created_at)))];
    const todayCount = scans.filter((s) => {
      const d = new Date(s.created_at);
      const n = new Date();
      return d.toDateString() === n.toDateString();
    }).length;

    const term = h('input', { type: 'search', placeholder: 'Search customer, ICCID, outlet or rep…' });
    const tableSlot = h('div', {});

    const draw = () => {
      const q = term.value.trim().toLowerCase();
      const filtered = q
        ? scans.filter((s) =>
            [s.customer_name, s.iccid, s.outlet_name, s.sales_rep_name, s.primary_number]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(q)),
          )
        : scans;
      mount(
        tableSlot,
        table(
          [
            {
              label: 'Customer',
              value: (s) =>
                h(
                  'div',
                  {},
                  h('div', { class: 'cell-strong' }, s.customer_name),
                  h('div', { class: 'cell-sub mono' }, s.iccid),
                ),
            },
            { label: 'Primary', value: (s) => h('span', { class: 'mono' }, s.primary_number) },
            { label: 'Backup', value: (s) => h('span', { class: 'mono' }, s.secondary_number) },
            {
              // A scan filed from a signed-in user shows the person; one
              // uploaded from a phone shows the registered device instead.
              label: 'Recorded by',
              value: (s) =>
                s.sales_rep_name
                  ? s.sales_rep_name
                  : h('span', { class: 'cell-sub' }, s.device_label ? `Phone · ${s.device_label}` : '—'),
            },
            {
              label: 'Outlet · Region',
              value: (s) => h('div', {}, h('div', {}, s.outlet_name), h('div', { class: 'cell-sub' }, s.region_name ?? '—')),
            },
            { label: 'Date', value: (s) => fmtDate(s.created_at) },
            { label: 'Time', value: (s) => h('span', { class: 'num' }, fmtTime(s.created_at)) },
          ],
          filtered,
          q ? `No scans match “${term.value.trim()}”.` : 'No scans in your scope yet.',
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
          h('div', {}, h('h1', {}, 'Scan Records'), h('p', { class: 'sub' }, `${scans.length} scan(s) visible to you as ${roleName(profile.role)}`)),
          h(
            'button',
            { class: 'btn secondary', onclick: () => exportCsv(term.value ? scans.filter((s) => JSON.stringify(s).toLowerCase().includes(term.value.toLowerCase())) : scans) },
            icon('download', 16, 'ico', true),
            'Export CSV',
          ),
        ),
        h(
          'div',
          { class: 'cards' },
          card('Visible scans', scans.length),
          card('Today', todayCount, { accent: 'accent-red' }),
          card('Months covered', months.length, { foot: months.slice(0, 2).join(', ') || '—' }),
        ),
        h(
          'div',
          { class: 'panel' },
          h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', 16, 'ico', true), term)),
          tableSlot,
        ),
      ),
    );
    draw();
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h1', {}, 'Scan Records'), banner('error', error.message)));
  }
}

function exportCsv(scans) {
  const header = ['Customer', 'ICCID', 'Primary', 'Backup', 'Sales rep', 'Outlet', 'Region', 'Zone', 'Created at'];
  const rows = scans.map((s) => [s.customer_name, s.iccid, s.primary_number, s.secondary_number, s.sales_rep_name, s.outlet_name, s.region_name, s.zone_name, s.created_at]);
  const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = h('a', { href: url, download: 'sim-scan-records.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
