-- Storage: concept-files follows concept visibility; sources follows source_documents visibility. No direct writes.
begin;
\ir _fixture.psql
select plan(18);

create function tests.objects(p_bucket text) returns setof text language sql as $$
  select name from storage.objects where bucket_id = p_bucket order by name;
$$;

-- concept-files
select tests.as_user('s_reader');
select results_eq($$select * from tests.objects('concept-files')$$, $$select tests.id('s1') || '/' || tests.id('c_pub') || '/notes.md'$$,
  'reader sees files of visible concepts only');
select tests.as_user('fin_reader');
select results_eq($$select * from tests.objects('concept-files')$$,
  $$select x from unnest(array[tests.id('s1') || '/' || tests.id('c_pub') || '/notes.md', tests.id('s1') || '/' || tests.id('c_fin') || '/calc.py']) x order by 1$$,
  'finance reader also sees restricted concept files');
select tests.as_user('owner_a');
select is_empty($$select 1 from storage.objects where name like '%' || tests.id('c_fin') || '%'$$, 'workspace owner outside finance does not see restricted files');
select tests.as_user('s_admin');
select is_empty($$select 1 from storage.objects where name like '%' || tests.id('c_fin') || '%'$$, 'space admin outside finance does not see restricted files');
select tests.as_user('member_b');
select results_eq($$select * from tests.objects('concept-files')$$, $$select tests.id('s2') || '/' || tests.id('c_b') || '/b.md'$$,
  'other tenant sees only its own concept files');
select tests.as_user('outsider');
select is_empty($$select 1 from storage.objects where bucket_id in ('concept-files', 'sources')$$, 'outsider sees nothing');
select is_empty($$select 1 from storage.objects where name like 'not-a-uuid%'$$, 'malformed paths are not readable (try_uuid -> null)');

-- sources
select tests.as_user('agent');
select is_empty($$select 1 from storage.objects where bucket_id = 'sources'$$, 'agents (readers) never see raw source files');
select tests.as_user('s_editor');
select results_eq($$select * from tests.objects('sources')$$, $$select tests.id('s1') || '/' || tests.id('src_pub') || '/m1.txt'$$,
  'editor sees source files of documents in audience; orphans hidden');
select tests.as_user('fin_editor');
select results_eq($$select * from tests.objects('sources')$$,
  $$select x from unnest(array[tests.id('s1') || '/' || tests.id('src_pub') || '/m1.txt', tests.id('s1') || '/' || tests.id('src_fin') || '/m2.txt']) x order by 1$$,
  'finance editor also sees the restricted source file');
select tests.as_user('owner_a');
select is_empty($$select 1 from storage.objects where name like '%' || tests.id('src_fin') || '%'$$, 'workspace owner outside finance does not see restricted source files');
select tests.as_user('member_b');
select is_empty($$select 1 from storage.objects where bucket_id = 'sources'$$, 'reader of s2 does not see raw files');
select tests.as_user('owner_b');
select results_eq($$select * from tests.objects('sources')$$, $$select tests.id('s2') || '/' || tests.id('src_b') || '/b1.txt'$$, 'admin of s2 sees only s2 files');

-- writes
select tests.as_user('fin_admin');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('concept-files', tests.id('s1') || '/' || tests.id('c_fin') || '/evil.py')$$,
  '42501', null, 'no direct uploads to concept-files');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('sources', tests.id('s1') || '/x/evil.txt')$$, '42501', null, 'no direct uploads to sources');
update storage.objects set name = name || '.bak' where bucket_id in ('concept-files', 'sources');
-- (direct DELETEs are additionally blocked by storage.protect_delete(); the Storage API deletes as the user with RLS)
select tests.as_postgres();
select is((select count(*)::int from storage.objects where bucket_id in ('concept-files', 'sources') and name not like '%.bak'
           and (name like tests.id('s1') || '%' or name like tests.id('s2') || '%' or name like 'not-a-uuid%')), 8, 'no updates through RLS');

set local role anon;
select is_empty($$select 1 from storage.objects where bucket_id in ('concept-files', 'sources')$$, 'anon sees nothing');
reset role;
select is((select public from storage.buckets where id = 'concept-files') or (select public from storage.buckets where id = 'sources'), false, 'buckets are private');

select * from finish();
rollback;
