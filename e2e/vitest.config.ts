import { defineConfig } from "vitest/config";

// Separate from the two workspace suites on purpose: this one needs the
// frontend built and a real chromium, so it must never join `npm test`, which
// is what every agent and every CI job runs. `make e2e` is its entry point.
export default defineConfig({
  test: {
    environment: "node",
    include: ["*.test.ts"],
    root: import.meta.dirname,
    // A browser launch, a page load and a handful of navigations. The default
    // 5s fails on a cold container for no reason worth investigating.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One browser, one server, one story — parallel files would fight over both.
    fileParallelism: false,
  },
});
