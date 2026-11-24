import { Bot, MessageSquareWarning, Settings2, TriangleAlert, User, Wrench } from "lucide-react";
import { Markdown } from "@/components/kf/markdown";
import { cn } from "@/components/ui/cn";
import type { Database } from "@/lib/database.types";
import { JsonDetails } from "./json-view";

export type TraceEventRow = Pick<
  Database["public"]["Tables"]["trace_events"]["Row"],
  "id" | "seq" | "role" | "content" | "tool_name" | "tool_input" | "tool_output" | "is_error" | "at"
>;

const ROLE_META = {
  system: { label: "System prompt", Icon: Settings2, box: "border-line bg-surface-2/60", icon: "text-subtle" },
  user: { label: "User", Icon: User, box: "border-line bg-surface", icon: "text-info" },
  assistant: { label: "Agent", Icon: Bot, box: "border-line bg-surface", icon: "text-accent" },
  tool: { label: "Tool", Icon: Wrench, box: "border-line bg-surface-2/40", icon: "text-violet" },
  feedback: { label: "Human correction", Icon: MessageSquareWarning, box: "border-warn/50 bg-warn-soft", icon: "text-warn" },
} as const;

/** A trace rendered as a chat transcript. Corrections and tool errors are what the curator learns from. */
export function Transcript({ events, knowledgeBase }: { events: TraceEventRow[]; knowledgeBase: string }) {
  return (
    <ol className="flex flex-col gap-3">
      {events.map((e) => {
        const meta = ROLE_META[e.role];
        const error = e.is_error;
        const long = e.role === "system" && (e.content?.length ?? 0) > 400;
        return (
          <li key={e.id} className={cn("rounded-md border px-4 py-3", error ? "border-danger/50 bg-danger-soft/60" : meta.box)}>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
              <meta.Icon className={cn("size-3.5", error ? "text-danger" : meta.icon)} aria-hidden="true" />
              <span className="font-medium text-fg">{meta.label}</span>
              {e.tool_name ? <span className="font-mono text-muted">{e.tool_name}</span> : null}
              {error ? (
                <span className="inline-flex items-center gap-1 font-medium text-danger">
                  <TriangleAlert className="size-3.5" /> error
                </span>
              ) : null}
              <span className="ml-auto text-subtle tabular-nums">
                #{e.seq} · {new Date(e.at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            </div>
            {e.content ? (
              long ? (
                <details>
                  <summary className="cursor-pointer text-xs text-muted select-none hover:text-fg">Show system prompt ({e.content.length} chars)</summary>
                  <pre className="mt-2 max-h-96 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">{e.content}</pre>
                </details>
              ) : e.role === "assistant" || e.role === "feedback" || e.role === "user" ? (
                <Markdown size="sm" knowledgeBase={knowledgeBase}>
                  {e.content}
                </Markdown>
              ) : (
                <pre className="font-mono text-xs whitespace-pre-wrap text-muted">{e.content}</pre>
              )
            ) : null}
            {e.tool_input != null || e.tool_output != null ? (
              <div className="mt-2 flex flex-col gap-1.5">
                <JsonDetails label="Input" value={e.tool_input} />
                <JsonDetails label="Output" value={e.tool_output} open={error} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
