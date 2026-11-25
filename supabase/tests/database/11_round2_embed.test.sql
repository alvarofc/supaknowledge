-- Round-2 review fixes for the embed worker (migration 20261125000023): compare-and-swap chunk writes and
-- once-per-entity re-queueing.
begin;
\ir _fixture.psql
select plan(28);

create function tests.vec(p float) returns text language sql immutable as $$
  select '[' || array_to_string(array_fill(p, array[384]), ',') || ']';
$$;
create function tests.sha(p uuid) returns text language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(c.body, 'UTF8')), 'hex') from public.concepts c where c.id = p;
$$;
grant execute on function tests.vec(float), tests.sha(uuid) to service_role, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('owner_a');
select throws_ok(format($$select public.kf_embed_write_concept(%L, 1, 'metrics/active-users', 'x', '[]')$$, tests.id('c_pub')),
  '42501', null, 'people cannot write chunks');
select throws_ok(format($$select public.kf_embed_write_document(%L, 'h1', true, '[]')$$, tests.id('doc_pub')),
  '42501', null, 'people cannot write source chunks');
select throws_ok(format($$select public.kf_embed_requeue(1, jsonb_build_object('table', 'concepts', 'id', %L))$$, tests.id('c_pub')),
  '42501', null, 'people cannot re-queue embed jobs');

-- ---------------------------------------------------------------------------------------------------------
-- concepts: CAS on revision + path + body
-- ---------------------------------------------------------------------------------------------------------
select tests.as_service();
select is(public.kf_embed_write_concept(tests.id('c_pub'), 1, 'metrics/active-users', tests.sha(tests.id('c_pub')),
  jsonb_build_array(
    jsonb_build_object('ord', 0, 'heading', 'H0', 'content', 'zero', 'embedding', tests.vec(0.1)),
    jsonb_build_object('ord', 1, 'heading', null, 'content', 'one', 'embedding', tests.vec(0.2)),
    jsonb_build_object('ord', 2, 'heading', null, 'content', 'skipped', 'embedding', null)),
  null,
  '[{"to_path": "finance/arr", "anchor": "ARR"}, {"to_path": "nowhere/yet", "anchor": "later"}]'::jsonb),
  true, 'the current version is written');
select is((select array_agg(content order by ord) from public.concept_chunks where concept_id = tests.id('c_pub')),
  array['zero', 'one'], 'chunks upserted on (concept, ord); rows without an embedding are skipped');
select is((select count(*)::int from public.concept_chunks where concept_id = tests.id('c_pub') and embedding is not null), 2,
  'embeddings stored');
select is((select to_concept from public.concept_links where from_concept = tests.id('c_pub') and to_path = 'finance/arr'),
  tests.id('c_fin'), 'links resolve their target');
select is((select to_concept from public.concept_links where from_concept = tests.id('c_pub') and to_path = 'nowhere/yet'),
  null::uuid, 'links to missing paths are kept unresolved');

-- partial write (total null) never trims
select is(public.kf_embed_write_concept(tests.id('c_pub'), 1, 'metrics/active-users', tests.sha(tests.id('c_pub')),
  jsonb_build_array(jsonb_build_object('ord', 0, 'heading', 'H0', 'content', 'zero again', 'embedding', tests.vec(0.3))), null, null),
  true, 'a partial write succeeds');
select is((select count(*)::int from public.concept_chunks where concept_id = tests.id('c_pub')), 2, 'a partial write keeps the tail');
select is((select count(*)::int from public.concept_links where from_concept = tests.id('c_pub')), 2, 'p_links null leaves links alone');

-- completing write trims, link set replaced
select is(public.kf_embed_write_concept(tests.id('c_pub'), 1, 'metrics/active-users', tests.sha(tests.id('c_pub')),
  '[]'::jsonb, 1, '[{"to_path": "finance/arr", "anchor": "ARR"}]'::jsonb), true, 'completing write');
select is((select array_agg(ord order by ord) from public.concept_chunks where concept_id = tests.id('c_pub')), array[0],
  'chunks with ord >= total are deleted');
select is((select array_agg(to_path) from public.concept_links where from_concept = tests.id('c_pub')), array['finance/arr'],
  'links that disappeared are deleted');

-- stale versions write nothing
select is(public.kf_embed_write_concept(tests.id('c_pub'), 0, 'metrics/active-users', tests.sha(tests.id('c_pub')),
  jsonb_build_array(jsonb_build_object('ord', 0, 'heading', 'old', 'content', 'OLD', 'embedding', tests.vec(0.9))), 0, '[]'::jsonb),
  false, 'an older revision is refused');
select is(public.kf_embed_write_concept(tests.id('c_pub'), 1, 'metrics/old-path', tests.sha(tests.id('c_pub')),
  jsonb_build_array(jsonb_build_object('ord', 0, 'heading', 'old', 'content', 'OLD', 'embedding', tests.vec(0.9))), 0, '[]'::jsonb),
  false, 'another path is refused');
select is(public.kf_embed_write_concept(tests.id('c_pub'), 1, 'metrics/active-users', 'deadbeef',
  jsonb_build_array(jsonb_build_object('ord', 0, 'heading', 'old', 'content', 'OLD', 'embedding', tests.vec(0.9))), 0, '[]'::jsonb),
  false, 'another body is refused');
select is(public.kf_embed_write_concept(gen_random_uuid(), 1, 'x', 'x', '[]', 0, '[]'), false, 'a deleted concept is refused');
select is((select array_agg(content) from public.concept_chunks where concept_id = tests.id('c_pub')), array['zero again'],
  'refused writes changed nothing');
select is((select count(*)::int from public.concept_links where from_concept = tests.id('c_pub')), 1, 'refused writes kept the links');

-- ---------------------------------------------------------------------------------------------------------
-- documents: CAS on content_hash + live/deleted
-- ---------------------------------------------------------------------------------------------------------
select is(public.kf_embed_write_document(tests.id('doc_pub'), 'h1', true,
  jsonb_build_array(jsonb_build_object('ord', 0, 'heading', null, 'content', 'new chunk', 'embedding', tests.vec(0.5))), 1),
  true, 'the current document content is written');
select is(public.kf_embed_write_document(tests.id('doc_pub'), 'old-hash', true, '[]', 0), false, 'an older content hash is refused');
select is(public.kf_embed_write_document(tests.id('doc_pub'), 'h1', false, '[]', 0), false,
  'a "deleted" job does not wipe a live document');
select is((select array_agg(content) from public.source_chunks where document_id = tests.id('doc_pub')), array['new chunk'],
  'refused document writes changed nothing');

-- ---------------------------------------------------------------------------------------------------------
-- re-queue: at most one queued message per entity
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
delete from pgmq.q_kf_embed q where q.message ->> 'id' = tests.id('c_fin')::text;
create temp table m as
  select pgmq.send('kf_embed', jsonb_build_object('table', 'concepts', 'id', tests.id('c_fin'))) as msg_id
  union all
  select pgmq.send('kf_embed', jsonb_build_object('table', 'concepts', 'id', tests.id('c_fin')));
grant select on m to service_role;
select tests.as_service();
select is(public.kf_embed_requeue((select min(msg_id) from m), jsonb_build_object('table', 'concepts', 'id', tests.id('c_fin'))),
  false, 'a duplicate message is acked without a new one (another is still queued)');
select is(public.kf_embed_requeue((select max(msg_id) from m), jsonb_build_object('table', 'concepts', 'id', tests.id('c_fin'))),
  true, 'the last one re-queues');
select tests.as_postgres();
select is((select count(*)::int from pgmq.q_kf_embed q where q.message ->> 'id' = tests.id('c_fin')::text), 1,
  'exactly one message remains for the entity');
select tests.as_service();
select throws_ok($$select public.kf_embed_requeue(1, '{"table": "users", "id": "x"}')$$, '22023', null, 'malformed messages are refused');

select * from finish();
rollback;
