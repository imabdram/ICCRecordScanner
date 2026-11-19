/**
 * The single place that talks to Supabase.
 *
 * Two services, both reached from the browser:
 *   auth  Supabase Auth -> username + password sign-in, returns a session.
 *   data  PostgREST     -> every query carries the session's JWT, and Postgres
 *                          Row Level Security filters rows by it.
 *
 * There is deliberately no database credential in the browser: the JWT plus RLS
 * is the security boundary. The publishable key is public by design.
 *
 * The only thing that needs the service role is user administration, which goes
 * through the `admin-user` Edge Function (see supabase/functions/admin-user).
 */
import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  emailFor,
  isConfigured,
  usernameFrom,
} from './config.supabase.js';

export { emailFor, usernameFrom, isConfigured };

let client = null;

export function supabase() {
  if (!isConfigured) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and ' +
        'VITE_SUPABASE_PUBLISHABLE_KEY, then rebuild.',
    );
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // This is a plain SPA; there is no OAuth redirect to detect.
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

/** Current session, or null when signed out. */
export async function getSession() {
  const { data, error } = await supabase().auth.getSession();
  if (error) return null;
  return data?.session ?? null;
}

/**
 * Signs in with a username.
 *
 * Supabase Auth is email-first, so the username is mapped to a synthetic
 * address that never receives mail: "yacquub" -> "yacquub@sim.local".
 */
export async function signIn(username, password) {
  const email = emailFor(username);
  if (!username || !email) throw new Error('Enter your username.');

  const { data, error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) {
    const m = error.message ?? '';
    if (/invalid login credentials/i.test(m)) {
      throw new Error('That username and password do not match.');
    }
    if (/email not confirmed/i.test(m)) {
      // Should not happen: admin-created accounts are confirmed immediately.
      throw new Error('This account is not confirmed. Ask an administrator to reset it.');
    }
    throw new Error(m);
  }
  return data;
}

export async function signOut() {
  const { error } = await supabase().auth.signOut();
  if (error) throw new Error(error.message || 'Could not sign out.');
}

/**
 * Changes the signed-in user's own password.
 *
 * Supabase's updateUser() does not verify the current password, so we verify it
 * ourselves by re-authenticating first. That check happens against the auth
 * server, not in the browser — a modified client cannot skip it by lying.
 *
 * Returns nothing; throws a readable Error on failure.
 */
export async function changeOwnPassword({ currentPassword, newPassword }) {
  const { data: sessionData } = await supabase().auth.getSession();
  const email = sessionData?.session?.user?.email;
  if (!email) throw new Error('You are not signed in.');

  const { error: verifyError } = await supabase().auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (verifyError) {
    if (/invalid login credentials/i.test(verifyError.message ?? '')) {
      throw new Error('Your current password is incorrect.');
    }
    throw new Error(verifyError.message);
  }

  const { error } = await supabase().auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message || 'Could not change the password.');
}

/**
 * Calls the admin-user Edge Function.
 *
 * The session JWT is forwarded so the function can verify the caller is an
 * admin. The service-role key never leaves the function.
 */
export async function callAdmin(action, payload = {}) {
  const session = await getSession();
  if (!session) throw new Error('You are not signed in.');

  const response = await fetch(`${SUPABASE_URL}/functions/v1/admin-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON response (gateway error page) — fall through to status handling.
  }

  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error ?? `Request failed (${response.status}).`);
  }
  return body;
}

/**
 * Throws a readable Error for a PostgREST failure.
 * Constraint violations are translated so the UI can explain them.
 */
export function unwrap({ data, error }) {
  if (error) {
    const message = error.message ?? String(error);
    if (/duplicate key/i.test(message)) {
      throw new Error('That value already exists.');
    }
    if (/violates check constraint/i.test(message)) {
      throw new Error('Some values are not in the expected format.');
    }
    if (/permission denied|row-level security|policy/i.test(message)) {
      throw new Error('Your role does not allow this action.');
    }
    throw new Error(message);
  }
  return data;
}
