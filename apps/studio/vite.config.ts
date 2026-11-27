import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

/** Server-only variables the Ask page reads at runtime (model and rate limit). They never reach the browser. */
const SERVER_ENV_PREFIXES = ["KF_LLM_", "KF_ASK_", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"];

export default defineConfig(({ mode }) => {
  // `vite dev` and `vite preview` also take them from apps/studio/.env.local (the shell environment wins).
  // A production server (node .output/server/index.mjs) reads only its real environment.
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), SERVER_ENV_PREFIXES))) process.env[k] ??= v;
  return {
    resolve: { tsconfigPaths: true },
    server: {
      // Supabase Auth's local site_url is http://127.0.0.1:3000: OAuth consent and email links land there.
      host: "127.0.0.1",
      port: 3000,
      strictPort: true,
    },
    plugins: [
      tailwindcss(),
      tanstackStart(),
      // Nitro builds a portable server (.output/): Node by default; Vercel, Netlify and others are detected
      // from the build environment or chosen with NITRO_PRESET.
      nitro(),
      viteReact(),
    ],
  };
});
