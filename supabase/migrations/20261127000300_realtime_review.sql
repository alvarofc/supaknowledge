-- Realtime Authorization for Studio's private channels, and live curator progress over Broadcast.
--
-- Two private topics (clients join them with `config: { private: true }`; Realtime checks these policies on
-- realtime.messages with the joining user's JWT when they join):
--
--   proposal:<proposal id>   Presence: who is looking at / reviewing a proposal. Join and track only for people who
--                            can see the proposal (the proposals SELECT policy decides, so audiences apply), never
--                            for headless agents or OAuth client tokens. Nobody can broadcast on these topics.
--   curator:<space id>       Broadcast: progress events of the space's curator tasks. Joined by whoever may read
--                            the space's curator runs (editors and up). Nobody but the curator sends: there is no
--                            INSERT policy (no broadcast, no presence), and kf_curator_progress() is service-role only.
--
-- Read policies cover both extensions of a topic: a join probes broadcast and presence, and what can be received is
-- limited by what can be sent.

-- ---------------------------------------------------------------------------------------------------------
-- topic helpers
-- ---------------------------------------------------------------------------------------------------------

-- The uuid after "<prefix>:" in the topic being authorized (realtime.topic()), or null for any other topic. Never
-- raises on a malformed topic, so a bad join is simply refused.
create or replace function private.realtime_topic_id(p_prefix text) returns uuid
language sql stable set search_path = '' as $$
  select case
    when t is not null and left(t, length(p_prefix) + 1) = p_prefix || ':'
     and substr(t, length(p_prefix) + 2) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then substr(t, length(p_prefix) + 2)::uuid
  end
  from (select realtime.topic() as t) x;
$$;
revoke execute on function private.realtime_topic_id(text) from public, anon;
grant execute on function private.realtime_topic_id(text) to authenticated, service_role;

-- A person (not an agent, not an OAuth client token) who can see the proposal named by the topic. SECURITY INVOKER
-- on purpose: the proposals SELECT policy (space role + every cited and consulted audience) decides.
create or replace function private.realtime_can_review(p_proposal uuid) returns boolean
language sql stable set search_path = '' as $$
  select p_proposal is not null
     and not private.is_agent()
     and not private.is_oauth_client()
     and exists (select 1 from public.proposals p where p.id = p_proposal);
$$;
revoke execute on function private.realtime_can_review(uuid) from public, anon;
grant execute on function private.realtime_can_review(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- policies on realtime.messages
-- ---------------------------------------------------------------------------------------------------------
drop policy if exists "kf: review presence: read" on realtime.messages;
create policy "kf: review presence: read" on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('presence', 'broadcast')
    and (select private.realtime_can_review(private.realtime_topic_id('proposal')))
  );

drop policy if exists "kf: review presence: track" on realtime.messages;
create policy "kf: review presence: track" on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select private.realtime_can_review(private.realtime_topic_id('proposal')))
  );

drop policy if exists "kf: curator progress: read" on realtime.messages;
create policy "kf: curator progress: read" on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and (select private.realtime_topic_id('curator')) in (select private.my_spaces('editor'))
  );

-- ---------------------------------------------------------------------------------------------------------
-- kf_curator_progress(): the curator's way onto curator:<space id>
-- ---------------------------------------------------------------------------------------------------------
-- Called by the curator Edge Function (service role) with a batch of progress events (CuratorProgress in
-- packages/core/src/curator/progress.ts). Each becomes one private broadcast, event "progress", through
-- realtime.send(), which stores it in realtime.messages: Realtime delivers it to subscribers authorized by the
-- policy above and can replay it to a viewer who joins later (Studio replays the active run). Events must not carry
-- evidence: the engine sends ids, counts and timings only, and this function caps their size.
create or replace function public.kf_curator_progress(p_space uuid, p_events jsonb) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_event jsonb;
  n integer := 0;
begin
  if not private.is_service_role() then raise exception 'service role only' using errcode = '42501'; end if;
  if p_space is null or not exists (select 1 from public.spaces s where s.id = p_space) then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_events) = 'object' then p_events := jsonb_build_array(p_events); end if;
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 50 then
    raise exception 'expected an array of at most 50 progress events' using errcode = '22023';
  end if;
  for v_event in select e from jsonb_array_elements(p_events) e loop
    if jsonb_typeof(v_event) <> 'object'
       or coalesce(v_event ->> 'type', '') !~ '^[a-z_]{1,40}$'
       or octet_length(v_event::text) > 2048 then
      raise exception 'invalid progress event' using errcode = '22023';
    end if;
    perform realtime.send(v_event, 'progress', 'curator:' || p_space::text, true);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.kf_curator_progress(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kf_curator_progress(uuid, jsonb) to service_role;
