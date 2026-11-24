import { card, h, mount, roleName, skeletonPanel } from '../ui.js';
import { fetchUsers, fetchVoucherDaily, fetchVoucherTotals } from '../data.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** '2026-11-24' -> '24 Nov' with no timezone drift. */
function dayLabel(value) {
  const iso = String(value ?? '').slice(0, 10).split('-');
  if (iso.length !== 3) return String(value ?? '');
  return String(Number(iso[2])) + ' ' + MONTHS[Number(iso[1]) - 1];
}

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** How stale the last upload is. A silent phone must not look like no sales. */
function freshness(last) {
  if (!last) return { text: 'never', tone: 'bad' };
  const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
  if (days <= 0) return { text: 'today', tone: 'ok' };
  if (days === 1) return { text: 'yesterday', tone: 'ok' };
  if (days <= 3) return { text: `${days} days`, tone: 'warn' };
  return { text: `${days} days`, tone: 'bad' };
}

/**
 * E-vouchers: one row per rep, expand to his days, expand a day to its
 * transactions. Collapsed by default so hundreds of reps stay navigable.
 */
export async function renderVouchers(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(5)));

  try {
    const [totals, daily, users] = await Promise.all([
      fetchVoucherTotals(),
      fetchVoucherDaily(5000),
      fetchUsers(),
    ]);

    // The totals view has no phone column, so the number comes from users.
    const phoneOf = new Map(users.map((u) => [u.id, u.phone]));

    const reps = [...totals].sort(
      (a, b) => Number(b.month_amount ?? 0) - Number(a.month_amount ?? 0),
    );

    const byRep = new Map();
    for (const d of daily) {
      if (!byRep.has(d.sales_rep_id)) byRep.set(d.sales_rep_id, []);
      byRep.get(d.sales_rep_id).push(d);
    }
    for (const list of byRep.values()) {
      list.sort((a, b) => String(b.day).localeCompare(String(a.day)));
    }

    const term = h('input', { type: 'search', placeholder: 'Search rep or outlet…' });

    let openRep = null;

    const listSlot = h('div', { class: 'rep-list' });
    const footSlot = h('div', { class: 'rep-foot' });

    const totalsFor = (rows) => ({
      today: rows.reduce((s, r) => s + Number(r.today_amount ?? 0), 0),
      month: rows.reduce((s, r) => s + Number(r.month_amount ?? 0), 0),
      stale: rows.filter((r) => (freshness(r.last_received_at).tone ?? 'ok') !== 'ok').length,
    });

    const drawFoot = (rows) => {
      const t = totalsFor(rows);
      footSlot.replaceChildren(
        h('span', { class: 'foot-label' }, `TOTAL (${rows.length} reps)`),
        h('span', { class: 'foot-num' }, money(t.today)),
        h('span', { class: 'foot-num strong' }, money(t.month)),
        h(
          'span',
          { class: `foot-flag${t.stale ? ' bad' : ''}` },
          t.stale ? `${t.stale} not syncing` : 'all syncing',
        ),
      );
    };

    const draw = async () => {
      const q = term.value.trim().toLowerCase();
      const visible = q
        ? reps.filter((r) =>
            [r.full_name, r.username, r.outlet_name, r.region_name]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(q)),
          )
        : reps;

      drawFoot(visible);

      const nodes = visible.map((rep) => {
        const fresh = freshness(rep.last_received_at);
        const isOpen = openRep === rep.user_id;
        const days = byRep.get(rep.user_id) ?? [];

        const row = h(
          'div',
          { class: `rep-row${isOpen ? ' open' : ''}` },
          h('span', { class: 'rep-caret' }, isOpen ? '▾' : '▸'),
          h(
            'span',
            { class: 'rep-name' },
            h('span', { class: 'rep-title' }, rep.full_name || rep.username),
            h('span', { class: 'rep-sub' }, rep.username ?? ''),
          ),
          h('span', { class: 'rep-mid' }, phoneOf.get(rep.user_id) ?? '—'),
          h('span', { class: 'rep-mid' }, rep.outlet_name ?? '—'),
          h('span', { class: 'rep-mid' }, rep.region_name ?? '—'),
          h('span', { class: 'rep-num' }, money(rep.today_amount)),
          h('span', { class: 'rep-num strong' }, money(rep.month_amount)),
          h('span', { class: 'rep-count' }, String(rep.month_count ?? 0)),
          h('span', { class: `badge ${fresh.tone}` }, fresh.text),
        );
        row.addEventListener('click', () => {
          openRep = isOpen ? null : rep.user_id;
          draw();
        });

        if (!isOpen) return row;

        // Days are read-only: the day total is the last level.
        const dayNodes = days.length
          ? days.map((d) =>
              h(
                'div',
                { class: 'day-row' },
                h('span', { class: 'day-caret' }),
                h('span', { class: 'day-date' }, dayLabel(d.day)),
                h('span', { class: 'day-count' }, d.vouchers + ' voucher(s)'),
                h('span', { class: 'day-amt' }, money(d.amount)),
              ),
            )
          : [h('div', { class: 'day-row muted' }, 'No vouchers this month.')];
        return h('div', { class: 'rep-open' }, row, h('div', { class: 'day-block' }, ...dayNodes));
      });

      listSlot.replaceChildren(
        h(
          'div',
          { class: 'rep-row head' },
          h('span', { class: 'rep-caret' }),
          h('span', { class: 'rep-name' }, 'Sales rep'),
          h('span', { class: 'rep-mid' }, 'Number'),
          h('span', { class: 'rep-mid' }, 'Outlet'),
          h('span', { class: 'rep-mid' }, 'Region'),
          h('span', { class: 'rep-num' }, 'Today'),
          h('span', { class: 'rep-num' }, 'This month'),
          h('span', { class: 'rep-count' }, 'Vouchers'),
          h('span', { class: 'badge' }, 'Last sync'),
        ),
        ...(nodes.length ? nodes : [h('div', { class: 'day-row muted' }, 'No reps match.')]),
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
            h('p', { class: 'sub' }, `Airtime per rep · you are ${roleName(profile.role)} · click a rep, then a day`),
          ),
        ),
        h(
          'div',
          { class: 'cards' },
          card('Today', money(totalsFor(reps).today), { accent: 'accent-red' }),
          card('This month', money(totalsFor(reps).month)),
        ),
        h(
          'div',
          { class: 'panel' },
          h('div', { class: 'toolbar' }, h('div', { class: 'search' }, term)),
          listSlot,
          footSlot,
        ),
      ),
    );
    await draw();
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h1', {}, 'E-vouchers'), h('p', {}, error.message)));
  }
}
