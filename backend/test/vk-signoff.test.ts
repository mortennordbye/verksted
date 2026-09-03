import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The second ask: a run that did its work and never wrote its verdict is asked
 * for the line, in the conversation it just had.
 *
 * Shell, like the guard, so nothing else in the suite would notice it
 * breaking — and its failure modes are both quiet. Asking when it should not
 * spends a model call on every clean night; never writing what it got back
 * leaves the inbox saying a night failed when it did not.
 */
const SIGNOFF = resolve(import.meta.dirname, "../../runtime/vk-signoff");
const run = promisify(execFile);

let dir: string;
let report: string;
let conv: string;
let calls: string;

/** A `claude` on PATH that records its argv and prints what it is told to. */
async function fakeClaude(stdout: string, exitCode = 0): Promise<string> {
  const bin = join(dir, "bin");
  await run("mkdir", ["-p", bin]);
  const path = join(bin, "claude");
  await writeFile(
    path,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(calls)}; done\n` +
      // %b, so a multi-line reply in the fixture reaches the script as lines.
      `printf '%b\\n' ${JSON.stringify(stdout)}\nexit ${exitCode}\n`,
  );
  await chmod(path, 0o755);
  return bin;
}

/** Run the script over an exit code, and say what the report holds after. */
async function signoff(code: string, env: Record<string, string> = {}): Promise<string> {
  const bin = join(dir, "bin");
  await run("sh", [SIGNOFF, code], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      VK_REPORT_FILE: report,
      VK_CONV_FILE: conv,
      ...env,
    },
  }).catch(() => {});
  return (await readFile(report, "utf8")).trim();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vk-signoff-"));
  report = join(dir, "report");
  conv = join(dir, "conv");
  calls = join(dir, "calls");
  await writeFile(report, "failed: no sign-off\n");
  await writeFile(conv, "11111111-2222-3333-4444-555555555555\n");
});

describe("vk-signoff", () => {
  it("asks the conversation it just had, and keeps the line it gets back", async () => {
    await fakeClaude("ok: nothing to do, no open maint/ pull requests");
    expect(await signoff("0", { VK_SETTINGS: "/etc/settings.json" })).toBe(
      "ok: nothing to do, no open maint/ pull requests",
    );
    const argv = (await readFile(calls, "utf8")).trim().split("\n");
    expect(argv).toContain("--resume");
    expect(argv).toContain("11111111-2222-3333-4444-555555555555");
    // The run's own settings, so the guard still stands over the second turn,
    // and one turn only: this is a question, not more work.
    expect(argv).toContain("--settings");
    expect(argv).toContain("/etc/settings.json");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("1");
  });

  it("takes the verdict line out of whatever else the turn said", async () => {
    await fakeClaude("Right, here it is:\n\nattention: the build cannot reach the remote\n");
    expect(await signoff("0")).toBe("attention: the build cannot reach the remote");
  });

  it("says it asked when the turn answers with nothing usable", async () => {
    await fakeClaude("I am not sure what you mean.");
    expect(await signoff("0")).toBe("failed: no sign-off (asked, no answer)");
  });

  it("says the same when the turn cannot run at all", async () => {
    await fakeClaude("", 1);
    expect(await signoff("0")).toBe("failed: no sign-off (asked, no answer)");
  });

  it("never asks after a run that broke: the watcher has the reason", async () => {
    await fakeClaude("ok: all fine");
    expect(await signoff("1")).toBe("failed: no sign-off");
    await expect(readFile(calls, "utf8")).rejects.toThrow();
  });

  it("never asks a run that did sign off, whatever it said", async () => {
    await fakeClaude("ok: rewritten");
    await writeFile(report, "failed: the tests do not pass on main\n");
    expect(await signoff("0")).toBe("failed: the tests do not pass on main");
    await expect(readFile(calls, "utf8")).rejects.toThrow();
  });

  it("does nothing without a conversation to resume", async () => {
    await fakeClaude("ok: fine");
    await writeFile(conv, "");
    expect(await signoff("0")).toBe("failed: no sign-off");
    await expect(readFile(calls, "utf8")).rejects.toThrow();
  });
});
