-- Supaknowledge: atomic curator run stats. Draft tasks of one run execute concurrently, so stats are merged in
-- one UPDATE (numeric values are added) instead of read-modify-write from the worker.
create function public.kf_add_run_stats(p_run uuid, p_delta jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_stats jsonb;
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  update public.curator_runs r
     set stats = coalesce(r.stats, '{}'::jsonb) || coalesce((
           select jsonb_object_agg(d.key,
                    case when jsonb_typeof(d.value) = 'number'
                         then to_jsonb(coalesce((r.stats ->> d.key)::numeric, 0) + (d.value #>> '{}')::numeric)
                         else d.value end)
           from jsonb_each(p_delta) d), '{}'::jsonb)
   where r.id = p_run
   returning stats into v_stats;
  return v_stats;
end;
$$;
revoke execute on function public.kf_add_run_stats(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kf_add_run_stats(uuid, jsonb) to service_role;
