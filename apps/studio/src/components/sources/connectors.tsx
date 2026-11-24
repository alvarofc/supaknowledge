import { BookText, FileUp, FolderGit2, FolderOpen, Globe, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { Database, Json } from "@/lib/database.types";

export type ConnectorKind = Database["public"]["Enums"]["connector_kind"];
export type SourceStatus = Database["public"]["Enums"]["source_status"];

/** Columns `authenticated` may select on sources (secret_id and sync_requested_at are not granted). */
/** Documents per page on a source page. */
export const SOURCE_PAGE_SIZE = 50;

export const SOURCE_COLUMNS =
  "id, space_id, connector, name, config, audience, sync_interval, status, cursor, last_synced_at, last_error, created_by, created_at";

export type ConfigField = {
  key: string;
  label: string;
  kind: "list" | "text" | "number";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  pattern?: RegExp;
  patternMessage?: string;
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
      { key: "database_ids", label: "Database IDs", kind: "list", placeholder: "a1b2c3d4e5f6…", hint: "One per line. Every page in these databases is synced." },
      { key: "page_ids", label: "Page IDs", kind: "list", placeholder: "f6e5d4c3b2a1…", hint: "One per line. The page and its children are synced." },
    ],
    token: { label: "Integration token", placeholder: "ntn_…", hint: "An internal integration secret. Share the pages/databases with the integration in Notion." },
  },
  {
    kind: "slack",
    label: "Slack",
    description: "Messages and threads from selected channels.",
    fields: [
      { key: "channels", label: "Channels", kind: "list", placeholder: "C0123456789", hint: "Channel IDs, one per line. Private channels need the bot invited.", required: true },
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
      { key: "branch", label: "Branch", kind: "text", placeholder: "main", hint: "Defaults to the repository's default branch." },
      { key: "paths", label: "Paths", kind: "list", placeholder: "docs/\nREADME.md", hint: "Files or folders to include, one per line. Empty = whole repository." },
    ],
    token: { label: "Access token", placeholder: "github_pat_…", hint: "A fine-grained token with read access to contents.", optional: true },
  },
  {
    kind: "gdrive",
    label: "Google Drive",
    description: "Docs, Sheets and files in shared folders.",
    fields: [{ key: "folder_ids", label: "Folder IDs", kind: "list", placeholder: "1AbCdEfGh…", hint: "One per line. Share each folder with the service account.", required: true }],
    token: { label: "Service account key (JSON)", placeholder: '{ "type": "service_account", … }', hint: "Paste the full JSON key file.", multiline: true },
  },
  {
    kind: "web",
    label: "Web pages",
    description: "Public pages such as docs sites, changelogs and status pages.",
    fields: [
      { key: "urls", label: "URLs", kind: "list", placeholder: "https://docs.example.com/", hint: "One per line.", required: true, pattern: /^https?:\/\//, patternMessage: "Each URL must start with http:// or https://" },
      { key: "crawl_depth", label: "Crawl depth", kind: "number", placeholder: "0", hint: "0 = only these pages; 1 = also pages they link to (same site)." },
    ],
    token: null,
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

export function ConnectorIcon({ kind, className = "size-4" }: { kind: ConnectorKind; className?: string }) {
  const icons: Record<ConnectorKind, ReactNode> = {
    notion: <BookText className={className} aria-hidden="true" />,
    slack: <MessageSquare className={className} aria-hidden="true" />,
    github: <FolderGit2 className={className} aria-hidden="true" />,
    gdrive: <FolderOpen className={className} aria-hidden="true" />,
    web: <Globe className={className} aria-hidden="true" />,
    upload: <FileUp className={className} aria-hidden="true" />,
  };
  return <>{icons[kind]}</>;
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

export function configToDraft(kind: ConnectorKind, config: Json): ConfigDraft {
  const obj = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, Json | undefined>) : {};
  const draft: ConfigDraft = {};
  for (const f of connectorDef(kind).fields) {
    const v = obj[f.key];
    draft[f.key] = Array.isArray(v) ? v.map(String).join("\n") : v === undefined || v === null ? "" : String(v);
  }
  return draft;
}

/** Validate and convert a draft into config jsonb. Unknown keys in `previous` are preserved. */
export function draftToConfig(
  kind: ConnectorKind,
  draft: ConfigDraft,
  previous: Json = {},
): { config: Record<string, Json>; errors: Record<string, string> } {
  const base = previous && typeof previous === "object" && !Array.isArray(previous) ? { ...(previous as Record<string, Json>) } : {};
  const errors: Record<string, string> = {};
  for (const f of connectorDef(kind).fields) {
    const raw = (draft[f.key] ?? "").trim();
    if (f.kind === "list") {
      const items = raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (f.required && items.length === 0) errors[f.key] = `${f.label} is required`;
      else if (f.pattern && items.some((i) => !f.pattern!.test(i))) errors[f.key] = f.patternMessage ?? "Invalid value";
      base[f.key] = items;
    } else if (f.kind === "number") {
      if (raw === "") {
        delete base[f.key];
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 5) errors[f.key] = `${f.label} must be a whole number from 0 to 5`;
      else base[f.key] = n;
    } else {
      if (f.required && !raw) errors[f.key] = `${f.label} is required`;
      else if (raw && f.pattern && !f.pattern.test(raw)) errors[f.key] = f.patternMessage ?? "Invalid value";
      if (raw) base[f.key] = raw;
      else delete base[f.key];
    }
  }
  // notion needs at least one of the two lists
  if (kind === "notion" && !(base.database_ids as Json[] | undefined)?.length && !(base.page_ids as Json[] | undefined)?.length) {
    errors.database_ids = "Add at least one database or page ID";
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
    case "github":
      return typeof obj.repo === "string" ? `${obj.repo}${typeof obj.branch === "string" ? `@${obj.branch}` : ""}` : "Not configured";
    case "gdrive":
      return `${count("folder_ids")} folder(s)`;
    case "web":
      return `${count("urls")} URL(s)`;
    default:
      return "Manual uploads";
  }
}
