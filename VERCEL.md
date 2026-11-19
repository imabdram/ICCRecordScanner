# Deploying the website to Vercel

The site is a plain Vite build (no framework, no server-side rendering), so
Vercel only needs to run `npm run build` and serve `dist`.

---

## 1. Import the repository

1. <https://vercel.com/new> → **Import Git Repository** →
   `imabdram/ICCRecordScanner`.
2. Leave **Root Directory** at the repository root. The Flutter app lives in
   `lib/` and is ignored by Vercel; `vercel.json` pins the framework to Vite so
   it is not misdetected as a Flutter/web project.
3. Framework preset, build and output are already declared in `vercel.json`:

| Setting | Value |
| --- | --- |
| Framework | Vite |
| Install command | `npm install` |
| Build command | `npm run build` |
| Output directory | `dist` |

## 2. Environment variables

Project Settings → **Environment Variables** → add both, for
Production *and* Preview:

| Name | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://emyycswvbdwiqgzsdxsg.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_VX9t2k0xjWAJDsvJgRrLXQ_K6HawBvY` |

Both are **public** — they are compiled into the browser bundle on purpose.
Security comes from Row Level Security in Postgres, not from hiding them.

`src/config.supabase.js` carries the same two values as a fallback, so a deploy
without these variables still works. Set them anyway: it makes switching
projects a configuration change rather than a code change, and it keeps the
build log honest about which project it targets.

> **Never** add `SUPABASE_SERVICE_ROLE_KEY` or an `sb_secret_...` key as a
> `VITE_`-prefixed variable. Vite inlines `VITE_*` values into the JavaScript
> bundle, which would publish the key that bypasses RLS. The service-role key
> belongs only in the Supabase Edge Function environment.

## 3. Deploy

Push to `main`; Vercel builds automatically. Every other branch gets a preview
URL.

```bash
git push origin main
```

## 4. Routing

The console uses **hash routing** (`#dashboard`, `#records`, `#users`), so
`vercel.json` needs no SPA rewrite: every URL resolves to `index.html` at `/`
and the hash is handled in the browser. This also means deep links survive a
refresh without server configuration.

If you later switch to path routing, add:

```json
"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
```

## 5. Configuration already handled

`vercel.json` sets:

- `framework: vite`, `outputDirectory: dist`
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` denying camera, microphone, geolocation
- immutable one-year caching for hashed `/assets/*`

A Content-Security-Policy is deliberately **not** set yet: the UI builds inline
`style` attributes from JavaScript, so a strict policy needs `style-src
'unsafe-inline'` at minimum and careful testing of the Supabase origins. Add it
once the Supabase data layer is live, with:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self' https://*.supabase.co wss://*.supabase.co;
```

## 6. CORS

The browser calls two different origins:

- PostgREST / Auth at `https://<ref>.supabase.co` — CORS allowed by Supabase.
- The Edge Function at `https://<ref>.supabase.co/functions/v1/admin-user` —
  the function returns its own `Access-Control-Allow-Origin: *` header, so it
  works from the Vercel domain without extra configuration.

Restricting that to your production domain is a reasonable hardening step once
the domain is fixed; it is not required for correctness because every action
authenticates with a JWT or a device key.

## 7. Custom domain

Project Settings → Domains → add your domain and follow the DNS instructions.
Nothing in the build depends on the hostname.

## 8. Verifying a deployment

- Build log must show `vite build` completing and the env-var warning **absent**.
- Open the site: it should render the sign-in screen, not "not configured".
- Sign in as the bootstrap admin created in
  `supabase/DEPLOY_ADMIN_FUNCTION.md`.

---

## Status of the data layer

`src/` now talks to Supabase (`src/supabase.js`, `src/data.js`) and no longer
references Neon — that client, its config, its scripts and its dependencies were
removed. Sign-in is username + password against `username@sim.local`.

What to verify on the first real deployment, in order:

1. Build log shows `vite build` completing **and** no missing-env warning.
2. The sign-in screen appears (not "not configured").
3. Signing in as the bootstrap admin works.
4. Users & Team can create a user — this exercises the `admin-user` Edge
   Function, which must be deployed with `--no-verify-jwt`
   (see `supabase/DEPLOY_ADMIN_FUNCTION.md`).

If step 4 fails with `401`/`403`, the function is missing, JWT verification is
still on, or `BOOTSTRAP_ADMIN_TOKEN` was never set — check the GET health
endpoint first.

### What was verified locally, and what was not

- **Verified:** every web module parses (`node --check`), and the import graph
  resolves end to end — no missing files, no named import that its target does
  not export (`node tools/check-imports.mjs .`).
- **Not verified:** the Vite build itself. Vite cannot run in this development
  sandbox because esbuild and Vite's Windows path probe both need to spawn child
  processes, which the sandbox blocks. The build must be confirmed by Vercel's
  build log, and the four checks above.
