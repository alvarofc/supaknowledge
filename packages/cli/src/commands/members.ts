// Membership through the RLS'd tables: workspace_members, space_members, groups, group_members,
// space_group_grants. Users are referenced by Auth user id (profiles do not expose emails).
// Nobody is added to a workspace without consent: admins invite by e-mail (invite_to_workspace) and the
// invitee accepts with `kf invitations accept <id>`. Space and group membership need workspace membership first.
import type { Command } from "commander";
import { CliError, must, mustRows, UUID_RE, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";
import { table } from "../render.ts";

const SPACE_ROLES = ["reader", "editor", "reviewer", "admin"];
const WS_ROLES = ["member", "admin", "owner"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Normalized e-mail + workspace role for `kf members invite` (same rules as invite_to_workspace). */
export function parseInvite(email: string, role: string | undefined): { email: string; role: string } {
  const e = (email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 320) throw new CliError(`"${email}" is not an e-mail address`, { exitCode: 2 });
  if (e.endsWith("@agents.supaknowledge.internal")) {
    throw new CliError("agents are not invited", { exitCode: 2, hint: "create one with `kf agents create`" });
  }
  const r = role ?? "member";
  if (!WS_ROLES.includes(r)) throw new CliError(`--role must be one of ${WS_ROLES.join(", ")}`, { exitCode: 2 });
  return { email: e, role: r };
}

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  invited_by?: string | null;
  created_at: string;
  expires_at: string;
  accepted_at?: string | null;
  declined_at?: string | null;
}

/** pending | expired | accepted | declined */
export function invitationStatus(i: Pick<InvitationRow, "expires_at" | "accepted_at" | "declined_at">, now: number): string {
  if (i.accepted_at) return "accepted";
  if (i.declined_at) return "declined";
  return Date.parse(i.expires_at) <= now ? "expired" : "pending";
}

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
    .description("add a workspace member (or agent) to the space; with --workspace, change a workspace member's role")
    .argument("<user-id>", "Auth user id, or `me`")
    .option("--role <role>", `space: ${SPACE_ROLES.join(" | ")}; workspace: ${WS_ROLES.join(" | ")}`)
    .option("--workspace", "change the workspace role of an existing member (new people: `kf members invite`)")
    .action(
      run(async (ctx: Ctx, user: string, opts: { role?: string; workspace?: boolean }) => {
        const uid = await userIdArg(ctx, user);
        const sp = await ctx.space();
        const db = await ctx.db();
        if (opts.workspace) {
          // existing workspace members only: people join a workspace by accepting an invitation
          const role = opts.role ?? "member";
          if (!WS_ROLES.includes(role)) throw new CliError(`--role must be one of ${WS_ROLES.join(", ")}`, { exitCode: 2 });
          await mustRows(
            db.from("workspace_members").update({ role }).eq("workspace_id", sp.workspace_id).eq("user_id", uid).select("user_id"),
            "nothing changed (not a workspace member, or you are not a workspace admin)",
            "to bring someone new into the workspace: kf members invite <email> [--role member|admin|owner]",
          );
          ctx.out({ user_id: uid, workspace_id: sp.workspace_id, role }, () => `${ctx.c.green("updated")} ${uid}: workspace role ${role}`);
          return;
        }
        const role = opts.role ?? "reader";
        if (!SPACE_ROLES.includes(role)) throw new CliError(`--role must be one of ${SPACE_ROLES.join(", ")}`, { exitCode: 2 });
        await mustRows(
          db.from("space_members").upsert({ space_id: sp.id, user_id: uid, role }).select("user_id"),
          "nothing changed (you are not a space admin)",
        );
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

  members
    .command("invite")
    .description("invite someone to the workspace by e-mail (workspace admin); they accept with `kf invitations accept`")
    .argument("<email>")
    .option("--role <role>", WS_ROLES.join(" | "), "member")
    .action(
      run(async (ctx: Ctx, email: string, opts: { role?: string }) => {
        const inv = parseInvite(email, opts.role);
        const sp = await ctx.space();
        const db = await ctx.db();
        const row = (await must(db.rpc("invite_to_workspace", { p_workspace: sp.workspace_id, p_email: inv.email, p_role: inv.role }))) as InvitationRow;
        ctx.out(row, () =>
          [
            `${ctx.c.green("invited")} ${row.email} as ${row.role} ${ctx.c.dim(`(id ${row.id}, expires ${row.expires_at.slice(0, 10)})`)}`,
            ctx.c.dim("they accept in Studio or with `kf invitations accept <id>` after signing in with that e-mail"),
          ].join("\n"),
        );
      }),
    );

  members
    .command("invitations")
    .description("open invitations of the workspace (workspace admin)")
    .option("--all", "include accepted, declined and expired invitations")
    .action(
      run(async (ctx: Ctx, opts: { all?: boolean }) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        let q = db
          .from("workspace_invitations")
          .select("id, email, role, invited_by, created_at, expires_at, accepted_at, declined_at")
          .eq("workspace_id", sp.workspace_id)
          .order("created_at", { ascending: false });
        if (!opts.all) q = q.is("accepted_at", null).is("declined_at", null);
        const rows = (await must(q)) as InvitationRow[];
        const now = ctx.io.now();
        const data = rows.map((r) => ({ ...r, status: invitationStatus(r, now) }));
        ctx.out(data, () =>
          data.length
            ? table(["ID", "EMAIL", "ROLE", "STATUS", "EXPIRES"], data.map((r) => [r.id, r.email, r.role, r.status, r.expires_at.slice(0, 10)]), ctx.c)
            : ctx.c.dim("no open invitations (or you are not a workspace admin)"),
        );
      }),
    );

  members
    .command("uninvite")
    .description("revoke an invitation (workspace admin)")
    .argument("<invitation-id>")
    .action(
      run(async (ctx: Ctx, id: string) => {
        if (!UUID_RE.test(id)) throw new CliError(`"${id}" is not an invitation id`, { exitCode: 2, hint: "kf members invitations" });
        const db = await ctx.db();
        await mustRows(
          db.from("workspace_invitations").delete().eq("id", id).select("id"),
          "nothing revoked (no such invitation, or you are not a workspace admin)",
        );
        ctx.out({ id, revoked: true }, () => `${ctx.c.red("revoked")} invitation ${id}`);
      }),
    );

  const invitations = program.command("invitations").description("invitations to workspaces addressed to you");

  invitations
    .command("list", { isDefault: true })
    .description("your open invitations")
    .action(
      run(async (ctx: Ctx) => {
        const db = await ctx.db();
        const rows = (await must(db.rpc("list_my_invitations"))) as {
          id: string;
          workspace_slug: string;
          workspace_name: string;
          role: string;
          invited_by_name: string | null;
          expires_at: string;
        }[];
        ctx.out(rows, () =>
          rows.length
            ? table(
                ["ID", "WORKSPACE", "ROLE", "INVITED BY", "EXPIRES"],
                rows.map((r) => [r.id, `${r.workspace_slug} (${r.workspace_name})`, r.role, r.invited_by_name ?? "", r.expires_at.slice(0, 10)]),
                ctx.c,
              )
            : ctx.c.dim("no open invitations (invitations match the verified e-mail of your account)"),
        );
      }),
    );

  invitations
    .command("accept")
    .description("join the workspace")
    .argument("<id>")
    .action(
      run(async (ctx: Ctx, id: string) => {
        if (!UUID_RE.test(id)) throw new CliError(`"${id}" is not an invitation id`, { exitCode: 2, hint: "kf invitations" });
        const db = await ctx.db();
        const ws = (await must(db.rpc("accept_invitation", { p_id: id }))) as { id: string; slug: string; name: string };
        ctx.out(ws, () => `${ctx.c.green("joined")} ${ws.slug} ${ctx.c.dim(`(${ws.name})`)}`);
      }),
    );

  invitations
    .command("decline")
    .description("decline an invitation")
    .argument("<id>")
    .action(
      run(async (ctx: Ctx, id: string) => {
        if (!UUID_RE.test(id)) throw new CliError(`"${id}" is not an invitation id`, { exitCode: 2, hint: "kf invitations" });
        const db = await ctx.db();
        await must(db.rpc("decline_invitation", { p_id: id }));
        ctx.out({ id, declined: true }, () => `${ctx.c.red("declined")} invitation ${id}`);
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
        await mustRows(db.from("groups").delete().eq("id", g.id).select("id"), "nothing deleted (you are not a workspace admin)");
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
        await mustRows(
          db.from("group_members").upsert({ group_id: g.id, user_id: uid }).select("user_id"),
          "nothing changed (you are not a workspace admin)",
        );
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
        await mustRows(
          db.from("group_members").delete().eq("group_id", g.id).eq("user_id", uid).select("user_id"),
          `nothing removed (${uid} is not in ${slug}, or you are not a workspace admin)`,
        );
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
        await mustRows(
          db.from("space_group_grants").upsert({ space_id: sp.id, group_id: g.id, role: opts.role }).select("group_id"),
          "nothing changed (you are not a space admin)",
        );
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
        await mustRows(
          db.from("space_group_grants").delete().eq("space_id", sp.id).eq("group_id", g.id).select("group_id"),
          `nothing revoked (${slug} has no role on ${sp.ref}, or you are not a space admin)`,
        );
        ctx.out({ group: slug, space: sp.ref, revoked: true }, () => `${ctx.c.red("revoked")} ${slug} on ${sp.ref}`);
      }),
    );
}
