import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let memoryDir: string;
let home: string;
let store: typeof import("../src/memory-store.js");

const CLAUDE_MD = ".claude/CLAUDE.md";

function write(slug: string, body: string): void {
  fs.writeFileSync(path.join(memoryDir, `${slug}.md`), body);
}

beforeAll(async () => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "vk-home-"));
  process.env.MEMORY_DIR = memoryDir;
  process.env.HOME = home;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-assist-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  store = await import("../src/memory-store.js");
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  for (const f of fs.readdirSync(memoryDir)) fs.rmSync(path.join(memoryDir, f));
  fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });
});

describe("the store", () => {
  it("reads a file the agent wrote itself", async () => {
    // The agent writes these with the ordinary Write tool, so the format has to
    // survive being produced by hand.
    write(
      "squash-merges",
      `---\ntype: preference\nscope: global\nsource: corrected me twice\ncreated: 2026-08-01T10:00:00.000Z\n---\n\nMerge with --squash --delete-branch, never the web UI.\n`,
    );

    const [memory] = await store.list();

    expect(memory.slug).toBe("squash-merges");
    expect(memory.text).toBe("Merge with --squash --delete-branch, never the web UI.");
    expect(memory.type).toBe("preference");
    expect(memory.source).toBe("corrected me twice");
  });

  it("keeps a fact whose frontmatter is missing or wrong", async () => {
    // A missing field should cost that field, not the fact.
    write("half-written", "---\ntype: nonsense\n---\n\nStill worth knowing.\n");

    const [memory] = await store.list();

    expect(memory.text).toBe("Still worth knowing.");
    expect(memory.type).toBe("reference");
    expect(memory.scope).toBe("global");
    expect(memory.source).toBeNull();
    // The agent leaves `created` off as often as not, and both the ordering and
    // which facts the budget drops depend on having one.
    expect(memory.createdAt).not.toBeNull();
  });

  it("ignores files that are not memories", async () => {
    write("real", "---\n---\n\nA fact.\n");
    fs.writeFileSync(path.join(memoryDir, "notes.txt"), "not a memory");
    fs.writeFileSync(path.join(memoryDir, "../escape.md"), "outside");
    write("empty", "---\ntype: preference\n---\n\n");

    expect((await store.list()).map((m) => m.slug)).toEqual(["real"]);
  });

  it("keeps the original date when a fact is corrected", async () => {
    const first = await store.save({ slug: "ports", text: "8080 is taken." });
    const second = await store.save({ slug: "ports", text: "8080 and 5173 are taken." });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.text).toBe("8080 and 5173 are taken.");
  });

  it("refuses a slug that would reach outside the directory", async () => {
    await expect(store.save({ slug: "../escape", text: "no" })).rejects.toThrow();
    await expect(store.save({ slug: "Has Spaces", text: "no" })).rejects.toThrow();
  });
});

describe("what sessions are told", () => {
  it("labels a project-scoped fact so one block can serve every repo", async () => {
    await store.save({ slug: "kargo", text: "Kargo promotes images.", scope: "Homelab" });
    await store.save({ slug: "dashes", text: "Avoid em dashes." });

    const { text } = store.renderBlock(await store.list());

    expect(text).toContain("- In Homelab: Kargo promotes images.");
    expect(text).toContain("- Avoid em dashes.");
  });

  it("drops the oldest rather than blowing the budget", async () => {
    const big = "x".repeat(900);
    for (let i = 0; i < 12; i++) {
      await store.save({ slug: `fact-${i}`, text: `${i} ${big}` });
    }

    const { used, dropped } = store.renderBlock(await store.list());

    expect(used).toBeLessThanOrEqual(store.BUDGET_BYTES);
    expect(dropped).toBeGreaterThan(0);
  });

  it("writes the block into the agent's memory file, and takes it back out", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, CLAUDE_MD), "# My own notes\n\nAlways rebase.\n");

    await store.save({ slug: "dashes", text: "Avoid em dashes." });
    const withMemory = fs.readFileSync(path.join(home, CLAUDE_MD), "utf8");

    expect(withMemory).toContain("Avoid em dashes.");
    expect(withMemory).toContain("Always rebase.");

    await store.remove("dashes");
    const without = fs.readFileSync(path.join(home, CLAUDE_MD), "utf8");

    // The block goes when the last fact does; a stale heading would read as
    // "verksted knows nothing about you", which is worse than no block at all.
    expect(without).not.toContain("verksted:memory");
    expect(without).toContain("Always rebase.");
  });
});

describe("the API", () => {
  it("reports what is stored and what it costs", async () => {
    await store.save({ slug: "dashes", text: "Avoid em dashes." });

    const body = (await app.inject({ url: "/api/memory" })).json();

    expect(body.memories).toHaveLength(1);
    expect(body.budget).toBe(store.BUDGET_BYTES);
    expect(body.used).toBeGreaterThan(0);
  });

  it("forgets on request", async () => {
    await store.save({ slug: "wrong", text: "Something untrue." });

    const res = await app.inject({ method: "DELETE", url: "/api/memory/wrong" });

    expect(res.statusCode).toBe(200);
    expect(await store.list()).toEqual([]);
  });

  it("404s deleting something that was never there", async () => {
    expect((await app.inject({ method: "DELETE", url: "/api/memory/ghost" })).statusCode).toBe(404);
  });
});
