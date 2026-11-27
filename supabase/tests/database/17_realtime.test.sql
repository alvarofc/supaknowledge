-- Realtime Authorization for Studio's private channels and kf_curator_progress() (migration 20261127000300).
--
-- Realtime authorizes a join by inserting a probe row into realtime.messages for the topic and extension, then, as
-- the joining user (role + JWT claims, realtime.topic set), checking whether it can SELECT it (receive) and INSERT
-- (send / track presence). tests.rt_read() and tests.rt_write() do the same.
begin;
\ir _fixture.psql
select plan(39);

-- Realtime normally keeps a partition for today; make sure one exists inside this (rolled back) transaction
do $$
declare
  d date := (now() at time zone 'utc')::date;
  n text := 'messages_' || to_char(d, 'YYYY_MM_DD');
begin
  if not exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
                 where i.inhparent = 'realtime.messages'::regclass and c.relname = n) then
    execute format('create table realtime.%I partition of realtime.messages for values from (%L) to (%L)', n, d, d + 1);
  end if;
end $$;

create function tests.claims(p text, p_oauth boolean default false) returns text language sql stable as $$
  select (case when p_oauth
    then json_build_object('sub', tests.id(p), 'role', 'authenticated', 'client_id', 'mcp-client-123')
    else json_build_object('sub', tests.id(p), 'role', 'authenticated') end)::text;
$$;

-- can user p receive messages of this topic / extension?
create function tests.rt_read(p text, p_topic text, p_ext text, p_oauth boolean default false) returns boolean language plpgsql as $$
declare
  v uuid := gen_random_uuid();
  ok boolean;
begin
  perform tests.as_postgres();
  insert into realtime.messages (id, topic, extension) values (v, p_topic, p_ext);
  perform set_config('realtime.topic', p_topic, true);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', tests.claims(p, p_oauth), true);
  select exists (select 1 from realtime.messages m where m.id = v) into ok;
  perform tests.as_postgres();
  perform set_config('realtime.topic', '', true);
  return ok;
end;
$$;

-- can user p send to this topic / track presence on it?
create function tests.rt_write(p text, p_topic text, p_ext text, p_oauth boolean default false) returns boolean language plpgsql as $$
declare
  ok boolean := true;
begin
  perform tests.as_postgres();
  perform set_config('realtime.topic', p_topic, true);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', tests.claims(p, p_oauth), true);
  begin
    insert into realtime.messages (topic, extension) values (p_topic, p_ext);
  exception when insufficient_privilege then
    ok := false;
  end;
  perform tests.as_postgres();
  perform set_config('realtime.topic', '', true);
  return ok;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- review presence: proposal:<id>
-- ---------------------------------------------------------------------------------------------------------
select ok(tests.rt_read('s_editor', 'proposal:' || tests.id('prop_pub'), 'presence'),
  'an editor who can see a proposal receives presence on its channel');
select ok(tests.rt_write('s_editor', 'proposal:' || tests.id('prop_pub'), 'presence'),
  'an editor who can see a proposal tracks presence on its channel');
select ok(tests.rt_read('s_reviewer', 'proposal:' || tests.id('prop_pub'), 'presence'), 'a reviewer receives presence');
select ok(tests.rt_read('grp_reviewer', 'proposal:' || tests.id('prop_pub'), 'presence'), 'a reviewer through a group grant receives presence');
select ok(tests.rt_read('owner_a', 'proposal:' || tests.id('prop_pub'), 'presence'), 'a workspace owner receives presence');
select ok(tests.rt_read('fin_editor', 'proposal:' || tests.id('prop_fin'), 'presence'),
  'a finance editor receives presence on a proposal citing finance-only evidence');
select ok(tests.rt_write('fin_reviewer', 'proposal:' || tests.id('prop_fin'), 'presence'), 'and a finance reviewer tracks on it');

select ok(not tests.rt_read('s_editor', 'proposal:' || tests.id('prop_fin'), 'presence'),
  'an editor outside the evidence audience cannot receive presence on that proposal');
select ok(not tests.rt_write('s_admin', 'proposal:' || tests.id('prop_fin'), 'presence'),
  'a space admin outside the evidence audience cannot track presence on it either');
select ok(not tests.rt_read('s_reader', 'proposal:' || tests.id('prop_pub'), 'presence'), 'readers (who cannot see proposals) are refused');
select ok(not tests.rt_write('s_reader', 'proposal:' || tests.id('prop_pub'), 'presence'), 'readers cannot track');
select ok(not tests.rt_read('member_b', 'proposal:' || tests.id('prop_pub'), 'presence'), 'another workspace is refused');
select ok(not tests.rt_read('outsider', 'proposal:' || tests.id('prop_pub'), 'presence'), 'an outsider is refused');
select ok(not tests.rt_read('s_editor', 'proposal:' || tests.id('prop_b'), 'presence'), 'a proposal of another workspace is refused');

-- agents never appear, even with a role that can see the proposal
select tests.as_postgres();
update public.space_members set role = 'reviewer' where space_id = tests.id('s1') and user_id = tests.id('agent');
select tests.as_user('agent');
select is((select count(*)::int from public.proposals where id = tests.id('prop_pub')), 1, 'a reviewer agent can see the proposal');
select tests.as_postgres();
select ok(not tests.rt_read('agent', 'proposal:' || tests.id('prop_pub'), 'presence'), 'but an agent cannot receive presence on it');
select ok(not tests.rt_write('agent', 'proposal:' || tests.id('prop_pub'), 'presence'), 'and an agent cannot track presence');
select ok(not tests.rt_read('s_editor', 'proposal:' || tests.id('prop_pub'), 'presence', true), 'an OAuth client token of an editor is refused');
select ok(not tests.rt_write('s_editor', 'proposal:' || tests.id('prop_pub'), 'presence', true), 'and cannot track');

select ok(not tests.rt_read('s_editor', 'proposal:' || tests.id('prop_fin'), 'broadcast'), 'joining a hidden proposal''s channel is refused for broadcast too');
select ok(not tests.rt_write('s_editor', 'proposal:' || tests.id('prop_pub'), 'broadcast'), 'nobody broadcasts on proposal channels');
select ok(not tests.rt_read('s_editor', 'proposal:not-a-uuid', 'presence'), 'a malformed topic is refused without an error');
select ok(not tests.rt_read('s_editor', 'proposal:' || tests.id('prop_pub') || ':x', 'presence'), 'a topic with a suffix is refused');
select ok(not tests.rt_read('s_editor', 'proposalx:' || tests.id('prop_pub'), 'presence'), 'another prefix is refused');
select ok(not tests.rt_read('s_editor', 'space:' || tests.id('s1') || ':flags', 'presence'), 'other topics have no policy');

-- ---------------------------------------------------------------------------------------------------------
-- curator progress: curator:<space id>
-- ---------------------------------------------------------------------------------------------------------
select ok(tests.rt_read('s_editor', 'curator:' || tests.id('s1'), 'broadcast'), 'an editor receives the space''s curator progress');
select ok(tests.rt_read('owner_a', 'curator:' || tests.id('s1'), 'broadcast'), 'so does a workspace owner');
select ok(not tests.rt_read('s_reader', 'curator:' || tests.id('s1'), 'broadcast'), 'readers (who cannot read curator runs) do not');
select ok(not tests.rt_read('member_b', 'curator:' || tests.id('s1'), 'broadcast'), 'another workspace does not');
select ok(not tests.rt_write('s_admin', 'curator:' || tests.id('s1'), 'broadcast'), 'nobody but the curator sends progress, not even a space admin');
select ok(not tests.rt_write('s_editor', 'curator:' || tests.id('s1'), 'presence'), 'nobody tracks presence on curator channels');

select tests.as_user('s_admin');
select throws_ok($$ select public.kf_curator_progress(tests.id('s1'), '[{"type":"task_started"}]') $$, '42501', null,
  'kf_curator_progress() is not callable by people');

select tests.as_service();
select is(public.kf_curator_progress(tests.id('s1'), '[{"type":"task_started","v":1,"seq":1},{"type":"task_finished","v":1,"seq":2}]'), 2,
  'the service role sends a batch of events');
select is(public.kf_curator_progress(tests.id('s1'), '{"type":"task_failed","final":true}'), 1, 'a single event is accepted');
select tests.as_postgres();
select is((select count(*)::int from realtime.messages
           where topic = 'curator:' || tests.id('s1') and event = 'progress' and extension = 'broadcast' and private),
  3, 'each event is a private broadcast "progress" on curator:<space id> (stored, so it can be replayed)');

select tests.as_service();
select throws_ok($$ select public.kf_curator_progress(tests.id('s1'), '[{"type":"Drop table"}]') $$, '22023', null, 'event types are checked');
select throws_ok($$ select public.kf_curator_progress(tests.id('s1'), jsonb_build_array(jsonb_build_object('type', 'evidence', 'x', repeat('a', 3000)))) $$,
  '22023', null, 'oversized events are refused');
select throws_ok($$ select public.kf_curator_progress(tests.id('s1'), (select jsonb_agg('{"type":"x"}'::jsonb) from generate_series(1, 51))) $$,
  '22023', null, 'at most 50 events per call');
select throws_ok($$ select public.kf_curator_progress(gen_random_uuid(), '[{"type":"task_started"}]') $$, 'P0002', null, 'an unknown space is refused');

select * from finish();
rollback;
