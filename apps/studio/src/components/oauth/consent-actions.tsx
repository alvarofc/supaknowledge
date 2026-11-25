import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";

export function ConsentActions({ authorizationId, clientName }: { authorizationId: string; clientName: string }) {
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "approve" | "deny") {
    setPending(action);
    setError(null);
    const fail = (message: string) => {
      setError(message);
      setPending(null);
    };
    try {
      const supabase = createClient();
      const res =
        action === "approve"
          ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
          : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (res.error || !res.data?.redirect_url) {
        fail(res.error?.message ?? "The authorization server did not return a redirect. Start the connection again.");
        return;
      }
      window.location.assign(res.data.redirect_url);
    } catch (err) {
      // a thrown rejection (network, client bug) must not leave both buttons disabled
      fail(err instanceof Error && err.message ? err.message : "Could not reach the authorization server. Try again.");
    }
  }

  return (
    <div className="mt-5">
      {error ? (
        <Callout tone="danger" className="mb-3">
          {error}
        </Callout>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={() => decide("deny")} pending={pending === "deny"} disabled={pending !== null}>
          Deny
        </Button>
        <Button variant="primary" onClick={() => decide("approve")} pending={pending === "approve"} disabled={pending !== null}>
          Allow {clientName.length > 18 ? "access" : clientName}
        </Button>
      </div>
    </div>
  );
}
