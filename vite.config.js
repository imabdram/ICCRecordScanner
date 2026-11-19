import { defineConfig, loadEnv } from 'vite';

/**
 * Vite config for the SIM Management System console.
 *
 * The Neon env vars are written by `neon deploy` / `neon env pull` as
 * NEON_DATA_API_URL and NEON_AUTH_BASE_URL. Vite only exposes VITE_-prefixed
 * variables to the browser, so they are mapped here instead of duplicating them.
 *
 * Note: those two URLs are public information (they are the API endpoints the
 * browser calls). No database credential or secret is exposed this way.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const dataApiUrl = env.VITE_NEON_DATA_API_URL ?? env.NEON_DATA_API_URL ?? '';
  // The SDK derives `${base}/auth` itself, so pass the branch base URL and strip
  // any trailing `/auth` from the value Neon reports (`NEON_AUTH_BASE_URL`).
  // Must include the /auth suffix: the auth client uses it verbatim as baseURL.
  const authUrl = env.VITE_NEON_AUTH_URL ?? env.NEON_AUTH_BASE_URL ?? '';

  if (mode === 'production' && (!dataApiUrl || !authUrl)) {
    console.warn(
      '\n[build] NEON_DATA_API_URL / NEON_AUTH_BASE_URL are missing. ' +
        'Run `neon deploy` first so .env.local is written; the bundle will boot to a "not configured" screen.\n',
    );
  }

  return {
    define: {
      'import.meta.env.VITE_NEON_DATA_API_URL': JSON.stringify(dataApiUrl),
      'import.meta.env.VITE_NEON_AUTH_URL': JSON.stringify(authUrl),
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    preview: {
      port: 8080,
      strictPort: true,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
