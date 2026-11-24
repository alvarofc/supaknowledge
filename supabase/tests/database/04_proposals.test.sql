-- Proposals: authoring rules, escalation guard, apply/reject/verify/revert, trust tiers.
begin;
\ir _fixture.psql
select plan(78);

grant insert on tests.ids to authenticated, service_role;

-- helpers run as the CURRENT role, so RLS applies to them
create function tests.new_prop(p_name text, p_space text default 's1') returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.proposals (space_id, author, title)
  values (tests.id(p_space), 'human:' || auth.uid(), p_name) returning id into v;
  perform tests.put(p_name, v);
  return v;
end;
$$;
create function tests.add_op(p_prop text, p_ord int, p_op public.proposal_op_kind, p_path text, p_after jsonb default '{}',
                             p_concept uuid default null, p_base int default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.proposal_ops (proposal_id, ord, op, path, after, concept_id, base_revision)
  values (tests.id(p_prop), p_ord, p_op, p_path, p_after, p_concept, p_base) returning id into v;
  return v;
end;
$$;
create function tests.add_cit(p_prop text, p_ref uuid, p_audience uuid[], p_op uuid default null) returns void language plpgsql as $$
begin
  insert into public.proposal_citations (proposal_id, op_id, label, ref_kind, ref_id, audience)
  values (tests.id(p_prop), p_op, 'cite-' || p_prop, 'source_document', p_ref, p_audience);
end;
$$;
create function tests.esc(p_name text) returns boolean language sql security definer as $$
  select escalation from public.proposals where id = tests.id(p_name);
$$;
create function tests.status(p_name text) returns public.proposal_status language sql security definer as $$
  select status from public.proposals where id = tests.id(p_name);
$$;
create function tests.concept(p_name text) returns public.concepts language sql security definer as $$
  select * from public.concepts where id = tests.id(p_name);
$$;
create function tests.trust(p_name text) returns public.trust_tier language sql security definer as $$
  select public.trust(c) from public.concepts c where c.id = tests.id(p_name);
$$;

-- ---------------------------------------------------------------------------------------------------------
-- A. authoring rules
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_editor');
select tests.new_prop('ed1');
select results_eq($$select created_by, author, status, escalation, auto_applied from public.proposals where id = tests.id('ed1')$$,
  $$select tests.id('s_editor'), 'human:' || tests.id('s_editor'), 'pending'::public.proposal_status, false, false$$, 'editor creates a human proposal as themselves');
select throws_ok($$insert into public.proposals (space_id, author, title) values (tests.id('s1'), 'curator/gpt', 'x')$$, '42501', null, 'cannot impersonate the curator');
select throws_ok($$insert into public.proposals (space_id, author, title) values (tests.id('s1'), 'human:' || tests.id('s_admin'), 'x')$$, '42501', null, 'author must be yourself');
select throws_ok($$insert into public.proposals (space_id, author, created_by, title) values (tests.id('s1'), 'human:' || auth.uid(), tests.id('s_admin'), 'x')$$, '42501', null, 'created_by must be yourself');
select throws_ok($$insert into public.proposals (space_id, author, title, escalation) values (tests.id('s1'), 'human:' || auth.uid(), 'x', true)$$, '42501', null, 'cannot set escalation');
select throws_ok($$insert into public.proposals (space_id, author, title, status) values (tests.id('s1'), 'human:' || auth.uid(), 'x', 'approved')$$, '42501', null, 'cannot set status');
select throws_ok($$insert into public.proposals (space_id, author, title, auto_applied) values (tests.id('s1'), 'human:' || auth.uid(), 'x', true)$$, '42501', null, 'cannot set auto_applied');
select throws_ok($$insert into public.proposals (space_id, author, title) values (tests.id('s2'), 'human:' || auth.uid(), 'x')$$, '42501', null, 'cannot propose in a foreign space');
select throws_ok($$select tests.add_op('ed1', 0, 'create', 'x/fin', jsonb_build_object('audience', array[tests.id('g_fin')]))$$, '42501', null,
  'cannot write to an audience you are not in');
select throws_ok($$insert into public.proposal_ops (proposal_id, ord, op, path) values (tests.id('prop_pub'), 5, 'create', 'x/y')$$, '42501', null, 'cannot add ops to someone else''s proposal');
select throws_ok($$insert into public.proposal_citations (proposal_id, label, ref_kind) values (tests.id('prop_pub'), 'x', 'url')$$, '42501', null, 'cannot add citations to someone else''s proposal');
select throws_ok($$insert into public.proposal_reviews (proposal_id, decision) values (tests.id('prop_pub'), 'approve')$$, '42501', null, 'cannot insert an approve review');
insert into public.proposal_reviews (proposal_id, decision, note) values (tests.id('prop_pub'), 'comment', 'lgtm?');
select ok(exists (select 1 from public.proposal_reviews where proposal_id = tests.id('prop_pub') and reviewer = tests.id('s_editor')), 'editors can comment');
select throws_ok($$update public.proposals set status = 'approved', escalation = true where id = tests.id('ed1')$$, '42501', null, 'no column of a proposal is directly updatable');
delete from public.proposals where id = tests.id('ed1');
select tests.as_postgres();
select results_eq($$select status, escalation from public.proposals where id = tests.id('ed1')$$, $$values ('pending'::public.proposal_status, false)$$,
  'proposals cannot be updated or deleted directly');
select tests.as_user('agent');
select throws_ok($$insert into public.proposals (space_id, author, title) values (tests.id('s1'), 'human:' || auth.uid(), 'x')$$, '42501', null, 'readers (agents) cannot propose');

-- ---------------------------------------------------------------------------------------------------------
-- B. escalation is computed, and cannot be bypassed
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('fin_editor');
select tests.new_prop('p1');
select tests.add_op('p1', 0, 'create', 'metrics/new', '{"title":"New","body":"from finance"}');
select tests.add_cit('p1', tests.id('doc_fin'), array[tests.id('g_fin')]);
select results_eq($$select escalation, risk from public.proposals where id = tests.id('p1')$$, $$values (true, 'high'::public.proposal_risk)$$,
  'restricted citation (op_id null) into a public target escalates and sets risk high');

select tests.new_prop('p2');
select tests.put('p2_op', tests.add_op('p2', 0, 'create', 'metrics/new2', '{}'));
select tests.add_cit('p2', tests.id('doc_fin'), array[tests.id('g_fin')], tests.id('p2_op'));
select is(tests.esc('p2'), true, 'restricted citation bound to the op escalates');

select tests.new_prop('p3');
select tests.add_cit('p3', tests.id('doc_fin'), array[tests.id('g_fin')]);
select is(tests.esc('p3'), false, 'citation alone (no ops yet) is not an escalation');
select tests.add_op('p3', 0, 'create', 'metrics/new3', '{}');
select is(tests.esc('p3'), true, 'adding the op after the citation escalates');

select tests.new_prop('p4');
select tests.add_op('p4', 0, 'update', 'finance/arr', '{"audience":[]}', null, 1);
select is(tests.esc('p4'), true, 'widening an existing restricted concept escalates');

select tests.new_prop('p5');
select tests.add_op('p5', 0, 'update', 'metrics/active-users', jsonb_build_object('audience', array[tests.id('g_fin')], 'body', 'narrowed'));
select tests.add_cit('p5', tests.id('doc_fin'), array[tests.id('g_fin')]);
select is(tests.esc('p5'), false, 'narrowing to the evidence audience is not an escalation');

select tests.new_prop('p6');
select tests.add_op('p6', 0, 'update', 'finance/arr', '{"body":"ARR is 44M"}', null, 1);
select tests.add_cit('p6', tests.id('doc_fin'), array[tests.id('g_fin')]);
select is(tests.esc('p6'), false, 'restricted evidence into a same-audience concept is not an escalation');
select is((select target_audience from public.proposal_ops where proposal_id = tests.id('p6')), array[tests.id('g_fin')],
  'target_audience defaults to the concept audience');

select throws_ok($$update public.proposals set escalation = false where id = tests.id('p1')$$, '42501', null, 'escalation is not writable');
select throws_ok($$update public.proposal_ops set target_audience = array[tests.id('g_fin')] where proposal_id = tests.id('p1')$$, '42501', null, 'ops are not writable after insert');
delete from public.proposal_citations where proposal_id = tests.id('p1');
delete from public.proposal_ops where proposal_id = tests.id('p1');
select is(tests.esc('p1'), true, 'escalation cannot be cleared by updating the proposal or deleting/changing children');
select tests.as_postgres();
select is((select count(*)::int from public.proposal_ops where proposal_id = tests.id('p1') and target_audience = '{}'), 1, 'ops are immutable for authors');

-- VULNERABILITY: proposal_citations.op_id is not checked to belong to the same proposal; recompute_proposal_access
-- joins on (c.op_id = o.id) within the proposal, so a citation bound to an op of ANOTHER proposal is silently
-- ignored and the escalation guard is skipped.
select tests.as_user('fin_editor');
select tests.new_prop('p7');
select tests.add_op('p7', 0, 'create', 'metrics/leak', '{"body":"finance numbers, now public"}');
do $$ begin perform tests.add_cit('p7', tests.id('doc_fin'), array[tests.id('g_fin')], tests.id('p2_op')); exception when others then null; end $$;
select ok(tests.esc('p7') or not exists (select 1 from public.proposal_citations where proposal_id = tests.id('p7')),
  'VULNERABILITY: a citation bound to another proposal''s op is refused or still escalates');
-- VULNERABILITY: citation audience is whatever the author says; it is not derived from the cited row, so citing a
-- finance document with audience '{}' skips the guard and also makes the proposal visible to reviewers outside
-- finance (can_see_proposal trusts the same column).
select tests.new_prop('p8');
select tests.add_op('p8', 0, 'create', 'metrics/leak2', '{"body":"finance numbers, now public"}');
select tests.add_cit('p8', tests.id('doc_fin'), '{}');
select is(tests.esc('p8'), true, 'VULNERABILITY: citation audience is derived from the cited evidence, not trusted from the client');

-- ---------------------------------------------------------------------------------------------------------
-- C. apply / reject / verify
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_editor');
select throws_ok($$select public.apply_proposal(tests.id('prop_pub'))$$, '42501', null, 'editors cannot apply');
select throws_ok($$select public.reject_proposal(tests.id('prop_pub'), 'no')$$, '42501', null, 'editors cannot reject');
select tests.as_user('s_reviewer');
select is((public.apply_proposal(tests.id('prop_pub'), 'looks right')).status, 'applied', 'reviewer applies a proposal they can fully see');
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
select throws_ok($$select public.apply_proposal(tests.id('p1'))$$, '42501', null, 'reviewer cannot apply an escalation');
select tests.as_service();
select throws_ok($$select public.apply_proposal(tests.id('p1'))$$, '42501', null, 'service role cannot apply an escalation');
select throws_ok($$select public.apply_proposal(tests.id('p4'))$$, '42501', null, 'service role cannot apply a widening');
select tests.as_user('fin_admin');
select is((public.apply_proposal(tests.id('p1'))).status, 'applied', 'space admin in audience applies the escalation');
select tests.as_postgres();
select is((select audience from public.concepts where space_id = tests.id('s1') and path = 'metrics/new'), '{}'::uuid[], 'created with the target audience');

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

-- conflicts: nothing half-applied
select tests.as_user('fin_editor');
select tests.new_prop('p9');
select tests.add_op('p9', 0, 'update', 'metrics/active-users', '{"body":"half applied?"}', null, 2);
select tests.add_op('p9', 1, 'update', 'finance/arr', '{"body":"stale"}', null, 1);
select tests.new_prop('p10');
select tests.add_op('p10', 0, 'create', 'metrics/active-users', '{"body":"dup"}');
select tests.as_user('fin_admin');
select is((public.apply_proposal(tests.id('p9'))).status, 'conflicted', 'base_revision mismatch -> conflicted');
select is((public.apply_proposal(tests.id('p10'))).status, 'conflicted', 'create on an existing path -> conflicted');
select tests.as_postgres();
select results_eq($$select revision, body from public.concepts where id = tests.id('c_pub')$$, $$values (2, 'Active = logged in within 28 days.')$$,
  'the valid op of a conflicted proposal was not applied');
select is_empty($$select 1 from public.concept_revisions where proposal_id in (tests.id('p9'), tests.id('p10'))$$, 'no revisions from conflicted proposals');
select tests.as_user('fin_reviewer');
select is((public.reject_proposal(tests.id('p9'), 'stale')).status, 'rejected', 'conflicted proposals can be rejected');

-- reject reopens flags
select tests.as_postgres();
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
  $$select 'human:' || tests.id('s_editor'), 2, 'Public revenue definition. See [ARR](finance/arr).'$$, 'revert proposal restores the old revision as a normal proposal');

-- VULNERABILITY: propose_revert (SECURITY DEFINER) copies an old revision without checking the caller is in that
-- revision's audience, so an editor can pull the body of a revision that was finance-only before the concept was
-- sanitised and widened. The op target is the CURRENT (public) audience, so there is no escalation either.
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
select throws_ok($$select public.propose_revert(tests.id('c_leak'), 1)$$, '42501', null,
  'VULNERABILITY: cannot revert to a revision whose audience you are not in');
select is_empty($$select 1 from public.proposal_ops where after::text like '%SECRET%'$$,
  'VULNERABILITY: restricted revision content never reaches an editor outside its audience');

-- ---------------------------------------------------------------------------------------------------------
-- E. targeting concepts the author / reviewer cannot see
-- ---------------------------------------------------------------------------------------------------------
-- VULNERABILITY: an editor outside finance can target a finance concept by path (the op trigger resolves it with
-- definer rights) and widen it; can_see_proposal only looks at the TARGET audience, so a space admin outside
-- finance sees a harmless-looking escalation and applies it. "Audience is never bypassed by role" is violated.
select tests.as_user('s_editor');
select tests.new_prop('e1');
select throws_ok($$select tests.add_op('e1', 0, 'update', 'finance/arr', '{"audience":[]}')$$, '42501', null,
  'VULNERABILITY: editors cannot target a concept outside their audience');
-- same shape authored by the curator (service role), so the apply check is tested independently of the op check
select tests.as_postgres();
insert into public.proposals (space_id, author, title) values (tests.id('s1'), 'curator/test', 'widen') returning tests.put('e1b', id);
insert into public.proposal_ops (proposal_id, ord, op, path, after) values (tests.id('e1b'), 0, 'update', 'finance/arr', '{"audience":[]}');
select tests.as_user('s_admin');
select throws_ok($$select public.apply_proposal(tests.id('e1b'))$$, '42501', null,
  'VULNERABILITY: an admin outside the audience cannot apply a proposal that touches a restricted concept');
select tests.as_postgres();
select is((select audience from public.concepts where id = tests.id('c_fin')), array[tests.id('g_fin')],
  'VULNERABILITY: finance concept was not widened by people outside finance');

-- VULNERABILITY: escalation is only recomputed when ops/citations change, and apply_proposal trusts the stored
-- flag. A proposal drafted while a concept was public (no base_revision) re-publishes it after the concept was
-- restricted, applied by a plain reviewer.
select tests.as_user('s_editor');
select tests.new_prop('e2');
select tests.add_op('e2', 0, 'update', 'metrics/active-users', '{"body":"edited"}');
select tests.as_postgres();
update public.concepts set audience = array[tests.id('g_fin')] where id = tests.id('c_pub');
select tests.as_user('s_reviewer');
select throws_ok($$select public.apply_proposal(tests.id('e2'))$$, '42501', null,
  'VULNERABILITY: a stale proposal cannot widen a concept that was restricted after it was drafted');
select tests.as_postgres();
update public.concepts set audience = '{}' where id = tests.id('c_pub');

-- VULNERABILITY: proposal_ops.concept_id is never checked against the proposal's space. Any user can create a
-- workspace, become admin of their own space, and apply a proposal whose op points at another tenant's concept id.
select tests.as_user('owner_b');
do $$
begin
  perform tests.new_prop('x1', 's2');
  perform tests.add_op('x1', 0, 'update', 'whatever', '{"body":"pwned by B"}', tests.id('c_open'));
  perform public.apply_proposal(tests.id('x1'));
exception when others then null;
end $$;
select tests.as_postgres();
select is((select body from public.concepts where id = tests.id('c_open')), 'Open revenue handbook',
  'VULNERABILITY: a proposal in workspace B cannot modify a concept in workspace A');

select * from finish();
rollback;
