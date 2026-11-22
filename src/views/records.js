import { banner, card, fmtDate, fmtTime, h, icon, mount, roleName, skeletonPanel, table } from '../ui.js';
import { fetchScans, fetchUsers } from '../data.js';
import { supabase, unwrap } from '../supabase.js';

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
                  'button',
                  {
                    class: 'icon-btn',
                    type: 'button',
                    title: `Edit ${s.iccid}`,
                    'aria-label': `Edit ${s.iccid}`,
                    onclick: () => openEditScan(s, { onSaved: () => renderRecords(root, { profile }) }),
                  },
                  icon('edit', 16, 'ico', true),
                ),
            },
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
            'div',
            { class: 'page-actions', style: { display: 'flex', gap: '8px' } },
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () =>
                  openAddRecord({ profile, onSaved: () => renderRecords(root, { profile }) }),
              },
              icon('plus', 16, 'ico', true),
              'Add record',
            ),
            h(
              'button',
              { class: 'btn secondary', onclick: () => exportCsv(term.value ? scans.filter((s) => JSON.stringify(s).toLowerCase().includes(term.value.toLowerCase())) : scans) },
              icon('download', 16, 'ico', true),
              'Export CSV',
            ),
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

/**
 * Phone number rules, mirroring the database constraints.
 *   primary : 71 followed by 7 digits (9 total) -- enforced by schema_v6
 *   backup  : any 7-12 digits
 * The database is the authority; these just produce a readable message instead
 * of a constraint violation.
 */
const PRIMARY_RE = /^71[0-9]{7}$/;
const SECONDARY_RE = /^[0-9]{7,12}$/;

function checkNumbers(primary, secondary) {
  if (!PRIMARY_RE.test(primary)) {
    return 'Primary number must be 71 followed by 7 digits (for example 712345678).';
  }
  if (!SECONDARY_RE.test(secondary)) {
    return 'Backup number must be 7 to 12 digits.';
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
