import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { demoErrorMessage, demoLanding, parseDemoJoin } from "@/lib/demo";
import { createClient } from "@/lib/supabase/client";

/**
 * Public demo sign-in: an anonymous Supabase Auth session that joins the demo space as a reader (join_demo()).
 * What the visitor may do is decided by the database, not by this button.
 */
export function DemoSignIn({ next }: { next: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    try {
      const { error: signInError } = await supabase.auth.signInAnonymously();
      if (signInError) throw signInError;
      const { data, error: joinError } = await supabase.rpc("join_demo", {});
      if (joinError) {
        // do not leave an anonymous session that belongs to no space
        await supabase.auth.signOut();
        throw joinError;
      }
      const join = parseDemoJoin(data);
      if (!join) throw new Error("The demo space could not be opened.");
      // route guards read the new session on this navigation
      void router.navigate({ href: demoLanding(join, next), replace: true });
    } catch (err) {
      setError(demoErrorMessage((err as { message?: string }).message ?? ""));
      setPending(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-line pt-6">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <Button type="button" variant="secondary" size="lg" className="w-full" pending={pending} onClick={() => void start()}>
        Try the demo
      </Button>
      <p className="text-center text-xs text-subtle">A shared read-only space. Flags you raise are cleared every night.</p>
    </div>
  );
}
