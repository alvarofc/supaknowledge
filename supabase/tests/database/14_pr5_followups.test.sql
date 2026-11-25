-- PR #5 bot-review follow-ups: search_sources applies p_source inside each candidate set before its 50-row limit
-- (FTS and vector), and proposal path validation (20261125000025) rejects empty and "." segments.
begin;
\ir _fixture.psql
select plan(12);

-- ---------------------------------------------------------------------------------------------------------
-- search_sources(p_source) with more than 50 better-ranked candidates from another source
-- ---------------------------------------------------------------------------------------------------------
-- 60 public chunks that outrank the finance chunk on both FTS (more matches) and vector distance (identical to
-- the query vector), so an unfiltered top-50 candidate set never contains the finance document.
select tests.as_postgres();
insert into public.source_chunks (document_id, space_id, ord, content, embedding)
select tests.id('doc_pub'), tests.id('s1'), g, 'revenue revenue revenue revenue ' || g, array_fill(0.1::real, array[384])::extensions.vector
from generate_series(1, 60) g;
update public.source_chunks set embedding = (array[0.5::real] || array_fill(0.1::real, array[383]))::extensions.vector
where document_id = tests.id('doc_fin');

select tests.as_user('fin_editor');
select is_empty($$select 1 from public.search_sources(tests.id('s1'), 'revenue') where document_id = tests.id('doc_fin')$$,
  'fixture check (FTS): unfiltered, the finance chunk falls outside the 50 FTS candidates');
select set_eq($$select document_id from public.search_sources(tests.id('s1'), 'revenue', p_source => tests.id('src_fin'))$$,
  $$values (tests.id('doc_fin'))$$, 'FTS: p_source filters the candidates before the limit, so the finance document is found');
select is_empty($$select 1 from public.search_sources(tests.id('s1'), 'zzz-no-text-match', array_fill(0.1::real, array[384])::extensions.vector)
                  where document_id = tests.id('doc_fin')$$,
  'fixture check (vector): unfiltered, the finance chunk falls outside the 50 nearest neighbours');
select set_eq($$select document_id from public.search_sources(tests.id('s1'), 'zzz-no-text-match', array_fill(0.1::real, array[384])::extensions.vector,
                                                              p_source => tests.id('src_fin'))$$,
  $$values (tests.id('doc_fin'))$$, 'vector: p_source filters the nearest-neighbour candidates before the limit');
select set_eq($$select document_id from public.search_sources(tests.id('s1'), 'revenue', array_fill(0.1::real, array[384])::extensions.vector,
                                                              p_limit => 1, p_source => tests.id('src_fin'))$$,
  $$values (tests.id('doc_fin'))$$, 'hybrid: p_source with a limit of 1 still returns that source''s document');
select tests.as_user('s_editor');
select is_empty($$select 1 from public.search_sources(tests.id('s1'), 'zzz-no-text-match', array_fill(0.1::real, array[384])::extensions.vector,
                                                       p_source => tests.id('src_fin'))$$,
  'vector: p_source on a restricted source returns nothing to someone outside its audience');

-- ---------------------------------------------------------------------------------------------------------
-- proposal paths: the same segment rule as concepts.path
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
select ok(not private.valid_concept_path('metrics//arr'), 'an empty segment is an invalid proposal path');
select ok(not private.valid_concept_path('metrics/./arr'), 'a "." segment is an invalid proposal path');
select ok(not private.valid_concept_path('metrics/arr/'), 'a trailing slash is an invalid proposal path');
select ok(private.valid_concept_path('metrics/v1.2/arr'), 'dots inside a segment are still valid');

select tests.as_user('s_editor');
select throws_ok($$select public.create_proposal(tests.id('s1'), 'bad path', 'because', 'medium',
                     jsonb_build_array(jsonb_build_object('op', 'create', 'path', 'metrics//arr2',
                       'after', jsonb_build_object('type', 'Metric', 'title', 'ARR 2', 'body', 'b'))), '[]', null, null)$$,
  '22023', null, 'create_proposal refuses an op whose path has an empty segment');
select throws_ok($$select public.create_proposal(tests.id('s1'), 'bad move', 'because', 'medium',
                     jsonb_build_array(jsonb_build_object('op', 'move', 'path', 'metrics/active-users', 'new_path', 'metrics/./users',
                       'concept_id', tests.id('c_pub'))), '[]', null, null)$$,
  '22023', null, 'create_proposal refuses a move whose new_path has a "." segment');

select * from finish();
rollback;
