-- Supaknowledge: review fixes, round 2 (verification review of migrations 11-20).
--
--   * Own-row RLS branches (own traces, traces on your behalf, your flags, your usage, appending trace events,
--     updating your traces) require CURRENT reader access to the space: people removed from a space/workspace
--     no longer read their old restricted traces or feed new events to the curator.
--   * Revoked agents (agents.revoked_at <= now()) hold no role, space, workspace or group: an access token
--     minted before the revoke is useless against PostgREST/RLS right away (not only after it expires).
--   * Agent passwords (= agent keys) change only through key rotation: a trigger on auth.users refuses any
--     other password change of an agent user (e.g. PUT /auth/v1/user with the agent's own session). The
--     `agents` function authorises one change with public.kf_allow_agent_password_change() right before it
--     calls the Auth admin API.
--   * private.aud_ok() is a bare `audience = '{}' or audience && groups` so the GIN indexes on audience apply.
--   * Citation audience snapshots follow the evidence: when a cited row changes audience, the snapshot of open
--     proposals is refreshed, so a cited row that is deleted later (source delete, trace retention) keeps its
--     last known audience instead of a stale, wider one. Escalation still uses the live audience while the row
--     exists.
--   * Client-supplied citation audiences are ignored for people (only the service role, and propose_revert
--     internally, may set the audience of a citation without a ref_id), and every audience group must belong
--     to the space's workspace. traces.audience and sources.audience are validated the same way.
--   * URL citations resolve only against documents the author can see that are not soft-deleted (no
--     existence oracle for restricted URLs); soft-deleted documents cannot be cited.
--   * apply_proposal no longer erases the escalation flag of the proposal it is applying (the concept audience
--     it writes used to trigger a recompute of that same proposal); apply/reject/propose_revert authorise
--     before taking locks and answer one uniform 42501 for "not found" and "not allowed".
--   * guard_group_delete(): also protects revisions and open proposal citations; ignores soft-deleted
--     documents, closed flags and traces (fail closed). public.retire_group() replaces a group by another one
--     everywhere in the workspace and deletes it.
--   * Storage GC never removes live objects (revived / re-uploaded documents, existing concept files);
--     kf_storage_gc_objects() is index friendly.
--   * An agent's workspace membership cannot be deleted directly (it would leave an active agent that can never
--     be re-added); deleting the agent (or its workspace / Auth user) still removes it.
--   * usage_counts() only counts concepts the caller can see and works for the service role.
--   * Workspace invitations: only owners refresh or revoke owner invitations; the hourly invitation limit is
--     kept in a per-user table that does not disappear with the workspace.
--   * Concurrency: evidence audience changes recompute proposals in id order; removing/demoting an owner locks
--     the workspace row.
--   * Service-only RPCs check is_service_role() themselves; kf_strip_proposal_files restores the previous GUC
--     value; kf_revoke_user_sessions deletes through auth.sessions (refresh tokens cascade).
--   * search CTEs filter concepts/documents by space; curator.stuck_after_minutes minimum is 10.
--   * agents.last_seen_at is no longer client-writable.
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- audiences: GIN-friendly check (columns are NOT NULL, my_group_ids() never returns null)
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.aud_ok(p_audience uuid[], p_groups uuid[]) returns boolean
language sql immutable parallel safe as $$
  select p_audience = '{}'::uuid[] or p_audience && p_groups;
$$;

-- procedural callers keep "null audience = everyone"
create or replace function private.in_audience(p_audience uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.aud_ok(coalesce(p_audience, '{}'::uuid[]), private.my_group_ids());
$$;

-- ---------------------------------------------------------------------------------------------------------
-- revoked agents hold nothing
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.is_revoked_agent() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.agents a
                  where a.id = (select auth.uid()) and a.revoked_at is not null and a.revoked_at <= now());
$$;
-- (called inside the SECURITY DEFINER helpers below, never directly by API roles)
revoke execute on function private.is_revoked_agent() from public, anon, authenticated;

create or replace function private.my_group_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(gm.group_id), '{}'::uuid[])
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  join public.workspace_members wm on wm.workspace_id = g.workspace_id and wm.user_id = gm.user_id
  where gm.user_id = (select auth.uid()) and not (select private.is_revoked_agent());
$$;

create or replace function private.my_workspaces(min_role public.workspace_role default 'member') returns setof uuid
language sql stable security definer set search_path = '' as $$
  select wm.workspace_id from public.workspace_members wm
  where wm.user_id = (select auth.uid())
    and not (select private.is_revoked_agent())
    and (min_role = 'member'
         or (min_role = 'admin' and wm.role in ('owner', 'admin'))
         or (min_role = 'owner' and wm.role = 'owner'));
$$;

create or replace function private.space_rank(p_space uuid) returns int
language sql stable security definer set search_path = '' as $$
  with sp as (
    select s.id, s.workspace_id, s.visibility, wm.role as ws_role
    from public.spaces s
    join public.workspace_members wm on wm.workspace_id = s.workspace_id and wm.user_id = (select auth.uid())
    where s.id = p_space and not (select private.is_revoked_agent())
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
    where not (select private.is_revoked_agent())
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

-- agents.last_seen_at is written by private.touch_agent_last_seen() (SECURITY DEFINER) only
revoke update on public.agents from authenticated, anon;
grant update (name, description) on public.agents to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- own-row RLS branches require current reader access to the space
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "traces: own or reviewers" on public.traces;
create policy "traces: own or reviewers" on public.traces for select to authenticated
  using (
    ((principal_id = (select auth.uid()) or on_behalf_of = (select auth.uid()))
     and space_id in (select private.my_spaces('reader')))
    or (space_id in (select private.my_spaces('reviewer')) and private.aud_ok(audience, (select private.my_group_ids())))
  );

drop policy if exists "traces: sender updates own" on public.traces;
create policy "traces: sender updates own" on public.traces for update to authenticated
  using (principal_id = (select auth.uid()) and space_id in (select private.my_spaces('reader')))
  with check (principal_id = (select auth.uid()) and space_id in (select private.my_spaces('reader')));

drop policy if exists "trace_events: sender inserts" on public.trace_events;
create policy "trace_events: sender inserts" on public.trace_events for insert to authenticated
  with check (
    trace_events.space_id in (select private.my_spaces('reader'))
    and exists (select 1 from public.traces t
                 where t.id = trace_events.trace_id and t.space_id = trace_events.space_id
                   and t.principal_id = (select auth.uid()))
  );

drop policy if exists "flags: author or editors" on public.flags;
create policy "flags: author or editors" on public.flags for select to authenticated
  using (
    (created_by = (select auth.uid()) and space_id in (select private.my_spaces('reader')))
    or (space_id in (select private.my_spaces('editor')) and private.aud_ok(audience, (select private.my_group_ids())))
  );

drop policy if exists "concept_usage: reviewers or own" on public.concept_usage;
create policy "concept_usage: reviewers or own" on public.concept_usage for select to authenticated
  using (
    (principal_id = (select auth.uid()) and space_id in (select private.my_spaces('reader')))
    or (space_id in (select private.my_spaces('reviewer'))
        and exists (select 1 from public.concepts c where c.id = concept_usage.concept_id))
  );

-- ---------------------------------------------------------------------------------------------------------
-- audiences name groups of the row's workspace (no foreign or invented group ids)
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.audience_error(p_space uuid, p_audience uuid[]) returns text
language sql stable security definer set search_path = '' as $$
  select case when exists (
      select 1 from unnest(coalesce(p_audience, '{}'::uuid[])) g
      where g is null or not exists (select 1 from public.groups gr join public.spaces s on s.workspace_id = gr.workspace_id
                                      where gr.id = g and s.id = p_space))
    then 'audience names a group that does not exist in this workspace' end;
$$;
revoke execute on function private.audience_error(uuid, uuid[]) from public, anon, authenticated;

create or replace function private.check_audience_groups() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_err text;
begin
  if tg_op = 'INSERT' or new.audience is distinct from old.audience or new.space_id is distinct from old.space_id then
    v_err := private.audience_error(new.space_id, new.audience);
    if v_err is not null then
      raise exception '%.%', tg_table_name, v_err using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.check_audience_groups() from public, anon, authenticated;
create or replace trigger traces_audience_groups before insert or update of audience, space_id on public.traces
  for each row execute function private.check_audience_groups();
create or replace trigger sources_audience_groups before insert or update of audience, space_id on public.sources
  for each row execute function private.check_audience_groups();

-- ---------------------------------------------------------------------------------------------------------
-- citations
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.proposal_citation_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_visible boolean := false;
  v_service boolean := private.is_service_role();
  v_trusted boolean := coalesce(current_setting('kf.trusted_citation_audience', true), '') = 'on';
  v_uid uuid := (select auth.uid());
  v_rank int := 0;
  v_groups uuid[] := '{}';
  v_doc uuid;
  v_err text;
  r record;
begin
  select p.space_id into new.space_id from public.proposals p where p.id = new.proposal_id;
  if not v_service then
    v_rank := private.space_rank(new.space_id);
    v_groups := private.my_group_ids();
  end if;

  -- a URL that is a live document of this space IS that document (and carries its audience). People only
  -- resolve against documents they can read, so the outcome never reveals a restricted URL.
  if new.ref_kind = 'url' and new.ref_id is null and coalesce(new.url, '') <> '' then
    select d.id into v_doc from public.source_documents d
     where d.space_id = new.space_id and d.url = new.url and d.deleted_at is null
       and (v_service or (v_rank >= 2 and private.aud_ok(d.audience, v_groups)))
     order by (d.audience = '{}'), d.id
     limit 1;
    if v_doc is not null then
      new.ref_kind := 'source_document';
      new.ref_id := v_doc;
    end if;
  end if;

  if new.ref_id is not null then
    case new.ref_kind
      when 'source_document' then
        select d.audience as audience into r from public.source_documents d
         where d.id = new.ref_id and d.space_id = new.space_id and d.deleted_at is null;
        v_visible := found and (v_service or (v_rank >= 2 and private.aud_ok(r.audience, v_groups)));
      when 'trace' then
        select t.audience as audience, t.principal_id, t.on_behalf_of into r from public.traces t
         where t.id = new.ref_id and t.space_id = new.space_id;
        v_visible := found and (v_service or (v_rank >= 1 and (r.principal_id = v_uid or r.on_behalf_of = v_uid))
                                or (v_rank >= 3 and private.aud_ok(r.audience, v_groups)));
      when 'flag' then
        select f.audience as audience, f.created_by into r from public.flags f where f.id = new.ref_id and f.space_id = new.space_id;
        v_visible := found and (v_service or (v_rank >= 1 and r.created_by = v_uid)
                                or (v_rank >= 2 and private.aud_ok(r.audience, v_groups)));
      when 'concept' then
        select c.audience as audience into r from public.concepts c where c.id = new.ref_id and c.space_id = new.space_id;
        v_visible := found and (v_service or (v_rank >= 1 and private.aud_ok(r.audience, v_groups)));
      else
        raise exception 'url citations cannot carry a ref_id' using errcode = '22023';
    end case;
    if not coalesce(v_visible, false) then
      raise exception 'cited % not found', new.ref_kind using errcode = '42501';
    end if;
    new.audience := r.audience;
  elsif v_service or v_trusted then
    -- the curator (or propose_revert, for the revision it restores) states the audience of evidence that is
    -- not a row: it must name groups of this workspace, and a person must be in it
    new.audience := coalesce(new.audience, '{}');
    v_err := private.audience_error(new.space_id, new.audience);
    if v_err is not null then
      raise exception 'invalid citation: %', v_err using errcode = '22023';
    end if;
    if not v_service and not private.aud_ok(new.audience, v_groups) then
      raise exception 'you cannot cite evidence outside your audience' using errcode = '42501';
    end if;
  else
    -- people cannot attach an arbitrary audience (spoofed escalations, zombie proposals nobody may see)
    new.audience := '{}';
  end if;
  new.audience := coalesce(new.audience, '{}');
  return new;
end;
$$;
revoke execute on function private.proposal_citation_defaults() from public, anon, authenticated;

-- escalation/visibility skip the proposal apply_proposal is writing (its own concept writes must not
-- recompute — and erase — the escalation flag it was approved with)
create or replace function private.recompute_proposal_access(p_proposal uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_escalation boolean;
begin
  if p_proposal::text = coalesce(current_setting('kf.applying_proposal', true), '') then
    return;
  end if;
  select
    exists (
      select 1 from private.proposal_citation_audiences(p_proposal) c
      join public.proposal_ops o on o.proposal_id = p_proposal and (c.op_id is null or c.op_id = o.id)
      where private.is_escalation(c.audience, o.target_audience)
    )
    or exists (
      select 1 from public.proposal_ops o join public.concepts k on k.id = o.concept_id
      where o.proposal_id = p_proposal and private.is_escalation(k.audience, o.target_audience)
    )
  into v_escalation;

  update public.proposals p
     set escalation = v_escalation,
         risk = case when v_escalation then 'high'::public.proposal_risk else p.risk end
   where p.id = p_proposal and (p.escalation is distinct from v_escalation or (v_escalation and p.risk <> 'high'));
end;
$$;
revoke execute on function private.recompute_proposal_access(uuid) from public, anon, authenticated;

-- evidence (or a target concept) changed audience: refresh the citation snapshots of open proposals, then
-- recompute their escalation flag in a fixed order (no AB-BA deadlocks between concurrent changes)
create or replace function private.on_evidence_audience_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prop uuid;
  v_kind public.citation_kind := case tg_table_name when 'source_documents' then 'source_document'
                                                    when 'traces' then 'trace' when 'flags' then 'flag'
                                                    when 'concepts' then 'concept' end;
  v_applying text := coalesce(current_setting('kf.applying_proposal', true), '');
  v_prev text := coalesce(current_setting('kf.defer_recompute', true), '');
begin
  perform set_config('kf.defer_recompute', 'on', true);
  update public.proposal_citations c set audience = new.audience
    from public.proposals p
   where c.ref_id = new.id and c.ref_kind = v_kind and p.id = c.proposal_id
     and p.status in ('pending', 'approved') and p.id::text <> v_applying
     and c.audience is distinct from new.audience;
  perform set_config('kf.defer_recompute', v_prev, true);

  for v_prop in
    select p.id from public.proposals p
    where p.status in ('pending', 'approved') and p.id::text <> v_applying
      and (exists (select 1 from public.proposal_citations c where c.proposal_id = p.id and c.ref_id = new.id)
           or (tg_table_name = 'concepts'
               and exists (select 1 from public.proposal_ops o where o.proposal_id = p.id and o.concept_id = new.id)))
    order by p.id
  loop
    perform private.recompute_proposal_access(v_prop);
  end loop;
  return null;
end;
$$;
revoke execute on function private.on_evidence_audience_changed() from public, anon, authenticated;

-- one-time: snapshots of open proposals catch up with audiences changed before this migration
do $$
declare
  v_prev text := coalesce(current_setting('kf.defer_recompute', true), '');
begin
  perform set_config('kf.defer_recompute', 'on', true);
  with live as (
    select c.id, case c.ref_kind
             when 'source_document' then (select d.audience from public.source_documents d where d.id = c.ref_id)
             when 'trace' then (select t.audience from public.traces t where t.id = c.ref_id)
             when 'flag' then (select f.audience from public.flags f where f.id = c.ref_id)
             when 'concept' then (select k.audience from public.concepts k where k.id = c.ref_id)
           end as audience
    from public.proposal_citations c join public.proposals p on p.id = c.proposal_id
    where p.status in ('pending', 'approved') and c.ref_id is not null
  )
  update public.proposal_citations c set audience = live.audience
    from live
   where live.id = c.id and live.audience is not null and c.audience is distinct from live.audience;
  perform set_config('kf.defer_recompute', v_prev, true);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- apply / reject / revert: authorise first (uniform 42501), then lock
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.apply_proposal(p_proposal uuid, p_note text default null, p_actor text default null)
returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
  o public.proposal_ops;
  c public.concepts;
  v_service boolean := private.is_service_role();
  v_agent boolean := false;
  v_rank int;
  v_actor text;
  v_uid uuid := (select auth.uid());
  v_space uuid;
  v_conflicts jsonb := '[]'::jsonb;
  v_err text;
  a jsonb;
begin
  select pr.space_id into v_space from public.proposals pr where pr.id = p_proposal;
  if not v_service then
    if v_uid is null then
      raise exception 'not authenticated' using errcode = '28000';
    end if;
    -- same answer whether the proposal is missing or the caller may not review it
    if v_space is null or private.is_oauth_client() then
      raise exception 'proposal not found or you cannot review it' using errcode = '42501';
    end if;
    v_rank := private.space_rank(v_space);
    if v_rank < 3 then
      raise exception 'proposal not found or you cannot review it' using errcode = '42501';
    end if;
    v_agent := private.is_agent();
  elsif v_space is null then
    raise exception 'proposal not found' using errcode = 'P0002';
  end if;

  -- one apply at a time per space: revision checks, audience checks and the writes see one consistent state
  perform pg_advisory_xact_lock(hashtextextended('supaknowledge.apply_proposal:' || v_space::text, 0));
  select * into p from public.proposals where id = p_proposal for update;
  if p.status not in ('pending', 'approved') then
    if not v_service and not private.can_see_proposal(p.id) then
      raise exception 'proposal not found or you cannot review it' using errcode = '42501';
    end if;
    raise exception 'proposal is %', p.status using errcode = '22023';
  end if;

  -- evidence and concept audiences may have changed since the proposal was drafted
  perform private.recompute_proposal_access(p.id);
  select * into p from public.proposals where id = p.id;

  if not v_service then
    if not private.can_see_proposal(p.id) then
      raise exception 'proposal not found or you cannot review it' using errcode = '42501';
    end if;
    if p.escalation and v_agent then
      raise exception 'this proposal widens access to restricted knowledge; agents cannot approve it' using errcode = '42501';
    end if;
    if p.escalation and v_rank < 4 then
      raise exception 'this proposal widens access to restricted knowledge; a space admin must approve it' using errcode = '42501';
    end if;
    v_actor := case when v_agent then 'agent:' else 'human:' end || v_uid::text;
  else
    if p.escalation then
      raise exception 'escalations always require human approval' using errcode = '42501';
    end if;
    v_actor := coalesce(nullif(trim(p_actor), ''), 'process:policy');
    if v_actor ~* '^(human|agent):' then
      raise exception 'actor prefixes human: and agent: are reserved' using errcode = '22023';
    end if;
  end if;

  if not exists (select 1 from public.proposal_ops where proposal_id = p.id) then
    raise exception 'proposal has no ops' using errcode = '22023';
  end if;

  -- 1. validate every op first so a conflict leaves nothing half-applied. Path collisions report the same
  --    reason whether or not the colliding concept is visible to the caller (paths are unique per space, so a
  --    create on a taken path conflicts either way: an accepted, documented limit).
  for o in select * from public.proposal_ops where proposal_id = p.id order by ord loop
    v_err := private.op_payload_error(o.op, o.path, o.new_path, o.after);
    if v_err is not null then
      v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'invalid op: ' || v_err);
    elsif o.op = 'create' then
      if exists (select 1 from public.concepts k where k.space_id = p.space_id and k.path = o.path)
         or exists (select 1 from public.proposal_ops o2 where o2.proposal_id = p.id and o2.ord < o.ord
                     and ((o2.op = 'create' and o2.path = o.path) or (o2.op = 'move' and o2.new_path = o.path))) then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'path is not available');
      end if;
    else
      select * into c from public.concepts k where k.id = o.concept_id and k.space_id = p.space_id;
      if not found then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'concept not found');
      elsif o.base_revision is not null and c.revision <> o.base_revision then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason',
          format('concept changed since draft (base %s, now %s)', o.base_revision, c.revision));
      elsif o.op = 'move' and (
          exists (select 1 from public.concepts k where k.space_id = p.space_id and k.path = o.new_path)
          or exists (select 1 from public.proposal_ops o2 where o2.proposal_id = p.id and o2.ord < o.ord
                      and ((o2.op = 'create' and o2.path = o.new_path) or (o2.op = 'move' and o2.new_path = o.new_path)))) then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'path is not available');
      end if;
    end if;
  end loop;

  -- 2. apply (a unique violation despite the checks still ends as `conflicted`, never half-applied). While
  --    writing, this proposal is excluded from the audience-change recompute (kf.applying_proposal).
  perform set_config('kf.applying_proposal', p.id::text, true);
  if jsonb_array_length(v_conflicts) = 0 then
    begin
      for o in select * from public.proposal_ops where proposal_id = p.id order by ord loop
        a := o.after;
        if o.op = 'create' then
          insert into public.concepts (space_id, path, kind, type, title, description, body, frontmatter, tags, status,
                                       superseded_by, stale_after, audience, revision, generated_by, generated_at)
          values (
            p.space_id, o.path,
            coalesce((a ->> 'kind')::public.concept_kind, 'domain'),
            coalesce(a ->> 'type', 'Reference'),
            coalesce(a ->> 'title', o.path),
            coalesce(a ->> 'description', ''),
            coalesce(a ->> 'body', ''),
            case when jsonb_typeof(a -> 'frontmatter') = 'object' then a -> 'frontmatter' else '{}'::jsonb end,
            case when jsonb_typeof(a -> 'tags') = 'array' then array(select jsonb_array_elements_text(a -> 'tags')) else '{}'::text[] end,
            coalesce((a ->> 'status')::public.concept_status, 'stable'),
            a ->> 'superseded_by',
            (a ->> 'stale_after')::timestamptz,
            o.target_audience, 1, v_actor, now()
          ) returning * into c;
          update public.concept_links l set to_concept = c.id
           where l.space_id = p.space_id and l.to_path = c.path and l.to_concept is null;
        elsif o.op = 'update' then
          update public.concepts k set
            kind = coalesce((a ->> 'kind')::public.concept_kind, k.kind),
            type = coalesce(a ->> 'type', k.type),
            title = coalesce(a ->> 'title', k.title),
            description = coalesce(a ->> 'description', k.description),
            body = coalesce(a ->> 'body', k.body),
            frontmatter = case when jsonb_typeof(a -> 'frontmatter') = 'object' then a -> 'frontmatter' else k.frontmatter end,
            tags = case when jsonb_typeof(a -> 'tags') = 'array' then array(select jsonb_array_elements_text(a -> 'tags')) else k.tags end,
            status = coalesce((a ->> 'status')::public.concept_status, k.status),
            superseded_by = case when a ? 'superseded_by' then a ->> 'superseded_by' else k.superseded_by end,
            stale_after = case when a ? 'stale_after' then (a ->> 'stale_after')::timestamptz else k.stale_after end,
            audience = o.target_audience,
            revision = k.revision + 1,
            generated_by = v_actor,
            generated_at = now(),
            updated_at = now()
          where k.id = o.concept_id returning * into c;
        elsif o.op = 'deprecate' then
          update public.concepts k set
            status = 'deprecated',
            superseded_by = coalesce(a ->> 'superseded_by', k.superseded_by),
            revision = k.revision + 1, generated_by = v_actor, generated_at = now(), updated_at = now()
          where k.id = o.concept_id returning * into c;
        elsif o.op = 'move' then
          update public.concepts k set
            path = o.new_path, revision = k.revision + 1, generated_by = v_actor, generated_at = now(), updated_at = now()
          where k.id = o.concept_id returning * into c;
          -- links written against the old path no longer resolve to this concept; links to the new path do
          update public.concept_links l set to_concept = null
           where l.space_id = p.space_id and l.to_concept = c.id and l.to_path <> o.new_path;
          update public.concept_links l set to_concept = c.id where l.space_id = p.space_id and l.to_path = o.new_path;
        end if;

        insert into public.concept_revisions (concept_id, space_id, revision, path, kind, type, title, description, body,
          frontmatter, tags, status, superseded_by, stale_after, audience, actor, actor_user_id, reason, proposal_id)
        values (c.id, c.space_id, c.revision, c.path, c.kind, c.type, c.title, c.description, c.body, c.frontmatter,
          c.tags, c.status, c.superseded_by, c.stale_after, c.audience, v_actor, case when not v_service then v_uid end,
          coalesce(o.rationale, p.title), p.id);

        -- humans vouch for what they apply (human_reviewed); agents only confirm it (machine_confirmed)
        if not v_service then
          insert into public.verifications (concept_id, space_id, revision, actor, actor_user_id, note)
          values (c.id, c.space_id, c.revision, v_actor, v_uid, p_note);
        end if;

        update public.proposal_ops set concept_id = c.id where id = o.id and concept_id is null;
      end loop;
    exception when unique_violation then
      v_conflicts := jsonb_build_array(jsonb_build_object('reason', 'path is not available'));
    end;
  end if;

  if jsonb_array_length(v_conflicts) > 0 then
    perform set_config('kf.applying_proposal', '', true);
    update public.proposals set status = 'conflicted', review_note = v_conflicts::text where id = p.id returning * into p;
    perform private.audit(p.space_id, 'proposal.conflicted', 'proposal', p.id, jsonb_build_object('conflicts', v_conflicts));
    return p;
  end if;

  update public.proposals set
    status = 'applied', applied_at = now(), auto_applied = v_service,
    reviewed_by = case when not v_service then v_uid else reviewed_by end,
    reviewed_at = case when not v_service then now() else reviewed_at end,
    review_note = coalesce(p_note, review_note)
  where id = p.id returning * into p;
  perform set_config('kf.applying_proposal', '', true);

  if not v_service then
    insert into public.proposal_reviews (proposal_id, space_id, reviewer, decision, note)
    values (p.id, p.space_id, v_uid, 'approve', p_note);
  end if;

  update public.flags set status = 'resolved', resolved_at = now(), resolved_by = v_uid,
         resolution = coalesce(resolution, 'applied in proposal ' || p.id::text)
   where proposal_id = p.id and status in ('open', 'in_proposal');

  perform private.audit(p.space_id, case when v_service then 'proposal.auto_applied' else 'proposal.applied' end,
                        'proposal', p.id, jsonb_build_object('actor', v_actor));
  return p;
end;
$$;

create or replace function public.reject_proposal(p_proposal uuid, p_note text) returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
  v_service boolean := private.is_service_role();
  v_space uuid;
begin
  select pr.space_id into v_space from public.proposals pr where pr.id = p_proposal;
  if not v_service then
    if v_space is null or (select auth.uid()) is null or private.is_oauth_client() or private.space_rank(v_space) < 3 then
      raise exception 'proposal not found or you cannot review it' using errcode = '42501';
    end if;
  elsif v_space is null then
    raise exception 'proposal not found' using errcode = 'P0002';
  end if;
  select * into p from public.proposals where id = p_proposal for update;
  if not v_service and not private.can_see_proposal(p.id) then
    raise exception 'proposal not found or you cannot review it' using errcode = '42501';
  end if;
  if p.status not in ('pending', 'approved', 'conflicted') then
    raise exception 'proposal is %', p.status using errcode = '22023';
  end if;
  update public.proposals set status = 'rejected', reviewed_by = (select auth.uid()), reviewed_at = now(), review_note = p_note
   where id = p.id returning * into p;
  insert into public.proposal_reviews (proposal_id, space_id, reviewer, decision, note)
  values (p.id, p.space_id, (select auth.uid()), 'reject', p_note);
  -- flags go back to the pool; the rejection note is context for the next curator run
  update public.flags set status = 'open', proposal_id = null where proposal_id = p.id and status = 'in_proposal';
  perform private.audit(p.space_id, 'proposal.rejected', 'proposal', p.id, jsonb_build_object('note', p_note));
  return p;
end;
$$;

-- restore an old revision (content AND audience) as a normal proposal
create or replace function public.propose_revert(p_concept uuid, p_revision int) returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.concepts;
  r public.concept_revisions;
  v_prev text := coalesce(current_setting('kf.trusted_citation_audience', true), '');
  v_out public.proposals;
begin
  -- who first: agents and OAuth client tokens never create proposals (before anything is looked up)
  if (select auth.uid()) is null or private.is_agent() or private.is_oauth_client() then
    raise exception 'editor role required' using errcode = '42501';
  end if;
  select * into c from public.concepts where id = p_concept;
  if not found or private.space_rank(c.space_id) < 2 or not private.in_audience(c.audience) then
    raise exception 'editor role required' using errcode = '42501';
  end if;
  select * into r from public.concept_revisions where concept_id = p_concept and revision = p_revision;
  if not found then raise exception 'revision not found' using errcode = 'P0002'; end if;
  if not private.in_audience(r.audience) then
    raise exception 'editor role required' using errcode = '42501';
  end if;
  -- restoring the old audience too: reverting to content that was public into a now-restricted concept widens
  -- it (an escalation for a space admin); reverting to restricted content keeps it restricted. The revision's
  -- audience rides on a citation without a ref_id, which only this function may set for a person.
  perform set_config('kf.trusted_citation_audience', 'on', true);
  v_out := public.create_proposal(
    c.space_id,
    format('Revert %s to revision %s', c.path, p_revision),
    'Manual revert',
    'medium',
    jsonb_build_array(jsonb_build_object(
      'op', 'update', 'concept_id', c.id, 'path', c.path, 'base_revision', c.revision,
      'after', jsonb_build_object('kind', r.kind, 'type', r.type, 'title', r.title, 'description', r.description,
                                  'body', r.body, 'frontmatter', r.frontmatter, 'tags', to_jsonb(r.tags), 'status', r.status,
                                  'superseded_by', r.superseded_by, 'stale_after', r.stale_after,
                                  'audience', to_jsonb(r.audience)))),
    jsonb_build_array(jsonb_build_object('label', format('revision-%s', p_revision), 'ref_kind', 'concept',
                                         'audience', to_jsonb(r.audience)))
  );
  perform set_config('kf.trusted_citation_audience', v_prev, true);
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- groups: delete only when unused by live data; retire_group() replaces a group everywhere first
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
  -- Traces, closed flags and soft-deleted documents do not block: after the delete they are readable by
  -- nobody through that group (fail closed), which is the right outcome for history.
  select string_agg(x.what, ', ') into v_uses from (
    select 'concepts' as what where exists (select 1 from public.concepts c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.audience && g)
    union all select 'concept revisions' where exists (select 1 from public.concept_revisions c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.audience && g)
    union all select 'sources' where exists (select 1 from public.sources c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.audience && g)
    union all select 'source documents' where exists (select 1 from public.source_documents c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.deleted_at is null and c.audience && g)
    union all select 'open flags' where exists (select 1 from public.flags c join public.spaces s on s.id = c.space_id
                                             where s.workspace_id = old.workspace_id and c.status in ('open', 'in_proposal')
                                               and c.audience && g)
    union all select 'pending proposals' where exists (
        select 1 from public.proposals p join public.spaces s on s.id = p.space_id
        where s.workspace_id = old.workspace_id and p.status in ('pending', 'approved')
          and (exists (select 1 from public.proposal_ops o where o.proposal_id = p.id and o.target_audience && g)
               or exists (select 1 from public.proposal_citations ci where ci.proposal_id = p.id and ci.audience && g)))
  ) x;
  if v_uses is not null then
    raise exception 'group "%" is still used as an audience by %; change those audiences first or retire the group (retire_group)',
      old.slug, v_uses using errcode = '23503';
  end if;
  return old;
end;
$$;
revoke execute on function private.guard_group_delete() from public, anon, authenticated;

create or replace function private.replace_group(p_audience uuid[], p_old uuid, p_new uuid) returns uuid[]
language sql immutable set search_path = '' as $$
  select case when p_old = any (p_audience)
              then array(select distinct x from unnest(array_replace(p_audience, p_old, p_new)) x order by x)
              else p_audience end;
$$;
revoke execute on function private.replace_group(uuid[], uuid, uuid) from public, anon, authenticated;

-- Workspace admins (people, not OAuth tokens) retire a group: every audience in the workspace that names it
-- names p_replacement instead (never wider: the replacement is a group of the same workspace), open proposals
-- are recomputed, and the group is deleted (its members and grants with it).
create or replace function public.retire_group(p_group uuid, p_replacement uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.groups;
  v_ws uuid;
  v_prev text := coalesce(current_setting('kf.defer_recompute', true), '');
  v_prop uuid;
  ga uuid[];
begin
  select * into g from public.groups where id = p_group for update;
  if not private.is_service_role() and (
       g.id is null or (select auth.uid()) is null or private.is_agent() or private.is_oauth_client()
       or g.workspace_id not in (select private.my_workspaces('admin'))) then
    raise exception 'workspace admin required' using errcode = '42501';
  end if;
  if g.id is null then
    raise exception 'group not found' using errcode = 'P0002';
  end if;
  if p_replacement is null or p_replacement = p_group
     or not exists (select 1 from public.groups r where r.id = p_replacement and r.workspace_id = g.workspace_id) then
    raise exception 'the replacement must be another group of the same workspace' using errcode = '22023';
  end if;
  v_ws := g.workspace_id;
  ga := array[p_group];

  update public.sources t set audience = private.replace_group(t.audience, p_group, p_replacement)
    from public.spaces s where s.id = t.space_id and s.workspace_id = v_ws and t.audience && ga;
  update public.source_documents t set audience = private.replace_group(t.audience, p_group, p_replacement)
    from public.spaces s where s.id = t.space_id and s.workspace_id = v_ws and t.audience && ga;
  update public.concepts t set audience = private.replace_group(t.audience, p_group, p_replacement)
    from public.spaces s where s.id = t.space_id and s.workspace_id = v_ws and t.audience && ga;
  update public.concept_revisions t set audience = private.replace_group(t.audience, p_group, p_replacement)
    from public.spaces s where s.id = t.space_id and s.workspace_id = v_ws and t.audience && ga;
  update public.traces t set audience = private.replace_group(t.audience, p_group, p_replacement)
    from public.spaces s where s.id = t.space_id and s.workspace_id = v_ws and t.audience && ga;
  update public.flags t set audience = private.replace_group(t.audience, p_group, p_replacement)
    from public.spaces s where s.id = t.space_id and s.workspace_id = v_ws and t.audience && ga;

  perform set_config('kf.defer_recompute', 'on', true);
  -- ops derive target_audience from after.audience on write: keep both in step
  update public.proposal_ops t
     set target_audience = private.replace_group(t.target_audience, p_group, p_replacement),
         after = case when jsonb_typeof(t.after -> 'audience') = 'array'
                      then jsonb_set(t.after, '{audience}',
                                     to_jsonb(private.replace_group(array(select jsonb_array_elements_text(t.after -> 'audience')::uuid),
                                                                    p_group, p_replacement)))
                      else t.after end
    from public.spaces s where s.id = t.space_id and s.workspace_id = v_ws and t.target_audience && ga;
  update public.proposal_citations t set audience = private.replace_group(t.audience, p_group, p_replacement)
    from public.spaces s where s.id = t.space_id and s.workspace_id = v_ws and t.audience && ga;
  perform set_config('kf.defer_recompute', v_prev, true);

  for v_prop in select p.id from public.proposals p join public.spaces s on s.id = p.space_id
                 where s.workspace_id = v_ws and p.status in ('pending', 'approved') order by p.id loop
    perform private.recompute_proposal_access(v_prop);
  end loop;

  delete from public.groups where id = p_group;
  insert into public.audit_log (workspace_id, actor_user_id, actor, action, target_kind, target_id, data)
  values (v_ws, (select auth.uid()),
          case when (select auth.uid()) is null then 'system' else 'user:' || (select auth.uid())::text end,
          'group.retired', 'group', p_group, jsonb_build_object('slug', g.slug, 'replacement', p_replacement));
end;
$$;
revoke execute on function public.retire_group(uuid, uuid) from public, anon;
grant execute on function public.retire_group(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- workspace membership: one owner always remains (workspace row locked); agents leave only when deleted
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.keep_an_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    -- serialise owner removals/demotions per workspace (two owners leaving at once cannot both pass)
    perform 1 from public.workspaces w where w.id = old.workspace_id for no key update;
    if found
       and exists (select 1 from auth.users u where u.id = old.user_id)
       and not exists (select 1 from public.workspace_members wm
                        where wm.workspace_id = old.workspace_id and wm.role = 'owner' and wm.user_id <> old.user_id) then
      raise exception 'a workspace must keep at least one owner' using errcode = '42501';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function private.keep_an_owner() from public, anon, authenticated;

-- An agent's membership goes away with the agent (agents API delete -> Auth user deleted -> cascade) or with the
-- workspace. Deleting just the membership left an active agent that could never be re-added.
create or replace function private.guard_agent_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.agents a where a.id = old.user_id and a.workspace_id = old.workspace_id)
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id)
     and exists (select 1 from auth.users u where u.id = old.user_id) then
    raise exception 'an agent leaves its workspace only when the agent is deleted (agents API / kf agents delete)'
      using errcode = '42501';
  end if;
  return old;
end;
$$;
revoke execute on function private.guard_agent_membership() from public, anon, authenticated;
create or replace trigger workspace_members_guard_agent before delete on public.workspace_members
  for each row execute function private.guard_agent_membership();

-- ---------------------------------------------------------------------------------------------------------
-- agent passwords change only through key rotation
-- ---------------------------------------------------------------------------------------------------------
create table if not exists private.agent_password_changes (
  agent_id uuid primary key references auth.users (id) on delete cascade,
  allowed_until timestamptz not null
);
revoke all on private.agent_password_changes from public, anon, authenticated, service_role;

-- service role (the `agents` function), right before auth.admin.updateUserById(id, {password}): allows ONE
-- password change of that agent within the next 2 minutes
create or replace function public.kf_allow_agent_password_change(p_agent uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.agents a where a.id = p_agent) then
    raise exception 'agent not found' using errcode = 'P0002';
  end if;
  insert into private.agent_password_changes (agent_id, allowed_until) values (p_agent, now() + interval '2 minutes')
  on conflict (agent_id) do update set allowed_until = excluded.allowed_until;
end;
$$;
revoke execute on function public.kf_allow_agent_password_change(uuid) from public, anon, authenticated;
grant execute on function public.kf_allow_agent_password_change(uuid) to service_role;

create or replace function private.guard_agent_password() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(old.raw_app_meta_data ->> 'kind', '') = 'agent' or coalesce(new.raw_app_meta_data ->> 'kind', '') = 'agent'
     or exists (select 1 from public.agents a where a.id = new.id) then
    delete from private.agent_password_changes c where c.agent_id = new.id and c.allowed_until > now();
    if not found then
      raise exception 'an agent''s password is its key: rotate the key with the agents API instead' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.guard_agent_password() from public, anon, authenticated;
drop trigger if exists guard_agent_password on auth.users;
create trigger guard_agent_password
  before update of encrypted_password on auth.users
  for each row when (old.encrypted_password is distinct from new.encrypted_password)
  execute function private.guard_agent_password();

-- ---------------------------------------------------------------------------------------------------------
-- usage counts: only concepts the caller can see; the service role sees all
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.usage_counts(p_space uuid, p_since timestamptz)
returns table (concept_id uuid, n bigint)
language sql stable security definer set search_path = '' as $$
  select u.concept_id, count(*) from public.concept_usage u
  join public.concepts c on c.id = u.concept_id
  where u.space_id = p_space and u.at > p_since
    and ((select private.is_service_role())
         or ((select private.space_rank(p_space)) >= 1 and private.aud_ok(c.audience, (select private.my_group_ids()))))
  group by u.concept_id;
$$;
revoke execute on function private.usage_counts(uuid, timestamptz) from public, anon;
grant execute on function private.usage_counts(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- workspace invitations: owners own owner invitations; a rate limit that survives workspace deletion
-- ---------------------------------------------------------------------------------------------------------
create table if not exists private.rate_events (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null,
  at timestamptz not null default now()
);
create index if not exists rate_events_actor_idx on private.rate_events (actor, action, at desc);
revoke all on private.rate_events from public, anon, authenticated, service_role;

drop policy if exists "workspace_invitations: admins revoke" on public.workspace_invitations;
create policy "workspace_invitations: admins revoke" on public.workspace_invitations for delete to authenticated
  using (
    workspace_id in (select private.my_workspaces('admin')) and not (select private.is_oauth_client())
    and (role <> 'owner' or workspace_id in (select private.my_workspaces('owner')))
  );

create or replace function public.invite_to_workspace(p_workspace uuid, p_email text, p_role public.workspace_role default 'member')
returns public.workspace_invitations
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower(trim(coalesce(p_email, '')));
  v_inv public.workspace_invitations;
  v_owner boolean;
begin
  if v_uid is null or private.is_agent() or private.is_oauth_client()
     or not exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = p_workspace and wm.user_id = v_uid and wm.role in ('owner', 'admin')) then
    raise exception 'workspace admin required' using errcode = '42501';
  end if;
  v_owner := exists (select 1 from public.workspace_members wm
                      where wm.workspace_id = p_workspace and wm.user_id = v_uid and wm.role = 'owner');
  if coalesce(p_role, 'member') = 'owner' and not v_owner then
    raise exception 'only owners can invite owners' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 320 then
    raise exception 'invalid e-mail address' using errcode = '22023';
  end if;
  if v_email like '%@agents.supaknowledge.internal' then
    raise exception 'agents are created with the agents API, not invited' using errcode = '22023';
  end if;
  -- per person, across workspaces (deleting a workspace does not reset it)
  if (select count(*) from private.rate_events r
       where r.actor = v_uid and r.action = 'workspace_invitation' and r.at > now() - interval '1 hour') >= 30 then
    raise exception 'too many invitations, try again later' using errcode = 'PT429';
  end if;
  if exists (select 1 from public.workspace_members wm join auth.users u on u.id = wm.user_id
              where wm.workspace_id = p_workspace and lower(u.email) = v_email) then
    raise exception 'already a member of this workspace' using errcode = '23505';
  end if;

  select * into v_inv from public.workspace_invitations i
   where i.workspace_id = p_workspace and i.email = v_email and i.accepted_at is null and i.declined_at is null
   for update;
  if v_inv.id is not null and v_inv.role = 'owner' and not v_owner then
    raise exception 'only owners can change an owner invitation' using errcode = '42501';
  end if;
  if v_inv.id is not null then
    update public.workspace_invitations i
       set role = coalesce(p_role, 'member'), invited_by = v_uid, created_at = now(), expires_at = now() + interval '14 days'
     where i.id = v_inv.id
    returning * into v_inv;
  else
    insert into public.workspace_invitations (workspace_id, email, role, invited_by)
    values (p_workspace, v_email, coalesce(p_role, 'member'), v_uid)
    returning * into v_inv;
  end if;

  insert into private.rate_events (actor, action) values (v_uid, 'workspace_invitation');
  insert into public.audit_log (workspace_id, actor_user_id, actor, action, target_kind, target_id, data)
  values (p_workspace, v_uid, 'user:' || v_uid::text, 'workspace_invitation.created', 'invitation', v_inv.id,
          jsonb_build_object('email', v_email, 'role', v_inv.role));
  return v_inv;
end;
$$;
revoke execute on function public.invite_to_workspace(uuid, text, public.workspace_role) from public, anon;
grant execute on function public.invite_to_workspace(uuid, text, public.workspace_role) to authenticated;

create or replace function util.cleanup_invitations() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  delete from public.workspace_invitations
   where coalesce(accepted_at, declined_at, expires_at) < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from private.rate_events where at < now() - interval '1 day';
  return n;
end;
$$;
revoke execute on function util.cleanup_invitations() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Storage GC: never remove live objects
-- ---------------------------------------------------------------------------------------------------------
-- a revived (or re-uploaded) document takes its object back out of the GC queue
create or replace function private.on_document_live() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.kf_storage_gc g where g.bucket = 'sources' and g.prefix = new.storage_path;
  return null;
end;
$$;
revoke execute on function private.on_document_live() from public, anon, authenticated;
create or replace trigger source_documents_live after insert or update of deleted_at, storage_path on public.source_documents
  for each row when (new.deleted_at is null and new.storage_path is not null)
  execute function private.on_document_live();

create index if not exists kf_storage_gc_prefix_idx on public.kf_storage_gc (bucket, prefix);
create index if not exists concept_files_storage_path_idx on public.concept_files (storage_path);

create or replace function private.storage_object_live(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'sources' then exists (select 1 from public.source_documents d where d.storage_path = p_name and d.deleted_at is null)
    when 'concept-files' then exists (select 1 from public.concept_files f where f.storage_path = p_name)
    else false
  end;
$$;
revoke execute on function private.storage_object_live(text, text) from public, anon, authenticated;

-- Lists queued objects for the `maintenance` function, ordered by name (COLLATE "C", the Storage index order),
-- paginated with p_after. Objects still referenced by a live document or a concept file are never listed.
create or replace function public.kf_storage_gc_objects(p_bucket text, p_prefix text, p_after text default '', p_limit int default 500)
returns table (name text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 500), 1000));
  v_after text := coalesce(p_after, '');
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  if coalesce(p_prefix, '') = '' then
    raise exception 'p_prefix is required' using errcode = '22023';
  end if;
  if right(p_prefix, 1) = '/' then
    -- a folder: an index range scan on (bucket_id, name COLLATE "C")
    return query
      select o.name::text from storage.objects o
      where o.bucket_id = p_bucket
        and o.name collate "C" >= p_prefix collate "C"
        and o.name collate "C" < (p_prefix || chr(1114111)) collate "C"
        and o.name collate "C" > v_after collate "C"
        and starts_with(o.name, p_prefix)
        and not private.storage_object_live(p_bucket, o.name)
      order by o.name collate "C"
      limit v_limit;
  else
    return query
      select o.name::text from storage.objects o
      where o.bucket_id = p_bucket and o.name collate "C" = p_prefix collate "C"
        and o.name collate "C" > v_after collate "C"
        and not private.storage_object_live(p_bucket, o.name)
      order by o.name collate "C"
      limit v_limit;
  end if;
end;
$$;

revoke execute on function public.kf_storage_gc_objects(text, text, text, int) from public, anon, authenticated;
grant execute on function public.kf_storage_gc_objects(text, text, text, int) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- service-only RPCs check the caller themselves
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.kf_revoke_user_sessions(p_user uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'p_user is required' using errcode = '22023';
  end if;
  -- refresh tokens cascade from their session (auth.refresh_tokens.session_id ON DELETE CASCADE)
  delete from auth.sessions s where s.user_id = p_user;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.kf_revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.kf_revoke_user_sessions(uuid) to service_role;

create or replace function public.kf_strip_proposal_files(p_op uuid, p_files jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_after jsonb;
  v_status public.proposal_status;
  v_prev text := coalesce(current_setting('kf.defer_recompute', true), '');
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
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
  perform set_config('kf.defer_recompute', v_prev, true);
  return true;
end;
$$;
revoke execute on function public.kf_strip_proposal_files(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kf_strip_proposal_files(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- search: candidate CTEs start from the space
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.search_knowledge(
  p_space uuid,
  p_query text,
  p_embedding extensions.vector(384) default null,
  p_kinds public.concept_kind[] default null,
  p_limit int default 8,
  p_include_deprecated boolean default false
)
returns table (
  concept_id uuid, path text, kind public.concept_kind, type text, title text, description text,
  snippet text, trust public.trust_tier, stale boolean, status public.concept_status, revision int,
  score double precision
)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  -- filtered HNSW scans keep scanning until enough rows pass the space/RLS filters (pgvector >= 0.8).
  -- (set_config in a STABLE function is deliberate: a transaction-local planner setting, no data change.)
  perform set_config('hnsw.iterative_scan', 'strict_order', true);
  return query
  with params as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as q
  ), chunk_fts as (
    select ch.concept_id, ch.id as chunk_id,
           row_number() over (order by ts_rank_cd(ch.fts, p.q) desc) as rnk
    from public.concept_chunks ch
    join public.concepts c on c.id = ch.concept_id and c.space_id = p_space
    cross join params p
    where ch.space_id = p_space and ch.fts @@ p.q
      and (p_kinds is null or c.kind = any (p_kinds))
      and c.status <> 'draft' and (p_include_deprecated or c.status <> 'deprecated')
    order by ts_rank_cd(ch.fts, p.q) desc
    limit 50
  ), chunk_vec as (
    select ch.concept_id, ch.id as chunk_id,
           row_number() over (order by ch.embedding operator(extensions.<=>) p_embedding) as rnk
    from public.concept_chunks ch
    join public.concepts c on c.id = ch.concept_id and c.space_id = p_space
    where p_embedding is not null and ch.space_id = p_space and ch.embedding is not null
      and (p_kinds is null or c.kind = any (p_kinds))
      and c.status <> 'draft' and (p_include_deprecated or c.status <> 'deprecated')
    order by ch.embedding operator(extensions.<=>) p_embedding
    limit 50
  ), concept_fts as (  -- also finds concepts whose chunks are not embedded yet
    select c.id as concept_id, null::uuid as chunk_id,
           row_number() over (order by ts_rank_cd(c.fts, p.q) desc) as rnk
    from public.concepts c, params p
    where c.space_id = p_space and c.fts @@ p.q
      and (p_kinds is null or c.kind = any (p_kinds))
      and c.status <> 'draft' and (p_include_deprecated or c.status <> 'deprecated')
    order by ts_rank_cd(c.fts, p.q) desc
    limit 50
  ), fused as (
    select x.concept_id, x.chunk_id, 1.0 / (60 + x.rnk) as s, 'fts' as src from chunk_fts x
    union all select x.concept_id, x.chunk_id, 1.0 / (60 + x.rnk), 'vec' from chunk_vec x
    union all select x.concept_id, x.chunk_id, 1.0 / (60 + x.rnk), 'title' from concept_fts x
  ), scored as (
    select b.concept_id, sum(b.s) as score,
           (select f.chunk_id from fused f where f.concept_id = b.concept_id and f.chunk_id is not null
             order by f.s desc limit 1) as best_chunk
    from (select f.concept_id, f.src, max(f.s) as s from fused f group by f.concept_id, f.src) b
    group by b.concept_id
  )
  select c.id, c.path, c.kind, c.type, c.title, c.description,
         left(coalesce(ch.content, nullif(c.description, ''), left(c.body, 600)), 600),
         public.trust(c), public.is_stale(c), c.status, c.revision, sc.score::double precision
  from scored sc
  join public.concepts c on c.id = sc.concept_id and c.space_id = p_space
  left join public.concept_chunks ch on ch.id = sc.best_chunk
  order by sc.score desc
  limit greatest(1, least(coalesce(p_limit, 8), 50));
end;
$$;

create or replace function public.search_sources(
  p_space uuid,
  p_query text,
  p_embedding extensions.vector(384) default null,
  p_limit int default 10
)
returns table (
  document_id uuid, source_id uuid, title text, url text, snippet text, changed_at timestamptz, score double precision
)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  perform set_config('hnsw.iterative_scan', 'strict_order', true);
  return query
  with params as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as q
  ), f as (
    select ch.document_id, ch.id as chunk_id, row_number() over (order by ts_rank_cd(ch.fts, p.q) desc) as rnk
    from public.source_chunks ch
    join public.source_documents d on d.id = ch.document_id and d.space_id = p_space and d.deleted_at is null
    cross join params p
    where ch.space_id = p_space and ch.fts @@ p.q
    order by ts_rank_cd(ch.fts, p.q) desc limit 50
  ), v as (
    select ch.document_id, ch.id as chunk_id,
           row_number() over (order by ch.embedding operator(extensions.<=>) p_embedding) as rnk
    from public.source_chunks ch
    join public.source_documents d on d.id = ch.document_id and d.space_id = p_space and d.deleted_at is null
    where p_embedding is not null and ch.space_id = p_space and ch.embedding is not null
    order by ch.embedding operator(extensions.<=>) p_embedding limit 50
  ), fused as (
    select document_id, chunk_id, 1.0 / (60 + rnk) as s, 'fts' as src from f
    union all select document_id, chunk_id, 1.0 / (60 + rnk), 'vec' from v
  ), scored as (
    select b.document_id, sum(b.s) as score,
           (select y.chunk_id from fused y where y.document_id = b.document_id order by y.s desc limit 1) as best_chunk
    from (select x.document_id, x.src, max(x.s) as s from fused x group by x.document_id, x.src) b
    group by b.document_id
  )
  select d.id, d.source_id, d.title, d.url, left(ch.content, 600), d.changed_at, sc.score::double precision
  from scored sc
  join public.source_documents d on d.id = sc.document_id and d.space_id = p_space and d.deleted_at is null
  left join public.source_chunks ch on ch.id = sc.best_chunk
  order by sc.score desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- curator.stuck_after_minutes: at least 10 (the kf-curator queue visibility timeout is 400 s)
-- ---------------------------------------------------------------------------------------------------------
create or replace function util.reap_curator_runs() returns int
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
  v_status text;
begin
  for r in
    select cr.id, cr.created_at, cr.started_at,
           private.setting_int(s.settings, '{curator,stuck_after_minutes}', 30, 10, 1440) as stuck_after,
           (select max(greatest(t.created_at, t.finished_at)) from public.curator_tasks t where t.run_id = cr.id) as last_task
    from public.curator_runs cr join public.spaces s on s.id = cr.space_id
    where cr.status in ('queued', 'running')
    for update of cr skip locked
  loop
    if greatest(r.created_at, r.started_at, r.last_task) < now() - make_interval(mins => r.stuck_after) then
      update public.curator_tasks set status = 'failed', finished_at = now(),
             error = coalesce(error || '; ', '') || format('reaped: no progress for %s minutes', r.stuck_after)
       where run_id = r.id and status in ('queued', 'running');
    end if;
    v_status := private.finish_run_if_done(r.id);
    if v_status is distinct from 'running' then n := n + 1; end if;
  end loop;
  return n;
end;
$$;
revoke execute on function util.reap_curator_runs() from public, anon, authenticated;

-- the settings validator of 20261125000020 with the new lower bound. Keep in sync with packages/core
-- SpaceSettingsSchema (packages/core/test/settings-db.test.ts reads this list from the latest migration).
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
      ('{curator,stuck_after_minutes}', 'integer', 10, 1440),
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
