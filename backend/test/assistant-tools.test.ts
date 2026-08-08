import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The assistant's MCP server, driven the way the CLI drives it: JSON-RPC over
 * stdio, against a stub standing in for the backend.
 *
 * It is a runtime file rather than part of the backend build, so nothing else
 * here would notice it breaking. What is pinned below is not the formatting —
 * that changes freely — but the four properties that are load-bearing and would
 * regress in silence: which tools exist at all, and the three request shapes
 * that carry a safety decision.
 */
const SERVER = path.resolve(import.meta.dirname, "../../runtime/verksted-mcp.mjs");

interface Seen {
  method: string;
  url: string;
  body: string;
}

let stub: http.Server;
let seen: Seen[] = [];
let api: string;

/** Canned replies keyed by "METHOD /path"; anything else answers null. */
const REPLIES: Record<string, unknown> = {
  "DELETE /api/sessions/vk-demo-1": { id: "vk-demo-1", report: "ok: done" },
  "PUT /api/settings": { schedulesPaused: true },
  "POST /api/projects/demo/sessions": { id: "vk-demo-2", agent: "claude", project: "demo" },
};

/** One JSON-RPC round trip, with a fresh process each time. */
function rpc(request: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, VK_API: api },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => {
      const line = out.split("\n").find(Boolean);
      if (!line) return reject(new Error("no reply"));
      resolve(JSON.parse(line));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

const callTool = (name: string, args: object = {}) =>
  rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      const key = `${req.method} ${(req.url ?? "").split("?")[0]}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(REPLIES[key] ?? null));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const addr = stub.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  api = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("the tool set", () => {
  it("offers exactly the tools the assistant is meant to have", async () => {
    const res = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    };

    // Sorted so the assertion does not depend on the order they are declared in.
    expect(res.result.tools.map((t) => t.name).sort()).toEqual(
      [
        "ci_log",
        "ci_rerun",
        "ci_runs",
        "create_schedule",
        "delete_schedule",
        "end_session",
        "forget",
        "list_memories",
        "list_prs",
        "list_schedules",
        "merge_pr",
        "notify",
        "pause_schedules",
        "pr_detail",
        "read_session_output",
        "remember",
        "repo_diff",
        "repo_status",
        "run_schedule",
        "start_session",
        "status",
        "update_schedule",
      ].sort(),
    );
  });

  it("names no tool that writes to a repo", async () => {
    const res = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    };

    // The invariant the whole agent rests on: changing a repo happens in a
    // session with a terminal, never through a tool here.
    const names = res.result.tools.map((t) => t.name).join(" ");
    for (const forbidden of ["commit", "discard", "reset", "stage", "checkout", "write", "file"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });
});

describe("requests that carry a safety decision", () => {
  it("pauses schedules without touching the agent env vars beside them", async () => {
    // PUT /api/settings also carries `vars`. Sending the one flag is what keeps
    // this tool from being a way to rewrite credentials.
    seen = [];

    await callTool("pause_schedules", { paused: true });

    const put = seen.find((r) => r.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(put!.body)).toEqual({ schedulesPaused: true });
  });

  it("reads the pause state without writing anything", async () => {
    seen = [];

    await callTool("pause_schedules");

    expect(seen.map((r) => r.method)).toEqual(["GET"]);
  });

  it("ends a session without purging it from history", async () => {
    // purge=1 would delete the metadata file the inbox and run history read.
    seen = [];

    await callTool("end_session", { id: "vk-demo-1" });

    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].url).toBe("/api/sessions/vk-demo-1");
    expect(seen[0].url).not.toContain("purge");
  });

  it("starts delegated sessions in auto permission mode", async () => {
    // Nobody is attached to a session the assistant started; without this it
    // stalls on its first tool call and looks stuck.
    seen = [];

    await callTool("start_session", { project: "demo", agent: "claude", prompt: "look around" });

    expect(JSON.parse(seen[0].body)).toMatchObject({
      agent: "claude",
      prompt: "look around",
      autoPermissions: true,
    });
  });

  it("pushes a notification through the endpoint that vets the link", async () => {
    // The tool must not gain its own way to the push service: the tap target is
    // restricted to a path inside the app, and that check lives on the route.
    seen = [];

    await callTool("notify", { body: "the nightly run failed", url: "/inbox" });

    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/api/push/send");
    expect(JSON.parse(seen[0].body)).toEqual({ body: "the nightly run failed", url: "/inbox" });
  });

  it("reads a diff without a path that could climb out of the repo", async () => {
    seen = [];

    await callTool("repo_diff", { project: "demo", path: "../../etc/passwd" });

    // Encoded, not interpolated raw; the route's own realpath check is what
    // actually refuses it, and this keeps the request arriving in one piece.
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/api/projects/demo/diff?path=..%2F..%2Fetc%2Fpasswd");
  });
});
