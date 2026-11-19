# Hierarchy: Zone → Region → Outlet → User

This document describes the organisational structure the app models, how it is
stored in Postgres, and the access rules that follow from it.

The rule is simple:

> **A user belongs to exactly one outlet. The outlet determines their region and
> their zone.** Everything a person can see is derived from that one link.

---

## 1. The structure

```
Zone            (3)
 └── Region     (4)      belongs to one Zone
      └── Outlet (26)    belongs to one Region
           └── User      belongs to one Outlet
                └── Scan one row per registered SIM
```

| Level  | Table     | Parent column | Uniqueness                |
| ------ | --------- | ------------- | ------------------------- |
| Zone   | `zones`   | —             | `name`                    |
| Region | `regions` | `zone_id`     | `(zone_id, name)`         |
| Outlet | `outlets` | `region_id`   | `(region_id, name)`       |
| User   | `users`   | `outlet_id`   | `username` (login email)  |

Every link is `ON DELETE RESTRICT` — a region with outlets (or an outlet with
users) cannot be deleted out from under its children.

### Users have one extra link

A sales rep also reports to a **team leader**, via `users.team_leader_id`
(self-reference, `ON DELETE SET NULL`). That relationship sits *beside* the
outlet chain, not inside it: it does not change what a rep can see, it decides
who manages them.

```
Sales Rep ──reports to──► Team Leader ──belongs to──► Outlet ──► Region ──► Zone
```

---

## 2. What exists right now

Zones 1 and 3 exist but have no regions yet. All operating regions are in
Zone 2.

| Zone   | Region        | Outlets | Users |
| ------ | ------------- | ------: | ----: |
| Zone 1 | —             |       0 |     0 |
| Zone 2 | Bari Region   |       5 |     9 |
| Zone 2 | Mudug Region  |      13 |     0 |
| Zone 2 | Nugaal Region |       7 |     0 |
| Zone 2 | Sool Region   |       1 |     0 |
| Zone 3 | —             |       0 |     0 |

### Outlets by region

**Bari Region** (5)
- Alla-aamin Qardho — 4 users
- Amalbank HQI Bosaso — 1 user
- Amalbank Qardho
- Amalbank-Jubba-Bosaso
- Customer care Bosaso — 4 users

**Mudug Region** (13)
- Galkacyo HQ
- Galkacyo Golden plaza
- Galkacyo Isbarriije
- Galdogobl
- Bacaadweyn
- Xarfo
- Cagaaran
- Buraalax
- Ballibusle
- Jarriiban
- Garacad
- Daarusaalam
- Galkaio_Wadajir

**Nugaal Region** (7)
- Opec
- Amal HQ
- Inji
- Amtel Buurtinle
- Dangoroyo
- Jalam
- Amtel_Nugaal

**Sool Region** (1)
- Laascaano

---

## 3. Roles and what each can see

Visibility is computed from the user's outlet — **never** entered by hand.

| Role         | Scope                          | Sees                                                  |
| ------------ | ------------------------------ | ----------------------------------------------------- |
| `admin`      | everything                     | all zones, regions, outlets, users and scans          |
| `supervisor` | their **zone**                 | every outlet and user in the zone their outlet is in  |
| `team_leader`| their **outlet**               | every rep and scan in their own outlet                |
| `sales_rep`  | their **own work**             | only the scans they recorded; their outlet's team list |

### Who may change what

| Action                          | admin | supervisor | team_leader | sales_rep |
| ------------------------------- | :---: | :--------: | :---------: | :-------: |
| Create users                    |  ✅   |     ✅     | ✅ reps only |    —      |
| Edit name / phone / status      |  ✅   |     ✅     | ✅ own reps |    —      |
| Change a role                   |  ✅   |     ✅     |      —      |    —      |
| Move someone to another outlet  |  ✅   |     ✅     |      —      |    —      |
| Record a scan                   | any   |   anyone   | own outlet  |   only self |
| Change own role                 |  —    |     —      |      —      |    —      |

Two database triggers enforce the parts a policy cannot express:

- **`scans_before_write`** — stamps `outlet_id`, `region_id` and `zone_id` on a
  scan from the signed-in rep, so a phone cannot claim another outlet.
- **`users_guard_privileges`** — blocks self-escalation (nobody can change their
  own role/outlet/leader), and stops a non-admin touching an admin.

---

## 4. Where the structure lives

### In Postgres (source of truth)

```
zones(id, name, created_at)
regions(id, name, zone_id → zones.id)
outlets(id, name, region_id → regions.id)
users(id, auth_user_id, username, full_name, phone, role,
      outlet_id → outlets.id, team_leader_id → users.id, active, created_at)
```

Derived views used by the web console and the Android app:

| View                | Gives                                                        |
| ------------------- | ------------------------------------------------------------ |
| `v_my_profile`      | the signed-in user's outlet / region / zone names            |
| `v_rep_scan_counts` | per rep: `scans_today`, `scans_total` (the dashboard)        |
| `v_scan_records`    | scans with rep, outlet, region and zone attached             |

### On the phone

The Android app keeps only its own scans locally, in SQLite table `records`
(`icc_id` unique, `sync_status` pending/synced). It stores **no** zones,
regions or outlets — those are read from Postgres on login.

---

## 5. Why the hierarchy is denormalised onto scans

`scans` carries `outlet_id`, `region_id` and `zone_id` even though they could be
reached through `sales_rep_id`. This is deliberate:

- **History stays truthful.** If a rep moves outlets, their past scans still
  report against the outlet where the SIM was actually registered.
- **Reports are cheap.** "Scans per region" is one indexed column, not a chain
  of joins on every dashboard load.

The values are filled by the `scans_before_write` trigger, never by the client.

---

## 6. Adding to the tree

Order matters — each row needs its parent:

```sql
-- 1. a region inside a zone
insert into public.regions (name, zone_id)
select 'Bari Region', id from public.zones where name = 'Zone 2';

-- 2. an outlet inside that region
insert into public.outlets (name, region_id)
select 'New Outlet', id from public.regions
where name = 'Bari Region';

-- 3. put a user in that outlet (this is what sets their region and zone)
update public.users
   set outlet_id = (select id from public.outlets where name = 'New Outlet')
 where username = 'someone@example.com';
```

Seed data for the current tree is in [`seed.sql`](../scripts/seed.sql); the full
schema, triggers and row-level policies are in
[`schema.sql`](../scripts/schema.sql) — both are safe to re-run.
