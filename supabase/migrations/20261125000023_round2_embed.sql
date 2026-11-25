-- Supaknowledge: review fixes, round 2 — the `embed` worker.
--   * Chunk writes are compare-and-swap: kf_embed_write_concept() / kf_embed_write_document() lock the entity row
--     (FOR NO KEY UPDATE), check that it is still the version the worker embedded, and only then upsert chunks
--     (and, for concepts, the link graph). A job that embedded an older version can no longer overwrite the
--     chunks of a newer one written in between (the old check-then-write ran in separate requests).
--   * kf_embed_requeue() acks a job that ran out of embedding budget and re-queues its entity only when no other
--     message for that entity is still queued, so duplicate messages (rapid edits, parallel batches) collapse
--     into one instead of travelling together forever.
-- Idempotent.

-- ---------------------------------------------------------------------------------------------------------
-- concepts: chunks (+ links) for exactly the embedded version
-- ---------------------------------------------------------------------------------------------------------
-- p_chunks: [{ord, heading, content, embedding}] (embedding = pgvector literal). p_total: the number of chunks of
-- this version, given on the call that completes it (chunks with ord >= p_total are deleted); null on a partial
-- write. p_links: [{to_path, anchor}] = the concept's full link set (upserted, links not in it deleted); null to
-- leave links alone. Returns false (nothing written) when the concept is gone or no longer this version.
create or replace function public.kf_embed_write_concept(
  p_concept uuid, p_revision int, p_path text, p_body_sha256 text,
  p_chunks jsonb, p_total int default null, p_links jsonb default null
) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.concepts;
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  if p_chunks is not null and jsonb_typeof(p_chunks) <> 'array' or p_links is not null and jsonb_typeof(p_links) <> 'array' then
    raise exception 'p_chunks and p_links must be arrays' using errcode = '22023';
  end if;
  -- no concept update commits between this check and the writes below; writers of one concept queue up
  select * into c from public.concepts k where k.id = p_concept for no key update;
  if not found or c.revision <> p_revision or c.path <> p_path
     or encode(sha256(convert_to(c.body, 'UTF8')), 'hex') <> p_body_sha256 then
    return false;
  end if;

  insert into public.concept_chunks as ch (concept_id, space_id, revision, ord, heading, content, embedding)
  select c.id, c.space_id, c.revision, r.ord, r.heading, r.content, r.embedding::extensions.vector
    from jsonb_to_recordset(coalesce(p_chunks, '[]'::jsonb)) as r(ord int, heading text, content text, embedding text)
   where r.ord >= 0 and r.content is not null and r.embedding is not null
  on conflict (concept_id, ord) do update
    set revision = excluded.revision, heading = excluded.heading, content = excluded.content, embedding = excluded.embedding;
  if p_total is not null then
    delete from public.concept_chunks ch where ch.concept_id = c.id and ch.ord >= p_total;
  end if;

  if p_links is not null then
    insert into public.concept_links as l (space_id, from_concept, to_path, to_concept, anchor)
    select c.space_id, c.id, x.to_path,
           (select k.id from public.concepts k where k.space_id = c.space_id and k.path = x.to_path),
           left(x.anchor, 200)
      from (select distinct on (r.to_path) r.to_path, r.anchor
              from jsonb_to_recordset(p_links) as r(to_path text, anchor text)
             where r.to_path is not null and r.to_path <> '' and r.to_path <> c.path
             order by r.to_path) x
    on conflict (from_concept, to_path) do update set to_concept = excluded.to_concept, anchor = excluded.anchor;
    delete from public.concept_links l
     where l.from_concept = c.id
       and not exists (select 1 from jsonb_to_recordset(p_links) as r(to_path text)
                        where r.to_path = l.to_path and r.to_path <> c.path);
    -- links that pointed at this path before it existed
    update public.concept_links l set to_concept = c.id
     where l.space_id = c.space_id and l.to_path = c.path and l.to_concept is null;
  end if;
  return true;
end;
$$;
revoke execute on function public.kf_embed_write_concept(uuid, int, text, text, jsonb, int, jsonb) from public, anon, authenticated;
grant execute on function public.kf_embed_write_concept(uuid, int, text, text, jsonb, int, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- source documents: chunks for exactly the embedded content
-- ---------------------------------------------------------------------------------------------------------
-- p_live: the worker saw the document live (deleted_at is null). A deleted or empty document is written as
-- p_chunks = [] and p_total = 0 (removes every chunk). Returns false when the document changed since.
create or replace function public.kf_embed_write_document(
  p_document uuid, p_content_hash text, p_live boolean, p_chunks jsonb, p_total int default null
) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  d public.source_documents;
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  if p_chunks is not null and jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'p_chunks must be an array' using errcode = '22023';
  end if;
  select * into d from public.source_documents s where s.id = p_document for no key update;
  if not found or d.content_hash is distinct from p_content_hash or (d.deleted_at is null) is distinct from p_live then
    return false;
  end if;

  insert into public.source_chunks as ch (document_id, space_id, ord, heading, content, embedding)
  select d.id, d.space_id, r.ord, r.heading, r.content, r.embedding::extensions.vector
    from jsonb_to_recordset(coalesce(p_chunks, '[]'::jsonb)) as r(ord int, heading text, content text, embedding text)
   where r.ord >= 0 and r.content is not null and r.embedding is not null
  on conflict (document_id, ord) do update
    set heading = excluded.heading, content = excluded.content, embedding = excluded.embedding;
  if p_total is not null then
    delete from public.source_chunks ch where ch.document_id = d.id and ch.ord >= p_total;
  end if;
  return true;
end;
$$;
revoke execute on function public.kf_embed_write_document(uuid, text, boolean, jsonb, int) from public, anon, authenticated;
grant execute on function public.kf_embed_write_document(uuid, text, boolean, jsonb, int) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- out of budget: ack + re-queue once per entity
-- ---------------------------------------------------------------------------------------------------------
-- Deletes message p_msg_id and sends p_message ({table, id}) again unless another message for the same entity is
-- still queued (visible or being processed): that one finishes the work. Serialised per entity, so two jobs of
-- one entity re-queueing at the same time leave exactly one message. Returns true when a message was sent.
create or replace function public.kf_embed_requeue(p_msg_id bigint, p_message jsonb, p_delay int default 0) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_table text := p_message ->> 'table';
  v_id text := p_message ->> 'id';
begin
  if not private.is_service_role() then
    raise exception 'service role only' using errcode = '42501';
  end if;
  if v_table is null or v_table not in ('concepts', 'source_documents') or v_id is null
     or v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid embed message' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supaknowledge.embed_requeue:' || v_table || ':' || v_id, 0));
  perform pgmq.delete('kf_embed', p_msg_id);
  if exists (select 1 from pgmq.q_kf_embed q
              where q.msg_id <> p_msg_id and q.message ->> 'table' = v_table and q.message ->> 'id' = v_id) then
    return false;
  end if;
  perform pgmq.send('kf_embed', jsonb_build_object('table', v_table, 'id', v_id), greatest(coalesce(p_delay, 0), 0));
  return true;
end;
$$;
revoke execute on function public.kf_embed_requeue(bigint, jsonb, int) from public, anon, authenticated;
grant execute on function public.kf_embed_requeue(bigint, jsonb, int) to service_role;
