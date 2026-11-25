-- Supaknowledge: review fixes, part 7 — indexes for hot curator, proposal, RLS and FK paths.
-- (Plain CREATE INDEX: these tables are small at migration time. On a large live database, create them
-- CONCURRENTLY by hand first; IF NOT EXISTS then skips them here.)

-- concepts: curator "concepts citing this document" (frontmatter @> ...) and the daily staleness sweep
create index if not exists concepts_frontmatter_idx on public.concepts using gin (frontmatter jsonb_path_ops);
create index if not exists concepts_stale_idx on public.concepts (space_id, stale_after)
  where status = 'stable' and stale_after is not null;

-- RLS: group grants by group (my_spaces / space_rank)
create index if not exists space_group_grants_group_idx on public.space_group_grants (group_id);
create index if not exists groups_workspace_idx on public.groups (workspace_id);

-- proposals
create index if not exists proposal_ops_proposal_idx on public.proposal_ops (proposal_id);
create index if not exists proposal_ops_space_path_idx on public.proposal_ops (space_id, path);
create index if not exists proposal_ops_concept_idx on public.proposal_ops (concept_id) where concept_id is not null;
create index if not exists proposal_reviews_proposal_idx on public.proposal_reviews (proposal_id);
create index if not exists proposal_citations_ref_idx on public.proposal_citations (ref_id) where ref_id is not null;
create index if not exists proposals_run_idx on public.proposals (run_id) where run_id is not null;

-- flags
create index if not exists flags_proposal_idx on public.flags (proposal_id) where proposal_id is not null;
create index if not exists flags_created_by_idx on public.flags (created_by);
create index if not exists flags_trace_idx on public.flags (trace_id) where trace_id is not null;

-- traces (RLS: own / on behalf of)
create index if not exists traces_principal_idx on public.traces (principal_id);
create index if not exists traces_on_behalf_of_idx on public.traces (on_behalf_of) where on_behalf_of is not null;

-- concept graph, files, verifications, revisions
create index if not exists concept_links_to_path_idx on public.concept_links (space_id, to_path);
create index if not exists concept_files_space_idx on public.concept_files (space_id);
create index if not exists verifications_space_idx on public.verifications (space_id);
create index if not exists concept_revisions_proposal_idx on public.concept_revisions (proposal_id) where proposal_id is not null;

-- curator
create index if not exists curator_tasks_run_status_idx on public.curator_tasks (run_id, status);
create index if not exists curator_runs_space_status_idx on public.curator_runs (space_id, status, created_at desc);

-- evidence: URL citations resolve to documents
create index if not exists source_documents_url_idx on public.source_documents (space_id, url) where url is not null;
create index if not exists concept_usage_principal_idx on public.concept_usage (principal_id, at desc);

-- audit (find_user_by_email rate limit, audit browsing per workspace)
create index if not exists audit_log_actor_idx on public.audit_log (actor_user_id, action, at desc);
create index if not exists audit_log_workspace_idx on public.audit_log (workspace_id, at desc);
