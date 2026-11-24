-- Review follow-ups (migration 20261125000020): agents.revoked_at, session revocation, settings validation of
-- every SpaceSettingsSchema key, Storage GC listing, stripping synced skill files, workspace invitations.
begin;
\ir _fixture.psql
select plan(64);

grant insert on tests.ids to authenticated, service_role;

create function tests.as_oauth(p text) returns void language plpgsql as $$
begin
  perform tests.as_user(p);
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(p), 'role', 'authenticated', 'client_id', 'mcp-client-123')::text, true);
end;
$$;
create function tests.email(p text) returns text language sql stable security definer set search_path = '' as $$
  select u.email from auth.users u where u.id = tests.id(p);
$$;
grant execute on function tests.email(text) to authenticated;
-- the fixture's users have unconfirmed e-mails; confirm the ones invitations are matched against
update auth.users set email_confirmed_at = now() where id in (tests.id('outsider'), tests.id('member_b'), tests.id('owner_b'));

-- ---------------------------------------------------------------------------------------------------------
-- agents.revoked_at / key_prefix are not client-writable
-- ---------------------------------------------------------------------------------------------------------
select has_column('public', 'agents', 'revoked_at', 'agents.revoked_at exists');
select tests.as_user('owner_a');
select throws_ok($$update public.agents set revoked_at = null where id = tests.id('agent')$$, '42501', null,
  'workspace owners cannot write agents.revoked_at (only the agents function)');
select throws_ok($$update public.agents set key_prefix = 'skn_x' where id = tests.id('agent')$$, '42501', null,
  'nor agents.key_prefix');
select lives_ok($$update public.agents set description = 'support' where id = tests.id('agent')$$, 'name/description stay editable');

-- ---------------------------------------------------------------------------------------------------------
-- kf_revoke_user_sessions: service role only
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
select tests.put('sess1', gen_random_uuid());
insert into auth.sessions (id, user_id, created_at, updated_at) values (tests.id('sess1'), tests.id('agent'), now(), now());
insert into auth.refresh_tokens (token, user_id, session_id, revoked, created_at, updated_at)
values ('rt-test-1', tests.id('agent')::text, tests.id('sess1'), false, now(), now());
insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), tests.id('s_reader'), now(), now());
select tests.as_user('owner_a');
select throws_ok($$select public.kf_revoke_user_sessions(tests.id('agent'))$$, '42501', null, 'authenticated cannot revoke sessions');
select tests.as_service();
select is(public.kf_revoke_user_sessions(tests.id('agent')), 1, 'service role deletes the user''s sessions');
select tests.as_postgres();
select is_empty($$select 1 from auth.sessions where user_id = tests.id('agent')
                  union all select 1 from auth.refresh_tokens where user_id = tests.id('agent')::text$$,
  'no session or refresh token is left for that user');
select isnt_empty($$select 1 from auth.sessions where user_id = tests.id('s_reader')$$, 'other users keep their sessions');

-- ---------------------------------------------------------------------------------------------------------
-- settings: every key of SpaceSettingsSchema is validated
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('s_admin');
select throws_ok($$update public.spaces set settings = '{"curator":{"research_scope":"everything"}}' where id = tests.id('s1')$$,
  '22023', null, 'curator.research_scope must be target_audience or all');
select throws_ok($$update public.spaces set settings = '{"curator":{"max_tokens_per_run":-1}}' where id = tests.id('s1')$$,
  '22023', null, 'curator.max_tokens_per_run must be >= 0');
select throws_ok($$update public.spaces set settings = '{"curator":{"max_tokens_per_run":1.5}}' where id = tests.id('s1')$$,
  '22023', null, 'curator.max_tokens_per_run must be an integer');
select throws_ok($$update public.spaces set settings = '{"curator":{"auto_dismiss_flags":"yes"}}' where id = tests.id('s1')$$,
  '22023', null, 'curator.auto_dismiss_flags must be a boolean');
select throws_ok($$update public.spaces set settings = '{"auto_apply":{"untrusted_source_kinds":["ftp"]}}' where id = tests.id('s1')$$,
  '22023', null, 'auto_apply.untrusted_source_kinds only takes connector kinds');
select throws_ok($$update public.spaces set settings = '{"auto_apply":{"untrusted_source_kinds":"web"}}' where id = tests.id('s1')$$,
  '22023', null, 'auto_apply.untrusted_source_kinds must be a list');
select throws_ok($$update public.spaces set settings = '{"curator":{"stuck_after_minutes":2}}' where id = tests.id('s1')$$,
  '22023', null, 'curator.stuck_after_minutes has a lower bound');
select throws_ok($$update public.spaces set settings = '{"staleness":{"data_access_days":40000}}' where id = tests.id('s1')$$,
  '22023', null, 'staleness.data_access_days has an upper bound');
select lives_ok($$update public.spaces set settings = '{
    "curator": {"research_scope": "all", "max_tokens_per_run": 0, "auto_dismiss_flags": false, "stuck_after_minutes": 45,
                "flag_cooldown_minutes": 0, "max_research_steps": 20},
    "auto_apply": {"untrusted_source_kinds": ["web", "github", "upload"]},
    "retention": {"trace_days": null, "usage_days": 30},
    "future_section": {"anything": 1}
  }' where id = tests.id('s1')$$, 'valid values of every new key (and unknown keys) are accepted');

-- ---------------------------------------------------------------------------------------------------------
-- Storage GC listing
-- ---------------------------------------------------------------------------------------------------------
select tests.as_postgres();
insert into storage.objects (bucket_id, name) values
  ('sources', 'gc-space/src1/a.md'), ('sources', 'gc-space/src1/sub/b.md'), ('sources', 'gc-space/src10/c.md'),
  ('sources', 'gc-space/src1_x/d.md'), ('sources', 'gc-space/doc.md'), ('sources', 'gc-space/doc.md.bak');
select tests.as_user('owner_a');
select throws_ok($$select * from public.kf_storage_gc_objects('sources', 'gc-space/')$$, '42501', null, 'authenticated cannot list GC objects');
select tests.as_service();
select results_eq($$select name from public.kf_storage_gc_objects('sources', 'gc-space/src1/')$$,
  array['gc-space/src1/a.md', 'gc-space/src1/sub/b.md'], 'a folder prefix lists everything below it, and only that folder');
select results_eq($$select name from public.kf_storage_gc_objects('sources', 'gc-space/src1/', 'gc-space/src1/a.md', 10)$$,
  array['gc-space/src1/sub/b.md'], 'listing is paginated by name');
select results_eq($$select name from public.kf_storage_gc_objects('sources', 'gc-space/doc.md')$$,
  array['gc-space/doc.md'], 'a prefix without a trailing slash is one exact object');
select tests.as_postgres();
select isnt_empty($$select 1 from cron.job where jobname = 'kf-storage-gc' and command like '%invoke_edge_function(''maintenance''%'$$,
  'cron kf-storage-gc calls the maintenance function');
select isnt_empty($$select 1 from cron.job where jobname = 'kf-embed' and command like '%''embed'', 4, 4,%'$$,
  'kf-embed sends 4 jobs per request');

-- ---------------------------------------------------------------------------------------------------------
-- stripping synced skill files from applied proposals
-- ---------------------------------------------------------------------------------------------------------
select tests.put('strip_p', (select id from public.proposals where title = 'Update ARR'));
select tests.put('strip_op', (select id from public.proposal_ops where proposal_id = tests.id('strip_p') order by ord limit 1));
update public.proposal_ops set after = after || '{"files":[{"path":"SKILL.md","content":"# big","encoding":"utf8"}]}'
 where id = tests.id('strip_op');
select tests.as_user('owner_a');
select throws_ok($$select public.kf_strip_proposal_files(tests.id('strip_op'), '[]')$$, '42501', null, 'authenticated cannot strip proposals');
select tests.as_service();
select throws_ok($$select public.kf_strip_proposal_files(tests.id('strip_op'), '[{"path":"SKILL.md","size_bytes":5,"sha256":"x","stripped":true}]')$$,
  '22023', null, 'only applied proposals are stripped');
select tests.as_postgres();
update public.proposals set status = 'applied' where id = tests.id('strip_p');
select tests.as_service();
select throws_ok($$select public.kf_strip_proposal_files(tests.id('strip_op'), '[{"path":"other.md","size_bytes":5,"sha256":"x","stripped":true}]')$$,
  '22023', null, 'the stripped list must keep the same paths');
select throws_ok($$select public.kf_strip_proposal_files(tests.id('strip_op'), '[{"path":"SKILL.md","content":"x"}]')$$,
  '22023', null, 'and must not carry content');
select ok(public.kf_strip_proposal_files(tests.id('strip_op'), '[{"path":"SKILL.md","encoding":"utf8","size_bytes":5,"sha256":"ab","stripped":true}]'),
  'applied proposal files are stripped');
select tests.as_postgres();
select is((select after -> 'files' from public.proposal_ops where id = tests.id('strip_op')),
  '[{"path":"SKILL.md","encoding":"utf8","size_bytes":5,"sha256":"ab","stripped":true}]'::jsonb, 'paths and metadata are kept, content is gone');

-- ---------------------------------------------------------------------------------------------------------
-- workspace invitations: nobody joins a workspace without consent
-- ---------------------------------------------------------------------------------------------------------
select hasnt_function('public', 'find_user_by_email', array['uuid', 'text'], 'find_user_by_email is gone');
select tests.as_user('admin_a');
select throws_ok($$insert into public.workspace_members (workspace_id, user_id, role) values (tests.id('ws_a'), tests.id('outsider'), 'member')$$,
  '42501', null, 'admins can no longer add people directly (no consent bypass)');
select tests.as_user('owner_a');
select throws_ok($$insert into public.workspace_members (workspace_id, user_id, role) values (tests.id('ws_a'), tests.id('outsider'), 'member')$$,
  '42501', null, 'neither can owners');
select tests.as_user('member_a');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'someone@example.com')$$, '42501', null, 'members cannot invite');
select tests.as_oauth('admin_a');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'someone@example.com')$$, '42501', null, 'OAuth client tokens cannot invite');
select tests.as_user('agent');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'someone@example.com')$$, '42501', null, 'agents cannot invite');
select tests.as_user('admin_a');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'someone@example.com', 'owner')$$, '42501', null, 'admins cannot invite owners');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'not-an-email')$$, '22023', null, 'invalid e-mails are refused');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'agent-1@agents.supaknowledge.internal')$$, '22023', null,
  'the agent domain cannot be invited');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), tests.email('member_a'))$$, '23505', null, 'members are not re-invited');
select tests.put('inv_out', (public.invite_to_workspace(tests.id('ws_a'), upper(tests.email('outsider')), 'admin')).id);
select is((select email from public.workspace_invitations where id = tests.id('inv_out')), lower(tests.email('outsider')), 'e-mails are normalised');
select is((public.invite_to_workspace(tests.id('ws_a'), tests.email('outsider'), 'member')).id, tests.id('inv_out'),
  're-inviting refreshes the open invitation');
select is((select role::text from public.workspace_invitations where id = tests.id('inv_out')), 'member', 'with the new role');
select is((select count(*)::int from public.audit_log where action = 'workspace_invitation.created' and target_id = tests.id('inv_out')), 2,
  'invitations are audited');

select tests.as_user('member_a');
select is_empty($$select 1 from public.workspace_invitations$$, 'members do not see the workspace''s invitations');
select tests.as_user('member_b');
select is_empty($$select 1 from public.list_my_invitations()$$, 'other people do not see the invitation');
select throws_ok($$select public.accept_invitation(tests.id('inv_out'))$$, 'P0002', null, 'and cannot accept it');
select throws_ok($$select public.decline_invitation(tests.id('inv_out'))$$, 'P0002', null, 'or decline it');
select tests.as_oauth('outsider');
select throws_ok($$select public.accept_invitation(tests.id('inv_out'))$$, '42501', null, 'the invitee''s OAuth client token cannot accept');
select tests.as_postgres();
update auth.users set email_confirmed_at = null where id = tests.id('outsider');
select tests.as_user('outsider');
select is_empty($$select 1 from public.list_my_invitations()$$, 'an unverified e-mail matches no invitation');
select throws_ok($$select public.accept_invitation(tests.id('inv_out'))$$, 'P0002', null, 'and cannot accept');
select tests.as_postgres();
update auth.users set email_confirmed_at = now() where id = tests.id('outsider');
select tests.as_user('outsider');
select results_eq($$select workspace_name, role::text from public.list_my_invitations()$$, $$values ('Acme'::text, 'member'::text)$$,
  'the invitee sees the invitation with the workspace name');
select isnt_empty($$select 1 from public.workspace_invitations where id = tests.id('inv_out')$$, 'and can read the row');
delete from public.workspace_invitations where id = tests.id('inv_out');
select isnt_empty($$select 1 from public.workspace_invitations where id = tests.id('inv_out')$$, 'but cannot delete it');
select is((public.accept_invitation(tests.id('inv_out'))).id, tests.id('ws_a'), 'the invitee accepts');
select is(public.my_space_role(tests.id('s_open')), 'reader'::public.space_role, 'and is now a member of the workspace');
select throws_ok($$select public.accept_invitation(tests.id('inv_out'))$$, '22023', null, 'an invitation is answered once');
select tests.as_postgres();
select is((select role::text from public.workspace_members where workspace_id = tests.id('ws_a') and user_id = tests.id('outsider')), 'member',
  'with the invited role');

-- expired and declined invitations
select tests.as_user('owner_a');
select tests.put('inv_b', (public.invite_to_workspace(tests.id('ws_a'), tests.email('member_b'), 'owner')).id);
select tests.put('inv_b2', (public.invite_to_workspace(tests.id('ws_a'), tests.email('owner_b'))).id);
select tests.as_postgres();
update public.workspace_invitations set expires_at = now() - interval '1 minute' where id = tests.id('inv_b');
select tests.as_user('member_b');
select is_empty($$select 1 from public.list_my_invitations()$$, 'expired invitations are not listed');
select throws_ok($$select public.accept_invitation(tests.id('inv_b'))$$, '22023', null, 'expired invitations cannot be accepted');
select tests.as_user('owner_b');
select lives_ok($$select public.decline_invitation(tests.id('inv_b2'))$$, 'the invitee can decline');
select tests.as_postgres();
select ok((select declined_at is not null from public.workspace_invitations where id = tests.id('inv_b2'))
          and not exists (select 1 from public.workspace_members where workspace_id = tests.id('ws_a') and user_id in (tests.id('owner_b'), tests.id('member_b'))),
  'declining (or letting it expire) adds nobody');

-- admins revoke; rate limit
select tests.as_user('admin_a');
select tests.put('inv_r', (public.invite_to_workspace(tests.id('ws_a'), 'revoke-me@example.com')).id);
delete from public.workspace_invitations where id = tests.id('inv_r');
select is_empty($$select 1 from public.workspace_invitations where id = tests.id('inv_r')$$, 'admins revoke invitations');
select lives_ok($$select count(*) from (select public.invite_to_workspace(tests.id('ws_a'), 'bulk-' || g || '@example.com') from generate_series(1, 27) g) x$$,
  '30 invitations per hour are allowed');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'one-more@example.com')$$, 'PT429', null, 'then invitations are rate limited');

select * from finish();
rollback;
