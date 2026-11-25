import { banner, card, h, mount, roleName, skeletonPanel } from '../ui.js';
import { fetchVoucherDailyLocal } from '../data.js';
import { buildIndividual, buildTeam, summariseTeam } from '../voucher-report.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** '2026-11-01' -> 'Nov 01' (long form for the header, short for rows). */
const dayShort = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${MONTHS[Number(m) - 1]} ${d}`;
};
const dayFull = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${MONTHS[Number(m) - 1]} ${d}, ${y}`;
};

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isoMonthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

/**
 * Daily E-Voucher Reports.
 *
 * Two modes over one dataset: one rep, or the whole team. Every day of the range
 * is listed even when nothing sold, because a gap is the finding.
 */
export async function renderVoucherReports(root, { profile }) {
  mount(root, h('div', {}, skeletonPanel(6)));

  const from = isoMonthStart();
  const to = isoToday();

  let daily = [];
  let mode = 'individual';
  let repId = '';
  let openDays = new Set();

  const state = { from, to, mode, repId };

  try {
    daily = await fetchVoucherDailyLocal(state.from, state.to);
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h1', {}, 'Daily E-Voucher Reports'), banner('error', error.message)));
    return;
  }

  const reps = [...new Map(daily.map((r) => [r.sales_rep_id, r.sales_rep_name])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));

  // ---- controls ------------------------------------------------------------
  const fromInput = h('input', { type: 'date', value: state.from, 'aria-label': 'Start date' });
  const toInput = h('input', { type: 'date', value: state.to, 'aria-label': 'End date' });

  const repSelect = h(
    'select',
    { 'aria-label': 'Sales representative' },
    h('option', { value: '' }, 'Choose a sales rep…'),
    ...reps.map(([id, name]) => h('option', { value: id }, name)),
  );

  const modeButton = (value, label) =>
    h(
      'button',
      {
        type: 'button',
        class: `seg${mode === value ? ' active' : ''}`,
        onclick: async () => {
          mode = value;
          openDays = new Set();
          await refresh();
        },
      },
      label,
    );

  const bodySlot = h('div', {});
  const cardsSlot = h('div', { class: 'cards' });
  const statusSlot = h('div', {});

  async function reload() {
    statusSlot.replaceChildren();
    try {
      daily = await fetchVoucherDailyLocal(state.from, state.to);
    } catch (error) {
      statusSlot.replaceChildren(banner('error', error.message));
      daily = [];
    }
  }

  function drawCards(summary) {
    cardsSlot.replaceChildren(
      card('Total E-Voucher Amount', money(summary.amount), { accent: 'accent-red' }),
      card('Total Vouchers Sold', String(summary.vouchers)),
      card('Active Sales Reps', String(summary.activeReps), { accent: 'accent-green' }),
      card('Average Daily Sales', money(summary.averagePerDay), { foot: `${summary.days} day(s)` }),
    );
  }

  function drawIndividual() {
    const { rows, totals } = buildIndividual(daily, state.repId, state.from, state.to);
    const repName = reps.find(([id]) => id === state.repId)?.[1] ?? '';

    drawCards({
      amount: totals.amount,
      vouchers: totals.vouchers,
      activeReps: totals.vouchers > 0 ? 1 : 0,
      averagePerDay: rows.length ? totals.amount / rows.length : 0,
      days: rows.length,
    });

    bodySlot.replaceChildren(
      h('p', { class: 'sub' }, `${repName} · ${dayFull(state.from)} – ${dayFull(state.to)}`),
      h(
        'table',
        { class: 'report-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', { class: 'num' }, 'Vouchers'), h('th', { class: 'num' }, 'Amount'))),
        h(
          'tbody',
          {},
          ...rows.map((row) =>
            h(
              'tr',
              { class: row.vouchers ? '' : 'empty-row' },
              h('td', {}, dayShort(row.day)),
              h('td', { class: 'num' }, String(row.vouchers)),
              h('td', { class: 'num' }, money(row.amount)),
            ),
          ),
        ),
        h(
          'tfoot',
          {},
          h(
            'tr',
            {},
            h('td', {}, 'TOTAL'),
            h('td', { class: 'num' }, String(totals.vouchers)),
            h('td', { class: 'num strong' }, money(totals.amount)),
          ),
        ),
      ),
    );
  }

  function drawTeam() {
    const team = buildTeam(daily, state.from, state.to);
    const summary = summariseTeam(team, state.from, state.to);
    drawCards(summary);

    const rows = [];
    for (const day of team.rows) {
      const isOpen = openDays.has(day.day);
      const row = h(
        'tr',
        {
          class: `clickable${day.vouchers ? '' : ' empty-row'}`,
          onclick: () => {
            if (!day.byRep.length) return;
            if (isOpen) openDays.delete(day.day);
            else openDays.add(day.day);
            drawTeam();
          },
        },
        h('td', {}, (day.byRep.length ? (isOpen ? '▾ ' : '▸ ') : '') + dayShort(day.day)),
        h('td', { class: 'num' }, String(day.vouchers)),
        h('td', { class: 'num' }, money(day.amount)),
      );
      rows.push(row);

      if (isOpen) {
        rows.push(
          h(
            'tr',
            { class: 'detail-row' },
            h(
              'td',
              { colspan: '3' },
              h(
                'table',
                { class: 'report-table nested' },
                h(
                  'thead',
                  {},
                  h('tr', {}, h('th', {}, 'Sales representative'), h('th', { class: 'num' }, 'Vouchers'), h('th', { class: 'num' }, 'Amount')),
                ),
                h(
                  'tbody',
                  {},
                  ...day.byRep.map((rep) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, rep.sales_rep_name),
                      h('td', { class: 'num' }, String(rep.vouchers)),
                      h('td', { class: 'num' }, money(rep.amount)),
                    ),
                  ),
                ),
                h(
                  'tfoot',
                  {},
                  h('tr', {}, h('td', {}, 'TOTAL'), h('td', { class: 'num' }, String(day.vouchers)), h('td', { class: 'num' }, money(day.amount))),
                ),
              ),
            ),
          ),
        );
      }
    }

    bodySlot.replaceChildren(
      h(
        'table',
        { class: 'report-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', { class: 'num' }, 'Total Vouchers'), h('th', { class: 'num' }, 'Total Amount'))),
        h('tbody', {}, ...rows),
        h(
          'tfoot',
          {},
          h('tr', {}, h('td', {}, 'TOTAL'), h('td', { class: 'num' }, String(team.totals.vouchers)), h('td', { class: 'num strong' }, money(team.totals.amount))),
        ),
      ),
    );
  }

  async function refresh() {
    await reload();
    if (mode === 'individual') {
      repSelect.style.display = '';
      if (!state.repId && reps.length) {
        state.repId = reps[0][0];
        repSelect.value = state.repId;
      }
      if (!state.repId) {
        bodySlot.replaceChildren(h('p', { class: 'sub' }, 'No vouchers uploaded yet.'));
        drawCards({ amount: 0, vouchers: 0, activeReps: 0, averagePerDay: 0, days: 0 });
        return;
      }
      drawIndividual();
    } else {
      repSelect.style.display = 'none';
      drawTeam();
    }
  }

  // ---- exports -------------------------------------------------------------
  async function exportExcel() {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Daily E-Vouchers');
    const head = ['Date', 'Vouchers', 'Amount'];
    ws.addRow(head);
    ws.getRow(1).font = { bold: true };

    if (mode === 'individual') {
      const { rows, totals } = buildIndividual(daily, state.repId, state.from, state.to);
      rows.forEach((row) => ws.addRow([row.day, row.vouchers, row.amount]));
      ws.addRow(['TOTAL', totals.vouchers, totals.amount]);
    } else {
      const team = buildTeam(daily, state.from, state.to);
      team.rows.forEach((row) => ws.addRow([row.day, row.vouchers, row.amount]));
      ws.addRow(['TOTAL', team.totals.vouchers, team.totals.amount]);
    }

    ws.columns.forEach((col) => (col.width = 18));
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `e-voucher-${mode}-${state.from}_${state.to}.xlsx` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const exportBar = h(
    'div',
    { class: 'row-actions' },
    h('button', { class: 'btn', type: 'button', onclick: exportExcel }, 'Export to Excel'),
    h('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'Download PDF'),
    h('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'Print Report'),
  );

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
          h('h1', {}, 'Daily E-Voucher Reports'),
          h('p', { class: 'sub' }, `Daily airtime per rep or the whole team · you are ${roleName(profile.role)}`),
        ),
      ),
      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'filters' },
          h('div', { class: 'filter' }, h('span', {}, 'Report'), h('div', { class: 'segment' }, modeButton('individual', 'Individual'), modeButton('team', 'Whole Team'))),
          h('label', { class: 'filter' }, h('span', {}, 'Sales rep'), repSelect),
          h('label', { class: 'filter' }, h('span', {}, 'Start date'), fromInput),
          h('label', { class: 'filter' }, h('span', {}, 'End date'), toInput),
          h(
            'div',
            { class: 'filter no-label' },
            h('span', { 'aria-hidden': 'true' }, 'Apply'),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: async () => {
                  state.from = fromInput.value;
                  state.to = toInput.value;
                  if (state.from > state.to) {
                    statusSlot.replaceChildren(banner('error', 'The start date is after the end date.'));
                    return;
                  }
                  openDays = new Set();
                  await refresh();
                },
              },
              'Apply',
            ),
          ),
        ),
        statusSlot,
      ),
      cardsSlot,
      h('div', { class: 'panel' }, exportBar, bodySlot),
    ),
  );

  repSelect.addEventListener('change', () => {
    state.repId = repSelect.value;
    refresh();
  });

  await refresh();
}
