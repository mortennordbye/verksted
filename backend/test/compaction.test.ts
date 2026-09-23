import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * Memory compaction against a fake `claude` (Assistant M4): when it bothers to
 * run, what it proposes, and that a kept merge takes the place of the facts it
 * names while a dropped one leaves them.
 */
let fake: FakeBin;
let app: FastifyInstance;
let memory: typeof import("../src/memory-store.js");
let jobs: typeof import("../src/assistant-jobs.js");

const log = { info: () => {}, warn: () => {} };

function run(text: string): string {
  return (
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n") + "\n"
  );
}

beforeAll(async () => {
  fake = FakeBin.install(["claude"]);
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-asst-"));
  process.env.COUNCIL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-council-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.SETTINGS_FILE = path.join(process.env.ASSISTANT_DIR, "settings.json");
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  memory = await import("../src/memory-store.js");
  jobs = await import("../src/assistant-jobs.js");
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

beforeEach(() => {
  fake.reset();
  const dir = process.env.MEMORY_DIR!;
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true });
});

/** Enough kept facts to pass half the budget, plus the two worth merging. */
async function fill(): Promise<void> {
  const pad = "x".repeat(400);
  for (let i = 0; i < 12; i++) await memory.save({ slug: `filler-${i}`, text: `${i} ${pad}` });
  await memory.save({ slug: "coffee", text: "Drinks coffee black." });
  await memory.save({ slug: "coffee-oat", text: "Takes oat milk in coffee now." });
}

const slugs = async () => (await memory.list()).map((m) => m.slug);

describe("runCompaction", () => {
  it("costs nothing while the store is under half full", async () => {
    await memory.save({ slug: "coffee", text: "Drinks coffee black." });
    expect(await jobs.runCompaction(log)).toBe(0);
    expect(fake.argvFor("claude")).toHaveLength(0);
  });

  it("proposes a merge, and keeping it removes the facts it replaces", async () => {
    await fill();
    fake.reply("claude", "-p", {
      stdout: run(
        [
          "coffee\tcoffee,coffee-oat\tDrinks coffee with oat milk.",
          // A fact that is not there replaces nothing, so it is not proposed.
          "ghost\tnot-a-fact\tSomething invented.",
          "garbage line",
        ].join("\n"),
      ),
    });

    expect(await jobs.runCompaction(log)).toBe(1);
    const argv = fake.argvFor("claude")[0];
    expect(argv[argv.indexOf("-p") + 1]).toContain("coffee-oat\t");

    const [proposal] = await memory.listProposals();
    expect(proposal).toMatchObject({
      slug: "coffee",
      text: "Drinks coffee with oat milk.",
      replaces: ["coffee", "coffee-oat"],
      source: "merges coffee, coffee-oat",
    });
    // Queued, not applied: both originals are still kept.
    expect(await slugs()).toEqual(expect.arrayContaining(["coffee", "coffee-oat"]));

    await memory.keep("coffee");
    const kept = await slugs();
    expect(kept).toContain("coffee");
    expect(kept).not.toContain("coffee-oat");
    expect((await memory.read("coffee"))?.text).toBe("Drinks coffee with oat milk.");
  });

  it("leaves every fact where it was when the merge is dropped", async () => {
    await fill();
    fake.reply("claude", "-p", {
      stdout: run("coffee-all\tcoffee,coffee-oat\tDrinks coffee with oat milk."),
    });
    expect(await jobs.runCompaction(log)).toBe(1);

    await memory.dropProposal("coffee-all");
    expect(await slugs()).toEqual(expect.arrayContaining(["coffee", "coffee-oat"]));
    expect(await slugs()).not.toContain("coffee-all");
  });
});
