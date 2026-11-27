import { createFileRoute } from "@tanstack/react-router";
import { AskConversation } from "@/components/ask/conversation";
import { Callout, Code, PageHeader } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadAsk } from "@/server/ask.functions";

export const Route = createFileRoute("/_authed/w/$workspace/$space/ask")({
  loader: ({ params }) => loadAsk({ data: { workspace: params.workspace, space: params.space } }),
  head: () => ({ meta: [title("Ask")] }),
  component: AskPage,
});

function AskPage() {
  const ctx = useSpace();
  const { model, modelProblem, recordTraces, demoVisitor } = Route.useLoaderData();
  const isAdmin = atLeast(ctx.role, "admin");

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Ask" description="An agent answers with the same MCP tools your agents use, and sees only what you can see." />

      {demoVisitor ? (
        <Callout tone="info" title="Ask is not available in the demo">
          <p>
            Connect your own agent with the MCP command on the <Link href={ctx.base} className="underline underline-offset-2 hover:text-fg">inbox</Link>, or run
            Supaknowledge locally to try Ask with your model.
          </p>
        </Callout>
      ) : model ? (
        <>
          <p className="mb-6 text-xs text-subtle">
            {recordTraces ? (
              "Conversations are sent to the curator as traces."
            ) : (
              <>
                This space does not send Ask conversations to the curator
                {isAdmin ? (
                  <>
                    {" "}
                    (<Link href={`${ctx.base}/settings?tab=curator`} className="underline underline-offset-2 hover:text-fg">curator settings</Link>)
                  </>
                ) : null}
                .
              </>
            )}
          </p>
          <AskConversation workspace={ctx.workspace.slug} space={ctx.space.slug} base={ctx.base} model={model} />
        </>
      ) : (
        <Callout tone="warn" title={modelProblem?.reason === "invalid" ? "The Ask model configuration is invalid" : "No model is configured for Ask"}>
          {modelProblem?.reason === "invalid" ? <p>{modelProblem.message}</p> : null}
          <p className={modelProblem?.reason === "invalid" ? "mt-2" : undefined}>
            Set <Code>KF_LLM_MODEL</Code> in the Studio server's environment, with the endpoint or gateway key it needs (<Code>KF_LLM_BASE_URL</Code> and{" "}
            <Code>KF_LLM_API_KEY</Code>, <Code>AI_GATEWAY_API_KEY</Code> or <Code>OPENROUTER_API_KEY</Code>), then restart Studio. These are the same variables
            the curator reads; see <Code>docs/studio.md</Code>.
          </p>
        </Callout>
      )}
    </div>
  );
}
