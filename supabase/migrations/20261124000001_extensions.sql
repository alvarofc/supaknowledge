-- Supaknowledge: extensions and internal schemas
--
-- Supabase primitives used:
--   vector   -> pgvector for semantic search
--   pgmq     -> Supabase Queues (embeddings, ingestion, curator steps)
--   pg_net   -> async HTTP from Postgres (invoke Edge Functions)
--   pg_cron  -> Supabase Cron (schedules)
--   vault    -> secrets (connector tokens, internal invoke secret)

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault with schema vault;

-- `private` holds security-definer helpers used by RLS policies. It is never exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- `util` holds plumbing (edge function invocation, queue helpers). Not exposed through the Data API.
create schema if not exists util;
revoke all on schema util from public, anon, authenticated;
grant usage on schema util to service_role;
