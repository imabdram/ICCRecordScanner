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
  const todayIso = iso(now);

  // A month is the unit people report by, so the range is derived from one: a
  // past month ends on its last day, the current month ends today.
  const monthBounds = (year, month) => {
    const from = iso(new Date(year, month, 1));
    const lastDay = iso(new Date(year, month + 1, 0));
    const isCurrent = year === now.getFullYear() && month === now.getMonth();
    return { from, to: isCurrent ? todayIso : lastDay };
  };

  const initial = monthBounds(now.getFullYear(), now.getMonth());

  const state = {
    tab: 'team',
    year: now.getFullYear(),
    month: now.getMonth(),
    from: initial.from,
    to: initial.to,
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
  // The numeric list names the column indexes that hold figures: those are right
  // aligned, everything else (names, phone numbers, badges) stays left, so a
  // header can never sit over a cell with the opposite alignment.
  function tableShell(head, body, foot, numeric = []) {
    return h(
      'table',
      { class: 'report-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...head.map((label, i) => h('th', { class: numeric.includes(i) ? 'num' : '' }, label)),
        ),
      ),
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
        [2, 3, 4],
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
        // The breakdown uses the same table, one row per rep: a nested table gets
        // its own column widths and stops lining up with the day row above it.
        for (const rep of day.byRep) {
          body.push(
            h(
              'tr',
              { class: 'detail-row' },
              h('td', { class: 'detail-name' }, rep.sales_rep_name),
              h('td', {}, phonesMap.get(rep.sales_rep_id) ?? '—'),
              h('td', { class: 'num' }, String(rep.vouchers)),
              h('td', { class: 'num' }, money(rep.amount)),
            ),
          );
        }
      }
    }

    return h(
      'div',
      {},
      tableShell(
        ['Day', 'Reps / Number', 'Vouchers', 'Amount'],
        body.length ? body : [h('tr', {}, h('td', { colspan: '4', class: 'muted' }, 'No days in this range.'))],
        h(
          'tr',
          {},
          h('td', {}, 'TOTAL'),
          h('td', { class: 'num' }, ''),
          h('td', { class: 'num' }, String(team.totals.vouchers)),
          h('td', { class: 'num strong' }, money(team.totals.amount)),
        ),
        [1, 2, 3],
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

    // Every day of the range, newest first. A day with nothing must show as 0:
    // a gap is the finding, and skipping it hides that.
    const byDay = new Map();
    for (const row of rows) {
      if (row.sales_rep_id !== rep.id) continue;
      const day = String(row.day).slice(0, 10);
      if (day < state.from || day > state.to) continue;
      const current = byDay.get(day) ?? { vouchers: 0, amount: 0 };
      current.vouchers += Number(row.vouchers ?? 0);
      current.amount += Number(row.amount ?? 0);
      byDay.set(day, current);
    }

    const dayRows = eachDay(state.from, state.to)
      .reverse()
      .map((day) => {
        const found = byDay.get(day) ?? { vouchers: 0, amount: 0 };
        return h(
          'tr',
          { class: found.vouchers ? '' : 'empty-row' },
          h('td', {}, dayLabel(day)),
          h('td', { class: 'num' }, String(found.vouchers)),
          h('td', { class: 'num' }, money(found.amount)),
        );
      });

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
        [1, 2],
      ),
    );
  }

  // ---- excel ---------------------------------------------------------------
  /** The current tab as a workbook, with the range in the header block. */
  async function exportExcel() {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('E-vouchers');

    const phonesMap = phones();
    const list = byRep();
    const MONEY_FMT = String.fromCharCode(34) + "$" + String.fromCharCode(34) + "#,##0.00";

    ws.addRow(['E-vouchers']);
    ws.addRow([dayLabel(state.from) + ' - ' + dayLabel(state.to)]);
    ws.addRow([]);

    let headers = [];
    let body = [];
    let totalRow = [];

    if (state.tab === 'team') {
      headers = ['Sales rep', 'Number', 'Outlet', 'Today', 'In range', 'Vouchers', 'Last day'];
      body = list.map((rep) => [
        rep.name ?? '',
        phonesMap.get(rep.id) ?? '',
        rep.outlet ?? '',
        Number(rep.today),
        Number(rep.range),
        Number(rep.vouchers),
        dayLabel(rep.lastDay) || 'never',
      ]);
      const t2 = totals(list);
      totalRow = ['TOTAL', '', '', Number(t2.today), Number(t2.amount), Number(t2.vouchers), ''];
    } else if (state.tab === 'days') {
      headers = ['Day', 'Reps', 'Vouchers', 'Amount'];
      const team = buildTeam(rows, state.from, state.to);
      body = [...team.rows].reverse().map((day) => [
        day.day,
        day.byRep.length,
        Number(day.vouchers),
        Number(day.amount),
      ]);
      totalRow = ['TOTAL', '', Number(team.totals.vouchers), Number(team.totals.amount)];
    } else {
      const rep = list.find((r) => r.id === state.repId);
      ws.getCell('A3').value = 'Sales rep: ' + (rep?.name ?? '');
      headers = ['Day', 'Vouchers', 'Amount'];
      const byDay = new Map();
      for (const row of rows) {
        if (row.sales_rep_id !== state.repId) continue;
        const day = String(row.day).slice(0, 10);
        const current = byDay.get(day) ?? { vouchers: 0, amount: 0 };
        current.vouchers += Number(row.vouchers ?? 0);
        current.amount += Number(row.amount ?? 0);
        byDay.set(day, current);
      }
      let vouchers = 0;
      let amount = 0;
      for (const day of eachDay(state.from, state.to).reverse()) {
        const found = byDay.get(day) ?? { vouchers: 0, amount: 0 };
        vouchers += found.vouchers;
        amount += found.amount;
        body.push([day, Number(found.vouchers), Number(found.amount)]);
      }
      totalRow = ['TOTAL', Number(vouchers), Number(amount)];
    }

    const headerRow = ws.addRow(headers).number;
    body.forEach((row) => ws.addRow(row));
    const total = ws.addRow(totalRow);

    ws.getRow(1).font = { bold: true, size: 14 };
    ws.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(headerRow).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE30613' },
    };
    total.font = { bold: true };
    total.border = { top: { style: 'thin' } };

    ws.columns.forEach((col, i) => {
      col.width = i === 0 ? 32 : 16;
    });

    // Only the money columns of the active tab.
    if (state.tab === 'team') {
      ws.getColumn(4).numFmt = MONEY_FMT;
      ws.getColumn(5).numFmt = MONEY_FMT;
    } else if (state.tab === 'days') {
      ws.getColumn(4).numFmt = MONEY_FMT;
    } else {
      ws.getColumn(3).numFmt = MONEY_FMT;
    }

    const buffer = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(
      new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    const a = h('a', {
      href: url,
      download: 'e-vouchers-' + state.tab + '-' + state.from + '_' + state.to + '.xlsx',
    });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---- pdf -----------------------------------------------------------------
  /**
   * A real PDF of whatever the current tab shows, so it can be mailed or filed
   * without going through the print dialog.
   */
  async function exportPdf() {
    const [{ jsPDF }, autoTableModule] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const autoTable = autoTableModule.default ?? autoTableModule.autoTable;

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const phonesMap = phones();
    const list = byRep();

    let title = 'E-vouchers';
    let head = [];
    let body = [];

    if (state.tab === 'team') {
      head = [['Sales rep', 'Number', 'Today', 'In range', 'Vouchers', 'Last day']];
      body = list.map((rep) => [
        rep.name ?? '—',
        phonesMap.get(rep.id) ?? '',
        money(rep.today),
        money(rep.range),
        String(rep.vouchers),
        dayLabel(rep.lastDay) || 'never',
      ]);
      const t = totals(list);
      body.push(['TOTAL', '', money(t.today), money(t.amount), String(t.vouchers), '']);
    } else if (state.tab === 'days') {
      title = 'E-vouchers · by day';
      head = [['Day', 'Reps', 'Vouchers', 'Amount']];
      const team = buildTeam(rows, state.from, state.to);
      body = [...team.rows].reverse().map((day) => [
        dayLabel(day.day),
        String(day.byRep.length),
        String(day.vouchers),
        money(day.amount),
      ]);
      body.push(['TOTAL', '', String(team.totals.vouchers), money(team.totals.amount)]);
    } else {
      const rep = list.find((r) => r.id === state.repId);
      title = `E-vouchers · ${rep?.name ?? 'individual'}`;
      head = [['Day', 'Vouchers', 'Amount']];
      const byDay = new Map();
      for (const row of rows) {
        if (row.sales_rep_id !== state.repId) continue;
        const day = String(row.day).slice(0, 10);
        const current = byDay.get(day) ?? { vouchers: 0, amount: 0 };
        current.vouchers += Number(row.vouchers ?? 0);
        current.amount += Number(row.amount ?? 0);
        byDay.set(day, current);
      }
      let vouchers = 0;
      let amount = 0;
      for (const day of eachDay(state.from, state.to).reverse()) {
        const found = byDay.get(day) ?? { vouchers: 0, amount: 0 };
        vouchers += found.vouchers;
        amount += found.amount;
        body.push([dayLabel(day), String(found.vouchers), money(found.amount)]);
      }
      body.push(['TOTAL', String(vouchers), money(amount)]);
    }

    doc.setFontSize(13);
    doc.text(title, 14, 16);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`${dayLabel(state.from)} – ${dayLabel(state.to)}`, 14, 22);

    autoTable(doc, {
      head,
      body,
      startY: 27,
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: { fillColor: [227, 6, 19], textColor: 255, fontSize: 8 },
      columnStyles: {
        [head[0].length - 1]: { halign: 'right' },
        [head[0].length - 2]: { halign: 'right' },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index === body.length - 1) {
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });

    doc.save(`e-vouchers-${state.tab}-${state.from}_${state.to}.pdf`);
  }
  // ---- month stepper -------------------------------------------------------
  const monthLabel = h('span', { style: { fontWeight: '700', minWidth: '150px', display: 'inline-block', textAlign: 'center' } });

  const canGoForward = () =>
    !(state.year === now.getFullYear() && state.month === now.getMonth());

  const refreshLabel = () => {
    monthLabel.textContent = MONTHS[state.month] + ' ' + state.year;
    nextButton.disabled = !canGoForward();
    nextButton.style.opacity = canGoForward() ? '1' : '.35';
  };

  async function shiftMonth(delta) {
    let month = state.month + delta;
    let year = state.year;
    if (month < 0) { month = 11; year -= 1; }
    if (month > 11) { month = 0; year += 1; }
    if (year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth())) return;

    state.year = year;
    state.month = month;
    const bounds = monthBounds(year, month);
    state.from = bounds.from;
    state.to = bounds.to;
    state.openDay = null;
    await load();
    refreshLabel();
    draw();
  }

  const prevButton = h(
    'button',
    { class: 'btn secondary sm', type: 'button', 'aria-label': 'Previous month', onclick: () => shiftMonth(-1) },
    '‹',
  );

  const nextButton = h(
    'button',
    { class: 'btn secondary sm', type: 'button', 'aria-label': 'Next month', onclick: () => shiftMonth(1) },
    '›',
  );

  const thisMonthButton = h(
    'button',
    {
      class: 'btn secondary sm',
      type: 'button',
      onclick: async () => {
        state.year = now.getFullYear();
        state.month = now.getMonth();
        const bounds = monthBounds(state.year, state.month);
        state.from = bounds.from;
        state.to = bounds.to;
        state.openDay = null;
        await load();
        refreshLabel();
        draw();
      },
    },
    'This month',
  );

  const stepper = h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
    prevButton,
    monthLabel,
    nextButton,
    thisMonthButton,
  );

  refreshLabel();

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
          h('button', { class: 'btn secondary', type: 'button', onclick: exportExcel }, 'Excel'),
          h('button', { class: 'btn secondary', type: 'button', onclick: exportPdf }, 'PDF'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'Print'),
        ),
      ),
      cardsSlot,
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'toolbar' }, h('div', { class: 'search' }, term), stepper, statusSlot),
        tabBar,
        bodySlot,
      ),
    ),
  );

  if (loadError) statusSlot.replaceChildren(banner('error', loadError.message));
  draw();
}
