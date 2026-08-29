import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The contract is the one thing about a repo the maintainer reads before it
 * reads the repo: what verifies it, what may merge alone, what is off limits.
 * Getting the section boundaries wrong would hand a run the wrong rules, or
 * none, without anything else noticing.
 */
let maintainer: typeof import("../src/maintainer.js");
let dir: string;

function repo(claudeMd: string | null): string {
  const d = fs.mkdtempSync(path.join(dir, "repo-"));
  if (claudeMd !== null) fs.writeFileSync(path.join(d, "CLAUDE.md"), claudeMd);
  return d;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-maint-"));
  process.env.MAINTAINER_DIR = path.resolve(import.meta.dirname, "../../runtime/maintainer");
  maintainer = await import("../src/maintainer.js");
});

describe("readContract", () => {
  it("returns the Maintainer section and nothing after it", async () => {
    const d = repo(
      "# CLAUDE.md\n\n## Development\n\nmake dev\n\n## Maintainer\n\n" +
        "Verify: `npm test`.\n\n### Tiers\n\n- tier:auto: docs\n\n## Architecture\n\nthree parts\n",
    );
    const contract = await maintainer.readContract(d);
    expect(contract).toContain("Verify: `npm test`.");
    expect(contract).toContain("### Tiers");
    expect(contract).not.toContain("three parts");
    expect(contract).not.toContain("make dev");
  });

  it("is null for a repo without one, or without a CLAUDE.md", async () => {
    expect(await maintainer.readContract(repo("# CLAUDE.md\n\n## Development\n"))).toBeNull();
    expect(await maintainer.readContract(repo("## Maintainer\n\n\n"))).toBeNull();
    expect(await maintainer.readContract(repo(null))).toBeNull();
  });
});

describe("stagePrompt", () => {
  it("puts the shipped prompt, the contract and the owner's notes together", async () => {
    const prompt = await maintainer.stagePrompt(
      "scout",
      { project: "demo", dir: "/data/repos/demo", contract: "Verify: `npm test`." },
      "skip the desktop app tonight",
    );
    expect(prompt).toMatch(/^You are the maintainer's scout/);
    expect(prompt).toContain("Project: demo");
    expect(prompt).toContain("Working tree: /data/repos/demo");
    expect(prompt).toContain("Verify: `npm test`.");
    expect(prompt).toContain("## Notes from the owner\n\nskip the desktop app tonight");
    // The one line every stage ends on: a denial is a rule, not an obstacle.
    expect(prompt).toContain("deny rather than ask");
  });

  it("tells a run with no contract to fail rather than guess", async () => {
    const prompt = await maintainer.stagePrompt(
      "scout",
      { project: "demo", dir: "/data/repos/demo", contract: null },
      "",
    );
    expect(prompt).toContain("no `## Maintainer` section");
    expect(prompt).toContain('"failed: no maintainer contract in CLAUDE.md"');
    expect(prompt).not.toContain("## Notes from the owner");
  });
});
