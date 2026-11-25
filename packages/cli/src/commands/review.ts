import type { Command } from "commander";
import { conceptToFiles, type ExportConcept } from "@supaknowledge/core";
import { CliError, must, resolveId, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";
import { ago, makeColors, shortId, statusColor, table, truncate, unifiedDiff } from "../render.ts";

const PROPOSAL_STATUSES = ["pending", "approved", "applied", "rejected", "conflicted", "superseded"];
const FLAG_STATUSES = ["open", "in_proposal", "resolved", "dismissed"];

interface ProposalOpRow {
  id: string;
  ord: number;
  op: "create" | "update" | "deprecate" | "move";
  concept_id: string | null;
  path: string;
  new_path: string | null;
  base_revision: number | null;
  after: Record<string, unknown>;
  target_audience: string[];
  rationale: string | null;
}

type ConceptRow = ExportConcept & { id: string; revision: number };

const CONCEPT_COLS = "id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision";

function statusFilter(v: string | undefined, allowed: string[], dflt: string): string[] | null {
  const s = v ?? dflt;
  if (s === "all") return null;
  const list = s.split(",").map((x) => x.trim());
  for (const x of list) if (!allowed.includes(x)) throw new CliError(`unknown status "${x}" (${[...allowed, "all"].join(", ")})`, { exitCode: 2 });
  return list;
}

function fileFor(c: ExportConcept | null): { name: string; text: string } {
  if (!c) return { name: "/dev/null", text: "" };
  const f = conceptToFiles(c)[0]!;
  return { name: f.path, text: f.content };
}

/**
 * One line per skill file carried by an op (`after.files`). After `bundle/sync-files` copied them into Storage,
 * the content is stripped from the op ({path, size_bytes, sha256, stripped: true}): list names, never content.
 */
export function skillFileLines(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string")
    .map((f) => {
      const size = typeof f.size_bytes === "number" ? f.size_bytes : typeof f.content === "string" ? (f.encoding === "base64" ? Math.floor((f.content.length * 3) / 4) : Buffer.byteLength(f.content)) : null;
      const notes = [f.encoding === "base64" ? "binary" : null, size !== null ? `${size} B` : null, f.stripped ? "synced to Storage" : null].filter(Boolean);
      return `${f.path as string}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    });
}

/** Before/after concept files for one op, as they would be exported (OKF .md or SKILL.md). */
export function opDocuments(op: ProposalOpRow, current: ConceptRow | null): { before: { name: string; text: string }; after: { name: string; text: string } } {
  const a = op.after ?? {};
  let next: ExportConcept | null;
  switch (op.op) {
    case "create":
      next = {
        kind: "domain",
        type: "Reference",
        title: op.path,
        description: "",
        body: "",
        frontmatter: {},
        tags: [],
        status: "stable",
        superseded_by: null,
        stale_after: null,
        ...(a as Partial<ExportConcept>),
        path: op.path,
        audience: op.target_audience ?? [],
      };
      return { before: fileFor(null), after: fileFor(next) };
    case "update":
      next = current ? ({ ...current, ...(a as Partial<ExportConcept>), path: current.path, audience: op.target_audience ?? current.audience } as ExportConcept) : null;
      break;
    case "deprecate":
      next = current ? { ...current, status: "deprecated", superseded_by: (a.superseded_by as string | undefined) ?? current.superseded_by ?? null } : null;
      break;
    case "move":
      next = current ? { ...current, path: op.new_path ?? current.path } : null;
      break;
  }
  // revision is metadata noise in a review diff
  const strip = (c: ConceptRow | ExportConcept | null) => (c ? ({ ...c, revision: undefined } as ExportConcept) : null);
  return { before: fileFor(strip(current)), after: fileFor(strip(next)) };
}

export function registerReview(program: Command, run: Runner): void {
  program
    .command("proposals")
    .description("list proposals in the space")
    .option("--status <status>", `${PROPOSAL_STATUSES.join(" | ")} | all (comma-separate for several)`, "pending")
    .option("-n, --limit <n>", "max rows", "50")
    .action(
      run(async (ctx: Ctx, opts: { status?: string; limit: string }) => {
        const st = statusFilter(opts.status, PROPOSAL_STATUSES, "pending");
        const sp = await ctx.space();
        const db = await ctx.db();
        let q = db
          .from("proposals")
          .select("id, title, status, risk, escalation, author, auto_applied, created_at, proposal_ops(count)")
          .eq("space_id", sp.id)
          .order("created_at", { ascending: false })
          .limit(Number(opts.limit) || 50);
        if (st) q = q.in("status", st);
        const rows = (await must(q)) as unknown as {
          id: string;
          title: string;
          status: string;
          risk: string;
          escalation: boolean;
          author: string;
          created_at: string;
          proposal_ops: { count: number }[];
        }[];
        const data = rows.map(({ proposal_ops, ...r }) => ({ ...r, ops: proposal_ops?.[0]?.count ?? 0 }));
        ctx.out(data, () =>
          table(
            ["ID", "STATUS", "RISK", "OPS", "TITLE", "AUTHOR", "CREATED"],
            data.map((r) => [
              shortId(r.id),
              statusColor(r.status, ctx.c),
              r.escalation ? ctx.c.red(`${r.risk}!`) : r.risk === "high" ? ctx.c.red(r.risk) : r.risk,
              r.ops,
              truncate(r.title, 60),
              truncate(r.author, 24),
              ago(r.created_at, ctx.io.now()),
            ]),
            ctx.c,
          ),
        );
      }),
    );

  program
    .command("proposal")
    .description("show a proposal: rationale, citations and a unified diff of every op against the current concepts")
    .argument("<id>", "proposal id (or a unique prefix)")
    .action(run(showProposal));

  program
    .command("approve")
    .description("apply a proposal (reviewer+; escalations need a space admin)")
    .argument("<id>")
    .option("--note <note>", "review note (recorded with the verification)")
    .action(
      run(async (ctx: Ctx, idArg: string, opts: { note?: string }) => {
        const id = await resolveId(ctx, "proposals", idArg, "proposal");
        const db = await ctx.db();
        const p = (await must(db.rpc("apply_proposal", { p_proposal: id, p_note: opts.note ?? null }))) as { id: string; status: string; review_note: string | null };
        if (p.status === "conflicted") {
          ctx.out(p, () => "");
          throw new CliError(`proposal conflicted: ${p.review_note ?? "a concept changed since it was drafted"}`, { hint: "ask the curator for a fresh draft (kf curate) or reject it", reported: true });
        }
        // skill files travel inside the ops and are copied into Storage by the bundle function once applied
        let filesSynced: number | null = null;
        const withFiles = (await must(db.from("proposal_ops").select("id").eq("proposal_id", id).not("after->files", "is", null).limit(1))) as unknown[];
        if (withFiles.length) {
          try {
            filesSynced = (await ctx.fn<{ files_synced: number }>("bundle/sync-files", { body: { proposal_id: id } })).files_synced;
          } catch (e) {
            ctx.warn(`proposal applied, but skill files were not synced: ${(e as Error).message}`);
          }
        }
        ctx.out({ ...p, files_synced: filesSynced }, () => `${ctx.c.green("applied")} ${p.id}${filesSynced ? ctx.c.dim(` (${filesSynced} skill files synced)`) : ""}`);
      }),
    );

  program
    .command("reject")
    .description("reject a proposal; the note goes back to the curator")
    .argument("<id>")
    .requiredOption("--note <note>", "why (required: the curator learns from it)")
    .action(
      run(async (ctx: Ctx, idArg: string, opts: { note: string }) => {
        const id = await resolveId(ctx, "proposals", idArg, "proposal");
        const db = await ctx.db();
        const p = (await must(db.rpc("reject_proposal", { p_proposal: id, p_note: opts.note }))) as { id: string; status: string };
        ctx.out(p, () => `${ctx.c.red("rejected")} ${p.id}`);
      }),
    );

  program
    .command("flags")
    .description("list flags raised by agents and people")
    .option("--status <status>", `${FLAG_STATUSES.join(" | ")} | all`, "open")
    .option("-n, --limit <n>", "max rows", "50")
    .action(
      run(async (ctx: Ctx, opts: { status?: string; limit: string }) => {
        const st = statusFilter(opts.status, FLAG_STATUSES, "open");
        const sp = await ctx.space();
        const db = await ctx.db();
        let q = db
          .from("flags")
          .select("id, kind, status, concept_path, observation, suggested_fix, query, synthetic, proposal_id, created_by, trace_id, created_at")
          .eq("space_id", sp.id)
          .order("created_at", { ascending: false })
          .limit(Number(opts.limit) || 50);
        if (st) q = q.in("status", st);
        const rows = (await must(q)) as { id: string; kind: string; status: string; concept_path: string | null; observation: string; synthetic: boolean; created_at: string }[];
        ctx.out(rows, () =>
          table(
            ["ID", "KIND", "STATUS", "CONCEPT", "OBSERVATION", "CREATED"],
            rows.map((f) => [
              shortId(f.id),
              f.kind,
              statusColor(f.status, ctx.c),
              f.concept_path ?? ctx.c.dim("-"),
              truncate(f.observation, 70) + (f.synthetic ? ctx.c.dim(" (from trace)") : ""),
              ago(f.created_at, ctx.io.now()),
            ]),
            ctx.c,
          ),
        );
      }),
    );

  program
    .command("dismiss")
    .description("dismiss a flag (reviewer+)")
    .argument("<flag-id>")
    .requiredOption("--reason <reason>", "why it is not actionable")
    .action(
      run(async (ctx: Ctx, idArg: string, opts: { reason: string }) => {
        const id = await resolveId(ctx, "flags", idArg, "flag");
        const db = await ctx.db();
        const f = (await must(db.rpc("dismiss_flag", { p_flag: id, p_reason: opts.reason }))) as { id: string; status: string };
        ctx.out(f, () => `${ctx.c.dim("dismissed")} ${f.id}`);
      }),
    );
}

/** For an applied proposal: concept_id -> the revision preceding the one the proposal wrote (null = it created it). */
async function priorRevisions(ctx: Ctx, proposalId: string): Promise<Map<string, ConceptRow | null>> {
  const db = await ctx.db();
  const produced = (await must(db.from("concept_revisions").select("concept_id, revision").eq("proposal_id", proposalId))) as { concept_id: string; revision: number }[];
  const out = new Map<string, ConceptRow | null>();
  for (const r of produced) out.set(r.concept_id, null);
  const prev = produced.filter((r) => r.revision > 1);
  if (!prev.length) return out;
  const rows = (await must(
    db
      .from("concept_revisions")
      .select("concept_id, " + CONCEPT_COLS.replace("id, ", ""))
      .or(prev.map((r) => `and(concept_id.eq.${r.concept_id},revision.eq.${r.revision - 1})`).join(",")),
  )) as unknown as (Omit<ConceptRow, "id"> & { concept_id: string })[];
  for (const { concept_id, ...r } of rows) out.set(concept_id, { ...r, id: concept_id } as ConceptRow);
  return out;
}

async function showProposal(ctx: Ctx, idArg: string): Promise<void> {
  const id = await resolveId(ctx, "proposals", idArg, "proposal");
  const db = await ctx.db();
  const p = (await must(
    db
      .from("proposals")
      .select("*, proposal_ops(*), proposal_citations(*), proposal_reviews(decision, note, reviewer, created_at)")
      .eq("id", id)
      .maybeSingle(),
  )) as
    | (Record<string, unknown> & {
        id: string;
        title: string;
        rationale: string;
        status: string;
        risk: string;
        escalation: boolean;
        author: string;
        created_at: string;
        review_note: string | null;
        proposal_ops: ProposalOpRow[];
        proposal_citations: { label: string; ref_kind: string; ref_id: string | null; url: string | null; quote: string | null; op_id: string | null; consulted?: boolean }[];
        proposal_reviews: { decision: string; note: string | null; created_at: string }[];
      })
    | null;
  if (!p) throw new CliError(`proposal ${idArg} not found or not visible to you`, { hint: "proposals are visible to editors+ who can see all cited evidence" });

  const ops = [...p.proposal_ops].sort((a, b) => a.ord - b.ord);
  const ids = ops.map((o) => o.concept_id).filter((x): x is string => Boolean(x));
  const paths = ops.filter((o) => !o.concept_id).map((o) => o.path);
  const current: ConceptRow[] = [];
  if (ids.length) current.push(...((await must(db.from("concepts").select(CONCEPT_COLS).in("id", ids))) as ConceptRow[]));
  if (paths.length) current.push(...((await must(db.from("concepts").select(CONCEPT_COLS).eq("space_id", p.space_id as string).in("path", paths))) as ConceptRow[]));

  // an applied proposal is shown against the revision before the one it wrote (not against today's concept)
  const prior = p.status === "applied" ? await priorRevisions(ctx, p.id) : new Map<string, ConceptRow | null>();
  // only a proposal that can still be applied can conflict
  const live = p.status === "pending" || p.status === "approved";

  const plain = makeColors(false);
  const rendered = ops.map((o) => {
    const cur = current.find((c) => (o.concept_id ? c.id === o.concept_id : c.path === o.path)) ?? null;
    const before = o.op === "create" ? null : o.concept_id && prior.has(o.concept_id) ? prior.get(o.concept_id)! : cur;
    const docs = opDocuments(o, before);
    const stale = live && cur && o.base_revision !== null && cur.revision !== o.base_revision;
    return {
      op: o,
      current_revision: cur?.revision ?? null,
      stale_base: Boolean(stale),
      missing: o.op !== "create" && !before,
      diff: (c: typeof ctx.c) => unifiedDiff(docs.before.name === "/dev/null" ? "/dev/null" : `a/${docs.before.name}`, `b/${docs.after.name}`, docs.before.text, docs.after.text, c),
    };
  });

  const { proposal_ops: _ops, ...rest } = p;
  ctx.out(
    {
      ...rest,
      ops: rendered.map((r) => ({ ...r.op, current_revision: r.current_revision, stale_base: r.stale_base, diff: r.diff(plain) })),
    },
    () => {
      const c = ctx.c;
      const out = [
        `${c.bold(p.title)}`,
        `${c.dim("id")} ${p.id}  ${c.dim("status")} ${statusColor(p.status, c)}  ${c.dim("risk")} ${p.risk}${p.escalation ? c.red("  ESCALATION: widens access, space admin must approve") : ""}`,
        `${c.dim("author")} ${p.author}  ${c.dim("created")} ${ago(p.created_at, ctx.io.now())}`,
      ];
      if (p.rationale) out.push("", p.rationale.trim());
      if (p.review_note) out.push("", `${c.dim("review note:")} ${p.review_note}`);
      const cited = (p.proposal_citations ?? []).filter((ci) => !ci.consulted);
      const consulted = (p.proposal_citations ?? []).filter((ci) => ci.consulted);
      if (cited.length) {
        out.push("", c.bold("Citations"));
        for (const ci of cited) {
          out.push(`  [^${ci.label}] ${ci.ref_kind}${ci.ref_id ? ` ${shortId(ci.ref_id)}` : ""}${ci.url ? ` ${ci.url}` : ""}${ci.quote ? c.dim(` "${truncate(ci.quote, 100)}"`) : ""}`);
        }
      }
      if (consulted.length) {
        // read while researching but not cited: still counts for who may see / approve the proposal
        out.push("", c.bold("Also consulted") + c.dim(" (not cited; counts for visibility and escalation)"));
        for (const ci of consulted) out.push(`  ${ci.ref_kind}${ci.ref_id ? ` ${shortId(ci.ref_id)}` : ""}${ci.url ? ` ${ci.url}` : ""}`);
      }
      for (const r of rendered) {
        const o = r.op;
        out.push("", c.magenta(`${o.ord + 1}. ${o.op} ${o.path}${o.new_path ? ` -> ${o.new_path}` : ""}`) + (o.rationale ? c.dim(`  ${truncate(o.rationale, 100)}`) : ""));
        if (r.missing) out.push(c.red("   concept not found (deleted, or you cannot see it)"));
        if (r.stale_base) out.push(c.yellow(`   drafted against revision ${o.base_revision}, concept is now at ${r.current_revision}: applying will conflict`));
        const d = r.diff(c);
        out.push(d || c.dim("   (no content change)"));
        const files = skillFileLines(o.after?.files);
        if (files.length) {
          out.push(c.dim(`   skill files (${files.length}):`));
          for (const f of files) out.push(c.dim(`     ${f}`));
        }
      }
      if (p.proposal_reviews?.length) {
        out.push("", c.bold("Reviews"));
        for (const rv of p.proposal_reviews) out.push(`  ${rv.decision} ${ago(rv.created_at, ctx.io.now())}${rv.note ? `: ${rv.note}` : ""}`);
      }
      if (p.status === "pending") out.push("", c.dim(`kf approve ${shortId(p.id)} [--note ...]   |   kf reject ${shortId(p.id)} --note ...`));
      return out.join("\n");
    },
  );
}
