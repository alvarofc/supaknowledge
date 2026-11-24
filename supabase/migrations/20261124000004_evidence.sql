-- Supaknowledge: evidence the curator learns from
--   sources / source_documents / source_chunks : raw material from Notion, Slack, GitHub, Drive, web, uploads
--   traces / trace_events                       : what agents actually did (and where humans corrected them)
--   concept_usage                               : which knowledge was retrieved for which work
--
-- Access: raw evidence often carries upstream ACLs (a private Slack channel, a restricted Drive folder).
-- Connectors map those to `audience` groups, and RLS enforces them exactly like concepts.

create type public.connector_kind as enum ('notion', 'slack', 'github', 'gdrive', 'web', 'upload');
create type public.source_status as enum ('active', 'paused', 'error');

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  connector public.connector_kind not null,
  name text not null,
  -- connector config (no secrets): {"database_ids": [...]}, {"channels": [...]}, {"repo": "org/x", "paths": [...]}
  config jsonb not null default '{}',
  -- Vault secret id holding the connector token. Never readable through the API.
  secret_id uuid,
  audience uuid[] not null default '{}',
  sync_interval interval not null default '1 hour',
  status public.source_status not null default 'active',
  cursor jsonb not null default '{}',
  last_synced_at timestamptz,
  last_error text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (space_id, name)
);

create table public.source_documents (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  external_id text not null,
  title text,
  url text,
  storage_path text,              -- original bytes in bucket "sources" at <space_id>/<source_id>/<file>
  mime_type text,
  content text not null default '',  -- extracted plain text / markdown
  content_hash text not null,
  audience uuid[] not null default '{}',
  author text,
  metadata jsonb not null default '{}',
  external_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),   -- last time content_hash changed (curator watermark)
  deleted_at timestamptz,
  unique (source_id, external_id)
);
create index on public.source_documents (space_id, changed_at desc);
create index on public.source_documents using gin (audience);

create table public.source_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.source_documents (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  ord int not null,
  heading text,
  content text not null,
  embedding extensions.vector(384),
  fts tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || content)) stored,
  unique (document_id, ord)
);
create index on public.source_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index on public.source_chunks using gin (fts);
create index on public.source_chunks (space_id);

-- ---------------------------------------------------------------------------------------------------------
-- traces
-- ---------------------------------------------------------------------------------------------------------
create type public.trace_outcome as enum ('unknown', 'success', 'failure', 'corrected');
create type public.trace_role as enum ('system', 'user', 'assistant', 'tool', 'feedback');

create table public.traces (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  principal_id uuid references auth.users (id) on delete set null default auth.uid(),  -- who sent it (agent or human)
  on_behalf_of uuid references auth.users (id) on delete set null,                     -- human the agent worked for
  external_id text,              -- id in the upstream tracer (OTel trace id, LangSmith run id...)
  name text,
  outcome public.trace_outcome not null default 'unknown',
  audience uuid[] not null default '{}',
  metadata jsonb not null default '{}',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  curated_at timestamptz,        -- set when the curator has processed it
  created_at timestamptz not null default now(),
  unique (space_id, external_id)
);
create index on public.traces (space_id, created_at desc);
create index on public.traces (space_id) where curated_at is null;

create table public.trace_events (
  id bigint generated always as identity primary key,
  trace_id uuid not null references public.traces (id) on delete cascade,
  space_id uuid not null references public.spaces (id) on delete cascade,
  seq int not null,
  role public.trace_role not null,
  content text,
  tool_name text,
  tool_input jsonb,
  tool_output jsonb,
  is_error boolean not null default false,
  metadata jsonb not null default '{}',
  at timestamptz not null default now(),
  unique (trace_id, seq)
);

create table public.concept_usage (
  id bigint generated always as identity primary key,
  space_id uuid not null references public.spaces (id) on delete cascade,
  concept_id uuid not null references public.concepts (id) on delete cascade,
  revision int not null,
  principal_id uuid references auth.users (id) on delete set null default auth.uid(),
  trace_id uuid references public.traces (id) on delete set null,
  via text not null default 'search',   -- search | read | load_skill
  query text,
  at timestamptz not null default now()
);
create index on public.concept_usage (concept_id, at desc);
create index on public.concept_usage (space_id, at desc);

-- ---------------------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------------------
alter table public.sources enable row level security;
alter table public.source_documents enable row level security;
alter table public.source_chunks enable row level security;
alter table public.traces enable row level security;
alter table public.trace_events enable row level security;
alter table public.concept_usage enable row level security;

-- sources: metadata visible to editors+ in audience; managed by space admins. secret_id is hidden by a
-- column grant below.
create policy "sources: editors read" on public.sources for select to authenticated
  using (space_id in (select private.my_spaces('editor')) and private.in_audience(audience));
create policy "sources: admins insert" on public.sources for insert to authenticated
  with check (space_id in (select private.my_spaces('admin')) and private.in_audience(audience));
create policy "sources: admins update" on public.sources for update to authenticated
  using (space_id in (select private.my_spaces('admin')) and private.in_audience(audience))
  with check (space_id in (select private.my_spaces('admin')) and private.in_audience(audience));
create policy "sources: admins delete" on public.sources for delete to authenticated
  using (space_id in (select private.my_spaces('admin')) and private.in_audience(audience));

revoke select on public.sources from authenticated, anon;
grant select (id, space_id, connector, name, config, audience, sync_interval, status, cursor, last_synced_at,
              last_error, created_by, created_at) on public.sources to authenticated;
revoke update on public.sources from authenticated;
grant update (name, config, audience, sync_interval, status) on public.sources to authenticated;
-- secret_id is only ever written by set_source_secret()
revoke insert on public.sources from authenticated, anon;
grant insert (space_id, connector, name, config, audience, sync_interval, status) on public.sources to authenticated;

-- raw documents: editors+ in audience (agents are readers, so they never see raw evidence)
create policy "source_documents: editors in audience" on public.source_documents for select to authenticated
  using (space_id in (select private.my_spaces('editor')) and private.in_audience(audience));
create policy "source_chunks: readers of document" on public.source_chunks for select to authenticated
  using (document_id in (select d.id from public.source_documents d));

-- traces: the sender, the human it was for, and reviewers+ in audience
create policy "traces: own or reviewers" on public.traces for select to authenticated
  using (
    principal_id = (select auth.uid())
    or on_behalf_of = (select auth.uid())
    or (space_id in (select private.my_spaces('reviewer')) and private.in_audience(audience))
  );
create policy "traces: readers insert own" on public.traces for insert to authenticated
  with check (space_id in (select private.my_spaces('reader')) and principal_id = (select auth.uid()));
create policy "traces: sender updates own" on public.traces for update to authenticated
  using (principal_id = (select auth.uid()))
  with check (principal_id = (select auth.uid()) and space_id in (select private.my_spaces('reader')));

create policy "trace_events: visible with trace" on public.trace_events for select to authenticated
  using (trace_id in (select t.id from public.traces t));
create policy "trace_events: sender inserts" on public.trace_events for insert to authenticated
  with check ((trace_id, space_id) in (select t.id, t.space_id from public.traces t where t.principal_id = (select auth.uid())));

create policy "concept_usage: reviewers or own" on public.concept_usage for select to authenticated
  using (
    principal_id = (select auth.uid())
    or (space_id in (select private.my_spaces('reviewer')) and concept_id in (select c.id from public.concepts c))
  );
