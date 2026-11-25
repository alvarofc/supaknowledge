-- Round-2 review fixes (migration 20261125000021): each block reproduces a scenario of the verification review.
begin;
\ir _fixture.psql
select plan(106);

grant insert on tests.ids to authenticated, service_role;

create function tests.as_oauth(p text) returns void language plpgsql as $$
begin
  perform tests.as_user(p);
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(p), 'role', 'authenticated', 'client_id', 'mcp-client-123')::text, true);
end;
$$;
create function tests.mk(p_name text, p_ops jsonb, p_cits jsonb default '[]', p_space text default 's1', p_author text default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := (public.create_proposal(tests.id(p_space), p_name, 'because', 'medium', p_ops, p_cits, null, p_author)).id;
  perform tests.put(p_name, v);
  return v;
end;
$$;
create function tests.esc(p_name text) returns boolean language sql security definer as $$
  select escalation from public.proposals where id = tests.id(p_name);
$$;
create function tests.explain(p_sql text) returns text language plpgsql as $$
declare
  l text;
  out text := '';
begin
  for l in execute 'explain ' || p_sql loop
    out := out || l || E'\n';
  end loop;
  return out;
end;
$$;
create function tests.matches(p text, p_re text, p_desc text) returns text language sql as $$
  select ok(coalesce(p ~ p_re, false), p_desc);
$$;
create function tests.email(p text) returns text language sql stable security definer set search_path = '' as $$
  select u.email from auth.users u where u.id = tests.id(p);
$$;
grant execute on function tests.email(text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- #14 aud_ok is GIN friendly
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
select ok((select prosrc from pg_proc where oid = 'private.aud_ok(uuid[],uuid[])'::regprocedure) !~ 'coalesce|cardinality',
  'aud_ok no longer wraps the check in coalesce/cardinality');
set local enable_seqscan = off;
select tests.matches(tests.explain(format($q$select id from public.source_documents where private.aud_ok(audience, array[%L]::uuid[])$q$, tests.id('g_fin'))),
  'Bitmap Index Scan on source_documents_audience_idx', 'an inlined aud_ok() uses the GIN index on audience');
reset enable_seqscan;

-- ---------------------------------------------------------------------------------------------------------
-- #3 own-row branches require current reader access to the space
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('fin_editor');
select isnt_empty($$select 1 from public.traces where id = tests.id('tr_fin')$$, 'a space member reads their own trace');
select tests.as_user('fin_reader');
select isnt_empty($$select 1 from public.flags where id = tests.id('flag_fin')$$, 'a space member reads their own flag');
select isnt_empty($$select 1 from public.concept_usage where principal_id = tests.id('fin_reader')$$, 'and their own usage');
select tests.as_postgres();
update public.traces set curated_at = now() where id = tests.id('tr_fin');
delete from public.space_members where space_id = tests.id('s1') and user_id in (tests.id('fin_editor'), tests.id('fin_reader'));
select tests.as_user('fin_editor');
select is_empty($$select 1 from public.traces where id = tests.id('tr_fin')$$, 'removed from the space: their old restricted trace is gone');
select is_empty($$select 1 from public.trace_events where trace_id = tests.id('tr_fin')$$, 'with its events');
select throws_ok($$insert into public.trace_events (trace_id, space_id, seq, role, content) values (tests.id('tr_fin'), tests.id('s1'), 9, 'user', 'x')$$,
  '42501', null, 'and they cannot append events to it');
update public.traces set outcome = 'corrected' where id = tests.id('tr_fin');
select tests.as_postgres();
select results_eq($$select outcome::text, curated_at is not null from public.traces where id = tests.id('tr_fin')$$,
  $$values ('unknown'::text, true)$$, 'nor update it, so they cannot reset its curation either');
select tests.as_user('fin_reader');
select is_empty($$select 1 from public.flags where id = tests.id('flag_fin')$$, 'removed from the space: their old flag is gone');
select is_empty($$select 1 from public.concept_usage where principal_id = tests.id('fin_reader')$$, 'and their usage');
select tests.as_postgres();
insert into public.space_members (space_id, user_id, role) values (tests.id('s1'), tests.id('fin_editor'), 'editor'), (tests.id('s1'), tests.id('fin_reader'), 'reader');

-- ---------------------------------------------------------------------------------------------------------
-- #9 revoked agents hold nothing (an access token minted before the revoke is useless right away)
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('agent');
select is(public.my_space_role(tests.id('s1')), 'reader'::public.space_role, 'an active agent reads its space');
select tests.as_postgres();
update public.agents set revoked_at = now() where id = tests.id('agent');
select tests.as_user('agent');
select is(public.my_space_role(tests.id('s1')), null, 'a revoked agent has no space role');
select is_empty($$select 1 from public.concepts$$, 'reads no knowledge');
select is_empty($$select 1 from public.workspaces$$, 'and no workspace');
select is_empty($$select 1 from public.traces$$, 'not even its own traces');
select throws_ok($$select public.flag_knowledge(tests.id('s1'), 'unclear', 'still here?')$$, '42501', null, 'and cannot flag');
select tests.as_postgres();
update public.agents set revoked_at = now() + interval '1 hour' where id = tests.id('agent');
select tests.as_user('agent');
select is(public.my_space_role(tests.id('s1')), 'reader'::public.space_role, 'a revoke scheduled in the future does not apply yet');
select tests.as_postgres();
update public.agents set revoked_at = null where id = tests.id('agent');

-- agents.last_seen_at is no longer client-writable (log_concept_usage still maintains it)
select tests.as_user('owner_a');
select throws_ok($$update public.agents set last_seen_at = now() - interval '1 year' where id = tests.id('agent')$$, '42501', null,
  'workspace admins cannot write agents.last_seen_at');
select tests.as_user('agent');
select is(public.log_concept_usage(tests.id('s1'), array[tests.id('c_pub')]), 1, 'the agent logs usage');
select tests.as_postgres();
select ok((select last_seen_at is not null from public.agents where id = tests.id('agent')), 'and last_seen_at is maintained');

-- ---------------------------------------------------------------------------------------------------------
-- #9 agent passwords change only through key rotation
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
select throws_ok($$update auth.users set encrypted_password = 'self-chosen' where id = tests.id('agent')$$, '42501', null,
  'an agent''s password cannot be changed outside key rotation (e.g. PUT /auth/v1/user)');
select lives_ok($$update auth.users set encrypted_password = 'human-choice' where id = tests.id('s_reader')$$, 'people change their passwords as usual');
select lives_ok($$update auth.users set last_sign_in_at = now() where id = tests.id('agent')$$, 'other agent columns are unaffected');
select tests.as_user('owner_a');
select throws_ok($$select public.kf_allow_agent_password_change(tests.id('agent'))$$, '42501', null, 'authenticated cannot authorise a password change');
select tests.as_service();
select throws_ok($$select public.kf_allow_agent_password_change(tests.id('s_reader'))$$, 'P0002', null, 'only agents are authorised');
select lives_ok($$select public.kf_allow_agent_password_change(tests.id('agent'))$$, 'the agents function authorises a rotation');
select tests.as_postgres();
select lives_ok($$update auth.users set encrypted_password = 'rotated' where id = tests.id('agent')$$, 'the authorised change goes through');
select throws_ok($$update auth.users set encrypted_password = 'again' where id = tests.id('agent')$$, '42501', null, 'once');
insert into private.agent_password_changes (agent_id, allowed_until) values (tests.id('agent'), now() - interval '1 second');
select throws_ok($$update auth.users set encrypted_password = 'late' where id = tests.id('agent')$$, '42501', null, 'expired authorisations do not count');

-- ---------------------------------------------------------------------------------------------------------
-- #5 citation audience snapshots follow the evidence; a deleted row keeps its last known audience
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
insert into public.source_documents (source_id, space_id, external_id, title, content, content_hash, audience)
values (tests.id('src_pub'), tests.id('s1'), 'snap', 'Snapshot doc', 'x', 'hs', '{}') returning tests.put('doc_snap', id);
select tests.as_service();
select tests.mk('snap1', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"from snap"}'::jsonb)),
  jsonb_build_array(jsonb_build_object('label', 'snap', 'ref_kind', 'source_document', 'ref_id', tests.id('doc_snap'))), 's1', 'curator/test');
select is(tests.esc('snap1'), false, 'public evidence into a public concept: no escalation');
select tests.as_postgres();
update public.source_documents set audience = array[tests.id('g_fin')] where id = tests.id('doc_snap');
select is((select audience from public.proposal_citations where proposal_id = tests.id('snap1')), array[tests.id('g_fin')],
  'reclassifying the evidence refreshes the citation snapshot of open proposals');
select is(tests.esc('snap1'), true, 'and escalates');
delete from public.source_documents where id = tests.id('doc_snap');
select private.recompute_proposal_access(tests.id('snap1'));
select is(tests.esc('snap1'), true, 'deleting the evidence later keeps the escalation (last known audience)');
select tests.as_user('s_reviewer');
select is_empty($$select 1 from public.proposals where id = tests.id('snap1')$$, 'and keeps it hidden from reviewers outside finance');
select throws_ok($$select public.apply_proposal(tests.id('snap1'))$$, '42501', null, 'who cannot apply it');

-- ---------------------------------------------------------------------------------------------------------
-- #4 apply_proposal keeps the escalation flag it was approved with
-- ---------------------------------------------------------------------------------------------------------
select tests.as_service();
select tests.mk('widen', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'finance/arr', 'after', '{"audience":[],"body":"ARR is public now"}'::jsonb)),
  '[]', 's1', 'curator/test');
select tests.mk('leakcreate', jsonb_build_array(jsonb_build_object('op', 'create', 'path', 'x/from-finance', 'after', '{"body":"from finance"}'::jsonb)),
  jsonb_build_array(jsonb_build_object('label', 'fin', 'ref_kind', 'source_document', 'ref_id', tests.id('doc_fin'))), 's1', 'curator/test');
select tests.as_user('fin_admin');
select is((public.apply_proposal(tests.id('widen'))).status, 'applied', 'a finance space admin applies a widening escalation');
select is(tests.esc('widen'), true, 'the applied proposal still records escalation = true');
select is((public.apply_proposal(tests.id('leakcreate'))).status, 'applied', 'and a create citing restricted evidence');
select is(tests.esc('leakcreate'), true, 'which also keeps escalation = true');
select tests.as_postgres();
select is(current_setting('kf.applying_proposal', true), '', 'the applying marker is cleared afterwards');
update public.concepts set audience = array[tests.id('g_fin')] where id = tests.id('c_fin');

-- ---------------------------------------------------------------------------------------------------------
-- #11 authorise before locking; one answer for "missing" and "not allowed"
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('outsider');
select throws_ok($$select public.apply_proposal(gen_random_uuid())$$, '42501', null, 'apply: a missing proposal answers 42501 (not P0002)');
select throws_ok($$select public.apply_proposal(tests.id('prop_pub'))$$, '42501', null, 'apply: a foreign proposal answers the same');
select throws_ok($$select public.reject_proposal(gen_random_uuid(), 'x')$$, '42501', null, 'reject: missing proposal -> 42501');
select tests.as_user('s_reviewer');
select throws_ok($$select public.apply_proposal(tests.id('widen'))$$, '42501', null,
  'apply: an applied proposal the reviewer cannot see answers 42501, not "proposal is applied"');
select throws_ok($$select public.reject_proposal(tests.id('widen'), 'x')$$, '42501', null, 'reject: same');
select tests.as_service();
select throws_ok($$select public.apply_proposal(gen_random_uuid())$$, 'P0002', null, 'the service role still gets P0002');
select tests.as_user('agent');
select throws_ok($$select public.propose_revert(tests.id('c_pub'), 999)$$, '42501', null, 'propose_revert rejects agents before looking at revisions');
select tests.as_oauth('s_editor');
select throws_ok($$select public.propose_revert(tests.id('c_pub'), 999)$$, '42501', null, 'and OAuth client tokens');
select tests.as_postgres();
select ok(position('pg_advisory_xact_lock' in prosrc) > position('space_rank' in prosrc), 'apply_proposal checks the role before taking the space lock')
  from pg_proc where oid = 'public.apply_proposal(uuid,text,text)'::regprocedure;

-- ---------------------------------------------------------------------------------------------------------
-- new #5 client-supplied citation audiences; traces/sources audiences name groups of the workspace
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_editor');
select tests.mk('spoof', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"x"}'::jsonb)),
  jsonb_build_array(jsonb_build_object('label', 'ext', 'ref_kind', 'url', 'url', 'https://example.com/a', 'audience', jsonb_build_array(tests.id('g_fin')))));
select results_eq($$select c.audience, p.escalation from public.proposal_citations c join public.proposals p on p.id = c.proposal_id where p.id = tests.id('spoof')$$,
  $$values ('{}'::uuid[], false)$$, 'people cannot attach an audience to a citation (no spoofed escalation)');
select tests.mk('zombie', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"y"}'::jsonb)),
  jsonb_build_array(jsonb_build_object('label', 'ext', 'ref_kind', 'url', 'url', 'https://example.com/b', 'audience', jsonb_build_array(gen_random_uuid()))));
select isnt_empty($$select 1 from public.proposals where id = tests.id('zombie')$$, 'nor an invented group (no zombie proposal nobody can see)');
select tests.as_service();
select throws_ok($$select tests.mk('svc_bad', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"z"}'::jsonb)),
    jsonb_build_array(jsonb_build_object('label', 'ext', 'ref_kind', 'url', 'url', 'https://example.com/c', 'audience', jsonb_build_array(tests.id('g_b')))),
    's1', 'curator/test')$$, '22023', null, 'the curator cannot name a group of another workspace');
select tests.mk('svc_ok', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"z"}'::jsonb)),
  jsonb_build_array(jsonb_build_object('label', 'ext', 'ref_kind', 'url', 'url', 'https://example.com/d', 'audience', jsonb_build_array(tests.id('g_fin')))),
  's1', 'curator/test');
select is(tests.esc('svc_ok'), true, 'the curator states the audience of external evidence (validated), which escalates');
select tests.as_user('agent');
select throws_ok($$insert into public.traces (space_id, principal_id, name, audience) values (tests.id('s1'), auth.uid(), 't', array[tests.id('g_b')])$$,
  '22023', null, 'traces cannot name a group of another workspace');
select throws_ok($$insert into public.traces (space_id, principal_id, name, audience) values (tests.id('s1'), auth.uid(), 't', array[gen_random_uuid()])$$,
  '22023', null, 'or an invented group');
select lives_ok($$insert into public.traces (space_id, principal_id, name, audience) values (tests.id('s1'), auth.uid(), 't', array[tests.id('g_fin')])$$,
  'a group of the workspace is fine');
select tests.as_service();
select throws_ok($$insert into public.sources (space_id, connector, name, audience) values (tests.id('s1'), 'web', 'bad-aud', array[tests.id('g_b')])$$,
  '22023', null, 'sources cannot name a group of another workspace');

-- ---------------------------------------------------------------------------------------------------------
-- #15 URL citations: no existence oracle, no soft-deleted documents
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
update public.source_documents set url = 'https://acme.slack.com/archives/C0FIN/p9' where id = tests.id('doc_fin');
select tests.as_user('s_editor');
select tests.mk('url_hidden', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"u"}'::jsonb)),
  '[{"label":"slack","ref_kind":"url","url":"https://acme.slack.com/archives/C0FIN/p9"}]');
select results_eq($$select ref_kind, ref_id from public.proposal_citations where proposal_id = tests.id('url_hidden')$$,
  $$values ('url'::public.citation_kind, null::uuid)$$, 'a restricted URL answers like an unknown URL for someone outside its audience');
select tests.as_user('fin_editor');
select tests.mk('url_fin', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"u"}'::jsonb)),
  '[{"label":"slack","ref_kind":"url","url":"https://acme.slack.com/archives/C0FIN/p9"}]');
select results_eq($$select ref_kind, ref_id from public.proposal_citations where proposal_id = tests.id('url_fin')$$,
  $$select 'source_document'::public.citation_kind, tests.id('doc_fin')$$, 'someone who can read it gets the document (and its audience)');
select tests.as_postgres();
update public.source_documents set deleted_at = now() where id = tests.id('doc_fin');
select tests.as_service();
select tests.mk('url_del', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"u"}'::jsonb)),
  '[{"label":"slack","ref_kind":"url","url":"https://acme.slack.com/archives/C0FIN/p9"}]', 's1', 'curator/test');
select is((select ref_kind from public.proposal_citations where proposal_id = tests.id('url_del')), 'url'::public.citation_kind,
  'a soft-deleted document no longer resolves');
select tests.as_user('fin_editor');
select throws_ok($$select tests.mk('del_ref', jsonb_build_array(jsonb_build_object('op', 'create', 'path', 'x/del')),
    jsonb_build_array(jsonb_build_object('label', 'd', 'ref_kind', 'source_document', 'ref_id', tests.id('doc_fin')))) $$,
  '42501', 'cited source_document not found', 'and cannot be cited by id');
select tests.as_postgres();
update public.source_documents set deleted_at = null where id = tests.id('doc_fin');

-- ---------------------------------------------------------------------------------------------------------
-- #18 group deletion: revisions and open citations protect a group; history does not trap it; retire_group
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
insert into public.groups (workspace_id, slug, name) values (tests.id('ws_a'), 'tmp-rev', 'Tmp') returning tests.put('g_rev_only', id);
insert into public.concept_revisions (concept_id, space_id, revision, path, kind, type, title, description, body, frontmatter, tags, status, audience, actor)
values (tests.id('c_pub'), tests.id('s1'), 100, 'metrics/active-users', 'domain', 'Metric', 'Old', '', 'old', '{}', '{}', 'stable',
        array[tests.id('g_rev_only')], 'import:test');
insert into public.groups (workspace_id, slug, name) values (tests.id('ws_a'), 'tmp-cit', 'Tmp') returning tests.put('g_cit_only', id);
select tests.as_service();
select tests.mk('cit_only', jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'after', '{"body":"c"}'::jsonb)),
  jsonb_build_array(jsonb_build_object('label', 'ext', 'ref_kind', 'url', 'url', 'https://example.com/e', 'audience', jsonb_build_array(tests.id('g_cit_only')))),
  's1', 'curator/test');
select tests.as_postgres();
insert into public.groups (workspace_id, slug, name) values (tests.id('ws_a'), 'tmp-hist', 'Tmp') returning tests.put('g_hist', id);
insert into public.traces (space_id, principal_id, name, audience) values (tests.id('s1'), tests.id('s_editor'), 'old', array[tests.id('g_hist')]);
insert into public.flags (space_id, created_by, kind, observation, audience, status)
values (tests.id('s1'), tests.id('s_editor'), 'missing', 'old', array[tests.id('g_hist')], 'resolved');
insert into public.source_documents (source_id, space_id, external_id, content, content_hash, audience, deleted_at)
values (tests.id('src_pub'), tests.id('s1'), 'gone', 'x', 'hg', array[tests.id('g_hist')], now());
select tests.as_user('admin_a');
select throws_ok($$delete from public.groups where id = tests.id('g_rev_only')$$, '23503', null, 'a group used by a concept revision cannot be deleted');
select throws_ok($$delete from public.groups where id = tests.id('g_cit_only')$$, '23503', null, 'nor one used by an open proposal''s citation');
select lives_ok($$delete from public.groups where id = tests.id('g_hist')$$, 'traces, closed flags and soft-deleted documents do not trap a group');

-- retire_group
select tests.as_user('member_a');
select throws_ok($$select public.retire_group(tests.id('g_rev_only'), tests.id('g_eng'))$$, '42501', null, 'members cannot retire groups');
select tests.as_oauth('admin_a');
select throws_ok($$select public.retire_group(tests.id('g_rev_only'), tests.id('g_eng'))$$, '42501', null, 'nor OAuth client tokens');
select tests.as_user('admin_a');
select throws_ok($$select public.retire_group(tests.id('g_rev_only'), tests.id('g_b'))$$, '22023', null, 'the replacement must be a group of the same workspace');
select throws_ok($$select public.retire_group(tests.id('g_rev_only'), null)$$, '22023', null, 'a replacement is required (never widens to everyone)');
select lives_ok($$select public.retire_group(tests.id('g_rev_only'), tests.id('g_eng'))$$, 'workspace admins retire a group');
select lives_ok($$select public.retire_group(tests.id('g_cit_only'), tests.id('g_fin'))$$, 'also one used by an open proposal');
select tests.as_postgres();
select is((select audience from public.concept_revisions where concept_id = tests.id('c_pub') and revision = 100), array[tests.id('g_eng')],
  'revision audiences name the replacement');
select is((select audience from public.proposal_citations where proposal_id = tests.id('cit_only')), array[tests.id('g_fin')],
  'citation audiences too');
select is_empty($$select 1 from public.groups where id in (tests.id('g_rev_only'), tests.id('g_cit_only'))$$, 'and the groups are gone');
select ok(exists (select 1 from public.audit_log where action = 'group.retired' and target_id = tests.id('g_rev_only')), 'audited');

-- ---------------------------------------------------------------------------------------------------------
-- #9 (storage) GC never removes live objects
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
update public.source_documents set deleted_at = now() where id = tests.id('doc_pub');
select isnt_empty($$select 1 from public.kf_storage_gc where prefix = tests.id('s1') || '/' || tests.id('src_pub') || '/m1.txt'$$,
  'soft-deleting a document queues its object');
update public.source_documents set deleted_at = null where id = tests.id('doc_pub');
select is_empty($$select 1 from public.kf_storage_gc where prefix = tests.id('s1') || '/' || tests.id('src_pub') || '/m1.txt'$$,
  'reviving it takes the object back out of the queue');
select tests.as_service();
select results_eq($$select name from public.kf_storage_gc_objects('sources', tests.id('s1') || '/' || tests.id('src_pub') || '/')$$,
  $$select tests.id('s1') || '/' || tests.id('src_pub') || '/orphan.txt'$$, 'a folder listing skips objects of live documents');
select is_empty($$select name from public.kf_storage_gc_objects('sources', tests.id('s1') || '/' || tests.id('src_pub') || '/m1.txt')$$,
  'an exact live object is never listed');
select is_empty($$select name from public.kf_storage_gc_objects('concept-files', tests.id('s1') || '/' || tests.id('c_pub') || '/')$$,
  'nor objects of existing concept files');
select tests.as_postgres();
grant execute on function public.kf_storage_gc_objects(text, text, text, int) to authenticated;
grant execute on function public.kf_revoke_user_sessions(uuid) to authenticated;
grant execute on function public.kf_strip_proposal_files(uuid, jsonb) to authenticated;
select tests.as_user('owner_a');
select throws_ok($$select * from public.kf_storage_gc_objects('sources', 'x/')$$, '42501', 'service role only',
  'kf_storage_gc_objects checks the service role itself (not only through grants)');
select throws_ok($$select public.kf_revoke_user_sessions(tests.id('agent'))$$, '42501', 'service role only', 'so does kf_revoke_user_sessions');
select throws_ok($$select public.kf_strip_proposal_files(gen_random_uuid(), '[]')$$, '42501', 'service role only', 'and kf_strip_proposal_files');
select tests.as_postgres();
revoke execute on function public.kf_storage_gc_objects(text, text, text, int) from authenticated;
revoke execute on function public.kf_revoke_user_sessions(uuid) from authenticated;
revoke execute on function public.kf_strip_proposal_files(uuid, jsonb) from authenticated;

-- kf_strip_proposal_files restores the caller's kf.defer_recompute
select tests.put('strip_op', (select o.id from public.proposal_ops o where o.proposal_id = tests.id('widen') limit 1));
update public.proposal_ops set after = after || '{"files":[{"path":"a.txt","content":"x"}]}' where id = tests.id('strip_op');
select tests.as_service();
select set_config('kf.defer_recompute', 'on', true);
select ok(public.kf_strip_proposal_files(tests.id('strip_op'), '[{"path":"a.txt","stripped":true}]'), 'files stripped');
select is(current_setting('kf.defer_recompute', true), 'on', 'the previous kf.defer_recompute value is restored');
select set_config('kf.defer_recompute', '', true);

-- ---------------------------------------------------------------------------------------------------------
-- #10 an agent's workspace membership goes only with the agent
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('owner_a');
select throws_ok($$delete from public.workspace_members where workspace_id = tests.id('ws_a') and user_id = tests.id('agent')$$, '42501', null,
  'removing an agent from its workspace directly is refused (it would leave an active agent behind)');
select tests.as_postgres();
select isnt_empty($$select 1 from public.space_members where user_id = tests.id('agent')$$, 'its space roles are untouched');
-- deleting the agent's Auth user (agents API delete) still cascades
select tests.mkuser('agent2', true);
insert into public.workspace_members (workspace_id, user_id, role) values (tests.id('ws_a'), tests.id('agent2'), 'member');
insert into public.agents (id, workspace_id, name) values (tests.id('agent2'), tests.id('ws_a'), 'bot-2');
select lives_ok($$delete from auth.users where id = tests.id('agent2')$$, 'deleting the agent''s Auth user works');
select is_empty($$select 1 from public.workspace_members where user_id = tests.id('agent2')$$, 'and removes its membership');
-- deleting the workspace still cascades
select tests.as_user('member_b');
select tests.put('ws_tmp', (public.create_workspace('tmp-agent-ws', 'Tmp')).id);
select tests.as_postgres();
select tests.mkuser('agent3', true);
insert into public.workspace_members (workspace_id, user_id, role) values (tests.id('ws_tmp'), tests.id('agent3'), 'member');
insert into public.agents (id, workspace_id, name) values (tests.id('agent3'), tests.id('ws_tmp'), 'bot-3');
select tests.as_user('member_b');
select lives_ok($$delete from public.workspaces where id = tests.id('ws_tmp')$$, 'deleting a workspace with an agent works');
select tests.as_postgres();
select is_empty($$select 1 from public.agents where id = tests.id('agent3') union all select 1 from auth.users where id = tests.id('agent3')$$,
  'and removes the agent');

-- ---------------------------------------------------------------------------------------------------------
-- #12 usage counts: only visible concepts; the service role sees them all
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_reader');
select is_empty($$select 1 from private.usage_counts(tests.id('s1'), now() - interval '1 day') where concept_id = tests.id('c_fin')$$,
  'readers outside finance get no usage count for a finance concept');
select tests.as_user('fin_reader');
select isnt_empty($$select 1 from private.usage_counts(tests.id('s1'), now() - interval '1 day') where concept_id = tests.id('c_fin')$$,
  'finance readers do');
select tests.as_service();
select isnt_empty($$select 1 from private.usage_counts(tests.id('s1'), now() - interval '1 day') where concept_id = tests.id('c_fin')$$,
  'the service role does');
select cmp_ok((public.knowledge_health(tests.id('s1')) ->> 'never_used')::int, '<', (public.knowledge_health(tests.id('s1')) ->> 'concepts')::int,
  'knowledge_health for the service role no longer reports every concept as never used');

-- ---------------------------------------------------------------------------------------------------------
-- #13 invitations: owners own owner invitations; the rate limit survives workspace deletion
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
update auth.users set email_confirmed_at = now() where id = tests.id('outsider');
select tests.as_user('owner_a');
select tests.put('inv_owner', (public.invite_to_workspace(tests.id('ws_a'), 'future-owner@example.com', 'owner')).id);
select tests.as_user('admin_a');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'future-owner@example.com', 'member')$$, '42501', null,
  'admins cannot downgrade (refresh) an owner invitation');
delete from public.workspace_invitations where id = tests.id('inv_owner');
select tests.as_postgres();
select is((select role::text from public.workspace_invitations where id = tests.id('inv_owner')), 'owner', 'nor revoke it');
select tests.as_user('owner_a');
delete from public.workspace_invitations where id = tests.id('inv_owner');
select is_empty($$select 1 from public.workspace_invitations where id = tests.id('inv_owner')$$, 'owners can');

select tests.as_user('outsider');
select tests.put('ws_burn', (public.create_workspace('burn-ws', 'Burn')).id);
select lives_ok($$select count(*) from (select public.invite_to_workspace(tests.id('ws_burn'), 'burn-' || g || '@example.com') from generate_series(1, 30) g) x$$,
  '30 invitations in an hour');
delete from public.workspaces where id = tests.id('ws_burn');
select tests.put('ws_burn2', (public.create_workspace('burn-ws2', 'Burn 2')).id);
select throws_ok($$select public.invite_to_workspace(tests.id('ws_burn2'), 'one-more@example.com')$$, 'PT429', null,
  'deleting the workspace does not reset the limit');

-- ---------------------------------------------------------------------------------------------------------
-- #15 concurrency, LC4 search, LC5 settings
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
select tests.matches((select prosrc from pg_proc where oid = 'private.on_evidence_audience_changed()'::regprocedure), 'order by p\.id',
  'open proposals are recomputed in id order (no AB-BA deadlocks)');
select tests.matches((select prosrc from pg_proc where oid = 'private.keep_an_owner()'::regprocedure), 'for no key update',
  'removing or demoting an owner locks the workspace row');
select tests.as_user('owner_a');
select throws_ok($$delete from public.workspace_members where workspace_id = tests.id('ws_a') and user_id = tests.id('owner_a')$$, '42501', null,
  'the last owner still cannot leave');
select tests.as_postgres();
select tests.matches((select prosrc from pg_proc where oid = 'public.search_knowledge(uuid,text,extensions.vector,public.concept_kind[],integer,boolean,uuid[],double precision)'::regprocedure),
  'c\.id = ch\.concept_id and c\.space_id = p_space', 'search CTEs start from the space');
select tests.as_user('s_admin');
select throws_ok($$update public.spaces set settings = '{"curator":{"stuck_after_minutes":9}}' where id = tests.id('s1')$$, '22023', null,
  'curator.stuck_after_minutes must be at least 10 (> the curator queue visibility timeout)');
select lives_ok($$update public.spaces set settings = '{"curator":{"stuck_after_minutes":10}}' where id = tests.id('s1')$$, '10 is accepted');

select * from finish();
rollback;
