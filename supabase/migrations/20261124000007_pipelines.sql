-- Supaknowledge: background pipelines (Supabase Queues + Cron + pg_net + Vault)
--
--   queue           producer                                   consumer (Edge Function)
--   kf_embed        concept / source_document triggers         embed       (chunk, gte-small, links)
--   kf_ingest       cron: sources due for sync                 connectors  (Notion, Slack, GitHub, Drive, web)
--   kf_curator      cron nightly, flag threshold, manual        curator     (one task per message)
--
-- Cron calls Edge Functions with an internal shared secret read from Vault ("kf_internal_secret"). The
-- functions compare it against their KF_INTERNAL_SECRET env var. Local setup: see supabase/seed.sql.

-- (guarded so re-applying the file does not fail on existing queues)
select pgmq.create(q.name) from unnest(array['kf_embed', 'kf_ingest', 'kf_curator']) as q(name)
 where not exists (select 1 from pgmq.meta m where m.queue_name = q.name);

-- ---------------------------------------------------------------------------------------------------------
-- plumbing
-- ---------------------------------------------------------------------------------------------------------
create function util.secret(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;
revoke execute on function util.secret(text) from public, anon, authenticated;

create function util.invoke_edge_function(p_name text, p_body jsonb, p_timeout_ms int default 150000)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := util.secret('project_url');
  v_secret text := util.secret('kf_internal_secret');
begin
  if v_url is null or v_secret is null then
    raise log 'supaknowledge: vault secrets project_url / kf_internal_secret missing; skipping %', p_name;
    return null;
  end if;
  return net.http_post(
    url := v_url || '/functions/v1/' || p_name,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kf-internal', v_secret),
    body := p_body,
    timeout_milliseconds := p_timeout_ms
  );
end;
$$;
revoke execute on function util.invoke_edge_function(text, jsonb, int) from public, anon, authenticated;

-- read up to batch_size * max_batches messages and fan them out to the function, batch_size per request.
-- Messages stay invisible for `vt` seconds; the function deletes them on success, so failures retry.
create function util.process_queue(p_queue text, p_function text, p_batch_size int, p_max_batches int, p_vt int)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_batches int := 0;
  b jsonb;
begin
  if util.secret('project_url') is null then
    return 0;
  end if;
  for b in
    with msgs as (
      select m.msg_id, m.read_ct, m.message
      from pgmq.read(queue_name => p_queue, vt => p_vt, qty => p_batch_size * p_max_batches) m
    ), numbered as (
      select *, (row_number() over (order by msg_id) - 1) / p_batch_size as grp from msgs
    )
    select jsonb_build_object('queue', p_queue,
             'jobs', jsonb_agg(jsonb_build_object('msg_id', msg_id, 'read_ct', read_ct, 'message', message)))
    from numbered group by grp
  loop
    perform util.invoke_edge_function(p_function, b, p_vt * 1000);
    v_batches := v_batches + 1;
  end loop;
  return v_batches;
end;
$$;
revoke execute on function util.process_queue(text, text, int, int, int) from public, anon, authenticated;

-- Edge Functions ack/requeue through PostgREST with the service role (util is not exposed)
create function public.kf_queue_ack(p_queue text, p_msg_ids bigint[]) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  id bigint;
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  if p_queue not in ('kf_embed', 'kf_ingest', 'kf_curator') then raise exception 'unknown queue'; end if;
  foreach id in array p_msg_ids loop
    if pgmq.delete(p_queue, id) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

create function public.kf_queue_send(p_queue text, p_messages jsonb[], p_delay int default 0) returns bigint[]
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  if p_queue not in ('kf_embed', 'kf_ingest', 'kf_curator') then raise exception 'unknown queue'; end if;
  return array(select pgmq.send_batch(p_queue, p_messages, p_delay));
end;
$$;

-- dead-letter: archive after too many attempts so a poison message does not loop forever
create function public.kf_queue_archive(p_queue text, p_msg_ids bigint[]) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  id bigint;
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  if p_queue not in ('kf_embed', 'kf_ingest', 'kf_curator') then raise exception 'unknown queue'; end if;
  foreach id in array p_msg_ids loop
    if pgmq.archive(p_queue, id) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

revoke execute on function public.kf_queue_ack(text, bigint[]) from public, anon, authenticated;
revoke execute on function public.kf_queue_send(text, jsonb[], int) from public, anon, authenticated;
revoke execute on function public.kf_queue_archive(text, bigint[]) from public, anon, authenticated;
grant execute on function public.kf_queue_ack(text, bigint[]) to service_role;
grant execute on function public.kf_queue_send(text, jsonb[], int) to service_role;
grant execute on function public.kf_queue_archive(text, bigint[]) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- embeddings: enqueue on change (automatic embeddings pattern)
-- ---------------------------------------------------------------------------------------------------------
create function private.enqueue_embed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pgmq.send('kf_embed', jsonb_build_object('table', tg_table_name, 'id', new.id));
  return null;
end;
$$;

create trigger concepts_embed_insert after insert on public.concepts
  for each row execute function private.enqueue_embed();
create trigger concepts_embed_update after update of title, description, body, path, revision on public.concepts
  for each row when (old.revision is distinct from new.revision or old.body is distinct from new.body or old.path is distinct from new.path)
  execute function private.enqueue_embed();

create trigger source_documents_embed_insert after insert on public.source_documents
  for each row execute function private.enqueue_embed();
create trigger source_documents_embed_update after update of content_hash on public.source_documents
  for each row when (old.content_hash is distinct from new.content_hash)
  execute function private.enqueue_embed();

-- keep changed_at as the curator watermark
create function private.touch_changed_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.content_hash is distinct from old.content_hash or new.deleted_at is distinct from old.deleted_at then
    new.changed_at := now();
  end if;
  return new;
end;
$$;
create trigger source_documents_changed before update on public.source_documents
  for each row execute function private.touch_changed_at();

-- ---------------------------------------------------------------------------------------------------------
-- ingestion
-- ---------------------------------------------------------------------------------------------------------
alter table public.sources add column sync_requested_at timestamptz;

create function util.enqueue_due_sources() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  s record;
begin
  for s in
    select id, space_id from public.sources
    where status = 'active'
      and (last_synced_at is null or last_synced_at + sync_interval < now())
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

create function public.request_source_sync(p_source uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.sources;
begin
  select * into s from public.sources where id = p_source;
  if not found or (not private.is_service_role() and (private.space_rank(s.space_id) < 4 or not private.in_audience(s.audience))) then
    raise exception 'space admin required' using errcode = '42501';
  end if;
  perform pgmq.send('kf_ingest', jsonb_build_object('source_id', s.id, 'space_id', s.space_id, 'full', true));
  update public.sources set sync_requested_at = now() where id = s.id;
end;
$$;
revoke execute on function public.request_source_sync(uuid) from public, anon;
grant execute on function public.request_source_sync(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- curator
-- ---------------------------------------------------------------------------------------------------------
create function private.start_curator_run(p_space uuid, p_trigger text, p_requested_by uuid default null)
returns public.curator_runs
language plpgsql security definer set search_path = '' as $$
declare
  r public.curator_runs;
  t public.curator_tasks;
  v_since timestamptz;
begin
  -- one active run per space
  select * into r from public.curator_runs where space_id = p_space and status in ('queued', 'running')
   order by created_at desc limit 1;
  if found then return r; end if;

  select coalesce(max(until), '-infinity'::timestamptz) into v_since
    from public.curator_runs where space_id = p_space and status = 'succeeded';

  insert into public.curator_runs (space_id, trigger, requested_by, since, until)
  values (p_space, p_trigger, p_requested_by, v_since, now()) returning * into r;

  insert into public.curator_tasks (run_id, space_id, step, input)
  values (r.id, p_space, case when p_trigger = 'staleness' then 'sweep' else 'gather' end, '{}')
  returning * into t;

  perform pgmq.send('kf_curator', jsonb_build_object('task_id', t.id, 'run_id', r.id, 'space_id', p_space));
  return r;
end;
$$;
revoke execute on function private.start_curator_run(uuid, text, uuid) from public, anon, authenticated;

create function public.request_curator_run(p_space uuid, p_trigger text default 'manual') returns public.curator_runs
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_service_role() and private.space_rank(p_space) < 3 then
    raise exception 'reviewer role required' using errcode = '42501';
  end if;
  return private.start_curator_run(p_space, case when private.is_service_role() then p_trigger else 'manual' end, (select auth.uid()));
end;
$$;
revoke execute on function public.request_curator_run(uuid, text) from public, anon;
grant execute on function public.request_curator_run(uuid, text) to authenticated, service_role;

-- curator enqueues follow-up tasks (draft per cluster, finalize) through this
create function public.kf_enqueue_curator_task(p_run uuid, p_step text, p_input jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.curator_tasks;
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  insert into public.curator_tasks (run_id, space_id, step, input)
  select r.id, r.space_id, p_step, p_input from public.curator_runs r where r.id = p_run
  returning * into t;
  perform pgmq.send('kf_curator', jsonb_build_object('task_id', t.id, 'run_id', t.run_id, 'space_id', t.space_id));
  return t.id;
end;
$$;
revoke execute on function public.kf_enqueue_curator_task(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.kf_enqueue_curator_task(uuid, text, jsonb) to service_role;

-- flag threshold: N open flags on one concept (or N "missing" flags in a space) triggers a run
create function private.on_flag_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_threshold int := coalesce((private.space_settings(new.space_id) #>> '{curator,flag_threshold}')::int, 3);
  v_enabled boolean := coalesce((private.space_settings(new.space_id) #>> '{curator,enabled}')::boolean, true);
  v_count int;
begin
  if not v_enabled or v_threshold <= 0 then return null; end if;
  select count(*) into v_count from public.flags f
   where f.space_id = new.space_id and f.status = 'open'
     and ((new.concept_id is not null and f.concept_id = new.concept_id)
          or (new.concept_id is null and f.concept_id is null and f.kind = 'missing'));
  if v_count >= v_threshold then
    perform private.start_curator_run(new.space_id, 'flag_threshold');
  end if;
  return null;
end;
$$;
create trigger flags_threshold after insert on public.flags
  for each row execute function private.on_flag_created();

create function util.schedule_nightly_curator() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  s record;
begin
  for s in select id from public.spaces where coalesce((settings #>> '{curator,enabled}')::boolean, true) loop
    -- only when there is something to learn from
    if exists (select 1 from public.flags f where f.space_id = s.id and f.status = 'open')
       or exists (select 1 from public.traces t where t.space_id = s.id and t.curated_at is null)
       or exists (select 1 from public.source_documents d where d.space_id = s.id
                   and d.changed_at > coalesce((select max(r.until) from public.curator_runs r where r.space_id = s.id and r.status = 'succeeded'), '-infinity'))
    then
      perform private.start_curator_run(s.id, 'cron');
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

create function util.schedule_staleness_sweep() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  s record;
begin
  for s in select distinct c.space_id from public.concepts c
            where c.status = 'stable' and c.stale_after is not null and c.stale_after < now() loop
    perform private.start_curator_run(s.space_id, 'staleness');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function util.schedule_nightly_curator() from public, anon, authenticated;
revoke execute on function util.schedule_staleness_sweep() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- cron
-- ---------------------------------------------------------------------------------------------------------
select cron.schedule('kf-embed', '10 seconds', $$ select util.process_queue('kf_embed', 'embed', 8, 4, 120); $$);
select cron.schedule('kf-ingest-due', '*/5 * * * *', $$ select util.enqueue_due_sources(); $$);
select cron.schedule('kf-ingest', '30 seconds', $$ select util.process_queue('kf_ingest', 'connectors', 1, 2, 400); $$);
select cron.schedule('kf-curator', '15 seconds', $$ select util.process_queue('kf_curator', 'curator', 1, 3, 400); $$);
select cron.schedule('kf-curator-nightly', '0 2 * * *', $$ select util.schedule_nightly_curator(); $$);
select cron.schedule('kf-staleness', '0 3 * * *', $$ select util.schedule_staleness_sweep(); $$);
select cron.schedule('kf-net-cleanup', '0 * * * *', $$ delete from net._http_response where created < now() - interval '6 hours'; $$);
