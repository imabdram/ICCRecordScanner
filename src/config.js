/**
 * Build-time configuration, injected by Vite from the Neon-managed env vars.
 *
 * `neon deploy` / `neon env pull` write these into `.env.local`:
 *   NEON_DATA_API_URL   PostgREST endpoint (JWT protected)
 *   NEON_AUTH_BASE_URL  Managed Better Auth base URL (issues the JWT)
 *
 * The `VITE_` prefix is required for Vite to expose a variable to the browser;
 * `vite.config.js` maps the Neon names onto them so there is one source of truth.
 */
const raw = import.meta.env;

function clean(value) {
  return (value ?? '').trim().replace(/\/+$/, '');
}

// PostgREST root, e.g. https://ep-x.apirest.region.aws.neon.tech/neondb/rest/v1
export const DATA_API_URL = clean(raw.VITE_NEON_DATA_API_URL);

// Better Auth base INCLUDING the /auth suffix, e.g.
// https://ep-x.neonauth.<region>.aws.neon.tech/neondb/auth
// The auth client uses this verbatim as its baseURL, so the suffix must be kept
// (verified: stripping it makes the client call /neondb/get-session -> 404).
export const AUTH_URL = clean(raw.VITE_NEON_AUTH_URL);

export const isConfigured = DATA_API_URL !== '' && AUTH_URL !== '';
