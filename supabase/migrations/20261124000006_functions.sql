-- Supaknowledge: RPCs (exposed through PostgREST, used by the MCP server, CLI and Studio)

-- ---------------------------------------------------------------------------------------------------------
-- internal helpers
-- ---------------------------------------------------------------------------------------------------------
create function private.audit(p_space uuid, p_action text, p_target_kind text, p_target uuid, p_data jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (workspace_id, space_id, actor_user_id, actor, action, target_kind, target_id, data)
  select s.workspace_id, p_space, (select auth.uid()),
         case when (select auth.uid()) is null then 'system' else 'user:' || (select auth.uid())::text end,
         p_action, p_target_kind, p_target, p_data
  from public.spaces s where s.id = p_space;
$$;
revoke execute on function private.audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

create function private.space_settings(p_space uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(s.settings, '{}'::jsonb) from public.spaces s where s.id = p_space;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- search_knowledge: hybrid (full-text + vector) with reciprocal rank fusion.
-- SECURITY INVOKER: RLS on concepts/chunks decides what the caller can find.
-- The caller computes the query embedding (gte-small in the Edge Runtime).
-- ---------------------------------------------------------------------------------------------------------
create function public.search_knowledge(
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
language sql stable security invoker set search_path = '' as $$
  with params as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as q
  ), chunk_fts as (
    select ch.concept_id, ch.id as chunk_id,
           row_number() over (order by ts_rank_cd(ch.fts, p.q) desc) as rnk
    from public.concept_chunks ch, params p
    where ch.space_id = p_space and ch.fts @@ p.q
    order by ts_rank_cd(ch.fts, p.q) desc
    limit 50
  ), chunk_vec as (
    select ch.concept_id, ch.id as chunk_id,
           row_number() over (order by ch.embedding operator(extensions.<=>) p_embedding) as rnk
    from public.concept_chunks ch
    where p_embedding is not null and ch.space_id = p_space and ch.embedding is not null
    order by ch.embedding operator(extensions.<=>) p_embedding
    limit 50
  ), concept_fts as (  -- also finds concepts whose chunks are not embedded yet
    select c.id as concept_id, null::uuid as chunk_id,
           row_number() over (order by ts_rank_cd(c.fts, p.q) desc) as rnk
    from public.concepts c, params p
    where c.space_id = p_space and c.fts @@ p.q
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
  join public.concepts c on c.id = sc.concept_id
  left join public.concept_chunks ch on ch.id = sc.best_chunk
  where (p_kinds is null or c.kind = any (p_kinds))
    and c.status <> 'draft'
    and (p_include_deprecated or c.status <> 'deprecated')
  order by sc.score desc
  limit greatest(1, least(coalesce(p_limit, 8), 50));
$$;

-- same shape over raw evidence (editors+, used by the curator UI and reviewers)
create function public.search_sources(
  p_space uuid,
  p_query text,
  p_embedding extensions.vector(384) default null,
  p_limit int default 10
)
returns table (
  document_id uuid, source_id uuid, title text, url text, snippet text, changed_at timestamptz, score double precision
)
language sql stable security invoker set search_path = '' as $$
  with params as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as q
  ), f as (
    select ch.document_id, ch.id as chunk_id, row_number() over (order by ts_rank_cd(ch.fts, p.q) desc) as rnk
    from public.source_chunks ch, params p
    where ch.space_id = p_space and ch.fts @@ p.q
    order by ts_rank_cd(ch.fts, p.q) desc limit 50
  ), v as (
    select ch.document_id, ch.id as chunk_id, row_number() over (order by ch.embedding operator(extensions.<=>) p_embedding) as rnk
    from public.source_chunks ch
    where p_embedding is not null and ch.space_id = p_space and ch.embedding is not null
    order by ch.embedding operator(extensions.<=>) p_embedding limit 50
  ), fused as (
    select document_id, chunk_id, 1.0 / (60 + rnk) as s from f
    union all select document_id, chunk_id, 1.0 / (60 + rnk) from v
  ), scored as (
    select x.document_id, sum(x.s) as score,
           (select y.chunk_id from fused y where y.document_id = x.document_id order by y.s desc limit 1) as best_chunk
    from fused x group by x.document_id
  )
  select d.id, d.source_id, d.title, d.url, left(ch.content, 600), d.changed_at, sc.score::double precision
  from scored sc
  join public.source_documents d on d.id = sc.document_id and d.deleted_at is null
  left join public.source_chunks ch on ch.id = sc.best_chunk
  order by sc.score desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- usage logging (insert goes through RLS: only concepts you can see, only as yourself)
create policy "concept_usage: log own reads" on public.concept_usage for insert to authenticated
  with check (
    principal_id = (select auth.uid())
    and (concept_id, space_id) in (select c.id, c.space_id from public.concepts c)
    and (trace_id is null or trace_id in (select t.id from public.traces t where t.principal_id = (select auth.uid())))
  );

create function public.log_concept_usage(
  p_space uuid, p_concepts uuid[], p_via text default 'search', p_query text default null, p_trace uuid default null
) returns int
language plpgsql volatile security invoker set search_path = '' as $$
declare
  n int;
begin
  insert into public.concept_usage (space_id, concept_id, revision, principal_id, trace_id, via, query)
  select c.space_id, c.id, c.revision, (select auth.uid()), p_trace, p_via, p_query
  from public.concepts c where c.id = any (p_concepts) and c.space_id = p_space;
  get diagnostics n = row_count;
  if (select auth.uid()) is not null then
    update public.agents set last_seen_at = now() where id = (select auth.uid());
  end if;
  return n;
end;
$$;

-- full concept for agents: body, frontmatter, links, files, trust
create function public.read_concept(p_space uuid, p_path text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'path', c.path, 'kind', c.kind, 'type', c.type, 'title', c.title,
    'description', c.description, 'body', c.body, 'frontmatter', c.frontmatter, 'tags', c.tags,
    'status', c.status, 'superseded_by', c.superseded_by, 'stale_after', c.stale_after,
    'stale', public.is_stale(c), 'trust', public.trust(c), 'revision', c.revision,
    'generated_by', c.generated_by, 'generated_at', c.generated_at, 'audience', c.audience,
    'links', coalesce((select jsonb_agg(jsonb_build_object('path', l.to_path, 'anchor', l.anchor, 'exists', l.to_concept is not null))
                       from public.concept_links l where l.from_concept = c.id), '[]'::jsonb),
    'backlinks', coalesce((select jsonb_agg(jsonb_build_object('path', src.path, 'title', src.title))
                           from public.concept_links l join public.concepts src on src.id = l.from_concept
                           where l.to_concept = c.id), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(jsonb_build_object('path', f.path, 'storage_path', f.storage_path, 'content_type', f.content_type, 'size_bytes', f.size_bytes))
                       from public.concept_files f where f.concept_id = c.id), '[]'::jsonb)
  )
  from public.concepts c
  where c.space_id = p_space and c.path = p_path;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- flag_knowledge: the "issue reporting tool" from the knowledge-factory post.
-- Any space reader (agents included) can flag. The flag inherits the concept's audience so it never leaks
-- restricted content to reviewers who could not read the concept.
-- ---------------------------------------------------------------------------------------------------------
create function public.flag_knowledge(
  p_space uuid,
  p_kind public.flag_kind,
  p_observation text,
  p_concept_path text default null,
  p_query text default null,
  p_suggested_fix text default null,
  p_trace uuid default null,
  p_evidence jsonb default '{}'
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_concept public.concepts;
  v_id uuid;
  v_audience uuid[] := '{}';
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if private.space_rank(p_space) < 1 then
    raise exception 'no access to space' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_observation)), 0) = 0 then
    raise exception 'observation is required' using errcode = '22023';
  end if;

  if p_concept_path is not null then
    select * into v_concept from public.concepts c where c.space_id = p_space and c.path = p_concept_path;
    -- a concept the caller cannot see is treated as missing (do not confirm its existence)
    if found and private.in_audience(v_concept.audience) then
      v_audience := v_concept.audience;
    else
      v_concept := null;
    end if;
  end if;

  insert into public.flags (space_id, created_by, trace_id, kind, concept_id, concept_path, query, observation,
                            suggested_fix, evidence, audience)
  values (
    p_space, (select auth.uid()),
    (select t.id from public.traces t where t.id = p_trace and t.principal_id = (select auth.uid())),
    p_kind, v_concept.id, p_concept_path, p_query, p_observation, p_suggested_fix, coalesce(p_evidence, '{}'),
    v_audience
  ) returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- proposals: escalation + risk are computed by triggers, never trusted from the client
-- ---------------------------------------------------------------------------------------------------------
create function private.recompute_proposal_access(p_proposal uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_escalation boolean;
begin
  select
    -- cited evidence would reach a wider audience than it has today
    exists (
      select 1 from public.proposal_citations c
      join public.proposal_ops o on o.proposal_id = c.proposal_id and (c.op_id is null or c.op_id = o.id)
      where c.proposal_id = p_proposal and private.is_escalation(c.audience, o.target_audience)
    )
    -- an existing concept would be widened (e.g. finance-only -> everyone)
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

create function private.on_proposal_child_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.recompute_proposal_access(coalesce(new.proposal_id, old.proposal_id));
  return null;
end;
$$;

create trigger proposal_ops_access after insert or update or delete on public.proposal_ops
  for each row execute function private.on_proposal_child_change();
create trigger proposal_citations_access after insert or update or delete on public.proposal_citations
  for each row execute function private.on_proposal_child_change();

-- fill space_id / target_audience defaults on ops
create function private.proposal_op_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_concept public.concepts;
begin
  select p.space_id into new.space_id from public.proposals p where p.id = new.proposal_id;
  if new.concept_id is null and new.op <> 'create' then
    select c.id into new.concept_id from public.concepts c where c.space_id = new.space_id and c.path = new.path;
  end if;
  if tg_op = 'INSERT' and new.op = 'create' then
    new.concept_id := null;
  elsif tg_op = 'INSERT' and not exists (
      select 1 from public.concepts c
      where c.id = new.concept_id and c.space_id = new.space_id
        and (private.is_service_role() or private.in_audience(c.audience))) then
    -- same error whether the concept is missing, foreign or restricted: do not confirm it exists
    raise exception 'concept % not found', new.path using errcode = '42501';
  end if;
  if new.after ? 'audience' then
    new.target_audience := array(select jsonb_array_elements_text(new.after -> 'audience')::uuid);
  elsif new.concept_id is not null and tg_op = 'INSERT' then
    select * into v_concept from public.concepts c where c.id = new.concept_id;
    new.target_audience := coalesce(v_concept.audience, new.target_audience);
  end if;
  return new;
end;
$$;
create trigger proposal_ops_defaults before insert or update on public.proposal_ops
  for each row execute function private.proposal_op_defaults();

create function private.proposal_child_space() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select p.space_id into new.space_id from public.proposals p where p.id = new.proposal_id;
  return new;
end;
$$;

-- the audience of cited evidence is read from the evidence itself, never trusted from the client
create function private.proposal_citation_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_aud uuid[];
begin
  select p.space_id into new.space_id from public.proposals p where p.id = new.proposal_id;
  if new.ref_id is not null then
    v_aud := case new.ref_kind
      when 'source_document' then (select d.audience from public.source_documents d where d.id = new.ref_id and d.space_id = new.space_id)
      when 'trace' then (select t.audience from public.traces t where t.id = new.ref_id and t.space_id = new.space_id)
      when 'flag' then (select f.audience from public.flags f where f.id = new.ref_id and f.space_id = new.space_id)
      when 'concept' then (select c.audience from public.concepts c where c.id = new.ref_id and c.space_id = new.space_id)
    end;
    if v_aud is null and new.ref_kind <> 'url' then
      raise exception 'cited % not found', new.ref_kind using errcode = '42501';
    end if;
  end if;
  new.audience := coalesce(v_aud, new.audience);
  return new;
end;
$$;
create trigger proposal_citations_space before insert on public.proposal_citations
  for each row execute function private.proposal_citation_defaults();
create trigger proposal_reviews_space before insert on public.proposal_reviews
  for each row execute function private.proposal_child_space();

-- ---------------------------------------------------------------------------------------------------------
-- apply_proposal: the ONLY write path into concepts.
--   humans: reviewer+ who can see all evidence; escalations need a space admin
--   service role (curator / policy auto-apply): never for escalations
-- ---------------------------------------------------------------------------------------------------------
create function public.apply_proposal(p_proposal uuid, p_note text default null, p_actor text default null)
returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
  o public.proposal_ops;
  c public.concepts;
  v_human boolean := not private.is_service_role();
  v_actor text;
  v_uid uuid := (select auth.uid());
  v_conflicts jsonb := '[]';
  a jsonb;
begin
  select * into p from public.proposals where id = p_proposal for update;
  if not found then
    raise exception 'proposal not found' using errcode = 'P0002';
  end if;
  if p.status not in ('pending', 'approved') then
    raise exception 'proposal is %', p.status using errcode = '22023';
  end if;
  -- concept audiences may have changed since the proposal was drafted
  perform private.recompute_proposal_access(p.id);
  select * into p from public.proposals where id = p.id;

  if v_human then
    if v_uid is null then
      raise exception 'not authenticated' using errcode = '28000';
    end if;
    if private.space_rank(p.space_id) < 3 then
      raise exception 'reviewer role required' using errcode = '42501';
    end if;
    if not private.can_see_proposal(p.id) then
      raise exception 'you cannot see all evidence cited by this proposal' using errcode = '42501';
    end if;
    if p.escalation and private.space_rank(p.space_id) < 4 then
      raise exception 'this proposal widens access to restricted knowledge; a space admin must approve it' using errcode = '42501';
    end if;
    v_actor := 'human:' || v_uid::text;
  else
    if p.escalation then
      raise exception 'escalations always require human approval' using errcode = '42501';
    end if;
    v_actor := coalesce(p_actor, 'process:policy');
  end if;

  -- 1. validate every op first so a conflict leaves nothing half-applied
  for o in select * from public.proposal_ops where proposal_id = p.id order by ord loop
    if o.op = 'create' then
      if exists (select 1 from public.concepts k where k.space_id = p.space_id and k.path = o.path) then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'path already exists');
      end if;
    else
      select * into c from public.concepts k where k.id = o.concept_id and k.space_id = p.space_id;
      if not found then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'concept not found');
      elsif o.base_revision is not null and c.revision <> o.base_revision then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason',
          format('concept changed since draft (base %s, now %s)', o.base_revision, c.revision));
      elsif o.op = 'move' and (o.new_path is null or exists (select 1 from public.concepts k where k.space_id = p.space_id and k.path = o.new_path)) then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'invalid move target');
      end if;
    end if;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    update public.proposals set status = 'conflicted', review_note = v_conflicts::text where id = p.id returning * into p;
    perform private.audit(p.space_id, 'proposal.conflicted', 'proposal', p.id, jsonb_build_object('conflicts', v_conflicts));
    return p;
  end if;

  -- 2. apply
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
        coalesce(a -> 'frontmatter', '{}'),
        coalesce(array(select jsonb_array_elements_text(a -> 'tags')), '{}'),
        coalesce((a ->> 'status')::public.concept_status, 'stable'),
        a ->> 'superseded_by',
        (a ->> 'stale_after')::timestamptz,
        o.target_audience, 1, v_actor, now()
      ) returning * into c;
    elsif o.op = 'update' then
      update public.concepts k set
        kind = coalesce((a ->> 'kind')::public.concept_kind, k.kind),
        type = coalesce(a ->> 'type', k.type),
        title = coalesce(a ->> 'title', k.title),
        description = coalesce(a ->> 'description', k.description),
        body = coalesce(a ->> 'body', k.body),
        frontmatter = coalesce(a -> 'frontmatter', k.frontmatter),
        tags = case when a ? 'tags' then array(select jsonb_array_elements_text(a -> 'tags')) else k.tags end,
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
      update public.concept_links l set to_concept = c.id where l.space_id = p.space_id and l.to_path = o.new_path;
    end if;

    insert into public.concept_revisions (concept_id, space_id, revision, path, kind, type, title, description, body,
      frontmatter, tags, status, superseded_by, stale_after, audience, actor, actor_user_id, reason, proposal_id)
    values (c.id, c.space_id, c.revision, c.path, c.kind, c.type, c.title, c.description, c.body, c.frontmatter,
      c.tags, c.status, c.superseded_by, c.stale_after, c.audience, v_actor, case when v_human then v_uid end,
      coalesce(o.rationale, p.title), p.id);

    if v_human then
      insert into public.verifications (concept_id, space_id, revision, actor, actor_user_id, note)
      values (c.id, c.space_id, c.revision, v_actor, v_uid, p_note);
    end if;

    update public.proposal_ops set concept_id = c.id where id = o.id and concept_id is null;
  end loop;

  update public.proposals set
    status = 'applied', applied_at = now(), auto_applied = not v_human,
    reviewed_by = case when v_human then v_uid else reviewed_by end,
    reviewed_at = case when v_human then now() else reviewed_at end,
    review_note = coalesce(p_note, review_note)
  where id = p.id returning * into p;

  if v_human then
    insert into public.proposal_reviews (proposal_id, space_id, reviewer, decision, note)
    values (p.id, p.space_id, v_uid, 'approve', p_note);
  end if;

  update public.flags set status = 'resolved', resolved_at = now(), resolved_by = v_uid,
         resolution = coalesce(resolution, 'applied in proposal ' || p.id::text)
   where proposal_id = p.id and status in ('open', 'in_proposal');

  perform private.audit(p.space_id, case when v_human then 'proposal.applied' else 'proposal.auto_applied' end,
                        'proposal', p.id, jsonb_build_object('actor', v_actor));
  return p;
end;
$$;

create function public.reject_proposal(p_proposal uuid, p_note text) returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
begin
  select * into p from public.proposals where id = p_proposal for update;
  if not found then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if p.status not in ('pending', 'approved', 'conflicted') then
    raise exception 'proposal is %', p.status using errcode = '22023';
  end if;
  if not private.is_service_role() then
    if private.space_rank(p.space_id) < 3 or not private.can_see_proposal(p.id) then
      raise exception 'reviewer role required' using errcode = '42501';
    end if;
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

create function public.dismiss_flag(p_flag uuid, p_reason text) returns public.flags
language plpgsql volatile security invoker set search_path = '' as $$
declare
  f public.flags;
begin
  update public.flags set status = 'dismissed', resolution = p_reason, resolved_by = (select auth.uid()), resolved_at = now()
   where id = p_flag returning * into f;   -- RLS: reviewers in audience only
  if not found then raise exception 'flag not found or not permitted' using errcode = '42501'; end if;
  return f;
end;
$$;

-- a human vouches for the current revision (OKF `verified`)
create function public.verify_concept(p_concept uuid, p_note text default null) returns public.verifications
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.concepts;
  v public.verifications;
begin
  select * into c from public.concepts where id = p_concept;
  if not found or private.space_rank(c.space_id) < 3 or not private.in_audience(c.audience) then
    raise exception 'reviewer role required' using errcode = '42501';
  end if;
  insert into public.verifications (concept_id, space_id, revision, actor, actor_user_id, note)
  values (c.id, c.space_id, c.revision, 'human:' || (select auth.uid())::text, (select auth.uid()), p_note)
  returning * into v;
  return v;
end;
$$;

-- restore an old revision = a new proposal (keeps the single write path)
create function public.propose_revert(p_concept uuid, p_revision int) returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.concepts;
  r public.concept_revisions;
  p public.proposals;
begin
  select * into c from public.concepts where id = p_concept;
  if not found or private.space_rank(c.space_id) < 2 or not private.in_audience(c.audience) then
    raise exception 'editor role required' using errcode = '42501';
  end if;
  select * into r from public.concept_revisions where concept_id = p_concept and revision = p_revision;
  if not found then raise exception 'revision not found' using errcode = 'P0002'; end if;
  if not private.in_audience(r.audience) then
    raise exception 'editor role required' using errcode = '42501';
  end if;
  insert into public.proposals (space_id, author, created_by, title, rationale, risk)
  values (c.space_id, 'human:' || (select auth.uid())::text, (select auth.uid()),
          format('Revert %s to revision %s', c.path, p_revision), 'Manual revert', 'medium')
  returning * into p;
  insert into public.proposal_ops (proposal_id, space_id, ord, op, concept_id, path, base_revision, after, target_audience)
  values (p.id, c.space_id, 0, 'update', c.id, c.path, c.revision,
          jsonb_build_object('kind', r.kind, 'type', r.type, 'title', r.title, 'description', r.description, 'body', r.body,
                             'frontmatter', r.frontmatter, 'tags', to_jsonb(r.tags), 'status', r.status,
                             'superseded_by', r.superseded_by, 'stale_after', r.stale_after),
          r.audience);
  -- the old content carries the old audience: restoring it into a wider concept is an escalation
  insert into public.proposal_citations (proposal_id, space_id, label, ref_kind, audience)
  values (p.id, c.space_id, format('revision-%s', p_revision), 'concept', r.audience);
  select * into p from public.proposals where id = p.id;
  return p;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- connector secrets in Vault
-- ---------------------------------------------------------------------------------------------------------
create function public.set_source_secret(p_source uuid, p_secret text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.sources;
begin
  select * into s from public.sources where id = p_source;
  if not found or private.space_rank(s.space_id) < 4 or not private.in_audience(s.audience) then
    raise exception 'space admin required' using errcode = '42501';
  end if;
  if s.secret_id is null
     or not exists (select 1 from vault.secrets vs where vs.id = s.secret_id and vs.name = 'kf_source_' || p_source::text) then
    update public.sources set secret_id = vault.create_secret(p_secret, 'kf_source_' || p_source::text, 'Supaknowledge connector token')
     where id = p_source;
  else
    perform vault.update_secret(s.secret_id, p_secret);
  end if;
  perform private.audit(s.space_id, 'source.secret_set', 'source', p_source);
end;
$$;

create function util.get_source_secret(p_source uuid) returns text
language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret from public.sources s join vault.decrypted_secrets ds on ds.id = s.secret_id
   where s.id = p_source and ds.name = 'kf_source_' || s.id::text;
$$;
revoke execute on function util.get_source_secret(uuid) from public, anon, authenticated;
grant execute on function util.get_source_secret(uuid) to service_role;

-- PostgREST cannot see the util schema, so expose a service-role-only wrapper in public.
create function public.kf_get_source_secret(p_source uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  return util.get_source_secret(p_source);
end;
$$;
revoke execute on function public.kf_get_source_secret(uuid) from public, anon, authenticated;
grant execute on function public.kf_get_source_secret(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- knowledge health (Studio dashboard). Counts only what the caller can see.
-- ---------------------------------------------------------------------------------------------------------
create function public.knowledge_health(p_space uuid, p_days int default 30) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with c as (select * from public.concepts where space_id = p_space and status <> 'deprecated'),
  usage as (select u.concept_id, count(*) as n from public.concept_usage u
            where u.space_id = p_space and u.at > now() - make_interval(days => p_days) group by u.concept_id),
  fl as (select f.concept_id, count(*) as n from public.flags f
         where f.space_id = p_space and f.created_at > now() - make_interval(days => p_days) group by f.concept_id)
  select jsonb_build_object(
    'concepts', (select count(*) from c),
    'by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}') from (select kind, count(*) n from c group by kind) k),
    'by_trust', (select coalesce(jsonb_object_agg(t, n), '{}') from (
        select public.trust(k) t, count(*) n from public.concepts k
        where k.space_id = p_space and k.status <> 'deprecated' group by 1) x),
    'stale', (select count(*) from c where c.stale_after < now()),
    'open_flags', (select count(*) from public.flags f where f.space_id = p_space and f.status = 'open'),
    'missing_flags', (select count(*) from public.flags f where f.space_id = p_space and f.status = 'open' and f.kind = 'missing'),
    'pending_proposals', (select count(*) from public.proposals p where p.space_id = p_space and p.status = 'pending'),
    'applied_proposals', (select count(*) from public.proposals p where p.space_id = p_space and p.status = 'applied'
                           and p.applied_at > now() - make_interval(days => p_days)),
    'auto_applied', (select count(*) from public.proposals p where p.space_id = p_space and p.auto_applied
                      and p.applied_at > now() - make_interval(days => p_days)),
    'never_used', (select count(*) from c where c.id not in (select concept_id from usage)),
    'most_flagged', (select coalesce(jsonb_agg(x order by x.flags desc), '[]') from (
        select c.path, c.title, fl.n as flags, coalesce(usage.n, 0) as uses,
               round(fl.n::numeric / greatest(coalesce(usage.n, 0), 1), 3) as flag_rate
        from fl join c on c.id = fl.concept_id left join usage on usage.concept_id = c.id
        order by fl.n desc limit 10) x),
    'last_run', (select to_jsonb(r) from (select id, status, trigger, stats, finished_at from public.curator_runs
                  where space_id = p_space order by created_at desc limit 1) r)
  );
$$;

-- ---------------------------------------------------------------------------------------------------------
-- grants: nothing here is for anon
-- ---------------------------------------------------------------------------------------------------------
revoke execute on function public.search_knowledge(uuid, text, extensions.vector, public.concept_kind[], int, boolean) from anon, public;
revoke execute on function public.search_sources(uuid, text, extensions.vector, int) from anon, public;
revoke execute on function public.log_concept_usage(uuid, uuid[], text, text, uuid) from anon, public;
revoke execute on function public.read_concept(uuid, text) from anon, public;
revoke execute on function public.flag_knowledge(uuid, public.flag_kind, text, text, text, text, uuid, jsonb) from anon, public;
revoke execute on function public.apply_proposal(uuid, text, text) from anon, public;
revoke execute on function public.reject_proposal(uuid, text) from anon, public;
revoke execute on function public.dismiss_flag(uuid, text) from anon, public;
revoke execute on function public.verify_concept(uuid, text) from anon, public;
revoke execute on function public.propose_revert(uuid, int) from anon, public;
revoke execute on function public.set_source_secret(uuid, text) from anon, public;
revoke execute on function public.knowledge_health(uuid, int) from anon, public;
revoke execute on function public.trust(public.concepts) from anon, public;
revoke execute on function public.is_stale(public.concepts) from anon, public;
grant execute on function public.search_knowledge(uuid, text, extensions.vector, public.concept_kind[], int, boolean) to authenticated, service_role;
grant execute on function public.search_sources(uuid, text, extensions.vector, int) to authenticated, service_role;
grant execute on function public.log_concept_usage(uuid, uuid[], text, text, uuid) to authenticated, service_role;
grant execute on function public.read_concept(uuid, text) to authenticated, service_role;
grant execute on function public.flag_knowledge(uuid, public.flag_kind, text, text, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function public.apply_proposal(uuid, text, text) to authenticated, service_role;
grant execute on function public.reject_proposal(uuid, text) to authenticated, service_role;
grant execute on function public.dismiss_flag(uuid, text) to authenticated, service_role;
grant execute on function public.verify_concept(uuid, text) to authenticated, service_role;
grant execute on function public.propose_revert(uuid, int) to authenticated, service_role;
grant execute on function public.set_source_secret(uuid, text) to authenticated, service_role;
grant execute on function public.knowledge_health(uuid, int) to authenticated, service_role;
grant execute on function public.trust(public.concepts) to authenticated, service_role;
grant execute on function public.is_stale(public.concepts) to authenticated, service_role;
