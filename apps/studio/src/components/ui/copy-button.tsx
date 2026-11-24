import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";

export function CopyButton({ value, label = "Copy", size = "sm" }: { value: string; label?: string; size?: "sm" | "md" }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size={size}
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // clipboard unavailable (insecure context); the value is visible for manual copy
        }
      }}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A read-only code block with a copy button. */
export function CopyBlock({ value, label, wrap }: { value: string; label?: string; wrap?: boolean }) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface-2">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-3 py-1.5">
        <span className="mono-label text-subtle">{label ?? ""}</span>
        <CopyButton value={value} />
      </div>
      <pre className={`overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-fg ${wrap ? "break-all whitespace-pre-wrap" : ""}`}>{value}</pre>
    </div>
  );
}
