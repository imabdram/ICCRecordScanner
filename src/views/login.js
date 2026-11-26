import { banner, h, mount, setBusy } from '../ui.js';
import { signIn } from '../supabase.js';

/**
 * Sign-in with a username and password.
 *
 * The username is mapped to `username@sim.local` before reaching Supabase Auth,
 * so nobody has to type or remember an email address. There is no "forgot
 * password" link: accounts are created by an administrator, and an administrator
 * sets a new password from Users & Team.
 */
export function renderLogin(root, onSignedIn) {
  const username = h('input', {
    type: 'text',
    required: true,
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: 'your.username',
  });
  const password = h('input', {
    type: 'password',
    required: true,
    autocomplete: 'current-password',
    placeholder: 'Enter your password',
  });

  const message = h('div', {});
  const submit = h('button', { class: 'btn block signin', type: 'submit' }, 'Sign in');

  const form = h(
    'form',
    {
      class: 'login-card',
      onsubmit: async (event) => {
        event.preventDefault();
        message.replaceChildren();
        setBusy(submit, true, 'Signing in…');
        try {
          // Trim only: usernames are already stored lower-case, and the mapping
          // to the synthetic email lower-cases again.
          await signIn(username.value.trim(), password.value);
          await onSignedIn();
        } catch (error) {
          message.append(banner('error', error.message));
          setBusy(submit, false);
        }
      },
    },
    h(
      'div',
      { class: 'login-brand' },
      h('img', { src: '/amtel-logo.png', alt: 'Amtel', class: 'login-logo' }),
      h('span', { class: 'tagline' }, 'Always closer you'),
    ),
    h('h1', { class: 'login-title' }, 'SIM Management System'),
    h('p', { class: 'login-sub' }, 'Sign in to the Bari Region operations console.'),
    message,
    h('label', { class: 'field login-field' }, h('span', {}, 'Username'), username),
    h('label', { class: 'field login-field' }, h('span', {}, 'Password'), password),
    h('div', { class: 'login-submit' }, submit),
    h(
      'div',
      { class: 'login-notice' },
      h('span', { class: 'notice-title' }, 'Security notice'),
      h(
        'p',
        {},
        'Accounts are created by an administrator. If you have forgotten your password, ask them to set a new one — there is no reset email.',
      ),
    ),
  );

  mount(
    root,
    h(
      'div',
      { class: 'login-page' },
      // One logo only, inside the card above the heading.
      form,
      h('div', { class: 'login-footer' }, 'Amtel · Bari Region'),
    ),
  );
  username.focus();
}
