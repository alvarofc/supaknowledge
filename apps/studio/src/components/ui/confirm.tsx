import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

type ConfirmOptions = { title: ReactNode; description?: ReactNode; confirmLabel?: string; danger?: boolean };

/**
 * An accessible replacement for window.confirm(): `const [confirm, dialog] = useConfirm()`, render `{dialog}` once,
 * then `if (!(await confirm({ title: "Delete?" }))) return;`.
 */
export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  // a pending confirm() resolves false when the owner unmounts (navigation, list re-render) instead of hanging
  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    [],
  );

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  };

  const dialog = (
    <Dialog
      open={opts !== null}
      onClose={() => settle(false)}
      size="sm"
      title={opts?.title ?? ""}
      description={opts?.description}
      footer={
        <>
          <Button onClick={() => settle(false)}>Cancel</Button>
          <Button variant={opts?.danger === false ? "primary" : "danger"} onClick={() => settle(true)}>
            {opts?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    />
  );
  return [confirm, dialog];
}
