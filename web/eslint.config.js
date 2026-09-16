import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-refresh": reactRefresh },
    rules: {
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // Build-time scripts run in Node, not the browser: Buffer and console are
  // theirs, and none of the React rules apply.
  {
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: { globals: globals.node },
  },
  // The service worker is neither a browser page nor Node: `self` is its global
  // and `window` does not exist in it. globals.serviceworker is exactly that
  // environment, and it is the only file in public/ with any code in it.
  {
    files: ["public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  // The Playwright suite is Node too, and exports no components.
  {
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: { globals: globals.node },
    rules: { "react-refresh/only-export-components": "off" },
  },
  // Stays last, as in server/eslint.config.js.
  prettier,
);
