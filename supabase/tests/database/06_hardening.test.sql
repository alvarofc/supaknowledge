-- Catalog-level hardening: grants, search_path, RLS coverage, service-role detection.
begin;
\ir _fixture.psql
select plan(14);

select is_empty($$
  select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and n.nspname in ('public', 'private', 'util')
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
$$, 'every SECURITY DEFINER function pins search_path');

select is_empty($$
  select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'util') and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'execute') and has_schema_privilege('anon', n.oid, 'usage')
    and n.nspname || '.' || p.proname not like 'public.pgmq%'
$$, 'no Supaknowledge function is executable by anon');

select ok(not has_schema_privilege('anon', 'private', 'usage') and not has_schema_privilege('anon', 'util', 'usage')
          and not has_schema_privilege('authenticated', 'util', 'usage'), 'private/util schemas are not reachable by anon; util not by authenticated');

select is_empty($$
  select p from unnest(array['public.kf_get_source_secret(uuid)', 'public.kf_queue_ack(text,bigint[])', 'public.kf_queue_send(text,jsonb[],integer)',
                             'public.kf_queue_archive(text,bigint[])', 'public.kf_enqueue_curator_task(uuid,text,jsonb)']) p
  where has_function_privilege('authenticated', p::regprocedure, 'execute') or has_function_privilege('anon', p::regprocedure, 'execute')
$$, 'service-only RPCs are not executable by authenticated or anon');

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
$$, 'RLS is enabled on every public table');

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
    and not coalesce((select bool_or(o = 'security_invoker=true') from unnest(c.reloptions) o), false)
$$, 'no security-definer views in public');

select is_empty($$
  select tablename || ': ' || policyname from pg_policies
  where schemaname in ('public', 'storage') and (roles && array['anon', 'public']::name[])
    and (schemaname = 'public' or policyname like 'concept-files%' or policyname like 'sources:%')
$$, 'no Supaknowledge policy applies to anon/public');

select is_empty($$
  select tablename || ' ' || cmd from pg_policies
  where schemaname = 'public' and cmd <> 'SELECT'
    and tablename in ('concepts', 'concept_revisions', 'concept_chunks', 'concept_links', 'concept_files', 'verifications',
                      'source_documents', 'source_chunks', 'audit_log', 'curator_runs', 'curator_tasks', 'flags')
    and not (tablename = 'flags' and cmd = 'UPDATE')
$$, 'knowledge, raw evidence, audit and curator tables have no client write policies');

-- private.is_service_role
select tests.as_user('s_admin');
select is(private.is_service_role(), false, 'authenticated JWT is not the service role');
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(private.is_service_role(), false, 'anon JWT is not the service role');
select set_config('request.jwt.claims', json_build_object('sub', tests.id('s_admin'), 'role', 'authenticated', 'app_metadata', json_build_object('role', 'service_role'))::text, true);
select is(private.is_service_role(), false, 'role nested in app_metadata does not count');
select tests.as_service();
select is(private.is_service_role(), true, 'service role JWT is the service role');
select tests.as_user('s_admin');
select throws_ok($$select public.kf_get_source_secret(tests.id('src_fin'))$$, '42501', null, 'secret RPC refused for authenticated even when called by name');
select tests.as_postgres();
select is(private.is_service_role(), true, 'direct postgres connection (cron, migrations) counts as service');

select * from finish();
rollback;
