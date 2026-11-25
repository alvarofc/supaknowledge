-- Supaknowledge: hardening from the access-control review (supabase/tests/database) + small API additions.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Column-level write grants: RLS decides WHICH rows, grants decide WHICH columns.
-- ---------------------------------------------------------------------------------------------------------

-- flags: reviewers triage (status/resolution) but cannot rewrite who raised it, its audience or space
revoke update on public.flags from authenticated, anon;
grant update (status, resolution, resolved_by, resolved_at, proposal_id) on public.flags to authenticated;

-- proposals: authors write the content; review/apply/escalation fields belong to the RPCs and triggers
revoke insert, update on public.proposals from authenticated, anon;
grant insert (space_id, author, created_by, title, rationale, risk) on public.proposals to authenticated;

-- proposal ops/citations: never re-pointed after insert (escalation is computed at insert time)
revoke update on public.proposal_ops, public.proposal_citations from authenticated, anon;

-- traces: senders can close their trace and add metadata, not re-home it
revoke update on public.traces from authenticated, anon;
grant update (name, outcome, metadata, started_at, ended_at, on_behalf_of, audience) on public.traces to authenticated;

-- agents: the agents function records the display prefix of the current key (admins only, by RLS)
grant update (key_prefix) on public.agents to authenticated;

-- Studio shows "sync requested"
grant select (sync_requested_at) on public.sources to authenticated;

-- RLS is the only barrier on these tables; TRUNCATE bypasses RLS, so nobody but the owner gets it.
revoke truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;

-- internal helpers that need not be callable by API roles
revoke execute on function private.space_settings(uuid) from public, anon, authenticated;
revoke execute on function private.recompute_proposal_access(uuid) from public, anon, authenticated;
revoke execute on function private.on_proposal_child_change() from public, anon, authenticated;
revoke execute on function private.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- 2. profiles.kind follows app_metadata (the Auth admin API may set app_metadata after the insert).
--    app_metadata is not user-editable, so this cannot be used to self-promote.
-- ---------------------------------------------------------------------------------------------------------
create function private.sync_profile_kind() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles
     set kind = case when new.raw_app_meta_data ->> 'kind' = 'agent' then 'agent'::public.principal_kind
                     else 'human'::public.principal_kind end
   where id = new.id;
  return new;
end;
$$;
revoke execute on function private.sync_profile_kind() from public, anon, authenticated;

create trigger on_auth_user_kind
  after update of raw_app_meta_data on auth.users
  for each row when (old.raw_app_meta_data ->> 'kind' is distinct from new.raw_app_meta_data ->> 'kind')
  execute function private.sync_profile_kind();

-- ---------------------------------------------------------------------------------------------------------
-- 3. Add people by email: workspace admins can resolve an email to a user id (exact match only).
-- ---------------------------------------------------------------------------------------------------------
create function public.find_user_by_email(p_workspace uuid, p_email text)
returns table (user_id uuid, display_name text, kind public.principal_kind)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = p_workspace and wm.user_id = (select auth.uid()) and wm.role in ('owner', 'admin')) then
    raise exception 'workspace admin required' using errcode = '42501';
  end if;
  return query
    select u.id, p.display_name, p.kind
    from auth.users u join public.profiles p on p.id = u.id
    where lower(u.email) = lower(trim(p_email))
    limit 1;
end;
$$;
revoke execute on function public.find_user_by_email(uuid, text) from public, anon;
grant execute on function public.find_user_by_email(uuid, text) to authenticated;
