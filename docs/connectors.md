# Source connectors

Connectors pull raw evidence (Notion pages, Slack conversations, GitHub docs and issues, Drive files, web pages,
uploads) into `public.source_documents`. Every write is chunked and embedded automatically (`kf_embed` queue), and
the curator reads changed documents on its next run.

```
pg_cron ──(every 5 min) util.enqueue_due_sources()──► pgmq kf_ingest ──(every 30 s) util.process_queue──►
  Edge Function `connectors` ──► upstream API ──► Storage bucket `sources` (raw export)
                                             └──► source_documents (markdown) ──trigger──► kf_embed ──► source_chunks
```

- Code: `supabase/functions/connectors/` (`index.ts` worker + upload route, `lib/<kind>.ts` connectors,
  `lib/engine.ts` bookkeeping, `lib/markdown.ts` conversions, `test/` unit tests with recorded fixtures).
- Raw originals/exports go to `sources/<space_id>/<source_id>/<safe-external-id>-<hash>.<ext>`.
- Sync is incremental from `sources.cursor`. `request_source_sync()` (the "Sync now" button) sends `full: true`,
  which ignores the cursor and also reconciles deletions.

## Creating a source

Only space **admins** inside the source's audience can create sources and set their secrets (RLS).

**SQL / PostgREST (as the admin user):**

```sql
insert into public.sources (space_id, connector, name, config, audience, sync_interval)
values ('<space-uuid>', 'github', 'handbook repo',
        '{"repo": "acme/handbook", "paths": ["docs/**", "**/*.md"], "include_issues": true}',
        '{}',            -- audience: empty = everyone who can read the space; or an array of group ids
        '1 hour');

select public.set_source_secret('<source-uuid>', '<token>');   -- stored in Vault, never readable via the API
select public.request_source_sync('<source-uuid>');            -- run now (otherwise: within sync_interval)
```

With supabase-js, insert with `Prefer: return=minimal` (or select explicit columns): `sources.secret_id` is not
selectable by users, so `select *` / `return=representation` fails.

**Studio / CLI:** the Sources page and the `kf` CLI use the same three steps: insert the `sources` row as the
signed-in admin, call `set_source_secret`, then `request_source_sync`. Nothing else is needed.

Status lives on the row: `status` (`active` | `paused` | `error`), `last_synced_at`, `last_error`, `cursor`.
Set `status = 'paused'` to stop syncing. A source goes to `error` immediately on bad config or rejected
credentials, and after 5 failed attempts otherwise; fix it and call `request_source_sync()` to resume.

## Common config keys

| Key | Default | Meaning |
|---|---|---|
| `acl_strict` | `false` | Skip upstream-restricted items (private channel, private repo, unshared file) that no group maps to, instead of giving them the source audience. Items synced earlier are marked deleted. |

## Connectors

### Notion (`notion`)

| Config | Type | Default |
|---|---|---|
| `database_ids` | string[] (ids or URLs) | – |
| `page_ids` | string[] (ids or URLs) | – (at least one of the two) |
| `include_child_pages` | boolean | `true` |
| `max_depth` | number (child page depth) | `3` |

- **Token:** internal integration secret (`ntn_…` / `secret_…`). Capabilities: *Read content*; *Read user
  information* is optional (author names). Share every database/page with the integration (… → Connections).
- Databases are queried with a `last_edited_time` filter (ascending) from `cursor.databases[id]`; pages are
  re-checked with a cheap `GET /pages/{id}` and re-rendered only when `last_edited_time` moved. Block children are
  fetched recursively and converted to markdown (headings, paragraphs, lists, to-dos, code, quote, callout,
  toggles, tables, links, bookmarks, equations, columns, synced blocks). Database properties are rendered as a
  key/value list. Raw export: page + block JSON.
- External id: page id. Uses API version `2022-06-28`.

### Slack (`slack`)

| Config | Type | Default |
|---|---|---|
| `channels` | string[] of channel ids (`C…`/`G…`) | required |
| `include_threads` | boolean | `true` |
| `min_reactions` | number (keep only messages with ≥ N reactions) | `0` |
| `since_days` | number (initial backfill) | `90` |
| `thread_lookback_days` | number (re-check older days for new replies) | `7` |

- **Token:** bot token `xoxb-…` with `channels:history`, `channels:read`, `groups:history`, `groups:read`,
  `users:read` (add `im:*`/`mpim:*` for DMs). Invite the bot to every channel (`/invite @bot`).
- One document per channel per **UTC day** (`C123:2026-11-24`) with the day's messages and thread replies; user
  ids are resolved to display names. A day is rebuilt when it gets new messages, or new thread replies within the
  lookback window. Channels removed from the config have their documents marked deleted.
- Rate limits: 429 + `Retry-After` is honoured. Note Slack's 2025 limits for *non-Marketplace distributed* apps
  (`conversations.history`/`replies` at 1 req/min, 15 messages); internal custom apps are not affected.

### GitHub (`github`)

| Config | Type | Default |
|---|---|---|
| `repo` | `"owner/name"` | required |
| `ref` | branch/tag/sha | default branch |
| `paths` | globs (`**`, `*`, `?`, `{a,b}`; no `/` = match basename anywhere) | `["**/*.md", "docs/**"]` |
| `include_issues` | boolean (closed issues + PRs, with labels and comments) | `false` |
| `issue_labels` | string[] (only issues carrying any of these) | all |
| `include_discussions` | boolean (GraphQL, needs a token) | `false` |
| `max_file_bytes` | number | `1000000` |
| `api_url` | GitHub Enterprise API base (https only, public address, no query or fragment) | `https://api.github.com` |

- **Token:** fine-grained PAT or GitHub App installation token with *Contents: read*, *Metadata: read*;
  *Issues/Pull requests: read* for issues, *Discussions: read* for discussions, *Administration: read* to map
  teams of private repos. Without a source token it falls back to the `GITHUB_TOKEN` function secret **only when
  `api_url` is `https://api.github.com`** (the deployment's token is never sent to an admin-chosen host), then
  unauthenticated (public repos, 60 requests/hour). Credentials only ever go to the `api_url` origin.
- First/full sync lists the git tree; later runs call `compare/<cursor.sha>...<head>` and fetch only
  added/modified/renamed files, deleting removed ones (falls back to the tree on force-push, >300 files, or a
  missing base). Blob shas are stored as versions, so unchanged files are never downloaded again. Binary files and
  files over `max_file_bytes` are skipped; non-prose files under the globs are stored as fenced code.
- External ids: `file:<path>`, `issue:<n>`, `pr:<n>`, `discussion:<n>`.

### Google Drive (`gdrive`)

| Config | Type | Default |
|---|---|---|
| `folder_ids` | string[] | required (subfolders are included) |
| `subject` | user email to impersonate (domain-wide delegation) | – |
| `include_pdfs` | boolean | `true` |
| `max_file_bytes` | number | `10000000` |

- **Secret:** a service-account key JSON (share the folders with its `client_email`, or enable domain-wide
  delegation for scope `https://www.googleapis.com/auth/drive.readonly` and set `subject`), or an OAuth
  `authorized_user` JSON (`client_id`, `client_secret`, `refresh_token`) with the same scope. The JWT is signed
  in the function with WebCrypto (RS256). Tokens are always requested from `https://oauth2.googleapis.com/token`:
  a `token_uri` in the JSON is accepted only if it is one of Google's own token endpoints and is otherwise
  rejected as a config error, so whoever can set the secret cannot make the connector post credentials to another
  URL.
- **Folder mappings are hierarchical:** the most specific mapped folder wins. A file in `finance/q3` where
  `finance` maps to group `finance` and the synced root maps to `all-staff` gets only `finance`, not both. The
  shared drive (`gdrive_drive`) counts only when no folder matched, and Google groups the file is shared with
  directly (`google_group`) narrow that result (intersection; if it is empty, the folder mapping is kept).
- Lists files with `modifiedTime >= cursor.since` (ascending) and applies the `changes` feed for deletions,
  trashing and moves out of the synced folders. Google Docs export as `text/markdown` (fallback `text/plain`),
  Sheets as CSV (first sheet), Slides as text; `.md`/`.txt`/`.html`/`.pdf` files are downloaded.
- External id: Drive file id.

### Web (`web`)

| Config | Type | Default |
|---|---|---|
| `urls` | string[] | – |
| `sitemap` | URL of a sitemap or sitemap index | – (at least one of the two) |
| `max_pages` | number | `50` (max 1000) |
| `same_origin_only` | boolean | `true` |
| `follow_links` | boolean (crawl links found on pages) | `false` |
| `include` / `exclude` | URL substrings or `/regex/` | – |
| `user_agent` | string | `Supaknowledge-Connector/1.0` |

- No token. `robots.txt` is honoured (Allow/Disallow with `*`/`$`, longest match wins, `Crawl-delay` up to 10 s;
  a 5xx robots.txt means "disallow all"). Main content is extracted (`<main>`/`<article>`, navigation, headers,
  footers, sidebars, cookie banners, scripts and styles removed) and converted to markdown.
- `ETag`/`Last-Modified` are kept in `cursor.pages` and sent as `If-None-Match`/`If-Modified-Since`.
  404/410 pages are deleted. On a completed run, pages no longer in the config/sitemap are deleted.
- External id: the URL.

### Upload (`upload`)

No sync. Documents come from Studio or the CLI through the authenticated route on the same function:

```
POST /functions/v1/connectors/upload
Authorization: Bearer <user JWT | OAuth token | skn_ agent key>
```

- multipart/form-data: `source_id`, `file` (`.md`, `.txt`, `.html`, `.pdf`; max 20 MB), optional `title`,
  `external_id`, `url`
- or JSON: `{ "source_id", "content", "title"?, "external_id"?, "format"?: "md" | "txt" | "html", "url"? }`

The caller must see the source through RLS (space **editor+** inside the source audience) and the source must be an
`upload` source. `external_id` defaults to the slugged file name (or title), so uploading the same name again
replaces the document. PDFs are stored as-is with text extracted best effort (`unpdf`); when extraction fails the
document has empty content and `metadata.extraction_error`.
Response: `201 { document, changed: true }` on a new/changed document, `200 { …, changed: false }` when the content
hash did not change. Errors: 400 bad input, 401 no/invalid token, 403 not an editor, 404 source not visible,
409 not an upload source / paused, 413 too large, 415 unsupported type.

```bash
curl -X POST "$SUPABASE_URL/functions/v1/connectors/upload" -H "Authorization: Bearer $JWT" \
  -F source_id=<uuid> -F file=@policy.pdf
```

## Access control (audiences)

Documents inherit `sources.audience`. Connectors report upstream ACL hints, and groups opt in to them through
`groups.external_ref`. A group matches when its `external_ref` contains the key/value (values may be a string or an
array of strings):

| Connector | Restricted upstream when | `external_ref` keys matched |
|---|---|---|
| slack | private channel / DM | `{"slack_channel": "C0123"}` |
| github | private or internal repo | `{"github_repo": "acme/handbook"}`, `{"github_team": "acme/finance"}` (teams with repo access) |
| gdrive | not shared with "anyone" / the whole domain | `{"gdrive_folder": "<folder id or any ancestor up to the configured root>"}` (the most specific mapped folder wins), `{"google_group": "sales@acme.com"}`, `{"gdrive_drive": "<shared drive id>"}` (only when no folder matched) |
| notion | never (the API has no permissions) | `{"notion_database": "<id>"}`, `{"notion_page": "<root page id>"}` |
| web, upload | never | – |

```sql
update public.groups set external_ref = '{"slack_channel": "C0FINANCE"}' where slug = 'finance';
```

Rules (`lib/acl.ts`), which guarantee a document is **never wider than its source**:

- Source audience empty → document audience = the matched groups (or empty if none match).
- Source audience restricted → document audience = matched ∩ source. If the intersection is empty the document
  keeps the source audience (OR-lists cannot express "members of both").
- Restricted upstream item with no matching group → source audience, or skipped (and retracted) with
  `acl_strict: true`.

The decision is recorded in `metadata.acl` (`mode`: `inherit` | `mapped` | `unmapped` | `disjoint`). Audience changes
are re-applied on the next sync even when the content did not change.

## Document lifecycle

- `content_hash` = sha-256 of the markdown. Rows are only written when the hash, title or audience changed (a new
  upstream version with identical content only updates `metadata.version`). `changed_at` moves only on content
  or deletion changes, so the curator sees real changes.
- Deleted upstream → `deleted_at` set and chunks dropped (search already hides deleted documents). If the document
  comes back it is undeleted and re-embedded.
- `metadata.version` holds the cheap upstream version (blob sha, `last_edited_time`, `modifiedTime:md5`, ETag) that
  lets connectors skip downloads.

## Outbound requests (SSRF guard)

Source configs come from space admins, so every outbound connector request goes through a guard
(`lib/net-guard.ts`):

- only `http(s)`, and `https` whenever credentials (`Authorization`, `Cookie`) are attached;
- no loopback, private, CGNAT, link-local / cloud-metadata, multicast or reserved addresses (IPv4 and IPv6,
  including IPv4-mapped, NAT64 and 6to4 forms), and no internal host names (single-label names such as `kong` or
  `db`, `localhost`, `*.internal`, `*.local`, `*.svc`, `*.home.arpa`…);
- host names are resolved (A + AAAA) and refused when any address is not public;
- redirects are followed by hand (at most 5 hops), each hop is checked again, and credentials are dropped when a
  hop changes origin.

A refused URL is a config error (the sync fails with a message and is not retried until the config changes).
Self-hosted setups that need to sync intranet sites can set the function secret
`KF_CONNECTORS_ALLOW_PRIVATE_NETWORK=true`, which disables the private-network checks for every source.

## Limits and tuning

| Limit | Value | Override |
|---|---|---|
| documents fetched per run | 200 | env `CONNECTOR_DOC_LIMIT` |
| time budget per run | 120 s | env `CONNECTOR_TIME_BUDGET_MS` (keep below the platform wall-clock limit) |
| upstream response body | 20 MiB, read as a stream and cut off past the limit; an oversized file or page is skipped, an oversized API response fails the run | env `KF_CONNECTOR_MAX_BYTES` (bytes) |
| stored content per document | 2,000,000 chars (`metadata.truncated`) | – |
| upload size | 20 MB (bucket limit 50 MB) | – |
| chunks embedded per document | 400 (embed worker) | – |

When a run hits the cap or the time budget, it saves its cursor checkpoint and re-enqueues itself (5 s delay), so a
large backfill proceeds in batches. HTTP 429/5xx are retried with `Retry-After` (or exponential backoff) up to 30 s
inside a run; longer waits fail the job, which retries after the queue visibility timeout (400 s).

## Known gaps

- Slack: new thread replies on messages older than `thread_lookback_days` are picked up only by a full sync.
- Notion: child pages of *database* pages are only discovered when the parent page changes (or on a full sync);
  databases with multiple data sources (API 2025-09-03) are not supported yet.
- GitHub: reopened issues keep their closed-state document; discussions are limited to 30 comments each.
- Drive: Sheets export only the first sheet; files moved out of the synced folders are detected through the
  changes feed (or a full sync).
- Two runs of the same source can overlap (e.g. "Sync now" during a long backfill). Writes are idempotent upserts,
  so this only duplicates work.
