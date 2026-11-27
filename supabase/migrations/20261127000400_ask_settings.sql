-- Studio "Ask" page: a space setting that turns off sending Ask conversations to the curator as traces.
-- Same validator as 20261125000022_round2_functions.sql plus the `ask` section and `ask.record_traces`
-- (packages/core/src/settings.ts; packages/core/test/settings-db.test.ts keeps the two in sync).
create or replace function private.validate_space_settings() returns trigger
language plpgsql set search_path = '' as $$
declare
  s jsonb := new.settings;
  k text;
  v jsonb;
  spec record;
begin
  if s is null or jsonb_typeof(s) <> 'object' then
    raise exception 'settings must be a JSON object' using errcode = '22023';
  end if;
  foreach k in array array['curator', 'auto_apply', 'staleness', 'embeddings', 'retention', 'ask'] loop
    if s ? k and jsonb_typeof(s -> k) <> 'object' then
      raise exception 'settings.% must be an object', k using errcode = '22023';
    end if;
  end loop;
  -- (path, type, min, max)
  for spec in select * from (values
      ('{curator,enabled}', 'boolean', null, null),
      ('{curator,flag_threshold}', 'integer', 0, 1000000),
      ('{curator,flag_cooldown_minutes}', 'integer', 0, 10080),
      ('{curator,stuck_after_minutes}', 'integer', 10, 1440),
      ('{curator,model}', 'string', 0, 200),
      ('{curator,fast_model}', 'string', 0, 200),
      ('{curator,fallback_models}', 'string[]', 0, 5),
      ('{curator,max_research_steps}', 'integer', 1, 20),
      ('{curator,max_clusters_per_run}', 'integer', 1, 200),
      ('{curator,max_traces_per_run}', 'integer', 0, 5000),
      ('{curator,max_tokens_per_run}', 'integer', 0, 2000000000),
      ('{curator,research_scope}', 'enum:target_audience,all', null, null),
      ('{curator,auto_dismiss_flags}', 'boolean', null, null),
      ('{curator,instructions}', 'string', 0, 8000),
      ('{auto_apply,enabled}', 'boolean', null, null),
      ('{auto_apply,max_risk}', 'enum:low,medium', null, null),
      ('{auto_apply,kinds}', 'enum[]:skill,domain,data_access', null, null),
      ('{auto_apply,require_observed_evidence}', 'boolean', null, null),
      ('{auto_apply,allow_create}', 'boolean', null, null),
      ('{auto_apply,untrusted_source_kinds}', 'enum[]:notion,slack,github,gdrive,web,upload', null, null),
      ('{staleness,data_access_days}', 'integer', 0, 36500),
      ('{embeddings,provider}', 'enum:gte-small', null, null),
      ('{retention,trace_days}', 'integer?', 1, 36500),
      ('{retention,usage_days}', 'integer?', 1, 36500),
      ('{ask,record_traces}', 'boolean', null, null)
    ) as x(path, typ, lo, hi)
  loop
    v := s #> spec.path::text[];
    continue when v is null;
    if spec.typ = 'boolean' and jsonb_typeof(v) <> 'boolean'
       or spec.typ = 'string' and (jsonb_typeof(v) <> 'string'
                                   or (spec.hi is not null and length(v #>> '{}') > spec.hi))
       or spec.typ = 'string[]' and (jsonb_typeof(v) <> 'array'
                                     or (spec.hi is not null and jsonb_array_length(v) > spec.hi)
                                     or exists (select 1 from jsonb_array_elements(v) e
                                                 where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 200))
       or spec.typ in ('integer', 'integer?') and not (
            (spec.typ = 'integer?' and jsonb_typeof(v) = 'null')
            or (jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]+(\.0+)?$'
                and (v #>> '{}')::numeric between spec.lo and spec.hi))
       or spec.typ like 'enum:%' and (jsonb_typeof(v) <> 'string'
                                      or not ((v #>> '{}') = any (string_to_array(substr(spec.typ, 6), ','))))
       or spec.typ like 'enum[]:%' and (jsonb_typeof(v) <> 'array'
                                        or exists (select 1 from jsonb_array_elements(v) e
                                                    where jsonb_typeof(e) <> 'string'
                                                       or not ((e #>> '{}') = any (string_to_array(substr(spec.typ, 8), ',')))))
    then
      raise exception 'invalid settings.%: expected %', array_to_string(spec.path::text[], '.'),
        replace(replace(replace(spec.typ, 'integer?', 'integer or null'), 'enum[]:', 'a list of '), 'enum:', 'one of ')
          || case
               when spec.typ = 'string' and spec.hi is not null then format(' of at most %s characters', spec.hi)
               when spec.typ = 'string[]' and spec.hi is not null then format(' of at most %s items (each at most 200 characters)', spec.hi)
               when spec.lo is not null then format(' between %s and %s', spec.lo, spec.hi)
               else '' end
        using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function private.validate_space_settings() from public, anon, authenticated;
