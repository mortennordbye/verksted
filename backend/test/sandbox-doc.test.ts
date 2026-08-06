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
