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

const TOOLS = [
  {
    name: "list_projects",
    description:
      "Every repo on the workbench, with its branch and how many sessions are running, waiting or done.",
    inputSchema: { type: "object", properties: {} },
    run: () => call("GET", "/api/projects"),
  },
  {
    name: "list_sessions",
    description:
      "Agent sessions across every project: which are running, which are waiting for input, and the one-line verdict each finished one wrote about itself.",
    inputSchema: { type: "object", properties: {} },
    run: () => call("GET", "/api/sessions"),
  },
  {
    name: "list_runs",
    description: "What the scheduled runs did while nobody was watching (the inbox).",
    inputSchema: { type: "object", properties: {} },
    run: () => call("GET", "/api/runs"),
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
      call("GET", `/api/sessions/${encodeURIComponent(a.id)}/capture?lines=${a.lines ?? 40}`),
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
      }),
  },
  {
    name: "list_memories",
    description: "Everything currently remembered about how this person works.",
    inputSchema: { type: "object", properties: {} },
    run: () => call("GET", "/api/memory"),
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
      }),
  },
  {
    name: "forget",
    description: "Delete a remembered fact that is wrong or no longer true.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
    run: (a) => call("DELETE", `/api/memory/${encodeURIComponent(a.slug)}`),
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
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
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
