import { $, avatar, banner, h, icon, mount, roleName } from './ui.js';
import { SUPABASE_URL } from './config.supabase.js';
import { getSession, isConfigured, signOut, usernameFrom } from './supabase.js';
import { fetchProfile } from './data.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderRecords } from './views/records.js';
import { renderUsers } from './views/users.js';
import { renderAudit } from './views/audit.js';
import { renderVouchers } from './views/vouchers.js';
import { renderVoucherReports } from './views/voucher-reports.js';
import { renderSettings } from './views/settings.js';

const root = $('#app');

// `roles` limits a nav entry to the roles that can actually read the page.
// Sales reps have no audit page: their RLS policy returns no rows anyway.
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', render: renderDashboard },
  { id: 'records', label: 'Scan Records', icon: 'records', render: renderRecords },
  {
    id: 'audit',
    label: 'Deleted records',
    icon: 'trash',
    render: renderAudit,
    roles: ['admin', 'supervisor', 'team_leader'],
    // Reachable from Scan Records, not the sidebar: it is a rare lookup.
    hidden: true,
  },
  { id: 'vouchers', label: 'E-vouchers', icon: 'records', render: renderVouchers },
  {
    id: 'voucher-reports',
    label: 'Daily E-Voucher Reports',
    icon: 'dashboard',
    render: renderVoucherReports,
  },
  { id: 'users', label: 'Users & Team', icon: 'users', render: renderUsers },
  { id: 'settings', label: 'Settings', icon: 'key', render: renderSettings },
];

const LOADING = () =>
  h(
    'div',
    { class: 'content' },
    h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'Loading…')),
  );

async function start() {
  if (!isConfigured) {
    mount(
      root,
      h(
        'div',
        { class: 'panel narrow' },
        banner(
          'error',
          'VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are missing from this build. ' +
            'Set them in .env.local (local) or Project Settings â†’ Environment Variables (Vercel), then rebuild.',
        ),
        h('button', { class: 'btn', onclick: () => window.location.reload() }, 'Retry'),
      ),
    );
    return;
  }

  const session = await getSession();
  if (!session) {
    renderLogin(root, () => boot());
    return;
  }
  await boot();
}

async function boot() {
  const session = await getSession();
  if (!session) {
    renderLogin(root, () => boot());
    return;
  }

  // Show the username, not the synthetic address behind it.
  const who = usernameFrom(session?.user?.email ?? '');
  let profile = null;
  let profileError = null;
  try {
    profile = await fetchProfile();
  } catch (error) {
    profileError = error.message;
  }

  if (!profile) {
    mount(
      root,
      h(
        'div',
        { class: 'auth-wrap' },
        h(
          'div',
          { class: 'panel narrow' },
          h('h1', {}, 'Account not linked'),
          h('p', { class: 'muted' }, `Signed in as ${who}, but no profile row is linked to this account yet.`),
          h('p', { class: 'muted' }, 'An administrator must add you to Users & Team with an outlet.'),
          profileError ? banner('error', profileError) : null,
          h('button', { class: 'btn secondary block', onclick: logout }, 'Sign out'),
        ),
      ),
    );
    return;
  }

  const visibleNav = NAV.filter((n) => !n.roles || n.roles.includes(profile.role));

  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' });
  const content = h('main', { class: 'content' });
  const scrim = h('div', { class: 'scrim', hidden: true, onclick: () => closeDrawer() });

  const closeDrawer = () => {
    sidebar.classList.remove('open');
    scrim.hidden = true;
  };
  const openDrawer = () => {
    sidebar.classList.add('open');
    scrim.hidden = false;
  };

  // Which view is rendered right now, so hash navigation never re-renders the
  // page (or re-fetches) for the view that is already on screen.
  let currentView = null;

  const renderView = (view) => {
    currentView = view;
    for (const b of sidebar.querySelectorAll('button[data-view]')) {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    }
    closeDrawer();
    const entry = visibleNav.find((n) => n.id === view) ?? visibleNav[0];
    document.title = `${entry.label} · SIM Management System`;
    mount(content, h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'Loading…')));
    entry.render(content, { profile, go });
    window.scrollTo({ top: 0 });
  };

  const viewFromHash = () => (window.location.hash || '#dashboard').slice(1);
  const normalise = (view) => (visibleNav.some((n) => n.id === view) ? view : 'dashboard');

  // Navigation is URL-driven (#dashboard, #records, #users), so Back/Forward and
  // deep links work. renderView is idempotent, so any path may call it safely.
  const go = (view) => {
    const target = normalise(view);
    const hashMatches = window.location.hash === `#${target}`;
    if (target !== currentView) renderView(target);
    else closeDrawer();
    if (!hashMatches) {
      // The boot view is written with replaceState (see below) so it is a real
      // history entry that Back can return to; later navigation pushes.
      if (window.location.hash === '') window.history.replaceState(null, '', `#${target}`);
      else window.location.hash = `#${target}`;
    }
  };

  window.addEventListener('hashchange', () => {
    const v = normalise(viewFromHash());
    if (v !== currentView) renderView(v);
  });

  sidebar.append(
    h('div', { class: 'brand' }, h('span', { class: 'dot' }), 'SIM Management'),
    h(
      'div',
      { class: 'who' },
      avatar(profile.full_name, profile.username),
      h(
        'div',
        { style: { minWidth: '0' } },
        h('div', { class: 'name' }, profile.full_name || profile.username),
        h('div', { class: 'role' }, roleName(profile.role)),
        h(
          'div',
          { class: 'meta' },
          [profile.outlet_name, profile.region_name].filter(Boolean).join(' · ') || 'No outlet',
        ),
      ),
    ),
    h(
      'nav',
      { 'aria-label': 'Primary' },
      h('div', { class: 'nav-title' }, 'Workspace'),
      ...visibleNav.filter((n) => !n.hidden).map((n) =>
        h(
          'button',
          { dataset: { view: n.id }, onclick: () => go(n.id) },
          icon(n.icon, 18),
          n.label,
        ),
      ),
    ),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn secondary', onclick: logout }, icon('logout', 16, 'ico', true), 'Sign out'),
  );

  mount(
    root,
    h(
      'div',
      { class: 'shell' },
      sidebar,
      scrim,
      h(
        'div',
        {},
        h(
          'button',
          { class: 'btn secondary sm menu-btn', onclick: openDrawer, 'aria-label': 'Open menu' },
          icon('menu', 16, 'ico', true),
          'Menu',
        ),
        content,
      ),
    ),
  );

  // First paint: honour a deep link (#records), otherwise start at the
  // dashboard. The URL is normalised with replaceState so the landing view is
  // not an extra Back stop.
  // Need a second history entry so the very first Back stays inside the app.
  // A fresh page load (including sign-in) already owns one entry, so pushing
  // our own would make Back leave the app; a deep link (#users) adds an entry
  // of its own and must not get another one either.
  const bootView = normalise(viewFromHash());
  const bootHasOwnEntry = window.location.hash !== '' && window.location.hash !== `#${bootView}`;
  if (window.location.hash === '') {
    // Set the hash first: replacing on a hashless URL only rewrites the current
    // entry, while replacing an existing hash can pop it off the stack.
    window.location.hash = `#${bootView}`;
  }
  if (!bootHasOwnEntry) window.history.pushState(null, '', `#${bootView}`);
  go(bootView);

  // Note: creating a user no longer signs the new account in. Accounts are made
  // by the admin-user Edge Function with the service role, so the administrator
  // keeps their own session. (The Neon build used signUp, which did switch the
  // browser to the new user — that whole workaround is gone.)
}

async function logout() {
  // Kick off the session revocation, but NEVER block the UI on it: a slow or
  // failed request must not leave the user stuck signed in. If the sign-out
  // call really fails, the session is still live, so show the error and let
  // them reload instead of pretending they are signed out.
  const pending = signOut().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  window.location.hash = '#dashboard';
  mount(root, h('div', { class: 'auth-wrap' }, h('div', { class: 'panel narrow' }, h('p', { class: 'muted' }, 'Signing out…'))));

  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ ok: true, timedOut: true }), 8000)),
  ]);

  if (!outcome.ok) {
    mount(
      root,
      h(
        'div',
        { class: 'auth-wrap' },
        h(
          'div',
          { class: 'panel narrow' },
          banner('error', `Could not sign out: ${outcome.error?.message ?? 'unknown error'}`),
          h('button', { class: 'btn block', onclick: () => window.location.reload() }, 'Reload'),
        ),
      ),
    );
    return;
  }
  await boot();
}

document.documentElement.dataset.supabaseUrl = SUPABASE_URL;

start().catch((error) => {
  mount(root, h('div', { class: 'panel narrow' }, h('h1', {}, 'Could not start'), h('p', { class: 'error' }, error.message)));
});

export { LOADING };


