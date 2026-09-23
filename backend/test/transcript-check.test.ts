import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The daily self-check on the newest real transcript (backlog: nothing read a
 * real one). What is pinned is that today's shape reads clean, and that a
 * shape the readers no longer understand is said rather than passed over.
 */
let check: typeof import("../src/transcript-check.js");

beforeAll(async () => {
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tc-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tc-s-"));
  check = await import("../src/transcript-check.js");
});

let n = 0;
const at = () => new Date(Date.UTC(2026, 8, 20, 10, 0, n++)).toISOString();
const human = (text: string) =>
  JSON.stringify({
    type: "user",
    uuid: `u${n}`,
    timestamp: at(),
    message: { role: "user", content: text },
    origin: { kind: "human" },
  });
const says = (text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: `a${n}`,
    timestamp: at(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

/** A home with one transcript of these lines, padded past the size worth judging. */
function home(lines: string[], padded = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tc-home-"));
  const project = path.join(dir, ".claude", "projects", "-data-repos-demo");
  fs.mkdirSync(project, { recursive: true });
  const pad = padded
    ? Array.from({ length: 40 }, (_, i) => says(`${"filler ".repeat(80)}${i}`))
    : [];
  fs.writeFileSync(
    path.join(project, "11111111-1111-4111-8111-111111111111.jsonl"),
    [...lines, ...pad].join("\n") + "\n",
  );
  return dir;
}

describe("the transcript self-check", () => {
  it("reads today's shape clean", async () => {
    const r = await check.checkTranscripts(home([human("fix the build"), says("Done.")]));
    expect(r?.problem).toBeNull();
    expect(r?.typed).toBe(1);
    expect(r?.turns).toBeGreaterThan(1);
  });

  it("says so when the harvest no longer finds what a person typed", async () => {
    // The shape a CLI release could move to: the same turn, the origin gone.
    const moved = JSON.stringify({
      type: "user",
      uuid: "m1",
      timestamp: at(),
      message: { role: "user", content: "fix the build" },
    });
    const r = await check.checkTranscripts(home([moved, says("Done.")]));
    expect(r?.problem).toMatch(/harvest found none/);
  });

  it("says so when the chat view reads no turns at all", async () => {
    const renamed = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ kind: "turn", who: "model", body: `${"x".repeat(400)}${i}` }),
    );
    const r = await check.checkTranscripts(home(renamed, false));
    expect(r?.problem).toMatch(/no turns/);
  });

  it("has nothing to say about a week with no transcript", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tc-none-"));
    expect(await check.checkTranscripts(empty)).toBeNull();
  });
});
