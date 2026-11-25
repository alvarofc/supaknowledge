import { gdrive } from "./gdrive.ts";
import { github } from "./github.ts";
import { notion } from "./notion.ts";
import { slack } from "./slack.ts";
import type { Connector, ConnectorKind } from "./types.ts";
import { upload } from "./upload.ts";
import { web } from "./web.ts";

export const connectors: Record<ConnectorKind, Connector<unknown>> = {
  notion: notion as Connector<unknown>,
  slack: slack as Connector<unknown>,
  github: github as Connector<unknown>,
  gdrive: gdrive as Connector<unknown>,
  web: web as Connector<unknown>,
  upload: upload as Connector<unknown>,
};
