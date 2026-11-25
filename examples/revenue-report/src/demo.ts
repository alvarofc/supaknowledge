// The revenue-report story from LangChain's "How to build a knowledge factory", end to end against a local
// Supaknowledge stack (`npx supabase start`).
//
//   npm run demo -w @supaknowledge/example-revenue-report              run the story (a fresh workspace every time)
//   npm run demo -w @supaknowledge/example-revenue-report -- --reset   delete everything earlier demo runs created
//
// Environment (defaults are the well-known local keys printed by `npx supabase status`):
//   SUPAKNOWLEDGE_URL               http://127.0.0.1:54321
//   SUPAKNOWLEDGE_PUBLISHABLE_KEY   sb_publishable_...  (everything people and agents do goes through RLS with this key)
//   SUPAKNOWLEDGE_SECRET_KEY        sb_secret_...       (only to create the two demo people, and for --reset)
//   SUPAKNOWLEDGE_STUDIO_URL        http://127.0.0.1:3000
//   DEMO_CURATOR_TIMEOUT_S   900
//   KF_LLM_MODEL (+ KF_LLM_BASE_URL / KF_LLM_API_KEY, or AI_GATEWAY_API_KEY, ...)
//                            when set, the working agent is a real Mastra Agent wired with @supaknowledge/mastra
//                            (same variables as the curator; see src/agent.ts). Otherwise it is simulated.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Supaknowledge } from "@supaknowledge/sdk";
import { agentModelFromEnv, runRealAgent } from "./agent.ts";
import { c, FINANCE_ONLY_PATH, money, readBundle, REVENUE_TABLE_PATH, runWarehouseQuery, say, SKILL_NAME, sleep, STORY, WarehouseError } from "./lib.ts";

const URL = (process.env.SUPAKNOWLEDGE_URL ?? "http://127.0.0.1:54321").replace(/\/+$/, "");
// Fallbacks are the Supabase CLI's public local-development defaults (printed by `supabase status`), not real secrets.
const PUBLISHABLE_KEY = process.env.SUPAKNOWLEDGE_PUBLISHABLE_KEY ?? "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const SECRET_KEY = process.env.SUPAKNOWLEDGE_SECRET_KEY ?? "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const STUDIO_URL = (process.env.SUPAKNOWLEDGE_STUDIO_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const CURATOR_TIMEOUT_MS = Number(process.env.DEMO_CURATOR_TIMEOUT_S ?? 900) * 1000;

// Everything the demo creates is recognisable, so --reset can remove it.
const EMAIL_DOMAIN = "acme-demo.test";
const WORKSPACE_PREFIX = "acme-demo-";
const PASSWORD = "acme-demo-password";
const SPACE_SLUG = "revenue";

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

interface Person {
  id: string;
  name: string;
  email: string;
  token: string;
  /** supabase-js client signed in as this person: every query runs under RLS */
  db: SupabaseClient;
}

class DemoError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new DemoError(`${what}: ${res.error.message}`);
  return res.data;
}

/** For calls whose data we do not need (Auth admin API). */
function check(res: { error: { message: string } | null }, what: string): void {
  if (res.error) throw new DemoError(`${what}: ${res.error.message}`);
}

/** Call a Supaknowledge Edge Function as a person (their access token is the bearer). */
async function callFunction<T>(path: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(`${URL}/functions/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    const err = (json as { error?: string } | null)?.error ?? text;
    throw new DemoError(`${method} /functions/v1/${path} -> ${res.status}: ${err}`, res.status === 404 ? "Are the Edge Functions running? `npx supabase start` serves them." : undefined);
  }
  return json as T;
}

const admin = createClient(URL, SECRET_KEY, noSession);

async function createPerson(name: string, email: string): Promise<Person> {
  check(await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { display_name: name } }), `create user ${email}`);
  const db = createClient(URL, PUBLISHABLE_KEY, noSession);
  const { data, error } = await db.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new DemoError(`sign in ${email}: ${error?.message ?? "no session"}`);
  return { id: data.user.id, name, email, token: data.session.access_token, db };
}

async function preflight() {
  const health = await fetch(`${URL}/auth/v1/health`, { headers: { apikey: PUBLISHABLE_KEY } }).catch(() => null);
  if (!health?.ok) {
    throw new DemoError(`no Supaknowledge stack at ${URL}`, "Start it from the repository root: cp supabase/.env.example supabase/.env && npx supabase start");
  }
  const mcp = await fetch(`${URL}/functions/v1/mcp/.well-known/oauth-protected-resource`).catch(() => null);
  if (!mcp?.ok) {
    throw new DemoError(`the Supaknowledge Edge Functions do not answer at ${URL}/functions/v1`, "`npx supabase start` serves them; check `docker logs supabase_edge_runtime_supaknowledge`.");
  }
}

// ---------------------------------------------------------------------------------------------------------
// the story
// ---------------------------------------------------------------------------------------------------------
async function run() {
  await preflight();
  const tag = Date.now().toString(36);
  const workspaceSlug = `${WORKSPACE_PREFIX}${tag}`;
  const spaceRef = `${workspaceSlug}/${SPACE_SLUG}`;
  console.log(c.bold("Supaknowledge revenue-report demo"));
  console.log(c.dim(`stack ${URL} · workspace ${workspaceSlug} · run \`npm run demo -w @supaknowledge/example-revenue-report -- --reset\` to clean up`));

  // ------------------------------------------------------------------------------------------------------
  say.step("Two people sign up (Auth admin API)");
  const lead = await createPerson("Fiona (finance lead)", `fiona-${tag}@${EMAIL_DOMAIN}`);
  const engineer = await createPerson("Eli (engineer)", `eli-${tag}@${EMAIL_DOMAIN}`);
  say.ok(`${lead.name}  ${lead.email}`);
  say.ok(`${engineer.name}  ${engineer.email}`);
  say.info(c.dim(`password for both: ${PASSWORD}`));

  // ------------------------------------------------------------------------------------------------------
  say.step("The finance lead creates the workspace, a space and the finance group (RPCs and inserts under RLS)");
  const ws = must(await lead.db.rpc("create_workspace", { p_slug: workspaceSlug, p_name: "Acme Analytics" }), "create_workspace") as { id: string; slug: string };
  const space = must(
    await lead.db.rpc("create_space", {
      p_workspace: ws.id, p_slug: SPACE_SLUG, p_name: "Revenue reporting",
      p_description: "Knowledge for Acme's finance and reporting agents", p_visibility: "workspace",
    }),
    "create_space",
  ) as { id: string };
  const finance = must(
    await lead.db.from("groups").insert({ workspace_id: ws.id, slug: "finance", name: "Finance", description: "Finance team" }).select("id").single(),
    "create group",
  ) as { id: string };
  must(await lead.db.from("group_members").insert({ group_id: finance.id, user_id: lead.id }), "join finance");
  // nobody joins a workspace without consent: the lead invites the engineer's e-mail, the engineer accepts
  const invite = must(await lead.db.rpc("invite_to_workspace", { p_workspace: ws.id, p_email: engineer.email, p_role: "member" }), "invite engineer") as { id: string };
  must(await engineer.db.rpc("accept_invitation", { p_id: invite.id }), "engineer accepts the invitation");
  // the engineer even administers the space: audiences are never bypassed by role
  must(await lead.db.from("space_members").insert({ space_id: space.id, user_id: engineer.id, role: "admin" }), "make engineer space admin");
  // space policy: low-risk data_access fixes backed by real agent work apply themselves
  must(
    await lead.db.from("spaces").update({ settings: { auto_apply: { enabled: true, kinds: ["data_access"], max_risk: "low" } } }).eq("id", space.id),
    "space settings",
  );
  say.ok(`workspace ${c.bold(workspaceSlug)} (finance lead = owner), space ${c.bold(spaceRef)}`);
  say.ok(`group ${c.bold("finance")} = { finance lead }; engineer = invited workspace member + ${c.bold("space admin")}, not in finance`);
  say.ok("policy: auto-apply low-risk data_access fixes that cite real agent work");

  // ------------------------------------------------------------------------------------------------------
  say.step("Import the Acme Analytics bundle (bundle function -> one proposal -> apply_proposal)");
  const files = readBundle();
  const imported = await callFunction<{ proposal_id: string; status: string; created: string[]; files_synced?: number; warnings: string[] }>(
    "bundle/import",
    lead.token,
    { space: spaceRef, files, apply: true, title: "Import the Acme Analytics bundle" },
  );
  say.ok(`${files.length} files -> proposal ${imported.proposal_id.slice(0, 8)} ${imported.status}; ${imported.created.length} concepts created, ${imported.files_synced ?? 0} skill file synced to Storage`);
  for (const p of imported.created) say.info(c.dim(p));
  for (const w of imported.warnings) say.warn(w);
  const restricted = must(await lead.db.from("concepts").select("path, audience").eq("space_id", space.id).neq("audience", "{}"), "restricted concepts") as { path: string }[];
  say.ok(`restricted to finance: ${restricted.map((r) => r.path).join(", ") || "(none!)"}`);

  // ------------------------------------------------------------------------------------------------------
  say.step("Wait for embeddings (trigger -> pgmq kf_embed -> cron -> embed function, gte-small)");
  const concepts = must(await lead.db.from("concepts").select("id").eq("space_id", space.id), "concepts") as { id: string }[];
  const embedDeadline = Date.now() + 180_000;
  let last = -1;
  for (;;) {
    const chunks = must(await lead.db.from("concept_chunks").select("concept_id").eq("space_id", space.id).limit(1000), "chunks") as { concept_id: string }[];
    const done = new Set(chunks.map((x) => x.concept_id)).size;
    if (done !== last) say.info(`${done}/${concepts.length} concepts embedded (${chunks.length} chunks)`);
    last = done;
    if (done >= concepts.length) break;
    if (Date.now() > embedDeadline) {
      throw new DemoError(
        "embeddings did not appear within 3 minutes",
        "The kf-embed cron job calls the embed function through pg_net with the Vault secrets project_url and kf_internal_secret (supabase/seed.sql), " +
          "and the function checks KF_INTERNAL_SECRET from supabase/.env. Check `docker logs supabase_edge_runtime_supaknowledge`.",
      );
    }
    await sleep(2000);
  }
  say.ok("hybrid search (pgvector + full-text) is ready; the link graph was rebuilt too");

  // ------------------------------------------------------------------------------------------------------
  say.step("Register a headless agent (agents function: an Auth user with app_metadata.kind = agent)");
  const created = await callFunction<{ agent: { id: string; name: string }; key: string }>("agents", lead.token, {
    workspace_id: ws.id,
    name: "revenue-report-agent",
    description: "Writes the monthly revenue report",
    spaces: [{ space_id: space.id, role: "reader" }],
  });
  const agentKey = created.key;
  say.ok(`agent ${c.bold(created.agent.name)} is a ${c.bold("reader")} of ${spaceRef}`);
  say.info(c.dim(`key ${agentKey.slice(0, 46)}… (shown once; it is the agent's Auth password)`));

  // ------------------------------------------------------------------------------------------------------
  const kf = new Supaknowledge({ url: URL, space: spaceRef, apiKey: agentKey, timeoutMs: 120_000, onError: (e) => say.warn(`trace: ${String(e)}`) });
  const agentModel = agentModelFromEnv();
  const traceInfo = { name: "November revenue report", externalId: `revenue-report-${tag}`, metadata: { requested_by: lead.email } };
  if (agentModel) {
    say.step(`The working agent writes the November report (Mastra Agent on ${agentModel.label}, @supaknowledge/mastra tools + trace)`);
    say.actor("finance lead", `"${STORY.ask}"`);
    const out = await runRealAgent(kf, agentModel.model, STORY, { ...traceInfo, author: lead.email }, (name, input, output, isError) => {
      const arg = JSON.stringify(input ?? {});
      say.actor("agent", `${name}(${arg.length > 90 ? arg.slice(0, 87) + "..." : arg})${isError ? c.red(` -> ${String(output).split("\n")[0]}`) : ""}`);
    });
    say.block(out.draft, 8);
    say.actor("finance lead", `"${STORY.correction.split(". ")[0]}."`);
    say.block(out.finalReport, 4);
    if (!out.flagged) say.warn("the agent did not call flag_knowledge this time; the curator can still mine the failed query from the trace");
    say.ok(`trace ${String(out.traceId).slice(0, 8)} recorded through the traces function (outcome: corrected, ${out.toolCalls.length} tool calls)`);
  } else {
    say.step("The working agent writes the November report (simulated agent: SDK with the agent key, over MCP)");
    say.info(c.dim("set KF_LLM_MODEL (and your endpoint or gateway key) in this shell to run a real Mastra agent instead"));
    await simulatedAgent(kf, traceInfo, lead.email);
  }

  // ------------------------------------------------------------------------------------------------------
  say.step(`Access model: who can see ${FINANCE_ONLY_PATH} (x-supaknowledge-audience: [finance])?`);
  const engineerRole = must(await engineer.db.rpc("my_space_role", { p_space: space.id }), "my_space_role");
  const viewers: [string, Supaknowledge, SupabaseClient | null][] = [
    ["finance lead", new Supaknowledge({ url: URL, space: spaceRef, accessToken: lead.token }), lead.db],
    [`engineer (${engineerRole})`, new Supaknowledge({ url: URL, space: spaceRef, accessToken: engineer.token }), engineer.db],
    ["agent (reader)", kf, null],
  ];
  for (const [who, client, db] of viewers) {
    const concept = await client.read(FINANCE_ONLY_PATH);
    const found = await client.search("board pack committed ARR forecast haircut", { limit: 5 });
    const count = db ? (must(await db.from("concepts").select("id").eq("space_id", space.id), "count") as unknown[]).length : null;
    const line = `${who.padEnd(20)} read_concept: ${concept ? c.green("visible") : c.red("not found")} · search hits it: ${found.some((h) => h.path === FINANCE_ONLY_PATH) ? c.green("yes") : c.red("no")}${count !== null ? ` · concepts visible through PostgREST: ${count}` : ""}`;
    if (concept) say.ok(line);
    else say.no(line);
  }
  say.info(c.dim("RLS decides for every principal: no role bypasses an audience, and agents act as their own Auth user."));

  // ------------------------------------------------------------------------------------------------------
  say.step("The finance lead asks the curator to run now (curator function -> request_curator_run -> pgmq kf_curator)");
  const requested = await callFunction<{ run: { id: string; status: string } }>("curator/run", lead.token, { space: spaceRef });
  const runId = requested.run.id;
  say.ok(`run ${runId.slice(0, 8)} queued; the kf-curator cron job hands it to the curator function within ~15 s`);

  const deadline = Date.now() + CURATOR_TIMEOUT_MS;
  let status = "";
  let runRow: { status: string; error: string | null; stats: Record<string, number> } | null = null;
  for (;;) {
    runRow = must(await lead.db.from("curator_runs").select("status, error, stats").eq("id", runId).single(), "curator run") as typeof runRow;
    const statsText = Object.keys(runRow!.stats ?? {}).length ? ` ${c.dim(JSON.stringify(runRow!.stats))}` : "";
    if (runRow!.status !== status) say.info(`status: ${c.bold(runRow!.status)}${statsText}`);
    status = runRow!.status;
    if (["succeeded", "failed", "cancelled"].includes(status)) break;
    if (Date.now() > deadline) throw new DemoError(`the curator run is still ${status} after ${CURATOR_TIMEOUT_MS / 1000} s`, `Follow it with \`kf runs --space ${spaceRef}\` or in Studio > Activity.`);
    await sleep(3000);
  }

  if (status === "failed" && /no model configured|KF_LLM_MODEL/.test(runRow!.error ?? "")) {
    say.warn("The curator could not call a model: KF_LLM_MODEL is not set for the Edge Functions.");
    console.log(`
    Everything up to the curator worked. To let the curator run, point it at a model:

      1. Add the model settings to ${c.bold("supabase/.env")}, for example your OpenAI-compatible endpoint:
           KF_LLM_MODEL=acme/your-model
           KF_LLM_BASE_URL=https://llm.acme.internal/v1
           KF_LLM_API_KEY=...
         or the Vercel AI Gateway:
           KF_LLM_MODEL=vercel/openai/gpt-6.2-sol
           AI_GATEWAY_API_KEY=...
      2. Restart the stack so the Edge Runtime picks them up (your data is kept):
           npx supabase stop && npx supabase start
      3. Run the curator again on this space, as the finance lead (after npm run build:cli):
           npx kf login --url ${URL} --publishable-key ${PUBLISHABLE_KEY} --email ${lead.email}   ${c.dim(`(password: ${PASSWORD})`)}
           npx kf curate --watch --space ${spaceRef}
         or simply run this demo again.

    The flag and the trace are waiting in the space. Meanwhile, see what the curator does with a scripted
    model: ${c.bold("npm run offline -w @supaknowledge/example-revenue-report")}
`);
    printReview(spaceRef, lead);
    return;
  }
  if (status !== "succeeded") {
    throw new DemoError(`curator run ${status}: ${runRow!.error ?? "(no error recorded)"}`, "Studio > Activity shows the run's tasks; `docker logs supabase_edge_runtime_supaknowledge` shows the function logs.");
  }

  // ------------------------------------------------------------------------------------------------------
  say.step("What the curator proposed");
  const proposals = must(
    await lead.db
      .from("proposals")
      .select("id, title, risk, escalation, status, auto_applied, author, proposal_ops(op, path), proposal_citations(label, ref_kind)")
      .eq("run_id", runId)
      .order("created_at"),
    "proposals",
  ) as {
    id: string; title: string; risk: string; escalation: boolean; status: string; auto_applied: boolean; author: string;
    proposal_ops: { op: string; path: string }[]; proposal_citations: { label: string; ref_kind: string }[];
  }[];
  if (!proposals.length) say.warn("no proposals (the model decided nothing needed to change; see the run's tasks in Studio > Activity)");
  for (const p of proposals) {
    const state = p.status === "applied" ? c.green(p.auto_applied ? "auto-applied by policy" : "applied") : c.yellow(p.status);
    console.log(`\n    ${c.bold(p.title)}  ${c.dim(p.id.slice(0, 8))}`);
    say.info(`risk ${p.risk}${p.escalation ? c.red(" · ESCALATION: a space admin in the cited audience must approve") : ""} · ${state} · by ${p.author}`);
    say.info(`ops: ${p.proposal_ops.map((o) => `${o.op} ${o.path}`).join(", ")}`);
    say.info(`citations: ${p.proposal_citations.map((x) => `[^${x.label}] ${x.ref_kind}`).join(", ") || "(none)"}`);
  }
  const flags = must(await lead.db.from("flags").select("status, synthetic").eq("space_id", space.id), "flags") as { status: string; synthetic: boolean }[];
  say.info(`\n    flags: ${flags.map((f) => `${f.synthetic ? "mined from trace" : "raised by agent"} -> ${f.status}`).join("; ")}`);
  printReview(spaceRef, lead);
}

/** The working agent's story, scripted: real SDK calls over MCP, a simulated model. */
async function simulatedAgent(kf: Supaknowledge, traceInfo: { name: string; externalId: string; metadata: Record<string, unknown> }, leadEmail: string) {
  const trace = kf.trace({ ...traceInfo, flushIntervalMs: 0 });
  trace.user(STORY.ask);
  await trace.start();
  say.actor("finance lead", `"${STORY.ask}"`);

  const skills = await kf.listSkills();
  say.actor("agent", `list_skills -> ${skills.map((s) => s.name).join(", ")}`);
  const skill = await kf.loadSkill(SKILL_NAME);
  trace.tool({ name: "load_skill", input: { name: SKILL_NAME }, output: skill?.markdown ?? null });
  say.actor("agent", `load_skill("${SKILL_NAME}") -> ${skill?.body.split("\n").filter((l) => /^\d+\./.test(l)).length ?? 0} steps, files: ${(skill?.files ?? []).map((f) => f.path).join(", ")}`);

  const hits = await kf.search("which table has monthly revenue by region", { kinds: ["data_access"], limit: 3, traceId: trace.externalId });
  trace.tool({ name: "search_knowledge", input: { query: "which table has monthly revenue by region" }, output: hits.map((h) => h.path) });
  say.actor("agent", "search_knowledge(\"which table has monthly revenue by region\")");
  for (const h of hits) say.info(`${c.bold(h.path)}  ${c.dim(`${h.trust ?? ""}${h.stale ? " stale" : ""}`)}  ${h.title}`);

  const table = await kf.read(REVENUE_TABLE_PATH);
  if (!table) throw new DemoError(`${REVENUE_TABLE_PATH} is not readable by the agent`);
  const documented = /```sql\n([\s\S]*?)```/.exec(table.body)?.[1]?.trim() ?? STORY.firstQuery;
  trace.tool({ name: "read_concept", input: { path: REVENUE_TABLE_PATH }, output: table.markdown ?? table.body });
  say.actor("agent", `read_concept("${REVENUE_TABLE_PATH}") -> revision ${table.revision}, trust ${table.trust}`);

  let error = "";
  try {
    runWarehouseQuery(documented);
  } catch (e) {
    if (!(e instanceof WarehouseError)) throw e;
    error = e.message;
  }
  trace.tool({ name: "bigquery.query", input: { sql: documented }, output: error, isError: true });
  say.actor("warehouse", c.red(error || "(unexpectedly succeeded)"));
  const fixed = documented.replace(/sum\(revenue_usd\)/g, "sum(revenue_usd_net)");
  const result = runWarehouseQuery(fixed);
  trace.tool({ name: "bigquery.query", input: { sql: fixed }, output: result.rows });
  say.actor("agent", `retries with revenue_usd_net -> ${result.rows.map((r) => `${r.region} ${money(r.revenue_usd)}`).join(", ")}`);

  const flag = await trace.flag({ kind: STORY.flag.kind, conceptPath: REVENUE_TABLE_PATH, query: STORY.flag.query, observation: STORY.flag.observation, suggestedFix: STORY.flag.suggestedFix });
  say.actor("agent", `flag_knowledge(kind=${STORY.flag.kind}, concept_path=${REVENUE_TABLE_PATH}, suggested_fix=…) -> flag ${String(flag?.id ?? "?").slice(0, 8)}`);

  trace.assistant(STORY.draftWithoutHeader);
  trace.feedback(STORY.correction, { author: leadEmail });
  trace.assistant(STORY.draftWithHeader + STORY.draftWithoutHeader);
  const traceId = await trace.end({ outcome: "corrected" });
  say.actor("finance lead", `"${STORY.correction.split(". ")[0]}."`);
  say.ok(`trace ${String(traceId).slice(0, 8)} recorded through the traces function (outcome: corrected)`);

}

function printReview(spaceRef: string, lead: Person) {
  const [ws, sp] = spaceRef.split("/");
  say.step("Look at it in Studio or with kf");
  console.log(`
    Studio  ${c.bold(`${STUDIO_URL}/w/${ws}/${sp}`)}   ${c.dim("(npm run studio; sign in as the finance lead)")}
            ${lead.email} / ${PASSWORD}

    kf      npm run build:cli                     ${c.dim("(once, from the repo root: builds kf and links it)")}
            npx kf login --url ${URL} --publishable-key ${PUBLISHABLE_KEY} --email ${lead.email}
            npx kf proposals --space ${spaceRef}
            npx kf proposal <id> --space ${spaceRef}
            npx kf approve <id> --space ${spaceRef}

    Clean up: npm run demo -w @supaknowledge/example-revenue-report -- --reset
`);
}

// ---------------------------------------------------------------------------------------------------------
// --reset
// ---------------------------------------------------------------------------------------------------------
async function listStorage(bucket: string, prefix: string): Promise<string[]> {
  const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) return [];
  const out: string[] = [];
  for (const item of data) {
    const p = `${prefix}/${item.name}`;
    if (item.id === null) out.push(...(await listStorage(bucket, p)));
    else out.push(p);
  }
  return out;
}

async function reset() {
  await preflight();
  say.step("Delete what earlier demo runs created (service role)");
  const workspaces = must(await admin.from("workspaces").select("id, slug").like("slug", `${WORKSPACE_PREFIX}%`), "list workspaces") as { id: string; slug: string }[];
  const ids = workspaces.map((w) => w.id);
  if (ids.length) {
    const agents = must(await admin.from("agents").select("id").in("workspace_id", ids), "list agents") as { id: string }[];
    for (const a of agents) check(await admin.auth.admin.deleteUser(a.id), "delete agent user");
    const spaces = must(await admin.from("spaces").select("id").in("workspace_id", ids), "list spaces") as { id: string }[];
    for (const s of spaces) {
      for (const bucket of ["concept-files", "sources"]) {
        const objects = await listStorage(bucket, s.id);
        if (objects.length) await admin.storage.from(bucket).remove(objects);
      }
    }
    must(await admin.from("workspaces").delete().in("id", ids), "delete workspaces");
    say.ok(`${workspaces.length} workspace(s), ${agents.length} agent(s), ${spaces.length} space(s) and their files`);
  }
  let people = 0;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new DemoError(`list users: ${error.message}`);
    for (const u of data.users) {
      if (u.email?.endsWith(`@${EMAIL_DOMAIN}`)) {
        check(await admin.auth.admin.deleteUser(u.id), "delete user");
        people++;
      }
    }
    if (data.users.length < 1000) break;
  }
  say.ok(`${people} demo user(s)`);
  if (!ids.length && !people) say.info("nothing to delete");
}

// ---------------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: npm run demo -w @supaknowledge/example-revenue-report [-- --reset]");
} else {
  (args.includes("--reset") ? reset() : run()).catch((e: unknown) => {
    console.error(`\n${c.red("error:")} ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof DemoError && e.hint) console.error(`${c.yellow("hint:")} ${e.hint}`);
    process.exit(1);
  });
}
