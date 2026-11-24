-- Supaknowledge: the knowledge store
--
-- A concept is one unit of knowledge (OKF "concept"). Three kinds, from the knowledge-factory model:
--   skill        how to do the work            -> exported as skills/<name>/SKILL.md
--   domain       how the business works        -> exported as an OKF concept
--   data_access  where live data is / how to query it -> exported as an OKF concept
--
-- Writes never go straight to `concepts`. Every change is a proposal applied by public.apply_proposal(),
-- which appends a row to concept_revisions. That gives one audited write path for humans and the curator.

create type public.concept_kind as enum ('skill', 'domain', 'data_access');
create type public.concept_status as enum ('draft', 'stable', 'deprecated');
create type public.trust_tier as enum ('unverified', 'machine_confirmed', 'human_reviewed');

create table public.concepts (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  -- OKF concept id: path inside the bundle without ".md", e.g. "metrics/arr" or "skills/revenue-report"
  path text not null check (path ~ '^[A-Za-z0-9_][A-Za-z0-9_./-]*$' and path !~ '\.\.' and path !~ '\.md$'),
  kind public.concept_kind not null,
  -- free-form OKF type: "Metric", "Playbook", "BigQuery Table", "Skill"...
  type text not null,
  title text not null,
  description text not null default '',
  body text not null default '',
  -- full OKF frontmatter (unknown keys preserved for lossless round-trips)
  frontmatter jsonb not null default '{}',
  tags text[] not null default '{}',
  status public.concept_status not null default 'stable',
  superseded_by text,
  stale_after timestamptz,
  audience uuid[] not null default '{}',
  revision int not null default 1,
  generated_by text,           -- actor of the last meaning-changing revision (OKF generated.by)
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) stored,
  unique (space_id, path)
);
create index on public.concepts using gin (fts);
create index on public.concepts (space_id, kind);
create index on public.concepts using gin (audience);
create index concepts_path_trgm on public.concepts using gin (path extensions.gin_trgm_ops);

create table public.concept_revisions (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references public.concepts (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  revision int not null,
  path text not null,
  kind public.concept_kind not null,
  type text not null,
  title text not null,
  description text not null,
  body text not null,
  frontmatter jsonb not null,
  tags text[] not null,
  status public.concept_status not null,
  superseded_by text,
  stale_after timestamptz,
  audience uuid[] not null,
  actor text not null,            -- "human:<uuid>", "curator/<model>", "import:okf", "process:policy"
  actor_user_id uuid references auth.users (id) on delete set null,
  reason text,
  proposal_id uuid,               -- fk added in loop migration
  created_at timestamptz not null default now(),
  unique (concept_id, revision)
);
create index on public.concept_revisions (space_id, created_at desc);

-- attachments of a concept (skill scripts, templates, references). Bytes live in Storage bucket
-- "concept-files" at <space_id>/<concept_id>/<path>.
create table public.concept_files (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references public.concepts (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  path text not null check (path !~ '\.\.' and path !~ '^/'),
  storage_path text not null,
  content_type text,
  size_bytes bigint,
  sha256 text,
  created_at timestamptz not null default now(),
  unique (concept_id, path)
);

-- the knowledge graph: markdown links between concepts, rebuilt by the embed worker on every revision
create table public.concept_links (
  space_id uuid not null references public.spaces (id) on delete cascade,
  from_concept uuid not null references public.concepts (id) on delete cascade,
  to_path text not null,
  to_concept uuid references public.concepts (id) on delete set null,
  anchor text,
  primary key (from_concept, to_path)
);
create index on public.concept_links (to_concept);

-- retrieval units. gte-small (Supabase Edge Runtime built-in) = 384 dims. Switching to a provider with a
-- different dimension requires a migration (see docs/architecture.md, Embeddings).
create table public.concept_chunks (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references public.concepts (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  revision int not null,
  ord int not null,
  heading text,
  content text not null,
  embedding extensions.vector(384),
  fts tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || content)) stored,
  unique (concept_id, ord)
);
create index on public.concept_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index on public.concept_chunks using gin (fts);
create index on public.concept_chunks (space_id);

-- OKF `verified` events, tied to a revision. Trust tier is derived:
--   human verification of the current revision -> human_reviewed
--   machine verification only                  -> machine_confirmed
--   none                                       -> unverified
create table public.verifications (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references public.concepts (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  revision int not null,
  actor text not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index on public.verifications (concept_id, revision);

-- computed column: PostgREST exposes it as `concepts?select=*,trust`
create function public.trust(c public.concepts) returns public.trust_tier
language sql stable security invoker set search_path = '' as $$
  select case
    when exists (select 1 from public.verifications v where v.concept_id = c.id and v.revision = c.revision and v.actor like 'human:%')
      then 'human_reviewed'::public.trust_tier
    when exists (select 1 from public.verifications v where v.concept_id = c.id and v.revision = c.revision)
      then 'machine_confirmed'::public.trust_tier
    else 'unverified'::public.trust_tier
  end;
$$;

create function public.is_stale(c public.concepts) returns boolean
language sql stable set search_path = '' as $$
  select c.stale_after is not null and c.stale_after < now();
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RLS: read = space reader AND in audience. No direct writes for `authenticated` (use proposals).
-- ---------------------------------------------------------------------------------------------------------
alter table public.concepts enable row level security;
alter table public.concept_revisions enable row level security;
alter table public.concept_files enable row level security;
alter table public.concept_links enable row level security;
alter table public.concept_chunks enable row level security;
alter table public.verifications enable row level security;

create policy "concepts: readers in audience" on public.concepts for select to authenticated
  using (space_id in (select private.my_spaces('reader')) and private.in_audience(audience));

create policy "concept_revisions: readers in audience" on public.concept_revisions for select to authenticated
  using (space_id in (select private.my_spaces('reader')) and private.in_audience(audience));

create policy "concept_files: readers of concept" on public.concept_files for select to authenticated
  using (concept_id in (select c.id from public.concepts c));  -- concepts RLS applies inside

create policy "concept_links: readers of both ends" on public.concept_links for select to authenticated
  using (
    from_concept in (select c.id from public.concepts c)
    and (to_concept is null or to_concept in (select c.id from public.concepts c))
  );

create policy "concept_chunks: readers of concept" on public.concept_chunks for select to authenticated
  using (concept_id in (select c.id from public.concepts c));

create policy "verifications: readers of concept" on public.verifications for select to authenticated
  using (concept_id in (select c.id from public.concepts c));
