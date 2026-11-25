import { ChevronRight, Folder, Lock } from "lucide-react";
import { Link } from "@/components/ui/link";
import { KindIcon, StaleBadge, TrustBadge } from "@/components/kf/badges";
import { cn } from "@/components/ui/cn";
import type { Database } from "@/lib/database.types";
import { conceptHref } from "./paths";

type Enums = Database["public"]["Enums"];

export interface TreeConcept {
  id: string;
  path: string;
  kind: Enums["concept_kind"];
  title: string;
  status: Enums["concept_status"];
  audience: string[];
  trust: Enums["trust_tier"] | null;
  is_stale: boolean | null;
}

interface Node {
  name: string;
  folders: Map<string, Node>;
  concepts: TreeConcept[];
  count: number;
}

function buildTree(concepts: TreeConcept[]): Node {
  const root: Node = { name: "", folders: new Map(), concepts: [], count: 0 };
  for (const c of concepts) {
    const parts = c.path.split("/");
    let node = root;
    node.count++;
    for (const seg of parts.slice(0, -1)) {
      let next = node.folders.get(seg);
      if (!next) {
        next = { name: seg, folders: new Map(), concepts: [], count: 0 };
        node.folders.set(seg, next);
      }
      next.count++;
      node = next;
    }
    node.concepts.push(c);
  }
  return root;
}

function ConceptRow({ c, base }: { c: TreeConcept; base: string }) {
  const leaf = c.path.split("/").pop();
  return (
    <li>
      <Link
        href={conceptHref(base, c.path)}
        className={cn(
          "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2",
          c.status === "deprecated" && "opacity-60",
        )}
      >
        <KindIcon kind={c.kind} />
        <span className={cn("min-w-0 flex-1 truncate", c.status === "deprecated" && "line-through")}>
          <span className="text-fg">{c.title}</span>
          <span className="ml-2 font-mono text-xs text-subtle">{leaf}</span>
        </span>
        {c.status === "draft" ? <span className="text-[11px] text-subtle">draft</span> : null}
        {c.audience.length > 0 ? (
          <span title="Restricted to specific groups" className="text-subtle">
            <Lock className="size-3.5" />
            <span className="sr-only">Restricted</span>
          </span>
        ) : null}
        {c.is_stale ? <StaleBadge /> : null}
        <TrustBadge trust={c.trust} compact />
      </Link>
    </li>
  );
}

function FolderNode({ node, base, depth }: { node: Node; base: string; depth: number }) {
  const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  const concepts = [...node.concepts].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <ul className={cn("flex flex-col gap-0.5", depth > 0 && "ml-3 border-l border-line pl-2")}>
      {folders.map((f) => (
        <li key={f.name}>
          <details open={depth < 1} className="group/folder">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-fg hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 text-subtle transition-transform group-open/folder:rotate-90" />
              <Folder className="size-4 text-subtle" />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-xs font-normal tabular-nums text-subtle">{f.count}</span>
            </summary>
            <FolderNode node={f} base={base} depth={depth + 1} />
          </details>
        </li>
      ))}
      {concepts.map((c) => (
        <ConceptRow key={c.id} c={c} base={base} />
      ))}
    </ul>
  );
}

export function KnowledgeTree({ concepts, base }: { concepts: TreeConcept[]; base: string }) {
  return <FolderNode node={buildTree(concepts)} base={base} depth={0} />;
}
