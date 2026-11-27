-- Supaknowledge: knowledge graph and monthly recap (Studio)
--
--   knowledge_graph(p_space, p_limit)               concepts, links between them, open flags per concept, and
--                                                   the evidence applied proposals cited for each concept
--   knowledge_recap(p_month, p_space, p_workspace)  one calendar month (UTC) of a space or a workspace in numbers
--
-- Both are SECURITY INVOKER and read every table through the caller's RLS: concepts outside the caller's groups,
-- flags they may not read, proposals they cannot fully see and evidence outside their audience are neither drawn
-- nor counted. Readers therefore get a graph without citations (proposals are editor-only) and a recap built from
-- concept revisions and their own flags.

-- ---------------------------------------------------------------------------------------------------------
-- knowledge_graph
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.knowledge_graph(p_space uuid, p_limit int default 1000) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with lim as (select greatest(1, least(coalesce(p_limit, 1000), 2000)) as n),
  c_all as (
    select k.id, k.path, k.title, k.kind, k.status, k.stale_after, k.updated_at, public.trust(k) as trust
    from public.concepts k
    where k.space_id = p_space and k.status <> 'deprecated'
  ),
  c as (select * from c_all order by path limit (select n from lim)),
  fl as (
    select f.concept_id, count(*)::int as n
    from public.flags f
    where f.space_id = p_space and f.status = 'open' and f.concept_id in (select id from c)
    group by f.concept_id
  ),
  ln as (
    select distinct l.from_concept, l.to_concept
    from public.concept_links l
    where l.space_id = p_space and l.to_concept is not null and l.from_concept <> l.to_concept
      and l.from_concept in (select id from c) and l.to_concept in (select id from c)
  ),
  -- a citation belongs to its op's concept; a proposal-level citation (no op) to every concept the proposal wrote
  cit as (
    select distinct coalesce(o.concept_id, o2.concept_id) as concept_id, pc.ref_kind, pc.ref_id
    from public.proposal_citations pc
    join public.proposals p on p.id = pc.proposal_id
    left join public.proposal_ops o on o.id = pc.op_id
    left join public.proposal_ops o2 on pc.op_id is null and o2.proposal_id = pc.proposal_id
    where p.space_id = p_space and p.status = 'applied'
      and pc.ref_kind in ('source_document', 'trace', 'flag', 'concept') and pc.ref_id is not null
  ),
  cit_c as (select * from cit where concept_id in (select id from c)),
  -- evidence rows are read through their own RLS: a citation to a row the caller cannot read is dropped
  ev as (
    select d.id, 'source_document'::text as kind, coalesce(nullif(d.title, ''), d.external_id) as label, null::uuid as proposal_id
    from public.source_documents d
    where d.space_id = p_space and d.id in (select ref_id from cit_c where ref_kind = 'source_document')
    union all
    select t.id, 'trace', coalesce(nullif(t.name, ''), 'Untitled trace'), null
    from public.traces t
    where t.space_id = p_space and t.id in (select ref_id from cit_c where ref_kind = 'trace')
    union all
    select f.id, 'flag', f.kind::text || ': ' || left(f.observation, 120),
           (select p.id from public.proposals p where p.id = f.proposal_id)
    from public.flags f
    where f.space_id = p_space and f.id in (select ref_id from cit_c where ref_kind = 'flag')
  ),
  edges as (
    select x.concept_id, x.ref_kind::text as ref_kind, x.ref_id
    from cit_c x
    where (x.ref_kind = 'concept' and x.ref_id <> x.concept_id and x.ref_id in (select id from c))
       or (x.ref_kind <> 'concept' and x.ref_id in (select id from ev))
  )
  select jsonb_build_object(
    'concepts', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'path', c.path, 'title', c.title, 'kind', c.kind, 'status', c.status, 'trust', c.trust,
        'stale', c.stale_after is not null and c.stale_after < now(), 'stale_after', c.stale_after,
        'open_flags', coalesce(fl.n, 0), 'updated_at', c.updated_at) order by c.path), '[]'::jsonb)
      from c left join fl on fl.concept_id = c.id),
    'truncated', (select count(*) from c_all) > (select count(*) from c),
    'links', (select coalesce(jsonb_agg(jsonb_build_object('from', ln.from_concept, 'to', ln.to_concept)), '[]'::jsonb) from ln),
    'evidence', (select coalesce(jsonb_agg(jsonb_build_object('id', ev.id, 'kind', ev.kind, 'label', ev.label,
        'proposal_id', ev.proposal_id)), '[]'::jsonb) from ev),
    'citations', (select coalesce(jsonb_agg(jsonb_build_object('concept', e.concept_id, 'ref_kind', e.ref_kind,
        'ref', e.ref_id)), '[]'::jsonb) from edges e)
  );
$$;
revoke execute on function public.knowledge_graph(uuid, int) from anon, public;
grant execute on function public.knowledge_graph(uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- knowledge_recap
-- ---------------------------------------------------------------------------------------------------------
-- p_month: any date in the month (UTC calendar month). Scope: p_space, or every space of p_workspace the caller
-- can read (pass one of them; with neither the recap is empty).
--
-- Definitions (all limited to what the caller can read):
--   concepts_added      concepts whose first revision was written in the month
--   concepts_changed    concepts with at least one later revision in the month
--   most_corrected      the concept with the most later revisions in the month (ties: most recent change)
--   applied_by_*        proposals behind the month's revisions, by who applied them: a person (human:), an agent
--                       reviewer (agent:) or the service role (auto-apply policy and other processes)
--   flags_*             flags raised in the month; flags resolved by an applied proposal in the month
--   top_flagger         who raised the most of those resolved flags
--   median_fix_seconds  median time from a flag being raised to the proposal that resolved it being applied
--   went_stale / stale_fixed  stable concepts whose stale_after date fell in the month (and had passed) while
--                       that revision was still current; of those, how many got a new revision before month end
create or replace function public.knowledge_recap(p_month date, p_space uuid default null, p_workspace uuid default null)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  with bounds as (
    select (date_trunc('month', coalesce(p_month, current_date)::timestamp) at time zone 'UTC') as m_start,
           ((date_trunc('month', coalesce(p_month, current_date)::timestamp) + interval '1 month') at time zone 'UTC') as m_end
  ),
  sp as (
    select s.id, s.slug, s.name
    from public.spaces s
    where (p_space is not null or p_workspace is not null)
      and (p_space is null or s.id = p_space)
      and (p_workspace is null or s.workspace_id = p_workspace)
  ),
  rev as (
    select r.concept_id, r.space_id, r.revision, r.actor, r.proposal_id, r.created_at
    from public.concept_revisions r, bounds b
    where r.space_id in (select id from sp) and r.created_at >= b.m_start and r.created_at < b.m_end
  ),
  corrected as (
    select r.concept_id, count(*)::int as n, max(r.created_at) as last_at
    from rev r where r.revision > 1 group by r.concept_id
  ),
  top_concept as (
    select k.path, k.title, k.kind, s.slug as space_slug, s.name as space_name, x.n
    from corrected x
    join public.concepts k on k.id = x.concept_id
    join sp s on s.id = k.space_id
    order by x.n desc, x.last_at desc, k.path
    limit 1
  ),
  applied as (
    select r.proposal_id as pid,
           case when r.actor like 'human:%' then 'people' when r.actor like 'agent:%' then 'agents' else 'policy' end as by
    from rev r where r.proposal_id is not null
  ),
  raised as (
    select f.id from public.flags f, bounds b
    where f.space_id in (select id from sp) and f.created_at >= b.m_start and f.created_at < b.m_end
  ),
  fixed as (
    select f.created_by, f.created_at, f.resolved_at
    from public.flags f, bounds b
    where f.space_id in (select id from sp) and f.status = 'resolved' and f.proposal_id is not null
      and f.resolved_at >= b.m_start and f.resolved_at < b.m_end
  ),
  flaggers as (
    select x.created_by, count(*)::int as n, min(x.created_at) as first_at
    from fixed x where x.created_by is not null group by x.created_by
  ),
  top_flagger as (
    select p.display_name, p.kind, x.n
    from flaggers x join public.profiles p on p.id = x.created_by
    order by x.n desc, x.first_at, p.display_name
    limit 1
  ),
  -- the interval each visible revision was current: [created_at, next revision's created_at)
  spans as (
    select r.concept_id, r.status, r.stale_after,
           lead(r.created_at) over (partition by r.concept_id order by r.revision) as superseded_at
    from public.concept_revisions r
    where r.space_id in (select id from sp)
  ),
  went_stale as (
    select distinct on (s.concept_id) s.concept_id, s.stale_after
    from spans s, bounds b
    where s.status = 'stable' and s.stale_after >= b.m_start and s.stale_after < least(b.m_end, now())
      and (s.superseded_at is null or s.superseded_at > s.stale_after)
    order by s.concept_id, s.stale_after
  )
  select jsonb_build_object(
    'month', to_char((select m_start from bounds) at time zone 'UTC', 'YYYY-MM'),
    'spaces', (select count(*) from sp),
    'concepts_added', (select count(distinct concept_id) from rev where revision = 1),
    'concepts_changed', (select count(distinct concept_id) from rev where revision > 1),
    'revisions', (select count(*) from rev),
    'most_corrected', (select to_jsonb(t) from top_concept t),
    'applied_by_people', (select count(distinct pid) from applied where by = 'people'),
    'applied_by_agents', (select count(distinct pid) from applied where by = 'agents'),
    'applied_by_policy', (select count(distinct pid) from applied where by = 'policy'),
    'flags_raised', (select count(*) from raised),
    'flags_fixed', (select count(*) from fixed),
    'top_flagger', (select to_jsonb(t) from top_flagger t),
    'median_fix_seconds', (select round(percentile_cont(0.5) within group (
        order by extract(epoch from (x.resolved_at - x.created_at)))::numeric) from fixed x),
    'went_stale', (select count(*) from went_stale),
    'stale_fixed', (select count(*) from went_stale w, bounds b
                     where exists (select 1 from public.concept_revisions r
                                    where r.concept_id = w.concept_id and r.created_at > w.stale_after
                                      and r.created_at < b.m_end))
  );
$$;
revoke execute on function public.knowledge_recap(date, uuid, uuid) from anon, public;
grant execute on function public.knowledge_recap(date, uuid, uuid) to authenticated, service_role;
