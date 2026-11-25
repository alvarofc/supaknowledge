-- Supaknowledge: review fixes, part 4 — RLS policies rewritten for correctness and performance.
--
--   * Audience checks use `private.aud_ok(audience, (select private.my_group_ids()))`: the caller's groups are
--     computed once per statement (initPlan) and the check is inlined, instead of one SECURITY DEFINER call per
--     row (which also made the GIN indexes on audience unusable).
--   * Child tables (chunks, files, links, verifications, source chunks, trace events, proposal children) use a
--     correlated EXISTS on the parent's primary key instead of `IN (SELECT id FROM parent)`, which materialised
--     every visible parent row of every space.
--   * Proposals: can_see_proposal(id, groups) with the group list from an initPlan; live evidence audiences.
--   * Soft-deleted source documents (deleted_at is not null) are no longer readable (rows, chunks, Storage files).
--   * flags: reviewers can only set resolved_by to themselves and link proposals of the same space they can see.
--   * traces: curated_at (and created_at) are not client-insertable; on_behalf_of must be a member of the trace's
--     workspace.
--   * trust(): one index lookup instead of two EXISTS per concept.
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- knowledge
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "concepts: readers in audience" on public.concepts;
create policy "concepts: readers in audience" on public.concepts for select to authenticated
  using (space_id in (select private.my_spaces('reader')) and private.aud_ok(audience, (select private.my_group_ids())));

drop policy if exists "concept_revisions: readers in audience" on public.concept_revisions;
create policy "concept_revisions: readers in audience" on public.concept_revisions for select to authenticated
  using (space_id in (select private.my_spaces('reader')) and private.aud_ok(audience, (select private.my_group_ids())));

drop policy if exists "concept_files: readers of concept" on public.concept_files;
create policy "concept_files: readers of concept" on public.concept_files for select to authenticated
  using (exists (select 1 from public.concepts c where c.id = concept_files.concept_id));  -- concepts RLS applies inside

drop policy if exists "concept_links: readers of both ends" on public.concept_links;
create policy "concept_links: readers of both ends" on public.concept_links for select to authenticated
  using (
    exists (select 1 from public.concepts c where c.id = concept_links.from_concept)
    and (concept_links.to_concept is null or exists (select 1 from public.concepts c where c.id = concept_links.to_concept))
  );

drop policy if exists "concept_chunks: readers of concept" on public.concept_chunks;
create policy "concept_chunks: readers of concept" on public.concept_chunks for select to authenticated
  using (exists (select 1 from public.concepts c where c.id = concept_chunks.concept_id));

drop policy if exists "verifications: readers of concept" on public.verifications;
create policy "verifications: readers of concept" on public.verifications for select to authenticated
  using (exists (select 1 from public.concepts c where c.id = verifications.concept_id));

create or replace function public.trust(c public.concepts) returns public.trust_tier
language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select case when bool_or(v.actor like 'human:%') then 'human_reviewed'::public.trust_tier
                else 'machine_confirmed'::public.trust_tier end
    from public.verifications v where v.concept_id = c.id and v.revision = c.revision
    having count(*) > 0
  ), 'unverified'::public.trust_tier);
$$;

-- ---------------------------------------------------------------------------------------------------------
-- evidence
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "sources: editors read" on public.sources;
create policy "sources: editors read" on public.sources for select to authenticated
  using (space_id in (select private.my_spaces('editor')) and private.aud_ok(audience, (select private.my_group_ids())));
drop policy if exists "sources: admins insert" on public.sources;
create policy "sources: admins insert" on public.sources for insert to authenticated
  with check (space_id in (select private.my_spaces('admin')) and private.aud_ok(audience, (select private.my_group_ids())));
drop policy if exists "sources: admins update" on public.sources;
create policy "sources: admins update" on public.sources for update to authenticated
  using (space_id in (select private.my_spaces('admin')) and private.aud_ok(audience, (select private.my_group_ids())))
  with check (space_id in (select private.my_spaces('admin')) and private.aud_ok(audience, (select private.my_group_ids())));
drop policy if exists "sources: admins delete" on public.sources;
create policy "sources: admins delete" on public.sources for delete to authenticated
  using (space_id in (select private.my_spaces('admin')) and private.aud_ok(audience, (select private.my_group_ids())));

drop policy if exists "source_documents: editors in audience" on public.source_documents;
create policy "source_documents: editors in audience" on public.source_documents for select to authenticated
  using (
    deleted_at is null
    and space_id in (select private.my_spaces('editor'))
    and private.aud_ok(audience, (select private.my_group_ids()))
  );

drop policy if exists "source_chunks: readers of document" on public.source_chunks;
create policy "source_chunks: readers of document" on public.source_chunks for select to authenticated
  using (exists (select 1 from public.source_documents d where d.id = source_chunks.document_id));

drop policy if exists "traces: own or reviewers" on public.traces;
create policy "traces: own or reviewers" on public.traces for select to authenticated
  using (
    principal_id = (select auth.uid())
    or on_behalf_of = (select auth.uid())
    or (space_id in (select private.my_spaces('reviewer')) and private.aud_ok(audience, (select private.my_group_ids())))
  );

drop policy if exists "trace_events: visible with trace" on public.trace_events;
create policy "trace_events: visible with trace" on public.trace_events for select to authenticated
  using (exists (select 1 from public.traces t where t.id = trace_events.trace_id));
drop policy if exists "trace_events: sender inserts" on public.trace_events;
create policy "trace_events: sender inserts" on public.trace_events for insert to authenticated
  with check (exists (select 1 from public.traces t
                       where t.id = trace_events.trace_id and t.space_id = trace_events.space_id
                         and t.principal_id = (select auth.uid())));

drop policy if exists "concept_usage: reviewers or own" on public.concept_usage;
create policy "concept_usage: reviewers or own" on public.concept_usage for select to authenticated
  using (
    principal_id = (select auth.uid())
    or (space_id in (select private.my_spaces('reviewer'))
        and exists (select 1 from public.concepts c where c.id = concept_usage.concept_id))
  );
drop policy if exists "concept_usage: log own reads" on public.concept_usage;
create policy "concept_usage: log own reads" on public.concept_usage for insert to authenticated
  with check (
    principal_id = (select auth.uid())
    and exists (select 1 from public.concepts c where c.id = concept_usage.concept_id and c.space_id = concept_usage.space_id)
    and (trace_id is null or exists (select 1 from public.traces t
                                      where t.id = concept_usage.trace_id and t.principal_id = (select auth.uid())))
  );

-- traces: what a sender may write on insert (curated_at belongs to the curator)
revoke insert on public.traces from authenticated, anon;
grant insert (space_id, principal_id, on_behalf_of, external_id, name, outcome, audience, metadata, started_at, ended_at)
  on public.traces to authenticated;

-- on_behalf_of must be a member of the trace's workspace (no planting traces in another tenant's view)
create or replace function private.check_trace_on_behalf_of() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.on_behalf_of is not null
     and (tg_op = 'INSERT' or new.on_behalf_of is distinct from old.on_behalf_of or new.space_id is distinct from old.space_id)
     and not exists (select 1 from public.spaces s join public.workspace_members wm on wm.workspace_id = s.workspace_id
                      where s.id = new.space_id and wm.user_id = new.on_behalf_of) then
    raise exception 'on_behalf_of must be a member of this workspace' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function private.check_trace_on_behalf_of() from public, anon, authenticated;
create or replace trigger traces_on_behalf_of before insert or update of on_behalf_of, space_id on public.traces
  for each row execute function private.check_trace_on_behalf_of();

-- ---------------------------------------------------------------------------------------------------------
-- flags
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "flags: author or editors" on public.flags;
create policy "flags: author or editors" on public.flags for select to authenticated
  using (
    created_by = (select auth.uid())
    or (space_id in (select private.my_spaces('editor')) and private.aud_ok(audience, (select private.my_group_ids())))
  );
drop policy if exists "flags: reviewers update" on public.flags;
create policy "flags: reviewers update" on public.flags for update to authenticated
  using (space_id in (select private.my_spaces('reviewer')) and private.aud_ok(audience, (select private.my_group_ids())))
  with check (
    space_id in (select private.my_spaces('reviewer'))
    and private.aud_ok(audience, (select private.my_group_ids()))
    and (resolved_by is null or resolved_by = (select auth.uid()))
    -- proposals RLS applies inside: same space AND visible to the reviewer
    and (proposal_id is null or exists (select 1 from public.proposals p where p.id = flags.proposal_id and p.space_id = flags.space_id))
  );

-- ---------------------------------------------------------------------------------------------------------
-- proposals
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "proposals: editors who can see all evidence" on public.proposals;
create policy "proposals: editors who can see all evidence" on public.proposals for select to authenticated
  using (space_id in (select private.my_spaces('editor')) and private.can_see_proposal(id, (select private.my_group_ids())));

drop policy if exists "proposal_ops: visible with proposal" on public.proposal_ops;
create policy "proposal_ops: visible with proposal" on public.proposal_ops for select to authenticated
  using (exists (select 1 from public.proposals p where p.id = proposal_ops.proposal_id));

drop policy if exists "proposal_citations: visible with proposal" on public.proposal_citations;
create policy "proposal_citations: visible with proposal" on public.proposal_citations for select to authenticated
  using (exists (select 1 from public.proposals p where p.id = proposal_citations.proposal_id));

drop policy if exists "proposal_reviews: visible with proposal" on public.proposal_reviews;
create policy "proposal_reviews: visible with proposal" on public.proposal_reviews for select to authenticated
  using (exists (select 1 from public.proposals p where p.id = proposal_reviews.proposal_id));
drop policy if exists "proposal_reviews: editors comment" on public.proposal_reviews;
create policy "proposal_reviews: editors comment" on public.proposal_reviews for insert to authenticated
  with check (
    reviewer = (select auth.uid())
    and decision in ('comment', 'request_changes')
    and exists (select 1 from public.proposals p where p.id = proposal_reviews.proposal_id)
  );

-- ---------------------------------------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "concept-files: readers of concept" on storage.objects;
create policy "concept-files: readers of concept" on storage.objects for select to authenticated
  using (
    bucket_id = 'concept-files'
    and exists (select 1 from public.concepts c where c.id = private.try_uuid((storage.foldername(objects.name))[2]))
  );

drop policy if exists "sources: editors in document audience" on storage.objects;
create policy "sources: editors in document audience" on storage.objects for select to authenticated
  using (
    bucket_id = 'sources'
    -- source_documents RLS applies inside (editors+, audience, not soft-deleted)
    and exists (select 1 from public.source_documents d where d.storage_path = objects.name)
  );
