import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "coverage/**"] },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Unused function arguments are often required for shape (Express handlers),
      // so allow a leading underscore to mark them deliberate.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // A forgotten await on a database or crypto call is the bug class most
      // likely to bite this codebase.
      "no-console": "off",
      "no-return-await": "error",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
    },
  },

  // Tests use the node:test globals via imports, so nothing extra is needed;
  // this block only relaxes rules that fight assertions.
  {
    files: ["tests/**/*.js"],
    rules: { "no-unused-expressions": "off" },
  },

  // Must stay last: switches off every rule Prettier already governs.
  prettier,
];
