import { createFileRoute } from "@tanstack/react-router";
import { PenLine } from "lucide-react";
import { conceptHref } from "@/components/knowledge/paths";
import { SuggestEditor } from "@/components/knowledge/suggest-editor";
import { LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/card";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadSuggest } from "@/server/suggest.functions";

export const Route = createFileRoute("/_authed/w/$workspace/$space/suggest")({
  validateSearch: (search: Record<string, unknown>): { path?: string } => ({
    path: typeof search.path === "string" || typeof search.path === "number" ? String(search.path) : undefined,
  }),
  loaderDeps: ({ search }) => ({ path: search.path }),
  loader: ({ params, deps }) => loadSuggest({ data: { workspace: params.workspace, space: params.space, path: deps.path } }),
  head: () => ({ meta: [title("Suggest an edit")] }),
  component: SuggestPage,
});

function SuggestPage() {
  const ctx = useSpace();
  const { path } = Route.useSearch();
  const { concept } = Route.useLoaderData();

  if (!atLeast(ctx.role, "editor")) {
    return (
      <EmptyState
        framed
        icon={<PenLine />}
        title="Editors suggest changes"
        actions={<LinkButton href={path ? conceptHref(ctx.base, path) : `${ctx.base}/knowledge`}>Back to knowledge</LinkButton>}
      >
        Your role in this space is {ctx.role ?? "none"}. You can still report a problem on any concept — the curator turns flags into proposals. Ask a
        space admin for the editor role to write proposals yourself.
      </EmptyState>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={concept ? <span className="font-mono">{concept.path}</span> : "Knowledge"}
        title={concept ? `Suggest an edit to “${concept.title}”` : "New concept"}
        description={
          concept
            ? "Change what you know is wrong or missing. Your edit is submitted as a proposal and applied when a reviewer approves it."
            : "Write down knowledge your agents need. It is submitted as a proposal and published when a reviewer approves it."
        }
      />
      <SuggestEditor
        key={concept?.id ?? "new"}
        concept={concept}
        spaceId={ctx.space.id}
        base={ctx.base}
        groups={ctx.groups}
        myGroupIds={ctx.myGroupIds}
      />
    </div>
  );
}
