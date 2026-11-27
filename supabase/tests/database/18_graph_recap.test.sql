-- knowledge_graph() and knowledge_recap() (migration 20261127000500): security invoker, so RLS decides what is
-- drawn and counted.
begin;
\ir _fixture.psql
select plan(38);

-- World for this file:
--   prop_pub applied by the auto-apply policy (service role): c_pub revision 2, resolves flag_pub (raised by agent)
--   prop_fin applied by fin_reviewer (a person): c_fin revision 2, resolves flag_fin and flag_fin2 (fin_reader)
--   an open flag on c_pub; c_pub revision 1 went stale a moment before revision 2 replaced it
select tests.as_postgres();
update public.flags set created_at = now() - interval '4 hours' where id = tests.id('flag_pub');
update public.flags set created_at = now() - interval '2 hours' where id = tests.id('flag_fin');
insert into public.flags (space_id, created_by, kind, concept_id, concept_path, observation, audience, status, proposal_id, created_at)
values (tests.id('s1'), tests.id('fin_reader'), 'outdated', tests.id('c_fin'), 'finance/arr', 'SECRET: board moved', array[tests.id('g_fin')],
        'in_proposal', tests.id('prop_fin'), now() - interval '1 hour');
update public.concept_revisions set stale_after = greatest(now() - interval '1 minute', date_trunc('month', now()))
 where concept_id = tests.id('c_pub') and revision = 1;
select tests.as_service();
select is((public.apply_proposal(tests.id('prop_pub'))).status, 'applied', 'setup: policy applies prop_pub');
select tests.as_user('fin_reviewer');
select is((public.apply_proposal(tests.id('prop_fin'), 'ok')).status, 'applied', 'setup: a person applies prop_fin');

select tests.as_postgres();
insert into public.flags (space_id, created_by, kind, concept_id, concept_path, observation)
values (tests.id('s1'), tests.id('s_reader'), 'unclear', tests.id('c_pub'), 'metrics/active-users', 'which events count?');
update public.concepts set stale_after = now() - interval '1 day' where id = tests.id('c_pub');
-- citations of another concept and of a trace, added to the applied public proposal
insert into public.proposal_citations (proposal_id, label, ref_kind, ref_id, audience) values
  (tests.id('prop_pub'), 'arr', 'concept', tests.id('c_fin'), array[tests.id('g_fin')]),
  (tests.id('prop_pub'), 'run', 'trace', tests.id('tr_agent'), '{}');

-- ---------------------------------------------------------------------------------------------------------
-- knowledge_graph
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_reader');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'concepts'), 1, 'a reader outside finance sees one concept');
select is(public.knowledge_graph(tests.id('s1')) #>> '{concepts,0,path}', 'metrics/active-users', 'and it is the public one');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'links'), 0, 'links to a restricted concept are not drawn');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'citations'), 0, 'readers see no citations (proposals are editor-only)');
select is((public.knowledge_graph(tests.id('s1')) #>> '{concepts,0,open_flags}')::int, 1, 'a reader counts the open flags they can read (their own)');
select is((public.knowledge_graph(tests.id('s1')) #>> '{concepts,0,stale}')::boolean, true, 'stale concepts are marked');
select is(public.knowledge_graph(tests.id('s1')) #>> '{concepts,0,trust}', 'unverified', 'a policy-applied revision is unverified');

select tests.as_user('fin_reader');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'concepts'), 2, 'a finance reader sees both concepts');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'links'), 2, 'and both links');
select is((select c ->> 'trust' from jsonb_array_elements(public.knowledge_graph(tests.id('s1')) -> 'concepts') c where c ->> 'path' = 'finance/arr'),
  'human_reviewed', 'a revision a person applied is human reviewed');

select tests.as_user('s_editor');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'citations'), 0,
  'an editor outside finance sees no citations of prop_pub: it cites finance-only evidence, so the proposal is hidden');

select tests.as_postgres();
delete from public.proposal_citations where proposal_id = tests.id('prop_pub') and ref_kind = 'concept';
select tests.as_user('s_editor');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'citations'), 1,
  'an editor sees the document citation of a proposal they can fully see; the trace (reviewer-only) is dropped');
select is(public.knowledge_graph(tests.id('s1')) #>> '{evidence,0,label}', 'General thread', 'evidence carries a label');

select tests.as_user('s_reviewer');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'citations'), 2, 'a reviewer also sees the trace citation');

select tests.as_user('fin_editor');
select is((select count(*)::int from jsonb_array_elements(public.knowledge_graph(tests.id('s1')) -> 'citations') x where x ->> 'ref_kind' = 'source_document'),
  2, 'a finance editor sees the citations of both applied proposals');
select is((select count(*)::int from jsonb_array_elements(public.knowledge_graph(tests.id('s1')) -> 'concepts') c where (c ->> 'open_flags')::int > 0),
  1, 'editors count every open flag in their audience');

select tests.as_user('member_b');
select is(jsonb_array_length(public.knowledge_graph(tests.id('s1')) -> 'concepts'), 0, 'another workspace sees nothing');
select is((public.knowledge_graph(tests.id('s1'), 1) ->> 'truncated')::boolean, false, 'nothing to truncate when nothing is visible');

select tests.as_user('fin_reader');
select is((public.knowledge_graph(tests.id('s1'), 1) ->> 'truncated')::boolean, true, 'p_limit caps the concepts and says so');

-- ---------------------------------------------------------------------------------------------------------
-- knowledge_recap
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_reader');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'concepts_added')::int, 1, 'reader: restricted concepts are not counted as added');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) #>> '{most_corrected,path}'), 'metrics/active-users', 'reader: most corrected is a visible concept');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'applied_by_policy')::int, 1, 'reader: one proposal applied by policy');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'applied_by_people')::int, 0, 'reader: the finance proposal is not counted');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'top_flagger'), null, 'reader: no resolved flags of their own, no top flagger');

select tests.as_user('fin_editor');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'concepts_changed')::int, 2, 'finance editor: both concepts changed');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'applied_by_people')::int, 1, 'finance editor: one proposal applied by a person');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'flags_fixed')::int, 3, 'finance editor: three flags fixed');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) #>> '{top_flagger,n}')::int, 2, 'the top flagger raised two of them');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) #>> '{top_flagger,kind}'), 'human', 'and is a person');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'median_fix_seconds')::numeric, 7200::numeric, 'median flag to fix is two hours');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'went_stale')::int, 1, 'one concept went stale this month');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'stale_fixed')::int, 1, 'and it was fixed');

select tests.as_user('s_editor');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) #>> '{top_flagger,kind}'), 'agent', 'outside finance the top flagger is the agent');

select tests.as_user('fin_reader');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, null, tests.id('ws_a')) ->> 'concepts_added')::int, 3, 'workspace scope adds every readable space');
select is((public.knowledge_recap(((now() at time zone 'UTC')::date - interval '2 months')::date, tests.id('s1')) ->> 'revisions')::int, 0, 'an earlier month is empty');

select tests.as_user('member_b');
select is((public.knowledge_recap((now() at time zone 'UTC')::date, tests.id('s1')) ->> 'revisions')::int, 0, 'another workspace counts nothing');

select * from finish();
rollback;
