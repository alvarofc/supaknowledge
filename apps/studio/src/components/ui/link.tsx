import { Link as RouterLink } from "@tanstack/react-router";
import type { LinkComponentProps } from "@tanstack/react-router";
import type { ComponentProps } from "react";

type Props = Omit<ComponentProps<"a">, "href"> & {
  href: string;
  /** replace the current history entry instead of pushing */
  replace?: boolean;
  /** scroll to the top after navigating (default true) */
  scroll?: boolean;
};

/**
 * App link taking a plain href ("/w/acme/main/knowledge?kind=skill"). Internal hrefs are client-side router
 * navigations (with intent preloading); absolute URLs render a normal <a>.
 */
export function Link({ href, replace, scroll, ...props }: Props) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) {
    return <a href={href} {...props} />;
  }
  // the router parses `href` into path, search and hash (buildLocation); the typed API only knows `to`
  const linkProps = { ...props, href, replace, resetScroll: scroll } as unknown as LinkComponentProps;
  return <RouterLink {...linkProps} />;
}
