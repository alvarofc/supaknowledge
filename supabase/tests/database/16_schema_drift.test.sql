-- kf_record_schema_drift(): schema drift flags from a `schema` source (migration 20261127000100).
begin;
\ir _fixture.psql
select plan(18);

select tests.as_postgres();
-- no active run, so a drift can start one
update public.curator_runs set status = 'failed' where space_id = tests.id('s1') and status in ('queued', 'running');
with x as (
  insert into public.sources (space_id, connector, name, audience) values (tests.id('s1'), 'schema', 'app db', '{}') returning id
) select tests.put('src_schema', x.id) from x;
with x as (
  insert into public.sources (space_id, connector, name, audience) values (tests.id('s1'), 'schema', 'eng db', array[tests.id('g_eng')]) returning id
) select tests.put('src_schema_eng', x.id) from x;
with x as (
  insert into public.source_documents (source_id, space_id, external_id, title, content, content_hash, audience)
  values (tests.id('src_schema'), tests.id('s1'), 'table:public.orders', 'public.orders (table)', '# public.orders', 'h-orders', '{}') returning id
) select tests.put('doc_orders', x.id) from x;
with x as (
  insert into public.concepts (space_id, path, kind, type, title, body, audience)
  values (tests.id('s1'), 'data/orders', 'data_access', 'Postgres Table', 'Orders', 'select sum(amount) from public.orders', '{}') returning id
) select tests.put('c_orders', x.id) from x;
with x as (
  insert into public.concepts (space_id, path, kind, type, title, body, audience)
  values (tests.id('s1'), 'data/orders-finance', 'data_access', 'Postgres Table', 'Orders (finance)', 'public.orders amount', array[tests.id('g_fin')]) returning id
) select tests.put('c_orders_fin', x.id) from x;

create function tests.drift(p_concept text, p_key text default 'column:public.orders.amount') returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'concept_id', tests.id(p_concept), 'key', p_key, 'kind', 'outdated', 'document', 'table:public.orders',
    'observation', 'Column public.orders.amount no longer exists: probably renamed to amount_cents.',
    'suggested_fix', 'Use public.orders.amount_cents.',
    'change', jsonb_build_object('kind', 'column_removed', 'table', 'public.orders', 'column', 'amount', 'renamed_to', 'amount_cents')));
$$;
grant execute on function tests.drift(text, text) to service_role, authenticated;

-- only the service role records drift
select tests.as_user('s_admin');
select throws_ok($$ select public.kf_record_schema_drift(tests.id('src_schema'), tests.drift('c_orders')) $$, '42501', null,
  'users cannot open drift flags');

select tests.as_service();
select throws_ok($$ select public.kf_record_schema_drift(tests.id('src_pub'), tests.drift('c_orders')) $$, '22023', 'not a schema source',
  'only schema sources record drift');
select throws_ok($$ select public.kf_record_schema_drift(tests.id('src_schema'), '{}'::jsonb) $$, '22023', 'p_flags must be a JSON array',
  'p_flags must be an array');

select is(public.kf_record_schema_drift(tests.id('src_schema'),
  tests.drift('c_orders') || tests.drift('c_pub') || '[{"concept_id": "not-a-uuid", "key": "k", "observation": "x"}]'::jsonb),
  1, 'one flag: domain concepts and malformed entries are skipped');

select tests.as_postgres();
select tests.put('f_drift', (select id from public.flags where concept_id = tests.id('c_orders') and evidence ? 'schema_drift'));
select is((select created_by from public.flags where id = tests.id('f_drift')), null, 'drift flags have no author');
select is((select kind::text || '|' || concept_path from public.flags where id = tests.id('f_drift')), 'outdated|data/orders', 'kind and concept path');
select is((select (evidence #>> '{schema_drift,document_id}')::uuid from public.flags where id = tests.id('f_drift')), tests.id('doc_orders'),
  'the flag cites the schema document');
select is((select evidence #>> '{schema_drift,change,renamed_to}' from public.flags where id = tests.id('f_drift')), 'amount_cents',
  'the structured change is kept');
select ok(exists (select 1 from public.curator_runs where space_id = tests.id('s1') and trigger = 'schema_drift' and status in ('queued', 'running')),
  'a curator run starts right away');

-- dedupe against live drift flags for the same concept and identifier
select tests.as_service();
select is(public.kf_record_schema_drift(tests.id('src_schema'), tests.drift('c_orders')), 0, 'an open drift flag is not repeated');
select tests.as_postgres();
update public.flags set status = 'in_proposal' where id = tests.id('f_drift');
select tests.as_service();
select is(public.kf_record_schema_drift(tests.id('src_schema'), tests.drift('c_orders')), 0, 'nor one in a proposal');
select is(public.kf_record_schema_drift(tests.id('src_schema'), tests.drift('c_orders', 'column:public.orders.status')), 1,
  'another identifier on the same concept is a new flag');
select tests.as_postgres();
update public.flags set status = 'resolved' where id = tests.id('f_drift');
select tests.as_service();
select is(public.kf_record_schema_drift(tests.id('src_schema'), tests.drift('c_orders')), 1, 'once resolved, the same drift flags again');

-- a flag someone raised by hand with the same evidence neither blocks nor collides
select tests.as_postgres();
insert into public.flags (space_id, created_by, kind, concept_id, concept_path, observation, evidence)
values (tests.id('s1'), tests.id('s_editor'), 'outdated', tests.id('c_orders_fin'), 'data/orders-finance', 'hand-made',
        '{"schema_drift": {"key": "column:public.orders.amount"}}');
select tests.as_service();
select is(public.kf_record_schema_drift(tests.id('src_schema'), tests.drift('c_orders_fin')), 1, 'user flags do not count for dedupe');

-- audiences: the flag never shows schema details wider than the source
select is((select audience from public.flags where concept_id = tests.id('c_orders_fin') and created_by is null),
  array[tests.id('g_fin')], 'public source, finance concept: finance audience');
select is(public.kf_record_schema_drift(tests.id('src_schema_eng'), tests.drift('c_orders_fin', 'column:public.orders.x')), 0,
  'restricted source and concept with no shared group: no flag');
select is(public.kf_record_schema_drift(tests.id('src_schema_eng'), tests.drift('c_orders', 'column:public.orders.y')), 1,
  'restricted source, public concept');
select is((select audience from public.flags where concept_id = tests.id('c_orders') and evidence #>> '{schema_drift,key}' = 'column:public.orders.y'),
  array[tests.id('g_eng')], 'the flag takes the source audience');

select * from finish();
rollback;
