import { defineConfig, loadEnv } from 'vite';

/**
 * Vite config for the SIM Management System console.
 *
 * DEPLOYMENT (Vercel)
 *   Build command : npm run build
 *   Output        : dist
 *   Framework     : Vite (see vercel.json)
 *
 * ENVIRONMENT
 *   Only two variables matter, and both are PUBLIC:
 *     VITE_SUPABASE_URL               https://<ref>.supabase.co
 *     VITE_SUPABASE_PUBLISHABLE_KEY   sb_publishable_...
 *
 *   Vite exposes any VITE_-prefixed variable to the browser automatically, so
 *   there is no `define` mapping here (the old Neon build needed one because
 *   those variables were not VITE_-prefixed).
 *
 *   The service-role / `sb_secret_` key is NEVER referenced here. It lives only
 *   in the Edge Function environment. If it ever appears in this file or in a
 *   VITE_-prefixed variable, it is in the browser bundle and must be rotated.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const supabaseUrl = (env.VITE_SUPABASE_URL ?? '').trim();
  const supabaseKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim();

  if (!supabaseUrl || !supabaseKey) {
    console.warn(
      '\n[build] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are missing.\n' +
        '         The site will boot to a "not configured" screen.\n' +
        '         Locally: copy .env.example to .env.local. On Vercel: set them in\n' +
        '         Project Settings -> Environment Variables, then redeploy.\n',
    );
  }

  return {
    // Relative-safe defaults. Vite rewrites asset URLs against the deployment
    // origin, which is what Vercel serves from, so no `base` is required.
    build: {
      outDir: 'dist',
      sourcemap: false,
      // Keep the bundle small: the console is a handful of ES modules.
      target: 'es2020',
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    preview: {
      port: 8080,
      strictPort: true,
    },
  };
});
