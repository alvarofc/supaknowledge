-- Supaknowledge: review fixes, part 1 — principal identity and the access helpers RLS is built on.
--
--   * private.is_agent() / private.is_agent_user(uid): headless agents (profiles.kind = 'agent' or
--     app_metadata.kind = 'agent'). Agents are capped at `reviewer` on every space, can never hold workspace
--     owner/admin or space admin (see 20261125000012), never approve escalations and record `agent:<uid>`.
--   * private.is_oauth_client(): the JWT carries an OAuth `client_id` (MCP clients acting for a person). Those
--     tokens read as the person, search, flag and send traces, but never administer anything or write knowledge.
--   * private.my_group_ids() + private.aud_ok(): an initPlan-friendly replacement for the per-row SECURITY DEFINER
--     private.in_audience() in RLS policies (policies are rewritten in 20261125000014).
--   * space_rank / my_spaces / group membership now require CURRENT membership of the space's workspace, and a
--     group only counts on spaces of its own workspace (fixes cross-tenant group hijack and access that survived
--     removal from the workspace).
--   * Agent e-mail domain is reserved: public sign-up cannot create agent-<uuid>@agents.supaknowledge.internal.
--   * agents rows cannot be deleted directly (the `agents` function deletes the Auth user); deleting an agents
--     row (directly by the owner, or through its workspace) deletes the agent's Auth user.
--
-- Every statement here is idempotent (create or replace / drop ... if exists) so the file can be re-applied.

-- ---------------------------------------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.is_oauth_client() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(nullif((select auth.jwt()) ->> 'client_id', ''), '') <> '';
$$;

create or replace function private.is_agent_user(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid is not null and (
    exists (select 1 from public.profiles p where p.id = p_uid and p.kind = 'agent')
    or exists (select 1 from auth.users u where u.id = p_uid and u.raw_app_meta_data ->> 'kind' = 'agent')
  );
$$;

create or replace function private.is_agent() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'kind', '') = 'agent'
      or private.is_agent_user((select auth.uid()));
$$;

-- ---------------------------------------------------------------------------------------------------------
-- audiences
-- ---------------------------------------------------------------------------------------------------------
-- No SET clause on purpose: plain immutable SQL gets inlined into policies, so `audience && $groups` can use
-- the GIN indexes and the group list is computed once per statement (initPlan).
create or replace function private.aud_ok(p_audience uuid[], p_groups uuid[]) returns boolean
language sql immutable parallel safe as $$
  select coalesce(cardinality(p_audience), 0) = 0 or coalesce(p_audience && p_groups, false);
$$;

-- groups of the current user that still count: the user must be a member of the group's workspace
create or replace function private.my_group_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(gm.group_id), '{}'::uuid[])
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  join public.workspace_members wm on wm.workspace_id = g.workspace_id and wm.user_id = gm.user_id
  where gm.user_id = (select auth.uid());
$$;

create or replace function private.my_groups() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select unnest(private.my_group_ids());
$$;

create or replace function private.in_audience(p_audience uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.aud_ok(p_audience, private.my_group_ids());
$$;

-- ---------------------------------------------------------------------------------------------------------
-- space roles: gated on current workspace membership; groups only count inside their own workspace;
-- agents are capped at reviewer (3).
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.space_rank(p_space uuid) returns int
language sql stable security definer set search_path = '' as $$
  with sp as (
    select s.id, s.workspace_id, s.visibility, wm.role as ws_role
    from public.spaces s
    join public.workspace_members wm on wm.workspace_id = s.workspace_id and wm.user_id = (select auth.uid())
    where s.id = p_space
  ), ranks as (
    select case when sp.ws_role in ('owner', 'admin') then 4 when sp.visibility = 'workspace' then 1 else 0 end as r
    from sp
    union all
    select private.role_rank(sm.role) from public.space_members sm join sp on sp.id = sm.space_id
     where sm.user_id = (select auth.uid())
    union all
    select private.role_rank(g.role) from public.space_group_grants g
      join sp on sp.id = g.space_id
      join public.groups gr on gr.id = g.group_id and gr.workspace_id = sp.workspace_id
      join public.group_members gm on gm.group_id = g.group_id
     where gm.user_id = (select auth.uid())
  )
  -- (least() ignores NULLs: no rows must stay 0)
  select least(coalesce(max(r), 0), case when private.is_agent() then 3 else 4 end) from ranks;
$$;

create or replace function private.my_spaces(min_role public.space_role default 'reader') returns setof uuid
language sql stable security definer set search_path = '' as $$
  with sp as (
    select s.id, s.workspace_id, s.visibility, wm.role as ws_role
    from public.spaces s
    join public.workspace_members wm on wm.workspace_id = s.workspace_id and wm.user_id = (select auth.uid())
  ), ranks as (
    select sp.id, case when sp.ws_role in ('owner', 'admin') then 4 when sp.visibility = 'workspace' then 1 else 0 end as r
    from sp
    union all
    select sm.space_id, private.role_rank(sm.role) from public.space_members sm join sp on sp.id = sm.space_id
     where sm.user_id = (select auth.uid())
    union all
    select g.space_id, private.role_rank(g.role) from public.space_group_grants g
      join sp on sp.id = g.space_id
      join public.groups gr on gr.id = g.group_id and gr.workspace_id = sp.workspace_id
      join public.group_members gm on gm.group_id = g.group_id
     where gm.user_id = (select auth.uid())
  ), cap as (select case when private.is_agent() then 3 else 4 end as c)
  select ranks.id from ranks, cap
  group by ranks.id, cap.c
  having least(max(ranks.r), cap.c) >= private.role_rank(min_role);
$$;

-- ---------------------------------------------------------------------------------------------------------
-- OAuth client tokens: read-mostly. RESTRICTIVE policies are AND-ed with the permissive ones, so these block
-- writes on administrative tables for OAuth tokens without touching any other rule.
-- (RPCs that are SECURITY DEFINER check private.is_oauth_client() themselves.)
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  t record;
  c text;
begin
  for t in
    select * from (values
      ('workspaces', array['update', 'delete']),
      ('workspace_members', array['insert', 'update', 'delete']),
      ('groups', array['insert', 'update', 'delete']),
      ('group_members', array['insert', 'update', 'delete']),
      ('spaces', array['insert', 'update', 'delete']),
      ('space_members', array['insert', 'update', 'delete']),
      ('space_group_grants', array['insert', 'update', 'delete']),
      ('sources', array['insert', 'update', 'delete']),
      ('agents', array['update']),
      ('profiles', array['update']),
      ('flags', array['update']),
      ('proposal_reviews', array['insert'])
    ) as x(tbl, cmds)
  loop
    foreach c in array t.cmds loop
      execute format('drop policy if exists %I on public.%I', t.tbl || ': no oauth ' || c, t.tbl);
      if c = 'insert' then
        execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (not (select private.is_oauth_client()))',
                       t.tbl || ': no oauth ' || c, t.tbl);
      elsif c = 'update' then
        execute format('create policy %I on public.%I as restrictive for update to authenticated using (not (select private.is_oauth_client())) with check (not (select private.is_oauth_client()))',
                       t.tbl || ': no oauth ' || c, t.tbl);
      else
        execute format('create policy %I on public.%I as restrictive for delete to authenticated using (not (select private.is_oauth_client()))',
                       t.tbl || ': no oauth ' || c, t.tbl);
      end if;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- workspace creation: humans only, not through an OAuth client token
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.create_workspace(p_slug text, p_name text) returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare
  ws public.workspaces;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if private.is_agent() then
    raise exception 'agents cannot create workspaces' using errcode = '42501';
  end if;
  if private.is_oauth_client() then
    raise exception 'OAuth client tokens cannot create workspaces' using errcode = '42501';
  end if;
  insert into public.workspaces (slug, name, created_by) values (p_slug, p_name, (select auth.uid())) returning * into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws.id, (select auth.uid()), 'owner');
  return ws;
end;
$$;
revoke execute on function public.create_workspace(text, text) from public, anon;
grant execute on function public.create_workspace(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- find_user_by_email: workspace admins (humans, no OAuth token) only; never returns agents; every lookup is
-- audited and rate limited (30 per hour per caller) so it cannot be used to enumerate the instance's accounts.
-- Over the limit it raises SQLSTATE PT429 (PostgREST answers HTTP 429).
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.find_user_by_email(p_workspace uuid, p_email text)
returns table (user_id uuid, display_name text, kind public.principal_kind)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_found uuid;
begin
  if v_uid is null or private.is_agent() or private.is_oauth_client()
     or not exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = p_workspace and wm.user_id = v_uid and wm.role in ('owner', 'admin')) then
    raise exception 'workspace admin required' using errcode = '42501';
  end if;
  if (select count(*) from public.audit_log a
       where a.actor_user_id = v_uid and a.action = 'user.lookup' and a.at > now() - interval '1 hour') >= 30 then
    raise exception 'too many lookups, try again later' using errcode = 'PT429';
  end if;

  select u.id into v_found
  from auth.users u join public.profiles p on p.id = u.id
  where lower(u.email) = lower(trim(p_email))
    and p.kind = 'human' and coalesce(u.raw_app_meta_data ->> 'kind', '') <> 'agent'
  limit 1;

  insert into public.audit_log (workspace_id, actor_user_id, actor, action, target_kind, target_id, data)
  values (p_workspace, v_uid, 'user:' || v_uid::text, 'user.lookup', 'user', v_found, jsonb_build_object('found', v_found is not null));

  return query select p.id, p.display_name, p.kind from public.profiles p where p.id = v_found;
end;
$$;
revoke execute on function public.find_user_by_email(uuid, text) from public, anon;
grant execute on function public.find_user_by_email(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Agent identities: the e-mail domain agent-<uuid>@agents.supaknowledge.internal is reserved for users created
-- by the `agents` Edge Function (Auth admin API, app_metadata.kind = 'agent').
--   1. Auth hook (config.jsonc auth.hook.before_user_created): public sign-up / OAuth / SSO with that domain is
--      refused with a 403. The Admin API does not run this hook, so agent creation is unaffected.
--   2. Deferred constraint trigger on auth.users (works whatever the Auth config): at COMMIT, a user with that
--      e-mail must have app_metadata.kind = 'agent'. GoTrue's admin create writes app_metadata after the INSERT
--      in the same transaction, so the check has to run at commit time and re-read the row.
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.guard_agent_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from auth.users u
              where u.id = new.id
                and lower(coalesce(u.email, '')) like '%@agents.supaknowledge.internal'
                and coalesce(u.raw_app_meta_data ->> 'kind', '') <> 'agent') then
    raise exception 'this e-mail domain is reserved for Supaknowledge agents' using errcode = '42501';
  end if;
  return null;
end;
$$;
revoke execute on function private.guard_agent_email() from public, anon, authenticated;
drop trigger if exists guard_agent_email on auth.users;
create constraint trigger guard_agent_email
  after insert or update of email, raw_app_meta_data on auth.users
  deferrable initially deferred
  for each row execute function private.guard_agent_email();

-- Supabase Auth "before user created" hook (Postgres function hook). Input: {"metadata": {...}, "user": {...}}.
-- Return {} to allow, {"error": {"http_code": 403, "message": "..."}} to reject.
create or replace function private.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if lower(coalesce(event -> 'user' ->> 'email', '')) like '%@agents.supaknowledge.internal' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'This e-mail domain is reserved.'));
  end if;
  return '{}'::jsonb;
end;
$$;
revoke execute on function private.hook_before_user_created(jsonb) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema private to supabase_auth_admin;
    grant execute on function private.hook_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Agents rows are removed only through the `agents` function (which deletes the Auth user). A direct DELETE
-- used to leave a working, invisible agent behind.
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "agents: admins delete" on public.agents;
revoke delete on public.agents from authenticated, anon;

-- Whenever an agents row goes away (agent deleted, or its workspace deleted), its Auth user goes too, so the
-- key stops working and no orphaned agent identity survives the workspace.
create or replace function private.on_agent_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from auth.users u where u.id = old.id and u.raw_app_meta_data ->> 'kind' = 'agent';
  return null;
end;
$$;
revoke execute on function private.on_agent_deleted() from public, anon, authenticated;
create or replace trigger agents_delete_auth_user
  after delete on public.agents
  for each row execute function private.on_agent_deleted();

-- new private helpers are used inside RLS policies and RPCs
grant execute on function private.is_oauth_client() to authenticated, service_role;
grant execute on function private.is_agent() to authenticated, service_role;
grant execute on function private.is_agent_user(uuid) to authenticated, service_role;
grant execute on function private.aud_ok(uuid[], uuid[]) to authenticated, service_role;
grant execute on function private.my_group_ids() to authenticated, service_role;
