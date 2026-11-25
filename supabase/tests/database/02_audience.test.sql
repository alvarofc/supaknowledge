-- Audience: restricted knowledge is invisible outside its groups, whatever the role.
begin;
\ir _fixture.psql
select plan(112);

-- run the same visibility checks for a space admin, a workspace owner and a workspace admin, none in finance
create function tests.audience_hidden(p_user text) returns setof text language plpgsql as $$
begin
  perform tests.as_user(p_user);
  return next is_empty($q$select 1 from public.concepts where id = tests.id('c_fin')$q$, p_user || ': restricted concept hidden');
  return next is_empty($q$select 1 from public.concept_revisions where concept_id = tests.id('c_fin')$q$, p_user || ': restricted revisions hidden');
  return next is_empty($q$select 1 from public.concept_chunks where concept_id = tests.id('c_fin')$q$, p_user || ': restricted chunks hidden');
  return next is_empty($q$select 1 from public.concept_links where from_concept = tests.id('c_fin') or to_concept = tests.id('c_fin')$q$,
    p_user || ': links touching restricted concept hidden');
  return next is_empty($q$select 1 from public.concept_files where concept_id = tests.id('c_fin')$q$, p_user || ': restricted files hidden');
  return next is_empty($q$select 1 from public.verifications where concept_id = tests.id('c_fin')$q$, p_user || ': restricted verifications hidden');
  return next is_empty($q$select 1 from public.flags where id = tests.id('flag_fin')$q$, p_user || ': restricted flag hidden');
  return next is_empty($q$select 1 from public.proposals where id = tests.id('prop_fin')$q$, p_user || ': proposal citing restricted evidence hidden');
  return next is_empty($q$select 1 from public.proposal_ops where proposal_id = tests.id('prop_fin')$q$, p_user || ': its ops hidden');
  return next is_empty($q$select 1 from public.proposal_citations where proposal_id = tests.id('prop_fin')$q$, p_user || ': its citations hidden');
  return next is_empty($q$select 1 from public.sources where id = tests.id('src_fin')$q$, p_user || ': restricted source hidden');
  return next is_empty($q$select 1 from public.source_documents where id = tests.id('doc_fin')$q$, p_user || ': restricted document hidden');
  return next is_empty($q$select 1 from public.source_chunks where document_id = tests.id('doc_fin')$q$, p_user || ': restricted doc chunks hidden');
  return next is_empty($q$select 1 from public.traces where id = tests.id('tr_fin')$q$, p_user || ': restricted trace hidden');
  return next is_empty($q$select 1 from public.trace_events where trace_id = tests.id('tr_fin')$q$, p_user || ': restricted trace events hidden');
  return next is_empty($q$select 1 from public.search_knowledge(tests.id('s1'), 'revenue', null, null, 50) where concept_id = tests.id('c_fin') or snippet like '%SECRET%'$q$,
    p_user || ': search_knowledge does not return the restricted concept');
  return next is_empty($q$select 1 from public.search_sources(tests.id('s1'), 'revenue') where document_id = tests.id('doc_fin') or snippet like '%SECRET%'$q$,
    p_user || ': search_sources does not return restricted documents');
  return next is(public.read_concept(tests.id('s1'), 'finance/arr'), null, p_user || ': read_concept on restricted path returns null');
  return next is(public.read_concept(tests.id('s1'), 'metrics/active-users') -> 'links', '[]'::jsonb, p_user || ': links to restricted concept are hidden');
  return next is(public.read_concept(tests.id('s1'), 'metrics/active-users') -> 'backlinks', '[]'::jsonb, p_user || ': backlinks from restricted concept hidden');
  return next is((public.knowledge_health(tests.id('s1')) ->> 'concepts')::int, 1, p_user || ': knowledge_health counts only visible concepts');
  return next is(public.knowledge_health(tests.id('s1')) -> 'by_trust', '{"unverified": 1}'::jsonb, p_user || ': by_trust ignores restricted concept');
  return next is((public.knowledge_health(tests.id('s1')) ->> 'pending_proposals')::int, 1, p_user || ': pending_proposals ignores hidden proposals');
  return next throws_ok($q$select public.verify_concept(tests.id('c_fin'))$q$, '42501', null, p_user || ': cannot verify restricted concept');
  return next throws_ok($q$select public.propose_revert(tests.id('c_fin'), 1)$q$, '42501', null, p_user || ': cannot revert restricted concept');
  return next throws_ok($q$select public.apply_proposal(tests.id('prop_fin'))$q$, '42501', null, p_user || ': cannot apply proposal with restricted evidence');
  return next throws_ok($q$select public.reject_proposal(tests.id('prop_fin'), 'no')$q$, '42501', null, p_user || ': cannot reject proposal with restricted evidence');
  return next throws_ok($q$select public.set_source_secret(tests.id('src_fin'), 'x')$q$, '42501', null, p_user || ': cannot set restricted source secret');
  return next throws_ok($q$select public.request_source_sync(tests.id('src_fin'))$q$, '42501', null, p_user || ': cannot sync restricted source');
  return next throws_ok($q$select public.dismiss_flag(tests.id('flag_fin'), 'x')$q$, '42501', null, p_user || ': cannot dismiss restricted flag');
  perform tests.as_postgres();
end;
$$;

select * from tests.audience_hidden('s_admin');
select * from tests.audience_hidden('owner_a');
select * from tests.audience_hidden('admin_a');

-- and members of the group do see it
select tests.as_user('fin_reader');
select results_eq($$select id from public.concepts where space_id = tests.id('s1') order by path$$,
  $$values (tests.id('c_fin')), (tests.id('c_pub'))$$, 'finance reader sees both concepts');
select ok(exists (select 1 from public.search_knowledge(tests.id('s1'), 'revenue') where concept_id = tests.id('c_fin')), 'finance reader finds it in search');
select is(public.read_concept(tests.id('s1'), 'finance/arr') ->> 'trust', 'human_reviewed', 'finance reader reads it, trust from verifications');
select is((select count(*)::int from public.concept_links where space_id = tests.id('s1')), 2, 'finance reader sees both links');
select is((public.knowledge_health(tests.id('s1')) ->> 'concepts')::int, 2, 'knowledge_health counts both for finance');
select tests.as_user('fin_admin');
select is((public.knowledge_health(tests.id('s1')) ->> 'pending_proposals')::int, 2, 'finance admin sees both pending proposals');
select results_eq($$select id from public.proposals where space_id = tests.id('s1') order by title$$,
  $$values (tests.id('prop_pub')), (tests.id('prop_fin'))$$, 'finance admin sees the restricted proposal');

-- the agent: reader, not in finance
select tests.as_user('agent');
select results_eq($$select concept_id from public.search_knowledge(tests.id('s1'), 'revenue')$$, $$select tests.id('c_pub')$$, 'agent search only returns public concept');
select is_empty($$select 1 from public.proposals$$, 'readers see no proposals');
select is(public.log_concept_usage(tests.id('s1'), array[tests.id('c_pub'), tests.id('c_fin')], 'search'), 1, 'usage can only be logged for visible concepts');

-- ---------------------------------------------------------------------------------------------------------
-- flag_knowledge and flag audience inheritance
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('agent');
create temp table t_flags (name text, id uuid) on commit drop;
grant all on t_flags to authenticated;
insert into t_flags values ('outsider_on_fin', public.flag_knowledge(tests.id('s1'), 'incorrect', 'ARR looks off', 'finance/arr'));
insert into t_flags values ('agent_on_pub', public.flag_knowledge(tests.id('s1'), 'unclear', 'unclear', 'metrics/active-users', null, null, tests.id('tr_fin')));
select results_eq($$select concept_id, audience from public.flags where id = (select id from t_flags where name = 'outsider_on_fin')$$,
  $$values (null::uuid, '{}'::uuid[])$$, 'flag on a restricted path by an outsider is not attached to the concept and has no audience');
select results_eq($$select concept_id, trace_id from public.flags where id = (select id from t_flags where name = 'agent_on_pub')$$,
  $$values (tests.id('c_pub'), null::uuid)$$, 'flag attaches to a visible concept; foreign trace ids are dropped');
select tests.as_user('fin_reader');
insert into t_flags values ('fin_on_fin', public.flag_knowledge(tests.id('s1'), 'outdated', 'SECRET: new ARR 44M', 'finance/arr'));
select results_eq($$select concept_id, audience from public.flags where id = (select id from t_flags where name = 'fin_on_fin')$$,
  $$values (tests.id('c_fin'), array[tests.id('g_fin')])$$, 'flag inherits the concept audience');
select tests.as_user('s_editor');
select is_empty($$select 1 from public.flags where id = (select id from t_flags where name = 'fin_on_fin')$$, 'editor outside finance cannot read the inherited flag');
select ok(exists (select 1 from public.flags where id = (select id from t_flags where name = 'outsider_on_fin')), 'editor sees the unattached flag');
select tests.as_user('s_admin');
select is((public.knowledge_health(tests.id('s1')) ->> 'open_flags')::int, 2, 'open_flags only counts visible flags');
select is_empty($$select 1 from jsonb_array_elements(public.knowledge_health(tests.id('s1')) -> 'most_flagged') x where x ->> 'path' = 'finance/arr'$$,
  'most_flagged does not leak the restricted path');
select tests.as_user('fin_editor');
select ok(exists (select 1 from public.flags where id = (select id from t_flags where name = 'fin_on_fin')), 'finance editor reads the flag');
select tests.as_user('s_reader');
select throws_ok($$select public.flag_knowledge(tests.id('s1'), 'missing', '   ')$$, '22023', null, 'observation is required');
select tests.as_user('outsider');
select throws_ok($$select public.flag_knowledge(tests.id('s1'), 'missing', 'x')$$, '42501', null, 'non-members cannot flag');

-- ---------------------------------------------------------------------------------------------------------
-- leaks through side tables (should be audience-filtered like everything else)
-- ---------------------------------------------------------------------------------------------------------
-- VULNERABILITY: concept_usage is visible to reviewers regardless of the concept's audience, including the
-- agent's raw `query` text and the restricted concept id.
select tests.as_user('s_reviewer');
select is_empty($$select 1 from public.concept_usage where concept_id = tests.id('c_fin')$$,
  'VULNERABILITY: reviewers outside the audience cannot read usage of restricted concepts');
-- VULNERABILITY: curator_tasks.input/output carry cluster topics, restricted concept paths and drafts, and are
-- readable by any space admin regardless of audience.
select tests.as_postgres();
create function tests.can_read_task_payload() returns boolean language plpgsql as $$
begin
  return exists (select 1 from public.curator_tasks where input::text like '%SECRET%' or input::text like '%finance/arr%');
exception when insufficient_privilege then
  return false;
end;
$$;
select tests.as_user('s_admin');
select is(tests.can_read_task_payload(), false,
  'VULNERABILITY: space admins outside the audience cannot read restricted curator task payloads');

select * from finish();
rollback;
