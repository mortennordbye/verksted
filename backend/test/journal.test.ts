import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * The journal: the day's conversation distilled at the end of it, and read
 * back at the start of the next.
 *
 * Driven against a fake `claude`, as the meeting tests are. What is pinned is
 * that a day with nothing said costs no call, that the turn is given the day's
 * words and the journal's own job rather than the briefing's, that what it
 * writes lands as that day's file, and that the next chair turn is told it.
 */
let fake: FakeBin;
let assistantDir: string;
let app: FastifyInstance;
let scheduler: typeof import("../src/scheduler.js");
let journal: typeof import("../src/journal-store.js");

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
  assistantDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-journal-"));
  process.env.ASSISTANT_DIR = assistantDir;
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.COUNCIL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-council-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.SETTINGS_FILE = path.join(assistantDir, "settings.json");
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  scheduler = await import("../src/scheduler.js");
  journal = await import("../src/journal-store.js");
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
  fs.rmSync(assistantDir, { recursive: true, force: true });
});

beforeEach(() => {
  fake.reset();
  fs.rmSync(path.join(assistantDir, "journal"), { recursive: true, force: true });
  for (const f of fs.readdirSync(assistantDir)) {
    if (f.endsWith(".jsonl")) fs.rmSync(path.join(assistantDir, f));
  }
});

/** A thread on the volume with these turns, all said now. */
function thread(id: string, turns: [string, string][]): void {
  const lines = turns.map(([role, text]) =>
    JSON.stringify({
      id: `${id}-${text.length}`,
      role,
      text,
      tools: [],
      at: new Date().toISOString(),
    }),
  );
  fs.writeFileSync(path.join(assistantDir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

describe("the journal", () => {
  it("costs nothing on a day nobody said anything", async () => {
    expect(await scheduler.runJournal(log)).toBe(false);
    expect(fake.argvFor("claude")).toHaveLength(0);
  });

  it("hands the day's words to a turn with the journal's own job, and keeps what it writes", async () => {
    thread("11111111-1111-4111-8111-111111111111", [
      ["user", "remind me the domain renews on the 3rd"],
      ["assistant", "Noted. Anything else?"],
    ]);
    fake.reply("claude", "-p", { stdout: run("Domain renews on the 3rd; reminder wanted.") });

    expect(await scheduler.runJournal(log)).toBe(true);

    const argv = fake.argvFor("claude")[0];
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("you: remind me the domain renews on the 3rd");
    expect(prompt).toContain("assistant: Noted. Anything else?");
    const system = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(system).toContain("writing the journal");
    expect(system).not.toContain("attention:");
    // The floor settings, not the chair's: this is a cheap turn by design.
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");

    const day = journal.today();
    expect(fs.readFileSync(path.join(assistantDir, "journal", `${day}.md`), "utf8")).toBe(
      "Domain renews on the 3rd; reminder wanted.\n",
    );
  });

  it("is read back, newest last, at the start of the next turn", async () => {
    await journal.writeDay("2026-08-27", "Three days ago.");
    await journal.writeDay("2026-08-28", "Two days ago.");
    await journal.writeDay("2026-08-29", "Yesterday: decided to move the domain.");
    await journal.writeDay("2026-08-26", "Too old to carry.");
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { text: "Kari is my partner." },
    });
    fake.reply("claude", "-p", { stdout: run("Yes, the domain.") });

    await app.inject({
      method: "POST",
      url: "/api/assistant/messages",
      payload: { text: "what did we decide yesterday?" },
    });

    const argv = fake.argvFor("claude")[0];
    const system = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(system).toContain("Kari is my partner.");
    expect(system).toContain("2026-08-29\nYesterday: decided to move the domain.");
    expect(system.indexOf("Two days ago.")).toBeLessThan(system.indexOf("Yesterday"));
    expect(system).not.toContain("Too old to carry.");
    // The person comes before the roster, and before the standing orders.
    expect(system.indexOf("Kari is my partner.")).toBeLessThan(system.indexOf("2026-08-29"));
  });

  it("keeps the material to the day and to a size", () => {
    const at = new Date().toISOString();
    const stale = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const entries = [
      { id: "a", role: "user" as const, text: "today", tools: [], at },
      { id: "b", role: "assistant" as const, text: "old", tools: [], at: stale },
      {
        id: "c",
        role: "assistant" as const,
        text: "x".repeat(journal.MATERIAL_BYTES),
        tools: [],
        at,
      },
      { id: "d", role: "user" as const, text: "after the cap", tools: [], at },
    ];
    const text = journal.material(entries, journal.today());
    expect(text).toBe("you: today");
  });
});
