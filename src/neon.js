/**
 * The single place that talks to Neon.
 *
 * Two services, both reached with the browser:
 *   auth     Managed Better Auth -> email/password sign-in, returns a session.
 *            The session is exchanged for a short-lived JWT.
 *   dataApi  PostgREST -> every query carries that JWT as a Bearer token and
 *            Postgres Row Level Security filters rows by the JWT `sub`.
 *
 * There is deliberately no database credential in the browser: the JWT plus RLS
 * is the security boundary.
 */
import { createClient } from '@neon/neon-js';
import { AUTH_URL, DATA_API_URL, isConfigured } from './config.js';

let client = null;

export function neon() {
  if (!isConfigured) {
    throw new Error('Neon is not configured. Set NEON_DATA_API_URL and NEON_AUTH_BASE_URL.');
  }
  if (!client) {
    client = createClient({
      auth: { url: AUTH_URL },
      dataApi: { url: DATA_API_URL },
    });
  }
  return client;
}

/** Current session, or null when signed out. */
export async function getSession() {
  const { data, error } = await neon().auth.getSession();
  if (error) return null;
  return data?.session ? data : null;
}

export async function signIn(email, password) {
  const { data, error } = await neon().auth.signIn.email({ email, password });
  if (error) throw new Error(error.message || 'Could not sign in.');
  return data;
}

export async function signOut() {
  const { error } = await neon().auth.signOut();
  if (error) throw new Error(error.message || 'Could not sign out.');
}

/**
 * Creates an account. This signs the *new* user in on this client, so a caller
 * creating an account for someone else must finish that user's profile and then
 * restore its own session.
 */
export async function createAccount(email, password, name) {
  const result = await neon().auth.signUp.email({ email, password, name });
  if (result.error) throw new Error(result.error.message || 'Could not create the account.');
  return result.data;
}

/**
 * Changes the signed-in user's own password. Neon Auth verifies the current
 * password, so an open session alone is not enough to change credentials.
 */
export async function changePassword({ currentPassword, newPassword }) {
  const { error } = await neon().auth.changePassword({
    currentPassword,
    newPassword,
    revokeOtherSessions: false,
  });
  if (error) {
    const message = error.message ?? String(error);
    if (/invalid password|incorrect password/i.test(message)) {
      throw new Error('Your current password is incorrect.');
    }
    throw new Error(message);
  }
}

/**
 * Asks Managed Better Auth to email a one-time password-reset code.
 *
 * There is no way for an administrator to *read* or directly set someone
 * else's password: Neon Auth stores only a hash. The reset email is the
 * supported path, and the user sets their own new password.
 */
export async function requestPasswordReset(email) {
  const { data, error } = await neon().auth.requestPasswordReset({ email });
  if (error) throw new Error(error.message || 'Could not send the reset email.');
  return data;
}

/**
 * Throws a readable Error when PostgREST returns an error object.
 * Constraint violations are translated so the UI can explain them.
 */
export function unwrap({ data, error }) {
  if (error) {
    const message = error.message ?? String(error);
    if (/duplicate key/i.test(message)) throw new Error('That email address is already registered.');
    if (/violates check constraint/i.test(message)) throw new Error('Some values are not in the expected format.');
    if (/permission denied|row-level security/i.test(message)) {
      throw new Error('Your role does not allow this action.');
    }
    throw new Error(message);
  }
  return data;
}

export { isConfigured };
