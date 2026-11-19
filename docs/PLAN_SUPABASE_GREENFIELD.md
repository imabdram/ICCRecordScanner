# Greenfield plan: offline app + Supabase website

Start from zero. The phone app becomes **offline-only with no login**. The
website owns all accounts: **username + password**, admins create users and set
their passwords, anyone can change their own.

This is intentionally a clean break from the current Neon/Better-Auth stack.
Nothing from it is required except the UI code you already like.

---

## 1. The shape of the new system

```
        PHONE (offline, no login)                 WEBSITE (online)
   ┌──────────────────────────────┐        ┌───────────────────────────┐
   │  scan SIM → SQLite           │        │  username + password      │
   │  view / search / export      │        │  admin: create users,     │
   │  optional: sync when online  │───────►│         set passwords     │
   │  (no sign-in ever)           │ upload │  user: change own password│
   └──────────────────────────────┘        └───────────┬───────────────┘
                                                       │
                                              ┌────────▼────────┐
                                              │    Supabase     │
                                              │  Postgres +     │
                                              │  Auth (admin)   │
                                              └─────────────────┘
```

Two decisions to make up front, because everything else follows:

| Decision | Option A | Option B |
| --- | --- | --- |
| **Who gets app data into the website?** | Sync when online (recommended) | Nothing — app is a standalone recorder, export by file |
| **How are app scans attributed to a person?** | Rep picks their own name once, stored locally | Nobody — scans are anonymous |

The rest of this plan assumes **A: optional online sync**, because a field
supervisor will eventually want to see the scans. If you truly want the app fully
standalone, skip section 6.

---

## 2. Database: Supabase schema

Supabase gives you Postgres, so the good parts of the current design carry over.
Keep the hierarchy — it is what makes "supervisor sees their region" possible.

```sql
-- 1. Organisation tree
create table zones (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table regions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  zone_id    uuid not null references zones(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (zone_id, name)
);

create table outlets (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  region_id  uuid not null references regions(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (region_id, name)
);

-- 2. People. auth_user_id links to Supabase's auth.users.
create table users (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid not null unique references auth.users(id) on delete cascade,
  username       text not null unique,          -- the login
  full_name      text not null default '',
  phone          text not null default '',
  role           text not null default 'sales_rep'
                 check (role in ('admin','supervisor','team_leader','sales_rep')),
  outlet_id      uuid references outlets(id) on delete restrict,
  team_leader_id uuid references users(id) on delete set null,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- 3. Scans
create table scans (
  id               uuid primary key default gen_random_uuid(),
  iccid            text not null unique check (iccid ~ '^892526379[0-9]{11}$'),
  customer_name    text not null,
  primary_number   text not null check (primary_number ~ '^[0-9]{10}$'),
  secondary_number text not null check (secondary_number ~ '^[0-9]{10}$'),
  sales_rep_id     uuid not null references users(id) on delete restrict,
  outlet_id        uuid not null references outlets(id) on delete restrict,
  region_id        uuid not null references regions(id) on delete restrict,
  zone_id          uuid not null references zones(id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index scans_rep_created    on scans (sales_rep_id, created_at desc);
create index scans_outlet_created on scans (outlet_id, created_at desc);
create index scans_region_created on scans (region_id, created_at desc);
create index scans_zone_created   on scans (zone_id, created_at desc);
```

### Seed the tree you already have

Copy the 3 zones / 4 regions / 26 outlets from the current `seed.sql` — it is
plain `insert ... select` SQL and runs unchanged on Supabase.

---

## 3. Auth model: username + password

Supabase Auth is email-first, and its client only signs in with an email. There
are two workable approaches (both described in the
[community answer](https://stackoverflow.com/questions/78550922/how-do-i-authorise-users-with-username-in-supabase)):

**Option A — synthetic email (simplest).** The login form takes a username and
the code appends a fixed suffix before calling Supabase:

```
username "yacquub"  →  email "yacquub@sim.local"
```

`sim.local` never receives mail — fine because **you never rely on email**. No
server logic is needed for login itself, only for admin actions.

**Option B — lookup function (real emails).** A `login` Edge Function takes
`{identifier, password}`, finds the username in `profiles`, resolves its email via
the service role, calls `signInWithPassword`, and returns the session tokens for
the browser to install with
`supabase.auth.setSession({ access_token, refresh_token })`. Real emails, but one
more function and an extra round trip.

**Recommendation: Option A** — less code, nothing to break, and the email is never
exposed or relied upon.

### Creating a user (admin action)

Must run **server-side** with the service-role key, never from the browser:

1. `supabase.auth.admin.createUser({ email, password, email_confirm: true })`
   → returns the auth user id
2. insert `users` row with `auth_user_id`, `username`, `role`, `outlet_id`

### Setting someone's password (admin action)

`supabase.auth.admin.updateUserById(authUserId, { password })` — this is the one
capability you asked for that the old stack could not do. It works because the
admin call uses the service role, not the user's own session.

### Changing your own password

`supabase.auth.updateUser({ password })` from the browser — the user is already
signed in, no old password needed (or require it client-side before allowing the
call).

### Why a small server is still needed

The service-role key must never reach a browser. Two functions are enough:

| Endpoint | Does |
| --- | --- |
| `POST /admin/users` | create auth user + `users` row (checks caller is admin) |
| `POST /admin/users/:id/password` | set password (checks caller is admin) |

On Supabase these run as **Edge Functions**. Nothing else needs a server.

---

## 4. Access rules (keep these — they are the good part)

Same shape as today, rewritten against Supabase's `auth.uid()`:

```sql
alter table users enable row level security;
alter table scans enable row level security;

-- helper: the caller's profile row
create function my_profile() returns users
language sql stable security definer set search_path = public as $$
  select * from users where auth_user_id = auth.uid() and active limit 1;
$$;

-- reads
create policy scans_read on scans for select to authenticated using (
  public.my_role_is_any('admin')
  or (public.my_role() = 'supervisor' and zone_id   = public.my_zone_id())
  or (public.my_role() = 'team_leader' and outlet_id = public.my_outlet_id())
  or sales_rep_id = (select id from my_profile())
);

-- writes: a scan's owner/location are stamped server-side, never trusted
create policy scans_insert on scans for insert to authenticated
  with check (sales_rep_id = (select id from my_profile()));
```

Carry over the two triggers, because they solved real problems:

- **`scans_before_write`** — fills `outlet_id` / `region_id` / `zone_id` from the
  signed-in rep, so a modified client cannot file a scan into another outlet.
- **`users_guard_privileges`** — stops anyone editing their own role, and stops
  non-admins touching admins. (Without it, a rep could escalate — we proved that
  the hard way.)

---

## 5. Website scope

Deliberately small — this is the "simple website" you asked for:

| Page | Contents |
| --- | --- |
| **Login** | username + password |
| **Dashboard** | scans today / total, scans per rep |
| **Scan records** | table + search + CSV export |
| **Users** | list; create user (name, username, role, outlet, team leader, password); set password; enable/disable |
| **Settings** | change my own password |

Stack: **Vite + plain JS (what you have)** or Next.js. Reuse `src/ui.js` and
`src/style.css` — the design is already written.

---

## 6. The app: offline, no login

The phone becomes a standalone recorder. This *removes* work rather than adding
it — no login screen, no session, no token storage.

**Keep:** `mobile_scanner` capture, the SQLite `records` table, records list,
search, share, XLSX export.

**Remove:** `BiometricGate`, `LoginPage`, `SessionStore`, `NeonBackend`,
`flutter_secure_storage`, the 60-second sync timer.

**Add (once, no account):**

1. **First-run setup screen** — pick outlet (Region → Outlet cascade); stored in
   `SharedPreferences`. This is "who am I for reporting" without being a login.
2. **A local `device_id`** (uuid) so uploads can be traced to a phone, not a user.
3. **Settings → Sync** (optional): when online, upload unsynced scans to
   Supabase using an **anon key + a narrow RLS policy** that allows inserts of
   anonymous scans, or a simple `sync-key` you distribute.

> **Security note:** an unauthenticated app cannot prove who recorded a scan.
> Scans will be attributed to the *outlet chosen on the phone*, not to a verified
> person. That is the cost of "no login" — acceptable for recording, not for
> anything that must be auditable per person.

---

## 7. Build order

Each step ends with something that works.

| # | Step | Done when |
| --- | --- | --- |
| 1 | Create the Supabase project (pick region near Somalia: `eu-central-1`) | project reachable |
| 2 | Run schema + seed SQL in the SQL editor | 3 zones, 4 regions, 26 outlets exist |
| 3 | Edge Functions: create-user, set-password (service role) | curl creates a login |
| 4 | Website: login page (username → `@sim.local`) | you can sign in |
| 5 | Website: Users page (create user, set password, disable) | you create a rep end-to-end |
| 6 | Website: dashboard + records + CSV | counts match the DB |
| 7 | Website: Settings → change my password | old password stops working |
| 8 | App: strip auth, add setup screen + local device id | app opens straight to Scan |
| 9 | App: scan, save, list, export with no network | airplane mode test passes |
| 10 | *(optional)* App → Supabase sync | a phone scan appears on the dashboard |

Steps 1–7 give you a working admin system before the app changes at all. If you
have a real deadline, ship that first.

---

## 8. Decisions I need from you

1. **Sync or no sync?** Without it the app is a recorder and the website only
   holds what the website creates. With it you get your current behaviour back.
2. **Do reps pick a name on the phone?** If yes, the dashboard can show "scanned
   by Ali" even without login — but anyone can pick any name. If no, scans show a
   device id only.
3. **Region:** `eu-central-1` (Frankfurt) is the closest to your users.
   `aws-us-east-1` is cheaper latency-wise only if hosting is there.
4. **Starting clean?** You said "start from 0". Confirm you do **not** want the
   current 5 scans / 9 users migrated. If you do, it is a `pg_dump` + CSV import,
   about an extra session.

---

## 9. What I'd flag before you commit

- **"No login" is a permanent decision.** Adding it later means reworking the app
  again — the current app spent this whole session on auth.
- **Supabase's synthetic-email scheme is a workaround.** It works, but if you ever
  want password-reset emails or 2FA, you outgrow it.
- **Keep the two triggers.** They fixed real, demonstrated bugs (a rep could
  previously promote themselves to admin).
- **Reuse, don't rewrite, the web UI.** `src/` is framework-free plain JS; only
  the data layer (`neon.js`, `data.js`) needs replacing with a Supabase client.

---

## Sources

- Supabase Auth admin API: `auth.admin.createUser`, `auth.admin.updateUserById`
- Supabase Row Level Security with `auth.uid()`
- Current schema to port: [`scripts/schema.sql`](../scripts/schema.sql) ·
  hierarchy reference: [`docs/HIERARCHY.md`](HIERARCHY.md) ·
  scan storage: [`docs/SCAN_RECORDS.md`](SCAN_RECORDS.md)
