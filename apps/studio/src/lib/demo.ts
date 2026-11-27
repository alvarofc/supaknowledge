// Public demo mode (KF_DEMO on the Studio server): visitors sign in as anonymous Supabase Auth users and join the
// demo space through the join_demo() RPC. The database restricts them (read, search, rate-limited flags).

/** KF_DEMO: "true", "1" or "on" turns the demo sign-in on; anything else leaves it off. */
export function demoEnabled(value: string | undefined): boolean {
  return /^(1|true|on)$/i.test((value ?? "").trim());
}

export type DemoJoin = { workspace: string; space: string };

/** What join_demo() returned, or null when it is not a { workspace, space } object. */
export function parseDemoJoin(data: unknown): DemoJoin | null {
  if (!data || typeof data !== "object") return null;
  const { workspace, space } = data as Record<string, unknown>;
  return typeof workspace === "string" && typeof space === "string" && workspace && space ? { workspace, space } : null;
}

/** Where a visitor lands: back to an OAuth consent request (an MCP client signing in), else the demo space. */
export function demoLanding(join: DemoJoin, next: string): string {
  if (next.startsWith("/oauth/consent")) return next;
  return `/w/${encodeURIComponent(join.workspace)}/${encodeURIComponent(join.space)}`;
}

/** A sentence for the sign-in page from an Auth or join_demo() error. */
export function demoErrorMessage(message: string): string {
  if (/anonymous sign-?ins? (are|is) disabled/i.test(message)) return "The demo is not available on this server: anonymous sign-ins are turned off in Supabase Auth.";
  if (/no demo space/i.test(message)) return "The demo is not set up yet: no demo space is configured.";
  if (/rate limit|too many/i.test(message)) return "Too many demo sign-ins from this network. Try again in an hour.";
  if (/captcha/i.test(message)) return "The demo sign-in needs a CAPTCHA, which this Studio does not support yet. Sign in with an account instead.";
  return message || "The demo sign-in failed.";
}
