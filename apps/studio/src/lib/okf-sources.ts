import type { Json } from "@/lib/database.types";
import { safeHref } from "./safe-href.ts";

export type SourceItem = {
  label: string;
  /** external http(s) link */
  url?: string;
  /** in-app Studio link (a supaknowledge://documents|traces resource or an x-supaknowledge-document id) */
  href?: string;
  /** the raw resource when it is not already the label (e.g. supaknowledge://flags/<id>) */
  resource?: string;
  detail?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SK_RESOURCE = new RegExp(`^supaknowledge://(documents|traces)/(${ID})$`, "i");
const DOC_ID = new RegExp(`^${ID}$`, "i");

/**
 * Which evidence pages the viewer can open: source documents need editor, traces reviewer (RLS; a trace's own sender
 * can open it too, but a concept's sources do not say who sent the trace). Default: both, for callers that only parse.
 */
export type EvidenceAccess = { documents: boolean; traces: boolean };

/** Studio page of a supaknowledge:// resource, when there is one and the viewer may open it. */
function studioHref(resource: string | undefined, docId: unknown, base: string | undefined, access: EvidenceAccess): string | undefined {
  if (!base) return undefined;
  const m = resource ? SK_RESOURCE.exec(resource) : null;
  if (m) {
    if (m[1].toLowerCase() === "documents") return access.documents ? `${base}/sources/documents/${m[2]}` : undefined;
    return access.traces ? `${base}/activity/traces/${m[2]}` : undefined;
  }
  if (typeof docId === "string" && DOC_ID.test(docId)) return access.documents ? `${base}/sources/documents/${docId}` : undefined;
  return undefined;
}

/**
 * OKF `sources`: a list of strings (ids / urls) or objects ({id, title, resource | url, author, last_modified, ...},
 * as written by the curator). `base` is the space's Studio URL, used to link supaknowledge:// resources in-app when
 * `access` says the viewer can open them (otherwise they stay plain text).
 */
export function parseSources(frontmatter: Json, base?: string, access: EvidenceAccess = { documents: true, traces: true }): SourceItem[] {
  if (!isRecord(frontmatter)) return [];
  const raw = frontmatter.sources;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.map((s): SourceItem => {
    if (typeof s === "string") {
      const url = safeHref(s) ?? undefined;
      return url ? { label: s, url } : { label: s, href: studioHref(s, undefined, base, access) };
    }
    if (isRecord(s)) {
      const ref = typeof s.resource === "string" ? s.resource : typeof s.url === "string" ? s.url : typeof s.href === "string" ? s.href : undefined;
      const url = safeHref(ref) ?? undefined;
      const href = url ? undefined : studioHref(ref, s["x-supaknowledge-document"], base, access);
      const label = [s.title, s.name, s.id, ref].find((x): x is string => typeof x === "string" && x !== "") ?? JSON.stringify(s);
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      const modified = str(s.last_modified) ?? str(s.retrieved_at) ?? str(s.at) ?? str(s.date);
      const detailBits = [
        str(s.type),
        str(s.kind),
        str(s.author) ? `by ${str(s.author)}` : undefined,
        modified ? `${s.last_modified ? "modified" : "retrieved"} ${modified}` : undefined,
      ].filter((x): x is string => !!x);
      return { label, url, href, resource: ref && ref !== label ? ref : undefined, detail: detailBits.join(" · ") || undefined };
    }
    return { label: JSON.stringify(s) };
  });
}
