# Deploying the `admin-user` Edge Function

Project: `emyycswvbdwiqgzsdxsg` → `https://emyycswvbdwiqgzsdxsg.supabase.co`

This function is the only server-side code in the system. It exists because two
operations need the service-role credential, which must never reach a browser:

- creating a user (`auth.admin.createUser`)
- setting someone else's password (`auth.admin.updateUserById`)

Verified locally: **30/30 behavioural checks pass** (see `_tools/`).

---

## 0. One thing to get right or bootstrap will fail

Deploy with JWT verification **off**:

```bash
supabase functions deploy admin-user --no-verify-jwt
```

Why: the bootstrap call authenticates with a plain random token, not a Supabase
JWT. Supabase's gateway rejects non-JWT `Authorization` headers *before* your
code runs, so with the default (`verify_jwt = true`) every bootstrap attempt
returns `401 Invalid JWT` and the function is never reached. The function does
its own checking — it compares the token to `BOOTSTRAP_ADMIN_TOKEN`, then
verifies real JWTs itself for every other action.

---

## 1. Install and sign in (CLI path)

```powershell
# Windows
scoop install supabase

# or via npm
npm install -g supabase

supabase --version
supabase login          # opens a browser to authorise
```

`supabase login` writes a token to `%USERPROFILE%\.supabase\access-token`.
Nothing else in this project needs you to paste a secret into a chat window.

## 2. Link the project

Run from the project root (the folder containing `supabase/`):

```powershell
supabase link --project-ref emyycswvbdwiqgzsdxsg
```

## 3. Set the bootstrap secret

Pick a long random string — this is the one-time key that creates the first
admin. Do not reuse a password.

```powershell
# generate one
$token = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
$token

supabase secrets set BOOTSTRAP_ADMIN_TOKEN=$token --project-ref emyycswvbdwiqgzsdxsg
```

Keep it in a password manager. You will unset it in step 6.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — you
do **not** set them, and you should never paste the service-role key anywhere.

## 4. Deploy

```powershell
supabase functions deploy admin-user --no-verify-jwt --project-ref emyycswvbdwiqgzsdxsg
```

## 5. Verify (touches no data)

```powershell
curl "https://emyycswvbdwiqgzsdxsg.supabase.co/functions/v1/admin-user"
```

Expected:

```json
{
  "ok": true,
  "function": "admin-user",
  "hasServiceKey": true,
  "bootstrapOpen": true,
  "actions": ["bootstrap","create-user","set-password","set-active"]
}
```

- `hasServiceKey: false` → the function cannot see a service credential. Recent
  Supabase projects use `sb_secret_...` keys; the function accepts either
  `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`. If both are false, set
  one in Edge Function secrets.
- `bootstrapOpen: false` → `BOOTSTRAP_ADMIN_TOKEN` is not set. Go back to step 3.

## 6. Create the first admin

Pick an outlet id first (any outlet is fine for an admin):

```powershell
curl "https://emyycswvbdwiqgzsdxsg.supabase.co/rest/v1/outlets?select=id,name&limit=5" `
  -H "apikey: <your publishable key>"
```

That call needs a signed-in session, so it will return `[]` — use the SQL
editor instead:

```sql
select id, name from public.outlets order by name limit 5;
```

Then:

```powershell
curl -X POST "https://emyycswvbdwiqgzsdxsg.supabase.co/functions/v1/admin-user" `
  -H "Authorization: Bearer $token" `
  -H "apikey: <your publishable key>" `
  -H "Content-Type: application/json" `
  -d '{\"action\":\"bootstrap\",\"username\":\"yacquub\",\"password\":\"CHANGE-ME-8+\",\"full_name\":\"Yacquub\",\"outlet_id\":\"<outlet uuid>\"}'
```

Expect `{"ok":true,"user":{...},"message":"Administrator created..."}`.

The login is now `yacquub` with the synthetic email `yacquub@sim.local`.

## 7. Close the bootstrap door

```powershell
supabase secrets unset BOOTSTRAP_ADMIN_TOKEN --project-ref emyycswvbdwiqgzsdxsg
```

Confirm it is shut — this must now return `403 bootstrap_closed`:

```powershell
curl -X POST "https://emyycswvbdwiqgzsdxsg.supabase.co/functions/v1/admin-user" `
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" `
  -d '{\"action\":\"bootstrap\",\"username\":\"x\",\"password\":\"longenough1\"}'
```

The function also refuses bootstrap independently once any admin row exists
(`409 admin_exists`), so this is belt and braces.

---

## Dashboard-only path (no CLI)

1. **Edge Functions → admin-user → Deploy a new function**.
2. Paste `supabase/functions/admin-user/index.ts`.
3. Function settings → turn **Enforce JWT verification** **off**.
4. **Project Settings → Edge Functions → Secrets** → add `BOOTSTRAP_ADMIN_TOKEN`.
5. Call it with the `curl` commands above.

---

## What each action does

| Action | Who may call | Effect |
| --- | --- | --- |
| `bootstrap` | anyone holding `BOOTSTRAP_ADMIN_TOKEN`, only while zero admins exist | creates one admin |
| `create-user` | admin | auth user + `users` row, atomic-ish (rolls back the auth user if the row fails) |
| `set-password` | admin | `auth.admin.updateUserById` — the capability the old stack could not provide |
| `set-active` | admin | flips `users.active` **and** bans/unbans the login, so "disabled" really means disabled |

`set-active` bans in Supabase Auth (`ban_duration`) as well as flipping the
profile flag. Without the ban, a "disabled" user's password would still work
against the auth endpoint — the flag only hides them from the app.

---

## Security notes

- The **publishable key** (`sb_publishable_...`) is designed to be public. It is
  safe in the browser and in the APK.
- The **secret key** (`sb_secret_...`) and the legacy `service_role` JWT must
  never leave the function environment. Do not paste either into a chat, a
  commit, or the browser bundle.
- Username collisions are case-insensitive (`Ali` and `ali` are the same login),
  enforced by a unique index on `lower(username)` **and** a clear `409` from the
  function.
