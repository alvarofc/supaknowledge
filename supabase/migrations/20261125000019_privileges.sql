-- Supaknowledge: review fixes, part 9 — default privileges for FUTURE objects.
--
-- Supabase's defaults grant ALL on new public tables (and EXECUTE on new functions) to anon and authenticated.
-- Earlier migrations revoked those grants table by table; anything added by a later migration would have been
-- exposed to anon again silently. From here on, objects created by `postgres` (the migration role):
--   * public tables / sequences: nothing for anon; no TRUNCATE for authenticated (TRUNCATE bypasses RLS);
--   * functions: the per-schema EXECUTE grant to anon is dropped. New functions are still executable through
--     PUBLIC (a global built-in default that a per-schema setting cannot remove, and revoking it globally would
--     also strip extensions created by `postgres`), so every new function must keep doing
--     `revoke execute ... from public, anon` — supabase/tests/database/06_hardening.test.sql fails otherwise.
--
-- Not changed here (cannot be from the `postgres` role, objects belong to supabase_admin): the `net` schema keeps
-- USAGE for anon/authenticated and `net.http_request_queue` is readable by any role that can run SQL directly.
-- `net` is not exposed through the Data API (config.jsonc api.schemas), so API clients cannot reach it; on a
-- self-hosted database, `revoke usage on schema net from anon, authenticated` as supabase_admin.
-- Idempotent.

alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
alter default privileges for role postgres in schema public revoke truncate on tables from authenticated;

-- re-assert for everything that exists now (new tables of migrations 11-18 included)
revoke all on all tables in schema public from anon;
revoke truncate on all tables in schema public from anon, authenticated;
