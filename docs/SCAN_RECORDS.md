# Scan records: where they are stored

A scan record (one registered SIM) is stored in **two places**, for two different
reasons:

| Where | Table | Holds | Why |
| --- | --- | --- | --- |
| **Phone** (Android app) | SQLite `records` | only the scans *that phone* recorded | works with no signal; survives app restarts |
| **Cloud** (Neon Postgres) | `public.scans` | every scan, from every rep | the website dashboard, reporting and history |

The phone is a **cache + outbox**, not a second source of truth. Postgres wins
whenever the two disagree.

```
  Sales rep scans a SIM
          │
          ▼
  mobile_scanner reads the ICCID  (must match ^892526379\d{11}$)
          │
          ▼
  ┌───────────────────────┐   insert (sync_status = 'pending')
  │  SQLite  records      │ ◄──────────────────────────────
  └───────────┬───────────┘
              │  CloudScanSync pushes pending rows
              ▼
  POST /scans ─────────────►  ┌──────────────────────┐
                              │  Postgres  scans     │
                              └──────────┬───────────┘
                                         │ RLS-filtered read
                                         ▼
                                  website dashboard
```

---

## 1. Cloud table: `public.scans`

| Column | Type | Constraint |
| --- | --- | --- |
| `id` | uuid | PK, `gen_random_uuid()` |
| `iccid` | text | **UNIQUE** · `CHECK (iccid ~ '^892526379[0-9]{11}$')` |
| `customer_name` | text | NOT NULL |
| `primary_number` | text | NOT NULL · `CHECK (^[0-9]{10}$)` |
| `secondary_number` | text | NOT NULL · `CHECK (^[0-9]{10}$)` |
| `sales_rep_id` | uuid | NOT NULL → `users(id)` |
| `outlet_id` | uuid | NOT NULL → `outlets(id)` |
| `region_id` | uuid | NOT NULL → `regions(id)` |
| `zone_id` | uuid | NOT NULL → `zones(id)` |
| `created_at` | timestamptz | NOT NULL, default `now()` |
| `updated_at` | timestamptz | NOT NULL, default `now()` |

Every foreign key is `ON DELETE RESTRICT`: a rep who has scans cannot be deleted
out from under their own history.

### Indexes

| Index | Purpose |
| --- | --- |
| `scans_pkey` | primary key |
| `scans_iccid_key` | uniqueness → **one SIM cannot be registered twice** |
| `scans_rep_created_idx` | `(sales_rep_id, created_at DESC)` — "my scans" |
| `scans_outlet_created_idx` | `(outlet_id, created_at DESC)` — team leader's outlet |
| `scans_region_created_idx` | `(region_id, created_at DESC)` — supervisor's region |
| `scans_zone_created_idx` | `(zone_id, created_at DESC)` — zone reporting |

### Why location is copied onto the scan

`outlet_id` / `region_id` / `zone_id` are redundant — they could be reached via
`sales_rep_id`. They are copied on purpose:

- **History stays true.** Move a rep to another outlet and their old scans still
  count against the outlet where the SIM was actually sold.
- **Reporting is one column, not a chain of joins.**

They are filled by the `scans_before_write` trigger from the **signed-in rep**,
never from the request body (`new.outlet_id := my_outlet.id`) — so a modified
phone cannot file a scan into another outlet. This was verified by sending a
forged `outlet_id`: it was ignored.

---

## 2. Phone table: `records` (SQLite)

File `icc_records.db`, schema version 3.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER | PK autoincrement |
| `icc_id` | TEXT | NOT NULL **UNIQUE** — the offline duplicate check |
| `full_name` | TEXT | NOT NULL |
| `primary_number` | TEXT | NOT NULL |
| `secondary_number` | TEXT | NOT NULL |
| `created_at` | TEXT | NOT NULL, ISO-8601 string |
| `sync_status` | TEXT | NOT NULL, default `'pending'` |

Index: `idx_records_created_at (created_at DESC)`.

`sync_status` drives the outbox:

| Status | Meaning |
| --- | --- |
| `pending` | saved on the phone, not yet confirmed by the server |
| `synced` | the server has it |
| `failed` | last upload attempt failed; retried on the next sync |

Matching between the two tables is by `icc_id`, so a record pulled down from the
server updates the existing row rather than creating a duplicate.

### Migrations

Version 2 added the date index; version 3 added `sync_status`. Older installs
upgrade in place — scans are never discarded.

---

## 3. How the two stay in step (`CloudScanSync`)

**Push.** On sign-in, every 60 seconds while signed in, and on "Sync now", the
app pushes rows with `sync_status != 'synced'`:
- success → mark `synced`
- duplicate ICCID (HTTP 409) → the row is already on the server, so mark `synced`
- network error → leave it pending and retry later

**Pull.** The app then reads the server's view of its scans and mirrors it into
SQLite: changed rows are updated, new ones inserted, and **local rows the server
no longer returns are deleted** — so a deletion made in the cloud disappears from
the phone too.

**Conflict rule.** The ICCID is the shared key, which is why re-uploading a row
is a safe no-op rather than a duplicated SIM.

---

## 4. What a rep can see

Reads are filtered by row-level security, so the same query returns different
rows per person:

| Role | Sees |
| --- | --- |
| `sales_rep` | only scans where `sales_rep_id` is them |
| `team_leader` | every scan in their outlet |
| `supervisor` | every scan in their zone |
| `admin` | everything |

The website and the app both read through **views**, so these rules apply even
though the query looks the same for everyone:

| View | Returns |
| --- | --- |
| `v_scan_records` | scan + rep name + outlet + region + zone (Scan Records page, CSV) |
| `v_rep_scan_counts` | per-rep `scans_today` / `scans_total` (the dashboard) |

---

## 5. Current contents

5 scans, all recorded 2026-11-12, all in Bari Region / Zone 2:

| ICCID | Customer | Rep | Outlet |
| --- | --- | --- | --- |
| 89252637990000000006 | Customer 6 | Abdi Sales Rep | Alla-aamin Qardho |
| 89252637990000000005 | Customer 5 | Hodan Sales Rep | Customer care Bosaso |
| 89252637990000000004 | Customer 4 | Hodan Sales Rep | Customer care Bosaso |
| 89252637990000000003 | Customer 3 | Ali Sales Rep | Customer care Bosaso |
| 89252637990000000002 | Customer 2 | Ali Sales Rep | Customer care Bosaso |

Per-rep totals: Ali 2 · Hodan 2 · Abdi 1 · team leaders and admin 0.

---

## 6. Rules worth knowing

- **One SIM, one record.** The unique `iccid` is enforced in both databases. This
  is also why a rep cannot accidentally register the same card twice.
- **Location cannot be faked.** It is stamped server-side from the signed-in rep;
  only customer fields (name, phone numbers) can be corrected afterwards.
- **Deleting from the phone is local only.** The app can delete selected records
  (Records → select → Delete), but that removes them **from the phone's SQLite
  only** — the cloud row stays, and the next pull puts the record back. To
  actually delete a scan, remove it in the cloud; the phone then drops it on the
  next sync.
- **Scans block deletion of a user.** Because `sales_rep_id` is ON DELETE
  RESTRICT, removing a rep who has scans would orphan their history — which is
  why the console offers **edit**, not delete.

Schema: [`scripts/schema.sql`](../scripts/schema.sql) (table, trigger, RLS, views).
