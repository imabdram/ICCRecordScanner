import { avatar, banner, h, icon, mount, pill, roleName, rolePill, skeletonPanel, switchToggle, table } from '../ui.js';
import { callAdmin } from '../supabase.js';
import { filterUsers } from '../filters.js';
import { fetchTree, fetchUsers, updateUser } from '../data.js';

/**
 * User management. An account is two rows:
 *   1. auth.users  (the login, created by the admin-user Edge Function)
 *   2. public.users (role + outlet; region and zone derive from the outlet)
 *
 * Both rows are created server-side with the service role, because creating an
 * auth user needs it. That also means creating someone does NOT sign them in
 * here, so the administrator's own session survives the operation.
 *
 * The create form is opened from a "+ New user" button (modal), not an inline
 * dropdown panel. Choosing an outlet is Region -> Outlet, so only the outlets in
 * the selected region are ever offered.
 *
 * Only admins and supervisors may write here — enforced by RLS, not just the UI.
 */
export async function renderUsers(root, { profile }) {
  // A team leader manages their own outlet's accounts (rep creation is locked
  // to themselves and their own outlet by RLS); a supervisor covers their zone;
  // an admin covers everything.
  const isTeamLeader = profile.role === 'team_leader';
  const canManage = ['admin', 'supervisor', 'team_leader'].includes(profile.role);
  mount(root, h('div', {}, skeletonPanel(4)));

  try {
    const [users, tree] = await Promise.all([fetchUsers(), fetchTree()]);
    // Mutable copy so the edit dialog always offers the current team leaders.
    let listUsers = () => users;
    const outletName = (id) => tree.outlets.find((o) => o.id === id)?.name ?? '—';
    const userName = (id) => users.find((u) => u.id === id)?.full_name ?? '—';
    const status = h('div', { style: { marginBottom: '14px' } });

    const term = h('input', { type: 'search', placeholder: 'Search by name, username or outlet…' });
    const listSlot = h('div', {});
    const countSlot = h('span', { class: 'hint' }, '');

    // ---- filters ------------------------------------------------------------
    // Applied in the browser over the rows RLS already allowed, so the outlet
    // list can only contain outlets this viewer can see.
    const filterState = { role: '', status: '', outlet: '' };

    const outletChoices = [...new Set(users.map((u) => u.outlet_id).filter(Boolean))]
      .map((id) => ({ id, name: outletName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const roleFilter = h(
      'select',
      { 'aria-label': 'Role' },
      h('option', { value: '' }, 'All roles'),
      h('option', { value: 'admin' }, 'Administrator'),
      h('option', { value: 'supervisor' }, 'Supervisor'),
      h('option', { value: 'team_leader' }, 'Team Leader'),
      h('option', { value: 'sales_rep' }, 'Sales Rep'),
    );
    const statusFilter = h(
      'select',
      { 'aria-label': 'Status' },
      h('option', { value: '' }, 'Any status'),
      h('option', { value: 'active' }, 'Active'),
      h('option', { value: 'disabled' }, 'Disabled'),
    );
    const outletFilter = h(
      'select',
      { 'aria-label': 'Outlet' },
      h('option', { value: '' }, 'All outlets'),
      ...outletChoices.map((o) => h('option', { value: o.id }, o.name)),
    );

    const applyUserFilters = (rows) =>
      filterUsers(rows, { ...filterState, query: term.value, outletName });

    const resetUserFilters = () => {
      filterState.role = filterState.status = filterState.outlet = '';
      roleFilter.value = statusFilter.value = outletFilter.value = '';
      term.value = '';
      drawList(listUsers());
    };

    const onUserFilter = () => {
      filterState.role = roleFilter.value;
      filterState.status = statusFilter.value;
      filterState.outlet = outletFilter.value;
      drawList(listUsers());
    };

    const drawList = (rows) => {
      const filtered = applyUserFilters(rows);
      const active = [filterState.role, filterState.status, filterState.outlet].filter(Boolean).length;
      countSlot.textContent =
        filtered.length === rows.length
          ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'}`
          : `${filtered.length} of ${rows.length} · ${active} filter(s)`;
      mount(
        listSlot,
        table(
          [
            {
              label: 'Person',
              value: (u) =>
                h(
                  'div',
                  { class: 'identity' },
                  avatar(u.full_name, u.username),
                  h(
                    'div',
                    {},
                    h('div', { class: 'cell-strong' }, u.full_name || u.username),
                    h('div', { class: 'cell-sub' }, u.username),
                  ),
                ),
            },
            { label: 'Role', value: (u) => rolePill(u.role) },
            { label: 'Outlet', value: (u) => outletName(u.outlet_id) },
            { label: 'Team leader', value: (u) => (u.team_leader_id ? userName(u.team_leader_id) : h('span', { class: 'cell-sub' }, '—')) },
            {
              label: 'Status',
              value: (u) => {
                if (!canManage) return pill(u.active ? 'Active' : 'Disabled', u.active ? 'ok' : 'off');
                const control = switchToggle({
                  checked: u.active,
                  onChange: async (next) => {
                    control.input.disabled = true;
                    try {
                      // Goes through the Edge Function: disabling must also ban
                      // the auth login, which needs the service role.
                      await callAdmin('set-active', { user_id: u.id, active: next });
                      mount(status, banner('ok', `${u.full_name || u.username} is now ${next ? 'active' : 'disabled'}.`));
                      await reload();
                    } catch (error) {
                      control.input.checked = !next;
                      mount(status, banner('error', error.message));
                    } finally {
                      control.input.disabled = false;
                    }
                  },
                });
                return control.el;
              },
            },
            {
              label: '',
              value: (u) => {
                if (!canManage) return null;
                return h(
                  'button',
                  {
                    class: 'icon-btn',
                    type: 'button',
                    title: `Edit ${u.full_name || u.username}`,
                    'aria-label': `Edit ${u.full_name || u.username}`,
                    onclick: () =>
                      openEditUser(u, {
                        tree,
                        users: listUsers(),
                        viewer: profile,
                        onSaved: async (message) => {
                          mount(status, banner('ok', message));
                          await reload();
                        },
                      }),
                  },
                  icon('edit', 16, 'ico', true),
                );
              },
            },
          ],
          filtered,
          rows.length === 0
            ? 'No users in your scope yet.'
            : `No people match these filters (${filtered.length} of ${rows.length} shown).`,
        ),
      );
    };

    const reload = async () => {
      const fresh = await fetchUsers();
      listUsers = () => fresh;
      drawList(fresh);
    };
    term.addEventListener('input', () => drawList(listUsers()));
    roleFilter.addEventListener('change', onUserFilter);
    statusFilter.addEventListener('change', onUserFilter);
    outletFilter.addEventListener('change', onUserFilter);

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
            h('h1', {}, 'Users & Team'),
            h('p', { class: 'sub' }, `${users.length} ${users.length === 1 ? 'person' : 'people'} visible to you · ${canManage ? 'you can manage accounts' : 'read-only for your role'}`),
          ),
          canManage
            ? h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: () =>
                    openCreateUser({
                      tree,
                      users,
                      viewer: profile,
                      onDone: reload,
                    }),
                },
                icon('plus', 17, 'ico', true),
                isTeamLeader ? 'New sales rep' : 'New user',
              )
            : null,
        ),
        status,
        h(
          'section',
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
            h('label', { class: 'filter' }, h('span', {}, 'Role'), roleFilter),
            h('label', { class: 'filter' }, h('span', {}, 'Status'), statusFilter),
            h('label', { class: 'filter' }, h('span', {}, 'Outlet'), outletFilter),
            // Wrapped in a .filter with a hidden label so the button's height and
            // baseline match the selects beside it.
            h(
              'div',
              { class: 'filter no-label' },
              h('span', { 'aria-hidden': 'true' }, 'Reset'),
              h(
                'button',
                { class: 'btn secondary sm', type: 'button', onclick: resetUserFilters },
                'Reset filters',
              ),
            ),
          ),
          listSlot,
        ),
      ),
    );
    await reload();
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h1', {}, 'Users & Team'), banner('error', error.message)));
  }
}

/* ========================================================================== */
/*  Edit user                                                                 */
/* ========================================================================== */
/**
 * Edits a user.
 *
 * What is editable depends on the viewer:
 *   admin       everything, including role and outlet
 *   supervisor  their zone's people, including role and outlet
 *   team leader their own outlet's reps; the outlet is fixed and the team
 *               leader is pinned to themselves (RLS enforces the same rule)
 *
 * The email is the sign-in identity and is shown read-only. The password is
 * never readable — it is stored as a hash — so the dialog offers Neon Auth's
 * reset email instead. Scans are never touched: their location is stamped at
 * creation and history must stay intact.
 */
function openEditUser(user, { tree, users, viewer, onSaved }) {
  const name = user.full_name || user.username;
  const isAdmin = viewer.role === 'admin';
  const isLeader = viewer.role === 'team_leader';
  // A team leader manages reps of their own outlet; everything is fixed.
  const locked = isLeader;
  // Only admins and supervisors may change someone's role, and only they may
  // re-assign the outlet (a team leader's reps stay in their outlet).
  const canSetRole = isAdmin || viewer.role === 'supervisor';

  const fullName = h('input', { type: 'text', required: true, value: user.full_name ?? '', placeholder: 'Full name' });
  const phone = h('input', { type: 'tel', value: user.phone ?? '', placeholder: 'Optional' });

  // Role options follow the same rule as creation: a supervisor may only hand
  // out sales_rep/team_leader, and nobody but an admin may grant admin.
  const editableRoles =
    viewer.role === 'admin'
      ? [
          ['sales_rep', 'Sales Rep'],
          ['team_leader', 'Team Leader'],
          ['supervisor', 'Supervisor'],
          ['admin', 'Administrator'],
        ]
      : [
          ['sales_rep', 'Sales Rep'],
          ['team_leader', 'Team Leader'],
        ];

  // If the row's current role is above what this viewer may grant (for example a
  // supervisor opening an admin), still show it rather than silently defaulting
  // to the first option — which would look like a pending demotion.
  const roleOptions = editableRoles.map(([value, label]) =>
    h('option', { value, selected: user.role === value }, label),
  );
  if (!editableRoles.some(([value]) => value === user.role)) {
    roleOptions.unshift(
      h('option', { value: user.role, selected: true }, roleName(user.role)),
    );
  }

  const role = h('select', { disabled: !canSetRole }, ...roleOptions);

  const leader = h(
    'select',
    { disabled: locked },
    h('option', { value: '' }, '— none —'),
    ...users
      .filter((u) => u.role === 'team_leader' && u.id !== user.id)
      .map((u) => h('option', { value: u.id, selected: u.id === user.team_leader_id }, u.full_name || u.username)),
  );
  if (locked) {
    leader.replaceChildren(h('option', { value: viewer.user_id, selected: true }, `${viewer.full_name} (you)`));
  }

  const active = h('input', { type: 'checkbox', checked: user.active });
  const activeLabel = h('span', { class: 'edit-active-label' }, user.active ? 'Active' : 'Disabled');
  active.addEventListener('change', () => {
    activeLabel.textContent = active.checked ? 'Active' : 'Disabled';
  });

  const status = h('div', {});
  const picker = regionOutletPicker(tree, {
    initialOutletId: user.outlet_id,
    initialRegionId: user.region_id ?? viewer.region_id ?? undefined,
    disabled: locked,
  });
  scopeFieldsByRole(role, picker);

  // ---- password: an administrator sets it (service role, Edge Function) ----
  const pwStatus = h('div', {});
  const newPassword = h('input', {
    type: 'password',
    minlength: '8',
    autocomplete: 'new-password',
    placeholder: 'At least 8 characters',
  });
  const setPassword = h(
    'button',
    {
      class: 'btn secondary',
      type: 'button',
      onclick: async () => {
        pwStatus.replaceChildren();
        if ((newPassword.value ?? '').length < 8) {
          pwStatus.replaceChildren(banner('error', 'Choose a password of at least 8 characters.'));
          return;
        }
        setPassword.disabled = true;
        setPassword.replaceChildren(h('span', { class: 'spin' }), document.createTextNode('Saving…'));
        try {
          await callAdmin('set-password', { user_id: user.id, password: newPassword.value });
          newPassword.value = '';
          pwStatus.replaceChildren(banner('ok', `Password set for ${user.username}. Give it to them directly.`));
        } catch (error) {
          pwStatus.replaceChildren(banner('error', error.message));
        } finally {
          setPassword.disabled = false;
          setPassword.replaceChildren(icon('key', 16, 'ico', true), document.createTextNode('Set password'));
        }
      },
    },
    icon('key', 16, 'ico', true),
    'Set password',
  );

  const submit = h('button', { class: 'btn', type: 'submit' }, 'Save changes');

  const modal = mountModal({
    title: 'Edit user',
    subtitle: `${user.username} · changes save immediately.`,
    body: h(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          status.replaceChildren(h('p', { class: 'muted' }, 'Saving…'));
          try {
            const patch = {
              full_name: fullName.value.trim(),
              phone: phone.value.trim(),
            };
            if (!locked) {
              patch.team_leader_id = leader.value || null;
              patch.outlet_id = picker.outlet.value || null;
            }
            if (canSetRole && !locked) patch.role = role.value;
            if (locked) patch.team_leader_id = viewer.user_id;
            await updateUser(user.id, patch);

            // The active flag is deliberately separate: disabling must also ban
            // the auth login, which only the Edge Function can do.
            if (active.checked !== user.active) {
              await callAdmin('set-active', { user_id: user.id, active: active.checked });
            }

            modal.close();
            await onSaved?.(`${patch.full_name || name} updated.`);
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
        field('Full name', fullName, 'Shown on the leaderboard'),
        field('Phone', phone, 'Optional'),
        field('Username', h('input', { type: 'text', value: user.username, disabled: true }), 'Sign-in identity, cannot be changed here'),
        field('Role', role, canSetRole ? 'Determines what they can see' : 'Only an admin or supervisor can change this'),
        field('Team leader', leader, locked ? 'Fixed: you manage this rep' : 'For sales reps'),
      ),
      picker.el,
      h(
        'div',
        { class: 'edit-active' },
        h('div', {}, h('span', { class: 'field-label' }, 'Account status'), h('div', { class: 'field-hint' }, 'Disabled users cannot sign in.')),
        h('div', { class: 'edit-active-toggle' }, activeLabel, active),
      ),
      h(
        'div',
        { class: 'password-box' },
        h('div', {}, h('span', { class: 'field-label' }, 'Password'), h('div', { class: 'field-hint' }, 'Stored hashed and never readable. Set a new one and give it to them — there is no reset email.')),
        h('div', { class: 'inline-row' }, newPassword, setPassword),
        pwStatus,
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'),
        submit,
      ),
    ),
  });
}

/* ========================================================================== */
/*  Modal plumbing                                                            */
/* ========================================================================== */

/** Shared dialog shell: backdrop, Escape, focus handling, returns close(). */
function mountModal({ title, subtitle, body, actions, width }) {
  const trigger = document.activeElement;
  const dialog = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title', style: width ? { width } : null },
    h(
      'div',
      { class: 'modal-head' },
      h('div', {}, h('h2', { id: 'modal-title' }, title), subtitle ? h('p', { class: 'cell-sub' }, subtitle) : null),
      h('button', { class: 'icon-btn', type: 'button', onclick: () => close(), 'aria-label': 'Close' }, icon('close', 18, 'ico', true)),
    ),
    body,
    actions ? h('div', { class: 'modal-actions' }, ...actions) : null,
  );
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => e.target === overlay && close() }, dialog);

  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (trigger instanceof HTMLElement) trigger.focus();
  }
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { overlay, dialog, close };
}

/* ========================================================================== */
/*  Create-user modal                                                         */
/* ========================================================================== */

/**
 * Region -> Outlet cascade. `tree` holds every region/outlet the signed-in user
 * may see, so the picker can never offer an outlet outside their scope.
 * `initialOutletId` preselects that outlet's region and the outlet itself
 * (used when editing an existing user).
 */
function regionOutletPicker(tree, { initialOutletId, initialRegionId, disabled = false } = {}) {
  const initialOutlet = initialOutletId ? tree.outlets.find((o) => o.id === initialOutletId) : null;
  const region = h(
    'select',
    { required: true, 'aria-label': 'Region', disabled },
    h('option', { value: '' }, 'Select a region…'),
    ...tree.regions.map((r) => h('option', { value: r.id, selected: initialOutlet ? r.id === initialOutlet.region_id : false }, r.name)),
  );
  if (initialOutlet) region.value = initialOutlet.region_id;
  else if (initialRegionId && tree.regions.some((r) => r.id === initialRegionId)) region.value = initialRegionId;

  const outlet = h('select', { required: true, disabled: true, 'aria-label': 'Outlet' });
  const count = h('span', { class: 'field-hint' }, 'Pick a region first');

  const fillOutlets = () => {
    const outlets = tree.outlets.filter((o) => o.region_id === region.value);
    outlet.replaceChildren(
      h('option', { value: '' }, region.value ? 'Select an outlet…' : 'Choose a region first'),
      ...outlets.map((o) => h('option', { value: o.id, selected: initialOutlet ? o.id === initialOutlet.id : false }, o.name)),
    );
    outlet.disabled = !region.value || disabled;
    if (initialOutlet && !outlet.value) outlet.value = initialOutlet.id;
    count.textContent = disabled
      ? 'Fixed to your outlet'
      : region.value
        ? `${outlets.length} outlet${outlets.length === 1 ? '' : 's'} in ${
            tree.regions.find((r) => r.id === region.value)?.name ?? 'this region'
          }`
        : 'Pick a region first';
  };

  region.addEventListener('change', () => {
    fillOutlets();
    if (region.value) outlet.focus();
  });
  fillOutlets();

  const el = h(
    'div',
    { class: 'cascade' },
    h('label', { class: 'field' }, h('span', {}, 'Region'), region),
    h('label', { class: 'field' }, h('span', {}, 'Outlet'), outlet, count),
  );

  return { el, region, outlet };
}

// A supervisor covers a whole region, so the outlet field is hidden and only the
// region is required. Applied to both the create and the edit dialogs.
function scopeFieldsByRole(role, picker) {
  const outletField = picker.el.lastElementChild;
  const sync = () => {
    const isSupervisor = role.value === 'supervisor';
    outletField.style.display = isSupervisor ? 'none' : '';
    picker.outlet.required = !isSupervisor;
  };
  role.addEventListener('change', sync);
  sync();
  return sync;
}

function openCreateUser({ tree, users, viewer, onDone }) {
  // A team leader creates sales reps who work under them, in their own outlet,
  // with themselves as team leader by default. Everything else is fixed.
  const asLeader = viewer.role === 'team_leader';

  const fullName = h('input', { type: 'text', required: true, placeholder: 'e.g. Ali Abdi', autocomplete: 'off' });
  const username = h('input', {
    type: 'text',
    required: true,
    placeholder: 'e.g. ali.abdi',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
  });
  const password = h('input', { type: 'password', required: true, minlength: '8', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
  const phone = h('input', { type: 'tel', placeholder: 'Optional', autocomplete: 'off' });
  // Roles this viewer may hand out. Mirrors the database (schema v9): only an
  // administrator can create another admin or supervisor.
  const allowedRoles =
    viewer.role === 'admin'
      ? [
          ['sales_rep', 'Sales Rep'],
          ['team_leader', 'Team Leader'],
          ['supervisor', 'Supervisor'],
          ['admin', 'Administrator'],
        ]
      : viewer.role === 'supervisor'
        ? [
            ['sales_rep', 'Sales Rep'],
            ['team_leader', 'Team Leader'],
          ]
        : [['sales_rep', 'Sales Rep']];

  const role = h(
    'select',
    { disabled: asLeader },
    ...allowedRoles.map(([value, label]) => h('option', { value }, label)),
  );
  const leader = asLeader
    ? h('select', { disabled: true }, h('option', { value: viewer.user_id, selected: true }, `${viewer.full_name} (you)`))
    : h(
        'select',
        {},
        h('option', { value: '' }, '— none —'),
        ...users.filter((u) => u.role === 'team_leader' && u.active).map((u) => h('option', { value: u.id }, u.full_name || u.username)),
      );

  const status = h('div', {});
  const picker = regionOutletPicker(tree, {
    initialOutletId: asLeader ? viewer.outlet_id : undefined,
    // A supervisor works in one region, so start there.
    initialRegionId: viewer.region_id ?? undefined,
    disabled: asLeader,
  });
  scopeFieldsByRole(role, picker);
  const submit = h('button', { class: 'btn', type: 'submit' }, asLeader ? 'Create sales rep' : 'Create user');

  const modal = mountModal({
    title: 'New user',
    subtitle: 'Creates the login and links it to an outlet. The outlet sets their region and zone.',
    body: h(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          status.replaceChildren(h('p', { class: 'muted' }, 'Creating account…'));
          try {
            // One call creates both the auth user and the public.users row.
            // It runs with the service role, so it does NOT sign the new user
            // in — the administrator keeps their own session.
            const created = await callAdmin('create-user', {
              username: username.value.trim(),
              password: password.value,
              full_name: fullName.value.trim(),
              phone: phone.value.trim(),
              role: role.value,
              // A supervisor is scoped by REGION, so the outlet is not required.
              outlet_id: role.value === 'supervisor' ? null : picker.outlet.value || null,
              region_id: picker.region.value || null,
              team_leader_id: leader.value || null,
            });

            const name = created?.user?.full_name || fullName.value.trim();
            const outletLabel = picker.outlet.selectedOptions[0]?.text ?? 'an outlet';
            modal.close();
            onDone?.();
            flash(
              'ok',
              `${name} created and linked to ${outletLabel}. Give them the username and password you chose.`,
            );
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
        field('Full name', fullName, 'Shown on the leaderboard'),
        field('Username', username, 'Used to sign in — letters, digits, dot, dash'),
        field('Password', password, 'Give this to the user'),
        field('Phone', phone, 'Optional'),
        field('Role', role, 'Determines what they can see'),
        field('Team leader', leader, 'For sales reps'),
      ),
      picker.el,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'),
        submit,
      ),
    ),
  });
  fullName.focus();
}

function flash(kind, message, action) {
  const box = banner(kind, message, action);
  const header = document.querySelector('.page-head');
  if (header) header.insertAdjacentElement('afterend', box);
  box.scrollIntoView({ block: 'nearest' });
}

function field(text, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, text), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
