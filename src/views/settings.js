import { banner, h, mount, roleName, avatar } from '../ui.js';
import { changeOwnPassword } from '../supabase.js';
import { fetchTree } from '../data.js';

/**
 * Settings: the signed-in user's own details and password.
 *
 * Changing a password is self-service. Supabase's updateUser() does not verify
 * the current password, so `changeOwnPassword` re-authenticates first — that
 * happens on the auth server, so it is a real check rather than a client-side
 * formality.
 */
export async function renderSettings(root, { profile }) {
  mount(root, h('div', { class: 'panel' }, h('h1', {}, 'Settings'), h('p', { class: 'muted' }, 'Loading…')));

  let outletName = '—';
  try {
    const tree = await fetchTree();
    outletName = tree.outlets.find((o) => o.id === profile.outlet_id)?.name ?? '—';
  } catch {
    /* the tree is decoration here; never block the page on it */
  }

  const current = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Current password' });
  const next = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
  const confirm = h('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: 'Repeat the new password' });
  const status = h('div', {});
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Change password');

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        status.replaceChildren();
        if (next.value !== confirm.value) {
          status.replaceChildren(banner('error', 'The new passwords do not match.'));
          return;
        }
        if (next.value === current.value) {
          status.replaceChildren(banner('error', 'Choose a password different from the current one.'));
          return;
        }
        submit.disabled = true;
        submit.replaceChildren(h('span', { class: 'spin' }), document.createTextNode('Saving…'));
        try {
          await changeOwnPassword({ currentPassword: current.value, newPassword: next.value });
          status.replaceChildren(banner('ok', 'Password changed. Use it the next time you sign in.'));
          form.reset();
        } catch (error) {
          status.replaceChildren(banner('error', error.message));
        } finally {
          submit.disabled = false;
          submit.replaceChildren(document.createTextNode('Change password'));
        }
      },
    },
    status,
    h(
      'div',
      { class: 'form-grid' },
      field('Current password', current),
      field('New password', next, 'At least 8 characters'),
      field('Confirm new password', confirm),
    ),
    h('div', { class: 'form-actions' }, submit),
  );

  mount(
    root,
    h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Your account'))),
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'Profile'),
        h(
          'div',
          { class: 'identity', style: { marginBottom: '14px' } },
          avatar(profile.full_name, profile.username, 'avatar'),
          h('div', {}, h('div', { class: 'cell-strong' }, profile.full_name || profile.username), h('div', { class: 'cell-sub' }, roleName(profile.role))),
        ),
        h(
          'div',
          { class: 'meta-grid' },
          h('div', {}, h('div', { class: 'k' }, 'Username (sign-in)'), h('div', { class: 'v' }, profile.username)),
          h('div', {}, h('div', { class: 'k' }, 'Outlet'), h('div', { class: 'v' }, outletName)),
          h('div', {}, h('div', { class: 'k' }, 'Region'), h('div', { class: 'v' }, profile.region_name ?? '—')),
          h('div', {}, h('div', { class: 'k' }, 'Zone'), h('div', { class: 'v' }, profile.zone_name ?? '—')),
        ),
        h('p', { class: 'cell-sub', style: { marginTop: '12px' } }, 'Your username is your sign-in identity and is managed by an administrator.'),
      ),
      h('section', { class: 'panel' }, h('h2', {}, 'Change password'), form),
    ),
  );
}

function field(text, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, text), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
