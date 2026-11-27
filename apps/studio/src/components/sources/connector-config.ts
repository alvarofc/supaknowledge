import type { Database, Json } from "@/lib/database.types";

// Connector definitions and config <-> form conversion. Pure (no React) so it can be unit tested
// (test/connector-config.test.ts). The keys must match what each connector's parseConfig reads
// (supabase/functions/connectors/lib/*.ts).

export type ConnectorKind = Database["public"]["Enums"]["connector_kind"];

export type ConfigField = {
  key: string;
  label: string;
  kind: "list" | "text" | "number" | "boolean";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  pattern?: RegExp;
  patternMessage?: string;
  /** number fields: inclusive bounds (the connector clamps to the same range) */
  min?: number;
  max?: number;
  /** boolean fields: the connector's default when the key is absent */
  defaultValue?: boolean;
  /**
   * list fields: also split on commas. Only for plain IDs; URLs and globs may contain commas, so by default a
   * list is one item per line.
   */
  commaSeparated?: boolean;
  /** older keys written by earlier Studio versions; read when `key` is absent and removed on save */
  legacyKeys?: string[];
};

export type ConnectorDef = {
  kind: ConnectorKind;
  label: string;
  description: string;
  fields: ConfigField[];
  /** label of the write-only credential, or null when the connector needs none */
  token: { label: string; placeholder: string; hint: string; multiline?: boolean; optional?: boolean } | null;
};

export const CONNECTORS: ConnectorDef[] = [
  {
    kind: "notion",
    label: "Notion",
    description: "Pages and databases shared with your Notion integration.",
    fields: [
      { key: "database_ids", label: "Database IDs", kind: "list", placeholder: "a1b2c3d4e5f6…", hint: "One per line. Every page in these databases is synced.", commaSeparated: true },
      { key: "page_ids", label: "Page IDs", kind: "list", placeholder: "f6e5d4c3b2a1…", hint: "One per line. The page and its children are synced.", commaSeparated: true },
    ],
    token: { label: "Integration token", placeholder: "ntn_…", hint: "An internal integration secret. Share the pages/databases with the integration in Notion." },
  },
  {
    kind: "slack",
    label: "Slack",
    description: "Messages and threads from selected channels.",
    fields: [
      { key: "channels", label: "Channels", kind: "list", placeholder: "C0123456789", hint: "Channel IDs, one per line. Private channels need the bot invited.", required: true, commaSeparated: true },
    ],
    token: { label: "Bot token", placeholder: "xoxb-…", hint: "Needs channels:history, groups:history and users:read scopes." },
  },
  {
    kind: "github",
    label: "GitHub",
    description: "Markdown docs, READMEs and code comments from a repository.",
    fields: [
      {
        key: "repo",
        label: "Repository",
        kind: "text",
        placeholder: "acme/handbook",
        required: true,
        pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
        patternMessage: "Use the owner/name form, e.g. acme/handbook",
      },
      {
        key: "ref",
        label: "Branch or ref",
        kind: "text",
        placeholder: "main",
        hint: "A branch, tag or commit. Defaults to the repository's default branch.",
        legacyKeys: ["branch"],
      },
      {
        key: "paths",
        label: "Paths",
        kind: "list",
        placeholder: "docs/**\nREADME.md",
        hint: "Globs of files to include, one per line. Empty = all Markdown files and docs/**.",
      },
    ],
    token: { label: "Access token", placeholder: "github_pat_…", hint: "A fine-grained token with read access to contents.", optional: true },
  },
  {
    kind: "gdrive",
    label: "Google Drive",
    description: "Docs, Sheets and files in shared folders.",
    fields: [{ key: "folder_ids", label: "Folder IDs", kind: "list", placeholder: "1AbCdEfGh…", hint: "One per line. Share each folder with the service account.", required: true, commaSeparated: true }],
    token: { label: "Service account key (JSON)", placeholder: '{ "type": "service_account", … }', hint: "Paste the full JSON key file.", multiline: true },
  },
  {
    kind: "web",
    label: "Web pages",
    description: "Public pages such as docs sites, changelogs and status pages.",
    fields: [
      {
        key: "urls",
        label: "URLs",
        kind: "list",
        placeholder: "https://docs.example.com/",
        hint: "One per line. Needed unless you give a sitemap.",
        pattern: /^https?:\/\//,
        patternMessage: "Each URL must start with http:// or https://",
      },
      {
        key: "sitemap",
        label: "Sitemap",
        kind: "text",
        placeholder: "https://docs.example.com/sitemap.xml",
        hint: "Every page listed in it is synced.",
        pattern: /^https?:\/\//,
        patternMessage: "The sitemap URL must start with http:// or https://",
      },
      {
        key: "follow_links",
        label: "Follow links",
        kind: "boolean",
        defaultValue: false,
        hint: "Also sync pages these pages link to.",
      },
      {
        key: "same_origin_only",
        label: "Stay on the same site",
        kind: "boolean",
        defaultValue: true,
        hint: "Only sync pages on the origins of the URLs and sitemap above.",
      },
      { key: "max_pages", label: "Max pages", kind: "number", placeholder: "50", min: 1, max: 1000, hint: "Upper bound per sync (1–1000). Default 50." },
    ],
    token: null,
  },
  {
    kind: "schema",
    label: "Database schema",
    description: "Tables, columns and RLS policies of a Supabase project's database.",
    fields: [
      {
        key: "project_ref",
        label: "Project ref",
        kind: "text",
        placeholder: "abcdefghijklmnopqrst",
        required: true,
        hint: "The project your agents query, from its URL: https://<ref>.supabase.co.",
        pattern: /^([a-z]{20}|https:\/\/[a-z]{20}\.supabase\.co\/?)$/,
        patternMessage: "Use the 20-letter project ref or the project URL",
      },
      {
        key: "schemas",
        label: "Schemas",
        kind: "list",
        placeholder: "public",
        hint: "One per line. Empty = public.",
        pattern: /^[A-Za-z_][A-Za-z0-9_$]*$/,
        patternMessage: "Use plain schema names, e.g. public",
        commaSeparated: true,
      },
    ],
    token: { label: "Access token", placeholder: "sbp_…", hint: "A Supabase access token of an account that can open the project. It only runs a read-only schema query." },
  },
  {
    kind: "upload",
    label: "Uploads",
    description: "Documents you upload by hand: exports, transcripts, notes.",
    fields: [],
    token: null,
  },
];

export function connectorDef(kind: ConnectorKind): ConnectorDef {
  return CONNECTORS.find((c) => c.kind === kind) ?? CONNECTORS[CONNECTORS.length - 1];
}

/** Interval options, stored with Postgres' canonical text output so edit forms round-trip. */
export const SYNC_INTERVALS = [
  { value: "00:15:00", label: "Every 15 minutes" },
  { value: "01:00:00", label: "Every hour" },
  { value: "06:00:00", label: "Every 6 hours" },
  { value: "1 day", label: "Every day" },
];

export function intervalLabel(v: string): string {
  return SYNC_INTERVALS.find((i) => i.value === v)?.label ?? `Every ${v}`;
}

/** Form state for a connector config: lists are edited as newline-separated text. */
export type ConfigDraft = Record<string, string>;

function asRecord(v: Json | undefined): Record<string, Json | undefined> {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** The stored value of a field, falling back to its legacy keys (with legacy-value translation). */
function storedValue(kind: ConnectorKind, f: ConfigField, obj: Record<string, Json | undefined>): Json | undefined {
  if (obj[f.key] !== undefined && obj[f.key] !== null) return obj[f.key];
  for (const k of f.legacyKeys ?? []) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  // earlier Studio versions stored web `crawl_depth` (0 = only these pages, >= 1 = follow links)
  if (kind === "web" && f.key === "follow_links" && typeof obj.crawl_depth === "number") return obj.crawl_depth > 0;
  return undefined;
}

export function configToDraft(kind: ConnectorKind, config: Json): ConfigDraft {
  const obj = asRecord(config);
  const draft: ConfigDraft = {};
  for (const f of connectorDef(kind).fields) {
    const v = storedValue(kind, f, obj);
    if (f.kind === "boolean") draft[f.key] = String(typeof v === "boolean" ? v : (f.defaultValue ?? false));
    else draft[f.key] = Array.isArray(v) ? v.map(String).join("\n") : v === undefined || v === null ? "" : String(v);
  }
  return draft;
}

/** Keys earlier Studio versions wrote that connectors never read: dropped when a config is saved. */
const LEGACY_ONLY: Partial<Record<ConnectorKind, string[]>> = { web: ["crawl_depth"] };

/** Validate and convert a draft into config jsonb. Unknown keys in `previous` are preserved. */
export function draftToConfig(
  kind: ConnectorKind,
  draft: ConfigDraft,
  previous: Json = {},
): { config: Record<string, Json>; errors: Record<string, string> } {
  const base: Record<string, Json> = { ...(asRecord(previous) as Record<string, Json>) };
  const errors: Record<string, string> = {};
  for (const f of connectorDef(kind).fields) {
    for (const k of f.legacyKeys ?? []) delete base[k];
    const raw = (draft[f.key] ?? "").trim();
    if (f.kind === "list") {
      const items = raw
        .split(f.commaSeparated ? /[\n,]/ : /\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (f.required && items.length === 0) errors[f.key] = `${f.label} is required`;
      else if (f.pattern && items.some((i) => !f.pattern!.test(i))) errors[f.key] = f.patternMessage ?? "Invalid value";
      base[f.key] = items;
    } else if (f.kind === "boolean") {
      base[f.key] = raw === "true";
    } else if (f.kind === "number") {
      if (raw === "") {
        delete base[f.key];
        continue;
      }
      const n = Number(raw);
      const min = f.min ?? 0;
      const max = f.max ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isInteger(n) || n < min || n > max) errors[f.key] = `${f.label} must be a whole number from ${min} to ${max}`;
      else base[f.key] = n;
    } else {
      if (f.required && !raw) errors[f.key] = `${f.label} is required`;
      else if (raw && f.pattern && !f.pattern.test(raw)) errors[f.key] = f.patternMessage ?? "Invalid value";
      if (raw) base[f.key] = raw;
      else delete base[f.key];
    }
  }
  for (const k of LEGACY_ONLY[kind] ?? []) delete base[k];
  // notion needs at least one of the two lists
  if (kind === "notion" && !(base.database_ids as Json[] | undefined)?.length && !(base.page_ids as Json[] | undefined)?.length) {
    errors.database_ids = "Add at least one database or page ID";
  }
  // web needs URLs and/or a sitemap
  if (kind === "web" && !(base.urls as Json[] | undefined)?.length && !base.sitemap && !errors.urls) {
    errors.urls = "Add at least one URL or a sitemap";
  }
  return { config: base, errors };
}

export function configSummary(kind: ConnectorKind, config: Json): string {
  const obj = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, Json>) : {};
  const count = (k: string) => (Array.isArray(obj[k]) ? (obj[k]).length : 0);
  switch (kind) {
    case "notion":
      return [count("database_ids") && `${count("database_ids")} database(s)`, count("page_ids") && `${count("page_ids")} page(s)`].filter(Boolean).join(", ") || "Not configured";
    case "slack":
      return `${count("channels")} channel(s)`;
    case "github": {
      const ref = typeof obj.ref === "string" ? obj.ref : typeof obj.branch === "string" ? obj.branch : null;
      return typeof obj.repo === "string" ? `${obj.repo}${ref ? `@${ref}` : ""}` : "Not configured";
    }
    case "gdrive":
      return `${count("folder_ids")} folder(s)`;
    case "schema":
      return typeof obj.project_ref === "string" ? `Project ${obj.project_ref}` : "Not configured";
    case "web":
      return [count("urls") && `${count("urls")} URL(s)`, typeof obj.sitemap === "string" && "sitemap"].filter(Boolean).join(" + ") || "Not configured";
    default:
      return "Manual uploads";
  }
}
