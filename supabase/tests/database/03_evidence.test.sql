-- Evidence: raw sources, traces, connector secrets, queue / service-only RPCs.
begin;
\ir _fixture.psql
select plan(45);

-- ---------------------------------------------------------------------------------------------------------
-- agents (readers) never see raw evidence or other people's traces
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('agent');
select is_empty($$select 1 from public.sources$$, 'agent: no sources');
select is_empty($$select 1 from public.source_documents$$, 'agent: no source documents');
select is_empty($$select 1 from public.source_chunks$$, 'agent: no source chunks');
select is_empty($$select 1 from public.search_sources(tests.id('s1'), 'revenue')$$, 'agent: search_sources returns nothing');
select results_eq($$select id from public.traces$$, $$select tests.id('tr_agent')$$, 'agent: only its own trace');
select results_eq($$select content from public.trace_events$$, $$values ('agent asked something')$$, 'agent: only its own trace events');
select is_empty($$select 1 from public.curator_runs$$, 'agent: no curator runs');
select is_empty($$select 1 from public.audit_log$$, 'agent: no audit log');
select is_empty($$select 1 from public.concept_usage where principal_id <> tests.id('agent')$$, 'agent: no one else''s usage');
select throws_ok($$insert into public.traces (space_id, principal_id, name) values (tests.id('s1'), tests.id('s_editor'), 'spoof')$$,
  '42501', null, 'agent cannot send traces as someone else');
select throws_ok($$insert into public.trace_events (trace_id, space_id, seq, role, content) values (tests.id('tr_editor'), tests.id('s1'), 9, 'user', 'x')$$,
  '42501', null, 'agent cannot append to someone else''s trace');
select throws_ok($$insert into public.traces (space_id, principal_id, name) values (tests.id('s2'), tests.id('agent'), 'x')$$,
  '42501', null, 'agent cannot send traces into a space it cannot read');
insert into public.traces (space_id, name) values (tests.id('s1'), 'own trace');
select ok(exists (select 1 from public.traces where name = 'own trace' and principal_id = tests.id('agent')), 'agent sends a trace as itself');

-- VULNERABILITY: "traces: sender updates own" has no space check in WITH CHECK, so the sender can move its trace
-- into any space (any tenant). The trace then shows up for that space's reviewers and curator.
do $$ begin update public.traces set space_id = tests.id('s2') where id = tests.id('tr_agent'); exception when others then null; end $$;
select tests.as_postgres();
select is((select space_id from public.traces where id = tests.id('tr_agent')), tests.id('s1'),
  'VULNERABILITY: a trace cannot be moved into a space the sender cannot read');
-- VULNERABILITY: trace_events.space_id is client-supplied and never checked against the trace's space.
select tests.as_user('agent');
do $$ begin
  insert into public.trace_events (trace_id, space_id, seq, role, content) values (tests.id('tr_agent'), tests.id('s2'), 7, 'user', 'injected');
exception when others then null; end $$;
select tests.as_postgres();
select is_empty($$select 1 from public.trace_events e join public.traces t on t.id = e.trace_id where e.space_id <> t.space_id$$,
  'VULNERABILITY: trace_events.space_id always matches its trace');
-- VULNERABILITY: concept_usage.space_id is client-supplied (direct insert) and lands in another tenant's
-- reviewers' view.
select tests.as_user('agent');
do $$ begin
  insert into public.concept_usage (space_id, concept_id, revision, query) values (tests.id('s2'), tests.id('c_pub'), 1, 'spam for B');
exception when others then null; end $$;
select tests.as_user('owner_b');
select is_empty($$select 1 from public.concept_usage where space_id = tests.id('s2')$$,
  'VULNERABILITY: usage rows cannot be planted in a foreign space');

-- ---------------------------------------------------------------------------------------------------------
-- editors / reviewers within audience
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_editor');
select results_eq($$select id from public.source_documents$$, $$select tests.id('doc_pub')$$, 'editor: documents in audience only');
select results_eq($$select document_id from public.source_chunks$$, $$select tests.id('doc_pub')$$, 'editor: chunks in audience only');
select results_eq($$select document_id from public.search_sources(tests.id('s1'), 'revenue')$$, $$select tests.id('doc_pub')$$, 'editor: search_sources in audience only');
select results_eq($$select id from public.traces order by name$$, $$select tests.id('tr_editor')$$, 'editor: only own trace');
select tests.as_user('fin_editor');
select results_eq($$select id from public.source_documents order by title$$, $$values (tests.id('doc_fin')), (tests.id('doc_pub'))$$, 'finance editor: both documents');
select tests.as_user('s_reviewer');
select results_eq($$select id from public.traces where id in (tests.id('tr_editor'), tests.id('tr_fin'))$$, $$select tests.id('tr_editor')$$,
  'reviewer: other principals'' traces in audience, not the finance one');
select ok(exists (select 1 from public.traces where name = 'own trace'), 'reviewer: sees the agent''s trace');
select is_empty($$select 1 from public.trace_events where trace_id = tests.id('tr_fin')$$, 'reviewer: no finance trace events');
select tests.as_user('fin_reviewer');
select ok(exists (select 1 from public.trace_events where trace_id = tests.id('tr_fin')), 'finance reviewer: finance trace events');

-- ---------------------------------------------------------------------------------------------------------
-- sources config and secrets
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('fin_admin');
select throws_ok($$select secret_id from public.sources$$, '42501', null, 'secret_id is not selectable');
select throws_ok($$select * from public.sources$$, '42501', null, 'select * on sources is refused (secret_id hidden)');
select throws_ok($$update public.sources set secret_id = null$$, '42501', null, 'secret_id is not updatable');
select throws_ok($$update public.sources set space_id = tests.id('s_open')$$, '42501', null, 'sources.space_id is not updatable');
select throws_ok($$select public.kf_get_source_secret(tests.id('src_fin'))$$, '42501', null, 'kf_get_source_secret denied for authenticated');
select throws_ok($$select public.kf_queue_send('kf_ingest', array['{}'::jsonb])$$, '42501', null, 'kf_queue_send denied');
select throws_ok($$select public.kf_queue_ack('kf_ingest', array[1::bigint])$$, '42501', null, 'kf_queue_ack denied');
select throws_ok($$select public.kf_queue_archive('kf_ingest', array[1::bigint])$$, '42501', null, 'kf_queue_archive denied');
select throws_ok($$select public.kf_enqueue_curator_task(tests.id('run_s1'), 'draft', '{}')$$, '42501', null, 'kf_enqueue_curator_task denied');
select throws_ok($$insert into public.sources (space_id, connector, name, audience) values (tests.id('s1'), 'web', 'fin2', array[tests.id('g_eng')])$$,
  '42501', null, 'admins cannot create sources for an audience they are not in');
select tests.as_user('s_editor');
select throws_ok($$insert into public.sources (space_id, connector, name) values (tests.id('s1'), 'web', 'x')$$, '42501', null, 'editors cannot create sources');
select throws_ok($$select public.set_source_secret(tests.id('src_pub'), 'x')$$, '42501', null, 'editors cannot set source secrets');
select throws_ok($$select public.request_source_sync(tests.id('src_pub'))$$, '42501', null, 'editors cannot request syncs');
select tests.as_user('owner_b');
select throws_ok($$select public.set_source_secret(tests.id('src_pub'), 'x')$$, '42501', null, 'foreign owner cannot set source secrets');
select tests.as_user('fin_admin');
select public.set_source_secret(tests.id('src_fin'), 'xoxb-rotated');
select public.set_source_secret(tests.id('src_pub'), 'xoxb-general');
select public.request_source_sync(tests.id('src_fin'));
select tests.as_service();
select is(public.kf_get_source_secret(tests.id('src_fin')), 'xoxb-rotated', 'admin in audience rotates an existing secret');
select is(public.kf_get_source_secret(tests.id('src_pub')), 'xoxb-general', 'admin creates a new secret');
select ok((select sync_requested_at is not null from public.sources where id = tests.id('src_fin')), 'admin in audience requests a sync');
select is((public.kf_enqueue_curator_task(tests.id('run_s1'), 'draft', '{}'::jsonb) is not null), true, 'service role enqueues curator tasks');

-- VULNERABILITY: sources.secret_id is INSERTable by authenticated (only SELECT/UPDATE got column grants). A space
-- admin outside finance creates a source pointing at the finance token's Vault secret (or any Vault secret, e.g.
-- project_url / kf_internal_secret) and then overwrites it through set_source_secret, or has the connector use it.
select tests.as_postgres();
select tests.put('fin_secret', (select secret_id from public.sources where id = tests.id('src_fin')));
select tests.as_user('s_admin');
select throws_ok($$insert into public.sources (space_id, connector, name, secret_id) values (tests.id('s1'), 'web', 'evil', tests.id('fin_secret'))$$,
  '42501', null, 'VULNERABILITY: secret_id cannot be set on insert');
do $$ begin
  perform public.set_source_secret((select id from public.sources where name = 'evil'), 'attacker-token');
exception when others then null; end $$;
select tests.as_service();
select is(public.kf_get_source_secret(tests.id('src_fin')), 'xoxb-rotated',
  'VULNERABILITY: a space admin outside finance cannot overwrite the finance connector token');

select * from finish();
rollback;
