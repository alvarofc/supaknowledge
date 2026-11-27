import { Flag, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FlagAnswerDialog } from "@/components/ask/flag-answer";
import { Markdown } from "@/components/kf/markdown";
import { conceptHref } from "@/components/knowledge/paths";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, SectionLabel } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Textarea } from "@/components/ui/form";
import { Link } from "@/components/ui/link";
import { ASK_LIMITS, STOPPED, splitNdjson } from "@/lib/ask";
import type { AskMessage, AskToolCall, AskTraceState, ConceptUse, UsedConcept } from "@/lib/ask";

interface Turn {
  id: string;
  question: string;
  answer: string;
  calls: AskToolCall[];
  /** calls sent to MCP whose result has not come back yet */
  running: { id: string; name: string }[];
  concepts: UsedConcept[];
  trace: AskTraceState | null;
  status: "streaming" | "done" | "error";
  error: string | null;
  flagged: boolean;
}

const USE_LABEL: Record<ConceptUse, string> = { read: "Read", loaded: "Loaded", found: "Search result" };

function newId(): string {
  return crypto.randomUUID();
}

/** The conversation sent with each question: every earlier question and the answer it got. */
function history(turns: Turn[], question: string): AskMessage[] {
  const out: AskMessage[] = [];
  for (const t of turns) {
    out.push({ role: "user", content: t.question });
    if (t.answer.trim()) out.push({ role: "assistant", content: t.answer });
  }
  out.push({ role: "user", content: question });
  return out;
}

export function AskConversation({ workspace, space, base, model }: { workspace: string; space: string; base: string; model: string }) {
  const [conversationId, setConversationId] = useState(newId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [flagging, setFlagging] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = turns.at(-1)?.status === "streaming";

  useEffect(() => () => abort.current?.abort(), []);
  const lastAnswerLength = turns.at(-1)?.answer.length ?? 0;
  useEffect(() => {
    if (busy) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [busy, lastAnswerLength, turns.length]);

  const update = (id: string, fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    const id = newId();
    const messages = history(turns, question);
    setTurns((ts) => [
      ...ts,
      { id, question, answer: "", calls: [], running: [], concepts: [], trace: null, status: "streaming", error: null, flagged: false },
    ]);
    setDraft("");
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, space, conversationId, messages }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof j?.error === "string" ? j.error : `The question could not be sent (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const { events, rest } = splitNdjson(done ? `${buffer}\n` : buffer);
        buffer = rest;
        for (const ev of events) {
          if (ev.type === "text") update(id, (t) => ({ ...t, answer: t.answer + ev.delta }));
          else if (ev.type === "tool-call") update(id, (t) => ({ ...t, running: [...t.running, { id: ev.call.id, name: ev.call.name }] }));
          else if (ev.type === "tool-result") {
            update(id, (t) => ({ ...t, calls: [...t.calls, ev.call], running: t.running.filter((r) => r.id !== ev.call.id) }));
          } else if (ev.type === "done") {
            finished = true;
            update(id, (t) => ({ ...t, concepts: ev.concepts, trace: ev.trace, status: "done", running: [] }));
          } else {
            finished = true;
            update(id, (t) => ({ ...t, trace: ev.trace ?? null, status: "error", error: ev.message, running: [] }));
          }
        }
        if (done) break;
      }
      if (!finished) update(id, (t) => ({ ...t, status: "error", error: "The answer stopped before it finished.", running: [] }));
    } catch (err) {
      const message = ctl.signal.aborted ? STOPPED : err instanceof Error ? err.message : String(err);
      update(id, (t) => ({ ...t, status: "error", error: message, running: [] }));
    } finally {
      if (abort.current === ctl) abort.current = null;
    }
  }

  function reset() {
    abort.current?.abort();
    setTurns([]);
    setConversationId(newId());
  }

  const flagTurn = turns.find((t) => t.id === flagging);

  return (
    <div className="flex flex-col gap-6">
      {turns.length ? (
        <ol className="flex flex-col gap-8">
          {turns.map((t) => (
            <li key={t.id} className="flex flex-col gap-3">
              <div className="self-end max-w-[85%] rounded-md border border-line bg-surface-2 px-3.5 py-2.5 text-sm whitespace-pre-wrap text-fg">{t.question}</div>
              <TurnAnswer turn={t} base={base} onFlag={() => setFlagging(t.id)} />
            </li>
          ))}
        </ol>
      ) : null}
      <div ref={bottom} />

      <form onSubmit={ask} className="flex flex-col gap-2">
        <label htmlFor="ask-question" className="sr-only">
          Question
        </label>
        <Textarea
          id="ask-question"
          rows={3}
          maxLength={ASK_LIMITS.questionMax}
          placeholder="Ask about this space's knowledge"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-subtle">
            Model <code className="font-mono">{model}</code>
          </p>
          <div className="flex items-center gap-2">
            {turns.length && !busy ? <Button onClick={reset}>New conversation</Button> : null}
            {busy ? (
              <Button onClick={() => abort.current?.abort()}>
                <Square /> Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!draft.trim()}>
                Ask
              </Button>
            )}
          </div>
        </div>
      </form>

      {flagTurn ? (
        <FlagAnswerDialog
          key={flagTurn.id}
          open
          onClose={() => setFlagging(null)}
          onFlagged={() => {
            update(flagTurn.id, (t) => ({ ...t, flagged: true }));
            setFlagging(null);
          }}
          workspace={workspace}
          space={space}
          question={flagTurn.question}
          answer={flagTurn.answer}
          concepts={flagTurn.concepts}
          traceId={flagTurn.trace?.status === "recorded" ? flagTurn.trace.traceId : null}
        />
      ) : null}
    </div>
  );
}

function TurnAnswer({ turn: t, base, onFlag }: { turn: Turn; base: string; onFlag: () => void }) {
  const streaming = t.status === "streaming";
  return (
    <div className="flex flex-col gap-3">
      {t.answer ? (
        <Markdown size="sm" knowledgeBase={`${base}/knowledge`}>
          {t.answer}
        </Markdown>
      ) : streaming ? (
        <p className="text-sm text-subtle" aria-live="polite">
          {t.running.length ? `Calling ${t.running.at(-1)!.name}` : "Thinking"}
        </p>
      ) : null}

      {t.status === "error" && t.error ? (
        t.error === STOPPED ? (
          <p className="text-xs text-subtle">Stopped.</p>
        ) : (
          <Callout tone="danger" title="The answer failed">
            {t.error}
          </Callout>
        )
      ) : null}

      {t.status === "done" ? <UsedConcepts concepts={t.concepts} base={base} /> : null}

      {t.calls.length ? (
        <details className="group rounded-md border border-line bg-surface">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted select-none hover:text-fg">Tool calls ({t.calls.length})</summary>
          <ol className="divide-y divide-line border-t border-line">
            {t.calls.map((c) => (
              <li key={c.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <code className="font-mono text-xs text-fg">
                    {c.name}({Object.keys(c.input).length ? JSON.stringify(c.input) : ""})
                  </code>
                  {c.isError ? <Badge tone="danger">Error</Badge> : null}
                </div>
                <pre className="max-h-64 overflow-auto rounded border border-line bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
                  {c.output || "(no text)"}
                </pre>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {t.trace?.status === "failed" ? <p className="text-xs text-subtle">Not sent to the curator: {t.trace.message}</p> : null}
      {t.trace?.status === "skipped" ? <p className="text-xs text-subtle">{t.trace.message}</p> : null}

      {!streaming && (t.answer || t.calls.length) ? (
        <div className="flex items-center gap-3">
          {t.flagged ? (
            <p className="text-xs text-subtle">
              Flagged. <Link href={`${base}?tab=flags`} className="text-fg underline underline-offset-2">Open flags</Link>
            </p>
          ) : (
            <Button size="sm" variant="ghost" onClick={onFlag}>
              <Flag /> Flag this answer
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function UsedConcepts({ concepts, base }: { concepts: UsedConcept[]; base: string }) {
  if (!concepts.length) return <p className="text-xs text-subtle">No concepts used.</p>;
  return (
    <div>
      <SectionLabel className="mb-1.5">Concepts used</SectionLabel>
      <ul className="divide-y divide-line rounded-md border border-line bg-surface">
        {concepts.map((c) => (
          <li key={c.path}>
            <Link href={conceptHref(base, c.path)} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2">
              <span className="min-w-0 flex-1 truncate text-fg">{c.title ?? c.path}</span>
              {c.title ? <code className="hidden min-w-0 truncate font-mono text-xs text-subtle sm:block">{c.path}</code> : null}
              <span className={cn("w-24 shrink-0 text-right text-xs", c.use === "found" ? "text-subtle" : "text-muted")}>{USE_LABEL[c.use]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
