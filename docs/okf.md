# OKF and Agent Skills

Postgres is where Supaknowledge keeps knowledge; files are how it travels. Supaknowledge reads and writes two formats:

- **OKF bundles** (Open Knowledge Format, v0.3): a folder of markdown concepts with YAML frontmatter, an
  `index.md` per folder and a `log.md`.
- **[Agent Skills](https://agentskills.io)**: `skills/<name>/SKILL.md` plus the files next to it, the format
  Claude Code, Deep Agents and other agents load skills from.

One bundle can hold both. `kf import`, `kf lint`, `kf export` and `kf pull` ([CLI](cli.md)) and the `bundle`
function use the same code: `importBundle()`, `exportBundle()` and `lintConcept()` in
`packages/core/src/okf.ts`. [`examples/revenue-report/knowledge`](../examples/revenue-report/knowledge) is a
complete example.

```
knowledge/
  index.md                          okf_version, title, description, license
  data/bigquery/revenue.md          concept "data/bigquery/revenue"
  metrics/arr.md                    concept "metrics/arr"
  finance/board-pack.md             concept with x-supaknowledge-audience: [finance]
  skills/revenue-report/SKILL.md    skill concept "skills/revenue-report"
  skills/revenue-report/templates/report-template.md   file of that skill
```

## Concepts

Every `.md` file whose frontmatter has a `type` is a concept. Its **path** is the file path without `.md`
(`metrics/arr`). Files without frontmatter or without `type` (a `README.md`, an `AGENTS.md`) are not concepts and
are skipped; so are `index.md`, `log.md` and anything under a dot-folder. Paths use letters, digits, `_ . / -`;
`index` and `log` are reserved names.

```markdown
---
type: Metric
title: Annual Recurring Revenue (ARR)
description: ARR is 12 times the recurring revenue recognized in a month; services and other one-off revenue are excluded.
tags: [metrics, revenue]
sources:
  - id: finance-handbook-arr
    title: Finance handbook, "Revenue metrics"
    resource: https://handbook.acme.example/finance/revenue-metrics#arr
---

# Annual Recurring Revenue (ARR)

ARR is the recognized subscription revenue of the last month of a period, multiplied by 12.[^finance-handbook-arr]
See the [revenue fact table](../data/bigquery/revenue.md).

[^finance-handbook-arr]: Finance handbook, "Revenue metrics", ARR section.
```

| Frontmatter | Column | Notes |
|---|---|---|
| `type` | `type` | Required. Free text ("Metric", "Policy", "BigQuery Table") |
| `title` | `title` | Default: the first `# heading`, then the file name |
| `description` | `description` | One sentence. Default: the first sentence of the body |
| `tags` | `tags` | A list (or a comma-separated string) |
| `status` | `status` | `draft` or `deprecated`; anything else is `stable`. Drafts never show up in search |
| `superseded_by` | `superseded_by` | Path of the concept that replaces this one |
| `stale_after` | `stale_after` | RFC 3339 timestamp; after it, agents see the concept as stale and the nightly sweep re-validates it |
| `x-supaknowledge-kind` | `kind` | `skill`, `domain` or `data_access`. Without it the kind is inferred from `type`: names like *table, dataset, view, endpoint, API, query, warehouse, database, schema, column, metric source, attested computation, BigQuery, Snowflake, Postgres, Salesforce* mean `data_access`, everything else `domain` |
| `x-supaknowledge-audience` | `audience` | Group slugs, e.g. `[finance]` (see [audiences](#audiences)) |
| `generated`, `verified` | derived | Written on export from the revision and verification history; ignored on import |
| anything else | `frontmatter` (jsonb) | Kept verbatim: `sources`, `resource`, `usage_window`, your own `x-acme-*` keys |

The **body** is the markdown after the frontmatter.

### Links

Standard markdown links between concept files are the knowledge graph (`concept_links`), shown as links and
backlinks in Studio and `read_concept`:

- relative to the file: `../data/bigquery/revenue.md`, `nrr.md#definition`;
- bundle-root relative with a leading `/`: `/metrics/arr.md`;
- `[[wikilinks]]`, images and links inside code are not links; external URLs are kept as external.

Links to concepts that do not exist yet are allowed (they show as missing until the concept appears).

Inside a `SKILL.md`, write links to other concepts **bundle-root relative** (`/metrics/arr.md`). The link graph
resolves relative links of a skill against the skill's parent folder rather than its own folder, so `../../x.md`
from `skills/<name>/SKILL.md` does not resolve; root-relative links work everywhere.

### Sources and footnotes

Supaknowledge follows OKF's provenance convention: claims carry markdown footnotes (`[^label]`), and the frontmatter
`sources` list has one entry per label with at least an `id` (the label) and a `resource` (a URL). The curator
writes both for every claim it adds; its `resource` values point at Supaknowledge evidence
(`supaknowledge://flags/<id>`, `supaknowledge://traces/<id>`, `supaknowledge://documents/<id>`, `supaknowledge://concepts/<id>`) or at the
source document's URL, with `title`, `author` and `last_modified` when known. See [curator](curator.md#provenance).

## Skills

Every `SKILL.md` owns its folder: the concept path is the folder (`skills/revenue-report`), its kind is `skill`,
and every other file under the folder (scripts, templates, references, binaries) becomes a **concept file**,
stored in the `concept-files` Storage bucket once the import is applied. Text files travel as UTF-8, others as
base64, inside the proposal's ops (`after.files`) so reviewers approve exactly those files. When the proposal is
applied, `bundle/sync-files` copies them into Storage and then strips the inline content from the proposal: the
ops keep each file's path, encoding, content type, size and sha256 (`"stripped": true`), so applied proposals do
not keep megabytes of base64 around, and Studio and `kf proposal <id>` still list the files by name.

```markdown
---
name: revenue-report
description: Build Acme's monthly revenue report (revenue by region and product line, ARR and NRR) in the house format. Use when someone asks for a revenue report, a monthly revenue summary, or revenue numbers for leadership.
license: Apache-2.0
metadata:
  owner: finance-data
---

# Revenue report
...
```

| Field | Rule |
|---|---|
| `name` | Lowercase letters, digits and hyphens, 1–64 characters. On export it is the last segment of the path |
| `description` | Required, at most 1,024 characters; say what the skill does and when to use it |
| body | Under 500 lines; move detail into `references/` |
| other keys (`license`, `compatibility`, `allowed-tools`, `metadata.*`) | Kept verbatim |

Supaknowledge state that the Agent Skills spec has no field for lives under `metadata`, with an `supaknowledge-` prefix:
`supaknowledge-type` (when not `Skill`), `supaknowledge-title`, `supaknowledge-tags`, `supaknowledge-status`, `supaknowledge-stale-after`,
`supaknowledge-audience` and, on export, `supaknowledge-revision`. The title defaults to the first `# heading`;
`supaknowledge-title` is written on export only when the title differs from that heading, so the title survives a
round trip either way.

## Audiences

`x-supaknowledge-audience` (or `metadata.supaknowledge-audience` in a skill) restricts a concept to members of any of the named
groups of the workspace. Group slugs, not ids, are written, so a bundle moves between workspaces that use the same
slugs. On import:

- the slugs are resolved in the target workspace. **Create the groups before importing**: a concept that names
  a slug that does not exist is skipped with a warning (`audience group(s) "finance" do not exist in this
  workspace`), never imported without its restriction (fail-closed);
- you cannot import a concept into an audience you are not part of: it is skipped with a warning;
- updating an existing restricted concept from a bundle that names no audience keeps the restriction.

`kf export --public` leaves restricted concepts (and their log entries) out. Without it, an export contains
exactly what the exporting person can read.

## Export

`kf export <dir>` (and `GET /functions/v1/bundle/export`) writes:

- one file per concept (`<path>.md`, or `<path>/SKILL.md` plus its files);
- `generated: {by, at}` from the latest revision and `verified: [{by, at}]` for the current revision;
- `x-supaknowledge-kind` only when the kind differs from what `type` implies;
- an `index.md` per folder listing its concepts and subfolders, with `okf_version: "0.3"`, the space name and
  description at the root;
- `log.md`: the latest 200 revisions, newest first, grouped by day.

Keys are written in a stable order (`type`, `title`, `description`, `resource`, `tags`, `status`, …, then the rest
in their original order). `kf export` and `kf pull` record what they wrote in a manifest and never overwrite files
you edited or did not write (see [CLI](cli.md#knowledge-in-and-out)).

## Round-trip guarantees

- **Import of an export changes nothing.** `generated`, `verified` and `metadata.supaknowledge-*` are derived again
  rather than stored, so re-importing an export reports every concept as unchanged.
- **Unknown frontmatter survives** import → storage → export as data: same keys, same values.
- **Formatting may change**: YAML is re-serialised (key order, quoting, list style; comments are not kept), and
  bodies are trimmed to end with one newline.
- Frontmatter is YAML 1.2 (core schema): duplicate keys, custom tags and non-mapping frontmatter are rejected
  with a warning for that file.
- **Every import is one proposal.** `kf import` without `--apply` leaves it pending for review; with `--apply`
  (reviewer role) it is applied at once. Unchanged concepts are not part of it.

## Checking a bundle

```bash
npx kf lint ./knowledge           # works offline when you are not signed in
```

It reports invalid paths, reserved names, missing `type` or `title`, invalid skill names, missing or too-long skill
descriptions, skill bodies over 500 lines, descriptions over 400 characters for other concepts, bad
`stale_after` values and unsafe file paths.
