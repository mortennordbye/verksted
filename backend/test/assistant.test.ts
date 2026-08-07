import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * The assistant end to end, against a fake `claude` on PATH.
 *
 * This is the only way to assert the part that matters without a token: that
 * the first turn *names* the conversation with --session-id and every later one
 * resumes it, that a turn is stored rather than scraped, and that a CLI which
 * fails leaves something in the thread saying so instead of silence.
 */
let fake: FakeBin;
let assistantDir: string;
let app: FastifyInstance;

const CONV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stream-json run that says `text`, echoing back whatever session id it got. */
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
  assistantDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-assist-"));
  process.env.ASSISTANT_DIR = assistantDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

beforeEach(() => {
  for (const f of fs.readdirSync(assistantDir)) fs.rmSync(path.join(assistantDir, f));
  fake.reset();
  fake.reply("claude", "-p", { stdout: run("Two things need you.") });
});

async function say(text: string) {
  return app.inject({ method: "POST", url: "/api/assistant/messages", payload: { text } });
}

describe("POST /api/assistant/messages", () => {
  it("stores both sides of the turn", async () => {
    const res = await say("what needs me today?");

    expect(res.statusCode).toBe(200);
    const thread = res.json();
    expect(thread.status).toBe("idle");
    expect(thread.entries.map((e: { role: string; text: string }) => [e.role, e.text])).toEqual([
      ["user", "what needs me today?"],
      ["assistant", "Two things need you."],
    ]);
  });

  it("names the conversation on the first turn and resumes it on the next", async () => {
    await say("first");
    const conversationId = (await app.inject({ url: "/api/assistant" })).json().conversationId;
    expect(conversationId).toMatch(CONV);

    fake.reset();
    await say("second");

    const [argv] = fake.argvFor("claude");
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(conversationId);
    expect(argv).not.toContain("--session-id");
  });

  it("asks for a stream it can actually parse", async () => {
    await say("hello");

    const [argv] = fake.argvFor("claude");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    // stream-json emits nothing without it.
    expect(argv).toContain("--verbose");
    expect(argv[argv.indexOf("--session-id") + 1]).toMatch(CONV);
  });

  it("denies the tools it should never have, and does not merely fail to allow them", async () => {
    // The allow list is auto-approval, not restriction: anything left off it
    // still exists and, in auto permission mode, is still a classifier's call.
    // Denying is the only half that actually stops a tool, so the assistant's
    // "it cannot edit files or run commands" claim rests entirely on this.
    await say("hello");

    const [argv] = fake.argvFor("claude");
    const denied = argv[argv.indexOf("--disallowed-tools") + 1];
    for (const tool of ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]) {
      expect(denied).toContain(tool);
    }
    expect(argv[argv.indexOf("--allowed-tools") + 1]).toContain("mcp__verksted");
    // Stronger than either list: this is the set that exists. It is also what
    // stops the CLI deferring tool schemas, which cost a whole ToolSearch round
    // trip per turn before the assistant could look at anything.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
  });

  it("gives the assistant the verksted tools to act through", async () => {
    await say("hello");

    const [argv] = fake.argvFor("claude");
    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };

    expect(config.mcpServers.verksted.args).toEqual(["/etc/verksted/verksted-mcp.mjs"]);
  });

  it("runs on the cheap settings, since the real work happens in the sessions it starts", async () => {
    await say("hello");

    const [argv] = fake.argvFor("claude");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
  });

  it("passes the prompt as its own argument, never through a shell", async () => {
    const nasty = 'merge "approved" PRs; then $(rm -rf /) `whoami`';

    await say(nasty);

    const [argv] = fake.argvFor("claude");
    expect(argv[argv.indexOf("-p") + 1]).toBe(nasty);
  });

  it("says what went wrong when the CLI fails, rather than storing silence", async () => {
    fake.reply("claude", "-p", { stderr: "Invalid API key", code: 1 });

    const thread = (await say("hello")).json();

    const last = thread.entries.at(-1);
    expect(last.role).toBe("assistant");
    expect(last.failed).toBe(true);
    expect(last.text).toContain("Invalid API key");
  });

  it("rejects an empty message", async () => {
    expect((await say("   ")).statusCode).toBe(400);
  });

  it("survives a turn that produces no events at all", async () => {
    fake.reply("claude", "-p", { stdout: "" });

    const thread = (await say("hello")).json();

    expect(thread.entries.at(-1).failed).toBe(true);
  });
});

describe("the thread", () => {
  it("persists across a restart, and comes back idle rather than thinking", async () => {
    await say("remember this");

    // A fresh module registry is what a restarted pod looks like: in-memory
    // state is gone, the volume is not.
    vi.resetModules();
    const fresh = await import("../src/assistant.js");
    const thread = await fresh.readThread();

    expect(thread.status).toBe("idle");
    expect(thread.entries).toHaveLength(2);
  });

  it("starts a new conversation without destroying the old thread", async () => {
    await say("first thread");
    const before = (await app.inject({ url: "/api/assistant" })).json().conversationId;

    const created = await app.inject({ method: "POST", url: "/api/assistant/new" });
    const after = created.json().conversationId;

    expect(after).not.toBe(before);
    expect((await app.inject({ url: "/api/assistant" })).json().entries).toEqual([]);
    expect(fs.existsSync(path.join(assistantDir, `${before}.jsonl`))).toBe(true);
  });
});
