# Deploying the greenfield schema to Supabase

Two files do everything:

| File | Purpose |
| --- | --- |
| `scripts/schema_v2_greenfield.sql` | Tables, triggers, RLS policies, views, functions |
| `scripts/seed_v2.sql` | The 3 zones / 4 regions / 26 outlets |

Both are **safe to re-run** (verified by executing each twice against PostgreSQL 18).

---

## 1. Create the Supabase project

Dashboard → New project. Region **eu-central-1 (Frankfurt)** is the closest to Somalia.

Wait for provisioning to finish before running SQL.

## 2. Run the SQL

Dashboard → **SQL Editor** → New query → paste the **entire** `schema_v2_greenfield.sql` → **Run**.

Expected output ends with:

```
Greenfield schema OK: 6 tables, 3 views, 11 functions, RLS enabled.
```

Then paste the whole of `seed_v2.sql` → **Run**. Expected:

```
Seeded: 3 zones, 4 regions, 26 outlets
```

> If the schema run fails, the last block is a self-check that names exactly
> which objects are missing. Nothing partially applied should surprise you:
> every statement is `create ... if not exists` or `create or replace`.

## 3. Create the first admin

There is deliberately no way to sign in yet — no user rows exist. The Edge
Function `admin-user` (step 3 of the build order, not yet written) creates both
the auth account and the `users` row.

Until that exists, the bootstrap path is documented in section 2 of
`seed_v2.sql`. **Do not** insert into `auth.users` by hand: Supabase's auth
schema expects specific column formats (`confirmation_token` must be `''`, not
`NULL`), and a raw insert produces login failures that are painful to trace.

## 4. What is different from the plan draft

The plan's section 2 was a simplification. These are the corrections, each
verified by a behavioural test:

| # | Change | Why |
| --- | --- | --- |
| 1 | `scans.sales_rep_id` is **nullable**; `scans.device_id` added | The plan had `NOT NULL` while section 6 required anonymous phone inserts. The two were incompatible. |
| 2 | `devices` table + `claim_device()` / `upload_scans()` | Replaces "a narrow RLS policy allowing anonymous inserts". A public anon key inside an APK + an INSERT policy = anyone can write any row. A per-device secret is the only thing RLS cannot do. |
| 3 | `ICCID` regex widened to `^89[0-9]{16,20}$` | Was `^892526379[0-9]{11}$` — a literal batch prefix. A new SIM batch would make **every** insert fail with a constraint error. |
| 4 | Users **write policy** restored | The plan dropped it. Without it, a team leader can no longer create their own reps — a capability regression, not a security win. |
| 5 | `delete_user()` restored | Scans are `ON DELETE RESTRICT`, so the function that removes a person *and* their scans together is load-bearing. |
| 6 | Team-leader scope guarded by zone | Was missing, allowing a cross-zone outlet assignment by a team leader. |
| 7 | `users_guard_privileges` DELETE branch tightened | Previously a supervisor could delete an admin. |
| 8 | Location is never taken from the client | `upload_scans()` derives outlet/region/zone from the `devices` row. Verified by smuggling `outlet_id` in the payload — it is ignored. |
| 9 | `v_scan_records` reports both sources | Adds `device_label` and `source` (`'user'` / `'device'`) so phone scans are visible without a rep name. |

## 5. Security model, in one paragraph

The **anon key is public** — it ships inside the APK. It therefore grants
nothing on any table in this schema: there are no `anon` table grants at all.
The only two things an unauthenticated client can do are call `claim_device()`
(exchange a short one-time setup code for a device key, once) and
`upload_scans()` (validate a device key, then insert with location derived
server-side). Everything else requires a signed-in session, and RLS filters
rows by role and zone.

## 6. Verifying an existing deployment

`_tools/validate-pg.mjs` executes both SQL files against a real PostgreSQL
(compiled to WASM via PGlite) and runs 24 behavioural assertions — RLS
behaviour, the ownership constraint, idempotent re-upload, location
spoofing, setup-code reuse, and the ICCID pattern.

```powershell
cd _tools
$env:npm_config_cache = "$PWD\.npm-cache"   # keep the cache inside the workspace
npm install @electric-sql/pglite
node validate-pg.mjs ..\..\scripts\schema_v2_greenfield.sql ..\..\scripts\seed_v2.sql
```

Adjust the relative paths if you copy `_tools` elsewhere. Last run:
**24/24 passed** on PostgreSQL 18.6.
