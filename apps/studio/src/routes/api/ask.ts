import { createFileRoute } from "@tanstack/react-router";
import { handleAsk } from "@/server/ask/handler.server";

/** POST: answer one question on the Ask page, streamed as NDJSON (see src/server/ask/handler.server.ts). */
export const Route = createFileRoute("/api/ask")({
  server: {
    handlers: {
      POST: ({ request }) => handleAsk(request),
    },
  },
});
