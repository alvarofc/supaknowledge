import { Link } from "@/components/ui/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/components/ui/cn";

/**
 * Resolve a markdown link inside a concept to a Studio URL. OKF concepts link to each other with relative
 * paths ("../metrics/arr.md", "arr", "/metrics/arr"); external URLs are returned unchanged (null).
 */
export function resolveConceptHref(href: string, fromPath: string | undefined, knowledgeBase: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return null;
  const [rawPath, hash] = href.split("#", 2) as [string, string | undefined];
  if (!rawPath) return null;
  const dir = fromPath ? fromPath.split("/").slice(0, -1) : [];
  const parts = rawPath.startsWith("/") ? [] : [...dir];
  for (const seg of rawPath.replace(/^\//, "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const path = parts.join("/").replace(/\.md$/, "").replace(/\/(SKILL|index)$/i, "");
  if (!path) return null;
  return `${knowledgeBase}/${path.split("/").map(encodeURIComponent).join("/")}${hash ? `#${hash}` : ""}`;
}

export function Markdown({
  children,
  className,
  conceptPath,
  knowledgeBase,
  size,
}: {
  children: string;
  className?: string;
  /** path of the concept being rendered, for resolving relative links */
  conceptPath?: string;
  /** /w/<ws>/<space>/knowledge — enables concept link rewriting */
  knowledgeBase?: string;
  size?: "sm";
}) {
  return (
    <div className={cn("md", size === "sm" && "md-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children: kids, node: _node, ...rest }) {
            void _node;
            if (!href) return <a {...rest}>{kids}</a>;
            const internal = knowledgeBase ? resolveConceptHref(href, conceptPath, knowledgeBase) : null;
            if (internal) return <Link href={internal}>{kids}</Link>;
            const external = /^https?:/i.test(href);
            return (
              <a href={href} {...rest} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                {kids}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
