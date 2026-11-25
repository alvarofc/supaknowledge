-- Supaknowledge: Storage buckets and Realtime
--
--   concept-files  <space_id>/<concept_id>/<path>       skill scripts, templates, references
--   sources        <space_id>/<source_id>/<file>        raw evidence (uploads, exported pages)
--
-- Reads follow the same rules as the rows they belong to. Writes happen through Edge Functions with the
-- service role, after the function has checked permissions.

insert into storage.buckets (id, name, public, file_size_limit)
values ('concept-files', 'concept-files', false, 10485760),
       ('sources', 'sources', false, 52428800)
on conflict (id) do nothing;

create function private.try_uuid(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end;
$$;

create policy "concept-files: readers of concept" on storage.objects for select to authenticated
  using (
    bucket_id = 'concept-files'
    and private.try_uuid((storage.foldername(name))[2]) in (select c.id from public.concepts c)
  );

create index if not exists source_documents_storage_path on public.source_documents (storage_path);
create policy "sources: editors in document audience" on storage.objects for select to authenticated
  using (
    bucket_id = 'sources'
    and name in (select d.storage_path from public.source_documents d where d.storage_path is not null)
  );

-- Realtime: Studio inbox and live knowledge browser. postgres_changes respects RLS.
do $$
declare
  t text;
begin
  foreach t in array array['flags', 'proposals', 'curator_runs', 'concepts'] loop
    if not exists (select 1 from pg_publication_tables p
                    where p.pubname = 'supabase_realtime' and p.schemaname = 'public' and p.tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
