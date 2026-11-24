-- Regression tests for the database review fixes (migrations 20261125000011 .. 19): tenancy invariants, OAuth
-- client tokens, agents, data lifecycle, traces/flags column rules, settings safety, the curator run lifecycle,
-- search and maintenance.
begin;
\ir _fixture.psql
select plan(93);

grant insert on tests.ids to authenticated, service_role;

create function tests.as_oauth(p text) returns void language plpgsql as $$
begin
  perform tests.as_user(p);
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(p), 'role', 'authenticated', 'client_id', 'mcp-client-123')::text, true);
end;
$$;
create function tests.role_of(p_user text, p_space text) returns public.space_role language plpgsql as $$
declare r public.space_role;
begin
  perform tests.as_user(p_user);
  r := public.my_space_role(tests.id(p_space));
  perform tests.as_postgres();
  return r;
end;
$$;
create function tests.sees_c_fin(p_user text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform tests.as_user(p_user);
  v := exists (select 1 from public.concepts where id = tests.id('c_fin'));
  perform tests.as_postgres();
  return v;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- tenancy: groups cannot change workspace; access requires CURRENT workspace membership
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('admin_a');
select tests.put('ws_evil', (public.create_workspace('evil-ws', 'Evil')).id);
select throws_ok($$update public.groups set workspace_id = tests.id('ws_evil') where id = tests.id('g_fin')$$, '42501', null,
  'groups.workspace_id is immutable (no hijacking groups into another workspace)');
select throws_ok($$update public.space_members set space_id = tests.id('s_open') where space_id = tests.id('s1') and user_id = tests.id('s_reader')$$,
  '42501', null, 'space_members keys are immutable');
update public.groups set name = 'Finance team' where id = tests.id('g_fin');
select tests.as_postgres();
select is((select name from public.groups where id = tests.id('g_fin')), 'Finance team', 'other group columns stay editable');

-- removal from the workspace removes space/group memberships
select tests.as_user('owner_a');
delete from public.workspace_members where workspace_id = tests.id('ws_a') and user_id = tests.id('fin_admin');
select tests.as_postgres();
select is(tests.role_of('fin_admin', 's1'), null, 'removed member has no role left on the private space');
select is(tests.sees_c_fin('fin_admin'), false, 'and no longer reads finance-only knowledge');
select is_empty($$select 1 from public.space_members where user_id = tests.id('fin_admin')
                  union all select 1 from public.group_members where user_id = tests.id('fin_admin')$$,
  'space and group memberships in that workspace are deleted');

-- even if membership rows linger (e.g. a legacy row), roles and audiences require workspace membership
alter table public.workspace_members disable trigger workspace_members_removed;
delete from public.workspace_members where workspace_id = tests.id('ws_a') and user_id = tests.id('fin_reviewer');
alter table public.workspace_members enable trigger workspace_members_removed;
select is(tests.role_of('fin_reviewer', 's1'), null, 'lingering space_members rows grant nothing outside the workspace');
select is(tests.sees_c_fin('fin_reviewer'), false, 'lingering group_members rows grant no audience');

-- members must belong to the workspace
select tests.as_user('s_admin');
select throws_ok($$insert into public.space_members (space_id, user_id, role) values (tests.id('s1'), tests.id('outsider'), 'admin')$$,
  '42501', null, 'space admins cannot add users from outside the workspace');
select tests.as_user('admin_a');
select throws_ok($$insert into public.group_members (group_id, user_id) values (tests.id('g_fin'), tests.id('outsider'))$$,
  '42501', null, 'group members must belong to the workspace');
insert into public.group_members (group_id, user_id) values (tests.id('g_eng'), tests.id('member_a'));
select tests.as_postgres();
select ok(exists (select 1 from public.audit_log where action = 'group_members.insert' and target_id = tests.id('member_a')
                  and actor_user_id = tests.id('admin_a')), 'group membership changes are audited');

-- last owner
select tests.as_user('owner_a');
select throws_ok($$delete from public.workspace_members where workspace_id = tests.id('ws_a') and user_id = tests.id('owner_a')$$,
  '42501', null, 'the last owner cannot leave');
select throws_ok($$update public.workspace_members set role = 'admin' where workspace_id = tests.id('ws_a') and user_id = tests.id('owner_a')$$,
  '42501', null, 'the last owner cannot demote themselves');

-- groups in use as an audience
select throws_ok($$delete from public.groups where id = tests.id('g_fin')$$, '23503', null, 'a group used as an audience cannot be deleted');
select tests.as_postgres();
select is((select count(*)::int from public.groups where id = tests.id('g_fin')), 1, 'finance group still there');

-- ---------------------------------------------------------------------------------------------------------
-- agents
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_admin');
select throws_ok($$update public.space_members set role = 'admin' where space_id = tests.id('s1') and user_id = tests.id('agent')$$,
  '42501', null, 'agents cannot be space admins');
select tests.as_user('owner_a');
select throws_ok($$update public.workspace_members set role = 'admin' where workspace_id = tests.id('ws_a') and user_id = tests.id('agent')$$,
  '42501', null, 'agents cannot be workspace admins');
select throws_ok($$delete from public.agents where id = tests.id('agent')$$, '42501', null, 'agents rows cannot be deleted directly');
insert into public.group_members (group_id, user_id) values (tests.id('g_rev'), tests.id('agent'));
update public.space_group_grants set role = 'admin' where space_id = tests.id('s1') and group_id = tests.id('g_rev');
select tests.as_postgres();
select is(tests.role_of('agent', 's1'), 'reviewer', 'an agent in an admin-granted group is capped at reviewer');
select is(tests.role_of('grp_reviewer', 's1'), 'admin', 'humans in that group are admins');
update public.space_group_grants set role = 'reviewer' where space_id = tests.id('s1') and group_id = tests.id('g_rev');
delete from public.group_members where group_id = tests.id('g_rev') and user_id = tests.id('agent');

-- agent last_seen_at
select tests.as_user('agent');
select is(public.log_concept_usage(tests.id('s1'), array[tests.id('c_pub')], 'search'), 1, 'agent logs usage');
select tests.as_postgres();
select isnt((select last_seen_at from public.agents where id = tests.id('agent')), null, 'agents.last_seen_at is updated');

-- reserved agent e-mail domain
set constraints auth.guard_agent_email immediate;
select throws_ok($$insert into auth.users (id, instance_id, email, aud, role, raw_app_meta_data) values (gen_random_uuid(),
  '00000000-0000-0000-0000-000000000000', 'agent-' || gen_random_uuid() || '@agents.supaknowledge.internal', 'authenticated', 'authenticated', '{}')$$,
  '42501', null, 'sign-up cannot claim the agent e-mail domain');
set constraints auth.guard_agent_email deferred;
-- the Auth admin API inserts first and writes app_metadata after, in the same transaction: checked at commit
select tests.put('fake_agent', gen_random_uuid());
insert into auth.users (id, instance_id, email, aud, role, raw_app_meta_data) values (tests.id('fake_agent'),
  '00000000-0000-0000-0000-000000000000', 'agent-' || tests.id('fake_agent') || '@agents.supaknowledge.internal', 'authenticated', 'authenticated', '{"provider":"email"}');
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"kind":"agent"}' where id = tests.id('fake_agent');
select lives_ok($$set constraints auth.guard_agent_email immediate$$, 'admin-created agents (app_metadata written later in the transaction) pass');
set constraints auth.guard_agent_email deferred;
select is(private.hook_before_user_created('{"user":{"email":"agent-1@agents.supaknowledge.internal","app_metadata":{"kind":"agent"}}}') -> 'error' ->> 'http_code',
  '403', 'the before_user_created hook refuses the agent domain (public sign-up never creates agents)');
select is(private.hook_before_user_created('{"user":{"email":"someone@example.com"}}'), '{}'::jsonb, 'the hook allows other e-mails');

-- (find_user_by_email was dropped in 20261125000020: people are invited by e-mail, see 08_followups)

-- ---------------------------------------------------------------------------------------------------------
-- OAuth client tokens: read as the person, never administer
-- ---------------------------------------------------------------------------------------------------------
select tests.as_oauth('owner_a');
select ok(exists (select 1 from public.concepts where id = tests.id('c_pub')), 'OAuth token reads knowledge as the person');
select ok(public.flag_knowledge(tests.id('s1'), 'unclear', 'via MCP', 'metrics/active-users') is not null, 'OAuth token can flag');
select lives_ok($$insert into public.traces (space_id, name) values (tests.id('s1'), 'mcp trace')$$, 'OAuth token can send traces');
select throws_ok($$insert into public.group_members (group_id, user_id) values (tests.id('g_fin'), tests.id('owner_a'))$$, '42501', null,
  'OAuth token cannot add the person to a group');
select throws_ok($$insert into public.space_members (space_id, user_id, role) values (tests.id('s1'), tests.id('member_a'), 'admin')$$, '42501', null,
  'OAuth token cannot grant space roles');
update public.spaces set name = 'renamed by oauth' where id = tests.id('s1');
select throws_ok($$select public.create_workspace('oauth-ws', 'x')$$, '42501', null, 'OAuth token cannot create workspaces');
select throws_ok($$select public.set_source_secret(tests.id('src_pub'), 'x')$$, '42501', null, 'OAuth token cannot set secrets');
select throws_ok($$select public.request_curator_run(tests.id('s1'))$$, '42501', null, 'OAuth token cannot start curator runs');
delete from public.workspaces where id = tests.id('ws_a');
select tests.as_postgres();
select is((select count(*)::int from public.workspaces where id = tests.id('ws_a')), 1, 'OAuth token cannot delete the workspace');
select is((select name from public.spaces where id = tests.id('s1')), 'Space 1', 'OAuth token cannot change spaces');

-- ---------------------------------------------------------------------------------------------------------
-- evidence lifecycle
-- ---------------------------------------------------------------------------------------------------------
-- documents are never wider than their source
insert into public.source_documents (source_id, space_id, external_id, title, content, content_hash, audience)
values (tests.id('src_fin'), tests.id('s1'), 'm9', 'Finance 2', 'more finance', 'h9', '{}') returning tests.put('doc_fin2', id);
select is((select audience from public.source_documents where id = tests.id('doc_fin2')), array[tests.id('g_fin')],
  'a document inserted without audience inherits its restricted source''s audience');
update public.sources set audience = array[tests.id('g_eng')] where id = tests.id('src_pub');
select is((select audience from public.source_documents where id = tests.id('doc_pub')), array[tests.id('g_eng')],
  'tightening a source''s audience narrows its documents');
update public.sources set audience = '{}' where id = tests.id('src_pub');
update public.source_documents set audience = '{}' where id = tests.id('doc_pub');

-- soft-deleted documents are hidden (rows, chunks, files) and queued for Storage cleanup
update public.source_documents set deleted_at = now() where id = tests.id('doc_pub');
select tests.as_user('s_editor');
select is_empty($$select 1 from public.source_documents where id = tests.id('doc_pub')$$, 'soft-deleted documents are hidden');
select is_empty($$select 1 from public.source_chunks where document_id = tests.id('doc_pub')$$, 'and their chunks');
select is_empty($$select 1 from storage.objects where bucket_id = 'sources' and name like '%/m1.txt'$$, 'and their files');
select tests.as_postgres();
select ok(exists (select 1 from public.kf_storage_gc where bucket = 'sources' and prefix like '%/m1.txt'), 'the file is queued for deletion');
update public.source_documents set deleted_at = null where id = tests.id('doc_pub');

-- deleting a source deletes its Vault secret and queues its files
update public.sources set secret_id = vault.create_secret('xoxb-new', 'kf_source_' || id::text) where id = tests.id('src_fin');
select tests.put('fin_secret', (select secret_id from public.sources where id = tests.id('src_fin')));
delete from public.sources where id = tests.id('src_fin');
select is_empty($$select 1 from vault.secrets where id = tests.id('fin_secret')$$, 'the source''s Vault secret is deleted with it');
select ok(exists (select 1 from public.kf_storage_gc where bucket = 'sources' and prefix = tests.id('s1') || '/' || tests.id('src_fin') || '/'),
  'the source''s files are queued for deletion');
select tests.as_user('s_admin');
select throws_ok($$select * from public.kf_storage_gc$$, '42501', null, 'the Storage GC queue is not readable by API users');

-- ---------------------------------------------------------------------------------------------------------
-- traces and flags column rules
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('agent');
select throws_ok($$insert into public.traces (space_id, name, curated_at) values (tests.id('s1'), 'skip curation', now())$$, '42501', null,
  'senders cannot mark their traces curated');
select throws_ok($$insert into public.traces (space_id, name, on_behalf_of) values (tests.id('s1'), 'spam', tests.id('member_b'))$$, '42501', null,
  'on_behalf_of must be a member of the workspace');
select lives_ok($$insert into public.traces (space_id, name, on_behalf_of) values (tests.id('s1'), 'for member', tests.id('member_a'))$$,
  'on_behalf_of a coworker is fine');

select tests.as_user('s_reviewer');
select throws_ok($$update public.flags set resolved_by = tests.id('owner_a') where id = tests.id('flag_pub')$$, '42501', null,
  'reviewers cannot attribute a resolution to someone else');
select throws_ok($$update public.flags set proposal_id = tests.id('prop_b') where id = tests.id('flag_pub')$$, '42501', null,
  'reviewers cannot link a proposal of another space');
update public.flags set status = 'dismissed', resolved_by = tests.id('s_reviewer') where id = tests.id('flag_pub');
select tests.as_postgres();
select is((select status from public.flags where id = tests.id('flag_pub')), 'dismissed', 'reviewers still triage flags');

-- flags never attach to a concept their audience cannot see
select tests.as_service();
insert into public.flags (space_id, kind, concept_id, concept_path, observation, audience, synthetic)
values (tests.id('s1'), 'incorrect', tests.id('c_fin'), 'finance/arr', 'eng saw something', array[tests.id('g_eng')], true) returning tests.put('flag_x', id);
insert into public.flags (space_id, kind, concept_id, concept_path, observation, synthetic)
values (tests.id('s1'), 'incorrect', tests.id('c_fin'), 'finance/arr', 'public trace', true) returning tests.put('flag_y', id);
select tests.as_postgres();
select results_eq($$select concept_id, audience from public.flags where id = tests.id('flag_x')$$, $$select null::uuid, array[tests.id('g_eng')]$$,
  'a flag whose audience is disjoint from the concept''s does not reference the concept');
select results_eq($$select concept_id, audience from public.flags where id = tests.id('flag_y')$$, $$select tests.id('c_fin'), array[tests.id('g_fin')]$$,
  'an unrestricted flag about a restricted concept inherits the concept''s audience');

-- ---------------------------------------------------------------------------------------------------------
-- settings safety: one bad space cannot break global cron
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_admin');
select throws_ok($$update public.spaces set settings = '{"curator":{"enabled":"not-a-bool"}}' where id = tests.id('s1')$$, '22023', null,
  'invalid settings are refused on write');
select throws_ok($$update public.spaces set settings = '{"curator":{"max_research_steps":0}}' where id = tests.id('s1')$$, '22023', null,
  'out-of-range settings are refused on write');
update public.spaces set settings = '{"curator":{"enabled":true,"unknown_key":1},"custom":{"x":1}}' where id = tests.id('s1');
select tests.as_postgres();
select is((select settings -> 'custom' from public.spaces where id = tests.id('s1')), '{"x":1}'::jsonb, 'unknown keys are kept');
select tests.as_user('s_admin');
select throws_ok($$insert into public.sources (space_id, connector, name, sync_interval) values (tests.id('s1'), 'web', 'forever', interval '1000000 years')$$,
  '23514', null, 'sync_interval is bounded');
select tests.as_postgres();
-- a legacy row with bad settings (written before validation) no longer aborts the global jobs
alter table public.spaces disable trigger spaces_validate_settings;
update public.spaces set settings = '{"curator":{"enabled":"not-a-bool","flag_threshold":"x"}}' where id = tests.id('s2');
alter table public.spaces enable trigger spaces_validate_settings;
select lives_ok($$select util.schedule_nightly_curator()$$, 'nightly curator survives malformed settings in one space');
select lives_ok($$select util.schedule_staleness_sweep()$$, 'staleness sweep survives malformed settings');
select tests.as_user('member_b');
select lives_ok($$select public.flag_knowledge(tests.id('s2'), 'missing', 'x')$$, 'flagging survives malformed settings');
select tests.as_postgres();
insert into public.sources (space_id, connector, name) values (tests.id('s1'), 'upload', 'uploads') returning tests.put('src_up', id);
select util.enqueue_due_sources();
select is((select sync_requested_at from public.sources where id = tests.id('src_up')), null, 'upload sources are never scheduled for sync');

-- ---------------------------------------------------------------------------------------------------------
-- curator run lifecycle
-- ---------------------------------------------------------------------------------------------------------
select tests.as_service();
select throws_ok($$insert into public.curator_runs (space_id, trigger) values (tests.id('s1'), 'manual')$$, '23505', null,
  'one active run per space (unique index)');
select is((public.request_curator_run(tests.id('s1'), 'cron')).id, tests.id('run_s1'), 'starting a run returns the active one');

-- a run fails if ANY task failed, even when the last one succeeded
select tests.put('t_extra', public.kf_enqueue_curator_task(tests.id('run_s1'), 'draft', '{}'));
select is(public.kf_finish_task((select id from public.curator_tasks where run_id = tests.id('run_s1') and id <> tests.id('t_extra')), 'failed', null, 'boom'),
  'running', 'run keeps running while tasks remain');
select is(public.kf_finish_task(tests.id('t_extra'), 'succeeded', '{"ok":true}'), 'failed', 'last task succeeded but an earlier one failed: run failed');
select results_eq($$select status, error like '%boom%' from public.curator_runs where id = tests.id('run_s1')$$, $$values ('failed'::public.run_status, true)$$,
  'run status and error recorded');
select is(public.kf_enqueue_curator_task(tests.id('run_s1'), 'draft', '{}'), null, 'no new tasks on a finished run');

-- all tasks succeeded
select tests.put('run2', (public.request_curator_run(tests.id('s1'), 'manual')).id);
select is(public.kf_finish_task((select id from public.curator_tasks where run_id = tests.id('run2')), 'succeeded', '{}'), 'succeeded',
  'run succeeds when all tasks succeeded');
select is(public.kf_maybe_finish_run(tests.id('run2')), 'succeeded', 'kf_maybe_finish_run is idempotent');

-- watermark ignores staleness sweeps
select tests.as_postgres();
update public.curator_runs set until = now() - interval '2 hours' where id = tests.id('run2');
insert into public.curator_runs (space_id, trigger, status, until) values (tests.id('s1'), 'staleness', 'succeeded', now() - interval '30 minutes');
select tests.as_service();
select tests.put('run3', (public.request_curator_run(tests.id('s1'), 'cron')).id);
select tests.as_postgres();
select ok((select since from public.curator_runs where id = tests.id('run3')) < now() - interval '1 hour',
  'the next run starts from the last NON-staleness watermark');

-- cancel
select tests.as_user('s_editor');
select throws_ok($$select public.cancel_curator_run(tests.id('run3'))$$, '42501', null, 'editors cannot cancel runs');
select tests.as_user('s_reviewer');
select is((public.cancel_curator_run(tests.id('run3'))).status, 'cancelled', 'reviewers cancel a run');
select tests.as_postgres();
select is_empty($$select 1 from public.curator_tasks where run_id = tests.id('run3') and status in ('queued', 'running')$$, 'its tasks are cancelled');

-- reaper
select tests.as_service();
select tests.put('run4', (public.request_curator_run(tests.id('s1'), 'manual')).id);
select tests.as_postgres();
update public.curator_runs set created_at = now() - interval '2 hours', started_at = now() - interval '2 hours', status = 'running' where id = tests.id('run4');
update public.curator_tasks set created_at = now() - interval '2 hours', status = 'running' where run_id = tests.id('run4');
select util.reap_curator_runs();
select results_eq($$select status from public.curator_runs where id = tests.id('run4')$$, $$values ('failed'::public.run_status)$$,
  'the reaper fails runs stuck without progress');
select ok(not exists (select 1 from public.curator_tasks where run_id = tests.id('run4') and status <> 'failed'), 'and their tasks');

-- staleness respects curator.enabled; flag threshold only counts missing flags space-wide; cooldown
update public.spaces set settings = '{"curator":{"enabled":false}}' where id = tests.id('s_open');
update public.concepts set stale_after = now() - interval '1 day' where id = tests.id('c_open');
select util.schedule_staleness_sweep();
select is_empty($$select 1 from public.curator_runs where space_id = tests.id('s_open')$$, 'staleness sweeps skip spaces with the curator disabled');
update public.spaces set settings = '{"curator":{"flag_threshold":1,"flag_cooldown_minutes":60}}' where id = tests.id('s_open');
select tests.as_user('member_a');
select public.flag_knowledge(tests.id('s_open'), 'unclear', 'vague, no concept');
select tests.as_postgres();
select is_empty($$select 1 from public.curator_runs where space_id = tests.id('s_open')$$, 'a non-missing flag without concept does not trigger a run');
select tests.as_user('member_a');
select public.flag_knowledge(tests.id('s_open'), 'missing', 'no doc about X');
select tests.as_postgres();
select is((select count(*)::int from public.curator_runs where space_id = tests.id('s_open') and trigger = 'flag_threshold'), 1, 'a missing flag over the threshold does');
update public.curator_runs set status = 'succeeded' where space_id = tests.id('s_open');
select tests.as_user('member_a');
select public.flag_knowledge(tests.id('s_open'), 'missing', 'no doc about Y');
select tests.as_postgres();
select is((select count(*)::int from public.curator_runs where space_id = tests.id('s_open')), 1, 'flag-triggered runs have a cooldown');

-- re-curation
update public.traces set curated_at = now() where id = tests.id('tr_agent');
select tests.as_user('agent');
insert into public.trace_events (trace_id, space_id, seq, role, content) values (tests.id('tr_agent'), tests.id('s1'), 1, 'feedback', 'that was wrong');
select tests.as_postgres();
select is((select curated_at from public.traces where id = tests.id('tr_agent')), null, 'new events make a trace uncurated again');
update public.traces set curated_at = now() where id = tests.id('tr_agent');
select tests.as_user('agent');
update public.traces set outcome = 'corrected' where id = tests.id('tr_agent');
select tests.as_postgres();
select is((select curated_at from public.traces where id = tests.id('tr_agent')), null, 'an outcome change makes it uncurated again');

-- kf_trace_events
insert into public.trace_events (trace_id, space_id, seq, role, content)
select tests.id('tr_editor'), tests.id('s1'), g, 'assistant', 'step ' || g from generate_series(0, 1499) g;
select tests.as_service();
select is(jsonb_array_length(public.kf_trace_events(array[tests.id('tr_editor'), tests.id('tr_agent')])), 1502, 'kf_trace_events returns every event (no 1000-row cap)');
select is(public.kf_trace_events(array[tests.id('tr_editor')], 100) -> -1 ->> 'seq', '1499', 'capped per trace, the tail (corrections) is kept');
select tests.as_user('fin_admin');
select throws_ok($$select public.kf_trace_events(array[tests.id('tr_fin')])$$, '42501', null, 'kf_trace_events is service-only');

-- ---------------------------------------------------------------------------------------------------------
-- search
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
insert into public.concepts (space_id, path, kind, type, title, body)
select tests.id('s1'), 'ops/deploy-' || g, 'domain', 'Guide', 'Deploy guide ' || g, 'how to deploy the deploy service' from generate_series(1, 60) g;
insert into public.concepts (space_id, path, kind, type, title, body)
values (tests.id('s1'), 'skills/deploy', 'skill', 'Skill', 'Deploy skill', 'deploy') returning tests.put('c_skill', id);
insert into public.concept_chunks (concept_id, space_id, revision, ord, content)
select c.id, c.space_id, 1, 0, c.body from public.concepts c where c.space_id = tests.id('s1') and c.path like '%deploy%';
select tests.as_user('s_reader');
select results_eq($$select concept_id from public.search_knowledge(tests.id('s1'), 'deploy', null, array['skill'::public.concept_kind])$$,
  $$select tests.id('c_skill')$$, 'kind filters apply before the candidate limit (60 matching domain concepts do not starve the skill)');

-- vector search with a global HNSW index: restricted and foreign chunks do not starve the caller's results
select tests.as_postgres();
update public.concept_chunks set embedding = array_fill(0.1::real, array[384])::extensions.vector
 where concept_id in (select id from public.concepts where path like 'ops/deploy-%');
update public.concepts set audience = array[tests.id('g_fin')] where path like 'ops/deploy-%';
update public.concept_chunks set embedding = (array[0.2::real] || array_fill(0.1::real, array[383]))::extensions.vector where concept_id = tests.id('c_skill');
set local enable_seqscan = off;
select tests.as_user('s_reader');
select results_eq($$select concept_id from public.search_knowledge(tests.id('s1'), 'zzz-no-text-match', array_fill(0.1::real, array[384])::extensions.vector)$$,
  $$select tests.id('c_skill')$$, 'vector search finds the visible chunk behind 60 nearer restricted ones');
reset enable_seqscan;

-- search_sources: one score per (document, signal)
select tests.as_postgres();
insert into public.source_chunks (document_id, space_id, ord, content)
select tests.id('doc_pub'), tests.id('s1'), g, 'revenue revenue boilerplate ' || g from generate_series(1, 10) g;
select tests.as_user('s_editor');
select ok((select max(score) from public.search_sources(tests.id('s1'), 'revenue')) <= 1.0 / 61 + 1e-9,
  'a document is scored by its best chunk, not the number of chunks');

-- ---------------------------------------------------------------------------------------------------------
-- maintenance
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
create temp table t_never_used as
  select count(*)::int as n from public.concepts c
  where c.space_id = tests.id('s1') and c.status <> 'deprecated' and private.aud_ok(c.audience, array[tests.id('g_fin')])
    and not exists (select 1 from public.concept_usage u where u.concept_id = c.id);
grant select on t_never_used to authenticated;
select tests.as_user('fin_editor');
select is((public.knowledge_health(tests.id('s1')) ->> 'never_used')::int, (select n from t_never_used),
  'knowledge_health counts usage by everyone for editors (usage by fin_reader and the agent counts)');
select lives_ok($$select public.knowledge_health(tests.id('s1'), -5), public.knowledge_health(tests.id('s1'), 1000000)$$, 'p_days is clamped');
select tests.as_postgres();
select lives_ok($$select util.cleanup()$$, 'cleanup job runs');
select ok(exists (select 1 from cron.job where jobname = 'kf-cleanup') and exists (select 1 from cron.job where jobname = 'kf-curator-reaper'),
  'cleanup and reaper are scheduled');

-- workspace deletion: cascades through groups in use, owners and agents (whose Auth users are deleted)
select tests.as_user('owner_a');
delete from public.workspaces where id = tests.id('ws_a');
select tests.as_postgres();
select is((select count(*)::int from public.workspaces where id = tests.id('ws_a')), 0, 'the owner deletes the workspace (groups in use and owners cascade)');
select is_empty($$select 1 from auth.users where id = tests.id('agent')$$, 'its agents'' Auth users are deleted with it');

select * from finish();
rollback;
