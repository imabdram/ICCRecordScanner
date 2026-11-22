import { banner, card, fmtDate, fmtTime, h, icon, mount, roleName, skeletonPanel, table } from '../ui.js';
import { deleteScan, fetchScans, fetchUsers } from '../data.js';
import { filterScans } from '../filters.js';
import { supabase, unwrap } from '../supabase.js';

/** Recent scans, newest first, filtered by RLS for this user's role. */
export async function renderRecords(root, { profile, go }) {
  // The database policy decides who may delete; this only hides a control that
  // would fail anyway. Sales reps cannot delete, not even their own scans.
  const canDelete = ['admin', 'supervisor', 'team_leader'].includes(profile.role);
  const reload = () => renderRecords(root, { profile, go });
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

    const term = h('input', { type: 'search', placeholder: 'Search customer, ICCID or number…' });
    const tableSlot = h('div', {});
    const countSlot = h('span', { class: 'hint' }, '');

    // ---- filters ------------------------------------------------------------
    // Filtering happens in the browser over the rows RLS already allowed. The
    // rep and outlet lists are derived from those rows, so the pickers can never
    // offer something the user is not allowed to see.
    const state = { from: '', to: '', rep: '', outlet: '' };

    const reps = [...new Map(scans.map((s) => [s.sales_rep_id, s.sales_rep_name])).entries()]
      .filter(([id, name]) => id && name)
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const outlets = [...new Set(scans.map((s) => s.outlet_name).filter(Boolean))].sort();

    const fromInput = h('input', { type: 'date', 'aria-label': 'From date' });
    const toInput = h('input', { type: 'date', 'aria-label': 'To date' });
    const repSelect = h(
      'select',
      { 'aria-label': 'Sales rep' },
      h('option', { value: '' }, 'All reps'),
      ...reps.map(([id, name]) => h('option', { value: id }, name)),
    );
    const outletSelect = h(
      'select',
      { 'aria-label': 'Outlet' },
      h('option', { value: '' }, 'All outlets'),
      ...outlets.map((name) => h('option', { value: name }, name)),
    );

    const applyFilters = (rows) =>
      filterScans(rows, { ...state, query: term.value });

    const resetFilters = () => {
      state.from = state.to = state.rep = state.outlet = '';
      fromInput.value = toInput.value = repSelect.value = outletSelect.value = '';
      term.value = '';
      draw();
    };

    const onFilter = () => {
      state.from = fromInput.value;
      state.to = toInput.value;
      state.rep = repSelect.value;
      state.outlet = outletSelect.value;
      draw();
    };

    const draw = () => {
      const filtered = applyFilters(scans);
      const active = [state.from, state.to, state.rep, state.outlet].filter(Boolean).length;
      countSlot.textContent =
        filtered.length === scans.length
          ? `${scans.length} scan(s)`
          : `${filtered.length} of ${scans.length} scan(s) · ${active} filter(s)`;
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
              // Every scan belongs to a person since v5 removed the device model.
              label: 'Recorded by',
              value: (s) => s.sales_rep_name ?? '—',
            },
            {
              label: 'Outlet · Region',
              value: (s) => h('div', {}, h('div', {}, s.outlet_name), h('div', { class: 'cell-sub' }, s.region_name ?? '—')),
            },
            { label: 'Date', value: (s) => fmtDate(s.created_at) },
            { label: 'Time', value: (s) => h('span', { class: 'num' }, fmtTime(s.created_at)) },
            {
              label: '',
              value: (s) =>
                h(
                  'div',
                  { class: 'row-actions' },
                  h(
                    'button',
                    {
                      class: 'icon-btn',
                      type: 'button',
                      title: `Edit ${s.iccid}`,
                      'aria-label': `Edit ${s.iccid}`,
                      onclick: () => openEditScan(s, { onSaved: reload }),
                    },
                    icon('edit', 16, 'ico', true),
                  ),
                  canDelete
                    ? h(
                        'button',
                        {
                          class: 'icon-btn danger',
                          type: 'button',
                          title: `Delete ${s.iccid}`,
                          'aria-label': `Delete ${s.iccid}`,
                          onclick: () => confirmDeleteScan(s, { onDeleted: reload }),
                        },
                        icon('trash', 16, 'ico', true),
                      )
                    : null,
                ),
            },
          ],
          filtered,
          scans.length === 0
            ? 'No scans in your scope yet.'
            : `No scans match these filters (${filtered.length} of ${scans.length} shown).`,
        ),
      );
    };

    term.addEventListener('input', draw);
    fromInput.addEventListener('change', onFilter);
    toInput.addEventListener('change', onFilter);
    repSelect.addEventListener('change', onFilter);
    outletSelect.addEventListener('change', onFilter);

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
            'div',
            { class: 'page-actions', style: { display: 'flex', gap: '8px' } },
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () =>
                  openAddRecord({ profile, onSaved: reload }),
              },
              icon('plus', 16, 'ico', true),
              'Add record',
            ),
            h(
              'button',
              {
                class: 'btn secondary',
                type: 'button',
                onclick: () => {
                  // Export exactly what the table shows, filters included.
                  exportExcel(applyFilters(scans));
                },
              },
              icon('download', 16, 'ico', true),
              'Export Excel',
            ),
            // Rarely used, so it lives here rather than in the sidebar.
            canDelete
              ? h(
                  'button',
                  {
                    class: 'btn secondary',
                    type: 'button',
                    title: 'Records that were deleted, and by whom',
                    onclick: () => go?.('audit'),
                  },
                  icon('trash', 15, 'ico', true),
                  'Deleted',
                )
              : null,
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
          h(
            'div',
            { class: 'toolbar' },
            h('div', { class: 'search' }, icon('search', 16, 'ico', true), term),
            countSlot,
          ),
          h(
            'div',
            { class: 'filters' },
            h('label', { class: 'filter' }, h('span', {}, 'From'), fromInput),
            h('label', { class: 'filter' }, h('span', {}, 'To'), toInput),
            h('label', { class: 'filter' }, h('span', {}, 'Sales rep'), repSelect),
            h('label', { class: 'filter' }, h('span', {}, 'Outlet'), outletSelect),
            // Wrapped in a .filter with a hidden label so the button's height and
            // baseline match the selects beside it.
            h(
              'div',
              { class: 'filter no-label' },
              h('span', { 'aria-hidden': 'true' }, 'Reset'),
              h(
                'button',
                { class: 'btn secondary sm', type: 'button', onclick: resetFilters },
                'Reset filters',
              ),
            ),
          ),
          tableSlot,
        ),
      ),
    );
    draw();
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h1', {}, 'Scan Records'), banner('error', error.message)));
  }
}

/**
 * Phone number rules, mirroring the database constraints (schema v8).
 *   primary : 071 followed by 7 digits (10 total)     0716736063
 *   backup  : 10 digits starting 090, 061 or 063      0905736063
 * The database is the authority; these just produce a readable message instead
 * of a constraint violation.
 */
const PRIMARY_RE = /^071[0-9]{7}$/;
const SECONDARY_RE = /^(090[0-9]{7}|061[0-9]{7}|063[0-9]{7})$/;

function checkNumbers(primary, secondary) {
  if (!PRIMARY_RE.test(primary)) {
    return 'Primary number must be 071 followed by 7 digits (for example 0716736063).';
  }
  if (!SECONDARY_RE.test(secondary)) {
    return 'Backup number must be 10 digits starting 090, 061 or 063 (for example 0905736063).';
  }
  return null;
}

/* ========================================================================== */
/*  Add record by hand                                                        */
/* ========================================================================== */

/**
 * Files a scan from the office: a damaged SIM, or a scan that was missed in
 * the field.
 *
 * "Recorded by" defaults to the signed-in user and offers whoever they may
 * file for:
 *   admin        anyone
 *   supervisor   their zone
 *   team leader  their outlet
 *   sales rep    only themselves
 *
 * That rule is enforced in Postgres (scans_insert + scans_before_write), not
 * here — this dropdown only spares you from an error message. The location is
 * derived from the chosen person, never from the caller.
 */
async function openAddRecord({ profile, onSaved }) {
  const iccid = h('input', { type: 'text', required: true, placeholder: '8925... (18-22 digits)', autocomplete: 'off' });
  const customer = h('input', { type: 'text', required: true, placeholder: 'Customer name', autocomplete: 'off' });
  const primary = h('input', { type: 'text', required: true, placeholder: 'Primary number', autocomplete: 'off' });
  const secondary = h('input', { type: 'text', required: true, placeholder: 'Backup number', autocomplete: 'off' });
  const status = h('div', {});
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Save record');

  // Who can this person file for? RLS on `users` already limits the list.
  const who = h('select', { required: true, 'aria-label': 'Recorded by' });
  let users = [];
  try {
    users = await fetchUsers();
  } catch (error) {
    users = [];
    status.replaceChildren(banner('error', `Could not load the people list: ${error.message}`));
  }
  const self = { id: profile.user_id, full_name: profile.full_name || profile.username, username: profile.username };
  const choices = [self, ...users.filter((u) => u.id !== self.id && u.active)];
  who.replaceChildren(
    ...choices.map((u) => h('option', { value: u.id, selected: u.id === self.id },
      u.id === self.id ? `${u.full_name} (me)` : (u.full_name || u.username))),
  );

  const dialog = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', {}, 'Add record')),
    h(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          status.replaceChildren();
          submit.disabled = true;

          const digits = (v) => String(v ?? '').replace(/\D/g, '');
          const cleanIccid = digits(iccid.value);
          if (cleanIccid.length < 18 || cleanIccid.length > 22) {
            status.replaceChildren(banner('error', 'ICCID must be 18-22 digits.'));
            submit.disabled = false;
            return;
          }
          const numberError = checkNumbers(digits(primary.value), digits(secondary.value));
          if (numberError) {
            status.replaceChildren(banner('error', numberError));
            submit.disabled = false;
            return;
          }

          try {
            unwrap(
              await supabase()
                .from('scans')
                .insert({
                  iccid: cleanIccid,
                  customer_name: customer.value.trim(),
                  primary_number: digits(primary.value),
                  secondary_number: digits(secondary.value),
                  sales_rep_id: who.value,
                })
                .select(),
            );
            close();
            await onSaved?.();
          } catch (error) {
            const message = String(error.message ?? error);
            status.replaceChildren(
              banner(
                'error',
                /duplicate key/i.test(message)
                  ? 'That ICCID is already recorded.'
                  : message,
              ),
            );
            submit.disabled = false;
          }
        },
      },
      status,
      h(
        'div',
        { class: 'form-grid' },
        field('ICCID', iccid, 'Printed on the SIM. Cannot be changed later.'),
        field('Customer name', customer),
        field('Primary number', primary),
        field('Backup number', secondary),
        field('Recorded by', who, "Counts towards this person's records"),
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => close() }, 'Cancel'),
        submit,
      ),
    ),
  );

  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => e.target === overlay && close() }, dialog);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  iccid.focus();
}

/* ========================================================================== */
/*  Delete a scan                                                             */
/* ========================================================================== */

/**
 * Removes a scan for everyone.
 *
 * The `scans_delete` policy is the real gate (admin anywhere, supervisor in
 * their zone, team leader in their outlet); this dialog exists so a misclick
 * cannot destroy a record. A sales rep never sees the button.
 */
function confirmDeleteScan(scan, { onDeleted }) {
  const status = h('div', {});
  const deleteBtn = h(
    'button',
    { class: 'btn', type: 'button', style: { background: 'var(--red, #d93025)' } },
    'Delete record',
  );

  const dialog = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'del-title' },
    h(
      'div',
      { class: 'modal-head' },
      h(
        'div',
        {},
        h('h2', { id: 'del-title' }, 'Delete this record?'),
        h('p', { class: 'cell-sub mono' }, scan.iccid),
      ),
    ),
    h(
      'div',
      { style: { padding: '4px 2px 10px' } },
      status,
      h('p', { style: { margin: '0 0 6px' } },
        `${scan.customer_name} · recorded by ${scan.sales_rep_name ?? 'unknown'}`),
      h('p', { class: 'cell-sub', style: { margin: 0 } },
        'Removed for everyone, including reports. This cannot be undone.'),
    ),
    h(
      'div',
      { class: 'modal-actions' },
      h('button', { class: 'btn secondary', type: 'button', onclick: () => close() }, 'Cancel'),
      deleteBtn,
    ),
  );

  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => e.target === overlay && close() }, dialog);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);

  deleteBtn.addEventListener('click', async () => {
    deleteBtn.disabled = true;
    deleteBtn.replaceChildren(h('span', { class: 'spin' }), document.createTextNode('Deleting…'));
    try {
      await deleteScan(scan.id);
      close();
      await onDeleted?.();
    } catch (error) {
      status.replaceChildren(banner('error', error.message));
      deleteBtn.disabled = false;
      deleteBtn.replaceChildren(document.createTextNode('Delete record'));
    }
  });
}

/* ========================================================================== */
/*  Edit a scan                                                               */
/* ========================================================================== */

/**
 * Corrects the customer details of an existing record.
 *
 * The ICCID is shown but not editable: it identifies the physical SIM, and
 * changing it would silently merge two different cards. The rep and the
 * outlet/region/zone are also fixed -- they were stamped when the scan was
 * filed, and history must stay truthful about who recorded what and where.
 *
 * Who may edit is enforced by the `scans_update` policy: admin anywhere,
 * supervisor in their zone, team leader in their outlet, a rep on their own.
 */
function openEditScan(scan, { onSaved }) {
  const customer = h('input', { type: 'text', required: true, value: scan.customer_name ?? '' });
  const primary = h('input', { type: 'text', required: true, value: scan.primary_number ?? '' });
  const secondary = h('input', { type: 'text', required: true, value: scan.secondary_number ?? '' });
  const status = h('div', {});
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Save changes');

  const dialog = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' },
      h('div', {},
        h('h2', {}, 'Edit record'),
        h('p', { class: 'cell-sub' }, `${scan.iccid} · ${scan.sales_rep_name ?? ''}`),
      ),
    ),
    h(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          status.replaceChildren();
          submit.disabled = true;
          const digits = (v) => String(v ?? '').replace(/\D/g, '');
          const numberError = checkNumbers(digits(primary.value), digits(secondary.value));
          if (numberError) {
            status.replaceChildren(banner('error', numberError));
            submit.disabled = false;
            return;
          }
          try {
            unwrap(
              await supabase()
                .from('scans')
                .update({
                  customer_name: customer.value.trim(),
                  primary_number: digits(primary.value),
                  secondary_number: digits(secondary.value),
                })
                .eq('id', scan.id)
                .select(),
            );
            close();
            await onSaved?.();
          } catch (error) {
            status.replaceChildren(banner('error', error.message));
            submit.disabled = false;
          }
        },
      },
      status,
      h(
        'div',
        { class: 'form-grid' },
        field('ICCID', h('input', { type: 'text', value: scan.iccid, disabled: true }), 'Identifies the SIM and cannot be changed'),
        field('Customer name', customer),
        field('Primary number', primary),
        field('Backup number', secondary),
        field('Recorded by', h('input', { type: 'text', value: scan.sales_rep_name ?? '—', disabled: true }), 'Fixed when the scan was filed'),
        field('Outlet', h('input', { type: 'text', value: scan.outlet_name ?? '—', disabled: true }), 'Fixed when the scan was filed'),
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => close() }, 'Cancel'),
        submit,
      ),
    ),
  );

  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => e.target === overlay && close() }, dialog);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  customer.focus();
}

function field(text, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, text), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

/**
 * Excel export matching the team's existing report:
 *   No | Name | Sales Rep | ICC ID | Golis Num | Amtel Num | Status | plan
 *
 * Dark blue header with white bold text, frozen header row, autofilter,
 * thin bottom borders, centred IDs. "Status" and "plan" are exported empty:
 * they are filled in after export, and inventing values would be worse than a
 * blank cell.
 */
async function exportExcel(rows) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIM Management System';
  wb.created = new Date();
  const ws = wb.addWorksheet('Customers', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'No', width: 6, style: { alignment: { horizontal: 'center' } } },
    { header: 'Name', width: 34 },
    { header: 'Sales Rep', width: 28 },
    { header: 'ICC ID', width: 16, style: { alignment: { horizontal: 'center' } } },
    { header: 'Golis Num', width: 16, style: { alignment: { horizontal: 'center' } } },
    { header: 'Amtel Num', width: 16, style: { alignment: { horizontal: 'center' } } },
    { header: 'Status', width: 12, style: { alignment: { horizontal: 'center' } } },
    { header: 'plan', width: 10, style: { alignment: { horizontal: 'center' } } },
  ];

  ws.getRow(1).height = 24;
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F4E78' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin' } };
  });

  rows.forEach((r, i) => {
    const row = ws.addRow([
      i + 1,
      r.customer_name ?? '',
      r.sales_rep_name ?? '',
      r.iccid ?? '',
      r.secondary_number ?? '', // Golis number
      r.primary_number ?? '',   // Amtel number (71...)
      '',
      '',
    ]);
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { size: 11 };
      cell.border = { bottom: { style: 'thin' } };
      cell.alignment =
        col === 2 || col === 3
          ? { horizontal: 'left' }
          : { horizontal: 'center' };
    });
  });

  ws.autoFilter = { from: 'A1', to: 'H1' };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = h('a', {
    href: url,
    download: `customers_${new Date().toISOString().slice(0, 10)}.xlsx`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


