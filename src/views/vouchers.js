import { banner, card, fmtDate, fmtTime, h, icon, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchVoucherTotals } from '../data.js';

/**
 * E-voucher report: airtime totals per sales rep, today and this month.
 *
 * The numbers come from the operator's 913 SMS messages, read on each rep's
 * phone and uploaded. They are what the handset reported, not audited cash, so
 * this page shows them per rep with a "last received" column: a rep whose phone
 * stopped syncing looks identical to a rep who stopped selling otherwise.
 */
export async function renderVouchers(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(5)));

  try {
    const rows = await fetchVoucherTotals();

    const money = (v) =>
      `$${Number(v ?? 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

    const todayTotal = rows.reduce((s, r) => s + Number(r.today_amount ?? 0), 0);
    const monthTotal = rows.reduce((s, r) => s + Number(r.month_amount ?? 0), 0);
    const todayCount = rows.reduce((s, r) => s + Number(r.today_count ?? 0), 0);
    const activeToday = rows.filter((r) => Number(r.today_count ?? 0) > 0).length;

    const term = h('input', {
      type: 'search',
      placeholder: 'Search rep or outlet…',
    });
    const slot = h('div', {});
    const countSlot = h('span', { class: 'hint' }, '');

    const draw = () => {
      const q = term.value.trim().toLowerCase();
      const filtered = q
        ? rows.filter((r) =>
            [r.full_name, r.username, r.outlet_name, r.region_name]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(q)),
          )
        : rows;

      countSlot.textContent =
        filtered.length === rows.length
          ? `${rows.length} people`
          : `${filtered.length} of ${rows.length}`;

      mount(
        slot,
        table(
          [
            {
              label: 'Sales rep',
              value: (r) =>
                h(
                  'div',
                  {},
                  h('div', { class: 'cell-strong' }, r.full_name || r.username),
                  h('div', { class: 'cell-sub' }, roleName(r.role)),
                ),
            },
            { label: 'Outlet', value: (r) => r.outlet_name ?? '—' },
            { label: 'Region', value: (r) => r.region_name ?? '—' },
            {
              label: 'Today',
              value: (r) =>
                h(
                  'div',
                  {},
                  h('span', { class: 'num big' }, money(r.today_amount)),
                  Number(r.today_count ?? 0) > 0
                    ? h('div', { class: 'cell-sub' }, `${r.today_count} voucher(s)`)
                    : null,
                ),
            },
            {
              label: 'This month',
              value: (r) =>
                h(
                  'div',
                  {},
                  h('span', { class: 'num big' }, money(r.month_amount)),
                  h('div', { class: 'cell-sub' }, `${r.month_count ?? 0} voucher(s)`),
                ),
            },
            {
              // The freshness column: without it, a silent phone looks like no sales.
              label: 'Last received',
              value: (r) =>
                r.last_received_at
                  ? h(
                      'div',
                      {},
                      h('div', {}, fmtDate(r.last_received_at)),
                      h('div', { class: 'cell-sub' }, fmtTime(r.last_received_at)),
                    )
                  : h('span', { class: 'cell-sub' }, 'never'),
            },
          ],
          filtered,
          rows.length === 0
            ? 'No vouchers uploaded yet. They appear once a rep opens E-voucher on the phone while online.'
            : `Nothing matches “${term.value.trim()}”.`,
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
            h('h1', {}, 'E-vouchers'),
            h(
              'p',
              { class: 'sub' },
              `Airtime from 913 SMS, per rep · visible to you as ${roleName(profile.role)}`,
            ),
          ),
        ),
        h(
          'div',
          { class: 'cards' },
          card('Today', money(todayTotal), {
            accent: 'accent-red',
            foot: `${todayCount} voucher(s)`,
          }),
          card('This month', money(monthTotal), { foot: 'All reps in your scope' }),
          card('Reps with vouchers today', `${activeToday}`, {
            accent: 'accent-green',
            foot: `of ${rows.length} in scope`,
          }),
        ),
        h(
          'div',
          { class: 'panel' },
          h(
            'div',
            { class: 'toolbar' },
            h('div', { class: 'search' }, icon('search', 16, 'ico', true), term),
            countSlot,
          ),
          slot,
        ),
        h(
          'p',
          { class: 'cell-sub', style: { marginTop: '12px' } },
          'Read from each rep’s phone. Treat as reported airtime, not audited cash — ' +
            'and check “Last received”: a stale date means the phone is not syncing.',
        ),
      ),
    );
    draw();
  } catch (error) {
    mount(
      root,
      h('div', { class: 'panel' }, h('h1', {}, 'E-vouchers'), banner('error', error.message)),
    );
  }
}
