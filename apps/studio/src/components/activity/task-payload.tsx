import { useState } from "react";
import { JsonDetails } from "@/components/activity/json-view";
import { errorMessage } from "@/lib/format";
import { loadTaskPayload } from "@/server/activity.functions";

type Payload = Awaited<ReturnType<typeof loadTaskPayload>>;

/** A curator task's input/output, fetched only when opened (payloads can be large). */
export function TaskPayload({ workspace, space, taskId }: { workspace: string; space: string; taskId: string }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "done"; payload: Payload } | { kind: "error"; message: string }>({
    kind: "idle",
  });

  async function load() {
    setState({ kind: "loading" });
    try {
      setState({ kind: "done", payload: await loadTaskPayload({ data: { workspace, space, taskId } }) });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  }

  return (
    <details
      className="mt-1"
      onToggle={(e) => {
        if (e.currentTarget.open && (state.kind === "idle" || state.kind === "error")) void load();
      }}
    >
      <summary className="cursor-pointer text-xs text-muted select-none hover:text-fg">Input and output</summary>
      <div className="mt-1 flex flex-col gap-1">
        {state.kind === "loading" ? <p className="text-xs text-subtle">Loading…</p> : null}
        {state.kind === "error" ? <p className="text-xs text-danger">{state.message}</p> : null}
        {state.kind === "done" ? (
          <>
            <JsonDetails label="Input" value={state.payload.input} />
            <JsonDetails label="Output" value={state.payload.output} />
          </>
        ) : null}
      </div>
    </details>
  );
}
