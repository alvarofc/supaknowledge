// Membership through the RLS'd tables: workspace_members, space_members, groups, group_members,
// space_group_grants. Users are referenced by Auth user id (profiles do not expose emails).
import type { Command } from "commander";
import { CliError, must, UUID_RE, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";
import { table } from "../render.ts";

const SPACE_ROLES = ["reader", "editor", "reviewer", "admin"];
const WS_ROLES = ["member", "admin", "owner"];

async function names(ctx: Ctx, ids: string[]): Promise<Map<string, { name: string; kind: string }>> {
  if (!ids.length) return new Map();
  const db = await ctx.db();
  const rows = (await must(db.from("profiles").select("id, display_name, kind").in("id", ids))) as { id: string; display_name: string | null; kind: string }[];
  return new Map(rows.map((r) => [r.id, { name: r.display_name ?? "", kind: r.kind }]));
}

async function userIdArg(ctx: Ctx, v: string): Promise<string> {
  if (v === "me") return ctx.userId();
  if (!UUID_RE.test(v)) throw new CliError(`"${v}" is not a user id`, { exitCode: 2, hint: "pass the Auth user id (see `kf members` or Studio); `me` means you" });
  return v;
}

async function groupBySlug(ctx: Ctx, slug: string): Promise<{ id: string; slug: string; name: string }> {
  const sp = await ctx.space();
  const db = await ctx.db();
  const g = (await must(db.from("groups").select("id, slug, name").eq("workspace_id", sp.workspace_id).eq("slug", slug).limit(1)))[0] as
    | { id: string; slug: string; name: string }
    | undefined;
  if (!g) throw new CliError(`no group "${slug}" in this workspace`, { hint: "kf groups list" });
  return g;
}

export function registerMembers(program: Command, run: Runner): void {
  const members = program.command("members").description("who can access the current space (or, with --workspace, the workspace)");

  members
    .command("list", { isDefault: true })
    .description("list members (direct, via groups, and workspace-wide access)")
    .option("--workspace", "list workspace members instead")
    .action(
      run(async (ctx: Ctx, opts: { workspace?: boolean }) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        if (opts.workspace) {
          const rows = (await must(db.from("workspace_members").select("user_id, role, created_at").eq("workspace_id", sp.workspace_id))) as { user_id: string; role: string }[];
          const n = await names(ctx, rows.map((r) => r.user_id));
          const data = rows.map((r) => ({ ...r, name: n.get(r.user_id)?.name ?? null, kind: n.get(r.user_id)?.kind ?? null }));
          ctx.out(data, () => table(["USER", "NAME", "KIND", "ROLE"], data.map((r) => [r.user_id, r.name, r.kind, r.role]), ctx.c));
          return;
        }
        const direct = (await must(db.from("space_members").select("user_id, role, created_at").eq("space_id", sp.id))) as { user_id: string; role: string }[];
        const grants = (await must(db.from("space_group_grants").select("role, groups(slug, name)").eq("space_id", sp.id))) as unknown as { role: string; groups: { slug: string; name: string } }[];
        const vis = (await must(db.from("spaces").select("visibility").eq("id", sp.id).single())) as { visibility: string };
        const n = await names(ctx, direct.map((r) => r.user_id));
        const data = {
          space: sp.ref,
          visibility: vis.visibility,
          members: direct.map((r) => ({ ...r, name: n.get(r.user_id)?.name ?? null, kind: n.get(r.user_id)?.kind ?? null })),
          group_grants: grants.map((g) => ({ group: g.groups?.slug, name: g.groups?.name, role: g.role })),
        };
        ctx.out(data, () =>
          [
            ctx.c.dim(
              data.visibility === "workspace"
                ? `${sp.ref}: every workspace member can read; workspace owners/admins are space admins`
                : `${sp.ref}: private; workspace owners/admins are space admins`,
            ),
            "",
            table(["USER", "NAME", "KIND", "ROLE"], data.members.map((m) => [m.user_id, m.name, m.kind, m.role]), ctx.c),
            ...(data.group_grants.length ? ["", table(["GROUP", "NAME", "ROLE"], data.group_grants.map((g) => [g.group, g.name, g.role]), ctx.c)] : []),
          ].join("\n"),
        );
      }),
    );

  members
    .command("add")
    .description("add a user (or agent) to the space, or with --workspace to the workspace")
    .argument("<user-id>", "Auth user id, or `me`")
    .option("--role <role>", `space: ${SPACE_ROLES.join(" | ")}; workspace: ${WS_ROLES.join(" | ")}`)
    .option("--workspace", "add to the workspace instead of the space")
    .action(
      run(async (ctx: Ctx, user: string, opts: { role?: string; workspace?: boolean }) => {
        const uid = await userIdArg(ctx, user);
        const sp = await ctx.space();
        const db = await ctx.db();
        if (opts.workspace) {
          const role = opts.role ?? "member";
          if (!WS_ROLES.includes(role)) throw new CliError(`--role must be one of ${WS_ROLES.join(", ")}`, { exitCode: 2 });
          await must(db.from("workspace_members").upsert({ workspace_id: sp.workspace_id, user_id: uid, role }));
          ctx.out({ user_id: uid, workspace_id: sp.workspace_id, role }, () => `${ctx.c.green("added")} ${uid} to the workspace as ${role}`);
          return;
        }
        const role = opts.role ?? "reader";
        if (!SPACE_ROLES.includes(role)) throw new CliError(`--role must be one of ${SPACE_ROLES.join(", ")}`, { exitCode: 2 });
        await must(db.from("space_members").upsert({ space_id: sp.id, user_id: uid, role }));
        ctx.out({ user_id: uid, space_id: sp.id, role }, () => `${ctx.c.green("added")} ${uid} to ${sp.ref} as ${role}`);
      }),
    );

  members
    .command("remove")
    .description("remove a user from the space (or with --workspace, the workspace)")
    .argument("<user-id>")
    .option("--workspace")
    .action(
      run(async (ctx: Ctx, user: string, opts: { workspace?: boolean }) => {
        const uid = await userIdArg(ctx, user);
        const sp = await ctx.space();
        const db = await ctx.db();
        const rows = (await must(
          opts.workspace
            ? db.from("workspace_members").delete().eq("workspace_id", sp.workspace_id).eq("user_id", uid).select("user_id")
            : db.from("space_members").delete().eq("space_id", sp.id).eq("user_id", uid).select("user_id"),
        )) as unknown[];
        if (!rows.length) throw new CliError("nothing removed (not a member, or you are not an admin)");
        ctx.out({ user_id: uid, removed: true }, () => `${ctx.c.red("removed")} ${uid}`);
      }),
    );

  const groups = program.command("groups").description("access groups (audiences) in the workspace");

  groups
    .command("list", { isDefault: true })
    .description("groups with member counts")
    .action(
      run(async (ctx: Ctx) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const rows = (await must(db.from("groups").select("id, slug, name, description, group_members(count)").eq("workspace_id", sp.workspace_id).order("slug"))) as unknown as {
          id: string;
          slug: string;
          name: string;
          description: string | null;
          group_members: { count: number }[];
        }[];
        const data = rows.map(({ group_members, ...g }) => ({ ...g, members: group_members?.[0]?.count ?? 0 }));
        ctx.out(data, () => table(["SLUG", "NAME", "MEMBERS", "DESCRIPTION"], data.map((g) => [g.slug, g.name, g.members, g.description ?? ""]), ctx.c));
      }),
    );

  groups
    .command("create")
    .description("create a group (workspace admin)")
    .argument("<slug>")
    .option("--name <name>")
    .option("--description <text>")
    .action(
      run(async (ctx: Ctx, slug: string, opts: { name?: string; description?: string }) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const g = await must(db.from("groups").insert({ workspace_id: sp.workspace_id, slug, name: opts.name ?? slug, description: opts.description ?? null }).select("id, slug, name").single());
        ctx.out(g, () => `${ctx.c.green("created")} group ${slug}`);
      }),
    );

  groups
    .command("delete")
    .description("delete a group (workspace admin)")
    .argument("<slug>")
    .action(
      run(async (ctx: Ctx, slug: string) => {
        const g = await groupBySlug(ctx, slug);
        const db = await ctx.db();
        await must(db.from("groups").delete().eq("id", g.id));
        ctx.out({ id: g.id, deleted: true }, () => `${ctx.c.red("deleted")} group ${slug}`);
      }),
    );

  groups
    .command("members")
    .description("list a group's members")
    .argument("<slug>")
    .action(
      run(async (ctx: Ctx, slug: string) => {
        const g = await groupBySlug(ctx, slug);
        const db = await ctx.db();
        const rows = (await must(db.from("group_members").select("user_id, created_at").eq("group_id", g.id))) as { user_id: string }[];
        const n = await names(ctx, rows.map((r) => r.user_id));
        const data = rows.map((r) => ({ ...r, name: n.get(r.user_id)?.name ?? null }));
        ctx.out(data, () => table(["USER", "NAME"], data.map((r) => [r.user_id, r.name]), ctx.c));
      }),
    );

  groups
    .command("add")
    .description("add a user to a group (workspace admin)")
    .argument("<slug>")
    .argument("<user-id>", "Auth user id, or `me`")
    .action(
      run(async (ctx: Ctx, slug: string, user: string) => {
        const g = await groupBySlug(ctx, slug);
        const uid = await userIdArg(ctx, user);
        const db = await ctx.db();
        await must(db.from("group_members").upsert({ group_id: g.id, user_id: uid }));
        ctx.out({ group: slug, user_id: uid }, () => `${ctx.c.green("added")} ${uid} to ${slug}`);
      }),
    );

  groups
    .command("remove")
    .description("remove a user from a group (workspace admin)")
    .argument("<slug>")
    .argument("<user-id>")
    .action(
      run(async (ctx: Ctx, slug: string, user: string) => {
        const g = await groupBySlug(ctx, slug);
        const uid = await userIdArg(ctx, user);
        const db = await ctx.db();
        await must(db.from("group_members").delete().eq("group_id", g.id).eq("user_id", uid));
        ctx.out({ group: slug, user_id: uid, removed: true }, () => `${ctx.c.red("removed")} ${uid} from ${slug}`);
      }),
    );

  groups
    .command("grant")
    .description("give a group a role on the current space (space admin)")
    .argument("<slug>")
    .option("--role <role>", SPACE_ROLES.join(" | "), "reader")
    .action(
      run(async (ctx: Ctx, slug: string, opts: { role: string }) => {
        if (!SPACE_ROLES.includes(opts.role)) throw new CliError(`--role must be one of ${SPACE_ROLES.join(", ")}`, { exitCode: 2 });
        const g = await groupBySlug(ctx, slug);
        const sp = await ctx.space();
        const db = await ctx.db();
        await must(db.from("space_group_grants").upsert({ space_id: sp.id, group_id: g.id, role: opts.role }));
        ctx.out({ group: slug, space: sp.ref, role: opts.role }, () => `${ctx.c.green("granted")} ${slug} ${opts.role} on ${sp.ref}`);
      }),
    );

  groups
    .command("revoke")
    .description("remove a group's role on the current space (space admin)")
    .argument("<slug>")
    .action(
      run(async (ctx: Ctx, slug: string) => {
        const g = await groupBySlug(ctx, slug);
        const sp = await ctx.space();
        const db = await ctx.db();
        await must(db.from("space_group_grants").delete().eq("space_id", sp.id).eq("group_id", g.id));
        ctx.out({ group: slug, space: sp.ref, revoked: true }, () => `${ctx.c.red("revoked")} ${slug} on ${sp.ref}`);
      }),
    );
}
