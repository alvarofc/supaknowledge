import type { OAuthGrant } from "@supabase/supabase-js";
import { AppWindow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { timeAgo } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";

/** Applications the current user approved on /oauth/consent, with revoke (listGrants / revokeGrant). */
export function ConnectedApps() {
  const toast = useToast();
  const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await createClient().auth.oauth.listGrants();
    if (error) setError(error.message);
    else setGrants(data ?? []);
  }, []);

  useEffect(() => {
    let active = true;
    createClient()
      .auth.oauth.listGrants()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setError(error.message);
        else setGrants(data ?? []);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <Card>
      <CardHeader
        title="Connected applications"
        description="MCP clients you approved to act as you. Revoking signs them out and invalidates their tokens."
      />
      <div className="px-4 py-3">
        {error ? (
          <p className="text-sm text-subtle">Couldn&apos;t load connected applications: {error}</p>
        ) : grants === null ? (
          <p className="text-sm text-subtle">Loading…</p>
        ) : grants.length === 0 ? (
          <p className="text-sm text-subtle">No applications yet. When you approve one on the consent screen it shows up here.</p>
        ) : (
          <ul className="divide-y divide-line">
            {grants.map((g) => (
              <li key={g.client.id} className="flex flex-wrap items-center gap-3 py-2">
                <AppWindow className="size-4 shrink-0 text-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{g.client.name || g.client.id}</div>
                  <div className="text-xs text-subtle">
                    {g.scopes.join(" ") || "no scopes"} · approved {timeAgo(g.granted_at)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline-danger"
                  pending={revoking === g.client.id}
                  onClick={async () => {
                    setRevoking(g.client.id);
                    const { error } = await createClient().auth.oauth.revokeGrant({ clientId: g.client.id });
                    setRevoking(null);
                    if (error) toast.error(error.message);
                    else {
                      toast.success(`Disconnected ${g.client.name || "application"}`);
                      void load();
                    }
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
