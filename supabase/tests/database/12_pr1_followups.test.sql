-- Follow-ups from the PR #1 bot review: trace on_behalf_of updates, soft-deleted documents, agent provenance.
begin;
\ir _fixture.psql
select plan(11);

-- ---------------------------------------------------------------------------------------------------------
-- traces.on_behalf_of: the UPDATE path is validated like INSERT, and only the sender can change it
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('agent');
select throws_ok($$update public.traces set on_behalf_of = tests.id('member_b') where id = tests.id('tr_agent')$$, '42501', null,
  'a sender cannot re-point its trace at a user outside the workspace');
select lives_ok($$update public.traces set on_behalf_of = tests.id('s_reader') where id = tests.id('tr_agent')$$,
  'a sender can name a coworker it works for');

select tests.as_user('s_reader');
select results_eq($$select id from public.traces where id = tests.id('tr_agent')$$, $$select tests.id('tr_agent')$$,
  'the user a trace was sent on behalf of can read it');
-- someone else cannot take over (or re-point) a trace it did not send
update public.traces set on_behalf_of = tests.id('s_editor') where id = tests.id('tr_agent');
select tests.as_postgres();
select is((select on_behalf_of from public.traces where id = tests.id('tr_agent')), tests.id('s_reader'),
  'only the sender can change on_behalf_of');

-- the on_behalf_of branch needs current reader access to the space
delete from public.space_members where space_id = tests.id('s1') and user_id = tests.id('s_reader');
select tests.as_user('s_reader');
select is_empty($$select 1 from public.traces where id = tests.id('tr_agent')$$,
  'losing access to the space hides traces sent on your behalf');
select tests.as_postgres();
insert into public.space_members (space_id, user_id, role) values (tests.id('s1'), tests.id('s_reader'), 'reader');

-- ---------------------------------------------------------------------------------------------------------
-- soft-deleted (ACL-revoked) documents: rows, chunks and files are hidden from editors in their audience
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('fin_editor');
select isnt_empty($$select 1 from storage.objects where bucket_id = 'sources' and name like '%/m2.txt'$$, 'a live restricted file is readable in its audience');
select tests.as_postgres();
update public.source_documents set deleted_at = now() where id = tests.id('doc_fin');
select tests.as_user('fin_editor');
select is_empty($$select 1 from public.source_documents where id = tests.id('doc_fin')$$, 'a soft-deleted restricted document is hidden');
select is_empty($$select 1 from public.source_chunks where document_id = tests.id('doc_fin')$$, 'and its chunks');
select is_empty($$select 1 from storage.objects where bucket_id = 'sources' and name like '%/m2.txt'$$, 'and its file');
select tests.as_postgres();
update public.source_documents set deleted_at = null where id = tests.id('doc_fin');

-- ---------------------------------------------------------------------------------------------------------
-- agents with the reviewer role never produce human-review provenance
-- ---------------------------------------------------------------------------------------------------------
update public.space_members set role = 'reviewer' where space_id = tests.id('s1') and user_id = tests.id('agent');
select tests.as_user('agent');
select is((public.verify_concept(tests.id('c_pub'))).actor, 'agent:' || tests.id('agent'), 'an agent verification is recorded as agent:');
select tests.as_postgres();
select is_empty($$select 1 from public.verifications where actor_user_id = tests.id('agent') and actor like 'human:%'$$,
  'no human: verification is ever attributed to an agent');

select * from finish();
rollback;
