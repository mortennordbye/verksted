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
  "POST /api/proposals": { id: "proposal:1", title: "a card" },
  "POST /api/council": {
    id: "ledger",
    name: "Ledger",
    remit: "what this bench costs",
    face: "bear",
    colour: "rose",
    tools: ["status"],
    web: false,
  },
};

/** One JSON-RPC round trip, with a fresh process each time. */
function rpc(request: object, env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, VK_API: api, ...env },
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

/** What the backend sets for a turn a schedule fired, with nobody reading. */
const VK_UNATTENDED = { VK_UNATTENDED: "1" };

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
        "brief_material",
        "calendar_search",
        "calendar_today",
        "calendar_upcoming",
        "ci_log",
        "ci_rerun",
        "ci_runs",
        "close_loop",
        "cluster_status",
        "council_add",
        "feed",
        "feed_done",
        "create_schedule",
        "delete_schedule",
        "desk_session",
        "end_session",
        "forget",
        "list_memories",
        "list_prs",
        "list_schedules",
        "loops",
        "merge_pr",
        "notify",
        "open_loop",
        "pause_schedules",
        "person_note",
        "pr_detail",
        "propose",
        "propose_memory",
        "read_session_output",
        "recall",
        "recent_prompts",
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

  it("offers the mail to an advisor and never to the chair", async () => {
    // Mail is text written by strangers, which is the shape a prompt
    // injection takes, and the chair holds every tool that acts. So the mail
    // tools exist only in a process started for a member.
    const names = async (env: Record<string, string>) => {
      const res = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, env)) as {
        result: { tools: { name: string }[] };
      };
      return res.result.tools.map((t) => t.name);
    };
    expect(await names({})).not.toContain("mail_read");
    expect(await names({})).not.toContain("docs_read");
    expect(await names({ VK_MEMBER: "uriel", VK_TOOLS: "mail_read,status" })).toEqual([
      "status",
      "mail_read",
    ]);
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

  it("offers nothing that changes anything when nobody is reading", async () => {
    // A schedule fires this server with VK_UNATTENDED set. The point of cutting
    // the tools here rather than in an allow list is that they are absent from
    // tools/list — under --permission-mode auto an unlisted tool still exists
    // and is still a classifier's call, but one that was never offered is not.
    const res = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, VK_UNATTENDED)) as {
      result: { tools: { name: string }[] };
    };

    expect(res.result.tools.map((t) => t.name).sort()).toEqual(
      [
        "brief_material",
        "calendar_search",
        "calendar_today",
        "calendar_upcoming",
        "ci_log",
        "ci_runs",
        "feed",
        // Read-only, and the cluster is exactly the thing an unwatched run needs
        // to see: a scheduled deploy check has no one to ask.
        "cluster_status",
        "list_memories",
        "list_prs",
        "list_schedules",
        "loops",
        "notify",
        "pr_detail",
        // Writes to the review queue, never to memory — which is exactly why it
        // is the one write an unwatched turn may do.
        "propose_memory",
        "read_session_output",
        "recall",
        "recent_prompts",
        "repo_diff",
        "repo_status",
        "status",
      ].sort(),
    );
  });

  it("cannot remember anything unwatched, only propose", async () => {
    // The gate the whole harvest rests on: a turn nobody read must not be able
    // to put a fact into every future session without a person keeping it.
    const res = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, VK_UNATTENDED)) as {
      result: { tools: { name: string }[] };
    };

    const names = res.result.tools.map((t) => t.name);
    expect(names).not.toContain("remember");
    expect(names).not.toContain("forget");
    expect(names).toContain("propose_memory");
  });

  it("refuses to run a tool it did not offer, rather than only hiding it", async () => {
    // tools/list and tools/call must agree: a model that knows the name from an
    // earlier turn, or guesses it, must not get through anyway.
    const res = (await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start_session" } },
      VK_UNATTENDED,
    )) as { error?: { message: string } };

    expect(res.error?.message).toContain("no such tool");
  });
});

/**
 * VK_TOOLS is how one advisor on the council is narrowed. --allowed-tools can
 * only name the whole server, so this is the only place a member's reach can
 * actually be cut — and the property that matters is not the list, it is that
 * list and call agree about it.
 */
describe("one advisor's tools", () => {
  const list = async (env: Record<string, string>) => {
    const res = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, env)) as {
      result: { tools: { name: string }[] };
    };
    return res.result.tools.map((t) => t.name);
  };

  it("offers exactly what VK_TOOLS names", async () => {
    expect(await list({ VK_TOOLS: "status,cluster_status" })).toEqual(["status", "cluster_status"]);
  });

  it("refuses to run a tool it did not offer that member", async () => {
    const res = (await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "merge_pr" } },
      { VK_TOOLS: "status,cluster_status" },
    )) as { error?: { message: string } };

    expect(res.error?.message).toContain("no such tool");
  });

  it("intersects with the unattended filter rather than overriding it", async () => {
    // A member named in VK_TOOLS whose schedule fired still loses everything
    // that changes something. Two filters, both of which have to say yes.
    const names = await list({ VK_TOOLS: "status,merge_pr", VK_UNATTENDED: "1" });

    expect(names).toContain("status");
    expect(names).not.toContain("merge_pr");
  });

  it("ignores a name that is not a tool", async () => {
    // A filter, not a contract. The typo is caught when the member is saved,
    // which is where somebody can see it; here it must not take the run down.
    expect(await list({ VK_TOOLS: "status,not_a_tool" })).toEqual(["status"]);
  });

  it("writes an advisor's memory to its own store, not the bench's", async () => {
    // The whole difference between a member holding `remember` and the chair
    // holding it: one writes a note nothing else reads, the other writes into
    // every session in every repo.
    seen = [];
    await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "remember", arguments: { slug: "dentist", text: "Thursday." } },
      },
      { VK_MEMBER: "uriel", VK_TOOLS: "remember" },
    );

    expect(seen[0]?.url).toBe("/api/council/uriel/memory/dentist");
  });

  it("does not let a tool argument decide whose memory is written", async () => {
    // The id comes from the environment. A model that names somebody else, or
    // asks for a project scope, changes nothing about where this lands.
    seen = [];
    await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: { slug: "x", text: "y", scope: "Homelab", member: "chair" },
        },
      },
      { VK_MEMBER: "uriel", VK_TOOLS: "remember" },
    );

    expect(seen[0]?.url).toBe("/api/council/uriel/memory/x");
    expect(seen[0]?.body).not.toContain("Homelab");
  });

  it("adds a council member as the create-only call, not as an overwrite", async () => {
    // PUT would replace whoever already holds that id, along with everything
    // they were given. The chair working from a half-remembered name must get
    // a refusal rather than quietly take an advisor's place.
    seen = [];
    const res = await callTool("council_add", {
      id: "ledger",
      name: "Ledger",
      remit: "what this bench costs",
      persona: "You watch the money.",
      tools: ["status"],
      face: "bear",
      colour: "rose",
    });

    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("/api/council");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ id: "ledger", face: "bear" });
    expect(JSON.stringify(res)).toContain("added Ledger (@ledger)");
  });

  it("gives the backend's inventory the same names this server offers", async () => {
    // The backend keeps its own copy of these names, because this file is baked
    // into the image at a path the build does not import from. This is the test
    // that keeps the copy honest — the settings page's checkboxes and the
    // write-time validation are both built on it.
    const { TOOL_INVENTORY } = await import("../src/council-store.js");

    // As a member with no filter, since the mail tools exist only for one.
    const all = (await list({ VK_MEMBER: "uriel" })).sort();
    expect(TOOL_INVENTORY.map((t) => t.name).sort()).toEqual(all);
    // And the chair's view is the inventory minus what is a member's alone.
    expect(
      TOOL_INVENTORY.filter((t) => !t.memberOnly)
        .map((t) => t.name)
        .sort(),
    ).toEqual((await list({})).sort());
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

  it("proposes ending a session rather than ending it", async () => {
    // Nothing with no undo happens on a model's say-so: the tool files a card
    // and the person's tap is what reaches DELETE /api/sessions.
    seen = [];

    await callTool("end_session", { id: "vk-demo-1", why: "it finished an hour ago" });

    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/api/proposals");
    expect(JSON.parse(seen[0].body)).toEqual({
      action: { kind: "end_session", id: "vk-demo-1" },
      why: "it finished an hour ago",
    });
  });

  it("proposes a merge, and a mail, the same way", async () => {
    seen = [];
    await callTool("merge_pr", { project: "demo", number: 7 });
    await callTool("propose", { kind: "send", to: "kari@example.no", subject: "Hei", body: "Ja." });

    expect(seen.map((r) => r.url)).toEqual(["/api/proposals", "/api/proposals"]);
    expect(JSON.parse(seen[0].body).action).toEqual({
      kind: "merge_pr",
      project: "demo",
      number: 7,
    });
    expect(JSON.parse(seen[1].body).action).toEqual({
      kind: "send",
      to: "kari@example.no",
      subject: "Hei",
      body: "Ja.",
    });
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
