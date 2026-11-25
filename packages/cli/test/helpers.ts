import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/context.ts";
import { main } from "../src/program.ts";

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}
export type Route = (c: Call) => Response | undefined | Promise<Response | undefined>;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

export function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

export const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const WS_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const URL = "http://kf.test";

export interface Harness {
  dir: string;
  configDir: string;
  calls: Call[];
  routes: Route[];
  run: (...argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** run with a different working directory (e.g. a subdirectory of the project) */
  runIn: (cwd: string, ...argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  stdin: string;
  stdinIsTTY: boolean;
  /** answers for io.prompt (in order); prompting throws when empty */
  prompts: string[];
  /** extra environment variables */
  env: Record<string, string>;
  /** overrides for the Io (e.g. run, randomHex, sleep) */
  io: Partial<Io>;
}

/** Temp project + config dir, scripted fetch, in-memory stdio. */
export function harness(opts: { loggedIn?: boolean; project?: boolean; expiresIn?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kf-test-"));
  const configDir = join(dir, ".config");
  mkdirSync(configDir);
  if (opts.loggedIn !== false) {
    const exp = Math.floor(Date.now() / 1000) + (opts.expiresIn ?? 3600);
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        current_profile: "default",
        profiles: {
          default: {
            url: URL,
            publishable_key: "pk_test",
            session: { access_token: fakeJwt({ sub: USER_ID, exp, email: "me@acme.test", role: "authenticated" }), refresh_token: "rt-1", expires_at: exp },
          },
        },
      }),
    );
  }
  if (opts.project !== false) writeFileSync(join(dir, ".supaknowledge.json"), JSON.stringify({ space: "acme/finance", space_id: SPACE_ID }));
  const h: Harness = {
    dir,
    configDir,
    calls: [],
    routes: [],
    stdin: "",
    stdinIsTTY: false,
    prompts: [],
    env: {},
    io: {},
    run: (...argv) => h.runIn(dir, ...argv),
    runIn: async (cwd, ...argv) => {
      let stdout = "";
      let stderr = "";
      const io: Io = {
        stdout: (s) => void (stdout += s),
        stderr: (s) => void (stderr += s),
        readStdin: async () => h.stdin,
        prompt: async () => {
          const next = h.prompts.shift();
          if (next === undefined) throw new Error("no tty");
          return next;
        },
        isTTY: false,
        stdinIsTTY: h.stdinIsTTY,
        env: { SUPAKNOWLEDGE_CONFIG_DIR: configDir, HOME: dir, ...h.env },
        cwd,
        now: () => Date.now(),
        sleep: async () => {},
        fetch: async (input, init = {}) => {
          const headers: Record<string, string> = {};
          new Headers(init.headers).forEach((v, k) => (headers[k] = v));
          let body: any = init.body;
          if (typeof body === "string") {
            try {
              body = JSON.parse(body);
            } catch {
              /* text */
            }
          }
          const call = { method: (init.method ?? "GET").toUpperCase(), url: String(input), headers, body };
          h.calls.push(call);
          for (const r of h.routes) {
            const res = await r(call);
            if (res) return res;
          }
          return json({ message: `unmocked ${call.method} ${call.url}` }, 599);
        },
        ...h.io,
      };
      const code = await main(argv, io);
      return { code, stdout, stderr };
    },
  };
  return h;
}

/** PostgREST lookup of acme/finance used by most commands. */
export const spaceRoute: Route = (c) =>
  c.url.includes("/rest/v1/spaces?") ? json([{ id: SPACE_ID, slug: "finance", name: "Finance", workspace_id: WS_ID, workspaces: { slug: "acme" } }]) : undefined;
