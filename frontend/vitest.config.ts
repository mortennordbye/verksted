import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: that one pulls in the PWA plugin,
// which wants to build a service worker and has no business running in tests.
export default defineConfig({
  // Same reason vite.config.ts allows it for the dev server: the file icons are
  // globbed out of node_modules at the workspace root, one level above this
  // root, and without it every component that draws one fails to transform.
  server: { fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    restoreMocks: true,
  },
});
