import { diffLines, diffWordsWithSpace } from "diff";
import type { ChangeObject } from "diff";
import { useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { Segmented } from "@/components/ui/tabs";

type Row =
  | { type: "same"; left: string; right: string; ln: number; rn: number }
  | { type: "change"; left?: string; right?: string; ln?: number; rn?: number }
  | { type: "fold"; count: number; key: string };

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Pair removed/added runs side by side, keep context, fold long unchanged stretches. */
function buildRows(before: string, after: string, context = 3): Row[] {
  const parts = diffLines(before, after);
  const raw: Row[] = [];
  let ln = 1;
  let rn = 1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (const line of splitLines(p.value)) raw.push({ type: "same", left: line, right: line, ln: ln++, rn: rn++ });
      continue;
    }
    const removed = p.removed ? splitLines(p.value) : [];
    let added: string[] = p.added ? splitLines(p.value) : [];
    if (p.removed && parts[i + 1]?.added) {
      added = splitLines(parts[i + 1].value);
      i++;
    }
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) {
      raw.push({
        type: "change",
        left: removed[k],
        right: added[k],
        ln: removed[k] !== undefined ? ln++ : undefined,
        rn: added[k] !== undefined ? rn++ : undefined,
      });
    }
  }
  // fold unchanged runs longer than 2*context
  const keep = raw.map(() => false);
  raw.forEach((r, i) => {
    if (r.type === "change") for (let k = Math.max(0, i - context); k <= Math.min(raw.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Row[] = [];
  let folded = 0;
  raw.forEach((r, i) => {
    if (keep[i] || r.type !== "same") {
      if (folded) out.push({ type: "fold", count: folded, key: `f${i}` });
      folded = 0;
      out.push(r);
    } else folded++;
  });
  if (folded) out.push({ type: "fold", count: folded, key: "fend" });
  return out;
}

function WordDiff({ a, b, side }: { a: string; b: string; side: "left" | "right" }) {
  const parts: ChangeObject<string>[] = diffWordsWithSpace(a, b);
  return (
    <>
      {parts.map((p, i) => {
        if (side === "left" && p.added) return null;
        if (side === "right" && p.removed) return null;
        const hl = (side === "left" && p.removed) || (side === "right" && p.added);
        return (
          <span key={i} className={hl ? (side === "left" ? "rounded-sm bg-diff-del-strong" : "rounded-sm bg-diff-add-strong") : undefined}>
            {p.value}
          </span>
        );
      })}
    </>
  );
}

const cell = "px-2 py-px font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-words align-top";
const gutter = "w-10 select-none px-2 py-px text-right font-mono text-[11px] leading-5 text-subtle align-top";

export function DiffView({
  before,
  after,
  mode: initialMode = "split",
  showToggle = true,
  beforeLabel = "Before",
  afterLabel = "After",
}: {
  before: string;
  after: string;
  mode?: "split" | "unified";
  showToggle?: boolean;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const [mode, setMode] = useState<"split" | "unified">(initialMode);
  const rows = useMemo(() => buildRows(before, after), [before, after]);
  const changed = rows.some((r) => r.type === "change");

  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      {showToggle ? (
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-3 py-1.5">
          <span className="text-xs text-subtle">{changed ? `${rows.filter((r) => r.type === "change").length} changed lines` : "No changes"}</span>
          <Segmented
            label="Diff layout"
            value={mode}
            onChange={setMode}
            options={[
              { value: "split", label: "Split" },
              { value: "unified", label: "Unified" },
            ]}
          />
        </div>
      ) : null}
      <div className="overflow-x-auto">
        {mode === "split" ? (
          <table className="w-full table-fixed border-collapse">
            <thead className="sr-only">
              <tr>
                <th>Line</th>
                <th>{beforeLabel}</th>
                <th>Line</th>
                <th>{afterLabel}</th>
              </tr>
            </thead>
            <colgroup>
              <col className="w-10" />
              <col />
              <col className="w-10" />
              <col />
            </colgroup>
            <tbody>
              {rows.map((r, i) =>
                r.type === "fold" ? (
                  <tr key={r.key} className="bg-surface-2/60">
                    <td colSpan={4} className="px-3 py-1 text-center text-[11px] text-subtle">
                      {r.count} unchanged {r.count === 1 ? "line" : "lines"}
                    </td>
                  </tr>
                ) : r.type === "same" ? (
                  <tr key={i}>
                    <td className={gutter}>{r.ln}</td>
                    <td className={cn(cell, "text-muted")}>{r.left}</td>
                    <td className={cn(gutter, "border-l border-line")}>{r.rn}</td>
                    <td className={cn(cell, "text-muted")}>{r.right}</td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td className={cn(gutter, r.left !== undefined && "bg-diff-del")}>{r.ln}</td>
                    <td className={cn(cell, r.left !== undefined ? "bg-diff-del" : "bg-surface-2/40")}>
                      {r.left !== undefined && r.right !== undefined ? <WordDiff a={r.left} b={r.right} side="left" /> : r.left}
                    </td>
                    <td className={cn(gutter, "border-l border-line", r.right !== undefined && "bg-diff-add")}>{r.rn}</td>
                    <td className={cn(cell, r.right !== undefined ? "bg-diff-add" : "bg-surface-2/40")}>
                      {r.left !== undefined && r.right !== undefined ? <WordDiff a={r.left} b={r.right} side="right" /> : r.right}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {rows.flatMap((r, i) => {
                if (r.type === "fold")
                  return [
                    <tr key={r.key} className="bg-surface-2/60">
                      <td colSpan={3} className="px-3 py-1 text-center text-[11px] text-subtle">
                        {r.count} unchanged {r.count === 1 ? "line" : "lines"}
                      </td>
                    </tr>,
                  ];
                if (r.type === "same")
                  return [
                    <tr key={i}>
                      <td className={gutter}>{r.ln}</td>
                      <td className={gutter}>{r.rn}</td>
                      <td className={cn(cell, "text-muted")}> {r.left}</td>
                    </tr>,
                  ];
                const out = [];
                if (r.left !== undefined)
                  out.push(
                    <tr key={`${i}-l`} className="bg-diff-del">
                      <td className={gutter}>{r.ln}</td>
                      <td className={gutter} />
                      <td className={cell}>
                        <span className="select-none text-danger">-</span>
                        {r.right !== undefined ? <WordDiff a={r.left} b={r.right} side="left" /> : r.left}
                      </td>
                    </tr>,
                  );
                if (r.right !== undefined)
                  out.push(
                    <tr key={`${i}-r`} className="bg-diff-add">
                      <td className={gutter} />
                      <td className={gutter}>{r.rn}</td>
                      <td className={cell}>
                        <span className="select-none text-ok">+</span>
                        {r.left !== undefined ? <WordDiff a={r.left} b={r.right} side="right" /> : r.right}
                      </td>
                    </tr>,
                  );
                return out;
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Field-level diff for frontmatter / scalar columns: shows only keys that changed. */
export function FieldDiff({
  before,
  after,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  if (!keys.length) return <p className="text-xs text-subtle">No field changes.</p>;
  const show = (v: unknown) => (v === undefined || v === null ? "∅" : typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="bg-surface-2 text-left text-subtle">
            <th className="w-28 px-3 py-1.5 mono-label sm:w-40">Field</th>
            <th className="px-3 py-1.5 mono-label">Before</th>
            <th className="px-3 py-1.5 mono-label">After</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k} className="border-t border-line align-top">
              <td className="px-3 py-1.5 font-mono text-xs text-muted">{k}</td>
              <td className="bg-diff-del/60 px-3 py-1.5 font-mono text-xs break-words whitespace-pre-wrap">{show(before[k])}</td>
              <td className="bg-diff-add/60 px-3 py-1.5 font-mono text-xs break-words whitespace-pre-wrap">{show(after[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
