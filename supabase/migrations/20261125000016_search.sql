-- Supaknowledge: review fixes, part 6 — search.
--
--   * pgvector iterative HNSW scans (hnsw.iterative_scan = strict_order) per call: the global HNSW indexes no
--     longer return 0 hits when the top ef_search vectors belong to other spaces or audiences the caller cannot
--     read (post-filter starvation).
--   * Kind / status / deleted filters are applied inside each candidate list, BEFORE the per-list LIMIT, so 50
--     matching deprecated or other-kind chunks cannot starve the results.
--   * search_sources scores each document by its best chunk per signal (max per (document, signal)), like
--     search_knowledge, so long documents are no longer favoured just for having more chunks.
-- Signatures and result columns are unchanged. Still SECURITY INVOKER: RLS decides what the caller can find.
-- (plpgsql + set_config instead of a function-level SET clause: CREATE FUNCTION ... SET hnsw.* is refused for
-- non-superusers before the vector library is loaded.)

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
    join public.concepts c on c.id = ch.concept_id
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
    join public.concepts c on c.id = ch.concept_id
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
  join public.concepts c on c.id = sc.concept_id
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
  -- filtered HNSW scans keep scanning until enough rows pass the space/RLS filters (pgvector >= 0.8).
  -- (set_config in a STABLE function is deliberate: a transaction-local planner setting, no data change.)
  perform set_config('hnsw.iterative_scan', 'strict_order', true);
  return query
  with params as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as q
  ), f as (
    select ch.document_id, ch.id as chunk_id, row_number() over (order by ts_rank_cd(ch.fts, p.q) desc) as rnk
    from public.source_chunks ch
    join public.source_documents d on d.id = ch.document_id and d.deleted_at is null
    cross join params p
    where ch.space_id = p_space and ch.fts @@ p.q
    order by ts_rank_cd(ch.fts, p.q) desc limit 50
  ), v as (
    select ch.document_id, ch.id as chunk_id,
           row_number() over (order by ch.embedding operator(extensions.<=>) p_embedding) as rnk
    from public.source_chunks ch
    join public.source_documents d on d.id = ch.document_id and d.deleted_at is null
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
  join public.source_documents d on d.id = sc.document_id and d.deleted_at is null
  left join public.source_chunks ch on ch.id = sc.best_chunk
  order by sc.score desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
end;
$$;

revoke execute on function public.search_knowledge(uuid, text, extensions.vector, public.concept_kind[], int, boolean) from anon, public;
revoke execute on function public.search_sources(uuid, text, extensions.vector, int) from anon, public;
grant execute on function public.search_knowledge(uuid, text, extensions.vector, public.concept_kind[], int, boolean) to authenticated, service_role;
grant execute on function public.search_sources(uuid, text, extensions.vector, int) to authenticated, service_role;
