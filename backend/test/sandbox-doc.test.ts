import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSandboxNotes, mergeBlock } from "../src/sandbox-doc.js";

const MEMORY_FILES = [".claude/CLAUDE.md", ".codex/AGENTS.md"];
const log = { warn: () => {} };

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vk-home-"));
}

describe("mergeBlock", () => {
  it("keeps the user's own notes when adding the block", () => {
    const merged = mergeBlock("# My notes\n\nAlways rebase.\n");
    expect(merged).toContain("Always rebase.");
    expect(merged).toContain("/etc/verksted/SANDBOX.md");
  });

  it("replaces the block in place instead of stacking copies", () => {
    const once = mergeBlock("Mine.\n");
    const stale = once.replace("run `vk doctor` to", "run `vk explain` to");
    const merged = mergeBlock(stale);

    expect(merged).toBe(once);
    expect(merged).not.toContain("vk explain");
    expect(merged.split("verksted:sandbox start")).toHaveLength(2);
  });

  it("leaves text written after the block alone", () => {
    const merged = mergeBlock(`${mergeBlock("")}\nAnd my own footer.\n`);
    expect(merged).toContain("And my own footer.");
    expect(merged.split("verksted:sandbox start")).toHaveLength(2);
  });
});

describe("the sandbox note", () => {
  /**
   * How `vk feedback` is rolled out at all: the agents only learn the command
   * exists because this block is written into their global memory file, in
   * every repo, including ones verksted has never seen.
   */
  it("tells every agent how to say what the bench is missing", () => {
    const merged = mergeBlock("");
    expect(merged).toContain("vk feedback");
  });
});

describe("the house rules", () => {
  it("tells every agent to leave no sign that one wrote anything", () => {
    // Every agent CLI here signs its own work by default, and git history is
    // not something you can quietly correct later. This block is the only thing
    // that stops it, and it has to reach repos verksted has never seen — which
    // is why it lives in the global memory file rather than in any CLAUDE.md.
    const merged = mergeBlock("");

    expect(merged).toContain("Co-Authored-By");
    expect(merged).toContain("Generated with");
    expect(merged).toMatch(/commit messages/);
    expect(merged).toMatch(/pull request titles and bodies/);
  });

  it("tells every agent to ask before anything that cannot be undone", () => {
    // Scheduled sessions run in auto permission mode, so the line between
    // routine and gone-forever has to be drawn in words.
    const merged = mergeBlock("");

    for (const forbidden of ["Force-pushing", "reset --hard", "git clean", "rm -rf"]) {
      expect(merged, forbidden).toContain(forbidden);
    }
    // And the ordinary half, or an agent that asks about every commit is
    // useless in exactly the unattended runs this is written for.
    expect(merged).toContain("need no permission");
  });

  it("keeps the two blocks separate, so neither rewrite disturbs the other", () => {
    const merged = mergeBlock("Mine.\n");

    expect(merged.split("verksted:sandbox start")).toHaveLength(2);
    expect(merged.split("verksted:house start")).toHaveLength(2);
    expect(mergeBlock(merged)).toBe(merged);
    expect(merged).toContain("Mine.");
  });
});

describe("ensureSandboxNotes", () => {
  it("writes the pointer into every agent's global memory file", async () => {
    const home = tmpHome();
    await ensureSandboxNotes(log, home);

    for (const rel of MEMORY_FILES) {
      const text = fs.readFileSync(path.join(home, rel), "utf8");
      expect(text).toContain("/etc/verksted/SANDBOX.md");
    }
  });

  it("is idempotent across boots", async () => {
    const home = tmpHome();
    await ensureSandboxNotes(log, home);
    const first = fs.readFileSync(path.join(home, MEMORY_FILES[0]), "utf8");
    await ensureSandboxNotes(log, home);

    expect(fs.readFileSync(path.join(home, MEMORY_FILES[0]), "utf8")).toBe(first);
  });

  // Root ignores directory permissions and the tests run as root, so the
  // unwritable case has to be one no uid can write into.
  it("does not throw when the memory files cannot be written", async () => {
    const home = path.join(tmpHome(), "a-file-not-a-home");
    fs.writeFileSync(home, "");

    await expect(ensureSandboxNotes(log, home)).resolves.toBeUndefined();
  });
});
