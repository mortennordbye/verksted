import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AssistantFrame } from "../../shared/api.js";
import { transcriptPath } from "../src/claude-home.js";
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

/**
 * What the real CLI leaves behind once it has a conversation, and the fake does
 * not: the transcript, which is what the next turn's flag is read from.
 */
function claudeKnows(conversationId: string): void {
  const file = transcriptPath(process.env.REPOS_DIR ?? "", conversationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
}

beforeAll(async () => {
  fake = FakeBin.install(["claude"]);
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vk-home-"));
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

beforeEach(async () => {
  (await import("../src/assistant-usage.js")).resetUsageCache();
  // recursive: unattended threads live in a subdirectory beside the chats.
  for (const f of fs.readdirSync(assistantDir)) {
    fs.rmSync(path.join(assistantDir, f), { recursive: true, force: true });
  }
  fake.reset();
  fake.clear("claude");
  fake.reply("claude", "-p", { stdout: run("Two things need you.") });
});

async function say(text: string) {
  return app.inject({ method: "POST", url: "/api/assistant/messages", payload: { text } });
}

/** The same run, saying what it took the way the CLI's result event does. */
function measuredRun(text: string, prompt: number, output: number): string {
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: prompt - 10,
    cache_creation_input_tokens: 0,
    output_tokens: output,
  };
  return (
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }], usage } }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.25,
        usage,
      }),
    ].join("\n") + "\n"
  );
}

describe("what a thread has taken (A-26)", () => {
  it("says nothing until a turn has been measured", async () => {
    const thread = (await say("hello")).json();
    expect(thread.usage).toBeUndefined();
  });

  it("adds each turn to the thread's total, and keeps the size of the last prompt", async () => {
    fake.reply("claude", "-p", { stdout: measuredRun("One.", 1_000, 40) });
    await say("first");
    fake.reply("claude", "-p", { stdout: measuredRun("Two.", 3_000, 60) });
    const thread = (await say("second")).json();

    expect(thread.usage).toEqual({
      total: { input: 20, output: 100, cacheRead: 3_980, cacheWrite: 0, turns: 2, costUsd: 0.5 },
      context: 3_000,
    });
  });

  it("reads it back from the volume, not from memory", async () => {
    fake.reply("claude", "-p", { stdout: measuredRun("One.", 1_000, 40) });
    await say("first");
    (await import("../src/assistant-usage.js")).resetUsageCache();

    const thread = (await app.inject({ url: "/api/assistant" })).json();
    expect(thread.usage.total.output).toBe(40);
  });

  it("starts a new conversation at nothing, and takes the count with a deleted one", async () => {
    fake.reply("claude", "-p", { stdout: measuredRun("One.", 1_000, 40) });
    const old = (await say("first")).json().conversationId;

    await app.inject({ method: "POST", url: "/api/assistant/new" });
    expect((await app.inject({ url: "/api/assistant" })).json().usage).toBeUndefined();

    await app.inject({ method: "DELETE", url: `/api/assistant/threads/${old}` });
    expect(fs.readdirSync(assistantDir).filter((f) => f.startsWith(old))).toEqual([]);
  });

  it("is not read as a conversation by the thread list", async () => {
    fake.reply("claude", "-p", { stdout: measuredRun("One.", 1_000, 40) });
    await say("first");

    const threads = (await app.inject({ url: "/api/assistant/threads" })).json();
    expect(threads).toHaveLength(1);
  });
});

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
    claudeKnows(conversationId);

    fake.reset();
    await say("second");

    const [argv] = fake.argvFor("claude");
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(conversationId);
    expect(argv).not.toContain("--session-id");
  });

  it("names the conversation again when the first turn never got as far as one", async () => {
    // The thread has a reply in it, a failed one, and claude has no session:
    // resuming here failed this turn and every one after it.
    fake.reply("claude", "-p", { stderr: "Not logged in\n", code: 1 });
    await say("first");

    fake.reset();
    fake.reply("claude", "-p", { stdout: run("Here now.") });
    const thread = (await say("second")).json();

    const [argv] = fake.argvFor("claude");
    expect(argv).toContain("--session-id");
    expect(argv).not.toContain("--resume");
    expect(thread.entries.at(-1).text).toBe("Here now.");
  });

  it("takes the other flag when claude says the first was wrong", async () => {
    // Claude has the conversation and its transcript is not where this app
    // looks: the turn costs one more spawn rather than the thread.
    fake.reply("claude", "-p", {
      contains: "--session-id",
      stderr: "Error: Session ID 0a237a7d-c38f-4fc2-b6c4-c3d30d2a3d7f is already in use.\n",
      code: 1,
    });
    fake.reply("claude", "-p", { contains: "--resume", stdout: run("Picked up.") });

    const thread = (await say("hello")).json();

    const calls = fake.argvFor("claude");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--session-id");
    expect(calls[1]).toContain("--resume");
    expect(thread.entries.map((e: { text: string }) => e.text)).toEqual(["hello", "Picked up."]);
    expect(thread.entries.some((e: { failed?: boolean }) => e.failed)).toBe(false);
  });

  it("names a conversation claude has lost rather than failing to resume it", async () => {
    await say("first");
    const conversationId = (await app.inject({ url: "/api/assistant" })).json().conversationId;
    claudeKnows(conversationId);

    fake.reset();
    const gone = `No conversation found with session ID: ${conversationId}`;
    fake.reply("claude", "-p", {
      contains: "--resume",
      stderr: `${gone}\n`,
      // What the CLI prints for it: no `result`, the reason under `errors`.
      stdout:
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [gone],
        }) + "\n",
    });
    fake.reply("claude", "-p", { contains: "--session-id", stdout: run("Started over.") });
    const thread = (await say("second")).json();

    const calls = fake.argvFor("claude");
    expect(calls.map((argv) => argv.includes("--resume"))).toEqual([true, false]);
    expect(thread.entries.at(-1).text).toBe("Started over.");
    expect(thread.entries.at(-1).failed).toBeUndefined();
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
    for (const tool of ["Bash", "Edit", "Write", "Task"]) {
      expect(denied).toContain(tool);
    }
    expect(argv[argv.indexOf("--allowed-tools") + 1]).toContain("mcp__verksted");
    // Stronger than either list: this is the set that exists. It is also what
    // stops the CLI deferring tool schemas, which cost a whole ToolSearch round
    // trip per turn before the assistant could look at anything.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,WebFetch,WebSearch");
  });

  it("reads the web itself rather than asking somebody to", async () => {
    // The council is for judgement and for a subject somebody else knows
    // better, not for holding a capability the chair lacks: routing a lookup
    // through an advisor cost a call and a turn to say it had been asked, and
    // left the chair unable to answer the follow-up. What keeps this safe is
    // that a turn holds the web or the person's own things, never both — see
    // assistant-taint.ts, and the tests beside it.
    await say("hello");

    const [argv] = fake.argvFor("claude");
    const denied = argv[argv.indexOf("--disallowed-tools") + 1];
    const allowed = argv[argv.indexOf("--allowed-tools") + 1];
    for (const tool of ["WebFetch", "WebSearch"]) {
      expect(denied).not.toContain(tool);
      expect(allowed).toContain(tool);
    }
    // The browser is still the chair's alone, and an advisor's web stays
    // read-only: asked for input, not given a second way to act on it.
    expect(allowed).toContain("mcp__browser");
  });

  it("gives the assistant the verksted tools to act through", async () => {
    await say("hello");

    const [argv] = fake.argvFor("claude");
    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };

    expect(config.mcpServers.verksted.args).toEqual(["/etc/verksted/verksted-mcp.mjs"]);
  });

  it("gives the chair its own browser, booted through the backend before it connects", async () => {
    await say("hello");

    const [argv] = fake.argvFor("claude");
    expect(argv[argv.indexOf("--allowed-tools") + 1]).toContain("mcp__browser");
    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    const browserArgs = config.mcpServers.browser.args.join(" ");
    expect(browserArgs).toContain("/api/assistant/browser/start");
    expect(browserArgs).toContain('--cdp-endpoint "$VK_BROWSER_CDP"');
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

  /**
   * Norwegian, through a pipe.
   *
   * The CLI's output was decoded one chunk at a time, and a chunk is a length
   * of bytes rather than a length of text: an å whose two bytes straddled the
   * break came back as a pair of U+FFFD, one in each half. It happened at
   * whatever offset the pipe chose on the day, so it looked random — and the
   * corrupted text is stored, which means it is wrong for as long as the
   * thread exists and gets fed back to the model on every later turn.
   */
  it("does not corrupt a character that straddles two chunks of the CLI's output", async () => {
    const text = "Nei, det går fint. Blåbærsyltetøy til frokost.";
    const stdout = run(text);
    fake.reply("claude", "-p", {
      stdout,
      // One byte into the å: its second byte arrives in the next chunk.
      splitAt: Buffer.from(stdout).indexOf(Buffer.from("å")) + 1,
    });

    const thread = (await say("går det bra?")).json();

    expect(thread.entries.at(-1).text).toBe(text);
    expect(thread.entries.at(-1).text).not.toContain("�");
  });
});

describe("POST /api/assistant/messages, not waited for", () => {
  // What the chat screen sends. The socket carries the turn, and a request
  // held open for a meeting is one a proxy gives up on long before it ends.
  const ask = (text: string) =>
    app.inject({
      method: "POST",
      url: "/api/assistant/messages",
      payload: { text, wait: false },
    });
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const thread = (await app.inject({ url: "/api/assistant" })).json();
      if (thread.status === "idle") return thread;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the turn never ended");
  };

  it("answers 202 with the question on record and the turn marked as running", async () => {
    fake.reply("claude", "-p", { stdout: run("Two things need you."), delayMs: 300 });

    const res = await ask("what needs me?");

    expect(res.statusCode).toBe(202);
    const thread = res.json();
    expect(thread.status).toBe("thinking");
    expect(thread.entries.map((e: { role: string }) => e.role)).toEqual(["user"]);

    // And the answer lands in the thread, where the socket reads it from.
    expect((await settled()).entries.at(-1).text).toBe("Two things need you.");
  });

  it("still refuses a second turn at once, which is the one thing worth waiting to hear", async () => {
    fake.reply("claude", "-p", { stdout: run("first"), delayMs: 300 });

    expect((await ask("one")).statusCode).toBe(202);
    expect((await ask("two")).statusCode).toBe(409);

    await settled();
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

  it("mints one conversation however many callers ask at once", async () => {
    // The first message on a fresh bench and the poll watching for its answer
    // arrive together and both find no file. Two mints put the turn in one
    // thread and the screen on another, and the whole first exchange is
    // invisible: the transcript is written, and nothing is reading it.
    const { currentConversation } = await import("../src/assistant.js");

    const ids = await Promise.all(Array.from({ length: 8 }, () => currentConversation()));

    expect(new Set(ids).size).toBe(1);
    expect(fs.readFileSync(path.join(assistantDir, "current"), "utf8").trim()).toBe(ids[0]);
  });

  it("keeps a question and the poll watching for its answer in one thread", async () => {
    // The shape the race actually took: a GET landing while the first turn was
    // still writing came back with a conversation of its own.
    const [posted, polled] = await Promise.all([
      say("what needs me today?"),
      app.inject({ url: "/api/assistant" }),
    ]);

    expect(polled.json().conversationId).toBe(posted.json().conversationId);
    expect((await app.inject({ url: "/api/assistant" })).json().entries).toHaveLength(2);
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

  it("lists the threads, newest first, and opens an old one again", async () => {
    await say("first thread");
    const first = (await app.inject({ url: "/api/assistant" })).json().conversationId;
    await app.inject({ method: "POST", url: "/api/assistant/new" });
    await say("second thread\nwith a second line");
    // A thread nobody typed into is not worth going back to.
    await app.inject({ method: "POST", url: "/api/assistant/new" });

    const listed = (await app.inject({ url: "/api/assistant/threads" })).json();
    expect(listed.map((t: { title: string; turns: number }) => [t.title, t.turns])).toEqual([
      ["second thread", 1],
      ["first thread", 1],
    ]);

    const opened = await app.inject({
      method: "POST",
      url: `/api/assistant/threads/${first}/open`,
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().conversationId).toBe(first);
    expect(opened.json().entries[0].text).toBe("first thread");
    expect((await app.inject({ url: "/api/assistant" })).json().conversationId).toBe(first);
  });

  it("lists a meeting held when the council was a room of its own", async () => {
    // Threads written before the rooms merged carry advisors' turns; they are
    // conversations like any other now, and open the same way.
    const met = "22222222-2222-4222-8222-222222222222";
    const line = (e: object) =>
      `${JSON.stringify({ id: "x", at: "2026-01-01T00:00:00Z", ...e })}\n`;
    fs.writeFileSync(
      path.join(assistantDir, `${met}.jsonl`),
      line({ role: "user", text: "old meeting", tools: [] }) +
        line({ role: "assistant", text: "yes", tools: [], member: "michael" }),
    );

    const ids = (await app.inject({ url: "/api/assistant/threads" }))
      .json()
      .map((t: { conversationId: string }) => t.conversationId);
    expect(ids).toContain(met);
  });

  it("deletes a thread, and starts fresh when it was the open one", async () => {
    await say("keep me");
    const kept = (await app.inject({ url: "/api/assistant" })).json().conversationId;
    await app.inject({ method: "POST", url: "/api/assistant/new" });
    await say("delete me");
    const open = (await app.inject({ url: "/api/assistant" })).json().conversationId;

    const gone = await app.inject({ method: "DELETE", url: `/api/assistant/threads/${open}` });

    expect(gone.statusCode).toBe(200);
    expect(fs.existsSync(path.join(assistantDir, `${open}.jsonl`))).toBe(false);
    // The screen is never left pointing at a thread that is not there.
    const now = (await app.inject({ url: "/api/assistant" })).json();
    expect(now.conversationId).not.toBe(open);
    expect(now.entries).toEqual([]);

    expect(
      (await app.inject({ method: "DELETE", url: `/api/assistant/threads/${kept}` })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: "/api/assistant/threads" })).json()).toEqual([]);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/assistant/threads/${kept}` })).statusCode,
    ).toBe(404);
  });

  it("clears every thread but the open one, or only the old ones", async () => {
    const written = (id: string, at: string) =>
      fs.writeFileSync(
        path.join(assistantDir, `${id}.jsonl`),
        `${JSON.stringify({ id: "x", at, role: "user", text: `said ${at}`, tools: [] })}\n`,
      );
    const old = "44444444-4444-4444-8444-444444444444";
    const recent = "55555555-5555-4555-8555-555555555555";
    written(old, "2026-01-01T00:00:00.000Z");
    written(recent, new Date().toISOString());
    await say("the open one");
    const open = (await app.inject({ url: "/api/assistant" })).json().conversationId;
    const clear = (payload: object) =>
      app.inject({ method: "POST", url: "/api/assistant/threads/clear", payload });

    expect((await clear({ olderThanDays: 30 })).json()).toEqual({ deleted: 1 });
    expect(fs.existsSync(path.join(assistantDir, `${old}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(assistantDir, `${recent}.jsonl`))).toBe(true);

    expect((await clear({})).json()).toEqual({ deleted: 1 });
    const ids = (await app.inject({ url: "/api/assistant/threads" }))
      .json()
      .map((t: { conversationId: string }) => t.conversationId);
    expect(ids).toEqual([open]);
  });

  it("refuses to open a thread that is not there", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/threads/33333333-3333-4333-8333-333333333333/open",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("what it can do", () => {
  it("is read from the tool server itself, so the settings page cannot drift from it", async () => {
    const tools = (await app.inject({ url: "/api/assistant/tools" })).json();
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("status");
    expect(names).toContain("start_session");
    for (const t of tools) expect(t.description.length).toBeGreaterThan(10);
  });
});

describe("recall", () => {
  it("finds a turn from a thread that has been left behind", async () => {
    // The whole point: starting a new thread is how a long conversation is kept
    // affordable, and it must not be how something said in it is lost.
    fake.reply("claude", "-p", { stdout: run("Kargo promotes it on merge to main.") });
    await say("how does the homelab promotion work?");
    await app.inject({ method: "POST", url: "/api/assistant/new" });

    const res = await app.inject({ url: "/api/assistant/search?q=promotion" });

    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toHaveLength(1);
    expect(res.json().hits[0].text).toContain("how does the homelab promotion work?");
  });

  it("does not search the conversation it is already in", async () => {
    // A hit there would spend a result on something already in the context.
    await say("something about promotion");

    expect((await app.inject({ url: "/api/assistant/search?q=promotion" })).json().hits).toEqual(
      [],
    );
  });

  it("does not search what the machine said to itself", async () => {
    // Briefings and harvests are conversations too, and there will be hundreds
    // of them. Recall is for conversations the user had.
    fs.mkdirSync(path.join(assistantDir, "unattended"), { recursive: true });
    fs.writeFileSync(
      path.join(assistantDir, "unattended", "11111111-2222-3333-4444-555555555555.jsonl"),
      `${JSON.stringify({
        id: "x",
        role: "assistant",
        text: "ok: nothing needs you, promotion is quiet",
        tools: [],
        at: new Date().toISOString(),
      })}\n`,
    );

    expect((await app.inject({ url: "/api/assistant/search?q=promotion" })).json().hits).toEqual(
      [],
    );
  });

  it("walks past a line that parses but is not a turn, and still finds the rest", async () => {
    // `{}` is JSON, and search reads every thread there is: one such line in
    // one old file used to throw from every search, until somebody found it.
    fake.reply("claude", "-p", { stdout: run("Kargo promotes it on merge to main.") });
    await say("how does the homelab promotion work?");
    await app.inject({ method: "POST", url: "/api/assistant/new" });
    const old = fs.readdirSync(assistantDir).find((f) => f.endsWith(".jsonl"));
    fs.appendFileSync(
      path.join(assistantDir, old ?? ""),
      `{}\n${JSON.stringify({ id: "half", role: "user", at: new Date().toISOString() })}\n`,
    );

    const res = await app.inject({ url: "/api/assistant/search?q=promotion" });

    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toHaveLength(1);
  });

  it("requires every word, so a query narrows rather than widens", async () => {
    await say("the kargo promotion");
    await app.inject({ method: "POST", url: "/api/assistant/new" });

    const hits = async (q: string) =>
      (await app.inject({ url: `/api/assistant/search?q=${encodeURIComponent(q)}` })).json().hits;

    expect(await hits("kargo promotion")).toHaveLength(1);
    expect(await hits("kargo rollback")).toEqual([]);
  });
});

/**
 * The stream, over a real socket.
 *
 * `inject` cannot upgrade, so this listens on a port and connects to it. What
 * it pins is the frame protocol: a socket is sent the thread whole once, and
 * after that only the frames that carry something new carry entries at all.
 * A reply being written announces ten times a second, and the alternative is
 * a whole morning's conversation down a phone tunnel per three tokens.
 */
describe("GET /api/assistant/stream", () => {
  /**
   * Everything the socket is sent over `ms`, in order.
   *
   * Node's own WebSocket rather than the `ws` package the server runs on: it
   * is a global here, and this is the client half.
   */
  function listen(url: string, ms: number): { done: Promise<AssistantFrame[]> } {
    const got: AssistantFrame[] = [];
    const done = new Promise<AssistantFrame[]>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onerror = () => reject(new Error("the stream socket failed"));
      socket.onmessage = (e: MessageEvent) =>
        got.push(JSON.parse(String(e.data)) as AssistantFrame);
      socket.onopen = () =>
        setTimeout(() => {
          socket.close();
          resolve(got);
        }, ms);
    });
    return { done };
  }

  it("sends the thread whole once, then leaves the entries out of the frames that add none", async () => {
    // Its own instance, because `inject` cannot upgrade — and everything in
    // this test goes through it. An earlier case resets the module registry,
    // so a server built here and the `app` built in beforeAll hold two
    // different copies of the thread module, with a set of listeners each.
    const { buildApp } = await import("../src/app.js");
    const server = await buildApp({ logger: false });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.server.address() as { port: number };
    try {
      const watching = listen(`ws://127.0.0.1:${port}/api/assistant/stream`, 900);
      // Let the opening frame land before anything is announced over it.
      await new Promise((r) => setTimeout(r, 250));
      await server.inject({
        method: "POST",
        url: "/api/assistant/messages",
        payload: { text: "what needs me today?" },
      });

      const frames = await watching.done;

      // A turn announces several times: the user entry, the spawn, the reply,
      // the end. Only the ones that appended something carry entries.
      expect(frames.length).toBeGreaterThan(2);
      expect(frames[0].entries).toBeDefined();
      expect(frames.some((f) => f.entries === undefined)).toBe(true);

      // Every frame that does carry them carries the whole list, so a client
      // that replaces rather than appends is always right.
      const last = frames.filter((f) => f.entries).at(-1)!;
      expect(last.entries!.map((e) => e.text)).toEqual([
        "what needs me today?",
        "Two things need you.",
      ]);
      expect(frames.at(-1)!.conversationId).toBe(frames[0].conversationId);
    } finally {
      await server.close();
    }
  });
});
