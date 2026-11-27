-- Supaknowledge: the `schema` connector and schema drift flags
--
-- A `schema` source reads the schema of an application database (through the Supabase Management API) into
-- source documents. When a sync sees the schema change, the connectors function computes which data-access
-- concepts still refer to a dropped, renamed or changed identifier (packages/core/src/schema.ts) and records one
-- flag per concept and identifier through kf_record_schema_drift(). The curator then drafts the fixes.

alter type public.connector_kind add value if not exists 'schema';

-- one live drift flag per concept and changed identifier. Only system flags (no author) count, so a flag someone
-- raises by hand with the same evidence never blocks or collides with one.
create unique index if not exists flags_schema_drift_live
  on public.flags (concept_id, (evidence #>> '{schema_drift,key}'))
  where created_by is null and status in ('open', 'in_proposal') and evidence ? 'schema_drift';

-- p_flags: [{ concept_id, key, observation, suggested_fix?, kind?, document?, change? }] as computed by
-- driftFlags(). Returns the number of flags opened (duplicates of a live drift flag are skipped).
create or replace function public.kf_record_schema_drift(p_source uuid, p_flags jsonb) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.sources;
  f jsonb;
  c public.concepts;
  v_key text;
  v_obs text;
  v_doc uuid;
  v_audience uuid[];
  v_rows int;
  v_n int := 0;
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  select * into s from public.sources where id = p_source;
  if not found then
    raise exception 'source not found' using errcode = 'P0002';
  end if;
  if s.connector::text <> 'schema' then
    raise exception 'not a schema source' using errcode = '22023';
  end if;
  if jsonb_typeof(p_flags) is distinct from 'array' then
    raise exception 'p_flags must be a JSON array' using errcode = '22023';
  end if;

  for f in select value from jsonb_array_elements(p_flags) loop
    v_key := nullif(trim(f ->> 'key'), '');
    v_obs := nullif(trim(f ->> 'observation'), '');
    continue when v_key is null or v_obs is null or jsonb_typeof(f) <> 'object'
      or coalesce(f ->> 'concept_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    -- only data-access concepts of the source's own space
    select * into c from public.concepts
     where id = (f ->> 'concept_id')::uuid and space_id = s.space_id and kind = 'data_access' and status <> 'deprecated';
    continue when not found;

    -- The observation names schema identifiers, which only the source's audience may read. The flag gets the
    -- narrower of the two audiences; when both are restricted and share no group, no flag can be shown safely.
    if cardinality(s.audience) = 0 then
      v_audience := c.audience;
    elsif cardinality(c.audience) = 0 then
      v_audience := s.audience;
    else
      v_audience := array(select g from unnest(c.audience) g where g = any (s.audience) order by g);
      continue when cardinality(v_audience) = 0;
    end if;

    -- the cited schema document must belong to this source
    select d.id into v_doc from public.source_documents d
     where d.source_id = s.id and d.external_id = f ->> 'document' and d.deleted_at is null;

    insert into public.flags (space_id, created_by, kind, concept_id, concept_path, observation, suggested_fix, evidence, audience)
    values (
      s.space_id, null,
      case when f ->> 'kind' = 'incorrect' then 'incorrect' else 'outdated' end::public.flag_kind,
      c.id, c.path, left(v_obs, 2000), left(nullif(trim(f ->> 'suggested_fix'), ''), 2000),
      jsonb_build_object('schema_drift', jsonb_build_object(
        'key', left(v_key, 500),
        'source_id', s.id,
        'document_id', v_doc,
        'document', f ->> 'document',
        'change', case when jsonb_typeof(f -> 'change') = 'object' then f -> 'change' else '{}'::jsonb end)),
      v_audience
    )
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;

  -- catch it before an agent does: start a curator run now instead of waiting for the nightly one
  if v_n > 0 and coalesce((private.space_settings(s.space_id) #>> '{curator,enabled}')::boolean, true) then
    perform private.start_curator_run(s.space_id, 'schema_drift');
  end if;
  return v_n;
end;
$$;
revoke execute on function public.kf_record_schema_drift(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kf_record_schema_drift(uuid, jsonb) to service_role;
