# ICC Record Scanner

SIM card registration for Amtel field teams: an **offline-first Android app** for
scanning SIM cards, and a **website** that owns accounts and reporting.

```
        PHONE (offline-first)                  WEBSITE (online)
  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”      â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
  â”‚  sign in once                â”‚      â”‚  username + password      â”‚
  â”‚  scan -> SQLite              â”‚      â”‚  leader: create users,    â”‚
  â”‚  uploads when online         â”‚â”€â”€â”€â”€â”€â–ºâ”‚          set passwords    â”‚
  â”‚  (push-only)                 â”‚      â”‚  reports, records, edit   â”‚
  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜      â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                                      â”‚
                                            â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â–¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                                            â”‚     Supabase      â”‚
                                            â”‚ Postgres + Auth   â”‚
                                            â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

## What each side does

**The app** records. A rep signs in **once** with a username and password; the
session is stored and refreshed automatically. After that it opens straight to
the scanner and works with **no signal**: every scan is written to SQLite
immediately, then uploaded when the phone has a connection.

**The website** manages. Accounts, roles, outlets and reports live there.
Admins create users and set their passwords; team leaders manage their own
outlet; supervisors their zone.

### Sign-in is username-based

Supabase Auth only signs in with an email, so a username is mapped to an
address that never receives mail:

```
"hodan.ali"  ->  "hodan.ali@sim.local"
```

Nobody types or sees the domain. There is no self-service password reset —
an administrator sets a new password.

## Recording rules

| Field | Rule |
| --- | --- |
| ICCID | starts `89`, 18“22 digits, unique in the whole system |
| Primary number | `71` + 7 digits (9 total) |
| Backup number | 7“12 digits |

Validation exists in three places on purpose: the app (friendly message before
saving), the website (same), and the **database** (the authority — a modified
client cannot bypass it).

## Sync model

Push-only, append-only from the phone's point of view:

```
scan -> SQLite (instant)
          |
          | when online: after each save, on app open, on resume, on reconnect
          v
      Supabase -> website reports
```

- The phone **never deletes** a server record; it only marks its own copy sent.
- Re-uploading is safe: the ICCID is unique, so a duplicate is detected.
- A record the server already has is marked **duplicate** locally instead of
  being retried forever.
- Deleting is possible **only before a record uploads**. Once it is on the
  server, the office owns it — the app hides the Delete button instead of
  letting the two sides silently disagree.

## Duplicates

1. **On save** the phone checks its own table. If the ICCID is already there it
   shows when and for whom, and offers to open that record.
2. **On upload**, if another phone already registered that SIM, the database
   rejects it and the app marks the row `duplicate` with a red chip.

The app cannot say *who* holds the duplicate (a rep may only read their own
scans); an admin sees the full record on the website.

## Repository layout

| Path | What it is |
| --- | --- |
| `lib/main.dart` | The Android app (login, scanner, records, sync) |
| `src/` | Website — framework-free ES modules, built with Vite |
| `scripts/schema_v*.sql` | Database, in order (v2 base â†’ v6 numbers) |
| `supabase/functions/admin-user` | The only server-side code (user admin) |
| `tools/` | Verification harnesses and UI mockups |
| `docs/` | Architecture notes and the migration plan |

## Database

Run in the Supabase SQL editor, in this order:

1. `scripts/schema_v2_greenfield.sql` — tables, triggers, RLS, views
2. `scripts/seed_v2.sql` — 3 zones / 4 regions / 26 outlets
3. `scripts/schema_v5_login_only.sql` — removes the device/PIN model
4. `scripts/schema_v6_numbers.sql` — primary number must be `71xxxxxxx`

`schema_v3_reps.sql` and `schema_v4_filing.sql` are history: v5 removes what v3
added, and v4's filing rule is carried forward in v5's trigger. Skip v3/v4
unless you are reproducing the earlier design.

All files are safe to re-run.

## Access rules

| Role | Sees | May file a scan for |
| --- | --- | --- |
| `admin` | everything | anyone |
| `supervisor` | their zone | anyone in their zone |
| `team_leader` | their outlet | anyone in their outlet |
| `sales_rep` | only their own scans | only themselves |

Location is stamped server-side from the person the scan is attributed to —
never from the client. Two triggers enforce what policies cannot:
`scans_before_write` and `users_guard_privileges` (blocking self-escalation).

## Security model

The publishable key (`sb_publishable_...`) ships inside the APK and the browser
bundle. It therefore grants **no table access on its own** — there are no `anon`
grants at all. Every write requires a signed-in session, and RLS filters every
read.

The service-role key exists only in the `admin-user` Edge Function environment.
It must never appear in a `VITE_` variable (Vite inlines those into the bundle)
or in the app.

## Development

```bash
# website
npm install
npm run dev            # http://localhost:5173
npm run build          # -> dist/  (deployed to Vercel)

# app
flutter pub get
flutter run
flutter build apk --release
```

Website environment (`.env.local` locally, Project Settings on Vercel):

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

## Verifying changes

Both harnesses run against real software, not mocks of their own logic.

**Schema** — executes the SQL on PostgreSQL 18 (compiled to WASM):

```bash
cd tools
npm install
node validate-pg.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql
node validate-v5.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql ../scripts/schema_v5_login_only.sql
node validate-v6.mjs ../scripts/schema_v2_greenfield.sql ../scripts/seed_v2.sql ../scripts/schema_v5_login_only.sql ../scripts/schema_v6_numbers.sql
```

**Edge Function** — runs the real `index.ts` against a fake Supabase admin API:

```bash
cd tools
node stage-function.mjs ..
node node_modules/typescript/bin/tsc tools/.fnbuild/stage.ts \
  --target es2022 --module esnext --moduleResolution bundler --skipLibCheck
node test-admin-function.mjs ..
```

**Website** — static import-graph check (catches a missing module or a named
import its target does not export), plus an encoding check that catches UTF-8
text saved as CP1252 and rendering as garbled accents:

```bash
node tools/check-imports.mjs .
node tools/check-encoding.mjs .
```

**App**:

```bash
flutter analyze     # must be clean
flutter test        # validation rules
```

None of these prove Supabase accepts the exact calls; only a deployment does.

## UI mockups

`tools/mockup*.py` render the screens as PNGs (Pillow) so the layout can be
reviewed before Flutter code changes:

```bash
python tools/mockup.py           # all screens
python tools/mockup-entry.py     # new-record form
python tools/mockup-records.py   # records timeline
python tools/mockup-detail.py    # record detail, pending vs uploaded
python tools/mockup-saved.py     # post-save toast
```

## History

This project began on Neon (Lakebase Postgres + Managed Better Auth). That stack
is retired and its code removed. An intermediate design used per-phone **device
keys and PINs**; it was replaced by a normal login, which removed the anonymous
write path entirely. `docs/PLAN_SUPABASE_GREENFIELD.md` records the reasoning,
and `git log` keeps the old code.

`docs/HIERARCHY.md` and `docs/SCAN_RECORDS.md` still describe the Neon-era
tables; they are kept for the hierarchy rationale, but
`scripts/schema_v2_greenfield.sql` is authoritative.

