-- Supaknowledge: public read-only demo mode.
--
-- A hosted demo lets anyone try one space (e.g. the fictional Acme bundle) without signing up:
--
--   * Visitors are Supabase Auth ANONYMOUS users (auth.users.is_anonymous, JWT claim `is_anonymous: true`). Each
--     visitor has their own user, so flags are attributable and rate-limited per visitor, sessions are separate,
--     and Auth's per-IP limit on anonymous sign-ins (and optional CAPTCHA) applies. A shared demo account would
--     need a public password, pool every visitor into one rate limit and let one visitor read or sign out the others.
--   * `join_demo()` adds the calling anonymous user to a space listed in private.demo_spaces as a workspace
--     `member` and a space `reader`, and records them in private.demo_visitors.
--   * Demo visitors are restricted principals: private.is_oauth_client() is now also true for them, so every
--     existing OAuth-client rule applies (no administration, no workspaces, members, groups, grants, spaces,
--     sources, secrets or agents; no proposals, approvals, rejections, verifications or reverts). On top of that
--     they cannot send traces, and their flags are size-limited and rate-limited (per visitor per hour, per demo
--     space per day). Readers see only knowledge without an audience, their own flags and their own usage.
--   * `kf_demo_reset()` (and the nightly cron `kf-demo-reset`) deletes visitor flags, traces and usage, proposals
--     that were not applied since the demo was enabled, visitor memberships, and the anonymous visitor users.
--     Enabling the demo turns auto-apply off in the space, so knowledge only changes through the operator
--     (`kf demo reset --bundle <dir>` re-imports the bundle).
--
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- configuration and visitors (private: not reachable through the Data API)
-- ---------------------------------------------------------------------------------------------------------
create table if not exists private.demo_spaces (
  space_id uuid primary key references public.spaces (id) on delete cascade,
  flags_per_visitor_per_hour int not null default 5 check (flags_per_visitor_per_hour between 0 and 1000),
  flags_per_day int not null default 200 check (flags_per_day between 0 and 100000),
  enabled_by uuid references auth.users (id) on delete set null,
  enabled_at timestamptz not null default now(),
  last_reset_at timestamptz
);
revoke all on private.demo_spaces from public, anon, authenticated, service_role;

create table if not exists private.demo_visitors (
  user_id uuid not null references auth.users (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (user_id, space_id)
);
create index if not exists demo_visitors_space_idx on private.demo_visitors (space_id);
revoke all on private.demo_visitors from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------------------------------------
-- The current principal is a demo visitor: an anonymous session, or a user who joined through join_demo()
-- (still true if they later converted the anonymous account into a permanent one).
create or replace function private.is_demo_visitor() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'is_anonymous', '') = 'true'
      or exists (select 1 from private.demo_visitors v where v.user_id = (select auth.uid()));
$$;
revoke execute on function private.is_demo_visitor() from public, anon;
grant execute on function private.is_demo_visitor() to authenticated, service_role;

create or replace function private.is_demo_visitor_user(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid is not null and (
    exists (select 1 from auth.users u where u.id = p_uid and u.is_anonymous)
    or exists (select 1 from private.demo_visitors v where v.user_id = p_uid)
  );
$$;
revoke execute on function private.is_demo_visitor_user(uuid) from public, anon, authenticated;

-- "Restricted principal": an OAuth client token (MCP client acting for a person) or a demo visitor. Every RLS
-- policy and RPC that refuses OAuth clients refuses demo visitors too (see 20261125000011_identity.sql).
create or replace function private.is_oauth_client() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(nullif((select auth.jwt()) ->> 'client_id', ''), '') <> ''
      or (select private.is_demo_visitor());
$$;

-- ---------------------------------------------------------------------------------------------------------
-- demo visitors read, search and flag; they do not send traces
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "traces: no demo visitor insert" on public.traces;
create policy "traces: no demo visitor insert" on public.traces as restrictive for insert to authenticated
  with check (not (select private.is_demo_visitor()));
drop policy if exists "traces: no demo visitor update" on public.traces;
create policy "traces: no demo visitor update" on public.traces as restrictive for update to authenticated
  using (not (select private.is_demo_visitor())) with check (not (select private.is_demo_visitor()));
drop policy if exists "trace_events: no demo visitor insert" on public.trace_events;
create policy "trace_events: no demo visitor insert" on public.trace_events as restrictive for insert to authenticated
  with check (not (select private.is_demo_visitor()));

-- flags from demo visitors: size limits and rate limits (private.rate_events is pruned daily by
-- util.cleanup_invitations(), which keeps the last day)
create or replace function private.demo_flag_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  d private.demo_spaces;
begin
  if not private.is_demo_visitor_user(new.created_by) then
    return new;
  end if;
  select * into d from private.demo_spaces s where s.space_id = new.space_id;
  if not found then
    raise exception 'demo visitors can only flag in a demo space' using errcode = '42501';
  end if;
  if length(new.observation) > 2000 or length(coalesce(new.query, '')) > 1000
     or length(coalesce(new.suggested_fix, '')) > 2000 or length(coalesce(new.concept_path, '')) > 300
     or pg_column_size(new.evidence) > 4096 then
    raise exception 'flag too long for the demo (observation and suggested fix: 2000 characters, query: 1000)' using errcode = '22001';
  end if;
  if (select count(*) from private.rate_events r
       where r.actor = new.created_by and r.action = 'demo_flag' and r.at > now() - interval '1 hour') >= d.flags_per_visitor_per_hour then
    raise exception 'demo flag limit reached (% per hour); try again later', d.flags_per_visitor_per_hour using errcode = 'PT429';
  end if;
  if (select count(*) from private.rate_events r
       where r.actor = new.space_id and r.action = 'demo_space_flag' and r.at > now() - interval '1 day') >= d.flags_per_day then
    raise exception 'the demo has reached its daily flag limit; try again tomorrow' using errcode = 'PT429';
  end if;
  insert into private.rate_events (actor, action) values (new.created_by, 'demo_flag'), (new.space_id, 'demo_space_flag');
  return new;
end;
$$;
revoke execute on function private.demo_flag_limit() from public, anon, authenticated;
drop trigger if exists flags_demo_limit on public.flags;
create trigger flags_demo_limit before insert on public.flags
  for each row execute function private.demo_flag_limit();

-- ---------------------------------------------------------------------------------------------------------
-- joining
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.demo_workspace_error(p_space uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when exists (
    select 1 from public.spaces o join public.spaces s on s.workspace_id = o.workspace_id
     where s.id = p_space and o.id <> s.id and o.visibility = 'workspace')
  then 'the demo workspace has other spaces visible to every member; demo visitors would read them. Move the demo space to its own workspace or make those spaces private'
  end;
$$;
revoke execute on function private.demo_workspace_error(uuid) from public, anon, authenticated;

-- Called by Studio right after an anonymous sign-in. p_space: one of the demo spaces (default: the only one, or
-- the first enabled).
create or replace function public.join_demo(p_space uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_space public.spaces;
  v_ws public.workspaces;
  v_err text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce((select auth.jwt()) ->> 'is_anonymous', '') <> 'true' then
    raise exception 'only anonymous demo sessions can join the demo; sign out first' using errcode = '42501';
  end if;
  select s.* into v_space from public.spaces s
   where s.id = (select d.space_id from private.demo_spaces d
                  where p_space is null or d.space_id = p_space
                  order by d.enabled_at limit 1);
  if v_space.id is null then
    raise exception 'no demo space is configured' using errcode = 'P0002';
  end if;
  v_err := private.demo_workspace_error(v_space.id);
  if v_err is not null then
    raise exception '%', v_err using errcode = '42501';
  end if;
  select w.* into v_ws from public.workspaces w where w.id = v_space.workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws.id, v_uid, 'member')
  on conflict (workspace_id, user_id) do nothing;
  insert into public.space_members (space_id, user_id, role) values (v_space.id, v_uid, 'reader')
  on conflict do nothing;
  insert into private.demo_visitors (user_id, space_id) values (v_uid, v_space.id)
  on conflict do nothing;

  return jsonb_build_object('space_id', v_space.id, 'workspace', v_ws.slug, 'space', v_space.slug, 'space_name', v_space.name);
end;
$$;
revoke execute on function public.join_demo(uuid) from public, anon;
grant execute on function public.join_demo(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- operator RPCs: enable / disable / status / reset
-- ---------------------------------------------------------------------------------------------------------
-- a person (not an agent, OAuth client or demo visitor) who owns the space's workspace, or the service role
create or replace function private.demo_operator(p_space uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_service_role() or (
    (select auth.uid()) is not null and not private.is_agent() and not private.is_oauth_client()
    and exists (select 1 from public.spaces s join public.workspace_members wm on wm.workspace_id = s.workspace_id
                 where s.id = p_space and wm.user_id = (select auth.uid()) and wm.role = 'owner')
  );
$$;
revoke execute on function private.demo_operator(uuid) from public, anon, authenticated;

create or replace function public.kf_demo_enable(p_space uuid, p_flags_per_visitor_per_hour int default 5, p_flags_per_day int default 200)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_err text;
begin
  if not private.demo_operator(p_space) then
    raise exception 'workspace owner required' using errcode = '42501';
  end if;
  v_err := private.demo_workspace_error(p_space);
  if v_err is not null then
    raise exception '%', v_err using errcode = '42501';
  end if;
  insert into private.demo_spaces (space_id, flags_per_visitor_per_hour, flags_per_day, enabled_by)
  values (p_space, p_flags_per_visitor_per_hour, p_flags_per_day, (select auth.uid()))
  on conflict (space_id) do update
    set flags_per_visitor_per_hour = excluded.flags_per_visitor_per_hour, flags_per_day = excluded.flags_per_day;
  -- knowledge in a demo changes only through the operator
  update public.spaces s
     set settings = s.settings || jsonb_build_object('auto_apply', coalesce(s.settings -> 'auto_apply', '{}'::jsonb) || '{"enabled": false}'::jsonb)
   where s.id = p_space and coalesce(s.settings #>> '{auto_apply,enabled}', '') <> 'false';
  perform private.audit(p_space, 'demo.enabled', 'space', p_space,
                        jsonb_build_object('flags_per_visitor_per_hour', p_flags_per_visitor_per_hour, 'flags_per_day', p_flags_per_day));
  return public.kf_demo_status(p_space);
end;
$$;

create or replace function public.kf_demo_status(p_space uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d private.demo_spaces;
begin
  if not private.demo_operator(p_space) then
    raise exception 'workspace owner required' using errcode = '42501';
  end if;
  select * into d from private.demo_spaces s where s.space_id = p_space;
  if not found then
    return jsonb_build_object('space_id', p_space, 'enabled', false);
  end if;
  return jsonb_build_object(
    'space_id', p_space, 'enabled', true,
    'flags_per_visitor_per_hour', d.flags_per_visitor_per_hour, 'flags_per_day', d.flags_per_day,
    'enabled_at', d.enabled_at, 'last_reset_at', d.last_reset_at,
    'visitors', (select count(*) from private.demo_visitors v where v.space_id = p_space));
end;
$$;

-- Clears what demo visitors left behind. Knowledge itself is restored by re-importing the bundle (kf demo reset).
create or replace function private.demo_reset(p_space uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  d private.demo_spaces;
  v_ws uuid;
  v_visitors uuid[];
  n_flags int; n_proposals int; n_traces int; n_usage int; n_users int;
begin
  select * into d from private.demo_spaces s where s.space_id = p_space for update;
  if not found then
    raise exception 'not a demo space' using errcode = 'P0002';
  end if;
  select s.workspace_id into v_ws from public.spaces s where s.id = p_space;
  select coalesce(array_agg(v.user_id), '{}') into v_visitors from private.demo_visitors v where v.space_id = p_space;

  -- visitor flags, and flags whose (visitor) creator was already deleted
  delete from public.flags f
   where f.space_id = p_space
     and (f.created_by = any (v_visitors) or (f.created_by is null and not f.synthetic and f.created_at >= d.enabled_at));
  get diagnostics n_flags = row_count;
  -- proposals the curator drafted from them (nothing applied is touched: revisions keep their history)
  delete from public.proposals p
   where p.space_id = p_space and p.status <> 'applied' and p.created_at >= d.enabled_at;
  get diagnostics n_proposals = row_count;
  delete from public.traces t where t.space_id = p_space and t.principal_id = any (v_visitors);
  get diagnostics n_traces = row_count;
  delete from public.concept_usage u where u.space_id = p_space and u.principal_id = any (v_visitors);
  get diagnostics n_usage = row_count;

  -- memberships (removing the workspace membership also removes the space membership), their audit rows,
  -- rate-limit counters, then the anonymous users that belong to no other demo space
  delete from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.user_id = any (v_visitors) and wm.role = 'member'
     and not exists (select 1 from private.demo_visitors o join public.spaces s on s.id = o.space_id
                      where o.user_id = wm.user_id and o.space_id <> p_space and s.workspace_id = v_ws);
  delete from public.space_members sm where sm.space_id = p_space and sm.user_id = any (v_visitors);
  delete from public.audit_log a
   where a.workspace_id = v_ws and a.target_id = any (v_visitors)
     and a.action in ('workspace_members.insert', 'workspace_members.delete', 'space_members.insert', 'space_members.delete');
  delete from private.rate_events r
   where (r.actor = any (v_visitors) and r.action = 'demo_flag') or (r.actor = p_space and r.action = 'demo_space_flag');
  delete from private.demo_visitors v where v.space_id = p_space;
  delete from auth.users u
   where u.id = any (v_visitors) and u.is_anonymous
     and not exists (select 1 from private.demo_visitors o where o.user_id = u.id);
  get diagnostics n_users = row_count;

  update private.demo_spaces s set last_reset_at = now() where s.space_id = p_space;
  return jsonb_build_object('space_id', p_space, 'flags', n_flags, 'proposals', n_proposals, 'traces', n_traces,
                            'usage', n_usage, 'visitors', coalesce(array_length(v_visitors, 1), 0), 'users_deleted', n_users);
end;
$$;
revoke execute on function private.demo_reset(uuid) from public, anon, authenticated;

create or replace function public.kf_demo_reset(p_space uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.demo_operator(p_space) then
    raise exception 'workspace owner required' using errcode = '42501';
  end if;
  return private.demo_reset(p_space);
end;
$$;

create or replace function public.kf_demo_disable(p_space uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_out jsonb;
begin
  if not private.demo_operator(p_space) then
    raise exception 'workspace owner required' using errcode = '42501';
  end if;
  if not exists (select 1 from private.demo_spaces s where s.space_id = p_space) then
    return jsonb_build_object('space_id', p_space, 'enabled', false);
  end if;
  v_out := private.demo_reset(p_space);
  delete from private.demo_spaces s where s.space_id = p_space;
  perform private.audit(p_space, 'demo.disabled', 'space', p_space, '{}'::jsonb);
  return v_out || jsonb_build_object('enabled', false);
end;
$$;

revoke execute on function public.kf_demo_enable(uuid, int, int) from public, anon;
revoke execute on function public.kf_demo_status(uuid) from public, anon;
revoke execute on function public.kf_demo_reset(uuid) from public, anon;
revoke execute on function public.kf_demo_disable(uuid) from public, anon;
grant execute on function public.kf_demo_enable(uuid, int, int) to authenticated, service_role;
grant execute on function public.kf_demo_status(uuid) to authenticated, service_role;
grant execute on function public.kf_demo_reset(uuid) to authenticated, service_role;
grant execute on function public.kf_demo_disable(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- nightly reset (no-op without demo spaces)
-- ---------------------------------------------------------------------------------------------------------
create or replace function util.demo_reset_all() returns int
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in select s.space_id from private.demo_spaces s order by s.enabled_at loop
    perform private.demo_reset(r.space_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function util.demo_reset_all() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'kf-demo-reset';
select cron.schedule('kf-demo-reset', '43 3 * * *', $$ select util.demo_reset_all(); $$);
