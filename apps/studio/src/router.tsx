import { createRouter } from "@tanstack/react-router";
import { NotFound, PageSkeleton, RouteError } from "@/components/shell/route-states";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // hovering or focusing a link starts loading the next page (like Next's prefetch)
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
    defaultPendingComponent: PageSkeleton,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
