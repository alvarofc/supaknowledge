-- Supaknowledge: review fixes, part 5 — settings safety and the curator run lifecycle.
--
--   * Safe settings readers (private.setting_bool / private.setting_int): a malformed value in ONE space can no
--     longer abort the global cron jobs or flag_knowledge(). spaces.settings is validated on write (types of the
--     keys the platform reads; unknown keys are kept for forward compatibility).
--   * sources.sync_interval is bounded (5 minutes .. 365 days) and upload sources are never scheduled.
--   * One active curator run per space, enforced by a partial unique index (no duplicate concurrent runs).
--   * Watermarks ignore staleness sweeps (they never read documents), so documents changed before a sweep are
--     still picked up by the next normal run. Staleness sweeps respect curator.enabled.
--   * Flag threshold: fixed branch slip (only `missing` flags count space-wide) + per-space cooldown
--     (curator.flag_cooldown_minutes, default 60) so a misbehaving agent cannot trigger runs continuously.
--   * kf_finish_task / kf_maybe_finish_run: atomic task/run completion (a run fails if ANY task failed).
--   * cancel_curator_run(): reviewers can stop a run; util.reap_curator_runs() (cron) fails runs/tasks that made
--     no progress for curator.stuck_after_minutes (default 30) and closes runs whose tasks are all done.
--   * Traces are re-curated when new events arrive or their outcome changes (curated_at is reset).
--   * kf_trace_events(): all events of a batch of traces in one call (no PostgREST max_rows truncation).
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- safe settings
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.setting_bool(p_settings jsonb, p_path text[], p_default boolean) returns boolean
language sql immutable as $$
  select case when jsonb_typeof(p_settings #> p_path) = 'boolean' then (p_settings #>> p_path)::boolean else p_default end;
$$;

create or replace function private.setting_int(p_settings jsonb, p_path text[], p_default int, p_min int, p_max int) returns int
language sql immutable as $$
  select case
    when jsonb_typeof(p_settings #> p_path) = 'number' and (p_settings #>> p_path) ~ '^-?[0-9]+(\.0+)?$'
      then greatest(p_min::numeric, least(p_max::numeric, (p_settings #>> p_path)::numeric))::int
    else p_default
  end;
$$;

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
  foreach k in array array['curator', 'auto_apply', 'staleness', 'embeddings', 'retention'] loop
    if s ? k and jsonb_typeof(s -> k) <> 'object' then
      raise exception 'settings.% must be an object', k using errcode = '22023';
    end if;
  end loop;
  -- (path, type, min, max)
  for spec in select * from (values
      ('{curator,enabled}', 'boolean', null, null),
      ('{curator,flag_threshold}', 'integer', 0, 1000000),
      ('{curator,flag_cooldown_minutes}', 'integer', 0, 10080),
      ('{curator,stuck_after_minutes}', 'integer', 5, 1440),
      ('{curator,model}', 'string', null, null),
      ('{curator,fast_model}', 'string', null, null),
      ('{curator,fallback_models}', 'string[]', null, null),
      ('{curator,max_research_steps}', 'integer', 1, 20),
      ('{curator,max_clusters_per_run}', 'integer', 1, 200),
      ('{curator,max_traces_per_run}', 'integer', 0, 5000),
      ('{curator,instructions}', 'string', null, null),
      ('{auto_apply,enabled}', 'boolean', null, null),
      ('{auto_apply,max_risk}', 'enum:low,medium', null, null),
      ('{auto_apply,kinds}', 'enum[]:skill,domain,data_access', null, null),
      ('{auto_apply,require_observed_evidence}', 'boolean', null, null),
      ('{auto_apply,allow_create}', 'boolean', null, null),
      ('{staleness,data_access_days}', 'integer', 0, 36500),
      ('{embeddings,provider}', 'enum:gte-small', null, null),
      ('{retention,trace_days}', 'integer?', 1, 36500),
      ('{retention,usage_days}', 'integer?', 1, 36500)
    ) as x(path, typ, lo, hi)
  loop
    v := s #> spec.path::text[];
    continue when v is null;
    if spec.typ = 'boolean' and jsonb_typeof(v) <> 'boolean'
       or spec.typ = 'string' and jsonb_typeof(v) <> 'string'
       or spec.typ = 'string[]' and (jsonb_typeof(v) <> 'array'
                                     or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string'))
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
          || case when spec.lo is not null then format(' between %s and %s', spec.lo, spec.hi) else '' end
        using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function private.validate_space_settings() from public, anon, authenticated;
create or replace trigger spaces_validate_settings before insert or update of settings on public.spaces
  for each row execute function private.validate_space_settings();

-- ---------------------------------------------------------------------------------------------------------
-- sources: bounded sync interval; uploads are never scheduled
-- ---------------------------------------------------------------------------------------------------------
update public.sources set sync_interval = greatest(interval '5 minutes', least(interval '365 days', sync_interval))
 where sync_interval < interval '5 minutes' or sync_interval > interval '365 days';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sources_sync_interval_check' and conrelid = 'public.sources'::regclass) then
    alter table public.sources add constraint sources_sync_interval_check
      check (sync_interval >= interval '5 minutes' and sync_interval <= interval '365 days');
  end if;
end $$;

create or replace function util.enqueue_due_sources() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  s record;
begin
  for s in
    select id, space_id from public.sources
    where status = 'active'
      and connector <> 'upload'
      and (last_synced_at is null or last_synced_at < now() - sync_interval)
      and (sync_requested_at is null or sync_requested_at < now() - interval '30 minutes')
    for update skip locked
  loop
    perform pgmq.send('kf_ingest', jsonb_build_object('source_id', s.id, 'space_id', s.space_id));
    update public.sources set sync_requested_at = now() where id = s.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function util.enqueue_due_sources() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- one active run per space
-- ---------------------------------------------------------------------------------------------------------
-- (existing duplicates, if any, are closed before the index is created)
update public.curator_runs r set status = 'failed', error = 'superseded: duplicate active run', finished_at = now()
 where r.status in ('queued', 'running')
   and exists (select 1 from public.curator_runs r2 where r2.space_id = r.space_id and r2.status in ('queued', 'running')
                and (r2.created_at, r2.id) > (r.created_at, r.id));
create unique index if not exists curator_runs_one_active on public.curator_runs (space_id) where status in ('queued', 'running');

-- watermark = end of the last successful NON-staleness run
create or replace function private.curator_watermark(p_space uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select coalesce(max(r.until), '-infinity'::timestamptz) from public.curator_runs r
   where r.space_id = p_space and r.status = 'succeeded' and r.trigger <> 'staleness';
$$;

create or replace function private.start_curator_run(p_space uuid, p_trigger text, p_requested_by uuid default null)
returns public.curator_runs
language plpgsql security definer set search_path = '' as $$
declare
  r public.curator_runs;
  t public.curator_tasks;
begin
  insert into public.curator_runs (space_id, trigger, requested_by, since, until)
  values (p_space, p_trigger, p_requested_by,
          private.curator_watermark(p_space), now())
  on conflict (space_id) where status in ('queued', 'running') do nothing
  returning * into r;
  if r.id is null then
    -- a run is already active (or being created concurrently): return it
    select * into r from public.curator_runs where space_id = p_space and status in ('queued', 'running')
     order by created_at desc limit 1;
    return r;
  end if;

  insert into public.curator_tasks (run_id, space_id, step, input)
  values (r.id, p_space, case when p_trigger = 'staleness' then 'sweep' else 'gather' end, '{}')
  returning * into t;

  perform pgmq.send('kf_curator', jsonb_build_object('task_id', t.id, 'run_id', r.id, 'space_id', p_space));
  return r;
end;
$$;
revoke execute on function private.start_curator_run(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.request_curator_run(p_space uuid, p_trigger text default 'manual') returns public.curator_runs
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_service_role() and (private.is_oauth_client() or private.space_rank(p_space) < 3) then
    raise exception 'reviewer role required' using errcode = '42501';
  end if;
  return private.start_curator_run(p_space, case when private.is_service_role() then p_trigger else 'manual' end, (select auth.uid()));
end;
$$;
revoke execute on function public.request_curator_run(uuid, text) from public, anon;
grant execute on function public.request_curator_run(uuid, text) to authenticated, service_role;

-- follow-up tasks are only enqueued while the run is active (returns null otherwise)
create or replace function public.kf_enqueue_curator_task(p_run uuid, p_step text, p_input jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.curator_tasks;
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  insert into public.curator_tasks (run_id, space_id, step, input)
  select r.id, r.space_id, p_step, coalesce(p_input, '{}') from public.curator_runs r
   where r.id = p_run and r.status in ('queued', 'running')
  returning * into t;
  if t.id is null then
    return null;
  end if;
  perform pgmq.send('kf_curator', jsonb_build_object('task_id', t.id, 'run_id', t.run_id, 'space_id', t.space_id));
  return t.id;
end;
$$;
revoke execute on function public.kf_enqueue_curator_task(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.kf_enqueue_curator_task(uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- run completion
-- ---------------------------------------------------------------------------------------------------------
-- internal: decide a run's final state. Caller holds the run row lock.
create or replace function private.finish_run_if_done(p_run uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.curator_runs;
  v_failed int;
  v_error text;
begin
  select * into r from public.curator_runs where id = p_run;
  if not found then return null; end if;
  if r.status not in ('queued', 'running') then return r.status::text; end if;
  if exists (select 1 from public.curator_tasks t where t.run_id = p_run and t.status in ('queued', 'running')) then
    return 'running';
  end if;
  select count(*), string_agg(coalesce(t.step || ': ' || t.error, t.step), '; ' order by t.finished_at)
    into v_failed, v_error
    from public.curator_tasks t where t.run_id = p_run and t.status in ('failed', 'cancelled');
  update public.curator_runs
     set status = case when v_failed > 0 then 'failed'::public.run_status else 'succeeded'::public.run_status end,
         error = case when v_failed > 0 then left(format('%s task(s) did not succeed: %s', v_failed, v_error), 4000) else error end,
         started_at = coalesce(started_at, now()),
         finished_at = now()
   where id = p_run
  returning * into r;
  return r.status::text;
end;
$$;
revoke execute on function private.finish_run_if_done(uuid) from public, anon, authenticated;

-- service role: close a run if all of its tasks are done. failed if ANY task failed; 'running' while tasks remain.
create or replace function public.kf_maybe_finish_run(p_run uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  perform 1 from public.curator_runs where id = p_run for update;
  return private.finish_run_if_done(p_run);
end;
$$;

-- service role: record a task's final state and close its run when it was the last one. Locks the run first so
-- two tasks finishing at the same time cannot both conclude "another task is still running".
-- p_status: succeeded | failed | cancelled. Returns the run status ('running' while tasks remain).
create or replace function public.kf_finish_task(p_task uuid, p_status text, p_output jsonb default null, p_error text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid;
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'p_status must be succeeded, failed or cancelled' using errcode = '22023';
  end if;
  select t.run_id into v_run from public.curator_tasks t where t.id = p_task;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  perform 1 from public.curator_runs where id = v_run for update;
  update public.curator_tasks t
     set status = p_status::public.run_status,
         output = coalesce(p_output, t.output),
         error = case when p_status = 'succeeded' then null else coalesce(p_error, t.error) end,
         finished_at = now()
   where t.id = p_task and t.status in ('queued', 'running');
  return private.finish_run_if_done(v_run);
end;
$$;

revoke execute on function public.kf_maybe_finish_run(uuid) from public, anon, authenticated;
revoke execute on function public.kf_finish_task(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.kf_maybe_finish_run(uuid) to service_role;
grant execute on function public.kf_finish_task(uuid, text, jsonb, text) to service_role;

-- reviewers (not OAuth tokens) stop a run; queued/running tasks are cancelled and the worker skips them
create or replace function public.cancel_curator_run(p_run uuid) returns public.curator_runs
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.curator_runs;
begin
  select * into r from public.curator_runs where id = p_run for update;
  if not found or (not private.is_service_role()
                   and (private.is_oauth_client() or private.space_rank(r.space_id) < 3)) then
    raise exception 'reviewer role required' using errcode = '42501';
  end if;
  if r.status not in ('queued', 'running') then
    return r;
  end if;
  update public.curator_tasks set status = 'cancelled', finished_at = now(), error = coalesce(error, 'run cancelled')
   where run_id = p_run and status in ('queued', 'running');
  update public.curator_runs set status = 'cancelled', finished_at = now(),
         error = 'cancelled by ' || coalesce('user:' || (select auth.uid())::text, 'system')
   where id = p_run returning * into r;
  perform private.audit(r.space_id, 'curator_run.cancelled', 'curator_run', r.id);
  return r;
end;
$$;
revoke execute on function public.cancel_curator_run(uuid) from public, anon;
grant execute on function public.cancel_curator_run(uuid) to authenticated, service_role;

-- cron: fail runs/tasks without progress for stuck_after_minutes; close runs whose tasks are all done
create or replace function util.reap_curator_runs() returns int
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
  v_status text;
begin
  for r in
    select cr.id, cr.created_at, cr.started_at,
           private.setting_int(s.settings, '{curator,stuck_after_minutes}', 30, 5, 1440) as stuck_after,
           (select max(greatest(t.created_at, t.finished_at)) from public.curator_tasks t where t.run_id = cr.id) as last_task
    from public.curator_runs cr join public.spaces s on s.id = cr.space_id
    where cr.status in ('queued', 'running')
    for update of cr skip locked
  loop
    if greatest(r.created_at, r.started_at, r.last_task) < now() - make_interval(mins => r.stuck_after) then
      update public.curator_tasks set status = 'failed', finished_at = now(),
             error = coalesce(error || '; ', '') || format('reaped: no progress for %s minutes', r.stuck_after)
       where run_id = r.id and status in ('queued', 'running');
    end if;
    v_status := private.finish_run_if_done(r.id);
    if v_status is distinct from 'running' then n := n + 1; end if;
  end loop;
  return n;
end;
$$;
revoke execute on function util.reap_curator_runs() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- flag threshold (safe settings, missing-only branch, cooldown)
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.on_flag_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_settings jsonb := private.space_settings(new.space_id);
  v_threshold int := private.setting_int(v_settings, '{curator,flag_threshold}', 3, 0, 1000000);
  v_cooldown int := private.setting_int(v_settings, '{curator,flag_cooldown_minutes}', 60, 0, 10080);
  v_count int;
begin
  if not private.setting_bool(v_settings, '{curator,enabled}', true) or v_threshold <= 0 then return null; end if;
  if new.concept_id is null and new.kind <> 'missing' then return null; end if;
  select count(*) into v_count from public.flags f
   where f.space_id = new.space_id and f.status = 'open'
     and ((new.concept_id is not null and f.concept_id = new.concept_id)
          or (new.concept_id is null and f.concept_id is null and f.kind = 'missing'));
  if v_count < v_threshold then return null; end if;
  if v_cooldown > 0 and exists (select 1 from public.curator_runs r
                                 where r.space_id = new.space_id and r.trigger = 'flag_threshold'
                                   and r.created_at > now() - make_interval(mins => v_cooldown)) then
    return null;
  end if;
  perform private.start_curator_run(new.space_id, 'flag_threshold');
  return null;
end;
$$;

create or replace function util.schedule_nightly_curator() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  s record;
begin
  for s in select id, settings from public.spaces loop
    continue when not private.setting_bool(s.settings, '{curator,enabled}', true);
    -- only when there is something to learn from
    if exists (select 1 from public.flags f where f.space_id = s.id and f.status = 'open')
       or exists (select 1 from public.traces t where t.space_id = s.id and t.curated_at is null)
       or exists (select 1 from public.source_documents d where d.space_id = s.id and d.changed_at > private.curator_watermark(s.id))
    then
      perform private.start_curator_run(s.id, 'cron');
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

create or replace function util.schedule_staleness_sweep() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  s record;
begin
  for s in select sp.id from public.spaces sp
            where private.setting_bool(sp.settings, '{curator,enabled}', true)
              and exists (select 1 from public.concepts c where c.space_id = sp.id
                           and c.status = 'stable' and c.stale_after is not null and c.stale_after < now()) loop
    perform private.start_curator_run(s.id, 'staleness');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function util.schedule_nightly_curator() from public, anon, authenticated;
revoke execute on function util.schedule_staleness_sweep() from public, anon, authenticated;
revoke execute on function private.curator_watermark(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- re-curation: new events or a changed outcome make a trace "uncurated" again
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.on_trace_events_inserted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.traces t set curated_at = null
   where t.curated_at is not null and t.id in (select distinct n.trace_id from new_events n);
  return null;
end;
$$;
revoke execute on function private.on_trace_events_inserted() from public, anon, authenticated;
create or replace trigger trace_events_recurate after insert on public.trace_events
  referencing new table as new_events
  for each statement execute function private.on_trace_events_inserted();

create or replace function private.on_trace_outcome_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.curated_at := null;
  return new;
end;
$$;
revoke execute on function private.on_trace_outcome_changed() from public, anon, authenticated;
create or replace trigger traces_recurate before update of outcome on public.traces
  for each row when (old.outcome is distinct from new.outcome)
  execute function private.on_trace_outcome_changed();

-- ---------------------------------------------------------------------------------------------------------
-- kf_trace_events: events of up to 200 traces as ONE jsonb array (so PostgREST max_rows never truncates it),
-- ordered by trace then seq. Per trace at most p_max_per_trace events: the first and last halves are kept
-- (task setup at the start, corrections and outcome at the end).
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.kf_trace_events(p_trace_ids uuid[], p_max_per_trace int default 2000) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cap int := greatest(2, least(coalesce(p_max_per_trace, 2000), 20000));
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  if coalesce(cardinality(p_trace_ids), 0) > 200 then
    raise exception 'at most 200 traces per call' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'trace_id', e.trace_id, 'seq', e.seq, 'role', e.role, 'content', e.content, 'tool_name', e.tool_name,
             'tool_input', e.tool_input, 'tool_output', e.tool_output, 'is_error', e.is_error,
             'metadata', e.metadata, 'at', e.at) order by e.trace_id, e.seq)
    from (
      select te.*, row_number() over (partition by te.trace_id order by te.seq) as rn_first,
             row_number() over (partition by te.trace_id order by te.seq desc) as rn_last
      from public.trace_events te
      where te.trace_id = any (p_trace_ids)
    ) e
    where e.rn_first <= v_cap / 2 or e.rn_last <= v_cap - v_cap / 2
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.kf_trace_events(uuid[], int) from public, anon, authenticated;
grant execute on function public.kf_trace_events(uuid[], int) to service_role;
