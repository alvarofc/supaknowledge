import { useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Compass, TriangleAlert } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState framed className="w-full max-w-xl" icon={<Compass />} title="Nothing here — or nothing you can see" actions={<LinkButton href="/">Go to Studio</LinkButton>}>
        This page does not exist, or access rules hide it from you. Restricted knowledge is only visible to members of its audience
        groups; ask a workspace admin if you think you should have access.
      </EmptyState>
    </div>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <EmptyState
      framed
      icon={<TriangleAlert />}
      title="This page failed to load"
      actions={
        <Button
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </Button>
      }
    >
      {(error instanceof Error ? error.message : "") || "An unexpected error occurred."}
    </EmptyState>
  );
}

export function PageSkeleton() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="mb-2 h-7 w-48 rounded-md bg-surface-2" />
      <div className="mb-8 h-4 w-80 max-w-full rounded-md bg-surface-2" />
      <div className="space-y-3">
        <div className="h-20 rounded-md border border-line bg-surface" />
        <div className="h-20 rounded-md border border-line bg-surface" />
        <div className="h-20 rounded-md border border-line bg-surface" />
      </div>
    </div>
  );
}
