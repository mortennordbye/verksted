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
});
