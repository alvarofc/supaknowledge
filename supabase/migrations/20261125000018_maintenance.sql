-- Supaknowledge: review fixes, part 8 — maintenance jobs and smaller RPC fixes.
--
--   * util.cleanup() (cron kf-cleanup, daily): prunes cron.job_run_details (7 days), pgmq archive tables
--     (30 days), curator task payloads of finished runs (30 days), and — per space, only when configured —
--     traces (settings.retention.trace_days) and concept usage (settings.retention.usage_days).
--   * util.reap_curator_runs() every 5 minutes (cron kf-curator-reaper).
--   * util.process_queue() does not consume messages when kf_internal_secret is missing.
--   * agents.last_seen_at is actually updated (log_concept_usage runs as the caller, who cannot update agents).
--   * knowledge_health(): p_days clamped to 1..365; usage counts are aggregated for every concept the caller can
--     see (editors used to see only their own usage, so most concepts looked "never used").
--   * set_source_secret() locks the source row (concurrent first calls raced on the Vault secret name) and,
--     with request_source_sync(), refuses OAuth client tokens.
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- retention
-- ---------------------------------------------------------------------------------------------------------
create or replace function util.cleanup() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  q record;
  n bigint;
  v_out jsonb := '{}'::jsonb;
  s record;
begin
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  get diagnostics n = row_count;
  v_out := v_out || jsonb_build_object('cron_job_run_details', n);

  for q in select m.queue_name from pgmq.meta m where m.queue_name in ('kf_embed', 'kf_ingest', 'kf_curator') loop
    execute format('delete from pgmq.%I where archived_at < now() - interval ''30 days''', 'a_' || q.queue_name);
    get diagnostics n = row_count;
    v_out := v_out || jsonb_build_object('archive_' || q.queue_name, n);
  end loop;

  update public.curator_tasks t set input = '{}'::jsonb, output = null
   where t.finished_at < now() - interval '30 days' and (t.input <> '{}'::jsonb or t.output is not null);
  get diagnostics n = row_count;
  v_out := v_out || jsonb_build_object('curator_task_payloads', n);

  for s in select sp.id,
                  private.setting_int(sp.settings, '{retention,trace_days}', 0, 0, 36500) as trace_days,
                  private.setting_int(sp.settings, '{retention,usage_days}', 0, 0, 36500) as usage_days
           from public.spaces sp
           where private.setting_int(sp.settings, '{retention,trace_days}', 0, 0, 36500) > 0
              or private.setting_int(sp.settings, '{retention,usage_days}', 0, 0, 36500) > 0 loop
    if s.trace_days > 0 then
      delete from public.traces t where t.space_id = s.id and t.created_at < now() - make_interval(days => s.trace_days);
      get diagnostics n = row_count;
      v_out := v_out || jsonb_build_object('traces', coalesce((v_out ->> 'traces')::bigint, 0) + n);
    end if;
    if s.usage_days > 0 then
      delete from public.concept_usage u where u.space_id = s.id and u.at < now() - make_interval(days => s.usage_days);
      get diagnostics n = row_count;
      v_out := v_out || jsonb_build_object('concept_usage', coalesce((v_out ->> 'concept_usage')::bigint, 0) + n);
    end if;
  end loop;
  return v_out;
end;
$$;
revoke execute on function util.cleanup() from public, anon, authenticated;

select cron.schedule('kf-cleanup', '17 4 * * *', $$ select util.cleanup(); $$);
select cron.schedule('kf-curator-reaper', '*/5 * * * *', $$ select util.reap_curator_runs(); $$);

-- ---------------------------------------------------------------------------------------------------------
-- queue fan-out: do not dequeue (and burn read_ct toward the dead-letter limit) when the call cannot be made
-- ---------------------------------------------------------------------------------------------------------
create or replace function util.process_queue(p_queue text, p_function text, p_batch_size int, p_max_batches int, p_vt int)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_batches int := 0;
  b jsonb;
begin
  if util.secret('project_url') is null or util.secret('kf_internal_secret') is null then
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

-- ---------------------------------------------------------------------------------------------------------
-- agents.last_seen_at
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.touch_agent_last_seen() returns void
language sql volatile security definer set search_path = '' as $$
  update public.agents a set last_seen_at = now()
   where a.id = (select auth.uid()) and (a.last_seen_at is null or a.last_seen_at < now() - interval '1 minute');
$$;
revoke execute on function private.touch_agent_last_seen() from public, anon;
grant execute on function private.touch_agent_last_seen() to authenticated, service_role;

create or replace function public.log_concept_usage(
  p_space uuid, p_concepts uuid[], p_via text default 'search', p_query text default null, p_trace uuid default null
) returns int
language plpgsql volatile security invoker set search_path = '' as $$
declare
  n int;
begin
  insert into public.concept_usage (space_id, concept_id, revision, principal_id, trace_id, via, query)
  select c.space_id, c.id, c.revision, (select auth.uid()), p_trace, p_via, p_query
  from public.concepts c where c.id = any (p_concepts) and c.space_id = p_space;
  get diagnostics n = row_count;
  if (select auth.uid()) is not null then
    perform private.touch_agent_last_seen();
  end if;
  return n;
end;
$$;
revoke execute on function public.log_concept_usage(uuid, uuid[], text, text, uuid) from anon, public;
grant execute on function public.log_concept_usage(uuid, uuid[], text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- knowledge_health
-- ---------------------------------------------------------------------------------------------------------
-- usage counts per concept for a space the caller can read (aggregates only: no queries, no principals)
create or replace function private.usage_counts(p_space uuid, p_since timestamptz)
returns table (concept_id uuid, n bigint)
language sql stable security definer set search_path = '' as $$
  select u.concept_id, count(*) from public.concept_usage u
   where u.space_id = p_space and u.at > p_since and (select private.space_rank(p_space)) >= 1
   group by u.concept_id;
$$;
revoke execute on function private.usage_counts(uuid, timestamptz) from public, anon;
grant execute on function private.usage_counts(uuid, timestamptz) to authenticated, service_role;

create or replace function public.knowledge_health(p_space uuid, p_days int default 30) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with params as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365))) as since),
  c as (select * from public.concepts where space_id = p_space and status <> 'deprecated'),
  -- joined to the caller's visible concepts below, so restricted concepts never surface
  usage as (select u.concept_id, u.n from params, private.usage_counts(p_space, params.since) u),
  fl as (select f.concept_id, count(*) as n from public.flags f, params
         where f.space_id = p_space and f.created_at > params.since group by f.concept_id)
  select jsonb_build_object(
    'concepts', (select count(*) from c),
    'by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}') from (select kind, count(*) n from c group by kind) k),
    'by_trust', (select coalesce(jsonb_object_agg(t, n), '{}') from (
        select public.trust(k) t, count(*) n from public.concepts k
        where k.space_id = p_space and k.status <> 'deprecated' group by 1) x),
    'stale', (select count(*) from c where c.stale_after < now()),
    'open_flags', (select count(*) from public.flags f where f.space_id = p_space and f.status = 'open'),
    'missing_flags', (select count(*) from public.flags f where f.space_id = p_space and f.status = 'open' and f.kind = 'missing'),
    'pending_proposals', (select count(*) from public.proposals p where p.space_id = p_space and p.status = 'pending'),
    'applied_proposals', (select count(*) from public.proposals p, params where p.space_id = p_space and p.status = 'applied'
                           and p.applied_at > params.since),
    'auto_applied', (select count(*) from public.proposals p, params where p.space_id = p_space and p.auto_applied
                      and p.applied_at > params.since),
    'never_used', (select count(*) from c where c.id not in (select concept_id from usage)),
    'most_flagged', (select coalesce(jsonb_agg(x order by x.flags desc), '[]') from (
        select c.path, c.title, fl.n as flags, coalesce(usage.n, 0) as uses,
               round(fl.n::numeric / greatest(coalesce(usage.n, 0), 1), 3) as flag_rate
        from fl join c on c.id = fl.concept_id left join usage on usage.concept_id = c.id
        order by fl.n desc limit 10) x),
    'last_run', (select to_jsonb(r) from (select id, status, trigger, stats, finished_at from public.curator_runs
                  where space_id = p_space order by created_at desc limit 1) r)
  );
$$;
revoke execute on function public.knowledge_health(uuid, int) from anon, public;
grant execute on function public.knowledge_health(uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- sources
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.set_source_secret(p_source uuid, p_secret text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.sources;
begin
  select * into s from public.sources where id = p_source for update;
  if not found or private.is_oauth_client() or private.space_rank(s.space_id) < 4 or not private.in_audience(s.audience) then
    raise exception 'space admin required' using errcode = '42501';
  end if;
  if s.secret_id is null
     or not exists (select 1 from vault.secrets vs where vs.id = s.secret_id and vs.name = 'kf_source_' || p_source::text) then
    update public.sources set secret_id = vault.create_secret(p_secret, 'kf_source_' || p_source::text, 'Supaknowledge connector token')
     where id = p_source;
  else
    perform vault.update_secret(s.secret_id, p_secret);
  end if;
  perform private.audit(s.space_id, 'source.secret_set', 'source', p_source);
end;
$$;
revoke execute on function public.set_source_secret(uuid, text) from anon, public;
grant execute on function public.set_source_secret(uuid, text) to authenticated, service_role;

create or replace function public.request_source_sync(p_source uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.sources;
begin
  select * into s from public.sources where id = p_source;
  if not found or (not private.is_service_role()
                   and (private.is_oauth_client() or private.space_rank(s.space_id) < 4 or not private.in_audience(s.audience))) then
    raise exception 'space admin required' using errcode = '42501';
  end if;
  perform pgmq.send('kf_ingest', jsonb_build_object('source_id', s.id, 'space_id', s.space_id, 'full', true));
  update public.sources set sync_requested_at = now() where id = s.id;
end;
$$;
revoke execute on function public.request_source_sync(uuid) from public, anon;
grant execute on function public.request_source_sync(uuid) to authenticated, service_role;
