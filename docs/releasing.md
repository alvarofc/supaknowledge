# Releasing

Maintainer steps. A pushed tag `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml): it
checks that every package version matches the tag, runs the type checks and tests, then publishes
`@supaknowledge/sdk`, `@supaknowledge/mastra` and `@supaknowledge/cli` to npm (with provenance) and `supaknowledge` to
PyPI (trusted publishing). `@supaknowledge/core` and Studio are private and never published.

## One-time setup

### npm

1. On [npmjs.com](https://www.npmjs.com), create the organization `supaknowledge`, so the `@supaknowledge` scope
   belongs to it.
2. Create a granular access token with read and write permission on the `@supaknowledge` scope. The workflow
   publishes without anyone at a prompt, so the token must be allowed to publish from CI.
3. In the GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**, name `NPM_TOKEN`.

Provenance needs nothing else: the `npm` job already has `id-token: write`, and the repository is public.

### PyPI

1. On [pypi.org](https://pypi.org), under **Your account → Publishing**, add a pending trusted publisher (the project
   does not exist yet): PyPI project `supaknowledge`, owner `alvarofc`, repository `supaknowledge`, workflow
   `release.yml`, environment `pypi`.
2. In the GitHub repository: **Settings → Environments → New environment**, name `pypi`. Add required reviewers if a
   person should approve each PyPI upload.

## Cut a release

1. Start from `main` with a clean tree and green CI.
2. Versions. Every published package carries the same version: `packages/{sdk,mastra,cli}/package.json`,
   `SDK_VERSION` in `packages/sdk/src/client.ts`, `version` in `sdks/python/pyproject.toml` and `__version__` in
   `sdks/python/src/supaknowledge/client.py` (prereleases the PEP 440 way: `0.2.0-rc.1` on npm is `0.2.0rc1`). The
   mastra peer range on `@supaknowledge/sdk` must accept it, and the exact SDK pins in the CLI and mastra
   `devDependencies` must equal it. Then:

   ```bash
   node scripts/check-release.mjs --tag v0.1.0
   ```

3. Changelog. Replace `YYYY-MM-DD` in the `## [0.1.0]` heading of [CHANGELOG.md](../CHANGELOG.md) with the tag day, and
   move anything listed under `[Unreleased]` into that section. Commit to `main`.
4. Local checks against a running local stack:

   ```bash
   npm ci
   npm run test:all            # typecheck, tests, Studio lint, shared/functions checks, Deno, Python, pgTAP
   node scripts/check-release.mjs --tag v0.1.0
   ```

5. Dry run on GitHub: **Actions → Release → Run workflow** from `main`, with **dry_run** checked. It builds and packs
   everything and runs `npm publish --dry-run`.
6. Tag and push:

   ```bash
   git tag -a v0.1.0 -m "Supaknowledge 0.1.0"
   git push origin v0.1.0
   ```

7. Check what was published:

   ```bash
   npm view @supaknowledge/cli@0.1.0 version
   npx @supaknowledge/cli@0.1.0 --help
   python -m pip install supaknowledge==0.1.0
   ```

8. Create a GitHub release for the tag with the changelog section as its notes.

If a publish job fails halfway, fix the cause and run the workflow again on the tag: the npm job skips versions that
are already on npm, and the PyPI upload skips existing files.

## Supabase OAuth app and token broker

`kf deploy --login` signs in with a Supabase OAuth app. Supabase's token endpoint needs the app's client secret, so a
small Edge Function, `supabase/functions/oauth-broker`, holds it: it forwards the browser from Supabase to the CLI's
`127.0.0.1` listener and forwards the code exchange (with the CLI's PKCE verifier) and refreshes. It stores nothing.

1. **Register the OAuth app** in the organization's settings in the Supabase dashboard:
   - redirect URI: `https://<broker-ref>.supabase.co/functions/v1/oauth-broker/callback`, where `<broker-ref>` is the
     project that runs the broker (any project; the broker uses no database);
   - scopes: **Organizations** read, **Projects** read and write, **Database** read and write, **Edge Functions**
     read and write, **Secrets** read and write, **Auth** read and write.
   Note the client id and the client secret.
2. **Set the broker's secrets** in that project (dashboard: **Edge Functions → Secrets**):
   `KF_SUPABASE_OAUTH_CLIENT_ID`, `KF_SUPABASE_OAUTH_CLIENT_SECRET` and
   `KF_SUPABASE_OAUTH_REDIRECT_URI=https://<broker-ref>.supabase.co/functions/v1/oauth-broker/callback`.
3. **Deploy the broker** from a checkout without `supabase/.env` (the Supabase CLI uploads values it finds there; see
   the warning in [deploy](deploy.md#3-edge-functions)):

   ```bash
   npx supabase functions deploy oauth-broker --project-ref <broker-ref> --no-verify-jwt
   ```

4. **Check it**: `curl -s -X POST https://<broker-ref>.supabase.co/functions/v1/oauth-broker/token` answers
   `400 {"error":"unsupported grant_type ..."}` when the broker is configured, and `503` when a secret is missing.
5. **Publish** `KF_SUPABASE_OAUTH_CLIENT_ID=<client id>` and
   `KF_SUPABASE_OAUTH_BROKER_URL=https://<broker-ref>.supabase.co/functions/v1/oauth-broker` in the README and in
   [deploy](deploy.md#deploy-with-kf-deploy---login). The client id is not a secret. Then run
   `kf deploy --login --dry-run --project-ref <a test project>` once from a terminal to confirm the sign-in.

If the client secret leaks, rotate it in the dashboard and update `KF_SUPABASE_OAUTH_CLIENT_SECRET`. The broker
cannot exchange a code without the PKCE verifier that only the CLI that started the sign-in holds.

## Public demo

The public demo (Studio on Cloudflare Workers, the Edge Functions and the Acme bundle in its own Supabase project)
is described in [deploy → Host a public demo](deploy.md#host-a-public-demo). Deploying the demo's Studio from CI needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
