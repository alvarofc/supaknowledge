# Contributing to Supaknowledge

Thanks for helping. Issues and pull requests are welcome: bug reports, docs fixes, connectors, curator prompt
improvements, and new ideas in [DESIGN.md §11](docs/DESIGN.md#11-open-questions). Questions and ideas that are not
yet a concrete issue fit best in GitHub Discussions.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need Node 22.18+ (24 recommended), npm, Docker, and for the Python SDK [uv](https://docs.astral.sh/uv/) (or
any Python 3.10+). Deno is fetched on demand with `npx`.

```bash
npm install && npm run build:cli
cp supabase/.env.example supabase/.env
cp apps/studio/.env.example apps/studio/.env.local
npx supabase start                    # local stack: migrations, seed, Edge Functions, cron
npm run studio                        # http://127.0.0.1:3000
npm run demo                          # optional: load the example story into the stack
```

The TypeScript packages run from source with Node's type stripping, so most changes need no build step. Only the
`kf` binary is bundled: run `npm run build:cli` after changing `packages/cli` (or `packages/sdk` /
`packages/core`, which it bundles) if you want `npx kf` to pick it up.

**TypeScript versions.** Every workspace compiles with TypeScript 7 (the native compiler), so `npm run typecheck`
and the package builds use 7. The repository root keeps `typescript` 6.x on purpose: typescript-eslint, which
Studio's lint runs, needs the TypeScript JS API, and 7.0 does not ship one. Use `npm run typecheck`, or `npx tsc`
from a workspace directory; `npx tsc` at the root runs 6.x.

| Where | What | Docs |
|---|---|---|
| `supabase/migrations` | Schema, RLS, RPCs, queues, cron | [architecture](docs/architecture.md) |
| `supabase/functions` | Edge Functions (Deno) | [architecture](docs/architecture.md#edge-functions) |
| `packages/core` | Formats, access rules, policy, curator engine | [curator](docs/curator.md), [OKF](docs/okf.md) |
| `packages/cli`, `packages/sdk`, `packages/mastra`, `sdks/python` | `kf`, TypeScript SDK, Mastra integration, Python SDK | [CLI](docs/cli.md), [SDKs](docs/sdk.md) |
| `apps/studio` | Studio web UI (TanStack Start) | [Studio](docs/studio.md) |
| `examples/revenue-report` | The end-to-end demo | [README](examples/revenue-report/README.md) |

## Tests

Run everything locally (the stack must be running for the database tests):

```bash
npm run test:all
```

which runs, in order:

| Command | What |
|---|---|
| `npm run typecheck` | `tsc` in every workspace |
| `npm test` | Unit tests (`node --test`) of core, cli, sdk, mastra (a real Mastra agent against a mock OpenAI-compatible endpoint), Studio (`apps/studio/test`) and the example (offline curator story, real-agent path) |
| `npm run lint -w @supaknowledge/studio` | ESLint for Studio |
| `npm run check:shared` | `supabase/functions/_shared/core` is an exact copy of `packages/core/src` |
| `npm run check:functions` | `deno check` of every Edge Function against its `deno.json` and lockfile |
| `npm run test:deno` | Every Edge Function Deno suite (`scripts/test-deno.mjs`): `connectors`, `agents`, `bundle`, `maintenance`, `mcp`, `traces` and `_shared`, each against its function's `deno.json` (Deno 2.9.6 through `npx`; `node scripts/test-deno.mjs mcp` runs one suite) |
| `npm run test:python` | Python SDK tests (`uv venv`, `uv pip install -e ".[test]"`, `pytest`) |
| `npx supabase test db` | The 702 pgTAP tests of the access model (`npm run test:db`) |

Extra checks worth running when you touch these areas:

- `npm run smoke -w @supaknowledge/cli` after `npm run build:cli`: live CLI checks against the local stack (creates and
  deletes throwaway users).
- `npm run demo` and `npm run demo:offline`: the example story end to end.
- `npm run build -w @supaknowledge/studio`: the production build for Studio.

CI (`.github/workflows/ci.yml`) runs the same checks on every push and pull request.

## Rules of the road

- **`packages/core` is shared with the Edge Functions.** After changing anything in `packages/core/src`, run
  `npm run sync:shared` and commit `supabase/functions/_shared/core` with it. CI fails when the copy drifts.
  Never edit `_shared/core` by hand.
- **Access control lives in the database.** New tables get RLS and column grants in a migration, and new behaviour
  gets pgTAP tests in `supabase/tests/database` (use the shared `_fixture.psql`). New settings keys go into both
  `SpaceSettingsSchema` (`packages/core/src/settings.ts`) and the database validator
  (`private.validate_space_settings()`); `packages/core/test/settings-db.test.ts` fails when they drift. Edge Functions query as the
  caller; use the service role only in internal workers, or after checking permissions through the caller's RLS
  client, and say why in a comment.
- **One write path.** Knowledge changes go through proposals and `apply_proposal()`, never direct writes to
  `concepts`. Proposals are created only with the `create_proposal()` RPC (proposal, ops and citations in one
  transaction); never insert into `proposals`, `proposal_ops` or `proposal_citations` directly.
- **Migrations are append-only.** Add a new migration instead of editing a released one. After a schema change,
  regenerate Studio's types:
  `npx supabase gen types typescript --local --schema public > apps/studio/src/lib/database.types.ts`.
- **Pin dependencies** to exact versions (npm, `deno.json` imports, Python), and keep `deno.lock` files committed.
  The exception is the runtime dependencies of the published SDKs, which users install next to their own: the
  Python SDK declares a compatible range for `httpx`, and `@supaknowledge/mastra` a semver range for
  `@supaknowledge/sdk`.
- **Curator prompts** (`packages/core/src/curator/prompts.ts`) change behaviour for every space: describe the
  change and its effect in the pull request, and keep `packages/core/test/curator.test.ts` and the example green.
- Keep docs in `docs/` in step with the code: commands, flags and routes in the docs are meant to be exact.

## Pull requests

Keep them focused, explain the why, and include tests. Add a line under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md) for user-visible changes. By contributing you agree that your contributions are
licensed under the [Apache License 2.0](LICENSE).

Security issues: please do not open a public issue; see [SECURITY.md](SECURITY.md).

## Releases (maintainers)

Versions follow [SemVer](https://semver.org) (0.x while in alpha). To release, bump `version` in
`packages/sdk`, `packages/mastra`, `packages/cli` (and the `@supaknowledge/sdk` dependency of `packages/mastra`)
and `sdks/python/pyproject.toml`, move the `[Unreleased]` notes in `CHANGELOG.md` under the new version, merge,
then push a tag `vX.Y.Z`. The [release workflow](.github/workflows/release.yml) builds and publishes the npm
packages (with provenance) and the Python package (PyPI trusted publishing). It can also be run by hand from the
Actions tab, with a dry-run option.
