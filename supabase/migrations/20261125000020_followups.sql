-- Supaknowledge: review follow-ups.
--
--   * agents.revoked_at: set by the `agents` function on revoke (cleared on restore); the source of truth for
--     "this agent is revoked" in auth.ts, Studio and the CLI. Not client-writable, and neither is key_prefix any
--     more (the function writes both with the service role after its own permission check).
--   * public.kf_revoke_user_sessions(uid): service role only. Deletes the user's Auth sessions and refresh tokens,
--     so an agent's sessions die on revoke / rotate / delete (replaces the magic-link + global sign-out trick).
--   * spaces.settings validation covers every key of packages/core SpaceSettingsSchema (curator.max_tokens_per_run,
--     curator.research_scope, curator.auto_dismiss_flags, auto_apply.untrusted_source_kinds added).
--   * Storage GC: public.kf_storage_gc_objects() lists queued objects for the `maintenance` function, which a new
--     cron job (kf-storage-gc) calls while the queue is not empty.
--   * kf-embed fans out 4 jobs per request (matches the default KF_EMBEDS_PER_REQUEST).
--   * Workspace invitations: nobody is added to a workspace without consent. Admins invite by e-mail
--     (invite_to_workspace), the invitee accepts or declines (accept_invitation / decline_invitation, matched on
--     the VERIFIED e-mail of their Auth account). Direct INSERT into workspace_members is gone for API roles
--     (create_workspace and accept_invitation insert as definer; the agents function uses the service role).
--     find_user_by_email() is dropped (it only existed to add people by id).
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- agents: revoked_at, key_prefix no longer user-writable
-- ---------------------------------------------------------------------------------------------------------
alter table public.agents add column if not exists revoked_at timestamptz;
comment on column public.agents.revoked_at is
  'Set by the agents Edge Function when the agent is revoked (its key and sessions stop working); null = active.';
-- agents already banned in Auth before this column existed
update public.agents a set revoked_at = now()
  from auth.users u
 where u.id = a.id and a.revoked_at is null and u.banned_until is not null and u.banned_until > now();

revoke update on public.agents from authenticated, anon;
grant update (name, description, last_seen_at) on public.agents to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- session revocation (service role only)
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.kf_revoke_user_sessions(p_user uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if p_user is null then
    raise exception 'p_user is required' using errcode = '22023';
  end if;
  delete from auth.refresh_tokens rt where rt.user_id = p_user::text;
  delete from auth.sessions s where s.user_id = p_user;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.kf_revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.kf_revoke_user_sessions(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- settings validation: every key of SpaceSettingsSchema (packages/core/src/settings.ts). Keep the two in sync;
-- packages/core/test/settings-db.test.ts compares this list with the schema.
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.validate_space_settings() returns trigger
language plpgsql set search_path = '' as $$
declare
  s jsonb := new.settings;
  k text;
  v jsonb;
  spec record;
begin
  if s is null or jsonb_typeof(s) <> 'object' then
    raise exception 'settings must be a JSON object' using errcode = '22023';
  end if;
  foreach k in array array['curator', 'auto_apply', 'staleness', 'embeddings', 'retention'] loop
    if s ? k and jsonb_typeof(s -> k) <> 'object' then
      raise exception 'settings.% must be an object', k using errcode = '22023';
    end if;
  end loop;
  -- (path, type, min, max)
  for spec in select * from (values
      ('{curator,enabled}', 'boolean', null, null),
      ('{curator,flag_threshold}', 'integer', 0, 1000000),
      ('{curator,flag_cooldown_minutes}', 'integer', 0, 10080),
      ('{curator,stuck_after_minutes}', 'integer', 5, 1440),
      ('{curator,model}', 'string', null, null),
      ('{curator,fast_model}', 'string', null, null),
      ('{curator,fallback_models}', 'string[]', null, null),
      ('{curator,max_research_steps}', 'integer', 1, 20),
      ('{curator,max_clusters_per_run}', 'integer', 1, 200),
      ('{curator,max_traces_per_run}', 'integer', 0, 5000),
      ('{curator,max_tokens_per_run}', 'integer', 0, 2000000000),
      ('{curator,research_scope}', 'enum:target_audience,all', null, null),
      ('{curator,auto_dismiss_flags}', 'boolean', null, null),
      ('{curator,instructions}', 'string', null, null),
      ('{auto_apply,enabled}', 'boolean', null, null),
      ('{auto_apply,max_risk}', 'enum:low,medium', null, null),
      ('{auto_apply,kinds}', 'enum[]:skill,domain,data_access', null, null),
      ('{auto_apply,require_observed_evidence}', 'boolean', null, null),
      ('{auto_apply,allow_create}', 'boolean', null, null),
      ('{auto_apply,untrusted_source_kinds}', 'enum[]:notion,slack,github,gdrive,web,upload', null, null),
      ('{staleness,data_access_days}', 'integer', 0, 36500),
      ('{embeddings,provider}', 'enum:gte-small', null, null),
      ('{retention,trace_days}', 'integer?', 1, 36500),
      ('{retention,usage_days}', 'integer?', 1, 36500)
    ) as x(path, typ, lo, hi)
  loop
    v := s #> spec.path::text[];
    continue when v is null;
    if spec.typ = 'boolean' and jsonb_typeof(v) <> 'boolean'
       or spec.typ = 'string' and jsonb_typeof(v) <> 'string'
       or spec.typ = 'string[]' and (jsonb_typeof(v) <> 'array'
                                     or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string'))
       or spec.typ in ('integer', 'integer?') and not (
            (spec.typ = 'integer?' and jsonb_typeof(v) = 'null')
            or (jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]+(\.0+)?$'
                and (v #>> '{}')::numeric between spec.lo and spec.hi))
       or spec.typ like 'enum:%' and (jsonb_typeof(v) <> 'string'
                                      or not ((v #>> '{}') = any (string_to_array(substr(spec.typ, 6), ','))))
       or spec.typ like 'enum[]:%' and (jsonb_typeof(v) <> 'array'
                                        or exists (select 1 from jsonb_array_elements(v) e
                                                    where jsonb_typeof(e) <> 'string'
                                                       or not ((e #>> '{}') = any (string_to_array(substr(spec.typ, 8), ',')))))
    then
      raise exception 'invalid settings.%: expected %', array_to_string(spec.path::text[], '.'),
        replace(replace(replace(spec.typ, 'integer?', 'integer or null'), 'enum[]:', 'a list of '), 'enum:', 'one of ')
          || case when spec.lo is not null then format(' between %s and %s', spec.lo, spec.hi) else '' end
        using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function private.validate_space_settings() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Storage GC: the `maintenance` function lists objects under each queued prefix here (paginated by name),
-- removes them through the Storage API, then deletes the kf_storage_gc row.
-- A prefix ending in "/" is a folder; anything else is one exact object name.
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.kf_storage_gc_objects(p_bucket text, p_prefix text, p_after text default '', p_limit int default 500)
returns table (name text)
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = p_bucket
    and case when right(p_prefix, 1) = '/'
             then o.name like replace(replace(replace(p_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '%'
             else o.name = p_prefix end
    and o.name > coalesce(p_after, '')
  order by o.name
  limit greatest(1, least(coalesce(p_limit, 500), 1000));
$$;
revoke execute on function public.kf_storage_gc_objects(text, text, text, int) from public, anon, authenticated;
grant execute on function public.kf_storage_gc_objects(text, text, text, int) to service_role;

create index if not exists kf_storage_gc_created_idx on public.kf_storage_gc (id) where attempts < 10;

-- every 10 minutes, only when something is queued
select cron.schedule('kf-storage-gc', '*/10 * * * *', $$
  select util.invoke_edge_function('maintenance', '{"task":"storage_gc"}'::jsonb, 120000)
  where exists (select 1 from public.kf_storage_gc where attempts < 10);
$$);

-- one request embeds at most KF_EMBEDS_PER_REQUEST (default 4) new chunks; send 4 jobs per request so a batch
-- is not mostly re-queued. Up to 4 requests every 10 s.
select cron.schedule('kf-embed', '10 seconds', $$ select util.process_queue('kf_embed', 'embed', 4, 4, 120); $$);

-- ---------------------------------------------------------------------------------------------------------
-- workspace invitations
-- ---------------------------------------------------------------------------------------------------------
create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email) and length(email) <= 320 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.workspace_role not null default 'member',
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  declined_at timestamptz,
  check (accepted_at is null or declined_at is null)
);
-- one open invitation per (workspace, e-mail); re-inviting refreshes it
create unique index if not exists workspace_invitations_open_key on public.workspace_invitations (workspace_id, email)
  where accepted_at is null and declined_at is null;
create index if not exists workspace_invitations_email_idx on public.workspace_invitations (email)
  where accepted_at is null and declined_at is null;
create index if not exists workspace_invitations_invited_by_idx on public.workspace_invitations (invited_by);

alter table public.workspace_invitations enable row level security;
revoke all on public.workspace_invitations from anon, authenticated;
grant select, delete on public.workspace_invitations to authenticated;
grant all on public.workspace_invitations to service_role;

-- the caller's e-mail, only when Auth has verified it (agents never match: their domain cannot be invited)
create or replace function private.my_verified_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null and u.email is not null;
$$;
revoke execute on function private.my_verified_email() from public, anon;
grant execute on function private.my_verified_email() to authenticated, service_role;

drop policy if exists "workspace_invitations: admins and invitee read" on public.workspace_invitations;
create policy "workspace_invitations: admins and invitee read" on public.workspace_invitations for select to authenticated
  using (workspace_id in (select private.my_workspaces('admin')) or email = (select private.my_verified_email()));
drop policy if exists "workspace_invitations: admins revoke" on public.workspace_invitations;
create policy "workspace_invitations: admins revoke" on public.workspace_invitations for delete to authenticated
  using (workspace_id in (select private.my_workspaces('admin')) and not (select private.is_oauth_client()));

create or replace function public.invite_to_workspace(p_workspace uuid, p_email text, p_role public.workspace_role default 'member')
returns public.workspace_invitations
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower(trim(coalesce(p_email, '')));
  v_inv public.workspace_invitations;
begin
  if v_uid is null or private.is_agent() or private.is_oauth_client()
     or not exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = p_workspace and wm.user_id = v_uid and wm.role in ('owner', 'admin')) then
    raise exception 'workspace admin required' using errcode = '42501';
  end if;
  if coalesce(p_role, 'member') = 'owner' and not exists (
       select 1 from public.workspace_members wm where wm.workspace_id = p_workspace and wm.user_id = v_uid and wm.role = 'owner') then
    raise exception 'only owners can invite owners' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 320 then
    raise exception 'invalid e-mail address' using errcode = '22023';
  end if;
  if v_email like '%@agents.supaknowledge.internal' then
    raise exception 'agents are created with the agents API, not invited' using errcode = '22023';
  end if;
  if (select count(*) from public.audit_log a
       where a.actor_user_id = v_uid and a.action = 'workspace_invitation.created' and a.at > now() - interval '1 hour') >= 30 then
    raise exception 'too many invitations, try again later' using errcode = 'PT429';
  end if;
  if exists (select 1 from public.workspace_members wm join auth.users u on u.id = wm.user_id
              where wm.workspace_id = p_workspace and lower(u.email) = v_email) then
    raise exception 'already a member of this workspace' using errcode = '23505';
  end if;

  update public.workspace_invitations i
     set role = coalesce(p_role, 'member'), invited_by = v_uid, created_at = now(), expires_at = now() + interval '14 days'
   where i.workspace_id = p_workspace and i.email = v_email and i.accepted_at is null and i.declined_at is null
  returning * into v_inv;
  if v_inv.id is null then
    insert into public.workspace_invitations (workspace_id, email, role, invited_by)
    values (p_workspace, v_email, coalesce(p_role, 'member'), v_uid)
    returning * into v_inv;
  end if;

  insert into public.audit_log (workspace_id, actor_user_id, actor, action, target_kind, target_id, data)
  values (p_workspace, v_uid, 'user:' || v_uid::text, 'workspace_invitation.created', 'invitation', v_inv.id,
          jsonb_build_object('email', v_email, 'role', v_inv.role));
  return v_inv;
end;
$$;
revoke execute on function public.invite_to_workspace(uuid, text, public.workspace_role) from public, anon;
grant execute on function public.invite_to_workspace(uuid, text, public.workspace_role) to authenticated;

-- open, unexpired invitations for the caller's verified e-mail (with the workspace name the invitee cannot read yet)
create or replace function public.list_my_invitations()
returns table (id uuid, workspace_id uuid, workspace_slug text, workspace_name text, role public.workspace_role,
               invited_by_name text, created_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.workspace_id, w.slug, w.name, i.role, p.display_name, i.created_at, i.expires_at
  from public.workspace_invitations i
  join public.workspaces w on w.id = i.workspace_id
  left join public.profiles p on p.id = i.invited_by
  where i.email = private.my_verified_email()
    and i.accepted_at is null and i.declined_at is null and i.expires_at > now()
    and not private.is_agent()
  order by i.created_at desc;
$$;
revoke execute on function public.list_my_invitations() from public, anon;
grant execute on function public.list_my_invitations() to authenticated;

-- the invitation, locked, if it is addressed to the caller (uniform "not found" otherwise)
create or replace function private.my_open_invitation(p_id uuid) returns public.workspace_invitations
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.workspace_invitations;
begin
  if (select auth.uid()) is null or private.is_agent() or private.is_oauth_client() then
    raise exception 'only the invited person can answer an invitation, from a Studio / CLI session' using errcode = '42501';
  end if;
  select * into v_inv from public.workspace_invitations i
   where i.id = p_id and i.email = private.my_verified_email()
   for update;
  if v_inv.id is null then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if v_inv.accepted_at is not null or v_inv.declined_at is not null then
    raise exception 'invitation was already answered' using errcode = '22023';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invitation expired; ask for a new one' using errcode = '22023';
  end if;
  return v_inv;
end;
$$;
revoke execute on function private.my_open_invitation(uuid) from public, anon, authenticated;

create or replace function public.accept_invitation(p_id uuid) returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.workspace_invitations := private.my_open_invitation(p_id);
  ws public.workspaces;
begin
  -- already a member (e.g. invited twice): keep the existing role
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_inv.workspace_id, (select auth.uid()), v_inv.role)
  on conflict do nothing;
  update public.workspace_invitations set accepted_at = now() where id = v_inv.id;
  select * into ws from public.workspaces w where w.id = v_inv.workspace_id;
  return ws;
end;
$$;
revoke execute on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.accept_invitation(uuid) to authenticated;

create or replace function public.decline_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.workspace_invitations := private.my_open_invitation(p_id);
begin
  update public.workspace_invitations set declined_at = now() where id = v_inv.id;
end;
$$;
revoke execute on function public.decline_invitation(uuid) from public, anon;
grant execute on function public.decline_invitation(uuid) to authenticated;

-- membership: admins change roles and remove people, but can no longer add anyone directly
drop policy if exists "workspace_members: admins manage" on public.workspace_members;
drop policy if exists "workspace_members: admins update" on public.workspace_members;
drop policy if exists "workspace_members: admins delete" on public.workspace_members;
create policy "workspace_members: admins update" on public.workspace_members for update to authenticated
  using (
    workspace_id in (select private.my_workspaces('admin'))
    -- only owners can demote owners
    and (role <> 'owner' or workspace_id in (select private.my_workspaces('owner')))
  )
  with check (
    workspace_id in (select private.my_workspaces('admin'))
    -- only owners can mint owners
    and (role <> 'owner' or workspace_id in (select private.my_workspaces('owner')))
  );
create policy "workspace_members: admins delete" on public.workspace_members for delete to authenticated
  using (
    workspace_id in (select private.my_workspaces('admin'))
    and (role <> 'owner' or workspace_id in (select private.my_workspaces('owner')))
  );
revoke insert on public.workspace_members from authenticated, anon;

drop function if exists public.find_user_by_email(uuid, text);

-- answered / expired invitations are kept 30 days for the audit trail
create or replace function util.cleanup_invitations() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  delete from public.workspace_invitations
   where coalesce(accepted_at, declined_at, expires_at) < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function util.cleanup_invitations() from public, anon, authenticated;
select cron.schedule('kf-invitations-cleanup', '27 4 * * *', $$ select util.cleanup_invitations(); $$);

-- ---------------------------------------------------------------------------------------------------------
-- Skill files ride inside proposal ops (after.files, base64 for binaries). Once `bundle/sync-files` has copied
-- an APPLIED proposal's files into Storage, it replaces each file's content with metadata
-- ({path, encoding, content_type, size_bytes, sha256, stripped: true}) so applied proposals do not keep MBs of
-- inline content. Paths must stay the same; the proposal's access/escalation is not recomputed (history).
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.kf_strip_proposal_files(p_op uuid, p_files jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_after jsonb;
  v_status public.proposal_status;
begin
  select o.after, p.status into v_after, v_status
    from public.proposal_ops o join public.proposals p on p.id = o.proposal_id
   where o.id = p_op
   for update of o;
  if v_after is null then
    return false;
  end if;
  if v_status <> 'applied' then
    raise exception 'only applied proposals are stripped' using errcode = '22023';
  end if;
  if jsonb_typeof(v_after -> 'files') <> 'array' or jsonb_typeof(p_files) <> 'array'
     or (select coalesce(array_agg(f ->> 'path' order by f ->> 'path'), '{}') from jsonb_array_elements(v_after -> 'files') f)
        is distinct from
        (select coalesce(array_agg(f ->> 'path' order by f ->> 'path'), '{}') from jsonb_array_elements(p_files) f)
     or exists (select 1 from jsonb_array_elements(p_files) f where f ? 'content') then
    raise exception 'stripped files must list the same paths without content' using errcode = '22023';
  end if;
  perform set_config('kf.defer_recompute', 'on', true);
  update public.proposal_ops set after = jsonb_set(v_after, '{files}', p_files) where id = p_op;
  perform set_config('kf.defer_recompute', '', true);
  return true;
end;
$$;
revoke execute on function public.kf_strip_proposal_files(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kf_strip_proposal_files(uuid, jsonb) to service_role;
