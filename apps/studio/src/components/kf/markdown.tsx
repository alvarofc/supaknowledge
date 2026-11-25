import { Link } from "@/components/ui/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/components/ui/cn";
import { conceptFile, resolveConceptHref } from "@/lib/concept-links";

export function Markdown({
  children,
  className,
  conceptPath,
  conceptKind,
  knowledgeBase,
  size,
}: {
  children: string;
  className?: string;
  /** path of the concept being rendered, for resolving relative links */
  conceptPath?: string;
  /** its kind: a skill's body is skills/<name>/SKILL.md, so its relative links start from skills/<name>/ */
  conceptKind?: string;
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
            const internal = knowledgeBase ? resolveConceptHref(href, conceptPath ? conceptFile(conceptPath, conceptKind) : undefined, knowledgeBase) : null;
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
