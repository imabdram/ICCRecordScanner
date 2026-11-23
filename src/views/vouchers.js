import { card, fmtDate, h, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchVoucherDaily, fetchVoucherTotals } from '../data.js';

/**
 * E-vouchers: per rep per day, with filters.
 *
 * Days come from v_voucher_daily so a supervisor can answer "how much did Hodan
 * make on the 14th?" directly, instead of reading it off a chart.
 */
export async function renderVouchers(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(5)));

  try {
    const [totals, daily] = await Promise.all([fetchVoucherTotals(), fetchVoucherDaily(2000)]);

    const money = (v) =>
      `$${Number(v ?? 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

    const todayTotal = totals.reduce((s, r) => s + Number(r.today_amount ?? 0), 0);
    const monthTotal = totals.reduce((s, r) => s + Number(r.month_amount ?? 0), 0);
    const monthCount = totals.reduce((s, r) => s + Number(r.month_count ?? 0), 0);

    const reps = [...new Map(daily.map((d) => [d.sales_rep_id, d.sales_rep_name])).entries()]
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));

    // Default the range to the current month.
    const now = new Date();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const repSel = h(
      'select',
      { 'aria-label': 'Sales rep' },
      h('option', { value: '' }, 'All sales reps'),
      ...reps.map(([id, name]) => h('option', { value: id }, name)),
    );
    const fromInput = h('input', { type: 'date', 'aria-label': 'From', value: `${iso(now).slice(0, 7)}-01` });
    const toInput = h('input', { type: 'date', 'aria-label': 'To', value: iso(now) });

    const slot = h('div', {});
    const countSlot = h('span', { class: 'hint' }, '');

    const draw = () => {
      const from = fromInput.value;
      const to = toInput.value;
      const rep = repSel.value;

      const rows = daily
        .filter((d) => {
          const day = String(d.day).slice(0, 10);
          if (from && day < from) return false;
          if (to && day > to) return false;
          if (rep && d.sales_rep_id !== rep) return false;
          return true;
        })
        .sort((a, b) => String(b.day).localeCompare(String(a.day)));

      const sum = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
      countSlot.textContent = `${rows.length} day(s) · ${money(sum)}`;

      mount(
        slot,
        table(
          [
            { label: 'Day', value: (r) => fmtDate(r.day) },
            { label: 'Sales rep', value: (r) => h('span', { class: 'cell-strong' }, r.sales_rep_name) },
            { label: 'Outlet', value: (r) => r.outlet_name ?? '—' },
            { label: 'Vouchers', value: (r) => String(r.vouchers ?? 0) },
            {
              label: 'Amount',
              value: (r) => h('span', { class: 'num big' }, money(r.amount)),
            },
          ],
          rows,
          'No vouchers in this range yet. They appear once a rep opens E-voucher on the phone while online.',
        ),
      );
    };

    const reset = () => {
      repSel.value = '';
      fromInput.value = `${iso(now).slice(0, 7)}-01`;
      toInput.value = iso(now);
      draw();
    };

    repSel.addEventListener('change', draw);
    fromInput.addEventListener('change', draw);
    toInput.addEventListener('change', draw);

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
            h('h1', {}, 'E-vouchers'),
            h('p', { class: 'sub' }, `Airtime from 913 SMS per rep per day · you are ${roleName(profile.role)}`),
          ),
        ),
        h(
          'div',
          { class: 'cards' },
          card('Today', money(todayTotal), { accent: 'accent-red' }),
          card('This month', money(monthTotal), { foot: `${monthCount} voucher(s)` }),
        ),
        h(
          'div',
          { class: 'panel' },
          h(
            'div',
            { class: 'filters' },
            h('label', { class: 'filter' }, h('span', {}, 'Sales rep'), repSel),
            h('label', { class: 'filter' }, h('span', {}, 'From'), fromInput),
            h('label', { class: 'filter' }, h('span', {}, 'To'), toInput),
            h(
              'div',
              { class: 'filter no-label' },
              h('span', { 'aria-hidden': 'true' }, 'Reset'),
              h('button', { class: 'btn secondary sm', type: 'button', onclick: reset }, 'Reset filters'),
            ),
          ),
          h('div', { class: 'toolbar' }, countSlot),
          slot,
        ),
      ),
    );
    draw();
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h1', {}, 'E-vouchers'), h('p', {}, error.message)));
  }
}
