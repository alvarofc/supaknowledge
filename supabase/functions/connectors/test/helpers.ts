// Test helpers: a routing fake fetch, an in-memory DocumentStore, and a runner that collects changes.
import type { DocumentRow, DocumentStore, ExistingDoc } from "../lib/engine.ts";
import type { Connector, Cursor, DocumentChange, FetchLike, PreviousDoc, RawExport, SyncContext } from "../lib/types.ts";

export interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
}

type Handler = (req: { url: URL; method: string; headers: Headers; body: string | null; calls: number }) =>
  | Response
  | Promise<Response>
  | unknown;

/**
 * Routes are "METHOD urlprefix-or-regex". A handler returning a non-Response value is sent as JSON 200.
 * Unmatched requests fail the test loudly.
 */
export function fakeFetch(routes: [string, Handler][]): FetchLike & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const counts = new Map<number, number>();
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = init?.body === undefined || init?.body === null ? null : typeof init.body === "string" ? init.body : String(init.body);
    calls.push({ method, url: url.toString(), headers, body });
    for (let i = 0; i < routes.length; i++) {
      const [spec, h] = routes[i]!;
      const sp = spec.indexOf(" ");
      const m = spec.slice(0, sp);
      const pat = spec.slice(sp + 1);
      if (m !== method && m !== "*") continue;
      const full = url.toString();
      const ok = pat.startsWith("^") ? new RegExp(pat).test(full) : full.startsWith(pat);
      if (!ok) continue;
      const n = (counts.get(i) ?? 0) + 1;
      counts.set(i, n);
      const out = await h({ url, method, headers, body, calls: n });
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }) as FetchLike & { calls: Recorded[] };
  f.calls = calls;
  return f;
}

export async function fixture<T = unknown>(name: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url)));
}

export async function fixtureText(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));
}

export function makeCtx<C>(
  connector: Connector<C>,
  rawConfig: unknown,
  opts: {
    fetch: FetchLike;
    token?: string | null;
    cursor?: Cursor;
    full?: boolean;
    limit?: number;
    previous?: Record<string, Partial<PreviousDoc>>;
    env?: Record<string, string>;
    now?: Date;
  },
): SyncContext<C> {
  const prev = opts.previous ?? {};
  return {
    config: connector.parseConfig(rawConfig),
    token: opts.token === undefined ? "test-token" : opts.token,
    cursor: opts.cursor ?? {},
    full: opts.full ?? false,
    fetch: opts.fetch,
    log: () => {},
    limit: opts.limit ?? 200,
    previous: (id) => prev[id] ? { contentHash: "", version: null, deleted: false, children: [], ...prev[id] } : undefined,
    known: () => Object.keys(prev),
    now: () => opts.now ?? new Date("2026-11-24T12:00:00Z"),
    sleep: async () => {},
    env: (n) => opts.env?.[n],
  };
}

export async function collect<C>(connector: Connector<C>, ctx: SyncContext<C>): Promise<DocumentChange[]> {
  const out: DocumentChange[] = [];
  for await (const ch of connector.sync(ctx)) out.push(ch);
  return out;
}

export function upserts(changes: DocumentChange[]) {
  return changes.flatMap((c) => (c.type === "upsert" ? [c.doc] : []));
}

export function lastCursor(changes: DocumentChange[]) {
  const c = changes.filter((x) => x.type === "cursor").pop();
  return c && c.type === "cursor" ? c : undefined;
}

export class MemoryStore implements DocumentStore {
  docs = new Map<string, DocumentRow & { id: string }>();
  deleted = new Set<string>();
  raw = new Map<string, RawExport>();
  cursors: Cursor[] = [];
  reembedded: string[] = [];
  touched: string[] = [];
  private seq = 0;

  existing(): Promise<Map<string, ExistingDoc>> {
    const m = new Map<string, ExistingDoc>();
    for (const d of this.docs.values()) {
      m.set(d.external_id, {
        id: d.id, external_id: d.external_id, content_hash: d.content_hash, audience: d.audience, title: d.title,
        deleted_at: this.deleted.has(d.id) ? "2026-01-01T00:00:00Z" : null, storage_path: d.storage_path,
        version: (d.metadata.version as string) ?? null, children: (d.metadata.children as string[]) ?? [], acl: d.metadata.acl,
      });
    }
    return Promise.resolve(m);
  }
  putRaw(path: string, raw: RawExport) {
    this.raw.set(path, raw);
    return Promise.resolve();
  }
  upsert(row: DocumentRow) {
    const cur = this.docs.get(row.external_id);
    const id = cur?.id ?? `doc-${++this.seq}`;
    this.docs.set(row.external_id, { ...row, id });
    this.deleted.delete(id);
    return Promise.resolve({ id });
  }
  touch(id: string, patch: { metadata?: Record<string, unknown>; audience?: string[] }) {
    this.touched.push(id);
    for (const d of this.docs.values()) {
      if (d.id !== id) continue;
      if (patch.metadata) d.metadata = patch.metadata;
      if (patch.audience) d.audience = patch.audience;
    }
    return Promise.resolve();
  }
  markDeleted(ids: string[]) {
    for (const id of ids) this.deleted.add(id);
    return Promise.resolve();
  }
  reembed(id: string) {
    this.reembedded.push(id);
    return Promise.resolve();
  }
  saveCursor(c: Cursor) {
    this.cursors.push(c);
    return Promise.resolve();
  }
  live(): string[] {
    return [...this.docs.values()].filter((d) => !this.deleted.has(d.id)).map((d) => d.external_id).sort();
  }
}

export function scripted(changes: DocumentChange[] | ((ctx: SyncContext<unknown>) => DocumentChange[])): Connector<unknown> {
  return {
    kind: "web",
    parseConfig: (c) => c,
    async *sync(ctx) {
      for (const c of typeof changes === "function" ? changes(ctx) : changes) yield c;
    },
  };
}
