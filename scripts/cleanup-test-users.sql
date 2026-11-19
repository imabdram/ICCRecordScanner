-- =============================================================================
-- Removes accounts left behind by e2e / debug runs.
--
-- Deleting from public.users does NOT delete the auth identity, so those emails
-- would still be able to sign in (and would hit the "Account not linked" screen).
-- This clears both sides. Demo accounts are untouched.
--
-- Run:  node scripts/db.mjs sql-file scripts/cleanup-test-users.sql
-- =============================================================================
begin;

-- Test profiles. Their scans must go first (scans.sales_rep_id is RESTRICT).
delete from public.scans
 where sales_rep_id in (
   select id from public.users
    where username like 'e2e.%' or username like 'debug.%' or username like 'forged.%'
 );

delete from public.users
 where username like 'e2e.%' or username like 'debug.%' or username like 'forged.%';

-- Their Neon Auth identities, sessions and credentials.
delete from neon_auth.session
 where "userId" in (
   select id from neon_auth.user
    where email like 'e2e.%' or email like 'debug.%' or email like 'forged.%'
 );

delete from neon_auth.account
 where "userId" in (
   select id from neon_auth.user
    where email like 'e2e.%' or email like 'debug.%' or email like 'forged.%'
 );

delete from neon_auth.user
 where email like 'e2e.%' or email like 'debug.%' or email like 'forged.%';

commit;

select
  (select count(*) from public.users)                                  as profile_rows,
  (select count(*) from neon_auth.user)                                as auth_identities,
  (select count(*) from public.scans)                                  as scans;
