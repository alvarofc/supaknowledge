// GitHub connector (REST v3 + GraphQL for discussions).
//   config: { repo: "owner/name", ref?: string (default branch), paths?: string[] (globs, default
//             ["**/*.md", "docs/**"]), include_issues?: boolean, issue_labels?: string[],
//             include_discussions?: boolean, max_file_bytes?: number (default 1 MB),
//             api_url?: string (GitHub Enterprise, default https://api.github.com), acl_strict?: boolean }
//   token:  fine-grained PAT / GitHub App token with Contents: read (+ Issues, Discussions, Metadata;
//           Administration: read to map teams of private repos). Falls back to env GITHUB_TOKEN (only for
//           https://api.github.com - the deployment's token is never sent to a custom api_url), then
//           unauthenticated (public repos, 60 req/h). Credentials only ever go to the api_url origin.
//   cursor: { sha, ref, issues_since, discussions_since }
// Files: first run (or full) lists the git tree of the ref; later runs compare cursor.sha...head and only
// fetch added/modified/renamed files, deleting removed ones. Blob shas are stored as the document version,
// so unchanged files are never refetched. External ids: "file:<path>", "issue:<n>", "pr:<n>", "discussion:<n>".
// ACL: private/internal repos are restricted and map to groups with external_ref {"github_repo": "owner/name"}
// or {"github_team": "org/team-slug"} for each team that has access to the repo.
import { bytesToText, ensureOk, getJson, looksBinary, nextLink, postJson, readBody, readJson, request, TooLargeError } from "./http.ts";
import { assertPublicUrl, BlockedUrlError } from "./net-guard.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { type AclHint, asObject, type Connector, ConfigError, type DocumentChange, optBool, optNumber, optString, stringList, type SyncContext, UpstreamError } from "./types.ts";

export const GITHUB_API = "https://api.github.com";

export interface GithubConfig {
  owner: string;
  name: string;
  ref?: string;
  paths: string[];
  include_issues: boolean;
  issue_labels: string[];
  include_discussions: boolean;
  max_file_bytes: number;
  api_url: string;
}

/** Glob -> RegExp. Supports **, *, ?, {a,b} and [abc]. A pattern without "/" matches the basename anywhere. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.?\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = g.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += g.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(g.includes("/") ? `^${re}$` : `^(?:.*/)?${re}$`);
}

export function makeMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.map((g) => {
    try {
      return globToRegExp(g);
    } catch (e) {
      throw new ConfigError(`config.paths: invalid glob "${g}": ${e instanceof Error ? e.message : e}`);
    }
  });
  return (p) => res.some((r) => r.test(p));
}

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "tif", "tiff", "psd", "pdf", "zip", "gz", "tgz", "bz2", "xz",
  "7z", "rar", "jar", "war", "exe", "dll", "so", "dylib", "bin", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4",
  "mov", "avi", "webm", "wav", "ogg", "flac", "pptx", "docx", "xlsx", "key", "numbers", "pages", "sqlite", "db", "lock",
]);
const PROSE_EXT = new Set(["md", "markdown", "mdx", "txt", "rst", "adoc", "asciidoc", "org", "text", ""]);

function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function fileToMarkdown(path: string, text: string): string {
  const ext = extOf(path);
  if (PROSE_EXT.has(ext)) return text;
  if (ext === "html" || ext === "htm") return htmlToMarkdown(text, { mainContent: true }).markdown;
  // code / config under docs/: keep it fenced so chunking treats it as one block
  return `# ${path}\n\n\`\`\`${ext}\n${text.replace(/\s+$/, "")}\n\`\`\``;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}
interface CompareFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  sha: string | null;
  previous_filename?: string;
}
interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  state_reason?: string | null;
  user: { login: string } | null;
  labels: ({ name: string } | string)[];
  comments: number;
  comments_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { merged_at?: string | null };
}

export const github: Connector<GithubConfig> = {
  kind: "github",
  parseConfig(raw) {
    const o = asObject(raw);
    const repo = optString(o, "repo");
    const m = repo ? /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(repo.replace(/^https:\/\/github\.com\//, "")) : null;
    if (!m) throw new ConfigError('config.repo must look like "owner/name"');
    const paths = stringList(o, "paths");
    makeMatcher(paths); // compile now: a bad glob is a config error, not a retried sync failure
    const apiUrl = (optString(o, "api_url") ?? GITHUB_API).replace(/\/+$/, "");
    let api: URL;
    try {
      api = assertPublicUrl(apiUrl, { requireHttps: true });
    } catch (e) {
      throw new ConfigError(`config.api_url: ${e instanceof Error ? e.message : e}`);
    }
    if (api.search || api.hash) throw new ConfigError("config.api_url must not contain a query or fragment");
    return {
      owner: m[1]!,
      name: m[2]!,
      ref: optString(o, "ref"),
      paths: paths.length ? paths : ["**/*.md", "docs/**"],
      include_issues: optBool(o, "include_issues", false),
      issue_labels: stringList(o, "issue_labels"),
      include_discussions: optBool(o, "include_discussions", false),
      max_file_bytes: optNumber(o, "max_file_bytes", 1_000_000, 1, 50_000_000),
      api_url: apiUrl,
    };
  },

  async *sync(ctx: SyncContext<GithubConfig>): AsyncGenerator<DocumentChange> {
    const { config } = ctx;
    const api = config.api_url;
    const apiOrigin = new URL(api).origin;
    // the deployment-wide GITHUB_TOKEN is only for github.com: never hand it to an admin-chosen host
    const token = ctx.token ?? (api === GITHUB_API ? ctx.env("GITHUB_TOKEN") : undefined) ?? null;
    /** server-provided URLs (Link: next, comments_url) must stay on the API origin: credentials ride along */
    const onApi = (u: string): string => {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        throw new UpstreamError(0, "github returned an invalid URL");
      }
      if (parsed.origin !== apiOrigin) throw new BlockedUrlError(`github returned a URL outside ${apiOrigin}; refusing to follow it`);
      return parsed.toString();
    };
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Supaknowledge-Connector",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const repoPath = `${api}/repos/${config.owner}/${config.name}`;
    const full = `${config.owner}/${config.name}`;
    const matches = makeMatcher(config.paths);
    const cursor = { ...ctx.cursor } as {
      sha?: string;
      ref?: string;
      issues_since?: string;
      discussions_since?: string;
      discussions_scan?: { after: string | null; since: string | null; top?: string };
    };
    let fetched = 0;
    let capped = false;

    const repo = await getJson<{ default_branch: string; private: boolean; visibility?: string; html_url: string; owner: { login: string; type: string } }>(ctx, repoPath, { headers });
    const ref = config.ref ?? repo.default_branch;
    const htmlBase = repo.html_url;

    // ---- ACL
    const restricted = repo.private || repo.visibility === "internal";
    const refs: AclHint["refs"] = [{ github_repo: full }];
    if (restricted && token) {
      try {
        const teams = await getJson<{ slug: string }[]>(ctx, `${repoPath}/teams?per_page=100`, { headers }, { retries: 1 });
        for (const t of teams) refs.push({ github_team: `${config.owner}/${t.slug}` });
      } catch (e) {
        ctx.log(`github: cannot list teams for ${full} (needs Administration: read); mapping by repo only`, { error: String(e) });
      }
    }
    const acl: AclHint = { restricted, refs };

    // ---- files
    const head = (await getJson<{ sha: string }>(ctx, `${repoPath}/commits/${encodeURIComponent(ref)}`, { headers })).sha;
    const prevSha = !ctx.full && cursor.ref === ref ? cursor.sha : undefined;
    type Want = { path: string; sha: string; size?: number };
    let wants: Want[] = [];
    const deletes: string[] = [];
    let snapshot: string[] | null = null;

    let useTree = !prevSha;
    if (prevSha && prevSha !== head) {
      const res = await request(ctx, `${repoPath}/compare/${prevSha}...${head}?per_page=1`, { headers });
      if (res.status === 404 || res.status === 422) {
        await res.body?.cancel();
        useTree = true; // base commit gone (force push / gc)
      } else {
        const cmp = await readJson<{ status: string; files?: CompareFile[] }>(await ensureOk(res, "compare"));
        if (cmp.status !== "ahead" || (cmp.files?.length ?? 0) >= 300) useTree = true; // diverged or too big for compare
        else {
          for (const f of cmp.files ?? []) {
            if (f.status === "renamed" && f.previous_filename && matches(f.previous_filename)) deletes.push(`file:${f.previous_filename}`);
            if (f.status === "removed") {
              if (matches(f.filename)) deletes.push(`file:${f.filename}`);
            } else if (f.sha && matches(f.filename)) wants.push({ path: f.filename, sha: f.sha });
          }
        }
      }
    }
    if (useTree) {
      const tree = await getJson<{ tree: TreeEntry[]; truncated: boolean }>(ctx, `${repoPath}/git/trees/${head}?recursive=1`, { headers });
      wants = tree.tree.filter((e) => e.type === "blob" && matches(e.path)).map((e) => ({ path: e.path, sha: e.sha, size: e.size }));
      if (tree.truncated) ctx.log(`github: tree for ${full}@${ref} is truncated; deletions are not detected this run`);
      else snapshot = wants.map((w) => `file:${w.path}`);
    }
    wants.sort((a, b) => a.path.localeCompare(b.path));

    for (const id of deletes) yield { type: "delete", externalId: id, reason: "removed upstream" };
    for (const w of wants) {
      const id = `file:${w.path}`;
      const prev = ctx.previous(id);
      if (prev && !prev.deleted && prev.version === w.sha) continue;
      const ext = extOf(w.path);
      if (BINARY_EXT.has(ext) || (w.size ?? 0) > config.max_file_bytes) {
        if (snapshot) snapshot = snapshot.filter((x) => x !== id);
        continue;
      }
      if (fetched >= ctx.limit) {
        capped = true;
        break;
      }
      const res = await ensureOk(
        await request(ctx, `${repoPath}/git/blobs/${w.sha}`, { headers: { ...headers, Accept: "application/vnd.github.raw+json" } }),
        `blob ${w.path}`,
      );
      let bytes: Uint8Array;
      try {
        bytes = await readBody(res, config.max_file_bytes, `blob ${w.path}`);
      } catch (e) {
        if (!(e instanceof TooLargeError)) throw e;
        if (snapshot) snapshot = snapshot.filter((x) => x !== id);
        continue;
      }
      if (looksBinary(bytes)) {
        if (snapshot) snapshot = snapshot.filter((x) => x !== id);
        continue;
      }
      fetched++;
      const text = bytesToText(bytes);
      const titleFromMd = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
      yield {
        type: "upsert",
        doc: {
          externalId: id,
          title: titleFromMd ?? w.path.split("/").pop() ?? w.path,
          url: `${htmlBase}/blob/${encodeURIComponent(ref)}/${w.path.split("/").map(encodeURIComponent).join("/")}`,
          content: fileToMarkdown(w.path, text),
          mimeType: ext === "md" || ext === "markdown" || ext === "mdx" ? "text/markdown" : ext === "html" || ext === "htm" ? "text/html" : "text/plain",
          raw: { body: bytes, ext: ext || "txt", contentType: "text/plain; charset=utf-8" },
          version: w.sha,
          metadata: { repo: full, ref, path: w.path, blob_sha: w.sha, commit: head },
          acl,
        },
      };
    }
    if (!capped) {
      if (snapshot) {
        // the snapshot only covers files: keep issues/discussions alive
        const others = ctx.known().filter((id) => !id.startsWith("file:"));
        yield { type: "snapshot", externalIds: [...snapshot, ...others] };
      }
      cursor.sha = head;
      cursor.ref = ref;
    }
    yield { type: "cursor", cursor: { ...cursor } };

    // ---- closed issues / PRs
    if (config.include_issues && !capped) {
      let url: string | null = (() => {
        const u = new URL(`${repoPath}/issues`);
        u.searchParams.set("state", "closed");
        u.searchParams.set("sort", "updated");
        u.searchParams.set("direction", "asc");
        u.searchParams.set("per_page", "100");
        if (config.issue_labels.length === 1) u.searchParams.set("labels", config.issue_labels[0]!);
        if (cursor.issues_since && !ctx.full) u.searchParams.set("since", cursor.issues_since);
        return u.toString();
      })();
      outer: while (url) {
        const res = await ensureOk(await request(ctx, url, { headers }), "issues");
        const issues = await readJson<Issue[]>(res);
        const next = nextLink(res.headers.get("link"));
        url = next ? onApi(next) : null;
        for (const is of issues) {
          const labels = is.labels.map((l) => (typeof l === "string" ? l : l.name));
          const kind = is.pull_request ? "pr" : "issue";
          const id = `${kind}:${is.number}`;
          const prev = ctx.previous(id);
          const wanted = !config.issue_labels.length || labels.some((l) => config.issue_labels.includes(l));
          if (wanted && !(prev && !prev.deleted && prev.version === is.updated_at)) {
            if (fetched >= ctx.limit) {
              capped = true;
              break outer;
            }
            fetched++;
            let comments: { user: { login: string } | null; body: string; created_at: string }[] = [];
            if (is.comments > 0) comments = await getJson(ctx, `${onApi(is.comments_url)}?per_page=100`, { headers });
            yield { type: "upsert", doc: issueDoc(is, kind, labels, comments, full, acl) };
          }
          cursor.issues_since = is.updated_at;
          yield { type: "cursor", cursor: { ...cursor } };
        }
      }
    }

    // ---- discussions (GraphQL; needs a token)
    if (config.include_discussions && !capped) {
      if (!token) ctx.log("github: include_discussions needs a token; skipped");
      else {
        // Pages come newest-first (the API has no "since" filter). Each page is processed as it arrives (bounded
        // memory); `discussions_scan` remembers where a capped scan stopped and the high-water mark it will
        // commit to `discussions_since` once it reaches the previous mark (or the end).
        const graphql = api === GITHUB_API ? `${api}/graphql` : api.replace(/\/v3$/, "") + "/graphql";
        const resume = !ctx.full ? cursor.discussions_scan : undefined;
        const since = resume ? resume.since ?? undefined : ctx.full ? undefined : cursor.discussions_since;
        let top = resume?.top;
        let after: string | null = resume?.after ?? null;
        let done = false;
        pages: while (true) {
          const r: { data?: { repository?: { discussions: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Discussion[] } } }; errors?: { message: string }[] } =
            await postJson(ctx, graphql, { query: DISCUSSIONS_QUERY, variables: { owner: config.owner, name: config.name, after } }, { headers });
          if (r.errors?.length) throw new UpstreamError(200, `github graphql: ${r.errors.map((e) => e.message).join("; ")}`);
          const d = r.data?.repository?.discussions;
          if (!d) {
            done = true;
            break;
          }
          for (const n of d.nodes) {
            if (since && n.updatedAt <= since) {
              done = true;
              break pages;
            }
            if (!top || n.updatedAt > top) top = n.updatedAt;
            const id = `discussion:${n.number}`;
            const prev = ctx.previous(id);
            if (prev && !prev.deleted && prev.version === n.updatedAt) continue;
            if (fetched >= ctx.limit) {
              capped = true;
              // resume at this page (already emitted items are skipped by version)
              cursor.discussions_scan = { after, since: since ?? null, top };
              break pages;
            }
            fetched++;
            yield { type: "upsert", doc: discussionDoc(n, full, acl) };
          }
          if (!d.pageInfo.hasNextPage) {
            done = true;
            break;
          }
          after = d.pageInfo.endCursor;
          cursor.discussions_scan = { after, since: since ?? null, top };
          yield { type: "cursor", cursor: { ...cursor } };
        }
        if (done) {
          delete cursor.discussions_scan;
          if (top && (!cursor.discussions_since || top > cursor.discussions_since)) cursor.discussions_since = top;
          yield { type: "cursor", cursor: { ...cursor } };
        }
      }
    }
    yield { type: "cursor", cursor: { ...cursor }, more: capped };
  },
};

function issueDoc(
  is: Issue,
  kind: "issue" | "pr",
  labels: string[],
  comments: { user: { login: string } | null; body: string; created_at: string }[],
  repo: string,
  acl: AclHint,
) {
  const meta = [
    `- **State:** ${is.state}${is.state_reason ? ` (${is.state_reason})` : ""}${kind === "pr" && is.pull_request?.merged_at ? " (merged)" : ""}`,
    labels.length ? `- **Labels:** ${labels.join(", ")}` : null,
    `- **Author:** @${is.user?.login ?? "ghost"}`,
    `- **Opened:** ${is.created_at}${is.closed_at ? ` · **Closed:** ${is.closed_at}` : ""}`,
  ].filter(Boolean).join("\n");
  const parts = [`# ${is.title} (${kind === "pr" ? "PR" : "issue"} #${is.number})`, meta, (is.body ?? "").trim()];
  if (comments.length) {
    parts.push("## Comments");
    for (const c of comments) parts.push(`**@${c.user?.login ?? "ghost"}** (${c.created_at}):\n\n${c.body.trim()}`);
  }
  return {
    externalId: `${kind}:${is.number}`,
    title: `${is.title} (#${is.number})`,
    url: is.html_url,
    content: parts.filter(Boolean).join("\n\n"),
    mimeType: "text/markdown",
    raw: { body: JSON.stringify({ issue: is, comments }, null, 2), ext: "json", contentType: "application/json" },
    author: is.user?.login ?? null,
    updatedAt: is.updated_at,
    version: is.updated_at,
    metadata: { repo, number: is.number, kind, labels, state: is.state },
    acl,
  };
}

interface Discussion {
  number: number;
  title: string;
  url: string;
  body: string;
  updatedAt: string;
  createdAt: string;
  author: { login: string } | null;
  category: { name: string } | null;
  answer: { body: string; author: { login: string } | null } | null;
  comments: { nodes: { body: string; createdAt: string; author: { login: string } | null }[] };
}

const DISCUSSIONS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 25, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url body updatedAt createdAt
        author { login }
        category { name }
        answer { body author { login } }
        comments(first: 30) { nodes { body createdAt author { login } } }
      }
    }
  }
}`;

function discussionDoc(d: Discussion, repo: string, acl: AclHint) {
  const parts = [
    `# ${d.title} (discussion #${d.number})`,
    `- **Category:** ${d.category?.name ?? "General"}\n- **Author:** @${d.author?.login ?? "ghost"}\n- **Created:** ${d.createdAt}`,
    d.body.trim(),
  ];
  if (d.answer) parts.push(`## Accepted answer (@${d.answer.author?.login ?? "ghost"})\n\n${d.answer.body.trim()}`);
  if (d.comments.nodes.length) {
    parts.push("## Comments");
    for (const c of d.comments.nodes) parts.push(`**@${c.author?.login ?? "ghost"}** (${c.createdAt}):\n\n${c.body.trim()}`);
  }
  return {
    externalId: `discussion:${d.number}`,
    title: `${d.title} (discussion #${d.number})`,
    url: d.url,
    content: parts.filter(Boolean).join("\n\n"),
    mimeType: "text/markdown",
    raw: { body: JSON.stringify(d, null, 2), ext: "json", contentType: "application/json" },
    author: d.author?.login ?? null,
    updatedAt: d.updatedAt,
    version: d.updatedAt,
    metadata: { repo, number: d.number, kind: "discussion", category: d.category?.name ?? null },
    acl,
  };
}
