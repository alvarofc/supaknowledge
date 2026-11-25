-- Supaknowledge: the factory loop
--   flags      working agents report missing / wrong knowledge (they never edit knowledge themselves)
--   curator_*  background curator runs, split into queue-driven tasks
--   proposals  PR-style changesets (ops + citations) that humans review or policy auto-applies
--   audit_log  every privileged action

create type public.flag_kind as enum ('missing', 'incorrect', 'outdated', 'conflicting', 'unclear');
create type public.flag_status as enum ('open', 'in_proposal', 'resolved', 'dismissed');

create table public.flags (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  trace_id uuid references public.traces (id) on delete set null,
  kind public.flag_kind not null,
  concept_id uuid references public.concepts (id) on delete set null,
  concept_path text,
  query text,              -- what the agent was trying to do / looked for
  observation text not null,  -- what it saw (e.g. "column revenue_usd does not exist; found revenue_usd_net")
  suggested_fix text,
  evidence jsonb not null default '{}',
  audience uuid[] not null default '{}',   -- inherited from the concept, so flags never leak restricted content
  status public.flag_status not null default 'open',
  proposal_id uuid,
  resolution text,
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  synthetic boolean not null default false,   -- created by the curator from a trace "correction moment"
  created_at timestamptz not null default now()
);
create index on public.flags (space_id, status, created_at desc);
create index on public.flags (concept_id) where status = 'open';

create type public.run_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

create table public.curator_runs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  trigger text not null,                -- cron | flag_threshold | manual | staleness
  requested_by uuid references auth.users (id) on delete set null,
  status public.run_status not null default 'queued',
  -- watermarks: what this run covers
  since timestamptz,
  until timestamptz,
  stats jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index on public.curator_runs (space_id, created_at desc);

-- one unit of curator work: gather | cluster:<n> | sweep:<concept>
create table public.curator_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.curator_runs (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  step text not null,                   -- gather | detect | draft | sweep | finalize
  input jsonb not null default '{}',
  output jsonb,
  status public.run_status not null default 'queued',
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on public.curator_tasks (run_id);

create type public.proposal_status as enum ('pending', 'approved', 'applied', 'rejected', 'conflicted', 'superseded');
create type public.proposal_risk as enum ('low', 'medium', 'high');
create type public.proposal_op_kind as enum ('create', 'update', 'deprecate', 'move');

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  run_id uuid references public.curator_runs (id) on delete set null,
  author text not null,                 -- "curator/<model>" | "human:<uuid>" | "import:okf"
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  title text not null,
  rationale text not null default '',
  risk public.proposal_risk not null default 'medium',
  -- true when applying would expose restricted evidence to a wider audience (see private.is_escalation)
  escalation boolean not null default false,
  status public.proposal_status not null default 'pending',
  auto_applied boolean not null default false,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.proposals (space_id, status, created_at desc);

create table public.proposal_ops (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  ord int not null,
  op public.proposal_op_kind not null,
  concept_id uuid references public.concepts (id) on delete set null,
  path text not null,
  new_path text,                        -- for move
  base_revision int,                    -- optimistic concurrency: revision the op was drafted against
  -- new state for create/update:
  --   {kind, type, title, description, body, frontmatter, tags, status, stale_after, audience, superseded_by}
  after jsonb not null default '{}',
  -- audience of the target after the op (denormalised for RLS + escalation checks)
  target_audience uuid[] not null default '{}',
  rationale text,
  unique (proposal_id, ord),
  unique (proposal_id, id)
);

create type public.citation_kind as enum ('source_document', 'trace', 'flag', 'concept', 'url');

create table public.proposal_citations (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  op_id uuid,
  label text not null,                  -- OKF footnote id, e.g. "slack-finance-2026-11-20"
  ref_kind public.citation_kind not null,
  ref_id uuid,
  url text,
  quote text,
  audience uuid[] not null default '{}', -- audience of the cited material (copied at citation time)
  foreign key (proposal_id, op_id) references public.proposal_ops (proposal_id, id) on delete cascade
);
create index on public.proposal_citations (proposal_id);

create type public.review_decision as enum ('approve', 'reject', 'comment', 'request_changes');

create table public.proposal_reviews (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  reviewer uuid references auth.users (id) on delete set null default auth.uid(),
  decision public.review_decision not null,
  note text,
  created_at timestamptz not null default now()
);

alter table public.flags add constraint flags_proposal_fk foreign key (proposal_id) references public.proposals (id) on delete set null;
alter table public.concept_revisions add constraint revisions_proposal_fk foreign key (proposal_id) references public.proposals (id) on delete set null;

create table public.audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor text not null,
  action text not null,
  target_kind text,
  target_id uuid,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create index on public.audit_log (space_id, at desc);

-- ---------------------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------------------
alter table public.flags enable row level security;
alter table public.curator_runs enable row level security;
alter table public.curator_tasks enable row level security;
alter table public.proposals enable row level security;
alter table public.proposal_ops enable row level security;
alter table public.proposal_citations enable row level security;
alter table public.proposal_reviews enable row level security;
alter table public.audit_log enable row level security;

-- flags: anyone who can read the space can raise one (through public.flag_knowledge). Reading: the author,
-- and editors+ who are in the flag's audience.
create policy "flags: author or editors" on public.flags for select to authenticated
  using (
    created_by = (select auth.uid())
    or (space_id in (select private.my_spaces('editor')) and private.in_audience(audience))
  );
create policy "flags: reviewers update" on public.flags for update to authenticated
  using (space_id in (select private.my_spaces('reviewer')) and private.in_audience(audience))
  with check (space_id in (select private.my_spaces('reviewer')) and private.in_audience(audience));

create policy "curator_runs: editors read" on public.curator_runs for select to authenticated
  using (space_id in (select private.my_spaces('editor')));
create policy "curator_tasks: admins read" on public.curator_tasks for select to authenticated
  using (space_id in (select private.my_spaces('admin')));
-- input/output/error carry evidence from any audience; admins only get the status columns
revoke select on public.curator_tasks from authenticated, anon;
grant select (id, run_id, space_id, step, status, attempts, created_at, finished_at) on public.curator_tasks to authenticated;

-- a proposal is visible to editors+ only if they can see EVERY piece of evidence it cites and every
-- target audience it writes to. Reviewing something you cannot fully see is not a review.
create function private.can_see_proposal(p_proposal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
      select 1 from public.proposal_citations c where c.proposal_id = p_proposal and not private.in_audience(c.audience)
    ) and not exists (
      select 1 from public.proposal_ops o where o.proposal_id = p_proposal and not private.in_audience(o.target_audience)
    ) and not exists (
      select 1 from public.proposal_ops o join public.concepts k on k.id = o.concept_id
      where o.proposal_id = p_proposal and not private.in_audience(k.audience)
    );
$$;
grant execute on function private.can_see_proposal(uuid) to authenticated;

create policy "proposals: editors who can see all evidence" on public.proposals for select to authenticated
  using (space_id in (select private.my_spaces('editor')) and private.can_see_proposal(id));
create policy "proposals: editors create own" on public.proposals for insert to authenticated
  with check (
    space_id in (select private.my_spaces('editor'))
    and created_by = (select auth.uid())
    and status = 'pending' and auto_applied = false and escalation = false
    and author = 'human:' || (select auth.uid())::text
  );

create policy "proposal_ops: visible with proposal" on public.proposal_ops for select to authenticated
  using (proposal_id in (select p.id from public.proposals p));
create policy "proposal_ops: author adds to own pending proposal" on public.proposal_ops for insert to authenticated
  with check (
    proposal_id in (select p.id from public.proposals p where p.created_by = (select auth.uid()) and p.status = 'pending')
    and private.in_audience(target_audience)
  );

create policy "proposal_citations: visible with proposal" on public.proposal_citations for select to authenticated
  using (proposal_id in (select p.id from public.proposals p));
create policy "proposal_citations: author adds to own pending proposal" on public.proposal_citations for insert to authenticated
  with check (
    proposal_id in (select p.id from public.proposals p where p.created_by = (select auth.uid()) and p.status = 'pending')
    and private.in_audience(audience)
  );

create policy "proposal_reviews: visible with proposal" on public.proposal_reviews for select to authenticated
  using (proposal_id in (select p.id from public.proposals p));
create policy "proposal_reviews: editors comment" on public.proposal_reviews for insert to authenticated
  with check (
    reviewer = (select auth.uid())
    and decision in ('comment', 'request_changes')
    and proposal_id in (select p.id from public.proposals p)
  );

create policy "audit_log: admins read" on public.audit_log for select to authenticated
  using (
    space_id in (select private.my_spaces('admin'))
    or (space_id is null and workspace_id in (select private.my_workspaces('admin')))
  );
