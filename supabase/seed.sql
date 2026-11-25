-- Local development seed (safe to re-run).
-- Cron jobs reach Edge Functions through these Vault secrets. In production, set them once per project:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<long random string>', 'kf_internal_secret');
-- and set the same value as the KF_INTERNAL_SECRET Edge Function secret.
select vault.create_secret('http://api.supabase.internal:8000', 'project_url')
where not exists (select 1 from vault.secrets where name = 'project_url');
select vault.create_secret('local-dev-internal-secret-change-me', 'kf_internal_secret')
where not exists (select 1 from vault.secrets where name = 'kf_internal_secret');
