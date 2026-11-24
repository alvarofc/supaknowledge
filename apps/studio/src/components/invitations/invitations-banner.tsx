import { MailOpen } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { invitationErrorMessage } from "@/lib/invitations";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";
import type { MyInvitation } from "@/server/invitations.functions";

/**
 * "You've been invited": open workspace invitations addressed to the signed-in account's verified e-mail
 * (public.list_my_invitations). Accepting joins the workspace and opens it; declining just closes the invitation.
 */
export function InvitationsBanner({ invitations, className }: { invitations: MyInvitation[]; className?: string }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  if (!invitations.length) return null;
  const supabase = createClient();

  return (
    <Callout
      tone="info"
      icon={<MailOpen />}
      className={className}
      title={invitations.length === 1 ? "You've been invited to a workspace" : `You've been invited to ${invitations.length} workspaces`}
    >
      <p className="mt-0.5 text-xs text-muted">Invitations are matched to the verified e-mail address of the account you are signed in with.</p>
      <ul className="mt-2 flex flex-col gap-2">
        {invitations.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-medium text-fg">{i.workspace_name}</span>
              <span className="text-muted">
                {" "}
                as {i.role}
                {i.invited_by_name ? `, invited by ${i.invited_by_name}` : ""}
              </span>
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={async () => {
                const res = await run(
                  async () => {
                    const { data, error } = await supabase.rpc("accept_invitation", { p_id: i.id });
                    if (error) throw new Error(invitationErrorMessage(error));
                    return data;
                  },
                  { success: `You joined ${i.workspace_name}`, refresh: false },
                );
                if (res.ok) {
                  // navigation and memberships changed: reload everything, then open the workspace
                  await router.invalidate();
                  await router.navigate({ href: `/?workspace=${encodeURIComponent(res.data?.slug ?? i.workspace_slug)}` });
                }
              }}
            >
              Accept
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  async () => {
                    const { error } = await supabase.rpc("decline_invitation", { p_id: i.id });
                    if (error) throw new Error(invitationErrorMessage(error));
                    return null;
                  },
                  { success: "Invitation declined" },
                )
              }
            >
              Decline
            </Button>
          </li>
        ))}
      </ul>
    </Callout>
  );
}
