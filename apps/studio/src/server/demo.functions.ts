import { createServerFn } from "@tanstack/react-start";
import { demoEnabled } from "@/lib/demo";

/** Whether the sign-in page offers the demo (KF_DEMO, server-only, read at runtime). */
export const loadDemoMode = createServerFn({ method: "GET" }).handler(async () => ({
  enabled: demoEnabled(typeof process !== "undefined" ? process.env.KF_DEMO : undefined),
}));
