import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SessionChat } from "../../shared/api.js";

/**
 * Reading a session back as a conversation.
 *
 * Three things are worth pinning here. The first is what never rides the poll:
 * a tool's output is the bulk of a transcript and the reason a terminal is hard
 * to read, so the chip carries an id and the output is fetched only if somebody
 * asks for it. If output starts arriving here, the chat view has become the
 * thing it replaced.
 *
 * The second is that the CLI writes a great deal beside the conversation, and
 * most of it is bookkeeping. What earns a rail is what a person would go
 * looking for later — a mode change, a slash command, a PR, an interruption —
 * and everything else is dropped, including entry types that do not exist yet.
 *
 * The third is the tail window. It is what keeps this cheap on a five-megabyte
 * transcript, and it necessarily starts mid-line, so the torn first line has to
 * be dropped rather than parsed. Its awkward corner is the entries the CLI
 * writes with no uuid and no timestamp at all: they have to borrow both, and
 * borrow the same ones every time the window moves.
 */

let chat: typeof import("../src/chat.js");
let app: FastifyInstance;
let home: string;
let reposDir: string;
let sessionsDir: string;

const CONV = "3c4cde47-7829-4754-add9-ad19f99b80a3";
const SESSION = "vk-demo-1";

let clock = Date.parse("2026-01-01T00:00:00.000Z");
/** Distinct, increasing timestamps, because `since` compares them. */
function stamp(): string {
  clock += 1_000;
  return new Date(clock).toISOString();
}

let uuids = 0;
function human(text: string): string {
  return JSON.stringify({
    type: "user",
    uuid: `u${++uuids}`,
    timestamp: stamp(),
    message: { role: "user", content: text },
    origin: { kind: "human" },
    isSidechain: false,
  });
}

function says(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `a${++uuids}`,
    timestamp: stamp(),
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  });
}

function calls(name: string, input: Record<string, unknown>, id: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `t${++uuids}`,
    timestamp: stamp(),
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

function result(id: string, content: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    uuid: `r${++uuids}`,
    timestamp: stamp(),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
  });
}

/** An entry the CLI writes with no uuid and no timestamp of its own. */
function bare(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...fields });
}

function attach(type: string, body: Record<string, unknown>): string {
  return JSON.stringify({
    type: "attachment",
    uuid: `at${++uuids}`,
    timestamp: stamp(),
    attachment: { type, ...body },
  });
}

function transcriptDir(project: string): string {
  const dir = path.join(home, ".claude", "projects", `${reposDir}/${project}`.replace(/\//g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTranscript(project: string, lines: string[]): void {
  fs.writeFileSync(path.join(transcriptDir(project), `${CONV}.jsonl`), lines.join("\n") + "\n");
}

beforeAll(async () => {
  reposDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-")));
  fs.mkdirSync(path.join(reposDir, "demo"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "vk-home-"));
  process.env.HOME = home;
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.STATIC_DIR = "";
  process.env.SETTINGS_FILE = path.join(sessionsDir, "settings.json");

  fs.writeFileSync(
    path.join(sessionsDir, `${SESSION}.json`),
    JSON.stringify({
      id: SESSION,
      project: "demo",
      agent: "claude",
      title: "demo",
      createdAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T01:00:00.000Z",
    }),
  );
  fs.writeFileSync(path.join(sessionsDir, `${SESSION}.conv`), CONV);
  // A session whose agent never wrote a transcript, which is every agent that
  // is not claude and every session in its first seconds.
  fs.writeFileSync(
    path.join(sessionsDir, "vk-demo-2.json"),
    JSON.stringify({
      id: "vk-demo-2",
      project: "demo",
      agent: "codex",
      title: "codex",
      createdAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T01:00:00.000Z",
    }),
  );

  chat = await import("../src/chat.js");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("parseTranscript", () => {
  it("reads a turn as a question and an answer", () => {
    const { messages } = chat.parseTranscript(
      [human("does the build pass?"), says("It does.")].join("\n"),
    );
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "does the build pass?"],
      ["assistant", "It does."],
    ]);
  });

  it("keeps the tool call and drops what it printed", () => {
    const { messages } = chat.parseTranscript(
      [
        human("run the tests"),
        calls("Bash", { command: "make test", description: "run tests" }, "t1"),
        result("t1", "a".repeat(50_000)),
        says("All green."),
      ].join("\n"),
    );
    const reply = messages.at(-1)!;
    expect(reply.text).toBe("All green.");
    expect(reply.tools).toEqual([{ id: "t1", name: "Bash", detail: "make test" }]);
    // The whole reason this view exists: the 50kB of output is not in it.
    expect(JSON.stringify(messages)).not.toContain("aaaa");
  });

  it("marks the chip whose result came back an error", () => {
    const { messages } = chat.parseTranscript(
      [
        calls("Bash", { command: "make lint" }, "t1"),
        calls("Read", { file_path: "/tmp/x" }, "t2"),
        result("t1", "boom", true),
        result("t2", "fine"),
        says("Lint is broken."),
      ].join("\n"),
    );
    expect(messages.at(-1)!.tools).toEqual([
      { id: "t1", name: "Bash", detail: "make lint", failed: true },
      { id: "t2", name: "Read", detail: "/tmp/x" },
    ]);
  });

  // The CLI writes a thinking block with an empty body and a signature, so
  // there is nothing to show even if we wanted to. This pins that we do not
  // invent a turn out of one.
  it("leaves out thinking, which is not written down anyway", () => {
    const thinks = JSON.stringify({
      type: "assistant",
      uuid: "th1",
      timestamp: stamp(),
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "a secret plan", signature: "sig" }],
      },
    });
    const { messages } = chat.parseTranscript([human("hi"), thinks, says("Hello.")].join("\n"));
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain("secret plan");
  });

  it("leaves out a subagent's conversation", () => {
    const side = JSON.stringify({
      type: "assistant",
      uuid: "s1",
      timestamp: stamp(),
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] },
    });
    const { messages } = chat.parseTranscript([human("go"), side, says("Done.")].join("\n"));
    expect(messages.map((m) => m.text)).toEqual(["go", "Done."]);
  });

  it("reports work in flight rather than hiding it until the reply", () => {
    const { messages, pending } = chat.parseTranscript(
      [human("fix it"), says("Looking."), calls("Edit", { file_path: "src/a.ts" }, "t1")].join(
        "\n",
      ),
    );
    expect(messages.at(-1)!.text).toBe("Looking.");
    expect(pending).toEqual([{ id: "t1", name: "Edit", detail: "src/a.ts" }]);
  });

  it("puts what it was doing before the person who interrupted it", () => {
    const { messages } = chat.parseTranscript(
      [calls("Bash", { command: "sleep 30" }, "t1"), human("stop")].join("\n"),
    );
    expect(messages.map((m) => [m.role, m.text, m.tools.length])).toEqual([
      ["assistant", "", 1],
      ["user", "stop", 0],
    ]);
  });

  it("ignores a torn line without losing the rest", () => {
    const { messages } = chat.parseTranscript(
      ['{"type":"assistant","message":{"role":"assis', says("still here")].join("\n"),
    );
    expect(messages.map((m) => m.text)).toEqual(["still here"]);
  });

  it("skips a tool result that belongs to a call outside the window", () => {
    const { messages, pending } = chat.parseTranscript(
      [result("gone", "boom", true), says("ok")].join("\n"),
    );
    expect(messages.at(-1)!.tools).toEqual([]);
    expect(pending).toEqual([]);
  });

  // The regression that would ruin the view: a slash command arrives wearing
  // the person's role, and rendered as one it is a bubble full of XML.
  it("draws a slash command as a rail, never as something the person said", () => {
    const slash = JSON.stringify({
      type: "user",
      uuid: "c1",
      timestamp: stamp(),
      message: {
        role: "user",
        content:
          "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>",
      },
    });
    const { messages } = chat.parseTranscript([slash, says("Cleared.")].join("\n"));
    expect(messages.map((m) => [m.role, m.event ?? "", m.text])).toEqual([
      ["event", "command", "/clear"],
      ["assistant", "", "Cleared."],
    ]);
    expect(JSON.stringify(messages)).not.toContain("command-name");
  });

  it("still reads a typed turn that carries no origin at all", () => {
    const old = JSON.stringify({
      type: "user",
      uuid: "o1",
      timestamp: stamp(),
      message: { role: "user", content: "call repo_status and say one word" },
    });
    const { messages } = chat.parseTranscript([old].join("\n"));
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "call repo_status and say one word"],
    ]);
  });

  it("drops the scaffolding that wears the person's role", () => {
    const meta = JSON.stringify({
      type: "user",
      uuid: "m1",
      timestamp: stamp(),
      isMeta: true,
      message: { role: "user", content: "Caveat: the messages below were generated" },
    });
    const notification = JSON.stringify({
      type: "user",
      uuid: "n1",
      timestamp: stamp(),
      origin: { kind: "task-notification" },
      message: { role: "user", content: "an agent finished" },
    });
    const { messages } = chat.parseTranscript([meta, notification, says("ok")].join("\n"));
    expect(messages.map((m) => m.text)).toEqual(["ok"]);
  });

  it("rails a mode change, but not the mode it was already in", () => {
    const { messages, permissionMode } = chat.parseTranscript(
      [
        human("go"),
        bare("permission-mode", { permissionMode: "default" }),
        bare("permission-mode", { permissionMode: "default" }),
        bare("permission-mode", { permissionMode: "auto" }),
        says("done"),
      ].join("\n"),
    );
    // The first value seen is the state, not a change somebody made — railing it
    // would be a lie on every reconnect and every widening of the window.
    expect(messages.filter((m) => m.event === "mode").map((m) => m.text)).toEqual(["auto mode"]);
    expect(permissionMode).toBe("auto");
  });

  it("gives a uuid-less entry an id that does not move between polls", () => {
    const lines = [
      human("ship it"),
      bare("permission-mode", { permissionMode: "default" }),
      bare("permission-mode", { permissionMode: "auto" }),
      bare("pr-link", { prUrl: "https://example.test/pull/7", prNumber: 7, timestamp: stamp() }),
    ].join("\n");
    const first = chat.parseTranscript(lines).messages.map((m) => m.id);
    const again = chat.parseTranscript(lines).messages.map((m) => m.id);
    expect(again).toEqual(first);
    // Borrowed from the entry before it, so `since` can still reach it.
    const rails = chat.parseTranscript(lines).messages.filter((m) => m.role === "event");
    expect(rails.every((m) => m.at)).toBe(true);
    expect(rails.map((m) => m.event)).toEqual(["mode", "pr"]);
    expect(rails.at(-1)!.href).toBe("https://example.test/pull/7");
    expect(rails.at(-1)!.text).toBe("#7");
  });

  it("rails a pull request once, however often the CLI restates it", () => {
    const link = (n: number) =>
      bare("pr-link", { prUrl: `https://example.test/pull/${n}`, prNumber: n, timestamp: stamp() });
    const { messages } = chat.parseTranscript(
      [human("open it"), link(66), link(66), link(66), link(67)].join("\n"),
    );
    expect(messages.filter((m) => m.event === "pr").map((m) => m.text)).toEqual(["#66", "#67"]);
  });

  it("takes the checklist as state, whole, from the newest one it saw", () => {
    const { todos } = chat.parseTranscript(
      [
        attach("task_reminder", { content: [{ subject: "first", status: "completed" }] }),
        attach("task_reminder", {
          content: [
            { subject: "wire the parser", status: "completed" },
            { subject: "draw the rails", status: "in_progress" },
            { subject: "write it up", status: "pending" },
          ],
        }),
      ].join("\n"),
    );
    expect(todos).toEqual([
      { subject: "wire the parser", status: "completed" },
      { subject: "draw the rails", status: "in_progress" },
      { subject: "write it up", status: "pending" },
    ]);
  });

  it("rails a prompt typed while it was busy, and an interruption", () => {
    const interrupted = JSON.stringify({
      type: "user",
      uuid: "i1",
      timestamp: stamp(),
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
    });
    const { messages } = chat.parseTranscript(
      [
        calls("Bash", { command: "sleep 300" }, "t1"),
        attach("queued_command", { prompt: "actually, stop" }),
        interrupted,
      ].join("\n"),
    );
    expect(messages.filter((m) => m.role === "event").map((m) => [m.event, m.text])).toEqual([
      ["queued", "actually, stop"],
      ["interrupted", "you interrupted it"],
    ]);
    // What it was doing still belongs before the thing that stopped it.
    expect(messages[0].tools).toHaveLength(1);
  });

  it("says how long a turn took, and reports a hook that failed", () => {
    const { messages } = chat.parseTranscript(
      [
        says("done"),
        JSON.stringify({
          type: "system",
          uuid: "s1",
          timestamp: stamp(),
          subtype: "turn_duration",
          durationMs: 81_000,
        }),
        JSON.stringify({
          type: "system",
          uuid: "s2",
          timestamp: stamp(),
          subtype: "stop_hook_summary",
          hookErrors: ["boom"],
        }),
      ].join("\n"),
    );
    expect(messages.filter((m) => m.role === "event").map((m) => [m.event, m.text])).toEqual([
      ["duration", "1m 21s"],
      ["hook", "a stop hook reported an error"],
    ]);
  });

  it("ignores an entry type it has never heard of, and the noise it knows", () => {
    const { messages } = chat.parseTranscript(
      [
        bare("atis-latch", { whatever: true }),
        bare("ai-title", { aiTitle: "a title" }),
        bare("last-prompt", { lastPrompt: "a prompt" }),
        bare("mode", { mode: "normal" }),
        attach("total_tokens_reminder", { content: "you have used 40k tokens" }),
        says("still here"),
      ].join("\n"),
    );
    expect(messages.map((m) => m.text)).toEqual(["still here"]);
  });
});

describe("readChat", () => {
  it("says there is nothing to read when no transcript exists", async () => {
    expect(await chat.readChat(null, null)).toEqual({
      conversationId: null,
      messages: [],
      pending: [],
      truncated: false,
      todos: [],
      permissionMode: "",
    });
  });

  it("treats a transcript that is not there as empty, not as an error", async () => {
    const missing = path.join(home, "nope", `${CONV}.jsonl`);
    expect((await chat.readChat(missing, CONV)).messages).toEqual([]);
  });

  it("reads only the tail of a long transcript, and says so", async () => {
    writeTranscript("demo", [
      ...Array.from({ length: 400 }, (_, i) => says(`old line ${i} ${"x".repeat(2_000)}`)),
      human("the last question"),
      says("the last answer"),
    ]);
    const file = path.join(transcriptDir("demo"), `${CONV}.jsonl`);
    const windowed = await chat.readChat(file, CONV, { bytes: 20_000 });
    expect(windowed.truncated).toBe(true);
    expect(windowed.messages.at(-1)!.text).toBe("the last answer");
    expect(windowed.messages.length).toBeLessThan(50);
    // Widening it reaches the start, and then it stops claiming to be cut off.
    const whole = await chat.readChat(file, CONV, { bytes: chat.MAX_WINDOW });
    expect(whole.truncated).toBe(false);
    expect(whole.messages.length).toBeGreaterThan(400);
  });

  it("returns only what the caller has not got", async () => {
    writeTranscript("demo", [human("first"), says("second"), human("third")]);
    const file = path.join(transcriptDir("demo"), `${CONV}.jsonl`);
    const all = await chat.readChat(file, CONV);
    expect(all.messages).toHaveLength(3);
    const rest = await chat.readChat(file, CONV, { since: all.messages[1].at });
    expect(rest.messages.map((m) => m.text)).toEqual(["second", "third"]);
    // Inclusive on purpose: the turn the caller already holds comes back, so a
    // second turn written in the same millisecond can never be skipped. The
    // caller drops the repeat by id.
    const caught = await chat.readChat(file, CONV, { since: all.messages.at(-1)!.at });
    expect(caught.messages.map((m) => m.text)).toEqual(["third"]);
  });
});

describe("GET /api/sessions/:id/chat", () => {
  it("reads an ended session back, long after its terminal is gone", async () => {
    writeTranscript("demo", [
      human("what did you do?"),
      calls("Bash", { command: "git commit" }, "t1"),
      result("t1", "1 file changed"),
      says("Committed it."),
    ]);
    const res = await app.inject({ url: `/api/sessions/${SESSION}/chat` });
    expect(res.statusCode).toBe(200);
    const body: SessionChat = res.json();
    expect(body.conversationId).toBe(CONV);
    expect(body.messages.map((m) => m.text)).toEqual(["what did you do?", "Committed it."]);
    expect(body.messages.at(-1)!.tools[0].detail).toBe("git commit");
  });

  it("answers empty for an agent that writes no transcript", async () => {
    const res = await app.inject({ url: "/api/sessions/vk-demo-2/chat" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      conversationId: null,
      messages: [],
      pending: [],
      truncated: false,
      todos: [],
      permissionMode: "",
    });
  });

  it("404s an unknown session", async () => {
    const res = await app.inject({ url: "/api/sessions/vk-demo-99/chat" });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a window larger than the ceiling", async () => {
    const res = await app.inject({
      url: `/api/sessions/${SESSION}/chat?bytes=${chat.MAX_WINDOW + 1}`,
    });
    expect(res.statusCode).toBe(400);
  });
});
