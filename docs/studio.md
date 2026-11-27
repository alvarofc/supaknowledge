# Supaknowledge Studio

Studio (`apps/studio`, package `@supaknowledge/studio`) is the web UI for a Supaknowledge knowledge factory. People use it to review
what the curator proposes, browse and verify knowledge, connect sources and agents, and watch the health of each space.
It is also where MCP clients (Claude Code, Cursor…) send people to approve access: Studio hosts the OAuth consent
screen for Supabase Auth's OAuth 2.1 server.

Stack: [TanStack Start](https://tanstack.com/start) (React 19, TanStack Router file routes, server functions, Vite,
Nitro), Tailwind CSS v4, `@supabase/ssr` + `@supabase/supabase-js`, `react-markdown` + `remark-gfm`, `diff`,
`d3-force` (graph layout only; rendering is plain SVG).

## How it talks to Supabase

- **Only the publishable key.** Every query, RPC and Realtime subscription runs with the signed-in user's session, so
  RLS decides what each person sees and can do. Studio never holds a secret or service-role key. Hiding a button for a
  role is only a convenience; the database still enforces every rule.
- **Sessions in cookies.** `@supabase/ssr` keeps the session in cookies that the server and the browser share.
  - On the server, `src/server/supabase.server.ts` creates one `createServerClient` per request. It reads cookies with
    Start's `getCookies()` and writes refreshed tokens back with `setCookie()`, plus the `Cache-Control: no-store`
    headers `@supabase/ssr` asks for. `getUser()` calls `auth.getClaims()` once per request, which also refreshes an
    expired session.
  - In the browser, `src/lib/supabase/client.ts` (`createBrowserClient`) reads and refreshes the same cookies.
- **Route guards.** The root route's `beforeLoad` finds the current user with an isomorphic function
  (`src/lib/session.ts`). During SSR it uses `getClaims()` on the request cookies. On client navigations it uses the
  browser client's local session, so there is no extra round trip.
  - The pathless `_authed` layout sends signed-out visitors to `/login?next=<the URL they wanted>`. That matters for
    `/oauth/consent?authorization_id=…`.
  - `/login` and `/signup` send signed-in visitors on to `next`.
  - Guards are UX only. Every server function checks the session again, and RLS decides what each query returns.
- **Reads** run in route loaders that call `createServerFn` server functions (`src/server/*.functions.ts`). They
  query as the user with the server client. Helpers that may only run on the server live in `*.server.ts` files, which
  Start's import protection keeps out of the browser bundle. Pages render on the server and hydrate. Hovering a link
  preloads the next page's data. Dates render through `<Timestamp>` (`src/components/kf/timestamp.tsx`): English and
  UTC on the server and during hydration, then the viewer's locale and time zone, so server and browser markup match.
- **Writes** happen in small client components that use the browser client and call the RPCs in
  `supabase/migrations`: `apply_proposal`, `reject_proposal`, `dismiss_flag`, `verify_concept`, `propose_revert`,
  `flag_knowledge`, `set_source_secret`, `request_source_sync`, `request_curator_run`, `cancel_curator_run`,
  `create_proposal`, `create_workspace`, `create_space`, `invite_to_workspace`, `list_my_invitations`,
  `accept_invitation`, `decline_invitation`.
  - Human proposals ("Suggest an edit", "New concept") go through `create_proposal`, which inserts the proposal, its
    ops and citations in one transaction (direct inserts into the proposal tables are revoked).
  - Some writes are plain inserts, updates or deletes under RLS, such as members, groups, grants and sources. They
    ask for the affected rows back (`.select()`): RLS silently filters rows you may not change, so zero rows is
    reported as an error instead of a false success.
  - After a write, the component calls `router.invalidate()` so the loaders run again.
- **Edge Functions** are called with the user's access token as the Bearer (`src/lib/functions.ts`):
  - `agents`: list headless agents (with whether each is revoked), create, rotate, revoke, restore and delete them.
    Agent rows can only be deleted through this function.
  - `bundle/sync-files`: after approving a proposal whose ops carry skill files, copies them into Storage (as
    `kf approve` does).
  - `connectors/upload`: upload documents to `upload` sources.
  - `mcp`: the address shown in the "connect your agent" snippets.

  If a function isn't deployed, Studio says so in place.
- **Realtime.** The inbox, proposal pages, knowledge pages and Activity subscribe to `postgres_changes` on `proposals`,
  `flags`, `curator_runs` and `concepts`, filtered by space, and refresh when rows change. Realtime applies RLS, so
  nobody hears about rows they can't read. A change triggers `router.invalidate()`, which reloads the page's data.
- **Space settings** (`spaces.settings`) are validated with `SpaceSettingsSchema` from `@supaknowledge/core` before they are
  saved, in a POST server function (`saveSpaceSettings`). The update itself still runs as the user. It is merged
  into what is stored: keys the schema does not know are kept, and so are fields the form did not change, so a page
  opened before another admin saved does not revert their changes.
  - `@supaknowledge/core` is imported only from `src/server/settings.server.ts`. Its main entry also pulls in Mastra (the
    curator's model layer), so it must stay out of the browser bundle.
  - The curator form edits model ids only (`model`, `fast_model`, `fallback_models`, blank = the server's
    `KF_LLM_*` defaults) and `max_research_steps`. Model endpoints and API keys are Edge Function secrets and never
    appear in Studio.

## Run it locally

```bash
npm install                       # from the repo root (npm workspaces)
npm run db:start                  # supabase start: Postgres, Auth, Realtime, Edge Runtime, Mailpit
cp apps/studio/.env.example apps/studio/.env.local
npm run studio                    # vite dev on http://127.0.0.1:3000
```

Open **http://127.0.0.1:3000**, not `localhost`. Supabase Auth's local `site_url` is `http://127.0.0.1:3000`, so email
links and OAuth redirects land there, and cookies belong to one host. `vite.config.ts` binds the dev server to
`127.0.0.1:3000` (`strictPort`, so it fails instead of moving to another port).

`supabase start` also serves the Edge Functions, with the secrets from `supabase/.env` (copy
`supabase/.env.example` first). To run them with live reload and logs in your terminal instead:

```bash
npm run functions:serve           # supabase functions serve --env-file supabase/.env
```

Without the functions, Studio still works for browsing, reviewing and settings. Creating agents and uploading
documents show a "function not available" message instead.

Other scripts (run inside `apps/studio`, or with `-w @supaknowledge/studio`):

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on http://127.0.0.1:3000 |
| `npm run build` | Production build with Nitro (`.output/` for Node; see [Deploy](#deploy)) |
| `npm start` | Serve the Node build: `node .output/server/index.mjs` (port from `PORT`, default 3000) |
| `npm run preview` | Preview the production build with Vite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config: `@tanstack/eslint-config` + `eslint-plugin-react-hooks`) |

The TanStack Router plugin generates `src/routeTree.gen.ts` from `src/routes/` whenever the dev server or a build
runs. Commit it with your route changes.

`src/lib/database.types.ts` is generated from the local database. Regenerate it after a migration:

```bash
npx supabase gen types typescript --local --schema public > apps/studio/src/lib/database.types.ts
```

### First steps

1. Sign up at `/signup` with a password, or with an email link. Local emails go to Mailpit at http://127.0.0.1:54324.
2. If someone invited your e-mail address to a workspace, a **You've been invited** banner (on onboarding and on
   Home) lists the invitation with Accept and Decline; accepting opens the workspace. Otherwise onboarding
   (`/onboarding`) has three steps:
   - Create a workspace (`create_workspace`).
   - Create the first space (`create_space`).
   - Connect an agent: OAuth snippets for your own assistant, or a link to create a headless agent key.
3. Content arrives through curator proposals, OKF bundle imports (`kf import`), or "Suggest an edit" / "New concept" in
   Knowledge. Each change is a proposal that a reviewer approves in the Inbox.

To test with several people, create users with the Auth admin API. This uses the local secret key, which belongs only in
your terminal and never in Studio:

```bash
curl -X POST http://127.0.0.1:54321/auth/v1/admin/users \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"bob@example.com","password":"password123","email_confirm":true}'
```

Then invite them from **Settings → Members → Invite by e-mail** (workspace owners and admins; only owners can invite
owners). No e-mail is sent: the person signs in with that (verified) address and accepts the invitation from the
banner. Pending invitations are listed under Members with their expiry (14 days) and a Revoke button. People cannot be
added to a workspace without accepting; see [access control](access-control.md#joining-a-workspace-invitations).

## Environment variables

| Variable | Required | Value |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Project URL, such as `https://<ref>.supabase.co`. Locally `http://127.0.0.1:54321`. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | The project's **publishable** key (`sb_publishable_…`). The legacy anon key also works. |

Optional, server-only (read at runtime by the auth routes, not inlined; no `VITE_` prefix):

| Variable | Value |
|---|---|
| `SITE_URL` | Studio's public URL, such as `https://studio.example.com`. When set, sign-in / sign-out redirects always go there instead of being derived from request headers. Recommended in production. |
| `TRUST_PROXY` | `1` only behind a reverse proxy that overwrites `X-Forwarded-Host` / `X-Forwarded-Proto`. Without it Studio ignores those headers and uses the `Host` header (validated), then the request URL. |

That's all. Don't add a secret or service-role key: nothing in Studio needs one.

Vite only exposes variables with the `VITE_` prefix, and it **inlines them at build time** into both the browser and
the server bundle. Set them where the build runs (for example in Vercel's or Netlify's project settings), and rebuild
after changing them. Locally they come from `apps/studio/.env.local`.

## The OAuth consent page (`/oauth/consent`)

Supaknowledge uses Supabase Auth as an **OAuth 2.1 authorization server** for MCP clients. In `supabase/config.jsonc`:

```jsonc
"auth": {
  "site_url": "http://127.0.0.1:3000",
  "oauth_server": {
    "enabled": true,
    "authorization_url_path": "/oauth/consent",
    "allow_dynamic_registration": true
  }
}
```

The flow:

1. An MCP client connects to `…/functions/v1/mcp?space=<workspace>/<space>`, discovers that it needs OAuth, registers
   itself (dynamic client registration) and opens `/auth/v1/oauth/authorize?...` in the browser.
2. Supabase Auth redirects to `{site_url}/oauth/consent?authorization_id=…`.
3. Studio's page (`src/routes/_authed/oauth/consent.tsx`, data from `src/server/consent.functions.ts`):
   - **Requires sign-in.** The `_authed` guard redirects to `/login?next=/oauth/consent?authorization_id=…`. The user comes
     back after signing in, by password or by email link.
   - Calls `supabase.auth.oauth.getAuthorizationDetails(authorization_id)` on the server, with the user's session.
   - **Redirects immediately** when the response is `{ redirect_url }`. That means the user already consented to this
     client and scopes, so there is nothing to decide. The loader throws `redirect({ href })`, which is a 307 during SSR.
   - Otherwise it shows:
     - the client name, logo and site;
     - **which account is consenting**, with a "switch account" option (it signs out and returns to the same
       authorization request after the new sign-in);
     - that the agent **reads with the user's own permissions** (same spaces and audience groups, every action
       recorded under their account) and can search, read and flag, but never edit, approve or administer;
     - the requested scopes in plain language;
     - the exact redirect URI, with a warning if it uses plain HTTP on a non-loopback host.
   - **Allow** calls `supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })`. **Deny** calls
     `denyAuthorization(...)`. Both then send the browser to the returned `redirect_url`: the authorization code on
     approve, `access_denied` on deny.
4. The client exchanges the code at `/auth/v1/oauth/token` (PKCE). The tokens carry `client_id`. PostgREST and the `mcp`
   function apply RLS as the user, and the database additionally limits OAuth-client tokens to reading, searching,
   logging usage, flagging and recording traces: they cannot create, apply or reject proposals, verify or revert
   concepts, or change workspaces, members, groups, sources or agents, whatever the user's role.

People can see and revoke the applications they approved under **Agents → Connected applications**
(`auth.oauth.listGrants()` / `revokeGrant()`).

To try it without an MCP client:

```bash
# 1. register a public client
curl -s -X POST http://127.0.0.1:54321/auth/v1/oauth/clients/register -H 'Content-Type: application/json' \
  -d '{"client_name":"Test client","redirect_uris":["http://localhost:33418/callback"],"token_endpoint_auth_method":"none"}'
# 2. open in the browser (code_challenge = base64url(sha256(verifier)))
http://127.0.0.1:54321/auth/v1/oauth/authorize?response_type=code&client_id=<id>&redirect_uri=http%3A%2F%2Flocalhost%3A33418%2Fcallback&code_challenge=<challenge>&code_challenge_method=S256&state=xyz&scope=openid%20email
# 3. approve, take ?code= from the redirect, then
curl -s -X POST http://127.0.0.1:54321/auth/v1/oauth/token -d grant_type=authorization_code -d code=<code> \
  -d client_id=<id> -d redirect_uri=http://localhost:33418/callback -d code_verifier=<verifier>
```

## Deploy

Studio is a TanStack Start app inside an npm-workspaces monorepo. `npm run build` uses
[Nitro](https://nitro.build/) (`nitro/vite`), so the same build runs on many hosts. Nitro detects Vercel and Netlify
from their build environments. Elsewhere it builds a Node server, and you can pick another target with
`NITRO_PRESET=<preset>`.

Wherever you deploy, configure Supabase Auth for Studio's URL. In the Supabase dashboard:

1. Under **Authentication → URL Configuration**:
   - **Site URL**: your Studio URL, such as `https://studio.example.com`. OAuth consent and email links use it.
   - **Redirect URLs**: add `https://studio.example.com/**`. Add your preview domains too if you use them, such as
     `https://*-yourteam.vercel.app/**`.
2. Under **Authentication → OAuth Server**: enable it, set the authorization path to `/oauth/consent`, and enable
   dynamic client registration if MCP clients should register themselves.
3. (Optional) For cross-device email confirmation, point the email templates at
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/`. The default PKCE links go to
   `/auth/callback`, which only works in the browser that started the sign-in.

### Vercel

1. **Import the repository** in Vercel and set **Root Directory** to `apps/studio`. Vercel detects the npm workspaces and
   installs from the repo root, so `@supaknowledge/core` resolves.
2. Keep the build command `npm run build`. Nitro's `vercel` preset writes `.vercel/output` (Build Output API), which
   Vercel deploys as static assets plus one Node function.
3. Add the **environment variables** above for Production and Preview. They are read at build time.

### Netlify

1. Set **Base directory** to `apps/studio`, **Build command** to `npm run build`, and **Publish directory** to `dist`.
2. Add the environment variables above. On Netlify, Nitro's `netlify` preset writes the static site to `dist` and the
   server to `.netlify/functions-internal`.

### Any Node host or Docker

```bash
npm ci && npm run build -w @supaknowledge/studio        # writes apps/studio/.output
PORT=3000 node apps/studio/.output/server/index.mjs
```

`.output/` is self-contained: copy it to the server or image and run `node .output/server/index.mjs`. Put a TLS proxy
in front. The auth callbacks and sign-out redirect to the origin the browser used, which is where the session cookies
live, and behind a TLS-terminating proxy Studio itself only sees plain `http`. Tell it the public origin one of two
ways:

- **`SITE_URL=https://studio.example.com`** (recommended): redirects always go there, whatever the request headers say.
- **`TRUST_PROXY=1`**: Studio reads `X-Forwarded-Proto` (and `X-Forwarded-Host` when present). Set it only when the proxy
  overwrites those headers on every request (nginx `proxy_set_header X-Forwarded-Proto $scheme;`, Caddy, ALB, Fly,
  Render); otherwise a client could spoof them.

With neither, Studio uses the `Host` header with the scheme of the connection it received, so behind a TLS proxy
sign-in would redirect to `http://…`.

Every HTML response is sent with `Cache-Control: private, no-store`, because pages carry per-user data. Don't let a
CDN cache them.

## Map of the app

| Route | What it does |
|---|---|
| `/login`, `/signup` | Password or email-link sign-in and sign-up. `?next=` is preserved, and only same-origin paths are allowed (control characters, backslashes and anything that resolves to another origin are rejected). |
| `/auth/callback`, `/auth/confirm` | Server routes: PKCE code exchange and token-hash verification for email links. |
| `/auth/signout` | Server route, POST: signs out and returns to `/login` (keeping a validated `next`). Cross-site POSTs are refused (`Sec-Fetch-Site` / `Origin` check). |
| `/oauth/consent` | The consent screen for MCP clients (see above). |
| `/onboarding` | Pending invitations (accept / decline), then create a workspace, a space, and connect an agent. `?workspace=<slug>` skips to "new space". |
| `/w/<ws>/<space>` | **Inbox**: pending proposals (risk, escalation), open flags (dismiss), and history including auto-applied changes. Updates live. |
| `…/proposals/<id>` | **Review**: rationale; per-change field, frontmatter and body diffs (split or unified); skill files by name and size; citations with quotes and links to documents, traces and flags; evidence the curator consulted but did not cite, listed separately (it still decides visibility and escalation); review notes; approve with an optional note (skill files are then synced into Storage) or reject with a required one; conflicts explained. |
| `…/knowledge` | Concept tree (kind icons, trust, stale, restricted), kind filters, full-text search (`search_knowledge`). |
| `…/knowledge/<path>` | Rendered markdown with footnotes, frontmatter, OKF sources, links and backlinks, files, open flags. History tab with diffs between revisions. Actions: verify, revert (`propose_revert`), suggest an edit, report a problem. |
| `…/suggest[?path=]` | Editor that creates a human proposal (`create_proposal`, atomic), with a live diff and preview. |
| `…/sources` | Sources with status, last sync and errors. Add a source (connector config forms with the keys each connector reads, such as GitHub `ref` or Web `follow_links` / `sitemap` / `max_pages` / `same_origin_only`; audience), set a write-only token, sync now, browse and search documents, upload to `upload` sources. |
| `…/agents` | "Connect as yourself" (OAuth) snippets; headless agents (create shows the key once, plus snippets for Claude Code, Cursor and generic clients; rotate, revoke, restore, delete; revoked agents are marked); connected applications. Revoke, rotate and delete sign the agent's sessions out; its old key stops working within seconds. |
| `…/activity` | Curator runs (run now, cancel a queued or running run, stats, tasks for admins with their input and output loaded on demand), traces with a transcript viewer (reviewers and up), audit log (admins). |
| `…/health` | `knowledge_health`: counts by kind and trust, stale, open and missing flags, flag rate per concept, never-used concepts, last run. |
| `…/graph` | Knowledge graph (`knowledge_graph`): concepts colored by kind, links between them, and for editors the documents, traces, flags and concepts that applied proposals cited. Filters: kind, only concepts with open flags, only stale, citations on or off. Click a node to open it. Below the `md` breakpoint, or with `?view=list`, the same concepts show as a list. See [below](#knowledge-graph-and-recap). |
| `…/recap` | Monthly recap (`knowledge_recap`) for the space or the whole workspace, with a month picker, Download PNG, Copy image and Copy for Slack. See [below](#knowledge-graph-and-recap). |
| `…/settings` | General (name, visibility, delete), curator (model ids, research steps and scope, caps incl. the token budget per run, flag cooldown, stuck-run timeout, auto-dismissing flags, house rules), auto-apply policy (incl. untrusted source kinds) and retention (trace and usage days) — a field for every key of `SpaceSettingsSchema`; members (space and workspace; invite by e-mail, pending invitations), groups and their members, group grants. |

Roles shape the navigation:
- Readers don't see Sources or Activity.
- Editor-only actions are hidden from readers.
- Approving, verifying and starting curator runs need reviewer.
- Sources, members and settings need admin.

`my_space_role` provides the effective role, and the sidebar shows it.

## Knowledge graph and recap

Both pages read one `SECURITY INVOKER` RPC each (migration `20261127000500_graph_recap`), called from a server
function with the person's session. Every table inside is read through RLS, so concepts outside the person's
groups, flags they cannot read, proposals they cannot fully see and evidence outside their audience are neither
drawn nor counted. pgTAP coverage: `supabase/tests/database/16_graph_recap.test.sql`.

**`knowledge_graph(p_space, p_limit default 1000)`** returns the non-deprecated concepts (up to 2000, by path,
with `truncated` when there are more), each with its kind, trust tier, `stale` and number of open flags; the
`concept_links` between visible concepts; and the citations of applied proposals. A citation belongs to its op's
concept, or to every concept the proposal wrote when it has no op. Citations of documents, traces and flags are
kept only when that row is readable, so readers (who cannot read proposals) see no citations and editors see no
trace citations (traces are reviewer-only).

How the graph draws it (`src/components/graph/force-graph.tsx`): `d3-force` computes the layout in the browser,
once per filter change and only while the graph is visible; React renders SVG with hairline edges and
`vector-effect: non-scaling-stroke`, colors from the theme tokens, so light and dark mode both work.

| Mark | Meaning |
|---|---|
| Filled circle in the kind color (skill violet, domain green, data access blue) | Verified concept (human reviewed or machine confirmed) |
| Hollow circle | Unverified concept |
| Dashed amber ring | Stale: past its `stale_after` date |
| Red ring, thicker from three | Open flags |
| Solid line / dashed line | Link between concepts / citation |
| Square, diamond, triangle | Cited source document, trace, flag |

Drag the background to pan, scroll or use the buttons to zoom, hover or focus a node to highlight its neighbours.
Concept nodes are focusable and open with Enter. Documents open for editors, traces for reviewers, and a cited flag
opens the proposal that resolved it.

**`knowledge_recap(p_month, p_space default null, p_workspace default null)`** counts one UTC calendar month for a
space, or for every space of a workspace the person can read. It is computed in SQL so a month is one round trip and
the definitions are tested next to the RLS rules that limit them:

| Field | Definition |
|---|---|
| `concepts_added` | Concepts whose first revision was written in the month |
| `concepts_changed`, `revisions` | Concepts with a later revision in the month; all revisions in the month |
| `most_corrected` | The concept with the most later revisions in the month (ties: most recent change) |
| `applied_by_people` / `_agents` / `_policy` | Proposals behind the month's revisions, by who applied them: a person, an agent reviewer, or the service role (auto-apply policy) |
| `flags_raised`, `flags_fixed` | Flags raised in the month; flags resolved by an applied proposal in the month |
| `top_flagger` | Who raised the most of those fixed flags (name and kind from `profiles`) |
| `median_fix_seconds` | Median time from a flag being raised to the proposal that resolved it being applied |
| `went_stale`, `stale_fixed` | Stable concepts whose `stale_after` fell in the month while that revision was current, and how many of them got a new revision before the month ended |

Proposal counts come from `concept_revisions`, which readers can read, so a reader's recap still says how many
changes people and the policy applied to the knowledge they can see. Flag numbers follow flag RLS: readers count
only their own flags.

The page, the PNG and the Slack text all render from `recapKpis()` in `src/lib/recap.ts`, so they never disagree.
The PNG is drawn on a `<canvas>` in the browser with the current theme's colors (`src/components/recap/recap-image.ts`);
nothing is sent to an external service. Copy image uses the async Clipboard API; where a browser cannot copy images,
Download PNG still works.

## Troubleshooting

- **`npm run studio` says port 3000 is in use.** Something else is on 3000, and Studio won't move to another port:
  Auth redirects only go to `http://127.0.0.1:3000`. Stop the other process.
- **"Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY".** Copy `apps/studio/.env.example` to
  `apps/studio/.env.local`, or set the variables in your host's build settings and rebuild.
- **Signed in on `localhost` but OAuth or email links land on `127.0.0.1` (or the other way round).** Cookies belong to
  one host. Use the same host as `site_url`.
- **"The agents function is not available yet".** Deploy the Edge Functions (`supabase functions deploy`), or serve them
  locally with `npm run functions:serve`.
- **Changes I approved don't show up.** If someone else changed the concept after the curator drafted the proposal,
  `apply_proposal` marks the proposal `conflicted`. The review page lists the conflicting changes. Reject the proposal
  and the curator redrafts it against the current revision.
