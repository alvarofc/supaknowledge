-- Supaknowledge: tenancy, identity and access control
--
-- Access model (enforced with Supabase Auth + RLS):
--   * Every principal is a Supabase Auth user. Humans sign in normally; agents are Auth users with
--     app_metadata.kind = 'agent' (created by the `agents` Edge Function), so revoking an agent is just
--     banning/deleting its Auth user.
--   * workspace  -> the org. Roles: owner | admin | member.
--   * group      -> an access group inside a workspace (e.g. "finance"). Used as an *audience*.
--   * space      -> one knowledge factory (per team or per agent). Roles: reader < editor < reviewer < admin.
--                   Granted directly (space_members) or through a group (space_group_grants).
--                   Workspace owners/admins are space admins everywhere.
--                   visibility = 'workspace' makes every workspace member a reader.
--   * audience   -> uuid[] of group ids on concepts, sources, documents, traces and flags.
--                   Empty = everyone who can read the space. Non-empty = members of ANY listed group.
--                   Audience is never bypassed by role: a space admin outside "finance" cannot read
--                   finance-only knowledge.

create type public.workspace_role as enum ('owner', 'admin', 'member');
create type public.space_role as enum ('reader', 'editor', 'reviewer', 'admin');
create type public.space_visibility as enum ('workspace', 'private');
create type public.principal_kind as enum ('human', 'agent');

-- ---------------------------------------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  kind public.principal_kind not null default 'human',
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, kind, display_name)
  values (
    new.id,
    case when new.raw_app_meta_data ->> 'kind' = 'agent' then 'agent'::public.principal_kind
         else 'human'::public.principal_kind end,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------------------------------------
-- workspaces, members, groups
-- ---------------------------------------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on public.workspace_members (user_id);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null,
  description text,
  -- mapping to an upstream ACL, e.g. {"slack_channel": "C123"} or {"github_team": "org/finance"}
  external_ref jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index on public.group_members (user_id);

-- ---------------------------------------------------------------------------------------------------------
-- spaces (one knowledge factory each)
-- ---------------------------------------------------------------------------------------------------------
create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null,
  description text,
  visibility public.space_visibility not null default 'workspace',
  -- curator + policy settings, see packages/core/src/settings.ts for the schema
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index on public.spaces (workspace_id);

create table public.space_members (
  space_id uuid not null references public.spaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.space_role not null default 'reader',
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index on public.space_members (user_id);

create table public.space_group_grants (
  space_id uuid not null references public.spaces (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  role public.space_role not null default 'reader',
  created_at timestamptz not null default now(),
  primary key (space_id, group_id)
);

-- ---------------------------------------------------------------------------------------------------------
-- agents: Auth users with kind = 'agent'. The row id IS the auth user id.
-- ---------------------------------------------------------------------------------------------------------
create table public.agents (
  id uuid primary key references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  description text,
  -- first chars of the current API key, for display ("skn_ab12…")
  key_prefix text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (workspace_id, name)
);

-- ---------------------------------------------------------------------------------------------------------
-- RLS helpers. Set-returning helpers are used as `x in (select private.fn())` so Postgres evaluates them
-- once per statement (initPlan) instead of once per row.
-- ---------------------------------------------------------------------------------------------------------
create function private.role_rank(r public.space_role) returns int
language sql immutable set search_path = '' as $$
  select case r when 'reader' then 1 when 'editor' then 2 when 'reviewer' then 3 when 'admin' then 4 end;
$$;

create function private.my_workspaces(min_role public.workspace_role default 'member') returns setof uuid
language sql stable security definer set search_path = '' as $$
  select wm.workspace_id from public.workspace_members wm
  where wm.user_id = (select auth.uid())
    and (min_role = 'member'
         or (min_role = 'admin' and wm.role in ('owner', 'admin'))
         or (min_role = 'owner' and wm.role = 'owner'));
$$;

create function private.my_groups() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select gm.group_id from public.group_members gm where gm.user_id = (select auth.uid());
$$;

-- highest role rank the current user has on a space (0 = none)
create function private.space_rank(p_space uuid) returns int
language sql stable security definer set search_path = '' as $$
  select greatest(
    (select coalesce(max(4), 0) from public.spaces s
       join public.workspace_members wm on wm.workspace_id = s.workspace_id
      where s.id = p_space and wm.user_id = (select auth.uid()) and wm.role in ('owner', 'admin')),
    (select coalesce(max(1), 0) from public.spaces s
       join public.workspace_members wm on wm.workspace_id = s.workspace_id
      where s.id = p_space and s.visibility = 'workspace' and wm.user_id = (select auth.uid())),
    (select coalesce(max(private.role_rank(sm.role)), 0) from public.space_members sm
      where sm.space_id = p_space and sm.user_id = (select auth.uid())),
    (select coalesce(max(private.role_rank(g.role)), 0) from public.space_group_grants g
       join public.group_members gm on gm.group_id = g.group_id
      where g.space_id = p_space and gm.user_id = (select auth.uid()))
  );
$$;

-- spaces where the current user has at least `min_role`
create function private.my_spaces(min_role public.space_role default 'reader') returns setof uuid
language sql stable security definer set search_path = '' as $$
  with ranks as (
    select s.id, 4 as r from public.spaces s
      join public.workspace_members wm on wm.workspace_id = s.workspace_id
     where wm.user_id = (select auth.uid()) and wm.role in ('owner', 'admin')
    union all
    select s.id, 1 from public.spaces s
      join public.workspace_members wm on wm.workspace_id = s.workspace_id
     where wm.user_id = (select auth.uid()) and s.visibility = 'workspace'
    union all
    select sm.space_id, private.role_rank(sm.role) from public.space_members sm
     where sm.user_id = (select auth.uid())
    union all
    select g.space_id, private.role_rank(g.role) from public.space_group_grants g
      join public.group_members gm on gm.group_id = g.group_id
     where gm.user_id = (select auth.uid())
  )
  select id from ranks group by id having max(r) >= private.role_rank(min_role);
$$;

-- can the current user see something with this audience?
create function private.in_audience(p_audience uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(cardinality(p_audience), 0) = 0
      or p_audience && array(select gm.group_id from public.group_members gm where gm.user_id = (select auth.uid()));
$$;

-- would publishing to `target` widen access of material restricted to `source`?
-- Readers(target) ⊆ Readers(source) holds when source is unrestricted, or target is restricted to a subset
-- of source's groups. Anything else is an escalation and needs explicit human sign-off.
create function private.is_escalation(p_source uuid[], p_target uuid[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(cardinality(p_source), 0) > 0
     and (coalesce(cardinality(p_target), 0) = 0 or not (p_target <@ p_source));
$$;

-- True for the service role (curator, connectors) and for direct superuser DB connections (migrations, cron).
-- Deliberately NOT based on current_user: inside SECURITY DEFINER functions current_user is the owner.
create function private.is_service_role() returns boolean
language sql stable set search_path = '' as $$
  with c as (select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb as claims)
  select (c.claims ->> 'role') = 'service_role'
      or (c.claims ->> 'role' is null
          and coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), '') = ''
          and session_user not in ('authenticator', 'anon', 'authenticated'))
  from c;
$$;

grant execute on all functions in schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.space_group_grants enable row level security;
alter table public.agents enable row level security;

-- profiles: you, and anyone sharing a workspace with you
create policy "profiles: read self and coworkers" on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or id in (select wm.user_id from public.workspace_members wm where wm.workspace_id in (select private.my_workspaces()))
  );
create policy "profiles: update self" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- kind is set from app_metadata at signup and is never client-editable
revoke update on public.profiles from authenticated, anon;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- workspaces: members read; admins update; creation goes through public.create_workspace()
create policy "workspaces: members read" on public.workspaces for select to authenticated
  using (id in (select private.my_workspaces()));
create policy "workspaces: admins update" on public.workspaces for update to authenticated
  using (id in (select private.my_workspaces('admin')));
create policy "workspaces: owners delete" on public.workspaces for delete to authenticated
  using (id in (select private.my_workspaces('owner')));

create policy "workspace_members: members read" on public.workspace_members for select to authenticated
  using (workspace_id in (select private.my_workspaces()));
create policy "workspace_members: admins manage" on public.workspace_members for all to authenticated
  using (
    workspace_id in (select private.my_workspaces('admin'))
    -- only owners can demote or remove owners
    and (role <> 'owner' or workspace_id in (select private.my_workspaces('owner')))
  )
  with check (
    workspace_id in (select private.my_workspaces('admin'))
    -- only owners can mint owners
    and (role <> 'owner' or workspace_id in (select private.my_workspaces('owner')))
  );

create policy "groups: members read" on public.groups for select to authenticated
  using (workspace_id in (select private.my_workspaces()));
create policy "groups: admins manage" on public.groups for all to authenticated
  using (workspace_id in (select private.my_workspaces('admin')))
  with check (workspace_id in (select private.my_workspaces('admin')));

create policy "group_members: members read" on public.group_members for select to authenticated
  using (group_id in (select g.id from public.groups g where g.workspace_id in (select private.my_workspaces())));
create policy "group_members: admins manage" on public.group_members for all to authenticated
  using (group_id in (select g.id from public.groups g where g.workspace_id in (select private.my_workspaces('admin'))))
  with check (group_id in (select g.id from public.groups g where g.workspace_id in (select private.my_workspaces('admin'))));

create policy "spaces: readers read" on public.spaces for select to authenticated
  using (
    id in (select private.my_spaces('reader'))
    -- also lets INSERT ... RETURNING see a space created in the same statement
    or workspace_id in (select private.my_workspaces('admin'))
  );
create policy "spaces: workspace admins create" on public.spaces for insert to authenticated
  with check (workspace_id in (select private.my_workspaces('admin')));
create policy "spaces: space admins update" on public.spaces for update to authenticated
  using (id in (select private.my_spaces('admin')))
  with check (id in (select private.my_spaces('admin')));
create policy "spaces: workspace admins delete" on public.spaces for delete to authenticated
  using (workspace_id in (select private.my_workspaces('admin')));
-- a space never changes workspace (space admins are not necessarily admins of the target workspace)
revoke update on public.spaces from authenticated, anon;
grant update (slug, name, description, visibility, settings) on public.spaces to authenticated;

create policy "space_members: readers read" on public.space_members for select to authenticated
  using (space_id in (select private.my_spaces('reader')));
create policy "space_members: admins manage" on public.space_members for all to authenticated
  using (space_id in (select private.my_spaces('admin')))
  with check (space_id in (select private.my_spaces('admin')));

create policy "space_group_grants: readers read" on public.space_group_grants for select to authenticated
  using (space_id in (select private.my_spaces('reader')));
create policy "space_group_grants: admins manage" on public.space_group_grants for all to authenticated
  using (space_id in (select private.my_spaces('admin')))
  with check (
    space_id in (select private.my_spaces('admin'))
    and group_id in (select g.id from public.groups g join public.spaces s on s.workspace_id = g.workspace_id where s.id = space_id)
  );

-- agents: workspace members can see agents; admins manage them (creation needs the Auth admin API, so it
-- happens in the `agents` Edge Function with the service role). An agent can read its own row.
create policy "agents: members read" on public.agents for select to authenticated
  using (workspace_id in (select private.my_workspaces()) or id = (select auth.uid()));
create policy "agents: admins update" on public.agents for update to authenticated
  using (workspace_id in (select private.my_workspaces('admin')))
  with check (workspace_id in (select private.my_workspaces('admin')));
create policy "agents: admins delete" on public.agents for delete to authenticated
  using (workspace_id in (select private.my_workspaces('admin')));
revoke update on public.agents from authenticated, anon;
grant update (name, description, last_seen_at) on public.agents to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- bootstrap RPCs
-- ---------------------------------------------------------------------------------------------------------
create function public.create_workspace(p_slug text, p_name text) returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare
  ws public.workspaces;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.kind = 'agent')
     or coalesce((select auth.jwt()) -> 'app_metadata' ->> 'kind', '') = 'agent' then
    raise exception 'agents cannot create workspaces' using errcode = '42501';
  end if;
  insert into public.workspaces (slug, name, created_by) values (p_slug, p_name, (select auth.uid())) returning * into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws.id, (select auth.uid()), 'owner');
  return ws;
end;
$$;

create function public.create_space(
  p_workspace uuid, p_slug text, p_name text, p_description text default null,
  p_visibility public.space_visibility default 'workspace'
) returns public.spaces
language plpgsql security invoker set search_path = '' as $$
declare
  sp public.spaces;
begin
  insert into public.spaces (workspace_id, slug, name, description, visibility)
  values (p_workspace, p_slug, p_name, p_description, p_visibility)
  returning * into sp;
  return sp;
end;
$$;

-- effective role of the current user on a space, for UIs
create function public.my_space_role(p_space uuid) returns public.space_role
language sql stable security invoker set search_path = '' as $$
  select case private.space_rank(p_space) when 4 then 'admin'::public.space_role when 3 then 'reviewer'
         when 2 then 'editor' when 1 then 'reader' end;
$$;

revoke execute on function public.create_workspace(text, text) from anon, public;
revoke execute on function public.create_space(uuid, text, text, text, public.space_visibility) from anon, public;
revoke execute on function public.my_space_role(uuid) from anon, public;
