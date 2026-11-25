-- Proposals: authoring rules (create_proposal), escalation guard, apply/reject/verify/revert, trust tiers.
begin;
\ir _fixture.psql
select plan(124);

grant insert on tests.ids to authenticated, service_role;

-- helpers run as the CURRENT role, so the RPC's own checks apply to them
create function tests.op(p_op text, p_path text, p_after jsonb default '{}', p_concept uuid default null, p_base int default null,
                         p_new_path text default null) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('op', p_op, 'path', p_path, 'after', p_after, 'concept_id', p_concept,
                                              'base_revision', p_base, 'new_path', p_new_path));
$$;
create function tests.cit(p_ref uuid, p_kind text default 'source_document', p_op_index int default null,
                          p_audience uuid[] default null, p_consulted boolean default null) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('label', 'cite-' || coalesce(p_ref::text, 'x'), 'ref_kind', p_kind, 'ref_id', p_ref,
                                              'op_index', p_op_index, 'audience', to_jsonb(p_audience), 'consulted', p_consulted));
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
create function tests.status(p_name text) returns public.proposal_status language sql security definer as $$
  select status from public.proposals where id = tests.id(p_name);
$$;
create function tests.trust(p_name text) returns public.trust_tier language sql security definer as $$
  select public.trust(c) from public.concepts c where c.id = tests.id(p_name);
$$;
create function tests.as_oauth(p text) returns void language plpgsql as $$
begin
  perform tests.as_user(p);
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(p), 'role', 'authenticated', 'client_id', 'mcp-client-123')::text, true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- A. authoring rules
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_editor');
select tests.mk('ed1', jsonb_build_array(tests.op('update', 'metrics/active-users', '{"body":"edited"}')), '[]', 's1', 'curator/gpt');
select results_eq($$select created_by, author, status, escalation, auto_applied, run_id from public.proposals where id = tests.id('ed1')$$,
  $$select tests.id('s_editor'), 'human:' || tests.id('s_editor'), 'pending'::public.proposal_status, false, false, null::uuid$$,
  'editor creates a human proposal as themselves (p_author ignored: cannot impersonate the curator)');
select is((select count(*)::int from public.proposal_ops where proposal_id = tests.id('ed1')), 1, 'ops are created with the proposal');
select throws_ok($$insert into public.proposals (space_id, author, title) values (tests.id('s1'), 'human:' || auth.uid(), 'x')$$,
  '42501', null, 'no direct proposal inserts (create_proposal only)');
select throws_ok($$insert into public.proposal_ops (proposal_id, ord, op, path) values (tests.id('ed1'), 5, 'create', 'x/y')$$,
  '42501', null, 'no direct op inserts, even on your own proposal');
select throws_ok($$insert into public.proposal_citations (proposal_id, label, ref_kind) values (tests.id('ed1'), 'x', 'url')$$,
  '42501', null, 'no direct citation inserts');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/y')), '[]', 's2')$$, '42501', null, 'cannot propose in a foreign space');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/fin', jsonb_build_object('audience', array[tests.id('g_fin')]))))$$,
  '42501', null, 'cannot write to an audience you are not in');
select throws_ok($$select tests.mk('x', '[]'::jsonb)$$, '22023', null, 'a proposal needs at least one op');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', '../evil')))$$, '22023', null, 'invalid paths are refused');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('move', 'metrics/active-users', '{}', null, null, 'a/../b')))$$,
  '22023', null, 'invalid move targets are refused');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/t', '{"tags":"not-an-array"}')))$$, '22023', null,
  'after.tags must be an array');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/t', '{"frontmatter":[1]}')))$$, '22023', null,
  'after.frontmatter must be an object');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/t', '{"kind":"nope"}')))$$, '22023', null, 'after.kind must be valid');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('explode', 'x/t')))$$, '22023', null, 'unknown op kinds are refused');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/t', jsonb_build_object('audience', array[tests.id('g_b')]))))$$,
  '22023', null, 'audience groups must belong to the workspace');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/t')), jsonb_build_array(tests.cit(tests.id('doc_pub'), 'source_document', 3)))$$,
  '22023', null, 'citation op_index must point at an op');
select is_empty($$select 1 from public.proposals where title = 'x'$$, 'failed create_proposal calls leave nothing behind');
select throws_ok($$insert into public.proposal_reviews (proposal_id, decision) values (tests.id('prop_pub'), 'approve')$$, '42501', null, 'cannot insert an approve review');
insert into public.proposal_reviews (proposal_id, decision, note) values (tests.id('prop_pub'), 'comment', 'lgtm?');
select ok(exists (select 1 from public.proposal_reviews where proposal_id = tests.id('prop_pub') and reviewer = tests.id('s_editor')), 'editors can comment');
select throws_ok($$update public.proposals set status = 'approved', escalation = true where id = tests.id('ed1')$$, '42501', null, 'no column of a proposal is directly updatable');
delete from public.proposals where id = tests.id('ed1');
select tests.as_postgres();
select results_eq($$select status, escalation from public.proposals where id = tests.id('ed1')$$, $$values ('pending'::public.proposal_status, false)$$,
  'proposals cannot be updated or deleted directly');
select tests.as_user('agent');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/y')))$$, '42501', null, 'readers (agents) cannot propose');
select tests.as_postgres();
update public.space_members set role = 'editor' where space_id = tests.id('s1') and user_id = tests.id('agent');
select tests.as_user('agent');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/y')))$$, '42501', null, 'agents cannot propose even as editors');
select tests.as_oauth('s_editor');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/y')))$$, '42501', null, 'OAuth client tokens cannot propose');
select tests.as_service();
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/y')))$$, '22023', null, 'service role must name the author');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/y')), '[]', 's1', 'human:' || gen_random_uuid())$$, '22023', null,
  'service role cannot author as a human');
select tests.mk('svc1', jsonb_build_array(tests.op('create', 'x/svc')), '[]', 's1', 'curator/test');
select results_eq($$select author, created_by from public.proposals where id = tests.id('svc1')$$, $$values ('curator/test', null::uuid)$$,
  'service role authors curator proposals');
select tests.as_postgres();
update public.space_members set role = 'reader' where space_id = tests.id('s1') and user_id = tests.id('agent');

-- ---------------------------------------------------------------------------------------------------------
-- B. escalation is computed (from live evidence), and cannot be bypassed
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('fin_editor');
select tests.mk('p1', jsonb_build_array(tests.op('create', 'metrics/new', '{"title":"New","body":"from finance"}')),
  jsonb_build_array(tests.cit(tests.id('doc_fin'))));
select results_eq($$select escalation, risk from public.proposals where id = tests.id('p1')$$, $$values (true, 'high'::public.proposal_risk)$$,
  'restricted citation (no op_index) into a public target escalates and sets risk high');
select tests.mk('p2', jsonb_build_array(tests.op('create', 'metrics/new2')), jsonb_build_array(tests.cit(tests.id('doc_fin'), 'source_document', 0)));
select is(tests.esc('p2'), true, 'restricted citation bound to the op escalates');
select is((select op_id from public.proposal_citations where proposal_id = tests.id('p2')),
          (select id from public.proposal_ops where proposal_id = tests.id('p2')), 'op_index maps to the op id');
select tests.mk('p3', jsonb_build_array(tests.op('create', 'metrics/new3')), jsonb_build_array(tests.cit(tests.id('doc_fin'), 'source_document', null, null, true)));
select results_eq($$select escalation, (select consulted from public.proposal_citations where proposal_id = tests.id('p3')) from public.proposals where id = tests.id('p3')$$,
  $$values (true, true)$$, 'consulted (read but not cited) evidence escalates like a citation');
select tests.mk('p4', jsonb_build_array(tests.op('update', 'finance/arr', '{"audience":[]}', null, 1)));
select is(tests.esc('p4'), true, 'widening an existing restricted concept escalates');
select tests.mk('p5', jsonb_build_array(tests.op('update', 'metrics/active-users', jsonb_build_object('audience', array[tests.id('g_fin')], 'body', 'narrowed'))),
  jsonb_build_array(tests.cit(tests.id('doc_fin'))));
select is(tests.esc('p5'), false, 'narrowing to the evidence audience is not an escalation');
select tests.mk('p6', jsonb_build_array(tests.op('update', 'finance/arr', '{"body":"ARR is 44M"}', null, 1)), jsonb_build_array(tests.cit(tests.id('doc_fin'))));
select is(tests.esc('p6'), false, 'restricted evidence into a same-audience concept is not an escalation');
select is((select target_audience from public.proposal_ops where proposal_id = tests.id('p6')), array[tests.id('g_fin')],
  'target_audience defaults to the concept audience');
select tests.mk('p8', jsonb_build_array(tests.op('create', 'metrics/leak2', '{"body":"finance numbers, now public"}')),
  jsonb_build_array(tests.cit(tests.id('doc_fin'), 'source_document', null, '{}'::uuid[])));
select is(tests.esc('p8'), true, 'citation audience is derived from the cited evidence, not trusted from the client');

select throws_ok($$update public.proposals set escalation = false where id = tests.id('p1')$$, '42501', null, 'escalation is not writable');
select throws_ok($$update public.proposal_ops set target_audience = array[tests.id('g_fin')] where proposal_id = tests.id('p1')$$, '42501', null, 'ops are not writable after insert');
delete from public.proposal_citations where proposal_id = tests.id('p1');
delete from public.proposal_ops where proposal_id = tests.id('p1');
select is(tests.esc('p1'), true, 'escalation cannot be cleared by updating the proposal or deleting/changing children');
select tests.as_postgres();
select is((select count(*)::int from public.proposal_ops where proposal_id = tests.id('p1') and target_audience = '{}'), 1, 'ops are immutable for authors');

-- URL citations: a URL that is a document of the space IS that document (curator citing by URL cannot strip
-- the audience)
update public.source_documents set url = 'https://acme.slack.com/archives/C0FIN/p1' where id = tests.id('doc_fin');
select tests.as_service();
select tests.mk('u1', jsonb_build_array(tests.op('update', 'metrics/active-users', '{"body":"$99.9M"}', null, 1)),
  '[{"label":"slack","ref_kind":"url","url":"https://acme.slack.com/archives/C0FIN/p1"}]', 's1', 'curator/test');
select results_eq($$select c.ref_kind, c.ref_id, c.audience, p.escalation from public.proposal_citations c join public.proposals p on p.id = c.proposal_id where p.id = tests.id('u1')$$,
  $$select 'source_document'::public.citation_kind, tests.id('doc_fin'), array[tests.id('g_fin')], true$$, 'URL citation resolved to the restricted document; escalates');
select throws_ok($$select public.apply_proposal(tests.id('u1'), null, 'curator/test')$$, '42501', null, 'and cannot be auto-applied');
select tests.mk('u2', jsonb_build_array(tests.op('update', 'metrics/active-users', '{"body":"x"}', null, 1)),
  '[{"label":"ext","url":"https://example.com/blog"}]', 's1', 'curator/test');
select results_eq($$select c.ref_kind, c.ref_id, p.escalation from public.proposal_citations c join public.proposals p on p.id = c.proposal_id where p.id = tests.id('u2')$$,
  $$values ('url'::public.citation_kind, null::uuid, false)$$, 'external URLs stay URL citations');

-- citations only of evidence the author can see; one error for missing, hidden and foreign
select tests.as_user('s_editor');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/a')), jsonb_build_array(tests.cit(tests.id('tr_agent'), 'trace')))$$,
  '42501', 'cited trace not found', 'editors cannot cite other principals'' traces');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/a')), jsonb_build_array(tests.cit(gen_random_uuid(), 'trace')))$$,
  '42501', 'cited trace not found', 'missing trace: same error');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/a')), jsonb_build_array(tests.cit(tests.id('doc_fin'))))$$,
  '42501', 'cited source_document not found', 'restricted document: same error as a missing one (no existence oracle)');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/a')), jsonb_build_array(tests.cit(gen_random_uuid())))$$,
  '42501', 'cited source_document not found', 'missing document');
select throws_ok($$select tests.mk('x', jsonb_build_array(tests.op('create', 'x/a')), jsonb_build_array(tests.cit(tests.id('doc_b'))))$$,
  '42501', 'cited source_document not found', 'foreign document');
select tests.mk('own_tr', jsonb_build_array(tests.op('create', 'x/own')), jsonb_build_array(tests.cit(tests.id('tr_editor'), 'trace')));
select ok(tests.id('own_tr') is not null, 'editors can cite their own traces');

-- live evidence audience: reclassifying evidence after drafting is seen by visibility, escalation and apply
select tests.mk('live1', jsonb_build_array(tests.op('update', 'metrics/active-users', '{"body":"from general"}', null, 1)),
  jsonb_build_array(tests.cit(tests.id('doc_pub'))));
select tests.as_postgres();
update public.source_documents set audience = array[tests.id('g_fin')] where id = tests.id('doc_pub');
select tests.as_user('s_reviewer');
select is_empty($$select 1 from public.proposals where id = tests.id('live1')$$, 'a proposal citing reclassified evidence is hidden from reviewers outside its audience');
select throws_ok($$select public.apply_proposal(tests.id('live1'))$$, '42501', null, 'and they cannot apply it');
select tests.as_user('fin_reviewer');
select throws_ok($$select public.apply_proposal(tests.id('live1'))$$, '42501', null, 'it is now an escalation: a reviewer in finance cannot apply it either');
select is(tests.esc('live1'), true, 'escalation recomputed from the live evidence audience');
select tests.as_postgres();
update public.source_documents set audience = '{}' where id = tests.id('doc_pub');

-- a proposal without ops is visible to nobody and never applied (inserted directly by the service role)
insert into public.proposals (space_id, author, title, rationale) values (tests.id('s1'), 'curator/test', 'SECRET title', 'SECRET rationale')
returning tests.put('empty', id);
select tests.as_user('fin_admin');
select is_empty($$select 1 from public.proposals where id = tests.id('empty')$$, 'proposals without ops are invisible');
select tests.as_service();
select throws_ok($$select public.apply_proposal(tests.id('empty'))$$, '22023', null, 'proposals without ops cannot be applied');

-- ---------------------------------------------------------------------------------------------------------
-- C. apply / reject / verify
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_editor');
select throws_ok($$select public.apply_proposal(tests.id('prop_pub'))$$, '42501', null, 'editors cannot apply');
select throws_ok($$select public.reject_proposal(tests.id('prop_pub'), 'no')$$, '42501', null, 'editors cannot reject');
select tests.as_oauth('s_reviewer');
select throws_ok($$select public.apply_proposal(tests.id('prop_pub'))$$, '42501', null, 'OAuth client tokens cannot apply');
select throws_ok($$select public.reject_proposal(tests.id('prop_pub'), 'no')$$, '42501', null, 'OAuth client tokens cannot reject');
select throws_ok($$select public.verify_concept(tests.id('c_pub'))$$, '42501', null, 'OAuth client tokens cannot verify');
select tests.as_user('s_reviewer');
select is((public.apply_proposal(tests.id('prop_pub'), 'looks right')).status, 'applied', 'reviewer applies a proposal they can fully see');
select ok(exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()), 'apply holds the per-space advisory lock until commit');
select tests.as_postgres();
select results_eq($$select revision, body, generated_by from public.concepts where id = tests.id('c_pub')$$,
  $$select 2, 'Active = logged in within 28 days.', 'human:' || tests.id('s_reviewer')$$, 'concept updated, revision bumped');
select results_eq($$select actor, proposal_id from public.concept_revisions where concept_id = tests.id('c_pub') and revision = 2$$,
  $$select 'human:' || tests.id('s_reviewer'), tests.id('prop_pub')$$, 'revision recorded with actor and proposal');
select is(tests.trust('c_pub'), 'human_reviewed', 'human apply verifies the new revision');
select results_eq($$select status, resolved_by from public.flags where id = tests.id('flag_pub')$$, $$select 'resolved'::public.flag_status, tests.id('s_reviewer')$$, 'linked flags resolved');
select ok(exists (select 1 from public.proposal_reviews where proposal_id = tests.id('prop_pub') and decision = 'approve' and reviewer = tests.id('s_reviewer')), 'approve review recorded');
select ok(exists (select 1 from public.audit_log where target_id = tests.id('prop_pub') and action = 'proposal.applied'), 'audited');
select tests.as_user('s_reviewer');
select throws_ok($$select public.apply_proposal(tests.id('prop_pub'))$$, '22023', null, 'cannot apply twice');
select throws_ok($$select public.reject_proposal(tests.id('prop_pub'), 'x')$$, '22023', null, 'cannot reject an applied proposal');
select throws_ok($$select public.apply_proposal(tests.id('p5'))$$, '42501', null, 'reviewer outside finance cannot apply proposal citing finance evidence');
select tests.as_user('grp_reviewer');
select throws_ok($$select public.apply_proposal(tests.id('p6'))$$, '42501', null, 'group reviewer outside finance cannot apply it either');

-- escalations need a space admin, and never the service role
select tests.as_user('fin_reviewer');
select throws_ok($$select public.apply_proposal(tests.id('p8'))$$, '42501', null, 'reviewer cannot apply an escalation');
select tests.as_service();
select throws_ok($$select public.apply_proposal(tests.id('p8'))$$, '42501', null, 'service role cannot apply an escalation');
select throws_ok($$select public.apply_proposal(tests.id('p4'))$$, '42501', null, 'service role cannot apply a widening');
select throws_ok($$select public.apply_proposal(tests.id('p6'), null, 'human:' || gen_random_uuid())$$, '22023', null, 'service role cannot apply as a human');
select tests.as_user('fin_admin');
select is((public.apply_proposal(tests.id('p8'))).status, 'applied', 'space admin in audience applies the escalation');
select tests.as_postgres();
select is((select audience from public.concepts where space_id = tests.id('s1') and path = 'metrics/leak2'), '{}'::uuid[], 'created with the target audience');

-- service role (policy auto-apply)
select tests.as_service();
select results_eq($$select status, auto_applied from public.apply_proposal(tests.id('p6'), null, 'curator/test-model')$$,
  $$values ('applied'::public.proposal_status, true)$$, 'service role auto-applies a non-escalation');
select tests.as_postgres();
select results_eq($$select revision, generated_by, body from public.concepts where id = tests.id('c_fin')$$, $$values (2, 'curator/test-model', 'ARR is 44M')$$, 'applied with the curator actor');
select is(tests.trust('c_fin'), 'unverified', 'old human verification does not carry over to a new revision');
insert into public.verifications (concept_id, space_id, revision, actor) values (tests.id('c_fin'), tests.id('s1'), 2, 'curator/test-model');
select is(tests.trust('c_fin'), 'machine_confirmed', 'machine verification of the current revision');
select tests.as_user('fin_reviewer');
select ok((public.verify_concept(tests.id('c_fin'), 'checked')).revision = 2, 'reviewer in audience verifies the current revision');
select is(tests.trust('c_fin'), 'human_reviewed', 'human verification of the current revision');
select throws_ok($$insert into public.verifications (concept_id, space_id, revision, actor) values (tests.id('c_pub'), tests.id('s1'), 2, 'human:x')$$,
  '42501', null, 'no direct verification inserts');
select throws_ok($$insert into public.concepts (space_id, path, kind, type, title) values (tests.id('s1'), 'direct', 'domain', 'x', 'x')$$,
  '42501', null, 'no direct concept inserts');
update public.concepts set body = 'direct edit' where id = tests.id('c_fin');
select tests.as_user('s_editor');
select throws_ok($$select public.verify_concept(tests.id('c_pub'))$$, '42501', null, 'editors cannot verify');
select tests.as_service();
select throws_ok($$select public.verify_concept(tests.id('c_pub'))$$, '42501', null, 'service role cannot forge a human verification');
select tests.as_postgres();
select is((select body from public.concepts where id = tests.id('c_fin')), 'ARR is 44M', 'no direct concept updates');

-- agents with the reviewer role: machine trust, never escalations
update public.space_members set role = 'reviewer' where space_id = tests.id('s1') and user_id = tests.id('agent');
select tests.as_user('s_editor');
select tests.mk('ag1', jsonb_build_array(tests.op('update', 'metrics/active-users', '{"body":"agent applied"}', null, 2)));
select tests.as_user('agent');
select is((public.apply_proposal(tests.id('ag1'))).status, 'applied', 'an agent reviewer applies a non-escalation');
select tests.as_postgres();
select results_eq($$select generated_by from public.concepts where id = tests.id('c_pub')$$, $$select 'agent:' || tests.id('agent')$$,
  'agents apply as agent:<uid>');
select is(tests.trust('c_pub'), 'machine_confirmed', 'an agent apply is a machine confirmation, never human_reviewed');
select tests.as_user('agent');
select is((public.verify_concept(tests.id('c_pub'))).actor, 'agent:' || tests.id('agent'), 'agents verify as agent:<uid>');
select is(tests.trust('c_pub'), 'machine_confirmed', 'agent verification stays machine_confirmed');
select tests.as_user('s_editor');
select tests.mk('ag2', jsonb_build_array(tests.op('create', 'x/agent-esc')), jsonb_build_array(tests.cit(tests.id('doc_pub'))));
select tests.as_postgres();
update public.source_documents set audience = array[tests.id('g_eng')] where id = tests.id('doc_pub');
insert into public.group_members (group_id, user_id) values (tests.id('g_eng'), tests.id('agent'));
select tests.as_user('agent');
select throws_ok($$select public.apply_proposal(tests.id('ag2'))$$, '42501', null, 'agents never approve escalations');
select tests.as_postgres();
update public.source_documents set audience = '{}' where id = tests.id('doc_pub');
delete from public.group_members where group_id = tests.id('g_eng') and user_id = tests.id('agent');
update public.space_members set role = 'reader' where space_id = tests.id('s1') and user_id = tests.id('agent');

-- conflicts: nothing half-applied; path collisions report the same reason whether visible or not
select tests.as_user('fin_editor');
select tests.mk('p9', jsonb_build_array(tests.op('update', 'metrics/active-users', '{"body":"half applied?"}', null, 3),
                                        tests.op('update', 'finance/arr', '{"body":"stale"}', null, 1)));
select tests.mk('p10', jsonb_build_array(tests.op('create', 'metrics/active-users', '{"body":"dup"}')));
select tests.as_user('fin_admin');
select is((public.apply_proposal(tests.id('p9'))).status, 'conflicted', 'base_revision mismatch -> conflicted');
select is((public.apply_proposal(tests.id('p10'))).status, 'conflicted', 'create on an existing path -> conflicted');
select tests.as_postgres();
select results_eq($$select revision, body from public.concepts where id = tests.id('c_pub')$$, $$values (3, 'agent applied')$$,
  'the valid op of a conflicted proposal was not applied');
select is_empty($$select 1 from public.concept_revisions where proposal_id in (tests.id('p9'), tests.id('p10'))$$, 'no revisions from conflicted proposals');
select tests.as_user('s_editor');
select tests.mk('hid', jsonb_build_array(tests.op('create', 'finance/arr', '{"body":"probe"}')));
select tests.as_user('s_reviewer');
select results_eq($$select status, review_note::jsonb -> 0 ->> 'reason' from public.apply_proposal(tests.id('hid'))$$,
  $$values ('conflicted'::public.proposal_status, 'path is not available')$$, 'a hidden path collides with the same reason as a visible one');
select tests.as_user('fin_reviewer');
select is((public.reject_proposal(tests.id('p9'), 'stale')).status, 'rejected', 'conflicted proposals can be rejected');

-- payload edge cases: JSON nulls keep the current value instead of crashing or writing JSON null
select tests.as_service();
select tests.mk('nulls', jsonb_build_array(tests.op('update', 'metrics/active-users', '{"frontmatter":null,"tags":null,"title":null}')),
  '[]', 's1', 'curator/test');
select is((public.apply_proposal(tests.id('nulls'), null, 'curator/test')).status, 'applied', 'null frontmatter/tags/title apply cleanly');
select tests.as_postgres();
select results_eq($$select frontmatter, tags, title from public.concepts where id = tests.id('c_pub')$$,
  $$values ('{}'::jsonb, '{}'::text[], 'Active users')$$, 'and keep the current values');

-- move clears links that pointed at the old path and binds links to the new path
select tests.as_service();
select tests.mk('mv', jsonb_build_array(tests.op('move', 'metrics/active-users', '{}', null, null, 'metrics/users')), '[]', 's1', 'curator/test');
select is((public.apply_proposal(tests.id('mv'), null, 'curator/test')).status, 'applied', 'move applied');
select tests.as_postgres();
select is((select to_concept from public.concept_links where from_concept = tests.id('c_fin') and to_path = 'metrics/active-users'), null::uuid,
  'links to the old path no longer resolve to the moved concept');

-- reject reopens flags
update public.flags set status = 'in_proposal', proposal_id = tests.id('ed1') where id = tests.id('flag_pub');
select tests.as_user('s_reviewer');
select is((public.reject_proposal(tests.id('ed1'), 'not needed')).status, 'rejected', 'reviewer rejects');
select tests.as_postgres();
select results_eq($$select status, proposal_id from public.flags where id = tests.id('flag_pub')$$, $$values ('open'::public.flag_status, null::uuid)$$,
  'reject puts linked flags back in the pool');
select ok(exists (select 1 from public.proposal_reviews where proposal_id = tests.id('ed1') and decision = 'reject'), 'reject review recorded');

-- ---------------------------------------------------------------------------------------------------------
-- D. propose_revert
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_reader');
select throws_ok($$select public.propose_revert(tests.id('c_pub'), 1)$$, '42501', null, 'readers cannot propose reverts');
select tests.as_user('outsider');
select throws_ok($$select public.propose_revert(tests.id('c_pub'), 1)$$, '42501', null, 'outsiders cannot propose reverts');
select tests.as_user('s_editor');
select throws_ok($$select public.propose_revert(tests.id('c_pub'), 9)$$, 'P0002', null, 'unknown revision');
select tests.put('rev1', (public.propose_revert(tests.id('c_pub'), 1)).id);
select results_eq($$select p.author, o.base_revision, o.after ->> 'body' from public.proposals p join public.proposal_ops o on o.proposal_id = p.id where p.id = tests.id('rev1')$$,
  $$select 'human:' || tests.id('s_editor'), 5, 'Public revenue definition. See [ARR](finance/arr).'$$, 'revert proposal restores the old revision as a normal proposal');

-- reverting cannot copy content out of a revision whose audience you are not in
select tests.as_postgres();
do $$
declare v uuid;
begin
  insert into public.concepts (space_id, path, kind, type, title, body, audience, revision)
  values (tests.id('s1'), 'finance/plan', 'domain', 'Plan', 'Plan', 'Sanitised plan', '{}', 2) returning id into v;
  perform tests.put('c_leak', v);
  insert into public.concept_revisions (concept_id, space_id, revision, path, kind, type, title, description, body, frontmatter, tags, status, audience, actor)
  values (v, tests.id('s1'), 1, 'finance/plan', 'domain', 'Plan', 'Plan', '', 'SECRET layoffs in Q3', '{}', '{}', 'stable', array[tests.id('g_fin')], 'import:test'),
         (v, tests.id('s1'), 2, 'finance/plan', 'domain', 'Plan', 'Plan', '', 'Sanitised plan', '{}', '{}', 'stable', '{}', 'human:x');
end $$;
select tests.as_user('s_editor');
select throws_ok($$select public.propose_revert(tests.id('c_leak'), 1)$$, '42501', null, 'cannot revert to a revision whose audience you are not in');
select is_empty($$select 1 from public.proposal_ops where after::text like '%SECRET%'$$, 'restricted revision content never reaches an editor outside its audience');
-- a finance editor reverting restores the revision's audience too (not the current, wider one)
select tests.as_user('fin_editor');
select tests.put('rev_fin', (public.propose_revert(tests.id('c_leak'), 1)).id);
select results_eq($$select o.target_audience, p.escalation from public.proposal_ops o join public.proposals p on p.id = o.proposal_id where p.id = tests.id('rev_fin')$$,
  $$select array[tests.id('g_fin')], false$$, 'revert target audience is the revision''s audience (narrowing, no escalation)');
select tests.as_user('fin_admin');
select is((public.apply_proposal(tests.id('rev_fin'))).status, 'applied', 'finance admin applies the revert');
select tests.as_user('s_reader');
select is_empty($$select 1 from public.concepts where id = tests.id('c_leak')$$, 'the reverted restricted content stays restricted');

-- ---------------------------------------------------------------------------------------------------------
-- E. targeting concepts the author / reviewer cannot see
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_editor');
select throws_ok($$select tests.mk('e1', jsonb_build_array(tests.op('update', 'finance/arr', '{"audience":[]}')))$$, '42501', 'concept finance/arr not found',
  'editors cannot target a concept outside their audience (same error as a missing concept)');
select throws_ok($$select tests.mk('e1', jsonb_build_array(tests.op('update', 'no/such')))$$, '42501', 'concept no/such not found', 'missing concept');
select tests.as_service();
select tests.mk('e1b', jsonb_build_array(tests.op('update', 'finance/arr', '{"audience":[]}')), '[]', 's1', 'curator/test');
select tests.as_user('s_admin');
select throws_ok($$select public.apply_proposal(tests.id('e1b'))$$, '42501', null,
  'an admin outside the audience cannot apply a proposal that touches a restricted concept');
select tests.as_postgres();
select is((select audience from public.concepts where id = tests.id('c_fin')), array[tests.id('g_fin')], 'finance concept was not widened by people outside finance');

-- a stale proposal cannot widen a concept that was restricted after it was drafted
select tests.as_user('s_editor');
select tests.mk('e2', jsonb_build_array(tests.op('update', 'metrics/users', '{"body":"edited"}')));
select tests.as_postgres();
update public.concepts set audience = array[tests.id('g_fin')] where id = tests.id('c_pub');
select tests.as_user('s_reviewer');
select throws_ok($$select public.apply_proposal(tests.id('e2'))$$, '42501', null, 'a stale proposal cannot widen a concept that was restricted after drafting');
select tests.as_postgres();
update public.concepts set audience = '{}' where id = tests.id('c_pub');

-- a proposal in workspace B cannot modify a concept in workspace A
select tests.as_user('owner_b');
select throws_ok($$select tests.mk('x1', jsonb_build_array(tests.op('update', 'whatever', '{"body":"pwned by B"}', tests.id('c_open'))), '[]', 's2')$$,
  '42501', null, 'ops cannot point at a concept of another space');
select tests.as_postgres();
select is((select body from public.concepts where id = tests.id('c_open')), 'Open revenue handbook', 'a proposal in workspace B cannot modify a concept in workspace A');

select * from finish();
rollback;
