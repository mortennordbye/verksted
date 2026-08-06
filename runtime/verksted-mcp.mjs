#!/usr/bin/env node
// The assistant's tools: what it may do to this workbench, and nothing else.
//
// An MCP server over stdio, speaking JSON-RPC to the CLI and plain HTTP to the
// backend on loopback. Hand-rolled rather than built on the MCP SDK, which is a
// deliberate exception to this repo's "prefer a library" rule: the surface used
// here is three methods, and a dependency would have to resolve from
// node_modules at a path that differs between the tsx dev process and the built
// image. A file baked into the image is the same file in both.
//
// This exists so the assistant does not need Bash. Everything that changes the
// world either goes through a validated endpoint here, or happens in a project
// session a person can watch — which is the point: the assistant delegates the
// work, it does not do it.
import { createInterface } from "node:readline";

const API = process.env.VK_API ?? "http://127.0.0.1:8080";

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Tool results are not read once and dropped: they stay in the conversation and
// are re-sent with every later turn. Pretty-printed JSON of every field is
// therefore a cost paid over and over for the rest of the thread, so each tool
// answers in the fewest lines that still carry the decision. Raw JSON is one
// `read_session_output` away when something genuinely needs it.
const rows = (items, line) => (items.length ? items.map(line).join("\n") : "(none)");

const TOOLS = [
  {
    name: "status",
    description:
      "The whole workbench in one call: every repo, every session and what the scheduled runs did. Use this first for anything like 'what needs me' or 'what is running' — it answers in one round trip what three separate lookups would take three.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      // One tool rather than three, because each tool call is another model
      // invocation carrying the entire conversation with it. Round trips cost
      // far more than the handful of lines saved by asking narrowly.
      const [projects, sessions, runs] = await Promise.all([
        call("GET", "/api/projects"),
        call("GET", "/api/sessions"),
        call("GET", "/api/runs"),
      ]);
      const live = sessions.filter((s) => s.status !== "done");
      return [
        "PROJECTS",
        rows(
          projects,
          (p) =>
            `${p.name}  ${p.branch}${p.dirty ? "  dirty" : ""}  ` +
            `${p.running} running, ${p.waiting} waiting` +
            `${p.worktreeOf ? `  (worktree of ${p.worktreeOf})` : ""}`,
        ),
        "",
        "LIVE SESSIONS",
        rows(live, (s) => `${s.id}  ${s.agent}  ${s.status}  ${s.title}`),
        "",
        // Finished sessions matter only for what they concluded, and only
        // recently: the rest is history the user can open the inbox for.
        "RECENTLY FINISHED",
        rows(
          sessions.filter((s) => s.status === "done" && s.report).slice(0, 8),
          (s) => `${s.id}  ${s.outcome}  "${s.report}"`,
        ),
        "",
        "SCHEDULED RUNS",
        rows(
          runs.slice(0, 8),
          (r) =>
            `${r.at?.slice(0, 16) ?? "?"}  ${r.scheduleName ?? r.scheduleId}  ${r.outcome}` +
            `${r.error ? `  ${r.error}` : ""}${r.report ? `  "${r.report}"` : ""}`,
        ),
      ].join("\n");
    },
  },
  {
    name: "read_session_output",
    description:
      "The last lines a live session printed. Use this to answer 'what is it doing' or 'why did it stop' without attaching a terminal.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, lines: { type: "number" } },
      required: ["id"],
    },
    run: (a) =>
      call("GET", `/api/sessions/${encodeURIComponent(a.id)}/capture?lines=${a.lines ?? 40}`).then(
        (r) => (r.live ? r.text : "that session has ended"),
      ),
  },
  {
    name: "start_session",
    description:
      "Start an agent session in a project, optionally with a first prompt. This is how you do work that changes anything: you cannot edit files or run commands yourself, so delegate it to a session the user can watch, then say which session you started.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        agent: { type: "string", enum: ["claude", "antigravity", "codex"] },
        title: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["project", "agent"],
    },
    run: (a) =>
      call("POST", `/api/projects/${encodeURIComponent(a.project)}/sessions`, {
        agent: a.agent,
        ...(a.title ? { title: a.title } : {}),
        ...(a.prompt ? { prompt: a.prompt } : {}),
      }).then((s) => `started ${s.id} (${s.agent}) in ${s.project}`),
  },
  {
    name: "list_memories",
    description: "Everything currently remembered about how this person works.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const { memories, used, budget } = await call("GET", "/api/memory");
      return `${rows(memories, (m) => `${m.slug}  [${m.type}/${m.scope}]  ${m.text}`)}\n\n${used} of ${budget} bytes used`;
    },
  },
  {
    name: "remember",
    description:
      "Record one durable fact about how this person works, carried into every future session in every repo. Say what you are about to record and ask first. Keep it to a sentence or two, written as an instruction to a future agent.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "short-kebab-case name, also the filename" },
        text: { type: "string" },
        type: { type: "string", enum: ["preference", "project", "reference"] },
        scope: { type: "string", description: "'global', or a project name" },
        source: { type: "string", description: "how you learned it" },
      },
      required: ["slug", "text"],
    },
    run: (a) =>
      call("PUT", `/api/memory/${encodeURIComponent(a.slug)}`, {
        text: a.text,
        ...(a.type ? { type: a.type } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
        ...(a.source ? { source: a.source } : {}),
      }).then((m) => `remembered ${m.slug}`),
  },
  {
    name: "forget",
    description: "Delete a remembered fact that is wrong or no longer true.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
    run: (a) =>
      call("DELETE", `/api/memory/${encodeURIComponent(a.slug)}`).then(() => `forgot ${a.slug}`),
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(msg) {
  // Notifications carry no id and expect no reply.
  if (msg.id === undefined) return;

  if (msg.method === "initialize") {
    // Echo the client's protocol version rather than pinning one: this server
    // uses nothing version-specific, and disagreeing would fail the handshake.
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "verksted", version: "1" },
      },
    });
  }

  if (msg.method === "tools/list") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      },
    });
  }

  if (msg.method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `no such tool: ${msg.params?.name}` },
      });
    }
    try {
      const result = await tool.run(msg.params.arguments ?? {});
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: typeof result === "string" ? result : JSON.stringify(result) },
          ],
        },
      });
    } catch (err) {
      // isError rather than a JSON-RPC error: the model should see what went
      // wrong and be able to try something else, not have the turn fail.
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `failed: ${err.message}` }], isError: true },
      });
    }
  }

  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  void handle(msg);
});
