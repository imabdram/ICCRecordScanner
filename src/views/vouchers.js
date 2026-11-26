import { banner, card, h, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchUsers, fetchVoucherDailyLocal } from '../data.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** '2026-11-24' -> '24 Nov' (no Date parsing, so no timezone drift). */
function dayLabel(value) {
  const parts = String(value ?? '').slice(0, 10).split('-');
  if (parts.length !== 3) return String(value ?? '');
  return String(Number(parts[2])) + ' ' + MONTHS[Number(parts[1]) - 1];
}

const iso = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

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
 * E-vouchers, one page.
 *
 * This used to be two screens: a rep list (today / this month) and a separate
 * "Daily E-Voucher Reports" page with an Individual/Whole Team toggle. Both were
 * the same data sliced differently, so they are one page now: pick a date range,
 * see every rep, expand a rep to see his days.
 */
export async function renderVouchers(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(6)));

  const today = new Date();
  const monthStart = iso(new Date(today.getFullYear(), today.getMonth(), 1));
  const todayIso = iso(today);

  let from = monthStart;
  let to = todayIso;
  let rows = [];
  let users = [];
  let openRep = null;

  const bodySlot = h('div', {});
  const cardsSlot = h('div', { class: 'cards' });
  const statusSlot = h('div', {});

  async function load() {
    statusSlot.replaceChildren();
    try {
      [rows, users] = await Promise.all([
        fetchVoucherDailyLocal(from, to),
        fetchUsers().catch(() => []),
      ]);
    } catch (error) {
      statusSlot.replaceChildren(banner('error', error.message));
      rows = [];
    }
  }

  // ---- aggregation ---------------------------------------------------------
  const phoneOf = () => new Map(users.map((u) => [u.id, u.phone]));

  function summarise() {
    const reps = new Map();

    for (const row of rows) {
      const key = row.sales_rep_id;
      const entry =
        reps.get(key) ??
        {
          id: key,
          name: row.sales_rep_name,
          outlet: row.outlet_name,
          region: row.region_name,
          today: 0,
          range: 0,
          vouchers: 0,
          days: [],
        };
      const amount = Number(row.amount ?? 0);
      entry.range += amount;
      entry.vouchers += Number(row.vouchers ?? 0);
      if (String(row.day).slice(0, 10) === todayIso) entry.today += amount;
      entry.days.push({
        day: String(row.day).slice(0, 10),
        amount,
        vouchers: Number(row.vouchers ?? 0),
      });
      reps.set(key, entry);
    }

    for (const rep of reps.values()) {
      rep.days.sort((a, b) => (a.day < b.day ? 1 : -1));
    }

    const list = [...reps.values()].sort((a, b) => b.range - a.range);
    const total = list.reduce((s, r) => s + r.range, 0);
    const vouchers = list.reduce((s, r) => s + r.vouchers, 0);
    const active = list.filter((r) => r.vouchers > 0).length;
    const days = list.length
      ? Math.max(
          1,
          Math.round(
            (new Date(to) - new Date(from)) / 86400000 + 1,
          ),
        )
      : 0;

    return { list, total, vouchers, active, days };
  }

  function drawCards(summary) {
    cardsSlot.replaceChildren(
      card('Airtime in range', money(summary.total), { accent: 'accent-red' }),
      card('Vouchers', String(summary.vouchers)),
      card('Active reps', String(summary.active), { accent: 'accent-green' }),
      card('Average per day', money(summary.days ? summary.total / summary.days : 0), {
        foot: `${summary.days} day(s)`,
      }),
    );
  }

  // ---- rendering -----------------------------------------------------------
  const term = h('input', { type: 'search', placeholder: 'Search rep, outlet or number…' });

  function draw() {
    const summary = summarise();
    drawCards(summary);

    const q = term.value.trim().toLowerCase();
    const phones = phoneOf();
    const visible = summary.list.filter(
      (rep) =>
        !q ||
        [rep.name, rep.outlet, rep.region, phones.get(rep.id)]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
    );

    const listSlot = h('div', { class: 'rep-list' });

    const head = h(
      'div',
      { class: 'rep-row head' },
      h('span', { class: 'rep-caret' }),
      h('span', { class: 'rep-name' }, 'Sales rep'),
      h('span', { class: 'rep-mid' }, 'Number'),
      h('span', { class: 'rep-mid' }, 'Outlet'),
      h('span', { class: 'rep-mid' }, 'Region'),
      h('span', { class: 'rep-num' }, 'Today'),
      h('span', { class: 'rep-num' }, 'In range'),
      h('span', { class: 'rep-count' }, 'Vouchers'),
      h('span', { class: 'badge' }, 'Last day'),
    );

    const nodes = [];
    for (const rep of visible) {
      const open = openRep === rep.id;
      const last = rep.days[0]?.day;
      const fresh = freshness(last);

      const row = h(
        'div',
        { class: `rep-row${open ? ' open' : ''}` },
        h('span', { class: 'rep-caret' }, open ? '▾' : '▸'),
        h(
          'span',
          { class: 'rep-name' },
          h('span', { class: 'rep-title' }, rep.name ?? '—'),
          h('span', { class: 'rep-sub' }, rep.region ?? ''),
        ),
        h('span', { class: 'rep-mid' }, phones.get(rep.id) ?? '—'),
        h('span', { class: 'rep-mid' }, rep.outlet ?? '—'),
        h('span', { class: 'rep-mid' }, rep.region ?? '—'),
        h('span', { class: 'rep-num' }, money(rep.today)),
        h('span', { class: 'rep-num strong' }, money(rep.range)),
        h('span', { class: 'rep-count' }, String(rep.vouchers)),
        h('span', { class: `badge ${fresh.tone}` }, dayLabel(last) || 'never'),
      );
      row.addEventListener('click', () => {
        openRep = open ? null : rep.id;
        draw();
      });
      nodes.push(row);

      if (!open) continue;

      if (!rep.days.length) {
        nodes.push(h('div', { class: 'day-row muted' }, 'No vouchers in this range.'));
        continue;
      }

      for (const day of rep.days) {
        nodes.push(
          h(
            'div',
            { class: 'day-row' },
            h('span', { class: 'day-caret' }),
            h('span', { class: 'day-date' }, dayLabel(day.day)),
            h('span', {}),
            h('span', {}),
            h('span', {}),
            h('span', { class: 'day-amt' }, money(day.amount)),
            h('span', {}),
            h('span', { class: 'day-count' }, String(day.vouchers)),
            h('span', {}),
          ),
        );
      }
    }

    listSlot.replaceChildren(
      head,
      ...(nodes.length ? nodes : [h('div', { class: 'day-row muted' }, 'No vouchers in this range.')]),
    );

    const foot = h(
      'div',
      { class: 'rep-foot' },
      h('span', { class: 'foot-label' }, `TOTAL (${visible.length} reps)`),
      h('span', { class: 'foot-num' }, money(visible.reduce((s, r) => s + r.today, 0))),
      h('span', { class: 'foot-num strong' }, money(visible.reduce((s, r) => s + r.range, 0))),
      h(
        'span',
        { class: 'foot-flag' },
        `${visible.reduce((s, r) => s + r.vouchers, 0)} voucher(s)`,
      ),
    );

    bodySlot.replaceChildren(listSlot, foot);
  }

  // ---- exports -------------------------------------------------------------
  async function exportExcel() {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('E-Vouchers');
    ws.addRow(['Sales rep', 'Number', 'Outlet', 'Region', 'Date', 'Vouchers', 'Amount']);
    ws.getRow(1).font = { bold: true };

    const phones = phoneOf();
    const summary = summarise();
    for (const rep of summary.list) {
      for (const day of rep.days) {
        ws.addRow([
          rep.name,
          phones.get(rep.id) ?? '',
          rep.outlet,
          rep.region,
          day.day,
          day.vouchers,
          day.amount,
        ]);
      }
    }
    ws.columns.forEach((col) => (col.width = 18));

    const buffer = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(
      new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    const a = h('a', { href: url, download: `e-vouchers-${from}_${to}.xlsx` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---- controls ------------------------------------------------------------
  const fromInput = h('input', { type: 'date', value: from, 'aria-label': 'From' });
  const toInput = h('input', { type: 'date', value: to, 'aria-label': 'To' });

  const apply = h(
    'button',
    {
      class: 'btn sm',
      type: 'button',
      onclick: async () => {
        if (fromInput.value > toInput.value) {
          statusSlot.replaceChildren(banner('error', 'The start date is after the end date.'));
          return;
        }
        from = fromInput.value;
        to = toInput.value;
        openRep = null;
        await load();
        draw();
      },
    },
    'Apply',
  );

  const reset = h(
    'button',
    {
      class: 'btn secondary sm',
      type: 'button',
      onclick: async () => {
        fromInput.value = monthStart;
        toInput.value = todayIso;
        from = monthStart;
        to = todayIso;
        term.value = '';
        openRep = null;
        await load();
        draw();
      },
    },
    'This month',
  );

  term.addEventListener('input', draw);

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
          h(
            'p',
            { class: 'sub' },
            `Airtime from 913 SMS · click a rep to see his days · you are ${roleName(profile.role)}`,
          ),
        ),
        h(
          'div',
          { class: 'page-actions', style: { display: 'flex', gap: '8px' } },
          h(
            'button',
            { class: 'btn', type: 'button', onclick: exportExcel },
            'Export Excel',
          ),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'Print'),
        ),
      ),
      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'toolbar' },
          h('div', { class: 'search' }, term),
          h('span', { class: 'hint' }, `${dayLabel(from)} – ${dayLabel(to)}`),
        ),
        h(
          'div',
          { class: 'filters' },
          h('label', { class: 'filter' }, h('span', {}, 'From'), fromInput),
          h('label', { class: 'filter' }, h('span', {}, 'To'), toInput),
          h('div', { class: 'filter no-label' }, h('span', { 'aria-hidden': 'true' }, 'x'), apply),
          h('div', { class: 'filter no-label' }, h('span', { 'aria-hidden': 'true' }, 'x'), reset),
        ),
        statusSlot,
      ),
      cardsSlot,
      h('div', { class: 'panel' }, bodySlot),
    ),
  );

  draw();
}
