import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepTempFiles, writeJsonAtomic } from "../src/atomic-json.js";

let dir: string;
let target: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-atomic-"));
  target = path.join(dir, "rec.json");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What every store here does with a read it cannot parse: call it missing. */
async function readOrNull(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

describe("writeJsonAtomic", () => {
  it("leaves the record readable through a rewrite", async () => {
    // The bug this replaces: writeFile truncates the target first, so a reader
    // landing in that window parses nothing and every store here reports the
    // record as missing. A schedule the scheduler had just stamped read back as
    // null, mid-assertion, in scheduler-run.test.ts.
    //
    // A race cannot be forced, so it is crowded instead: a payload big enough
    // that the write is not one syscall, and a reader on every turn of it. This
    // can only fail if a torn read is observable, never because timing drifted.
    const big = { runs: Array.from({ length: 4000 }, (_, i) => ({ at: i, note: "x".repeat(80) })) };
    await writeJsonAtomic(target, big);

    const reads: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      reads.push(readOrNull(target));
      await writeJsonAtomic(target, { ...big, i });
      reads.push(readOrNull(target));
    }
    expect(await Promise.all(reads)).not.toContain(null);
  });

  it("cleans up after itself", async () => {
    await writeJsonAtomic(target, { ok: true });
    // A leftover would be swept at boot, but only a pod that died mid-write
    // should ever leave one.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the old record when the write fails", async () => {
    await writeJsonAtomic(target, { keep: "me" });
    // A value JSON.stringify throws on, which fails the write before the rename.
    await expect(writeJsonAtomic(target, { n: 1n })).rejects.toThrow();

    expect(await readOrNull(target)).toEqual({ keep: "me" });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("names the temp file so a directory scan skips it", async () => {
    // Both stores list a directory and parse everything ending in .json. A temp
    // file that ended in .json would be read as a record, half-written.
    let seen: string[] = [];
    const watching = setInterval(() => {
      seen = seen.concat(fs.readdirSync(dir));
    }, 0);
    await writeJsonAtomic(target, { a: 1 });
    clearInterval(watching);

    expect(seen.filter((f) => f !== "rec.json").every((f) => f.endsWith(".tmp"))).toBe(true);
  });
});

describe("sweepTempFiles", () => {
  it("removes what a pod killed mid-write left behind, and nothing else", async () => {
    fs.writeFileSync(path.join(dir, "rec.json.999.abc.tmp"), "{ half");
    fs.writeFileSync(path.join(dir, "keep.json"), "{}");

    await sweepTempFiles(dir);

    expect(fs.readdirSync(dir).sort()).toEqual(["keep.json", "rec.json"]);
  });

  it("does not throw on a directory that is not there", async () => {
    await expect(sweepTempFiles(path.join(dir, "nope"))).resolves.toBeUndefined();
  });
});
