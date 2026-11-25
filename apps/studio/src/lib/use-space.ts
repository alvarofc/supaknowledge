import { getRouteApi } from "@tanstack/react-router";

const spaceRoute = getRouteApi("/_authed/w/$workspace/$space");

/** The current space context (workspace, space, role, groups, base path) loaded by the space layout. */
export function useSpace() {
  return spaceRoute.useLoaderData().ctx;
}
