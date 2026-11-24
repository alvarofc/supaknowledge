-- Supaknowledge: review fixes, part 2 — tenancy invariants and data lifecycle.
--
--   * Membership rows never change tenant: workspace_id / space_id / group_id / user_id are immutable on
--     workspace_members, space_members, group_members, space_group_grants and groups (trigger based, so PostgREST
--     upserts that re-send the same keys keep working).
--   * space_members / group_members only accept users who are members of that workspace.
--   * Agents can never be workspace owner/admin or space admin.
--   * Removing someone from a workspace also removes their space and group memberships in it.
--   * A workspace always keeps at least one owner (unless the workspace or the user account is being deleted).
--   * Membership and group changes are written to audit_log.
--   * A group cannot be deleted while any row still uses it as an audience (it would lock that data away from
--     everyone, owners included).
--   * Deleting a source deletes its Vault secret; deleted sources, concepts, spaces and soft-deleted documents
--     queue their Storage objects in public.kf_storage_gc for an Edge Function to remove.
--   * Documents are never wider than their source: inserting/updating a document, or tightening a source's
--     audience, narrows the documents' audiences.
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- immutable keys
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.forbid_key_change() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
begin
  foreach k in array tg_argv loop
    if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception '%.% cannot be changed', tg_table_name, k using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function private.forbid_key_change() from public, anon, authenticated;

create or replace trigger workspace_members_keys before update on public.workspace_members
  for each row execute function private.forbid_key_change('workspace_id', 'user_id');
create or replace trigger space_members_keys before update on public.space_members
  for each row execute function private.forbid_key_change('space_id', 'user_id');
create or replace trigger group_members_keys before update on public.group_members
  for each row execute function private.forbid_key_change('group_id', 'user_id');
create or replace trigger space_group_grants_keys before update on public.space_group_grants
  for each row execute function private.forbid_key_change('space_id', 'group_id');
create or replace trigger groups_keys before update on public.groups
  for each row execute function private.forbid_key_change('workspace_id');
create or replace trigger agents_keys before update on public.agents
  for each row execute function private.forbid_key_change('id', 'workspace_id');

-- ---------------------------------------------------------------------------------------------------------
-- membership rules
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.check_workspace_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role in ('owner', 'admin') and private.is_agent_user(new.user_id) then
    raise exception 'agents cannot be workspace owners or admins' using errcode = '42501';
  end if;
  return new;
end;
$$;
create or replace trigger workspace_members_check before insert or update on public.workspace_members
  for each row execute function private.check_workspace_member();

create or replace function private.check_space_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.spaces s join public.workspace_members wm on wm.workspace_id = s.workspace_id
                  where s.id = new.space_id and wm.user_id = new.user_id) then
    raise exception 'user is not a member of this workspace; add them to the workspace first' using errcode = '42501';
  end if;
  if new.role = 'admin' and private.is_agent_user(new.user_id) then
    raise exception 'agents cannot be space admins' using errcode = '42501';
  end if;
  return new;
end;
$$;
create or replace trigger space_members_check before insert or update on public.space_members
  for each row execute function private.check_space_member();

create or replace function private.check_group_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.groups g join public.workspace_members wm on wm.workspace_id = g.workspace_id
                  where g.id = new.group_id and wm.user_id = new.user_id) then
    raise exception 'user is not a member of this workspace; add them to the workspace first' using errcode = '42501';
  end if;
  return new;
end;
$$;
create or replace trigger group_members_check before insert or update on public.group_members
  for each row execute function private.check_group_member();

create or replace function private.check_space_group_grant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.groups g join public.spaces s on s.workspace_id = g.workspace_id
                  where g.id = new.group_id and s.id = new.space_id) then
    raise exception 'group belongs to another workspace' using errcode = '42501';
  end if;
  return new;
end;
$$;
create or replace trigger space_group_grants_check before insert or update on public.space_group_grants
  for each row execute function private.check_space_group_grant();

-- last owner: refuse to remove or demote the only owner. Cascades (workspace or Auth user deleted) are allowed:
-- in a cascade the parent row is already invisible.
create or replace function private.keep_an_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id)
     and exists (select 1 from auth.users u where u.id = old.user_id)
     and not exists (select 1 from public.workspace_members wm
                      where wm.workspace_id = old.workspace_id and wm.role = 'owner' and wm.user_id <> old.user_id) then
    raise exception 'a workspace must keep at least one owner' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create or replace trigger workspace_members_keep_owner before update or delete on public.workspace_members
  for each row execute function private.keep_an_owner();

-- leaving a workspace removes the user's space and group memberships there
create or replace function private.on_workspace_member_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.space_members sm using public.spaces s
   where sm.space_id = s.id and s.workspace_id = old.workspace_id and sm.user_id = old.user_id;
  delete from public.group_members gm using public.groups g
   where gm.group_id = g.id and g.workspace_id = old.workspace_id and gm.user_id = old.user_id;
  return null;
end;
$$;
create or replace trigger workspace_members_removed after delete on public.workspace_members
  for each row execute function private.on_workspace_member_removed();

-- ---------------------------------------------------------------------------------------------------------
-- audit membership changes (who added whom to `finance`, ...). Skipped inside cascades of a deleted
-- workspace/space (the audit row would reference the row being deleted).
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.audit_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  v_ws uuid;
  v_space uuid;
  v_target uuid;
  v_kind text;
begin
  case tg_table_name
    when 'workspace_members' then v_ws := (r ->> 'workspace_id')::uuid; v_target := (r ->> 'user_id')::uuid; v_kind := 'user';
    when 'space_members' then
      v_space := (r ->> 'space_id')::uuid; v_target := (r ->> 'user_id')::uuid; v_kind := 'user';
      select s.workspace_id into v_ws from public.spaces s where s.id = v_space;
    when 'space_group_grants' then
      v_space := (r ->> 'space_id')::uuid; v_target := (r ->> 'group_id')::uuid; v_kind := 'group';
      select s.workspace_id into v_ws from public.spaces s where s.id = v_space;
    when 'group_members' then
      select g.workspace_id into v_ws from public.groups g where g.id = (r ->> 'group_id')::uuid;
      v_target := (r ->> 'user_id')::uuid; v_kind := 'user';
    when 'groups' then v_ws := (r ->> 'workspace_id')::uuid; v_target := (r ->> 'id')::uuid; v_kind := 'group';
  end case;
  if v_ws is null or not exists (select 1 from public.workspaces w where w.id = v_ws) then
    return null;
  end if;
  if v_space is not null and not exists (select 1 from public.spaces s where s.id = v_space) then
    v_space := null;
  end if;
  insert into public.audit_log (workspace_id, space_id, actor_user_id, actor, action, target_kind, target_id, data)
  values (v_ws, v_space, (select auth.uid()),
          case when (select auth.uid()) is null then 'system' else 'user:' || (select auth.uid())::text end,
          tg_table_name || '.' || lower(tg_op), v_kind, v_target,
          jsonb_build_object('new', case when tg_op <> 'DELETE' then to_jsonb(new) end,
                             'old', case when tg_op <> 'INSERT' then to_jsonb(old) end));
  return null;
end;
$$;
create or replace trigger workspace_members_audit after insert or update or delete on public.workspace_members
  for each row execute function private.audit_membership();
create or replace trigger space_members_audit after insert or update or delete on public.space_members
  for each row execute function private.audit_membership();
create or replace trigger group_members_audit after insert or update or delete on public.group_members
  for each row execute function private.audit_membership();
create or replace trigger space_group_grants_audit after insert or update or delete on public.space_group_grants
  for each row execute function private.audit_membership();
create or replace trigger groups_audit after insert or update or delete on public.groups
  for each row execute function private.audit_membership();

-- ---------------------------------------------------------------------------------------------------------
-- groups in use as an audience cannot be deleted (unless the whole workspace is being deleted)
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.guard_group_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  g uuid[] := array[old.id];
  v_uses text;
begin
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  select string_agg(x.what, ', ') into v_uses from (
    select 'concepts' as what where exists (select 1 from public.concepts c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.audience && g)
    union all select 'sources' where exists (select 1 from public.sources c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.audience && g)
    union all select 'source documents' where exists (select 1 from public.source_documents c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.audience && g)
    union all select 'traces' where exists (select 1 from public.traces c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.audience && g)
    union all select 'flags' where exists (select 1 from public.flags c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.audience && g)
    union all select 'pending proposals' where exists (select 1 from public.proposal_ops o join public.proposals p on p.id = o.proposal_id
                                             join public.spaces s on s.id = p.space_id
                                             where s.workspace_id = old.workspace_id and p.status in ('pending', 'approved')
                                               and o.target_audience && g)
  ) x;
  if v_uses is not null then
    raise exception 'group "%" is still used as an audience by %; change those audiences first', old.slug, v_uses
      using errcode = '23503';
  end if;
  return old;
end;
$$;
create or replace trigger groups_guard_delete before delete on public.groups
  for each row execute function private.guard_group_delete();

-- ---------------------------------------------------------------------------------------------------------
-- Storage garbage collection queue. Postgres cannot delete Storage objects itself (the bytes live in the object
-- store), so deletions are recorded here and an Edge Function (service role) removes every object under
-- `prefix` in `bucket`, then deletes the row. Not readable by API roles.
-- ---------------------------------------------------------------------------------------------------------
create table if not exists public.kf_storage_gc (
  id bigint generated always as identity primary key,
  bucket text not null,
  prefix text not null,              -- object name prefix ("<space>/<source>/") or exact object name
  reason text not null,
  created_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text
);
alter table public.kf_storage_gc enable row level security;
revoke all on public.kf_storage_gc from anon, authenticated;
grant all on public.kf_storage_gc to service_role;

create or replace function private.on_source_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.secret_id is not null then
    delete from vault.secrets vs where vs.id = old.secret_id and vs.name = 'kf_source_' || old.id::text;
  end if;
  insert into public.kf_storage_gc (bucket, prefix, reason)
  values ('sources', old.space_id::text || '/' || old.id::text || '/', 'source deleted');
  return null;
end;
$$;
create or replace trigger sources_deleted after delete on public.sources
  for each row execute function private.on_source_deleted();

create or replace function private.on_concept_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.spaces s where s.id = old.space_id) then
    insert into public.kf_storage_gc (bucket, prefix, reason)
    values ('concept-files', old.space_id::text || '/' || old.id::text || '/', 'concept deleted');
  end if;
  return null;
end;
$$;
create or replace trigger concepts_deleted after delete on public.concepts
  for each row execute function private.on_concept_deleted();

create or replace function private.on_space_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.kf_storage_gc (bucket, prefix, reason)
  values ('concept-files', old.id::text || '/', 'space deleted'), ('sources', old.id::text || '/', 'space deleted');
  return null;
end;
$$;
create or replace trigger spaces_deleted after delete on public.spaces
  for each row execute function private.on_space_deleted();

create or replace function private.on_document_soft_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null and old.deleted_at is null and new.storage_path is not null then
    insert into public.kf_storage_gc (bucket, prefix, reason) values ('sources', new.storage_path, 'document deleted');
  end if;
  return null;
end;
$$;
create or replace trigger source_documents_soft_deleted after update of deleted_at on public.source_documents
  for each row execute function private.on_document_soft_deleted();

-- ---------------------------------------------------------------------------------------------------------
-- documents are never wider than their source
-- ---------------------------------------------------------------------------------------------------------
-- Readers(doc) must be a subset of Readers(source). Keep the document's groups that are also source groups;
-- if none remain (or the document was unrestricted), take the source's audience.
create or replace function private.clamp_audience(p_doc uuid[], p_source uuid[]) returns uuid[]
language sql immutable set search_path = '' as $$
  select case
    when coalesce(cardinality(p_source), 0) = 0 then coalesce(p_doc, '{}')
    when coalesce(cardinality(p_doc), 0) = 0 then p_source
    when p_doc <@ p_source then p_doc
    when exists (select 1 from unnest(p_doc) d where d = any (p_source))
      then array(select d from unnest(p_doc) d where d = any (p_source))
    else p_source
  end;
$$;

create or replace function private.source_document_audience() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_src uuid[];
begin
  select s.audience into v_src from public.sources s where s.id = new.source_id;
  new.audience := private.clamp_audience(new.audience, v_src);
  return new;
end;
$$;
create or replace trigger source_documents_audience before insert or update of audience, source_id on public.source_documents
  for each row execute function private.source_document_audience();

create or replace function private.on_source_audience_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.source_documents d set audience = private.clamp_audience(d.audience, new.audience)
   where d.source_id = new.id and d.audience is distinct from private.clamp_audience(d.audience, new.audience);
  return null;
end;
$$;
create or replace trigger sources_audience_changed after update of audience on public.sources
  for each row when (old.audience is distinct from new.audience)
  execute function private.on_source_audience_changed();

do $$
declare
  f text;
begin
  foreach f in array array['check_workspace_member()', 'check_space_member()', 'check_group_member()', 'check_space_group_grant()',
                           'keep_an_owner()', 'on_workspace_member_removed()', 'audit_membership()', 'guard_group_delete()',
                           'on_source_deleted()', 'on_concept_deleted()', 'on_space_deleted()', 'on_document_soft_deleted()',
                           'source_document_audience()', 'on_source_audience_changed()'] loop
    execute format('revoke execute on function private.%s from public, anon, authenticated', f);
  end loop;
end $$;
