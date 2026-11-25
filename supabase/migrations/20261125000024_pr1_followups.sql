-- Follow-ups from the bot reviews of PR #1.
--
-- 1. search_sources gains p_source: Studio's per-source document search filtered client-side after the
--    space-wide LIMIT, so matching documents of that source could be missing. The filter now applies inside
--    both candidate sets, before any limit.
-- 2. concepts.path rejects empty and "." segments ("a//b", "a/./b", "./a", trailing "/"): the Studio route
--    drops empty segments and URL resolution collapses ".", so such a path could not be opened reliably.

drop function if exists public.search_sources(uuid, text, extensions.vector, int, uuid[], double precision);
create or replace function public.search_sources(
  p_space uuid,
  p_query text,
  p_embedding extensions.vector(384) default null,
  p_limit int default 10,
  p_visible_to uuid[] default null,
  p_min_similarity double precision default null,
  p_source uuid default null
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
      and (p_source is null or d.source_id = p_source)
    order by ts_rank_cd(ch.fts, p.q) desc limit 50
  ), v as (
    select x.document_id, x.chunk_id, row_number() over (order by x.dist) as rnk
    from (
      select ch.document_id, ch.id as chunk_id, ch.embedding operator(extensions.<=>) p_embedding as dist
      from public.source_chunks ch
      join public.source_documents d on d.id = ch.document_id and d.space_id = p_space and d.deleted_at is null
      where p_embedding is not null and ch.space_id = p_space and ch.embedding is not null
        and private.visible_to(d.audience, p_visible_to)
        and (p_source is null or d.source_id = p_source)
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
revoke execute on function public.search_sources(uuid, text, extensions.vector, int, uuid[], double precision, uuid) from public, anon;
grant execute on function public.search_sources(uuid, text, extensions.vector, int, uuid[], double precision, uuid) to authenticated, service_role;

alter table public.concepts drop constraint concepts_path_check;
alter table public.concepts add constraint concepts_path_check check (
  path ~ '^[A-Za-z0-9_][A-Za-z0-9_./-]*$'
  and path !~ '\.\.'
  and path !~ '\.md$'
  and path !~ '(^|/)\.?(/|$)'
);
