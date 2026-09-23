import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxUnavailableError, listSessionsDetail } from "../src/tmux.js";

const realPath = process.env.PATH;
const realTmpdir = process.env.TMUX_TMPDIR;

afterEach(() => {
  process.env.PATH = realPath;
  if (realTmpdir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = realTmpdir;
});

/**
 * The distinction the whole session sweep rests on. "No server running" means
 * genuinely nothing is live; anything else means we could not find out, and
 * answering [] would end every session and push "finished" for each one.
 */
describe("listSessionsDetail", () => {
  it("returns nothing when there is no tmux server", async () => {
    // A socket dir tmux has never used: it reports "error connecting to …".
    process.env.TMUX_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tmux-"));
    await expect(listSessionsDetail()).resolves.toEqual([]);
  });

  it("throws rather than reporting nothing when tmux cannot be run at all", async () => {
    process.env.PATH = "/nonexistent";
    await expect(listSessionsDetail()).rejects.toBeInstanceOf(TmuxUnavailableError);
  });

  it("asks tmux once for callers asking at the same moment, and again after (root cause 4)", async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tmux-bin-"));
    const log = path.join(bin, "calls");
    fs.writeFileSync(
      path.join(bin, "tmux"),
      `#!/bin/sh\necho ls >> "${log}"\nsleep 0.2\nprintf 'vk-a-1\\t1700000000\\t42\\n'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${realPath}`;
    const calls = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;

    const [a, b, c] = await Promise.all([
      listSessionsDetail(),
      listSessionsDetail(),
      listSessionsDetail(),
    ]);
    expect(a).toEqual([{ name: "vk-a-1", activity: 1700000000, panePid: 42 }]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(calls()).toBe(1);

    // Nothing is kept once it has answered: the next ask is a fresh look.
    await listSessionsDetail();
    expect(calls()).toBe(2);
  });
});
