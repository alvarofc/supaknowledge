import { useRouter } from "@tanstack/react-router";
import { useCallback, useState, useTransition } from "react";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";

type Result<T> = { data?: T | null; error?: unknown } | T;

/**
 * Run a mutation (an RPC, insert or function call), toast the outcome and refresh server data.
 * `fn` may return a supabase-js `{ data, error }` result or a plain value (thrown errors are handled).
 */
export function useMutation() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [refreshing, startTransition] = useTransition();

  const run = useCallback(
    async <T,>(
      fn: () => PromiseLike<Result<T>>,
      opts: { success?: string; refresh?: boolean; onSuccess?: (data: T | null | undefined) => void } = {},
    ): Promise<{ ok: boolean; data?: T | null }> => {
      setBusy(true);
      try {
        const res = await fn();
        if (res && typeof res === "object" && "error" in res && (res as { error?: unknown }).error) {
          toast.error(errorMessage((res as { error: unknown }).error));
          return { ok: false };
        }
        const data = res && typeof res === "object" && "data" in res ? (res as { data?: T | null }).data : (res as T);
        if (opts.success) toast.success(opts.success);
        opts.onSuccess?.(data);
        if (opts.refresh !== false) startTransition(() => router.invalidate());
        return { ok: true, data };
      } catch (e) {
        toast.error(errorMessage(e));
        return { ok: false };
      } finally {
        setBusy(false);
      }
    },
    [router, toast],
  );

  return { run, pending: busy || refreshing };
}
