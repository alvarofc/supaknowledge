// Pure helpers for `kf deploy`: dotenv parsing, which settings become function secrets, the Auth redirect
// allow-list merge, SQL literal quoting, JSONC handling and the function sizes `supabase functions deploy` prints.

/**
 * Parse a dotenv file: `KEY=value`, optional `export `, `#` comments (whole line, or after whitespace in an
 * unquoted value), double quotes (with \n \r \t \" \\ escapes, may span lines), single quotes and backticks
 * (literal, may span lines; e.g. KF_LLM_EXTRA_BODY='{"a":1}'). Later keys win.
 */
export function parseDotenv(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const s = src.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const KEY = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/;
  let i = 0;
  while (i < s.length) {
    const eol = s.indexOf("\n", i);
    const lineEnd = eol === -1 ? s.length : eol;
    const line = s.slice(i, lineEnd);
    const m = KEY.exec(line);
    if (!m) {
      i = lineEnd + 1;
      continue;
    }
    const key = m[1]!;
    const p = i + m[0].length;
    const q = s[p];
    if (q === '"' || q === "'" || q === "`") {
      let value = "";
      let j = p + 1;
      let closed = false;
      for (; j < s.length; j++) {
        const ch = s[j]!;
        if (q === '"' && ch === "\\" && j + 1 < s.length) {
          const nx = s[++j]!;
          value += nx === "n" ? "\n" : nx === "r" ? "\r" : nx === "t" ? "\t" : nx === '"' || nx === "\\" ? nx : `\\${nx}`;
          continue;
        }
        if (ch === q) {
          closed = true;
          break;
        }
        value += ch;
      }
      if (closed) {
        out.set(key, value);
        const after = s.indexOf("\n", j);
        i = after === -1 ? s.length : after + 1;
        continue;
      }
      // unterminated quote: take the rest of the line literally (like dotenv)
    }
    let value = s.slice(p, lineEnd);
    const hash = /(^|[ \t])#/.exec(value);
    if (hash) value = value.slice(0, hash.index);
    out.set(key, value.trim());
    i = lineEnd + 1;
  }
  return out;
}

/** Settings `--env-file` may upload as function secrets. */
export const FUNCTION_SECRET_RE =
  /^(KF_LLM_|KF_CONNECTOR|KF_CONNECTORS_|KF_EMBEDS_|KF_CURATOR_|KF_LLM_MAX|AI_GATEWAY_API_KEY$|OPENROUTER_API_KEY$|GITHUB_TOKEN$|CONNECTOR_DOC_LIMIT$|CONNECTOR_TIME_BUDGET_MS$)/;

export interface SecretSelection {
  upload: { name: string; value: string }[];
  ignored: { name: string; reason: string }[];
  /** allowed names with an empty value (not uploaded) */
  empty: string[];
}

/** Which entries of an env file become function secrets. Never returns values in `ignored`/`empty`. */
export function selectEnvSecrets(env: Map<string, string>): SecretSelection {
  const sel: SecretSelection = { upload: [], ignored: [], empty: [] };
  for (const [name, value] of env) {
    if (name === "KF_INTERNAL_SECRET") sel.ignored.push({ name, reason: "kf deploy manages it (Vault kf_internal_secret)" });
    else if (name === "KF_PUBLIC_URL") sel.ignored.push({ name, reason: "use --public-url" });
    else if (name.startsWith("SUPABASE_")) sel.ignored.push({ name, reason: "SUPABASE_* is provided by the platform" });
    else if (!FUNCTION_SECRET_RE.test(name)) sel.ignored.push({ name, reason: "not a Supaknowledge function setting" });
    else if (value === "") sel.empty.push(name);
    else sel.upload.push({ name, value });
  }
  return sel;
}

/** Add `<origin>/**` for each origin to a comma-separated redirect allow-list, keeping existing entries. */
export function mergeAllowList(existing: string | null | undefined, origins: string[]): { value: string; added: string[] } {
  const list = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const added: string[] = [];
  for (const o of origins) {
    const entry = `${o.replace(/\/+$/, "")}/**`;
    if (!list.includes(entry)) {
      list.push(entry);
      added.push(entry);
    }
  }
  return { value: list.join(","), added };
}

/** An http(s) origin (no path, query or credentials); returns it normalized, or null. */
export function parseOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return u.origin;
}

/** A Postgres string literal (standard_conforming_strings: only ' needs doubling). */
export function sqlLiteral(s: string): string {
  if (s.includes("\0")) throw new Error("NUL byte in SQL literal");
  return `'${s.replace(/'/g, "''")}'`;
}

/** Strip // and /* *\/ comments and trailing commas from JSONC, leaving strings untouched. */
export function jsoncToJson(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // trailing commas (strings are copied verbatim, so scan again with the same string rule)
  let res = "";
  for (let k = 0; k < out.length; k++) {
    const ch = out[k]!;
    if (ch === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (ch === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j]!)) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    res += ch;
  }
  return res;
}

/**
 * The project config for deploying functions from a clean copy: `edge_runtime.secrets` removed, so the Supabase
 * CLI has no `env(...)` secrets to resolve (and upload) from a .env file or the environment. Returns null when
 * the file cannot be parsed.
 */
export function configWithoutSecrets(jsonc: string): string | null {
  try {
    const cfg = JSON.parse(jsoncToJson(jsonc)) as Record<string, unknown>;
    const rt = cfg.edge_runtime as Record<string, unknown> | undefined;
    if (rt && typeof rt === "object") delete rt.secrets;
    return JSON.stringify(cfg, null, 2) + "\n";
  } catch {
    return null;
  }
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };

/** `Deploying Function: curator (script size: 19.1MB)` lines -> bytes per function. */
export function parseFunctionSizes(output: string): Map<string, number> {
  const sizes = new Map<string, number>();
  const re = /Deploying Function:\s*(\S+)\s*\(script size:\s*([\d.]+)\s*([KMG]i?B|B)\)/gi;
  for (const m of output.matchAll(re)) {
    const unit = UNITS[m[3]!.toLowerCase()];
    if (unit) sizes.set(m[1]!, Math.round(Number(m[2]) * unit));
  }
  return sizes;
}

export const formatMB = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * Replace every occurrence of each secret (6+ chars: shorter values are settings like `true` or `50`, and blanking
 * them would mangle all output) with ***. Longest first, so a secret that is a prefix of another cannot leave the
 * longer one's tail visible.
 */
export function redactor(secrets: () => Iterable<string | undefined>): (s: string) => string {
  return (s) => {
    let out = s;
    const values = [...secrets()].filter((v): v is string => !!v && v.length >= 6).sort((a, b) => b.length - a.length);
    for (const v of values) out = out.split(v).join("***");
    return out;
  };
}

/**
 * Streamed child output, redacted: only complete lines are printed (secrets never contain newlines), so a secret
 * split across two chunks is still caught. `flush` prints the rest.
 */
export function lineRedactor(redact: (s: string) => string, write: (s: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      const nl = pending.lastIndexOf("\n");
      if (nl === -1) return;
      write(redact(pending.slice(0, nl + 1)));
      pending = pending.slice(nl + 1);
    },
    flush() {
      if (pending) write(redact(pending));
      pending = "";
    },
  };
}

export function tail(output: string, lines = 20): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}
