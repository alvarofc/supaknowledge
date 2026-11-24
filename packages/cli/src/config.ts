// ~/.config/supaknowledge/config.json (profiles) + .supaknowledge.json (project default space) + env overrides.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface StoredSession {
  access_token: string;
  refresh_token?: string | null;
  /** epoch seconds */
  expires_at?: number | null;
  user?: { id: string; email?: string | null; kind?: string | null };
}

export interface Profile {
  url?: string;
  publishable_key?: string;
  session?: StoredSession | null;
}

export interface ConfigFile {
  current_profile?: string;
  profiles: Record<string, Profile>;
}

export interface ProjectFile {
  /** "<workspace>/<space>" */
  space: string;
  space_id?: string;
  workspace_id?: string;
  url?: string;
}

export type Env = Record<string, string | undefined>;

export function configDir(env: Env): string {
  if (env.SUPAKNOWLEDGE_CONFIG_DIR) return env.SUPAKNOWLEDGE_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "supaknowledge");
}

export function configPath(env: Env): string {
  return join(configDir(env), "config.json");
}

export function loadConfig(env: Env): ConfigFile {
  const p = configPath(env);
  if (!existsSync(p)) return { profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<ConfigFile>;
    return { current_profile: parsed.current_profile, profiles: parsed.profiles ?? {} };
  } catch (e) {
    throw new Error(`could not parse ${p}: ${(e as Error).message}`);
  }
}

export function saveConfig(env: Env, cfg: ConfigFile): void {
  const p = configPath(env);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600); // tokens live here
  } catch {
    /* best effort on filesystems without modes */
  }
}

export const PROJECT_FILE = ".supaknowledge.json";

/** Find .supaknowledge.json in cwd or any parent. */
export function findProjectFile(cwd: string): { path: string; data: ProjectFile } | null {
  let dir = resolve(cwd);
  for (;;) {
    const p = join(dir, PROJECT_FILE);
    if (existsSync(p)) {
      try {
        return { path: p, data: JSON.parse(readFileSync(p, "utf8")) as ProjectFile };
      } catch (e) {
        throw new Error(`could not parse ${p}: ${(e as Error).message}`);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function writeProjectFile(dir: string, data: ProjectFile): string {
  const p = join(dir, PROJECT_FILE);
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  return p;
}
