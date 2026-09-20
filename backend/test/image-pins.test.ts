import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins that live in two files and have to agree (O-09).
 *
 * Chromium is installed into the image by `playwright install`, and the
 * backend drives it with `playwright-core` from node_modules. The two speak a
 * private protocol that is only promised to work within one version, and
 * nothing checks them against each other: dependabot bumps the package because
 * it reads package.json, and the Dockerfile line is invisible to it. The pane
 * then fails to launch on a pod nobody changed, hours after a merge nobody
 * connected to it.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("the versions the image and the build share", () => {
  it("installs the chromium that playwright-core drives", () => {
    const pkg = JSON.parse(read("backend/package.json")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const core = pkg.dependencies["playwright-core"] ?? pkg.devDependencies?.["playwright-core"];
    const image = /npx --yes playwright@(\S+) install/.exec(read("Dockerfile"))?.[1];

    expect(core, "playwright-core is not pinned in backend/package.json").toBeTruthy();
    expect(image, "the Dockerfile no longer installs playwright the way this reads").toBeTruthy();
    // Exact on both sides: a range here would be the same drift with a wider
    // door. Bump the two together.
    expect(image).toBe(core);
  });
});
