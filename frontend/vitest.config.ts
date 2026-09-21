import path from "node:path";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: that one pulls in the PWA plugin,
// which wants to build a service worker and has no business running in tests.
export default defineConfig({
  // Same reason vite.config.ts allows it for the dev server: the file icons are
  // globbed out of node_modules at the workspace root, one level above this
  // root, and without it every component that draws one fails to transform.
  server: { fs: { allow: [".."] } },
  resolve: {
    alias: {
      // The one module the PWA plugin would have generated, stubbed — see the
      // file for why. Everything else the app imports is real.
      "virtual:pwa-register/react": path.resolve(import.meta.dirname, "test/stubs/pwa-register.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    restoreMocks: true,
    // Read only by `make coverage`; report-only.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});
