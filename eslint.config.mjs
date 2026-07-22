// Monorepo ESLint baseline (FEN-651 / A8, criterion C6).
//
// High-signal, type-unaware flat config: typescript-eslint's `recommended` (no
// type-checking pass, so it is fast and needs no per-package parserOptions). `tsc`
// already owns type correctness across the workspace; ESLint here owns the lint
// hygiene tsc does not (unused vars, unsafe patterns, dead code). The gate is
// **0 problems** (`--max-warnings 0` in the `lint` scripts).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // Generated / built / vendored output is never linted.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/_generated/**",
      "**/*.d.ts",
      "**/convex/_generated/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `no-undef` is redundant (and wrong) for TypeScript: `tsc` already rejects
      // real undefined references, and ESLint here has no env-globals table, so it
      // false-positives on `console`/`process`/`fetch`/`WebSocket`. typescript-eslint
      // recommends turning it off. tsc remains the source of truth for undefineds.
      "no-undef": "off",
      // Allow intentionally-unused args/vars prefixed with `_` (positional Lua/Convex
      // handler args, catch bindings) and ignored rest siblings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // React Rules of Hooks for the web + i18n React surfaces (the rule the inline
    // `eslint-disable react-hooks/exhaustive-deps` directives already reference).
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Tests + load harnesses: empty mocks and throwaway scaffolding are fine.
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**", "**/load/**"],
    rules: {
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
