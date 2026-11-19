import { banner, h, icon, mount, setBusy } from '../ui.js';
import { signIn } from '../neon.js';

/** Sign-in against Managed Better Auth (returns the session cookie). */
export function renderLogin(root, onSignedIn) {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'you@example.com' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Enter your password' });
  const message = h('div', {});
  const submit = h('button', { class: 'btn block', type: 'submit' }, 'Sign in');

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        message.replaceChildren();
        setBusy(submit, true, 'Signing in…');
        try {
          await signIn(email.value.trim(), password.value);
          await onSignedIn();
        } catch (error) {
          message.append(banner('error', error.message));
          setBusy(submit, false);
        }
      },
    },
    h('div', { style: { textAlign: 'center', marginBottom: '22px' } },
      h('div', {
        class: 'brand-logo',
        style: {
          width: '52px', height: '52px', borderRadius: '15px', margin: '0 auto 14px',
          background: 'linear-gradient(140deg,#ff4b57,#e11929 60%)',
          boxShadow: '0 10px 24px -8px rgba(225,25,41,.6)', display: 'grid', placeItems: 'center',
        },
      }, icon('records', 26, 'ico')),
      h('h1', { style: { fontSize: '22px', margin: 0 } }, 'SIM Management System'),
      h('p', { class: 'muted', style: { marginTop: '6px' } }, 'Sign in to the Bari Region operations console.'),
    ),
    message,
    h('label', { class: 'field' }, h('span', {}, 'Email'), email),
    h('label', { class: 'field', style: { marginTop: '14px' } }, h('span', {}, 'Password'), password),
    h('div', { style: { marginTop: '20px' } }, submit),
    h(
      'p',
      { class: 'muted', style: { textAlign: 'center', fontSize: '12.5px', marginTop: '16px' } },
      'Accounts are created by an administrator in Users & Team.',
    ),
  );

  mount(
    root,
    h('div', { class: 'auth-wrap' }, h('div', { class: 'panel narrow', style: { width: '100%' } }, form)),
  );
  email.focus();
}
