/**
 * Supabase configuration for the website.
 *
 * These two values are PUBLIC by design:
 *   - the URL is the project endpoint
 *   - an `sb_publishable_...` key is meant to ship in a browser bundle
 *
 * Security comes from Row Level Security in Postgres, not from hiding these.
 * The matching SECRET key (`sb_secret_...`) must never appear in this file,
 * in the browser, or in the APK. It lives only in Edge Function secrets.
 *
 * The phone app does NOT use this file, and does not use supabase_flutter.
 * It is offline-first: no login, no session, no auth library. When it does
 * upload, it calls the `upload_scans` RPC with a device key over plain HTTPS.
 */

export const SUPABASE_URL = 'https://emyycswvbdwiqgzsdxsg.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_VX9t2k0xjWAJDsvJgRrLXQ_K6HawBvY';

/**
 * Supabase Auth is email-first, but this system is username-first.
 * A username is mapped to a synthetic address that never receives mail.
 *
 *   "yacquub"  ->  "yacquub@sim.local"
 *
 * This is why no email is ever shown to a user, and why self-service password
 * reset is not offered: the mailbox does not exist. An administrator sets
 * passwords instead (Edge Function `admin-user`, action `set-password`).
 */
export const USERNAME_EMAIL_DOMAIN = 'sim.local';

/** The synthetic email the auth service stores for a username. */
export function emailFor(username) {
  const u = String(username ?? '').trim().toLowerCase();
  return `${u}@${USERNAME_EMAIL_DOMAIN}`;
}

/**
 * The inverse, for display. Returns the username part of a synthetic address,
 * and passes anything else through unchanged.
 */
export function usernameFrom(email) {
  const e = String(email ?? '');
  const suffix = `@${USERNAME_EMAIL_DOMAIN}`;
  return e.endsWith(suffix) ? e.slice(0, -suffix.length) : e;
}

/** True when both values are present, so the UI can show a setup error early. */
export const isConfigured = SUPABASE_URL !== '' && SUPABASE_PUBLISHABLE_KEY !== '';
