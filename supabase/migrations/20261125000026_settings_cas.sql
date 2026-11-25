-- Atomic space-settings saves (PR #5 review): Studio merged the form into the stored settings it had just read and
-- wrote the result back, so a save by another admin between the read and the write was lost. The write is now a
-- compare-and-swap: it only applies when the stored settings still equal what the caller merged against.
--
-- Runs with the caller's rights, so RLS (space admins only) and private.validate_space_settings still apply.
-- Returns 'saved', 'conflict' (the settings changed since p_expected was read: re-read, re-merge, retry),
-- 'forbidden' (the space is visible but the caller may not change it) or 'not_found'.
create or replace function public.update_space_settings(p_space uuid, p_settings jsonb, p_expected jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_current jsonb;
begin
  update public.spaces set settings = p_settings
   where id = p_space and settings is not distinct from p_expected
  returning id into v_id;
  if v_id is not null then
    return 'saved';
  end if;
  select s.settings into v_current from public.spaces s where s.id = p_space;
  if not found then
    return 'not_found';
  end if;
  return case when v_current is not distinct from p_expected then 'forbidden' else 'conflict' end;
end;
$$;

revoke execute on function public.update_space_settings(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.update_space_settings(uuid, jsonb, jsonb) to authenticated, service_role;
