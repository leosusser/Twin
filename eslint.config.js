import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptFiles = ["src/**/*.ts", "test/**/*.ts"];

export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "data/**",
      "docs/screenshots/**",
      "docs/references/**",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["eslint.config.js", "public/app.js"],
  },
  {
    ...js.configs.recommended,
    files: typescriptFiles,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["public/app.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: globals.browser,
    },
    // The current browser bundle intentionally replaces initial render helpers
    // later in the file. Keep semantic linting while that legacy structure is
    // split into modules in a future UI-focused change.
    rules: {
      "no-empty": "off",
      "no-func-assign": "off",
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
    },
  },
  eslintConfigPrettier,
]);
