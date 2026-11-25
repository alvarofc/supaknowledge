import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
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
});
