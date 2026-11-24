## What and why

<!-- What does this change, and why? Link the issue it closes (Closes #123). -->

## How it was tested

<!-- Commands you ran, e.g. npm run test:all, npm run demo, manual Studio checks. -->

## Checklist

- [ ] Tests added or updated (unit, pgTAP for access-control changes)
- [ ] `npm run sync:shared` run and `supabase/functions/_shared/core` committed, if `packages/core` changed
- [ ] New tables have RLS and grants in a migration; migrations are append-only
- [ ] Docs in `docs/` updated for changed commands, flags, routes or behaviour
- [ ] `CHANGELOG.md` updated under `[Unreleased]` for user-visible changes
- [ ] No secrets, private data or real company knowledge in code, fixtures or screenshots
