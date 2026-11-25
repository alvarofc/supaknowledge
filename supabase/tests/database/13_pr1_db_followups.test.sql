-- PR #1 bot-review follow-ups (migration 20261125000024): search_sources p_source filter, stricter concept paths.
begin;
\ir _fixture.psql
select plan(8);

-- ---------------------------------------------------------------------------------------------------------
-- search_sources(p_source): the filter applies before the limit, and never widens what the caller can see
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('fin_editor');
select set_eq($$select document_id from public.search_sources(tests.id('s1'), 'revenue')$$,
  $$values (tests.id('doc_pub')), (tests.id('doc_fin'))$$, 'without p_source, both visible documents match');
select set_eq($$select document_id from public.search_sources(tests.id('s1'), 'revenue', p_limit => 1, p_source => tests.id('src_fin'))$$,
  $$values (tests.id('doc_fin'))$$, 'p_source keeps only that source''s documents, even with a limit of 1');
select tests.as_user('s_editor');
select is_empty($$select 1 from public.search_sources(tests.id('s1'), 'revenue', p_source => tests.id('src_fin'))$$,
  'p_source on a restricted source returns nothing to someone outside its audience');
select set_eq($$select document_id from public.search_sources(tests.id('s1'), 'revenue', p_source => tests.id('src_pub'))$$,
  $$values (tests.id('doc_pub'))$$, 'p_source works for a public source');

-- ---------------------------------------------------------------------------------------------------------
-- concepts.path: empty and "." segments are rejected
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
select throws_ok($$insert into public.concepts (space_id, path, kind, type, title, body) values (tests.id('s1'), 'metrics//arr2', 'domain', 'Metric', 't', 'b')$$,
  '23514', null, 'a path with an empty segment is rejected');
select throws_ok($$insert into public.concepts (space_id, path, kind, type, title, body) values (tests.id('s1'), 'metrics/./arr2', 'domain', 'Metric', 't', 'b')$$,
  '23514', null, 'a path with a "." segment is rejected');
select throws_ok($$insert into public.concepts (space_id, path, kind, type, title, body) values (tests.id('s1'), 'metrics/arr2/', 'domain', 'Metric', 't', 'b')$$,
  '23514', null, 'a path with a trailing slash is rejected');
select lives_ok($$insert into public.concepts (space_id, path, kind, type, title, body) values (tests.id('s1'), 'metrics/v1.2/arr', 'domain', 'Metric', 't', 'b')$$,
  'dots inside a segment are still allowed');

select * from finish();
rollback;
