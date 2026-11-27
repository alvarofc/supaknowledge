-- Public demo mode (migration 20261127000600): anonymous visitors join one demo space as readers, can read,
-- search and flag (rate-limited) but cannot administer, review, write knowledge or send traces; the reset clears
-- what they left behind.
begin;
\ir _fixture.psql
select plan(45);

-- an anonymous Auth user, and the claims PostgREST passes for its session
create function tests.mkanon(p text) returns uuid language plpgsql as $$
declare
  v uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', true, '{}'::jsonb, '{}'::jsonb, now(), now());
  insert into tests.ids values (p, v);
  return v;
end;
$$;
create function tests.as_anon(p text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(p), 'role', 'authenticated', 'is_anonymous', true)::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;

select tests.as_postgres();
select tests.mkanon('visitor');
select tests.mkanon('visitor2');
select tests.mkanon('stranger');
-- fixture proposals predate the demo
update public.proposals set created_at = now() - interval '1 day';

-- ---- enabling ---------------------------------------------------------------------------------------------
select tests.as_user('s_admin');
select throws_ok($$select public.kf_demo_enable(tests.id('s1'))$$, '42501', 'workspace owner required',
  'a space admin who is not a workspace owner cannot enable the demo');

select tests.as_anon('stranger');
select throws_ok($$select public.join_demo()$$, 'P0002', 'no demo space is configured', 'nothing to join before a demo is enabled');

select tests.as_user('owner_a');
select throws_ok($$select public.kf_demo_enable(tests.id('s1'))$$, '42501', null,
  'refused while the workspace has another space every member can read (visitors would read it)');

select tests.as_postgres();
update public.spaces set visibility = 'private' where id = tests.id('s_open');
update public.spaces set settings = '{"auto_apply": {"enabled": true, "max_risk": "low"}}' where id = tests.id('s1');

select tests.as_user('owner_a');
select is((public.kf_demo_enable(tests.id('s1'), 3, 4)) ->> 'enabled', 'true', 'a workspace owner enables the demo');
select is((select settings -> 'auto_apply' from public.spaces where id = tests.id('s1')), '{"enabled": false, "max_risk": "low"}'::jsonb,
  'enabling turns auto-apply off and keeps the other auto-apply settings');
select is((public.kf_demo_status(tests.id('s1'))) ->> 'flags_per_visitor_per_hour', '3', 'status reports the limits');

-- ---- joining -----------------------------------------------------------------------------------------------
select tests.as_user('outsider');
select throws_ok($$select public.join_demo()$$, '42501', null, 'a signed-in person (not anonymous) cannot join through join_demo');

select tests.as_anon('visitor');
select is((public.join_demo()) ->> 'workspace', 'acme-test', 'an anonymous visitor joins the demo space');
select is(public.my_space_role(tests.id('s1')), 'reader'::public.space_role, 'the visitor is a reader of the demo space');
select is(public.join_demo() ->> 'space_id', tests.id('s1')::text, 'joining again is a no-op');
select throws_ok(format($$select public.join_demo(%L)$$, tests.id('s2')), 'P0002', null, 'a space that is not a demo cannot be joined');
select is(public.my_space_role(tests.id('s2')), null, 'other workspaces stay invisible');
select ok(private.is_oauth_client(), 'a visitor is a restricted principal (the OAuth-client rules apply)');

-- ---- reading and searching ---------------------------------------------------------------------------------
select ok(exists (select 1 from public.concepts where id = tests.id('c_pub')), 'the visitor reads public knowledge');
select ok(not exists (select 1 from public.concepts where id = tests.id('c_fin')), 'the visitor does not read audience-restricted knowledge');
select is((public.read_concept(tests.id('s1'), (select path from public.concepts where id = tests.id('c_pub')))) ->> 'id',
  tests.id('c_pub')::text, 'read_concept works for the visitor');
select ok(not exists (select 1 from public.proposals), 'the visitor sees no proposals (readers)');
select ok(not exists (select 1 from public.flags where created_by <> tests.id('visitor')), 'the visitor sees no one else''s flags');

-- ---- flagging, with limits ---------------------------------------------------------------------------------
select isnt(public.flag_knowledge(tests.id('s1'), 'incorrect', 'first visitor flag'), null, 'the visitor can flag');
select throws_ok($$select public.flag_knowledge(tests.id('s1'), 'incorrect', repeat('x', 2001))$$, '22001', null,
  'a flag observation longer than 2000 characters is refused');
select isnt(public.flag_knowledge(tests.id('s1'), 'missing', 'second visitor flag'), null, 'second flag');
select isnt(public.flag_knowledge(tests.id('s1'), 'missing', 'third visitor flag'), null, 'third flag');
select throws_ok($$select public.flag_knowledge(tests.id('s1'), 'missing', 'fourth visitor flag')$$, 'PT429', null,
  'the fourth flag within an hour hits the per-visitor limit (3)');
select is((select count(*)::int from public.flags where created_by = tests.id('visitor')), 3, 'the visitor sees their own three flags');

select tests.as_anon('visitor2');
select is((public.join_demo(tests.id('s1'))) ->> 'space', 's1', 'a second visitor joins');
select isnt(public.flag_knowledge(tests.id('s1'), 'missing', 'visitor2 flag'), null, 'the fourth flag of the day (all visitors) is accepted');
select throws_ok($$select public.flag_knowledge(tests.id('s1'), 'missing', 'visitor2 second flag')$$, 'PT429', null,
  'the daily limit of the demo space (4) applies across visitors');

-- ---- no administration, review, knowledge writes or traces -------------------------------------------------
select tests.as_anon('visitor');
select throws_ok($$select public.create_workspace('visitor-ws', 'Mine')$$, '42501', null, 'a visitor cannot create a workspace');
select throws_ok($$insert into public.traces (space_id, name) values (tests.id('s1'), 'visitor run')$$, '42501', null,
  'a visitor cannot send traces');
select throws_ok($$insert into public.sources (space_id, connector, name, config) values (tests.id('s1'), 'web', 'x', '{}')$$, '42501', null,
  'a visitor cannot add sources');
select throws_ok($$select public.request_curator_run(tests.id('s1'))$$, '42501', null, 'a visitor cannot start the curator');
select throws_ok($$select public.verify_concept(tests.id('c_pub'))$$, '42501', null, 'a visitor cannot verify knowledge');
select throws_ok($$select public.invite_to_workspace(tests.id('ws_a'), 'friend@example.com')$$, '42501', null, 'a visitor cannot invite people');
select is(public.update_space_settings(tests.id('s1'), '{}', (select settings from public.spaces where id = tests.id('s1'))), 'forbidden',
  'a visitor cannot change settings');
select throws_ok($$select public.kf_demo_reset(tests.id('s1'))$$, '42501', null, 'a visitor cannot reset the demo');
select throws_ok($$select public.kf_demo_status(tests.id('s1'))$$, '42501', null, 'a visitor cannot read the demo configuration');

-- a visitor who converted the anonymous account (is_anonymous false) stays restricted
select tests.as_user('visitor');
select ok(private.is_oauth_client(), 'a converted visitor is still a restricted principal');
select throws_ok($$select public.create_workspace('visitor-ws2', 'Mine')$$, '42501', null, 'a converted visitor cannot create a workspace');

-- ordinary members are not affected
select tests.as_user('s_reader');
select ok(not private.is_oauth_client(), 'a normal reader is not a restricted principal');

-- ---- reset -------------------------------------------------------------------------------------------------
select tests.as_postgres();
insert into public.proposals (space_id, author, created_by, title) values (tests.id('s1'), 'curator/test', null, 'From a visitor flag');
select tests.as_user('owner_a');
select is((public.kf_demo_reset(tests.id('s1'))) ->> 'users_deleted', '2', 'the reset deletes both anonymous visitors');
select tests.as_postgres();
select is((select count(*)::int from public.flags where space_id = tests.id('s1') and observation like '%visitor%'), 0, 'visitor flags are gone');
select ok(exists (select 1 from public.flags where id = tests.id('flag_pub')), 'flags of real members stay');
select is((select count(*)::int from public.proposals where space_id = tests.id('s1')), 2,
  'only the proposal drafted during the demo is removed; earlier proposals stay');
select ok(not exists (select 1 from public.workspace_members where user_id in (tests.id('visitor'), tests.id('visitor2')))
          and not exists (select 1 from private.demo_visitors), 'visitor memberships are gone');
select ok(exists (select 1 from cron.job where jobname = 'kf-demo-reset' and command like '%util.demo_reset_all()%'),
  'the nightly reset is scheduled');

select * from finish();
rollback;
