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

Two directions, and neither loses local work:

```
  push:  scan -> SQLite (instant) -> upload when online
  pull:  Supabase -> merge into SQLite (never deletes)
```

**Push** runs after each save, on app open, on resume, on reconnect, and from
"Sync now" or pull-to-refresh. The phone never deletes a server record; it only
marks its copy as sent. Re-uploading is safe because the ICCID is unique, and a
record the server already has becomes **duplicate** locally instead of being
retried forever.

**Pull** runs when the Records tab opens and on "Sync now". It reads whatever
RLS allows (own scans for a rep, the outlet for a team leader, the zone for a
supervisor) and merges by ICCID:

| Local state | Result |
| --- | --- |
| not on the phone | inserted as synced |
| already synced | the server's values win, so an office correction arrives |
| has unsent edits | the edit is kept; only the server id is linked |

Nothing is deleted by a pull, and a local record is never removed because the
server disagreed.

Deleting is possible **only before a record uploads**. Once it is on the server
the office owns it: the app hides the Delete button rather than letting the two
sides silently disagree.

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

## E-voucher (app only)

The phone totals airtime vouchers from the operator's "913" SMS messages. It is
**not** a tab: it lives in the drawer and opens a sheet.

```
913 SMS -> parse -> SQLite vouchers -> today / this month + a bar per day
```

Parsing is deliberately narrow. From

```
You received Airtime from 252710000040 - mfsuser on 22/11/2026 18:46:41,
TransactionID is ...; Amount is $+6.00. And you received commission $+0.00.
Now your balance is $+6.15.
```

only **`Amount is $+...`** is summed. The commission and balance lines are
ignored — adding either would inflate the total.

| Detail | Behaviour |
| --- | --- |
| Messages read | every message from 913 **or whose body mentions 252710000040**, still in the inbox |
| Duplicates | keyed by the SMS id, so re-reading never double-counts |
| Timestamp | taken from inside the message, which is what "today" must mean |
| Permission | `READ_SMS`, asked once when the sheet is first opened |
| Totals | today and this month; a bar per day of the current month |

`READ_SMS` is a high-trust permission: acceptable for a sideloaded APK, not
something Google Play would allow. Vouchers stay **on the phone** for now; they
are not uploaded.

```bash
flutter test          # 10 parser/summary cases, including the commission trap
```

## Daily E-Voucher Reports (website)

A separate page from the E-vouchers dashboard, built for checking a period:

- **Individual** or **Whole Team** report, over any start/end date
- every day of the range is listed, **including days with no sales** (`$0.00`)
- team rows expand to show each rep's contribution for that day
- summary cards: total amount, total vouchers, active reps, average per day
- Export to Excel, print, and PDF (via the browser's "Save as PDF")

Days come from `v_voucher_daily_local`, which converts to `Africa/Mogadishu`
before truncating — otherwise a 01:30 local voucher lands on the previous day.
Permissions are unchanged: the views are `security_invoker`, so RLS decides what
each role can see.

`scripts/schema_v14_voucher_reports.sql` must be applied.
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

### Release signing

Release builds are signed with a project keystore, not the debug key:

| File | Purpose | Committed? |
| --- | --- | --- |
| `android/app/icc-release.jks` | the signing key | **no** |
| `android/key.properties` | its passwords + alias | **no** |

`android/app/build.gradle.kts` reads `android/key.properties` and falls back to
the debug key, with a warning, only when that file is absent.

> **Back both files up somewhere you will not lose them.** Android refuses to
> install an update signed with a different key, so a lost keystore means every
> phone must uninstall first — and uninstalling deletes that phone's unsynced
> scans.
>
> ```bash
> apksigner verify --print-certs build/app/outputs/flutter-apk/app-release.apk
> ```
>
> Should read `CN=ICC Record Scanner`, not `CN=Android Debug`.

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

