-- Round-2 review fixes, functions/curator side (migration 20261125000022): flag path normalization, audience
-- scoped search, rejected proposals with their audiences, rowless consulted evidence, settings length limits.
begin;
\ir _fixture.psql
select plan(30);

grant insert on tests.ids to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- flag_knowledge normalizes the concept path (REST/SDK fallbacks pass file-style paths)
-- ---------------------------------------------------------------------------------------------------------
select is(private.normalize_concept_path('/finance/board-pack.md'), 'finance/board-pack', 'leading slash and .md');
select is(private.normalize_concept_path('./skills/x/SKILL.md'), 'skills/x', './ and /SKILL.md');
select is(private.normalize_concept_path(' metrics/arr/ '), 'metrics/arr', 'trailing slash and blanks');
select is(private.normalize_concept_path('/'), null, 'nothing left = no path');

select tests.as_user('fin_reader');
select tests.put('nf_fin', public.flag_knowledge(tests.id('s1'), 'incorrect', 'ARR is stale', '/finance/arr.md'));
select tests.as_postgres();
select results_eq($$select concept_id, concept_path, audience from public.flags where id = tests.id('nf_fin')$$,
  $$values (tests.id('c_fin'), 'finance/arr'::text, array[tests.id('g_fin')])$$,
  'a file-style path attaches the flag to the concept and takes its audience');

select tests.as_user('s_reader');
select tests.put('nf_pub', public.flag_knowledge(tests.id('s1'), 'missing', 'what is ARR', '/finance/arr.md'));
select tests.put('nf_pub2', public.flag_knowledge(tests.id('s1'), 'unclear', 'unclear', './metrics/active-users/'));
select tests.as_postgres();
select results_eq($$select concept_id is null, audience from public.flags where id = tests.id('nf_pub')$$,
  $$values (true, '{}'::uuid[])$$,
  'a concept the caller cannot read is still treated as missing');
select is((select concept_id from public.flags where id = tests.id('nf_pub2')), tests.id('c_pub'), './path/ attaches too');

-- ---------------------------------------------------------------------------------------------------------
-- search: p_visible_to (audience scope in SQL, before the LIMIT) and p_min_similarity
-- ---------------------------------------------------------------------------------------------------------
select tests.as_service();
select ok(exists (select 1 from public.search_knowledge(tests.id('s1'), 'revenue', null, null, 50) where concept_id = tests.id('c_fin')),
  'service role without a scope sees the finance concept');
select is_empty($$select 1 from public.search_knowledge(tests.id('s1'), 'revenue', null, null, 50, false, '{}') where concept_id = tests.id('c_fin')$$,
  'p_visible_to {} = unrestricted material only');
select ok(exists (select 1 from public.search_knowledge(tests.id('s1'), 'revenue', null, null, 50, false, array[tests.id('g_fin')]) where concept_id = tests.id('c_fin')),
  'p_visible_to {finance}: finance material is visible to every finance reader');
select is_empty($$select 1 from public.search_knowledge(tests.id('s1'), 'revenue', null, null, 50, false, array[tests.id('g_eng')]) where concept_id = tests.id('c_fin')$$,
  'p_visible_to {eng}: finance material is not');
select ok(exists (select 1 from public.search_knowledge(tests.id('s1'), 'revenue', null, null, 50, false, array[tests.id('g_eng')]) where concept_id = tests.id('c_pub')),
  'unrestricted material passes every scope');
select ok(exists (select 1 from public.search_sources(tests.id('s1'), 'revenue', null, 50) where document_id = tests.id('doc_fin')),
  'search_sources without a scope (service role)');
select is_empty($$select 1 from public.search_sources(tests.id('s1'), 'revenue', null, 50, '{}') where document_id = tests.id('doc_fin')$$,
  'search_sources p_visible_to {}');
select ok(exists (select 1 from public.search_sources(tests.id('s1'), 'revenue', null, 50, array[tests.id('g_fin')]) where document_id = tests.id('doc_fin')),
  'search_sources p_visible_to {finance}');

select tests.as_user('s_reader');
select is_empty($$select 1 from public.search_knowledge(tests.id('s1'), 'revenue', null, null, 50, false, array[tests.id('g_fin')]) where concept_id = tests.id('c_fin')$$,
  'the scope only narrows: RLS still hides finance material from people outside finance');

select tests.as_postgres();
update public.source_chunks set embedding = array_fill(0.1::real, array[384])::extensions.vector where document_id = tests.id('doc_pub');
select tests.as_service();
select ok(exists (select 1 from public.search_sources(tests.id('s1'), 'zzz-no-text-match', array_fill(0.1::real, array[384])::extensions.vector, 10, null, 0.9)
                  where document_id = tests.id('doc_pub')),
  'a close vector match passes the similarity floor');
select is_empty($$select 1 from public.search_sources(tests.id('s1'), 'zzz-no-text-match',
                   (array[1::real] || array_fill(0::real, array[383]))::extensions.vector, 10, null, 0.5)$$,
  'a nearest neighbour below the floor is not a hit');
select ok(exists (select 1 from public.search_sources(tests.id('s1'), 'zzz-no-text-match',
                   (array[1::real] || array_fill(0::real, array[383]))::extensions.vector, 10)),
  'without a floor the nearest neighbour is returned (unchanged default)');

-- ---------------------------------------------------------------------------------------------------------
-- kf_rejected_proposals: service role only, with the audiences of everything a rejection touched
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
update public.proposals set status = 'rejected', review_note = 'No: ARR is 42M', reviewed_at = now()
 where id in (tests.id('prop_fin'), tests.id('prop_pub'));
select tests.as_service();
select results_eq($$select id, paths, review_note from public.kf_rejected_proposals(tests.id('s1'), array['finance/arr'])$$,
  $$values (tests.id('prop_fin'), array['finance/arr'], 'No: ARR is 42M'::text)$$,
  'rejected proposals on the given paths');
select ok((select audiences @> jsonb_build_array(jsonb_build_array(tests.id('g_fin')))
             from public.kf_rejected_proposals(tests.id('s1'), array['finance/arr'])),
  'a rejection citing finance evidence reports the finance audience');
select is((select audiences from public.kf_rejected_proposals(tests.id('s1'), array['metrics/active-users'])), '[]'::jsonb,
  'an unrestricted rejection reports no audience');
select tests.as_user('fin_admin');
select throws_ok($$select * from public.kf_rejected_proposals(tests.id('s1'), array['finance/arr'])$$, '42501', null,
  'people cannot call kf_rejected_proposals');
select tests.as_postgres();
select ok(not has_function_privilege('authenticated', 'public.kf_rejected_proposals(uuid,text[],int)', 'execute')
          and not has_function_privilege('anon', 'public.search_knowledge(uuid,text,extensions.vector,public.concept_kind[],int,boolean,uuid[],double precision)', 'execute')
          and has_function_privilege('authenticated', 'public.search_sources(uuid,text,extensions.vector,int,uuid[],double precision,uuid)', 'execute'),
  'grants: rejections service-only, searches for authenticated (not anon)');

-- ---------------------------------------------------------------------------------------------------------
-- rowless consulted evidence (curator taint): the stated audience counts for escalation
-- ---------------------------------------------------------------------------------------------------------
select tests.as_service();
select tests.put('taint', (public.create_proposal(tests.id('s1'), 'taint', 'r', 'low',
  jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'concept_id', tests.id('c_pub'), 'base_revision', 1, 'after', '{"body":"x"}'::jsonb)),
  jsonb_build_array(jsonb_build_object('label', 'consulted:triage', 'ref_kind', 'url', 'consulted', true, 'audience', jsonb_build_array(tests.id('g_fin')))),
  null, 'curator/test')).id);
select tests.as_postgres();
select results_eq($$select p.escalation, c.audience from public.proposals p join public.proposal_citations c on c.proposal_id = p.id where p.id = tests.id('taint')$$,
  $$values (true, array[tests.id('g_fin')])$$,
  'a consulted citation without a row keeps the curator''s audience and escalates a public target');
select tests.as_service();
select throws_ok($$select public.create_proposal(tests.id('s1'), 'bad', 'r', 'low',
  jsonb_build_array(jsonb_build_object('op', 'update', 'path', 'metrics/active-users', 'concept_id', tests.id('c_pub'), 'base_revision', 1, 'after', '{}'::jsonb)),
  jsonb_build_array(jsonb_build_object('label', 'x', 'ref_kind', 'url', 'consulted', true, 'audience', jsonb_build_array(tests.id('g_b')))),
  null, 'curator/test')$$, '22023', null, 'its groups must belong to the workspace');

-- ---------------------------------------------------------------------------------------------------------
-- settings: length limits
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_admin');
select throws_ok(format($$update public.spaces set settings = jsonb_build_object('curator', jsonb_build_object('instructions', %L)) where id = tests.id('s1')$$, repeat('x', 8001)),
  '22023', null, 'curator.instructions: at most 8000 characters');
select lives_ok(format($$update public.spaces set settings = jsonb_build_object('curator', jsonb_build_object('instructions', %L)) where id = tests.id('s1')$$, repeat('x', 8000)),
  '8000 characters are accepted');
select throws_ok($$update public.spaces set settings = '{"curator":{"fallback_models":["a","b","c","d","e","f"]}}' where id = tests.id('s1')$$,
  '22023', null, 'curator.fallback_models: at most 5');
select throws_ok(format($$update public.spaces set settings = jsonb_build_object('curator', jsonb_build_object('model', %L)) where id = tests.id('s1')$$, repeat('m', 201)),
  '22023', null, 'curator.model: at most 200 characters');

select * from finish();
rollback;
