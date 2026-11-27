import { BookText, Database as DatabaseIcon, FileUp, FolderGit2, FolderOpen, Globe, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { Database } from "@/lib/database.types";
import type { ConnectorKind } from "./connector-config";

export {
  CONNECTORS,
  SYNC_INTERVALS,
  configSummary,
  configToDraft,
  connectorDef,
  draftToConfig,
  intervalLabel,
} from "./connector-config";
export type { ConfigDraft, ConfigField, ConnectorDef, ConnectorKind } from "./connector-config";

export type SourceStatus = Database["public"]["Enums"]["source_status"];

/** Documents per page on a source page. */
export const SOURCE_PAGE_SIZE = 50;

/** Columns `authenticated` may select on sources (secret_id and sync_requested_at are not granted). */
export const SOURCE_COLUMNS =
  "id, space_id, connector, name, config, audience, sync_interval, status, cursor, last_synced_at, last_error, created_by, created_at";

export function ConnectorIcon({ kind, className = "size-4" }: { kind: ConnectorKind; className?: string }) {
  const icons: Record<ConnectorKind, ReactNode> = {
    notion: <BookText className={className} aria-hidden="true" />,
    slack: <MessageSquare className={className} aria-hidden="true" />,
    github: <FolderGit2 className={className} aria-hidden="true" />,
    gdrive: <FolderOpen className={className} aria-hidden="true" />,
    web: <Globe className={className} aria-hidden="true" />,
    upload: <FileUp className={className} aria-hidden="true" />,
    schema: <DatabaseIcon className={className} aria-hidden="true" />,
  };
  return <>{icons[kind]}</>;
}

