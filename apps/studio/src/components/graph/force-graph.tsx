import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { KIND_LABEL } from "@/components/kf/badges";
import { cn } from "@/components/ui/cn";
import type { GraphEdge, GraphNode } from "@/lib/graph";

type SimNode = SimulationNodeDatum & { id: string; r: number };
type Positions = Map<string, { x: number; y: number }>;
type Transform = { x: number; y: number; k: number };

export const KIND_COLOR = { skill: "var(--violet)", domain: "var(--accent)", data_access: "var(--info)" } as const;
const TRUST_LABEL = { human_reviewed: "Human reviewed", machine_confirmed: "Machine confirmed", unverified: "Unverified" } as const;
const EVIDENCE_LABEL = { source_document: "Source document", trace: "Trace", flag: "Flag" } as const;

export function nodeRadius(n: GraphNode): number {
  return n.type === "evidence" ? 4 : 5 + Math.min(7, Math.sqrt(n.degree) * 1.6);
}

/** Graphs this small show every concept label, so the layout keeps room for them. */
const LABELLED_MAX = 40;
/** Approximate width of an 11px label in layout units (labels are drawn at a constant screen size). */
const labelWidth = (n: GraphNode) => (n.type === "concept" ? Math.min(48, n.title.length) * 6.2 + 4 : 0);

/** Runs the force layout to rest synchronously (deterministic: d3 seeds nodes on a phyllotaxis spiral). */
function layout(nodes: GraphNode[], edges: GraphEdge[]): Positions {
  const labelled = nodes.length <= LABELLED_MAX;
  // with labels shown, each concept's collision circle also covers about half its label, so labels rarely overlap
  const sim: SimNode[] = nodes.map((n) => ({ id: n.id, r: nodeRadius(n) + (labelled ? labelWidth(n) / 2 : 0) }));
  const links: SimulationLinkDatum<SimNode>[] = edges.map((e) => ({ source: e.source, target: e.target }));
  const simulation = forceSimulation(sim)
    .force("link", forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.id).distance(labelled ? 110 : 48).strength(labelled ? 0.3 : 0.6))
    .force("charge", forceManyBody<SimNode>().strength(labelled ? -320 : -90).distanceMax(labelled ? 800 : 400))
    .force("collide", forceCollide<SimNode>().radius((d) => d.r + 6).strength(0.9))
    // weak pull to the middle keeps disconnected concepts from drifting away
    .force("x", forceX<SimNode>(0).strength(0.06))
    .force("y", forceY<SimNode>(0).strength(labelled ? 0.12 : 0.06))
    // large graphs settle in about half the ticks (~150 instead of ~300) so the main thread stays responsive
    .alphaDecay(nodes.length > 600 ? 0.045 : 0.0228)
    .stop();
  const ticks = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
  simulation.tick(ticks);
  return new Map(sim.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}

/** Zoom by `factor` keeping the screen point (px, py) still. */
function zoomed(cur: Transform, px: number, py: number, factor: number): Transform {
  const k = Math.min(8, Math.max(0.1, cur.k * factor));
  const f = k / cur.k;
  return { k, x: px - (px - cur.x) * f, y: py - (py - cur.y) * f };
}

function fit(pos: Positions, nodes: GraphNode[], width: number, height: number): Transform {
  if (nodes.length === 0 || width === 0) return { x: width / 2, y: height / 2, k: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const r = nodeRadius(n) + 8;
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r + (nodes.length <= LABELLED_MAX ? labelWidth(n) : 0));
    maxY = Math.max(maxY, p.y + r);
  }
  const pad = 32;
  const k = Math.min(1.25, Math.max(0.1, Math.min((width - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1))));
  return { k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k };
}

/**
 * The knowledge graph as SVG: d3-force for the layout only, React for rendering. Drag the background to pan,
 * scroll or use the buttons to zoom, hover a node to see its neighbours, click or press Enter to open it.
 */
export function ForceGraph({
  nodes,
  edges,
  hrefFor,
  className,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hrefFor: (n: GraphNode) => string | null;
  className?: string;
}) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  // measure the container
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // lay out once the container has a size: never during SSR, and not while hidden (the phone layout shows the
  // list instead). Again whenever the drawn set changes.
  const visible = size.width > 0;
  const pos = useMemo(() => (visible ? layout(nodes, edges) : null), [visible, nodes, edges]);
  const fitted = useMemo(() => (pos ? fit(pos, nodes, size.width, size.height) : { x: 0, y: 0, k: 1 }), [pos, nodes, size.width, size.height]);

  // the person's pan and zoom; null = fit to the container. A new drawn set starts fitted again.
  const [userT, setUserT] = useState<Transform | null>(null);
  const [userTFor, setUserTFor] = useState(nodes);
  if (userTFor !== nodes) {
    setUserTFor(nodes);
    setUserT(null);
  }
  const t = userT ?? fitted;

  // wheel zoom around the pointer (a non-passive listener, so the page does not scroll underneath)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      setUserT((cur) => zoomed(cur ?? fitted, e.clientX - rect.left, e.clientY - rect.top, factor));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [fitted]);

  const zoomAt = (px: number, py: number, factor: number) => setUserT((cur) => zoomed(cur ?? fitted, px, py, factor));

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    }
    return m;
  }, [edges]);

  const lit = hover ? new Set([hover, ...(neighbours.get(hover) ?? [])]) : null;
  const hovered = hover ? nodes.find((n) => n.id === hover) : undefined;
  const showAllLabels = nodes.length <= LABELLED_MAX || t.k >= 1.6;

  const open = (n: GraphNode) => {
    const href = hrefFor(n);
    if (href) void router.navigate({ href });
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-node]")) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setUserT((cur) => {
      const from = cur ?? fitted;
      return { ...from, x: from.x + dx, y: from.y + dy };
    });
  };
  const endDrag = () => {
    drag.current = null;
  };

  const hp = hovered && pos?.get(hovered.id);

  return (
    <div ref={wrapRef} className={cn("relative overflow-hidden", className)}>
      <svg
        ref={svgRef}
        width={size.width}
        height={size.height}
        className="block cursor-grab touch-none select-none active:cursor-grabbing"
        role="group"
        aria-label="Knowledge graph"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {pos ? (
          <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
            <g aria-hidden="true">
              {edges.map((e) => {
                const a = pos.get(e.source);
                const b = pos.get(e.target);
                if (!a || !b) return null;
                const on = lit ? lit.has(e.source) && lit.has(e.target) : true;
                return (
                  <line
                    key={`${e.source}-${e.target}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={on && lit ? "var(--muted)" : "var(--line-strong)"}
                    strokeWidth={1}
                    strokeDasharray={e.kind === "cites" ? "3 3" : undefined}
                    vectorEffect="non-scaling-stroke"
                    opacity={on ? 1 : 0.25}
                  />
                );
              })}
            </g>
            {nodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const r = nodeRadius(n);
              const dim = lit ? !lit.has(n.id) : false;
              const href = hrefFor(n);
              const label = n.type === "concept" ? n.title : n.label;
              return (
                <g
                  key={n.id}
                  data-node=""
                  transform={`translate(${p.x},${p.y})`}
                  opacity={dim ? 0.2 : 1}
                  className={cn("outline-none", href && "cursor-pointer")}
                  role={href ? "link" : undefined}
                  tabIndex={href && n.type === "concept" ? 0 : undefined}
                  aria-label={n.type === "concept" ? describeConcept(n) : `${EVIDENCE_LABEL[n.kind]}: ${n.label}`}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                  onFocus={() => setHover(n.id)}
                  onBlur={() => setHover((h) => (h === n.id ? null : h))}
                  onClick={() => open(n)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") open(n);
                  }}
                >
                  {n.type === "concept" ? <ConceptMark n={n} r={r} focused={hover === n.id} /> : <EvidenceMark kind={n.kind} r={r} />}
                  {(showAllLabels && n.type === "concept") || hover === n.id ? (
                    <text
                      x={r + 4}
                      y={0}
                      dominantBaseline="central"
                      fontSize={11 / t.k}
                      fill="var(--fg)"
                      stroke="var(--surface)"
                      strokeWidth={3 / t.k}
                      paintOrder="stroke"
                      className="pointer-events-none"
                    >
                      {label.length > 48 ? `${label.slice(0, 47)}…` : label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        ) : null}
      </svg>

      {hovered && hp ? (
        <div
          className="pointer-events-none absolute z-10 max-w-72 rounded-md border border-line-strong bg-surface px-3 py-2 text-xs shadow-md"
          style={{
            left: Math.min(size.width - 296, Math.max(8, hp.x * t.k + t.x + 14)),
            top: Math.min(size.height - 120, Math.max(8, hp.y * t.k + t.y + 14)),
          }}
        >
          {hovered.type === "concept" ? (
            <>
              <div className="font-medium text-fg">{hovered.title}</div>
              <div className="truncate font-mono text-subtle">{hovered.path}</div>
              <div className="mt-1 text-muted">
                {KIND_LABEL[hovered.kind]}, {TRUST_LABEL[hovered.trust].toLowerCase()}
              </div>
              {hovered.stale ? <div className="text-warn">Stale: past its re-check date</div> : null}
              {hovered.open_flags ? (
                <div className="text-danger">
                  {hovered.open_flags} open flag{hovered.open_flags === 1 ? "" : "s"}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="text-muted">{EVIDENCE_LABEL[hovered.kind]}</div>
              <div className="text-fg">{hovered.label}</div>
            </>
          )}
        </div>
      ) : null}

      <div className="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-md border border-line-strong bg-button shadow-xs">
        <ZoomButton label="Zoom in" onClick={() => zoomAt(size.width / 2, size.height / 2, 1.3)}>
          <Plus />
        </ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => zoomAt(size.width / 2, size.height / 2, 1 / 1.3)}>
          <Minus />
        </ZoomButton>
        <ZoomButton label="Fit to screen" onClick={() => setUserT(null)}>
          <Maximize2 />
        </ZoomButton>
      </div>
    </div>
  );
}

function describeConcept(n: Extract<GraphNode, { type: "concept" }>): string {
  const parts = [n.title, KIND_LABEL[n.kind], TRUST_LABEL[n.trust]];
  if (n.stale) parts.push("stale");
  if (n.open_flags) parts.push(`${n.open_flags} open flag${n.open_flags === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * Concept: filled in its kind colour when verified, hollow when unverified; a dashed amber ring when stale; a red
 * ring when it has open flags (thicker from three).
 */
export function ConceptMark({ n, r, focused }: { n: Extract<GraphNode, { type: "concept" }>; r: number; focused?: boolean }) {
  const color = KIND_COLOR[n.kind];
  const hollow = n.trust === "unverified";
  return (
    <>
      {n.open_flags > 0 ? (
        <circle r={r + 5} fill="none" stroke="var(--danger)" strokeWidth={n.open_flags >= 3 ? 2.5 : 1.5} vectorEffect="non-scaling-stroke" />
      ) : null}
      {n.stale ? <circle r={r + 2.5} fill="none" stroke="var(--warn)" strokeWidth={1.5} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" /> : null}
      <circle
        r={r}
        fill={hollow ? "var(--surface)" : color}
        stroke={focused ? "var(--fg)" : color}
        strokeWidth={focused ? 2 : 1.5}
        vectorEffect="non-scaling-stroke"
      />
    </>
  );
}

/** Evidence: square for a source document, diamond for a trace, triangle for a flag. */
export function EvidenceMark({ kind, r }: { kind: "source_document" | "trace" | "flag"; r: number }) {
  const common = { fill: "var(--surface-3)", stroke: "var(--subtle)", strokeWidth: 1, vectorEffect: "non-scaling-stroke" as const };
  if (kind === "source_document") return <rect x={-r} y={-r} width={r * 2} height={r * 2} {...common} />;
  if (kind === "trace") return <rect x={-r} y={-r} width={r * 2} height={r * 2} transform="rotate(45)" {...common} />;
  return <path d={`M0 ${-r * 1.2} L${r * 1.1} ${r * 0.8} L${-r * 1.1} ${r * 0.8} Z`} {...common} />;
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center border-b border-line text-muted last:border-b-0 hover:bg-surface-2 hover:text-fg [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}
