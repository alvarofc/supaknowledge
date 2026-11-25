import { FileUp, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { callFunction, FunctionError } from "@/lib/functions";
import { useMutation } from "@/lib/use-mutation";

const MAX_BYTES = 2 * 1024 * 1024;

/** Paste or pick a text/markdown file; the `connectors` function stores it and enqueues embedding. */
export function UploadForm({ sourceId }: { sourceId: string }) {
  const { run, pending } = useMutation();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function readFile(file: File) {
    setFileError(null);
    if (file.size > MAX_BYTES) {
      setFileError("Files over 2 MB are not supported here. Split the document or use a connector.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setContent(String(reader.result ?? ""));
      if (!title) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ""));
    };
    reader.onerror = () => setFileError("Could not read that file.");
    reader.readAsText(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setUnavailable(null);
    const res = await run(
      async () => {
        try {
          return await callFunction("connectors/upload", { body: { source_id: sourceId, title: title.trim(), content } });
        } catch (err) {
          if (err instanceof FunctionError && (err.status === 501 || err.status === 404 || err.status === 0)) setUnavailable(err.message);
          throw err;
        }
      },
      { success: "Document uploaded. It will be chunked and embedded shortly." },
    );
    // the fields are disabled while the upload runs, so clearing them never drops later edits
    if (res.ok) {
      setTitle("");
      setContent("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {unavailable ? (
        <Callout tone="warn" title="Uploads aren't available yet">
          {unavailable} Deploy the <code>connectors</code> Edge Function (or run <code>npm run functions:serve</code> locally) and try again.
        </Callout>
      ) : null}
      <Field label="Title" htmlFor="upload-title">
        <Input id="upload-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Q3 pricing review notes" required disabled={pending} />
      </Field>
      <Field label="Content" htmlFor="upload-content" hint="Markdown or plain text. Pick a .md/.txt file or paste below." error={fileError}>
        <div className="flex flex-col gap-2">
          <label
            aria-disabled={pending || undefined}
            className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-line-strong px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg aria-disabled:pointer-events-none aria-disabled:opacity-60"
          >
            <FileUp className="size-4" /> Choose file
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,.txt,text/plain,text/markdown"
              className="sr-only"
              disabled={pending}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
              }}
            />
          </label>
          <Textarea id="upload-content" rows={10} className="font-mono text-xs" value={content} onChange={(e) => setContent(e.target.value)} placeholder={"# Pricing review\n\nWe agreed to…"} required disabled={pending} />
        </div>
      </Field>
      <div>
        <Button type="submit" variant="primary" pending={pending} disabled={!title.trim() || !content.trim()}>
          <Upload className="size-4" /> Upload document
        </Button>
      </div>
    </form>
  );
}
