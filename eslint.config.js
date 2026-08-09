import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettier from "eslint-config-prettier";

/**
 * Lint was `tsc --noEmit` alone, which checks types and nothing else. Most of
 * what a review catches here — a hook with the wrong dependencies, a floating
 * promise, an icon button with no accessible name — is a rule, not a type.
 *
 * Type-aware rules are on for src only: they need a program per file, and
 * pointing that at the test suites roughly doubles the run for no finding the
 * suites do not already make by failing.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "frontend/dev-dist/**",
      // Checked by its own tsconfig (worker globals, not DOM ones).
      "frontend/src/sw.ts",
      // Not inside either workspace's tsconfig, so the type-aware rules have no
      // program for them. shared/ is type-checked by both workspaces already.
      "shared/**",
      "eslint.config.js",
      // Shipped into the image and run by node there, not built by either
      // workspace — so no tsconfig project covers it.
      "runtime/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The codebase deliberately swallows errors in places where there is
      // nothing to do about them, and says so in a comment each time.
      "@typescript-eslint/no-empty-function": "off",
      // Fastify handlers legitimately return replies of several shapes.
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      // `void promise` is the codebase's way of saying "deliberately not awaited".
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      // Fire-and-forget async callbacks are the deliberate idiom throughout —
      // event handlers, setInterval bodies, action tables — and every one of
      // them guards its own errors. checksVoidReturn would flag all of them and
      // teach nothing; the rule's non-void checks stay on.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      // Flags an async function that happens not to await yet. Says nothing
      // about correctness, and the signature is often the deliberate contract.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["frontend/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Icon-only controls carry aria-label; the glyph is not the name.
      "jsx-a11y/control-has-associated-label": "off",
      // Real findings, but each needs markup restructuring rather than an
      // attribute: modal backdrops that close on click, and the browser pane's
      // canvas, which relays raw pointer events to a remote page. Warned rather
      // than errored so CI is not blocked on a refactor; tracked in BACKLOG.md.
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-tabindex": "warn",
      // The command palette input is the one place autofocus is correct: the
      // dialog exists to be typed into.
      "jsx-a11y/no-autofocus": "warn",
      // New in eslint-plugin-react-hooks 7, which folds in the React Compiler
      // rules. Both flag deliberate idioms here: the latest-ref pattern (a ref
      // assigned during render so an effect can read a fresh callback without
      // re-subscribing) and effects that seed state on mount. Each site is
      // commented where it stands. Same treatment as the jsx-a11y rules above
      // — real findings, but a refactor rather than an attribute, so they warn
      // instead of blocking CI. Tracked in BACKLOG.md.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // The suites assert on loosely typed fixtures and mock returns.
    files: ["**/test/**"],
    rules: {
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  prettier,
);
