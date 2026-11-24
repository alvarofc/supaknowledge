-- Tenancy: workspace isolation, the space role ladder, visibility, owners, agents.
begin;
\ir _fixture.psql
select plan(62);

-- ---------------------------------------------------------------------------------------------------------
-- workspace isolation: a member of B sees nothing of A
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('member_b');
select results_eq($$select id from public.workspaces where id in (select id from tests.ids)$$, $$select tests.id('ws_b')$$, 'B member only sees workspace B');
select results_eq($$select id from public.spaces where id in (select id from tests.ids)$$, $$select tests.id('s2')$$, 'B member only sees space s2');
select results_eq($$select id from public.groups where id in (select id from tests.ids)$$, $$select tests.id('g_b')$$, 'B member only sees B groups');
select is_empty($$select 1 from public.workspace_members where workspace_id = tests.id('ws_a')$$, 'no A memberships visible');
select is_empty($$select 1 from public.group_members where group_id in (tests.id('g_fin'), tests.id('g_eng'), tests.id('g_rev'))$$, 'no A group members visible');
select is_empty($$select 1 from public.space_members where space_id = tests.id('s1')$$, 'no A space members visible');
select is_empty($$select 1 from public.space_group_grants where space_id = tests.id('s1')$$, 'no A group grants visible');
select is_empty($$select 1 from public.agents where workspace_id = tests.id('ws_a')$$, 'no A agents visible');
select is_empty($$select 1 from public.profiles where id = tests.id('owner_a')$$, 'A profiles not visible');
select is_empty($$select 1 from public.concepts where space_id in (tests.id('s1'), tests.id('s_open'))$$, 'no A concepts');
select is_empty($$select 1 from public.concept_revisions where space_id in (tests.id('s1'), tests.id('s_open'))$$, 'no A revisions');
select is_empty($$select 1 from public.flags where space_id = tests.id('s1')$$, 'no A flags');
select is_empty($$select 1 from public.proposals where space_id = tests.id('s1')$$, 'no A proposals');
select is_empty($$select 1 from public.proposal_ops where space_id = tests.id('s1')$$, 'no A proposal ops');
select is_empty($$select 1 from public.traces where space_id = tests.id('s1')$$, 'no A traces');
select is_empty($$select 1 from public.trace_events where space_id = tests.id('s1')$$, 'no A trace events');
select is_empty($$select 1 from public.curator_runs where space_id = tests.id('s1')$$, 'no A curator runs');
select is_empty($$select 1 from public.audit_log where workspace_id = tests.id('ws_a')$$, 'no A audit log');
select is_empty($$select * from public.search_knowledge(tests.id('s1'), 'revenue')$$, 'search_knowledge on a foreign space returns nothing');
select is(public.read_concept(tests.id('s1'), 'metrics/active-users'), null, 'read_concept on a foreign space returns null');
select is(public.my_space_role(tests.id('s1')), null, 'no role on a foreign space');
select throws_ok($$select public.flag_knowledge(tests.id('s1'), 'missing', 'x')$$, '42501', null, 'cannot flag a foreign space');
select throws_ok($$select public.create_space(tests.id('ws_a'), 'evil', 'Evil')$$, '42501', null, 'cannot create a space in a foreign workspace');

select tests.as_user('owner_b');
select is_empty($$select 1 from public.sources where space_id = tests.id('s1')$$, 'B owner sees no A sources');
select throws_ok($$insert into public.workspace_members (workspace_id, user_id, role) values (tests.id('ws_a'), tests.id('owner_b'), 'member')$$,
  '42501', null, 'B owner cannot join workspace A');
select throws_ok($$insert into public.group_members (group_id, user_id) values (tests.id('g_fin'), tests.id('owner_b'))$$,
  '42501', null, 'B owner cannot join A groups');
select throws_ok($$insert into public.space_members (space_id, user_id, role) values (tests.id('s1'), tests.id('owner_b'), 'admin')$$,
  '42501', null, 'B owner cannot join A spaces');
update public.workspaces set name = 'pwned' where id = tests.id('ws_a');
select tests.as_postgres();
select is((select name from public.workspaces where id = tests.id('ws_a')), 'Acme', 'B owner cannot rename workspace A');

-- ---------------------------------------------------------------------------------------------------------
-- role ladder: direct, group grant, workspace owner/admin, visibility
-- ---------------------------------------------------------------------------------------------------------
create function tests.role_of(p_user text, p_space text) returns public.space_role language plpgsql as $$
declare r public.space_role;
begin
  perform tests.as_user(p_user);
  r := public.my_space_role(tests.id(p_space));
  perform tests.as_postgres();
  return r;
end;
$$;
select is(tests.role_of('s_reader', 's1'), 'reader', 'direct reader');
select is(tests.role_of('s_editor', 's1'), 'editor', 'direct editor');
select is(tests.role_of('s_reviewer', 's1'), 'reviewer', 'direct reviewer');
select is(tests.role_of('s_admin', 's1'), 'admin', 'direct admin');
select is(tests.role_of('grp_reviewer', 's1'), 'reviewer', 'reviewer through a group grant');
select is(tests.role_of('owner_a', 's1'), 'admin', 'workspace owner is admin of every space');
select is(tests.role_of('admin_a', 's1'), 'admin', 'workspace admin is admin of every space');
select is(tests.role_of('member_a', 's1'), null, 'plain member has no role on a private space');
select is(tests.role_of('member_a', 's_open'), 'reader', 'visibility=workspace makes every member a reader');
select is(tests.role_of('s_editor', 's_open'), 'reader', 'editor of s1 is only a reader of s_open');
select is(tests.role_of('outsider', 's_open'), null, 'non-member gets nothing from visibility=workspace');

select tests.as_user('member_a');
select results_eq($$select id from public.concepts where space_id in (tests.id('s1'), tests.id('s_open'))$$, $$select tests.id('c_open')$$,
  'member reads the workspace-visible space but not the private one');
select tests.as_user('s_reader');
select is_empty($$select 1 from public.sources where space_id = tests.id('s1')$$, 'readers do not see sources (editor+)');
select tests.as_user('s_editor');
select results_eq($$select id from public.sources where space_id = tests.id('s1')$$, $$select tests.id('src_pub')$$, 'editors see sources in audience');
select is_empty($$select 1 from public.traces where id = tests.id('tr_agent')$$, 'editors do not see other principals'' traces');
select is_empty($$select 1 from public.curator_tasks$$, 'editors do not see curator tasks');
select throws_ok($$select public.request_curator_run(tests.id('s1'))$$, '42501', null, 'editors cannot start curator runs');
select tests.as_user('grp_reviewer');
select results_eq($$select id from public.traces where id = tests.id('tr_agent')$$, $$select tests.id('tr_agent')$$, 'group reviewer sees traces');
select is((public.request_curator_run(tests.id('s1'), 'cron')).trigger, 'manual', 'group reviewer can start a run; trigger forced to manual');

-- space membership management
select tests.as_user('s_editor');
select throws_ok($$insert into public.space_members (space_id, user_id, role) values (tests.id('s1'), tests.id('member_a'), 'admin')$$,
  '42501', null, 'editors cannot grant roles');
select tests.as_user('s_admin');
insert into public.space_members (space_id, user_id, role) values (tests.id('s1'), tests.id('member_a'), 'editor');
select is(tests.role_of('member_a', 's1'), 'editor', 'space admins can grant roles');
select tests.as_user('s_admin');
select throws_ok($$insert into public.space_group_grants (space_id, group_id, role) values (tests.id('s1'), tests.id('g_b'), 'admin')$$,
  '42501', null, 'cannot grant a space to a group of another workspace');

-- ---------------------------------------------------------------------------------------------------------
-- owners, admins, agents
-- ---------------------------------------------------------------------------------------------------------
select tests.as_user('admin_a');
select throws_ok($$insert into public.workspace_members (workspace_id, user_id, role) values (tests.id('ws_a'), tests.id('outsider'), 'owner')$$,
  '42501', null, 'admins cannot mint owners (insert)');
select throws_ok($$update public.workspace_members set role = 'owner' where workspace_id = tests.id('ws_a') and user_id = tests.id('admin_a')$$,
  '42501', null, 'admins cannot promote themselves to owner');
select throws_ok($$update public.agents set workspace_id = tests.id('ws_b') where id = tests.id('agent')$$,
  '42501', null, 'admins cannot move agents into another workspace');
select tests.as_user('owner_a');
update public.workspace_members set role = 'owner' where workspace_id = tests.id('ws_a') and user_id = tests.id('member_a');
select tests.as_postgres();
select is((select role from public.workspace_members where workspace_id = tests.id('ws_a') and user_id = tests.id('member_a')), 'owner',
  'owners can mint owners');

-- VULNERABILITY: workspace admins can demote (or delete) owners; "only owners can mint owners" is meaningless
-- if an admin can remove every owner and then run the workspace. Fix: see report (USING must exclude owner rows
-- for non-owners).
select tests.as_user('admin_a');
update public.workspace_members set role = 'member' where workspace_id = tests.id('ws_a') and user_id = tests.id('owner_a');
delete from public.workspace_members where workspace_id = tests.id('ws_a') and user_id = tests.id('member_a');
select tests.as_postgres();
select is((select count(*)::int from public.workspace_members where workspace_id = tests.id('ws_a') and role = 'owner'), 2,
  'VULNERABILITY: admins cannot demote or remove owners');

-- VULNERABILITY: a space admin can move the space into ANY other workspace (spaces.workspace_id is updatable and
-- the WITH CHECK only re-checks space-level admin). This injects content (read by B's agents) into tenant B.
select tests.as_user('s_admin');
do $$ begin update public.spaces set workspace_id = tests.id('ws_b') where id = tests.id('s1'); exception when insufficient_privilege then null; end $$;
select tests.as_postgres();
select is((select workspace_id from public.spaces where id = tests.id('s1')), tests.id('ws_a'),
  'VULNERABILITY: space admins cannot move a space to another workspace');

-- workspace creation
select tests.as_user('agent');
select throws_ok($$select public.create_workspace('agent-ws', 'Agent WS')$$, '42501', null, 'agents cannot create workspaces');
select throws_ok($$insert into public.workspaces (slug, name) values ('direct-ws', 'x')$$, '42501', null, 'no direct workspace inserts');
-- VULNERABILITY: "profiles: update self" lets an agent flip its own kind to 'human' (the WITH CHECK even requires
-- it), after which create_workspace's agent check passes.
do $$ begin update public.profiles set kind = 'human' where id = tests.id('agent'); exception when others then null; end $$;
select throws_ok($$select public.create_workspace('agent-ws2', 'Agent WS 2')$$, '42501', null,
  'VULNERABILITY: agents cannot become human by updating their profile');
select tests.as_user('outsider');
select is((public.create_workspace('outsider-ws', 'Mine')).slug, 'outsider-ws', 'humans can create workspaces');
select results_eq($$select role from public.workspace_members wm join public.workspaces w on w.id = wm.workspace_id where w.slug = 'outsider-ws'$$,
  $$values ('owner'::public.workspace_role)$$, 'creator becomes owner');
set local role anon;
select throws_ok($$select public.create_workspace('anon-ws', 'x')$$, '42501', null, 'anon cannot create workspaces');
reset role;

select * from finish();
rollback;
