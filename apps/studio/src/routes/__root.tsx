import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { getCurrentUser } from "@/lib/session";
import { ThemeProvider, themeScript } from "@/lib/theme";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  // pages carry per-user data: never let a CDN or proxy cache them
  headers: () => ({ "Cache-Control": "private, no-store" }),
  beforeLoad: async () => ({ user: await getCurrentUser() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Supaknowledge Studio" },
      { name: "description", content: "Review, browse and curate your knowledge factory." },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
    ],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* applies the stored light/dark theme before the first paint */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {/* two theme-color tags: head() would dedupe them by name */}
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fcfcfc" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#171717" />
        <HeadContent />
      </head>
      <body className="min-h-dvh">
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
