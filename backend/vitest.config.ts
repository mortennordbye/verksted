import { defineConfig } from "vitest/config";

// Coverage is read only by `make coverage`; `npm test` does not measure it.
// Report-only across the board, with a floor on the two files the security
// baseline rests on: path scoping (paths.ts) and the origin and host checks
// (origin.ts). A change that leaves a branch of either untested fails there.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: {
        "src/paths.ts": { lines: 90, branches: 85, functions: 90 },
        "src/origin.ts": { lines: 90, branches: 85, functions: 90 },
      },
    },
  },
});
