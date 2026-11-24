-- Catalog-level hardening: grants, search_path, RLS coverage, service-role detection.
begin;
\ir _fixture.psql
select plan(19);

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
                             'public.kf_queue_archive(text,bigint[])', 'public.kf_enqueue_curator_task(uuid,text,jsonb)',
                             'public.kf_add_run_stats(uuid,jsonb)', 'public.kf_finish_task(uuid,text,jsonb,text)',
                             'public.kf_maybe_finish_run(uuid)', 'public.kf_trace_events(uuid[],integer)']) p
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

select is_empty($$
  select p from unnest(array['private.aud_ok(uuid[],uuid[])', 'private.my_group_ids()', 'private.my_spaces(public.space_role)',
                             'private.my_workspaces(public.workspace_role)', 'private.can_see_proposal(uuid,uuid[])',
                             'private.is_oauth_client()', 'private.try_uuid(text)', 'private.space_rank(uuid)']) p
  where not has_function_privilege('authenticated', p::regprocedure, 'execute')
$$, 'helpers used inside RLS policies are executable by authenticated');

select is_empty($$
  select p from unnest(array['private.recompute_proposal_access(uuid)', 'private.start_curator_run(uuid,text,uuid)',
                             'private.audit(uuid,text,text,uuid,jsonb)', 'private.hook_before_user_created(jsonb)',
                             'private.finish_run_if_done(uuid)', 'util.cleanup()', 'util.reap_curator_runs()']) p
  where has_function_privilege('authenticated', p::regprocedure, 'execute')
$$, 'internal helpers are not executable by authenticated');

select ok(has_function_privilege('supabase_auth_admin', 'private.hook_before_user_created(jsonb)', 'execute'),
  'the Auth hook is executable by supabase_auth_admin');

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
         or has_table_privilege('authenticated', c.oid, 'truncate'))
$$, 'anon has no table privileges and authenticated cannot TRUNCATE');

select ok(not has_table_privilege('authenticated', 'public.proposals', 'insert')
          and not has_table_privilege('authenticated', 'public.proposal_ops', 'insert')
          and not has_table_privilege('authenticated', 'public.proposal_citations', 'insert'),
  'proposals are only created through create_proposal()');

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
