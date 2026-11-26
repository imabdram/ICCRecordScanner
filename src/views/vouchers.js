import { banner, card, h, mount, roleName, skeletonPanel } from '../ui.js';
import { fetchUsers, fetchVoucherDailyLocal } from '../data.js';
import { buildTeam, eachDay } from '../voucher-report.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** '2026-11-24' -> '24 Nov'. No Date parsing, so no timezone drift. */
function dayLabel(value) {
  const parts = String(value ?? '').slice(0, 10).split('-');
  if (parts.length !== 3) return String(value ?? '');
  return String(Number(parts[2])) + ' ' + MONTHS[Number(parts[1]) - 1];
}

const iso = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function freshness(last) {
  if (!last) return { text: 'never', tone: 'bad' };
  const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
  if (days <= 0) return { text: 'today', tone: 'ok' };
  if (days === 1) return { text: 'yesterday', tone: 'ok' };
  if (days <= 3) return { text: `${days} days`, tone: 'warn' };
  return { text: `${days} days`, tone: 'bad' };
}

/**
 * E-vouchers: three reports over one dataset.
 *
 *   Team       each rep, with today / range / month figures
 *   Days       one row per day, expandable to who produced it
 *   Individual one rep, day by day
 *
 * They share the date range, so switching tabs never changes the window.
 */
export async function renderVouchers(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(6)));

  const now = new Date();
  const monthStart = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  const todayIso = iso(now);

  const state = {
    tab: 'team',
    from: monthStart,
    to: todayIso,
    repId: '',
    openDay: null,
  };

  let rows = [];
  let users = [];
  let loadError = null;

  const cardsSlot = h('div', { class: 'cards' });
  const bodySlot = h('div', {});
  const statusSlot = h('div', {});

  async function load() {
    statusSlot.replaceChildren();
    loadError = null;
    try {
      [rows, users] = await Promise.all([
        fetchVoucherDailyLocal(state.from, state.to),
        fetchUsers().catch(() => []),
      ]);
    } catch (error) {
      rows = [];
      users = [];
      loadError = error;
      statusSlot.replaceChildren(banner('error', error.message));
    }
  }

  const phones = () => new Map(users.map((u) => [u.id, u.phone]));

  // Created once: rebuilding it on every draw would steal focus mid-typing.
  const term = h('input', {
    type: 'search',
    placeholder: 'Search rep, outlet or number…',
    oninput: () => draw(),
  });

  // ---- shared aggregation --------------------------------------------------
  function byRep() {
    const map = new Map();
    for (const row of rows) {
      const entry =
        map.get(row.sales_rep_id) ??
        {
          id: row.sales_rep_id,
          name: row.sales_rep_name,
          outlet: row.outlet_name,
          region: row.region_name,
          today: 0,
          range: 0,
          vouchers: 0,
          days: 0,
          lastDay: null,
        };

      const amount = Number(row.amount ?? 0);
      const day = String(row.day).slice(0, 10);
      entry.range += amount;
      entry.vouchers += Number(row.vouchers ?? 0);
      entry.days += 1;
      if (day === todayIso) entry.today += amount;
      if (!entry.lastDay || day > entry.lastDay) entry.lastDay = day;
      map.set(row.sales_rep_id, entry);
    }
    return [...map.values()].sort((a, b) => b.range - a.range);
  }

  function totals(list) {
    return {
      amount: list.reduce((s, r) => s + r.range, 0),
      today: list.reduce((s, r) => s + r.today, 0),
      vouchers: list.reduce((s, r) => s + r.vouchers, 0),
      active: list.filter((r) => r.vouchers > 0).length,
    };
  }

  function drawCards(list) {
    const t = totals(list);
    const dayCount = eachDay(state.from, state.to).length;
    cardsSlot.replaceChildren(
      card('Airtime in range', money(t.amount), { accent: 'accent-red' }),
      card('Today', money(t.today)),
      card('Vouchers', String(t.vouchers), { accent: 'accent-green' }),
      card('Active reps', String(t.active), { foot: `${dayCount} day(s) in range` }),
    );
  }

  // ---- views ---------------------------------------------------------------
  function tableShell(head, body, foot) {
    return h(
      'table',
      { class: 'report-table' },
      h('thead', {}, h('tr', {}, ...head.map((label, i) => h('th', { class: i ? 'num' : '' }, label)))),
      h('tbody', {}, ...body),
      foot ? h('tfoot', {}, foot) : null,
    );
  }

  function teamView() {
    const list = byRep();
    const phonesMap = phones();

    // Everyone in scope, not only the people who sold: a rep with 0 in the period
    // is exactly what a supervisor needs to see.
    const seen = new Set(list.map((r) => r.id));
    for (const user of users) {
      if (seen.has(user.id)) continue;
      if (user.role !== 'sales_rep' && user.role !== 'team_leader') continue;
      if (user.active === false) continue;
      list.push({
        id: user.id,
        name: user.full_name || user.username,
        outlet: '—',
        region: null,
        today: 0,
        range: 0,
        vouchers: 0,
        days: 0,
        lastDay: null,
      });
    }
    list.sort((a, b) => b.range - a.range || String(a.name).localeCompare(String(b.name)));
    const q = term.value.trim().toLowerCase();

    const visible = list.filter(
      (rep) =>
        !q ||
        [rep.name, rep.outlet, rep.region, phonesMap.get(rep.id)]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
    );
    drawCards(visible);

    const body = visible.map((rep) => {
      const fresh = freshness(rep.lastDay);
      const row = h(
        'tr',
        {
          class: 'clickable',
          onclick: () => {
            state.tab = 'individual';
            state.repId = rep.id;
            draw();
          },
        },
        h(
          'td',
          {},
          h('div', { class: 'cell-strong' }, rep.name ?? '—'),
          h('div', { class: 'cell-sub' }, rep.outlet ?? '—'),
        ),
        h('td', {}, phonesMap.get(rep.id) ?? '—'),
        h('td', { class: 'num' }, money(rep.today)),
        h('td', { class: 'num' }, money(rep.range)),
        h('td', { class: 'num' }, String(rep.vouchers)),
        h('td', {}, h('span', { class: `badge ${fresh.tone}` }, dayLabel(rep.lastDay) || 'never')),
      );
      return row;
    });

    const t = totals(visible);
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'toolbar' },
        h('span', { class: 'hint' }, 'Click a rep for his individual report'),
      ),
      tableShell(
        ['Sales rep / Outlet', 'Number', 'Today', 'In range', 'Vouchers', 'Last day'],
        body.length ? body : [h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No vouchers in this range.'))],
        h(
          'tr',
          {},
          h('td', {}, `TOTAL (${visible.length} reps)`),
          h('td', {}, ''),
          h('td', { class: 'num' }, money(t.today)),
          h('td', { class: 'num strong' }, money(t.amount)),
          h('td', { class: 'num' }, String(t.vouchers)),
          h('td', {}, ''),
        ),
      ),
    );
  }

  function daysView() {
    const team = buildTeam(rows, state.from, state.to);
    const phonesMap = phones();
    drawCards(byRep());

    const body = [];
    // Newest day first.
    for (const day of [...team.rows].reverse()) {
      const open = state.openDay === day.day;
      const row = h(
        'tr',
        {
          class: `clickable${day.vouchers ? '' : ' empty-row'}`,
          onclick: () => {
            if (!day.byRep.length) return;
            state.openDay = open ? null : day.day;
            draw();
          },
        },
        h('td', {}, (day.byRep.length ? (open ? '▾ ' : '▸ ') : '') + dayLabel(day.day)),
        h('td', { class: 'num' }, String(day.byRep.length)),
        h('td', { class: 'num' }, String(day.vouchers)),
        h('td', { class: 'num' }, money(day.amount)),
      );
      body.push(row);

      if (open) {
        body.push(
          h(
            'tr',
            { class: 'detail-row' },
            h(
              'td',
              { colspan: '4' },
              tableShell(
                ['Sales rep', 'Number', 'Vouchers', 'Amount'],
                day.byRep.map((rep) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, rep.sales_rep_name),
                    h('td', {}, phonesMap.get(rep.sales_rep_id) ?? '—'),
                    h('td', { class: 'num' }, String(rep.vouchers)),
                    h('td', { class: 'num' }, money(rep.amount)),
                  ),
                ),
              ),
            ),
          ),
        );
      }
    }

    return h(
      'div',
      {},
      tableShell(
        ['Day', 'Reps', 'Vouchers', 'Amount'],
        body.length ? body : [h('tr', {}, h('td', { colspan: '4', class: 'muted' }, 'No days in this range.'))],
        h(
          'tr',
          {},
          h('td', {}, 'TOTAL'),
          h('td', { class: 'num' }, ''),
          h('td', { class: 'num' }, String(team.totals.vouchers)),
          h('td', { class: 'num strong' }, money(team.totals.amount)),
        ),
      ),
    );
  }

  function individualView() {
    const list = byRep();
    if (!state.repId && list.length) state.repId = list[0].id;

    const rep = list.find((r) => r.id === state.repId);
    drawCards(rep ? [rep] : []);

    const options = list.map((r) =>
      h('option', { value: r.id, selected: r.id === state.repId }, r.name ?? r.id),
    );

    if (!rep) {
      return h(
        'div',
        {},
        h('p', { class: 'sub' }, 'No vouchers in this range.'),
        h('label', { class: 'filter' }, h('span', {}, 'Sales rep'), h('select', {}, ...options)),
      );
    }

    const dayRows = rep.days === 0
      ? []
      : rows
          .filter(
            (row) =>
              row.sales_rep_id === rep.id &&
              String(row.day).slice(0, 10) >= state.from &&
              String(row.day).slice(0, 10) <= state.to,
          )
          .sort((a, b) => (String(a.day) < String(b.day) ? 1 : -1))
          .map((row) =>
            h(
              'tr',
              {},
              h('td', {}, dayLabel(row.day)),
              h('td', { class: 'num' }, String(row.vouchers ?? 0)),
              h('td', { class: 'num' }, money(row.amount)),
            ),
          );

    return h(
      'div',
      {},
      h(
        'div',
        { class: 'filters' },
        h(
          'label',
          { class: 'filter' },
          h('span', {}, 'Sales rep'),
          h(
            'select',
            {
              onchange: (event) => {
                state.repId = event.target.value;
                draw();
              },
            },
            ...options,
          ),
        ),
        h('div', { class: 'filter no-label' }, h('span', { 'aria-hidden': 'true' }, 'x'), h('span', { class: 'hint' }, rep.outlet ?? '')),
      ),
      tableShell(
        ['Day', 'Vouchers', 'Amount'],
        dayRows.length
          ? dayRows
          : [h('tr', {}, h('td', { colspan: '3', class: 'muted' }, 'No vouchers for this rep in range.'))],
        h(
          'tr',
          {},
          h('td', {}, 'TOTAL'),
          h('td', { class: 'num' }, String(rep.vouchers)),
          h('td', { class: 'num strong' }, money(rep.range)),
        ),
      ),
    );
  }

  // ---- chrome --------------------------------------------------------------
  function tabButton(value, label) {
    return h(
      'button',
      {
        type: 'button',
        class: `seg${state.tab === value ? ' active' : ''}`,
        onclick: async () => {
          state.tab = value;
          state.openDay = null;
          draw();
        },
      },
      label,
    );
  }

  function draw() {
    bodySlot.replaceChildren(
      state.tab === 'team'
        ? teamView()
        : state.tab === 'days'
          ? daysView()
          : individualView(),
    );

    tabBar.replaceChildren(
      tabButton('team', 'Team'),
      tabButton('days', 'By day'),
      tabButton('individual', 'Individual'),
    );
  }

  const tabBar = h('div', { class: 'segment', style: { margin: '4px 0 16px' } });

  await load();

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
          h('p', { class: 'sub' }, `Airtime from 913 SMS · you are ${roleName(profile.role)}`),
        ),
        h(
          'div',
          { class: 'page-actions', style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'Print'),
        ),
      ),
      cardsSlot,
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'toolbar' }, h('div', { class: 'search' }, term), statusSlot),
        tabBar,
        bodySlot,
      ),
    ),
  );

  if (loadError) statusSlot.replaceChildren(banner('error', loadError.message));
  draw();
}
