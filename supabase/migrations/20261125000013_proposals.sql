-- Supaknowledge: review fixes, part 3 — proposals.
--
--   * public.create_proposal(): ONE transaction inserts the proposal, its ops and its citations and computes
--     escalation/risk, so nothing (title, rationale, ops) is visible or applicable before the evidence is attached.
--     Direct INSERT on proposals / proposal_ops / proposal_citations is revoked from `authenticated`.
--   * proposal_citations.consulted: evidence the curator READ but did not cite (taint tracking). It counts for
--     escalation and visibility exactly like a citation.
--   * URL citations that match a source document of the space are resolved to that document (and its audience).
--   * Citation audiences are always re-read from the live evidence rows (recompute_proposal_access,
--     can_see_proposal, apply_proposal), so reclassifying evidence after drafting cannot bypass the guard.
--   * The citation trigger only accepts evidence the author can see (uniform "cited <kind> not found" error).
--   * A proposal without ops is visible to nobody and cannot be applied.
--   * apply_proposal(): per-space advisory lock (no lost updates / audience races between concurrent applies),
--     JSON payload and path validation (conflicted instead of crashing), move clears stale links, agents apply as
--     `agent:<uid>` (machine trust) and never approve escalations, OAuth client tokens cannot apply.
--   * propose_revert() restores the revision's audience too and goes through create_proposal().
--   * Flags never point at a concept their audience cannot see (synthetic flags from the curator included).
-- Idempotent.

alter table public.proposal_citations add column if not exists consulted boolean not null default false;

-- ---------------------------------------------------------------------------------------------------------
-- validation helpers
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.valid_concept_path(p text) returns boolean
language sql immutable as $$
  select p is not null and p ~ '^[A-Za-z0-9_][A-Za-z0-9_./-]*$' and p !~ '\.\.' and p !~ '\.md$' and length(p) <= 512;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'proposal_ops_path_check' and conrelid = 'public.proposal_ops'::regclass) then
    alter table public.proposal_ops add constraint proposal_ops_path_check check (private.valid_concept_path(path)) not valid;
    alter table public.proposal_ops validate constraint proposal_ops_path_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'proposal_ops_new_path_check' and conrelid = 'public.proposal_ops'::regclass) then
    alter table public.proposal_ops add constraint proposal_ops_new_path_check
      check (new_path is null or private.valid_concept_path(new_path)) not valid;
    alter table public.proposal_ops validate constraint proposal_ops_new_path_check;
  end if;
end $$;

-- null when the op is well-formed, else the reason
create or replace function private.op_payload_error(p_op public.proposal_op_kind, p_path text, p_new_path text, p_after jsonb)
returns text
language plpgsql stable set search_path = '' as $$
declare
  a jsonb := coalesce(p_after, '{}'::jsonb);
  k text;
begin
  if jsonb_typeof(a) <> 'object' then return 'after must be a JSON object'; end if;
  if not private.valid_concept_path(p_path) then return 'invalid path'; end if;
  if p_op = 'move' and not private.valid_concept_path(p_new_path) then return 'invalid new_path'; end if;
  foreach k in array array['type', 'title', 'description', 'body', 'superseded_by', 'kind', 'status', 'stale_after'] loop
    if a ? k and jsonb_typeof(a -> k) not in ('string', 'null') then return k || ' must be a string'; end if;
  end loop;
  if jsonb_typeof(a -> 'kind') = 'string' and a ->> 'kind' not in ('skill', 'domain', 'data_access') then
    return 'invalid kind';
  end if;
  if jsonb_typeof(a -> 'status') = 'string' and a ->> 'status' not in ('draft', 'stable', 'deprecated') then
    return 'invalid status';
  end if;
  if a ? 'frontmatter' and jsonb_typeof(a -> 'frontmatter') not in ('object', 'null') then
    return 'frontmatter must be an object';
  end if;
  if a ? 'tags' and jsonb_typeof(a -> 'tags') not in ('array', 'null') then return 'tags must be an array'; end if;
  if jsonb_typeof(a -> 'tags') = 'array'
     and exists (select 1 from jsonb_array_elements(a -> 'tags') t where jsonb_typeof(t) <> 'string') then
    return 'tags must be strings';
  end if;
  if a ? 'audience' and jsonb_typeof(a -> 'audience') not in ('array', 'null') then return 'audience must be an array'; end if;
  if jsonb_typeof(a -> 'audience') = 'array'
     and exists (select 1 from jsonb_array_elements(a -> 'audience') t
                  where jsonb_typeof(t) <> 'string'
                     or (t #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return 'audience must be a list of group ids';
  end if;
  if jsonb_typeof(a -> 'stale_after') = 'string' then
    begin
      perform (a ->> 'stale_after')::timestamptz;
    exception when others then
      return 'invalid stale_after';
    end;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- ops: defaults, validation, audience rules
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.proposal_op_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_concept public.concepts;
  v_ws uuid;
  v_err text;
  v_service boolean := private.is_service_role();
begin
  select p.space_id, s.workspace_id into new.space_id, v_ws
    from public.proposals p join public.spaces s on s.id = p.space_id where p.id = new.proposal_id;
  if tg_op = 'INSERT' then
    v_err := private.op_payload_error(new.op, new.path, new.new_path, new.after);
    if v_err is not null then
      raise exception 'invalid op %: %', new.ord, v_err using errcode = '22023';
    end if;
  end if;
  if new.concept_id is null and new.op <> 'create' then
    select c.id into new.concept_id from public.concepts c where c.space_id = new.space_id and c.path = new.path;
  end if;
  if tg_op = 'INSERT' and new.op = 'create' then
    new.concept_id := null;
  elsif tg_op = 'INSERT' and not exists (
      select 1 from public.concepts c
      where c.id = new.concept_id and c.space_id = new.space_id
        and (v_service or private.in_audience(c.audience))) then
    -- same error whether the concept is missing, foreign or restricted: do not confirm it exists
    raise exception 'concept % not found', new.path using errcode = '42501';
  end if;
  if jsonb_typeof(new.after -> 'audience') = 'array' then
    new.target_audience := array(select jsonb_array_elements_text(new.after -> 'audience')::uuid);
    if tg_op = 'INSERT' and exists (select 1 from unnest(new.target_audience) g
                                     where not exists (select 1 from public.groups gr where gr.id = g and gr.workspace_id = v_ws)) then
      raise exception 'invalid op %: audience names a group that does not exist in this workspace', new.ord using errcode = '22023';
    end if;
  elsif new.concept_id is not null and tg_op = 'INSERT' then
    select * into v_concept from public.concepts c where c.id = new.concept_id;
    new.target_audience := coalesce(v_concept.audience, new.target_audience);
  end if;
  if tg_op = 'INSERT' and not v_service and not private.in_audience(new.target_audience) then
    raise exception 'you cannot write to an audience you are not in' using errcode = '42501';
  end if;
  return new;
end;
$$;
create or replace trigger proposal_ops_defaults before insert or update on public.proposal_ops
  for each row execute function private.proposal_op_defaults();

-- ---------------------------------------------------------------------------------------------------------
-- citations: resolve URLs, read the audience from the evidence, only accept evidence the author can see
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.proposal_citation_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_aud uuid[];
  v_visible boolean := false;
  v_service boolean := private.is_service_role();
  v_uid uuid := (select auth.uid());
  v_rank int := 0;
  v_groups uuid[] := '{}';
  v_doc record;
  r record;
begin
  select p.space_id into new.space_id from public.proposals p where p.id = new.proposal_id;
  if not v_service then
    v_rank := private.space_rank(new.space_id);
    v_groups := private.my_group_ids();
  end if;

  -- a URL that is a known document of this space IS that document (and carries its audience)
  if new.ref_kind = 'url' and new.ref_id is null and coalesce(new.url, '') <> '' then
    select d.id into v_doc from public.source_documents d
     where d.space_id = new.space_id and d.url = new.url
     order by (d.audience = '{}'), d.deleted_at nulls first
     limit 1;
    if found then
      new.ref_kind := 'source_document';
      new.ref_id := v_doc.id;
    end if;
  end if;

  if new.ref_id is not null then
    case new.ref_kind
      when 'source_document' then
        select d.audience as audience into r from public.source_documents d where d.id = new.ref_id and d.space_id = new.space_id;
        v_visible := found and (v_service or (v_rank >= 2 and private.aud_ok(r.audience, v_groups)));
      when 'trace' then
        select t.audience as audience, t.principal_id, t.on_behalf_of into r from public.traces t
         where t.id = new.ref_id and t.space_id = new.space_id;
        v_visible := found and (v_service or r.principal_id = v_uid or r.on_behalf_of = v_uid
                                or (v_rank >= 3 and private.aud_ok(r.audience, v_groups)));
      when 'flag' then
        select f.audience as audience, f.created_by into r from public.flags f where f.id = new.ref_id and f.space_id = new.space_id;
        v_visible := found and (v_service or r.created_by = v_uid or (v_rank >= 2 and private.aud_ok(r.audience, v_groups)));
      when 'concept' then
        select c.audience as audience into r from public.concepts c where c.id = new.ref_id and c.space_id = new.space_id;
        v_visible := found and (v_service or (v_rank >= 1 and private.aud_ok(r.audience, v_groups)));
      else
        raise exception 'url citations cannot carry a ref_id' using errcode = '22023';
    end case;
    if not coalesce(v_visible, false) then
      raise exception 'cited % not found', new.ref_kind using errcode = '42501';
    end if;
    new.audience := r.audience;
  end if;
  new.audience := coalesce(new.audience, '{}');
  return new;
end;
$$;
create or replace trigger proposal_citations_space before insert on public.proposal_citations
  for each row execute function private.proposal_citation_defaults();

-- live audience of every citation of a proposal (falls back to the snapshot when the row is gone or the
-- citation has no ref, e.g. a revert's revision or an external URL)
create or replace function private.proposal_citation_audiences(p_proposal uuid)
returns table (op_id uuid, audience uuid[])
language sql stable security definer set search_path = '' as $$
  select c.op_id, coalesce(case c.ref_kind
      when 'source_document' then (select d.audience from public.source_documents d where d.id = c.ref_id)
      when 'trace' then (select t.audience from public.traces t where t.id = c.ref_id)
      when 'flag' then (select f.audience from public.flags f where f.id = c.ref_id)
      when 'concept' then (select k.audience from public.concepts k where k.id = c.ref_id)
    end, c.audience, '{}'::uuid[])
  from public.proposal_citations c
  where c.proposal_id = p_proposal;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- escalation + visibility from live audiences
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.recompute_proposal_access(p_proposal uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_escalation boolean;
begin
  select
    exists (
      select 1 from private.proposal_citation_audiences(p_proposal) c
      join public.proposal_ops o on o.proposal_id = p_proposal and (c.op_id is null or c.op_id = o.id)
      where private.is_escalation(c.audience, o.target_audience)
    )
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

-- create_proposal inserts many children; it recomputes once at the end instead of once per row
create or replace function private.on_proposal_child_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('kf.defer_recompute', true), '') = 'on' then
    return null;
  end if;
  perform private.recompute_proposal_access(coalesce(new.proposal_id, old.proposal_id));
  return null;
end;
$$;

-- evidence or a target concept changed audience: keep the stored escalation flag of open proposals current
-- (apply_proposal recomputes anyway; this keeps Studio and the auto-apply policy honest in between)
create or replace function private.on_evidence_audience_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prop uuid;
begin
  for v_prop in
    select distinct p.id from public.proposals p
    where p.status in ('pending', 'approved')
      and (exists (select 1 from public.proposal_citations c where c.proposal_id = p.id and c.ref_id = new.id)
           or (tg_table_name = 'concepts'
               and exists (select 1 from public.proposal_ops o where o.proposal_id = p.id and o.concept_id = new.id)))
  loop
    perform private.recompute_proposal_access(v_prop);
  end loop;
  return null;
end;
$$;
create or replace trigger source_documents_audience_recompute after update of audience on public.source_documents
  for each row when (old.audience is distinct from new.audience) execute function private.on_evidence_audience_changed();
create or replace trigger traces_audience_recompute after update of audience on public.traces
  for each row when (old.audience is distinct from new.audience) execute function private.on_evidence_audience_changed();
create or replace trigger flags_audience_recompute after update of audience on public.flags
  for each row when (old.audience is distinct from new.audience) execute function private.on_evidence_audience_changed();
create or replace trigger concepts_audience_recompute after update of audience on public.concepts
  for each row when (old.audience is distinct from new.audience) execute function private.on_evidence_audience_changed();

create or replace function private.can_see_proposal(p_proposal uuid, p_groups uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.proposal_ops o where o.proposal_id = p_proposal)
    and not exists (
      select 1 from private.proposal_citation_audiences(p_proposal) c where not private.aud_ok(c.audience, p_groups)
    ) and not exists (
      select 1 from public.proposal_ops o where o.proposal_id = p_proposal and not private.aud_ok(o.target_audience, p_groups)
    ) and not exists (
      select 1 from public.proposal_ops o join public.concepts k on k.id = o.concept_id
      where o.proposal_id = p_proposal and not private.aud_ok(k.audience, p_groups)
    );
$$;

create or replace function private.can_see_proposal(p_proposal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_see_proposal(p_proposal, private.my_group_ids());
$$;
grant execute on function private.can_see_proposal(uuid, uuid[]) to authenticated, service_role;
grant execute on function private.can_see_proposal(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- create_proposal
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.create_proposal(
  p_space uuid,
  p_title text,
  p_rationale text,
  p_risk public.proposal_risk,
  p_ops jsonb,
  p_citations jsonb default '[]',
  p_run uuid default null,
  p_author text default null
) returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_service boolean := private.is_service_role();
  v_uid uuid := (select auth.uid());
  v_author text;
  v_created_by uuid;
  v_run uuid;
  p public.proposals;
  v_item jsonb;
  v_n bigint;
  v_i int := 0;
  v_ids uuid[] := '{}'::uuid[];
  v_id uuid;
  v_idx int;
  v_kind public.citation_kind;
  v_after jsonb;
  v_prev text := coalesce(current_setting('kf.defer_recompute', true), '');
begin
  -- who
  if v_service then
    if coalesce(trim(p_author), '') = '' then
      raise exception 'p_author is required for service-role proposals' using errcode = '22023';
    end if;
    if trim(p_author) ~* '^(human|agent):' then
      raise exception 'author prefixes human: and agent: are reserved' using errcode = '22023';
    end if;
    if not exists (select 1 from public.spaces s where s.id = p_space) then
      raise exception 'space not found' using errcode = '22023';
    end if;
    v_author := trim(p_author);
    if p_run is not null then
      if not exists (select 1 from public.curator_runs r where r.id = p_run and r.space_id = p_space) then
        raise exception 'curator run not found in this space' using errcode = '22023';
      end if;
      v_run := p_run;
    end if;
  else
    if v_uid is null then
      raise exception 'not authenticated' using errcode = '28000';
    end if;
    if private.is_agent() or private.is_oauth_client() then
      raise exception 'agents and OAuth client tokens cannot create proposals; use flag_knowledge' using errcode = '42501';
    end if;
    if private.space_rank(p_space) < 2 then
      raise exception 'editor role required' using errcode = '42501';
    end if;
    v_author := 'human:' || v_uid::text;
    v_created_by := v_uid;
  end if;

  -- what
  if coalesce(trim(p_title), '') = '' then
    raise exception 'title is required' using errcode = '22023';
  end if;
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) = 0 then
    raise exception 'a proposal needs at least one op' using errcode = '22023';
  end if;
  if jsonb_array_length(p_ops) > 1000 then
    raise exception 'too many ops (max 1000)' using errcode = '22023';
  end if;
  if p_citations is not null and jsonb_typeof(p_citations) not in ('array', 'null') then
    raise exception 'p_citations must be an array' using errcode = '22023';
  end if;
  if jsonb_typeof(p_citations) = 'array' and jsonb_array_length(p_citations) > 2000 then
    raise exception 'too many citations (max 2000)' using errcode = '22023';
  end if;

  perform set_config('kf.defer_recompute', 'on', true);

  insert into public.proposals (space_id, run_id, author, created_by, title, rationale, risk)
  values (p_space, v_run, v_author, v_created_by, trim(p_title), coalesce(p_rationale, ''), coalesce(p_risk, 'medium'))
  returning * into p;

  for v_item, v_n in select x.value, x.ordinality from jsonb_array_elements(p_ops) with ordinality x order by x.ordinality loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid op %: must be an object', v_i using errcode = '22023';
    end if;
    v_after := case when v_item -> 'after' is null or jsonb_typeof(v_item -> 'after') = 'null' then '{}'::jsonb
                    else v_item -> 'after' end;
    begin
      insert into public.proposal_ops (proposal_id, space_id, ord, op, concept_id, path, new_path, base_revision, after, rationale)
      values (p.id, p_space, v_i, (v_item ->> 'op')::public.proposal_op_kind, (v_item ->> 'concept_id')::uuid,
              v_item ->> 'path', v_item ->> 'new_path', (v_item ->> 'base_revision')::int, v_after, v_item ->> 'rationale')
      returning id into v_id;
    exception
      when invalid_text_representation or numeric_value_out_of_range or not_null_violation or check_violation
        or invalid_datetime_format or datetime_field_overflow then
        raise exception 'invalid op %: %', v_i, sqlerrm using errcode = '22023';
    end;
    v_ids := v_ids || v_id;
    v_i := v_i + 1;
  end loop;

  for v_item, v_n in select x.value, x.ordinality from jsonb_array_elements(coalesce(p_citations, '[]'::jsonb)) with ordinality x
                     order by x.ordinality loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid citation %: must be an object', v_n - 1 using errcode = '22023';
    end if;
    if v_item ? 'op_index' and jsonb_typeof(v_item -> 'op_index') not in ('number', 'null') then
      raise exception 'invalid citation %: op_index must be a number', v_n - 1 using errcode = '22023';
    end if;
    begin
      v_idx := (v_item ->> 'op_index')::int;
      v_kind := coalesce((v_item ->> 'ref_kind')::public.citation_kind,
                         case when coalesce(v_item ->> 'url', '') <> '' then 'url'::public.citation_kind end);
      if v_kind is null then
        raise exception 'ref_kind is required' using errcode = '22023';
      end if;
      if v_idx is not null and (v_idx < 0 or v_idx >= v_i) then
        raise exception 'op_index % out of range', v_idx using errcode = '22023';
      end if;
      insert into public.proposal_citations (proposal_id, space_id, op_id, label, ref_kind, ref_id, url, quote, audience, consulted)
      values (
        p.id, p_space, case when v_idx is null then null else v_ids[v_idx + 1] end,
        coalesce(nullif(trim(v_item ->> 'label'), ''), 'ref-' || v_n::text),
        v_kind, (v_item ->> 'ref_id')::uuid, nullif(v_item ->> 'url', ''), v_item ->> 'quote',
        case when jsonb_typeof(v_item -> 'audience') = 'array'
             then array(select jsonb_array_elements_text(v_item -> 'audience')::uuid) else '{}'::uuid[] end,
        case when jsonb_typeof(v_item -> 'consulted') = 'boolean' then (v_item ->> 'consulted')::boolean else false end
      );
    exception
      when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
        raise exception 'invalid citation %: %', v_n - 1, sqlerrm using errcode = '22023';
    end;
  end loop;

  perform set_config('kf.defer_recompute', v_prev, true);
  perform private.recompute_proposal_access(p.id);
  select * into p from public.proposals where id = p.id;
  return p;
end;
$$;
revoke execute on function public.create_proposal(uuid, text, text, public.proposal_risk, jsonb, jsonb, uuid, text) from public, anon;
grant execute on function public.create_proposal(uuid, text, text, public.proposal_risk, jsonb, jsonb, uuid, text) to authenticated, service_role;

-- proposals and their children are only created through create_proposal() / propose_revert() / the service role
drop policy if exists "proposals: editors create own" on public.proposals;
drop policy if exists "proposal_ops: author adds to own pending proposal" on public.proposal_ops;
drop policy if exists "proposal_citations: author adds to own pending proposal" on public.proposal_citations;
revoke insert on public.proposals, public.proposal_ops, public.proposal_citations from authenticated, anon;

-- ---------------------------------------------------------------------------------------------------------
-- apply_proposal
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.apply_proposal(p_proposal uuid, p_note text default null, p_actor text default null)
returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
  o public.proposal_ops;
  c public.concepts;
  v_service boolean := private.is_service_role();
  v_agent boolean := false;
  v_rank int;
  v_actor text;
  v_uid uuid := (select auth.uid());
  v_space uuid;
  v_conflicts jsonb := '[]'::jsonb;
  v_err text;
  a jsonb;
begin
  select pr.space_id into v_space from public.proposals pr where pr.id = p_proposal;
  if not found then
    raise exception 'proposal not found' using errcode = 'P0002';
  end if;
  if not v_service then
    if v_uid is null then
      raise exception 'not authenticated' using errcode = '28000';
    end if;
    if private.is_oauth_client() then
      raise exception 'OAuth client tokens cannot apply proposals' using errcode = '42501';
    end if;
    v_agent := private.is_agent();
  end if;

  -- one apply at a time per space: revision checks, audience checks and the writes see one consistent state
  perform pg_advisory_xact_lock(hashtextextended('supaknowledge.apply_proposal:' || v_space::text, 0));
  select * into p from public.proposals where id = p_proposal for update;
  if p.status not in ('pending', 'approved') then
    raise exception 'proposal is %', p.status using errcode = '22023';
  end if;

  -- evidence and concept audiences may have changed since the proposal was drafted
  perform private.recompute_proposal_access(p.id);
  select * into p from public.proposals where id = p.id;

  if not v_service then
    v_rank := private.space_rank(p.space_id);
    if v_rank < 3 then
      raise exception 'reviewer role required' using errcode = '42501';
    end if;
    if not private.can_see_proposal(p.id) then
      raise exception 'you cannot see all evidence cited by this proposal' using errcode = '42501';
    end if;
    if p.escalation and v_agent then
      raise exception 'this proposal widens access to restricted knowledge; agents cannot approve it' using errcode = '42501';
    end if;
    if p.escalation and v_rank < 4 then
      raise exception 'this proposal widens access to restricted knowledge; a space admin must approve it' using errcode = '42501';
    end if;
    v_actor := case when v_agent then 'agent:' else 'human:' end || v_uid::text;
  else
    if p.escalation then
      raise exception 'escalations always require human approval' using errcode = '42501';
    end if;
    v_actor := coalesce(nullif(trim(p_actor), ''), 'process:policy');
    if v_actor ~* '^(human|agent):' then
      raise exception 'actor prefixes human: and agent: are reserved' using errcode = '22023';
    end if;
  end if;

  if not exists (select 1 from public.proposal_ops where proposal_id = p.id) then
    raise exception 'proposal has no ops' using errcode = '22023';
  end if;

  -- 1. validate every op first so a conflict leaves nothing half-applied. Path collisions report the same
  --    reason whether or not the colliding concept is visible to the caller.
  for o in select * from public.proposal_ops where proposal_id = p.id order by ord loop
    v_err := private.op_payload_error(o.op, o.path, o.new_path, o.after);
    if v_err is not null then
      v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'invalid op: ' || v_err);
    elsif o.op = 'create' then
      if exists (select 1 from public.concepts k where k.space_id = p.space_id and k.path = o.path)
         or exists (select 1 from public.proposal_ops o2 where o2.proposal_id = p.id and o2.ord < o.ord
                     and ((o2.op = 'create' and o2.path = o.path) or (o2.op = 'move' and o2.new_path = o.path))) then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'path is not available');
      end if;
    else
      select * into c from public.concepts k where k.id = o.concept_id and k.space_id = p.space_id;
      if not found then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'concept not found');
      elsif o.base_revision is not null and c.revision <> o.base_revision then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason',
          format('concept changed since draft (base %s, now %s)', o.base_revision, c.revision));
      elsif o.op = 'move' and (
          exists (select 1 from public.concepts k where k.space_id = p.space_id and k.path = o.new_path)
          or exists (select 1 from public.proposal_ops o2 where o2.proposal_id = p.id and o2.ord < o.ord
                      and ((o2.op = 'create' and o2.path = o.new_path) or (o2.op = 'move' and o2.new_path = o.new_path)))) then
        v_conflicts := v_conflicts || jsonb_build_object('ord', o.ord, 'path', o.path, 'reason', 'path is not available');
      end if;
    end if;
  end loop;

  -- 2. apply (a unique violation despite the checks still ends as `conflicted`, never half-applied)
  if jsonb_array_length(v_conflicts) = 0 then
    begin
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
            case when jsonb_typeof(a -> 'frontmatter') = 'object' then a -> 'frontmatter' else '{}'::jsonb end,
            case when jsonb_typeof(a -> 'tags') = 'array' then array(select jsonb_array_elements_text(a -> 'tags')) else '{}'::text[] end,
            coalesce((a ->> 'status')::public.concept_status, 'stable'),
            a ->> 'superseded_by',
            (a ->> 'stale_after')::timestamptz,
            o.target_audience, 1, v_actor, now()
          ) returning * into c;
          update public.concept_links l set to_concept = c.id
           where l.space_id = p.space_id and l.to_path = c.path and l.to_concept is null;
        elsif o.op = 'update' then
          update public.concepts k set
            kind = coalesce((a ->> 'kind')::public.concept_kind, k.kind),
            type = coalesce(a ->> 'type', k.type),
            title = coalesce(a ->> 'title', k.title),
            description = coalesce(a ->> 'description', k.description),
            body = coalesce(a ->> 'body', k.body),
            frontmatter = case when jsonb_typeof(a -> 'frontmatter') = 'object' then a -> 'frontmatter' else k.frontmatter end,
            tags = case when jsonb_typeof(a -> 'tags') = 'array' then array(select jsonb_array_elements_text(a -> 'tags')) else k.tags end,
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
          -- links written against the old path no longer resolve to this concept; links to the new path do
          update public.concept_links l set to_concept = null
           where l.space_id = p.space_id and l.to_concept = c.id and l.to_path <> o.new_path;
          update public.concept_links l set to_concept = c.id where l.space_id = p.space_id and l.to_path = o.new_path;
        end if;

        insert into public.concept_revisions (concept_id, space_id, revision, path, kind, type, title, description, body,
          frontmatter, tags, status, superseded_by, stale_after, audience, actor, actor_user_id, reason, proposal_id)
        values (c.id, c.space_id, c.revision, c.path, c.kind, c.type, c.title, c.description, c.body, c.frontmatter,
          c.tags, c.status, c.superseded_by, c.stale_after, c.audience, v_actor, case when not v_service then v_uid end,
          coalesce(o.rationale, p.title), p.id);

        -- humans vouch for what they apply (human_reviewed); agents only confirm it (machine_confirmed)
        if not v_service then
          insert into public.verifications (concept_id, space_id, revision, actor, actor_user_id, note)
          values (c.id, c.space_id, c.revision, v_actor, v_uid, p_note);
        end if;

        update public.proposal_ops set concept_id = c.id where id = o.id and concept_id is null;
      end loop;
    exception when unique_violation then
      v_conflicts := jsonb_build_array(jsonb_build_object('reason', 'path is not available'));
    end;
  end if;

  if jsonb_array_length(v_conflicts) > 0 then
    update public.proposals set status = 'conflicted', review_note = v_conflicts::text where id = p.id returning * into p;
    perform private.audit(p.space_id, 'proposal.conflicted', 'proposal', p.id, jsonb_build_object('conflicts', v_conflicts));
    return p;
  end if;

  update public.proposals set
    status = 'applied', applied_at = now(), auto_applied = v_service,
    reviewed_by = case when not v_service then v_uid else reviewed_by end,
    reviewed_at = case when not v_service then now() else reviewed_at end,
    review_note = coalesce(p_note, review_note)
  where id = p.id returning * into p;

  if not v_service then
    insert into public.proposal_reviews (proposal_id, space_id, reviewer, decision, note)
    values (p.id, p.space_id, v_uid, 'approve', p_note);
  end if;

  update public.flags set status = 'resolved', resolved_at = now(), resolved_by = v_uid,
         resolution = coalesce(resolution, 'applied in proposal ' || p.id::text)
   where proposal_id = p.id and status in ('open', 'in_proposal');

  perform private.audit(p.space_id, case when v_service then 'proposal.auto_applied' else 'proposal.applied' end,
                        'proposal', p.id, jsonb_build_object('actor', v_actor));
  return p;
end;
$$;

create or replace function public.reject_proposal(p_proposal uuid, p_note text) returns public.proposals
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
    if private.is_oauth_client() or private.space_rank(p.space_id) < 3 or not private.can_see_proposal(p.id) then
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

-- a reviewer vouches for the current revision (OKF `verified`). Agents record a machine confirmation.
create or replace function public.verify_concept(p_concept uuid, p_note text default null) returns public.verifications
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.concepts;
  v public.verifications;
begin
  select * into c from public.concepts where id = p_concept;
  if not found or (select auth.uid()) is null or private.is_oauth_client()
     or private.space_rank(c.space_id) < 3 or not private.in_audience(c.audience) then
    raise exception 'reviewer role required' using errcode = '42501';
  end if;
  insert into public.verifications (concept_id, space_id, revision, actor, actor_user_id, note)
  values (c.id, c.space_id, c.revision,
          case when private.is_agent() then 'agent:' else 'human:' end || (select auth.uid())::text,
          (select auth.uid()), p_note)
  returning * into v;
  return v;
end;
$$;

-- restore an old revision (content AND audience) as a normal proposal
create or replace function public.propose_revert(p_concept uuid, p_revision int) returns public.proposals
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.concepts;
  r public.concept_revisions;
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
  -- restoring the old audience too: reverting to content that was public into a now-restricted concept widens
  -- it (an escalation for a space admin); reverting to restricted content keeps it restricted.
  return public.create_proposal(
    c.space_id,
    format('Revert %s to revision %s', c.path, p_revision),
    'Manual revert',
    'medium',
    jsonb_build_array(jsonb_build_object(
      'op', 'update', 'concept_id', c.id, 'path', c.path, 'base_revision', c.revision,
      'after', jsonb_build_object('kind', r.kind, 'type', r.type, 'title', r.title, 'description', r.description,
                                  'body', r.body, 'frontmatter', r.frontmatter, 'tags', to_jsonb(r.tags), 'status', r.status,
                                  'superseded_by', r.superseded_by, 'stale_after', r.stale_after,
                                  'audience', to_jsonb(r.audience)))),
    jsonb_build_array(jsonb_build_object('label', format('revision-%s', p_revision), 'ref_kind', 'concept',
                                         'audience', to_jsonb(r.audience)))
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- flags never attach to a concept their audience cannot see: a flag about a restricted concept takes the
-- intersection of both audiences; when they are disjoint the concept is dropped (kept as a path guess only).
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.flag_concept_audience() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_aud uuid[];
begin
  if new.concept_id is null then
    return new;
  end if;
  select c.audience into v_aud from public.concepts c where c.id = new.concept_id and c.space_id = new.space_id;
  if not found then
    new.concept_id := null;
  elsif coalesce(cardinality(v_aud), 0) = 0 then
    null;
  elsif coalesce(cardinality(new.audience), 0) = 0 then
    new.audience := v_aud;
  elsif not (new.audience <@ v_aud) then
    if new.audience && v_aud then
      new.audience := array(select g from unnest(new.audience) g where g = any (v_aud));
    else
      new.concept_id := null;
    end if;
  end if;
  return new;
end;
$$;
create or replace trigger flags_concept_audience before insert or update of concept_id, audience on public.flags
  for each row execute function private.flag_concept_audience();

do $$
declare
  f text;
begin
  foreach f in array array['private.op_payload_error(public.proposal_op_kind, text, text, jsonb)', 'private.proposal_op_defaults()',
                           'private.proposal_citation_defaults()', 'private.proposal_citation_audiences(uuid)',
                           'private.recompute_proposal_access(uuid)', 'private.on_proposal_child_change()',
                           'private.flag_concept_audience()', 'private.on_evidence_audience_changed()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
