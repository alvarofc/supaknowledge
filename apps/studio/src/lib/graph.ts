// Knowledge graph: the shape of rpc knowledge_graph and the filtering the page applies to it. Pure: no React.

export type ConceptKind = "skill" | "domain" | "data_access";
export type EvidenceKind = "source_document" | "trace" | "flag";

export interface GraphConcept {
  id: string;
  path: string;
  title: string;
  kind: ConceptKind;
  status: "draft" | "stable" | "deprecated";
  trust: "unverified" | "machine_confirmed" | "human_reviewed";
  stale: boolean;
  stale_after: string | null;
  open_flags: number;
  updated_at: string;
}

export interface GraphEvidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  /** for a cited flag: the proposal that resolved it, when the caller can see that proposal */
  proposal_id: string | null;
}

export interface GraphData {
  concepts: GraphConcept[];
  truncated: boolean;
  links: { from: string; to: string }[];
  evidence: GraphEvidence[];
  citations: { concept: string; ref_kind: EvidenceKind | "concept"; ref: string }[];
}

export interface GraphFilters {
  kind?: ConceptKind;
  flagged?: boolean;
  stale?: boolean;
  /** draw cited documents, traces and flags (default true) */
  evidence?: boolean;
}

export type GraphNode =
  | ({ type: "concept"; degree: number } & GraphConcept)
  | ({ type: "evidence"; degree: number } & GraphEvidence);

export interface GraphEdge {
  source: string;
  target: string;
  /** link: a markdown link between concepts; cites: an applied proposal cited this for the concept */
  kind: "link" | "cites";
}

export const CONCEPT_KINDS: ConceptKind[] = ["skill", "domain", "data_access"];

export function parseGraphFilters(search: Record<string, unknown>): GraphFilters {
  const kind = typeof search.kind === "string" && (CONCEPT_KINDS as string[]).includes(search.kind) ? (search.kind as ConceptKind) : undefined;
  const flag = (v: unknown) => v === "1" || v === 1 || v === true || v === "true";
  return {
    kind,
    flagged: flag(search.flagged) || undefined,
    stale: flag(search.stale) || undefined,
    evidence: search.evidence === "0" || search.evidence === 0 || search.evidence === false ? false : undefined,
  };
}

/** Query string for a filter set (only non-default values), e.g. "?kind=skill&stale=1". */
export function graphSearch(f: GraphFilters, extra: Record<string, string | undefined> = {}): string {
  const u = new URLSearchParams();
  if (f.kind) u.set("kind", f.kind);
  if (f.flagged) u.set("flagged", "1");
  if (f.stale) u.set("stale", "1");
  if (f.evidence === false) u.set("evidence", "0");
  for (const [k, v] of Object.entries(extra)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : "";
}

export function hasConceptFilters(f: GraphFilters): boolean {
  return Boolean(f.kind || f.flagged || f.stale);
}

/**
 * Nodes and edges to draw. Concepts must pass every active filter; links are kept between remaining concepts;
 * evidence is kept when it is cited for a remaining concept (and evidence is on). Duplicate edges collapse.
 */
export function buildGraph(data: GraphData, f: GraphFilters): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const concepts = data.concepts.filter(
    (c) => (!f.kind || c.kind === f.kind) && (!f.flagged || c.open_flags > 0) && (!f.stale || c.stale),
  );
  const keep = new Set(concepts.map((c) => c.id));
  const evidenceById = new Map(data.evidence.map((e) => [e.id, e]));
  const showEvidence = f.evidence !== false;

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, kind: GraphEdge["kind"]) => {
    // links are directional in the data but drawn undirected: a <-> b is one edge
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (source === target || seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, kind });
  };
  for (const l of data.links) if (keep.has(l.from) && keep.has(l.to)) add(l.from, l.to, "link");
  const usedEvidence = new Set<string>();
  for (const c of data.citations) {
    if (!keep.has(c.concept)) continue;
    if (c.ref_kind === "concept") {
      if (keep.has(c.ref)) add(c.concept, c.ref, "cites");
    } else if (showEvidence && evidenceById.has(c.ref)) {
      usedEvidence.add(c.ref);
      add(c.concept, c.ref, "cites");
    }
  }

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const nodes: GraphNode[] = [
    ...concepts.map((c) => ({ ...c, type: "concept" as const, degree: degree.get(c.id) ?? 0 })),
    ...data.evidence.filter((e) => usedEvidence.has(e.id)).map((e) => ({ ...e, type: "evidence" as const, degree: degree.get(e.id) ?? 0 })),
  ];
  return { nodes, edges };
}
