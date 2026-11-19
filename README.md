# ICC Record Scanner

SIM card registration for Amtel field teams: an **offline Android app** for
scanning SIM cards, and a **website** that owns all accounts and reporting.

The phone has **no login, ever**. The website owns every account. That split is
deliberate — see [Why the app has no login](#why-the-app-has-no-login).

```
       PHONE (offline, no login)              WEBSITE (online)
  ┌──────────────────────────────┐      ┌───────────────────────────┐
  │  scan SIM → SQLite           │      │  username + password      │
  │  view / search / export      │      │  admin: create users,     │
  │  upload when online          │─────►│         set passwords     │
  │  (never signs in)            │      │  user: change own password│
  └──────────────────────────────┘      └─────────────┬─────────────┘
                                                      │
                                            ┌─────────▼─────────┐
                                            │     Supabase      │
                                            │ Postgres + Auth   │
                                            └───────────────────┘
```

## Repository layout

| Path | What it is |
| --- | --- |
| `lib/` | Flutter Android app (single-file `main.dart`) |
| `src/` | Website — framework-free ES modules, built with Vite |
| `scripts/` | Database schema and seed (`*_v2_*.sql` are the live ones) |
| `supabase/` | Edge Function `admin-user` — the only server-side code |
| `tools/` | Verification harnesses (schema and function tests) |
| `docs/` | Architecture notes, hierarchy, scan storage, greenfield plan |

## Quick start

```bash
npm install                 # website dependencies
npm run dev                 # website at http://localhost:5173

flutter pub get             # app dependencies
flutter run                 # app on a connected device
```

## Database

The live schema is **`scripts/schema_v2_greenfield.sql`**, a rebuild for
Supabase. The older `scripts/schema.sql` targeted Neon/Better-Auth and is kept
only for reference.

Run order in the Supabase SQL editor:

1. `scripts/schema_v2_greenfield.sql`
2. `scripts/seed_v2.sql` — 3 zones / 4 regions / 26 outlets

Both are safe to re-run. See [`scripts/DEPLOY_V2.md`](scripts/DEPLOY_V2.md).

### Two writers, one table

`scans` accepts rows from two sources, which is why `sales_rep_id` is nullable:

- a **signed-in web user** → `sales_rep_id` set, `device_id` null
- an **unauthenticated phone** → `sales_rep_id` null, `device_id` set

Location (`outlet_id`/`region_id`/`zone_id`) is **never** taken from the client.
A trigger derives it from the authenticated user, or from the device row.

## Security model

The publishable key ships inside the APK and the browser bundle, so it grants
**no table access at all** — there are no `anon` grants in the schema. The only
two things an unauthenticated client can do:

| Function | Purpose |
| --- | --- |
| `claim_device(setup_code)` | exchange a one-time setup code for a device key |
| `upload_scans(payload)` | insert scans, authenticated by that device key |

`upload_scans` derives the outlet from the device, ignores any location in the
request, and is idempotent per ICCID — so a phone retrying its outbox never
creates duplicates. Uploads are **push-only**: the phone never deletes a local
scan because the cloud disagreed.

Row Level Security then limits reads:

| Role | Sees |
| --- | --- |
| `admin` | everything |
| `supervisor` | their zone |
| `team_leader` | their outlet |
| `sales_rep` | only their own scans |

Two triggers enforce what policies cannot express: `scans_before_write` stamps
location, and `users_guard_privileges` blocks self-escalation to admin.

## Accounts

Supabase Auth is email-first; this system is username-first. A username maps to
a synthetic address that never receives mail:

```
"yacquub"  →  "yacquub@sim.local"
```

An administrator creates users and sets passwords through the `admin-user` Edge
Function, which holds the service-role key. Users change their own password from
the browser. There is no self-service password reset, because the mailbox does
not exist — that is the accepted cost of the username scheme.

Deploy it with [`supabase/DEPLOY_ADMIN_FUNCTION.md`](supabase/DEPLOY_ADMIN_FUNCTION.md).
Note the `--no-verify-jwt` flag: bootstrap uses a random token, not a JWT, and
the gateway would otherwise reject it before the function runs.

## Why the app has no login

A phone that must authenticate cannot work in the field: no signal, shared
devices, and a password prompt per shift. Dropping login removes the session,
the token store and the biometric gate.

The cost is real and worth stating: **an unauthenticated phone cannot prove who
recorded a scan.** Scans are attributed to the outlet of the registered device,
not to a verified person. That is acceptable for recording SIM registrations,
and not acceptable for anything that must be auditable per individual.

## Verifying changes

Both harnesses run against real software, not mocks of their own logic.

**Schema** — executes both SQL files on PostgreSQL 18 (compiled to WASM) and
asserts 24 behaviours: RLS, location spoofing, idempotent re-upload, setup-code
reuse, the ICCID pattern.

```bash
cd tools
npm install @electric-sql/pglite
node validate-pg.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql
```

**Edge Function** — runs the real `index.ts` against a fake Supabase admin API
and PostgREST layer: 30 behaviours covering auth, role rules, validation,
rollback on failure, and ban-on-disable.

```bash
cd tools
npm install typescript
node stage-function.mjs ..
node node_modules/typescript/bin/tsc .fnbuild/stage.ts \
  --target es2022 --module esnext --moduleResolution bundler \
  --skipLibCheck --noEmitOnError false
node test-admin-function.mjs ..
```

Neither can prove Supabase accepts the exact API calls; only a deployment does.

## Build the APK

```bash
flutter build apk --release
```

Output: `build/app/outputs/flutter-apk/app-release.apk`.

## Requirements

- Flutter 3.19+ (Dart 3.3+) for the app
- Node 20+ for the website and the test harnesses
- A Supabase project (`eu-central-1` is closest to the users)

## History

This repository previously targeted Neon (Lakebase Postgres + Managed Better
Auth). That stack is retired; the doc `docs/PLAN_SUPABASE_GREENFIELD.md` records
the reasoning and the migration. `neon.ts`, `src/neon.js` and `scripts/schema.sql`
remain only until they are deleted.
