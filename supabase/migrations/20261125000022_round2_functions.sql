-- Supaknowledge: review fixes, round 2 (functions & curator side).
--
--   * flag_knowledge() normalizes p_concept_path like the curator does ("/finance/board-pack.md",
--     "./skills/x/SKILL.md" -> "finance/board-pack", "skills/x"), so a flag raised through REST/SDK fallbacks
--     attaches to the concept (and takes its audience) instead of becoming an unattached, public flag.
--   * search_knowledge() / search_sources() take two optional filters, applied in SQL before the LIMIT (no
--     starvation when the curator filters a service-role search by audience):
--       p_visible_to      only material every reader of this audience may read ('{}' = unrestricted only,
--                         '{g1,g2}' = unrestricted or audience containing g1 and g2); null = no filter
--       p_min_similarity  vector-only matches need at least this cosine similarity (keyword matches count)
--     Both only narrow results; RLS still applies to people.
--   * kf_rejected_proposals() (service role): rejected proposals on given paths with the audiences of
--     everything they touched (live and recorded), so the curator shows a rejection's review note only within
--     its research scope and taints the new proposal with them.
--   * Settings: length limits on curator.model / fast_model (200), curator.fallback_models (5 items of 200),
--     curator.instructions (8000).
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- flag_knowledge: normalized concept paths
-- ---------------------------------------------------------------------------------------------------------
-- mirrors normalizeConceptPath() in packages/core/src/curator/engine.ts
create or replace function private.normalize_concept_path(p_path text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(trim(p_path), '^(\./|/)+', ''),
            '/SKILL\.md$', '', 'i'),
          '\.md$', '', 'i'),
        '/SKILL$', '', 'i'),
      '/+$', ''),
    '');
$$;

create or replace function public.flag_knowledge(
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
  v_path text := private.normalize_concept_path(p_concept_path);
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

  if v_path is not null then
    select * into v_concept from public.concepts c where c.space_id = p_space and c.path = v_path;
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
    p_kind, v_concept.id, v_path, p_query, p_observation, p_suggested_fix, coalesce(p_evidence, '{}'),
    v_audience
  ) returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function public.flag_knowledge(uuid, public.flag_kind, text, text, text, text, uuid, jsonb) from public, anon;
grant execute on function public.flag_knowledge(uuid, public.flag_kind, text, text, text, text, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- search: audience scope and similarity floor in SQL
-- ---------------------------------------------------------------------------------------------------------
-- may every reader of p_visible_to read material restricted to p_audience? (null = no filter)
create or replace function private.visible_to(p_audience uuid[], p_visible_to uuid[]) returns boolean
language sql immutable parallel safe as $$
  select p_visible_to is null or p_audience = '{}'::uuid[]
         or (cardinality(p_visible_to) > 0 and p_audience @> p_visible_to);
$$;

drop function if exists public.search_knowledge(uuid, text, extensions.vector, public.concept_kind[], int, boolean);
create or replace function public.search_knowledge(
  p_space uuid,
  p_query text,
  p_embedding extensions.vector(384) default null,
  p_kinds public.concept_kind[] default null,
  p_limit int default 8,
  p_include_deprecated boolean default false,
  p_visible_to uuid[] default null,
  p_min_similarity double precision default null
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
      and private.visible_to(c.audience, p_visible_to)
    order by ts_rank_cd(ch.fts, p.q) desc
    limit 50
  ), chunk_vec as (
    select v.concept_id, v.chunk_id, row_number() over (order by v.dist) as rnk
    from (
      select ch.concept_id, ch.id as chunk_id, ch.embedding operator(extensions.<=>) p_embedding as dist
      from public.concept_chunks ch
      join public.concepts c on c.id = ch.concept_id and c.space_id = p_space
      where p_embedding is not null and ch.space_id = p_space and ch.embedding is not null
        and (p_kinds is null or c.kind = any (p_kinds))
        and c.status <> 'draft' and (p_include_deprecated or c.status <> 'deprecated')
        and private.visible_to(c.audience, p_visible_to)
      order by ch.embedding operator(extensions.<=>) p_embedding
      limit 50
    ) v
    where p_min_similarity is null or 1 - v.dist >= p_min_similarity
  ), concept_fts as (  -- also finds concepts whose chunks are not embedded yet
    select c.id as concept_id, null::uuid as chunk_id,
           row_number() over (order by ts_rank_cd(c.fts, p.q) desc) as rnk
    from public.concepts c, params p
    where c.space_id = p_space and c.fts @@ p.q
      and (p_kinds is null or c.kind = any (p_kinds))
      and c.status <> 'draft' and (p_include_deprecated or c.status <> 'deprecated')
      and private.visible_to(c.audience, p_visible_to)
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
revoke execute on function public.search_knowledge(uuid, text, extensions.vector, public.concept_kind[], int, boolean, uuid[], double precision) from public, anon;
grant execute on function public.search_knowledge(uuid, text, extensions.vector, public.concept_kind[], int, boolean, uuid[], double precision) to authenticated, service_role;

drop function if exists public.search_sources(uuid, text, extensions.vector, int);
create or replace function public.search_sources(
  p_space uuid,
  p_query text,
  p_embedding extensions.vector(384) default null,
  p_limit int default 10,
  p_visible_to uuid[] default null,
  p_min_similarity double precision default null
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
      and private.visible_to(d.audience, p_visible_to)
    order by ts_rank_cd(ch.fts, p.q) desc limit 50
  ), v as (
    select x.document_id, x.chunk_id, row_number() over (order by x.dist) as rnk
    from (
      select ch.document_id, ch.id as chunk_id, ch.embedding operator(extensions.<=>) p_embedding as dist
      from public.source_chunks ch
      join public.source_documents d on d.id = ch.document_id and d.space_id = p_space and d.deleted_at is null
      where p_embedding is not null and ch.space_id = p_space and ch.embedding is not null
        and private.visible_to(d.audience, p_visible_to)
      order by ch.embedding operator(extensions.<=>) p_embedding limit 50
    ) x
    where p_min_similarity is null or 1 - x.dist >= p_min_similarity
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
revoke execute on function public.search_sources(uuid, text, extensions.vector, int, uuid[], double precision) from public, anon;
grant execute on function public.search_sources(uuid, text, extensions.vector, int, uuid[], double precision) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- rejected proposals with the audiences of what they touched (curator feedback, service role)
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.kf_rejected_proposals(p_space uuid, p_paths text[], p_limit int default 5)
returns table (id uuid, title text, paths text[], review_note text, reviewed_at timestamptz, audiences jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  return query
  with hits as (
    select p.id, p.title, p.review_note, p.reviewed_at, array_agg(distinct o.path) as paths
    from public.proposals p
    join public.proposal_ops o on o.proposal_id = p.id
    where p.space_id = p_space and p.status = 'rejected'
      and (o.path = any (p_paths) or o.new_path = any (p_paths))
    group by p.id
    order by p.reviewed_at desc nulls last, p.id
    limit greatest(1, least(coalesce(p_limit, 5), 50))
  )
  select h.id, h.title, h.paths, h.review_note, h.reviewed_at,
         coalesce((
           select jsonb_agg(distinct to_jsonb(a.audience))
           from (
             -- every citation (cited or consulted): its recorded audience AND the live audience of its row
             select c.audience from public.proposal_citations c where c.proposal_id = h.id
             union all
             select case c.ref_kind
                      when 'source_document' then (select d.audience from public.source_documents d where d.id = c.ref_id)
                      when 'trace' then (select t.audience from public.traces t where t.id = c.ref_id)
                      when 'flag' then (select f.audience from public.flags f where f.id = c.ref_id)
                      when 'concept' then (select k.audience from public.concepts k where k.id = c.ref_id)
                    end
             from public.proposal_citations c where c.proposal_id = h.id and c.ref_id is not null
             union all
             -- the concepts it would have written: target audience and the concept's live audience
             select o.target_audience from public.proposal_ops o where o.proposal_id = h.id
             union all
             select k.audience from public.proposal_ops o join public.concepts k on k.id = o.concept_id
              where o.proposal_id = h.id
           ) a
           where a.audience is not null and cardinality(a.audience) > 0
         ), '[]'::jsonb)
  from hits h
  order by h.reviewed_at desc nulls last, h.id;
end;
$$;
revoke execute on function public.kf_rejected_proposals(uuid, text[], int) from public, anon, authenticated;
grant execute on function public.kf_rejected_proposals(uuid, text[], int) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- settings: length limits. Keep in sync with packages/core SpaceSettingsSchema (packages/core/test/
-- settings-db.test.ts reads this list from the latest migration). For 'string' the bounds are lengths, for
-- 'string[]' item counts (each item at most 200 characters).
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
      ('{curator,stuck_after_minutes}', 'integer', 10, 1440),
      ('{curator,model}', 'string', 0, 200),
      ('{curator,fast_model}', 'string', 0, 200),
      ('{curator,fallback_models}', 'string[]', 0, 5),
      ('{curator,max_research_steps}', 'integer', 1, 20),
      ('{curator,max_clusters_per_run}', 'integer', 1, 200),
      ('{curator,max_traces_per_run}', 'integer', 0, 5000),
      ('{curator,max_tokens_per_run}', 'integer', 0, 2000000000),
      ('{curator,research_scope}', 'enum:target_audience,all', null, null),
      ('{curator,auto_dismiss_flags}', 'boolean', null, null),
      ('{curator,instructions}', 'string', 0, 8000),
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
       or spec.typ = 'string' and (jsonb_typeof(v) <> 'string'
                                   or (spec.hi is not null and length(v #>> '{}') > spec.hi))
       or spec.typ = 'string[]' and (jsonb_typeof(v) <> 'array'
                                     or (spec.hi is not null and jsonb_array_length(v) > spec.hi)
                                     or exists (select 1 from jsonb_array_elements(v) e
                                                 where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 200))
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
          || case
               when spec.typ = 'string' and spec.hi is not null then format(' of at most %s characters', spec.hi)
               when spec.typ = 'string[]' and spec.hi is not null then format(' of at most %s items (each at most 200 characters)', spec.hi)
               when spec.lo is not null then format(' between %s and %s', spec.lo, spec.hi)
               else '' end
        using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function private.validate_space_settings() from public, anon, authenticated;
