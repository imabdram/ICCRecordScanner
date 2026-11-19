/**
 * Neon configuration for the SIM Management System.
 *
 * `neon deploy` reconciles every branch with this file.
 *
 * Services:
 *   postgres  every branch always has Postgres (DATABASE_URL, DATABASE_URL_UNPOOLED)
 *   auth      Managed Better Auth - issues the JWT that the Data API verifies
 *   dataApi   PostgREST-compatible REST API secured by that JWT + RLS
 *
 * The web console is a static SPA, so it talks to Postgres through the Data API
 * instead of holding a database credential. Row Level Security is what enforces
 * the Zone -> Region -> Outlet -> User hierarchy.
 */
import { defineConfig } from '@neon/config/v1';

// Where the SPA is served from. Override at deploy time:
//   APP_ORIGIN=https://your-host neon deploy --env .env.local
const origin = process.env.APP_ORIGIN ?? 'http://localhost:8080';

export default defineConfig({
  // Managed Better Auth lives in the `neon_auth` schema and issues the JWTs.
  auth: true,

  // PostgREST-compatible API. It requires auth to verify the JWTs, which is why
  // `auth` above is on. RLS on public.* decides what each caller can see.
  dataApi: {
    settings: {
      // JWT -> Postgres role mapping. The Data API must keep running requests as
      // the `authenticated` role, which is what the RLS policies target.
      dbSchemas: ['public'],
      jwtRoleClaimKey: '.role',
      dbAnonRole: 'anonymous',
      // No aggregate functions are needed; small surface, less to exploit.
      dbAggregatesEnabled: false,
      // Rows are paginated, but keep a server ceiling for safety.
      dbMaxRows: 5000,
      // Comma-separated origins allowed to call the API from a browser.
      serverCorsAllowedOrigins: `${origin},http://localhost:5173`,
    },
  },

  // New (non-default) branches auto-expire so preview branches clean themselves up.
  branch: (branch) => {
    if (branch.isDefault) return {};
    if (!branch.exists) return { ttl: '7d' };
    return {};
  },
});
