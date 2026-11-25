// @ts-check
import { tanstackConfig } from "@tanstack/eslint-config";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  ...tanstackConfig,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      "import/no-cycle": "off",
      "import/order": "off",
      "sort-imports": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/require-await": "off",
      "pnpm/json-enforce-catalog": "off",
      // Supabase rows and Record lookups are typed non-null without noUncheckedIndexedAccess; the runtime
      // fallbacks are intentional
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/naming-convention": "off",
      "no-shadow": "off",
    },
  },
  {
    ignores: ["eslint.config.js", "src/routeTree.gen.ts", "src/lib/database.types.ts", ".output/**", ".nitro/**", ".tanstack/**", "dist/**"],
  },
];
