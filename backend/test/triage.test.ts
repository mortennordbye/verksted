import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * The triage turn against a fake `claude`: the batch it is handed, the job it
 * is given, what its verdicts do to the items and the loops, and what it
 * costs when there is nothing to judge.
 */
let fake: FakeBin;
let app: FastifyInstance;
let feed: typeof import("../src/feed-store.js");
let loops: typeof import("../src/loops-store.js");
let scheduler: typeof import("../src/scheduler.js");

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
  process.env.FEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-feed-"));
  process.env.LOOPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-loops-"));
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-asst-"));
  process.env.COUNCIL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-council-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.SETTINGS_FILE = path.join(process.env.ASSISTANT_DIR, "settings.json");
  // The pushes triage sends land here rather than in /data, which exists in a
  // container and not on a runner.
  process.env.PUSH_FILE = path.join(process.env.ASSISTANT_DIR, "push.json");
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  feed = await import("../src/feed-store.js");
  loops = await import("../src/loops-store.js");
  scheduler = await import("../src/scheduler.js");
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

beforeEach(() => {
  fake.reset();
  for (const dir of [process.env.FEED_DIR!, process.env.LOOPS_DIR!]) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  }
});

const arrived = (id: string, title: string) =>
  feed.upsert({
    id,
    source: "github",
    at: new Date().toISOString(),
    title,
    detail: "PullRequest, your review was asked for",
    link: "https://github.com/x/y/pull/1",
    version: "1",
  });

describe("triage", () => {
  it("costs nothing when nothing is waiting to be judged", async () => {
    expect(await scheduler.runTriage(log, true)).toBe(0);
    expect(fake.argvFor("claude")).toHaveLength(0);
  });

  it("judges the batch in one call, applies the verdicts, and opens the loops it names", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { text: "Kari is my partner; anything from her is urgent." },
    });
    await arrived("github:1", "verksted: Bump node");
    await arrived("github:2", "homelab: Kari asked about the cabin");
    await arrived("github:3", "left out on purpose");
    fake.reply("claude", "-p", {
      stdout: run(
        [
          "github:1\tquiet\tRenovate, patch-level, green.\t-",
          "github:2\tattention\tKari needs an answer about the cabin by Friday.\tnew: answer Kari about the cabin | 2026-09-05",
        ].join("\n"),
      ),
    });

    expect(await scheduler.runTriage(log, true)).toBe(3);

    const argv = fake.argvFor("claude")[0];
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("github:1\tgithub\tverksted: Bump node\t");
    expect(prompt).toContain("github:3\t");
    const system = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(system).toContain("sorting them for the person");
    expect(system).toContain("Kari is my partner");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");

    const one = (await feed.get("github:1"))!;
    expect([one.urgency, one.detail, one.triaged]).toEqual([
      "quiet",
      "Renovate, patch-level, green.",
      true,
    ]);
    const two = (await feed.get("github:2"))!;
    expect(two.urgency).toBe("attention");
    expect(two.loop).toBe("answer-kari-about-the-cabin");
    expect(two.pushed).toBe(true);
    const loop = (await loops.get("answer-kari-about-the-cabin"))!;
    expect([loop.due, loop.from]).toEqual(["2026-09-05", "github:2"]);
    // Left out of the reply: keeps the poller's verdict, but is judged, so it
    // is not carried into the next batch.
    const three = (await feed.get("github:3"))!;
    expect([three.urgency, three.triaged]).toEqual(["new", true]);
    expect(await feed.untriaged()).toEqual([]);
  });

  it("sorts by the rules the person has kept", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/memory/renovate-quiet",
      payload: { text: "Renovate's patch bumps are never worth attention.", type: "preference" },
    });
    await arrived("github:6", "verksted: Bump eslint");
    fake.reply("claude", "-p", { stdout: run("github:6\tquiet\tRenovate.\t-") });

    await scheduler.runTriage(log, true);

    const argv = fake.argvFor("claude")[0];
    const system = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(system).toContain("- Renovate's patch bumps are never worth attention.");
  });

  it("learns from what was dismissed, into the review queue and not past it", async () => {
    const at = new Date().toISOString();
    for (const [id, title] of [
      ["mail:1", "Newsletter: weekly deals"],
      ["mail:2", "Newsletter: more deals"],
      ["mail:3", "Kari: hytta"],
    ]) {
      await feed.upsert({
        id,
        source: "mail",
        at,
        title,
        detail: "",
        link: null,
        version: "1",
      });
      await feed.judge(id, { urgency: id === "mail:3" ? "attention" : "new" });
    }
    await feed.setState("mail:1", "done");
    await feed.setState("mail:2", "done");
    fake.reply("claude", "-p", {
      stdout: run(
        "newsletters-quiet\tNewsletters from the deals sender are quiet, never attention.",
      ),
    });

    expect(await scheduler.runLearning(log)).toBe(1);

    const argv = fake.argvFor("claude")[0];
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("mail\tNewsletter: weekly deals\tnew\tdismissed");
    expect(prompt).toContain("mail\tKari: hytta\tattention\tnew");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain(
      "would have sorted it right",
    );
    // Queued, not kept: nothing reaches triage until the person keeps it.
    const queue = (await app.inject({ url: "/api/memory/proposed" })).json().proposals;
    expect(queue.map((p: { slug: string; text: string }) => [p.slug, p.text])).toEqual([
      ["sort-newsletters-quiet", "Newsletters from the deals sender are quiet, never attention."],
    ]);
    expect(
      (await app.inject({ url: "/api/memory" }))
        .json()
        .memories.map((m: { slug: string }) => m.slug),
    ).not.toContain("sort-newsletters-quiet");
  });

  it("spaces itself out, so a busy hour is six calls and not sixty", async () => {
    await arrived("github:4", "one");
    fake.reply("claude", "-p", { stdout: run("github:4\tnew\tOne.\t-") });
    // Well past whatever the test above stamped.
    const t0 = Date.now() + 30 * 60_000;
    expect(await scheduler.runTriage(log, false, t0)).toBe(1);
    await arrived("github:5", "two");
    expect(await scheduler.runTriage(log, false, t0 + 60_000)).toBe(0);
    expect(await scheduler.runTriage(log, false, t0 + 11 * 60_000)).toBe(1);
  });
});
