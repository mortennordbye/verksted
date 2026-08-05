import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: that one pulls in the PWA plugin,
// which wants to build a service worker and has no business running in tests.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    restoreMocks: true,
  },
});
