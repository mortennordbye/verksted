import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SessionChat } from "../../shared/api.js";

/**
 * Reading a session back as a conversation.
 *
 * Two things are worth pinning here. The first is what never comes out: tool
 * results, thinking, and a subagent's turns are the bulk of a transcript and
 * the reason a terminal is hard to read — if any of them start appearing, the
 * chat view has become the thing it replaced.
 *
 * The second is the tail window. It is what keeps this cheap on a five-megabyte
 * transcript, and it necessarily starts mid-line, so the torn first line has to
 * be dropped rather than parsed.
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
    expect(reply.tools).toEqual([{ name: "Bash", detail: "make test" }]);
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
      { name: "Bash", detail: "make lint", failed: true },
      { name: "Read", detail: "/tmp/x" },
    ]);
  });

  it("leaves out thinking", () => {
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
    expect(pending).toEqual([{ name: "Edit", detail: "src/a.ts" }]);
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
});

describe("readChat", () => {
  it("says there is nothing to read when no transcript exists", async () => {
    expect(await chat.readChat(null, null)).toEqual({
      conversationId: null,
      messages: [],
      pending: [],
      truncated: false,
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
