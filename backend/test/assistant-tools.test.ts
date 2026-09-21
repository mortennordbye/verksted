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
/** Paths the stub answers 500 to, once each: for the fail-closed cases. */
const failNext = new Set<string>();
let hang = false;

const REPLIES: Record<string, unknown> = {
  "POST /api/memory/proposed": { slug: "invoices" },
  "PUT /api/memory/invoices": { slug: "invoices" },
  "PUT /api/council/uriel/memory/rates": { slug: "rates" },
  "POST /api/assistant/turn/private": { browsing: "closed" },
  // Which kind a schedule is, which the three schedule tools ask before
  // changing anything about it.
  "GET /api/schedules": [
    { id: "sch-1a2b3c4d", kind: "session", name: "nightly", project: "demo" },
    { id: "sch-assistant", kind: "assistant", name: "morning" },
  ],
  "POST /api/schedules": { id: "sch-new", name: "morning", kind: "assistant", enabled: true },
  "POST /api/schedules/sch-assistant/run": { reply: "ok: nothing needs you" },
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

/**
 * Several calls to one server process, in order, with the replies matched back
 * by id. What a turn is: the CLI spawns this server once and calls it as often
 * as the model asks, so anything the server remembers between calls — what this
 * turn has already read — only exists here.
 */
async function rpcTurn(
  requests: object[],
  env: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, VK_API: api, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.on("error", reject);
    child.on("close", () => resolve(buf));
    // One at a time: the server answers each line before the next matters, and
    // a turn's calls are sequential for the same reason.
    void (async () => {
      for (const r of requests) {
        child.stdin.write(`${JSON.stringify(r)}\n`);
        await new Promise((f) => setTimeout(f, 120));
      }
      child.stdin.end();
    })();
  });
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const line of out.split("\n").filter(Boolean)) {
    const msg = JSON.parse(line) as Record<string, unknown>;
    byId.set(msg.id, msg);
  }
  return requests.map((r) => byId.get((r as { id: unknown }).id) ?? {});
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
      // A backend that has taken the request and will never answer it.
      if (key === "GET /api/projects" && hang) return;
      if (failNext.delete(key)) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "no" }));
      }
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
        "calendar_add",
        "calendar_delete",
        "calendar_search",
        "calendar_today",
        "calendar_update",
        "calendar_upcoming",
        "ci_log",
        "ci_rerun",
        "ci_runs",
        "close_loop",
        "cluster_status",
        "council_add",
        // The mail and the documents, which the chair reads itself: a lookup is
        // not a meeting, and routing one through an advisor cost a call and a
        // turn to say it had been asked.
        "docs_catalogue",
        "docs_list",
        "docs_read",
        "docs_search",
        "mail_folders",
        "mail_move",
        "mail_relabel",
        "mail_labels",
        "mail_rules",
        "mail_rule_create",
        "mail_rule_delete",
        "mail_label_delete",
        "mail_read",
        "mail_recent",
        "mail_search",
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

  it("offers the mail and the documents to the chair, and narrows an advisor", async () => {
    // Routing a lookup through an advisor cost a call and a turn to say it had
    // been asked, so the chair reads these itself. What makes that safe is not
    // here: it has no web tools, and a session is a card it files.
    const names = async (env: Record<string, string>) => {
      const res = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, env)) as {
        result: { tools: { name: string }[] };
      };
      return res.result.tools.map((t) => t.name);
    };
    expect(await names({})).toContain("mail_read");
    expect(await names({})).toContain("docs_read");
    // VK_TOOLS still narrows a member to exactly what its file names.
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
        // Read-only, and the chair reads the mail itself now. mail_move and the
        // rule writes are not here on purpose: they change something, and
        // nothing that changes anything is offered when nobody is reading.
        "mail_folders",
        "mail_labels",
        "mail_rules",
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

  it("offers nothing to a member named with an empty list", async () => {
    // Set and empty is not the same as unset. Read as a truthy string, "" fell
    // through to "no filter" and handed an advisor with no verksted tools at
    // all every tool there is.
    expect(await list({ VK_TOOLS: "" })).toEqual([]);
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
    // asks for a project scope, changes nothing about where this lands — and
    // since A-10 it does not get that far: a member's schema carries neither
    // argument, so the call is refused rather than quietly stripped.
    const remember = (args: object) =>
      rpc(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "remember", arguments: args },
        },
        { VK_MEMBER: "uriel", VK_TOOLS: "remember" },
      );
    seen = [];

    const res = (await remember({ slug: "x", text: "y", scope: "Homelab", member: "chair" })) as {
      result: { content: { text: string }[] };
    };

    expect(res.result.content[0].text).toContain("no such argument");
    expect(seen).toEqual([]);

    // And the same call with only what it may name still lands in this
    // member's own store.
    await remember({ slug: "x", text: "y" });
    expect(seen[0]?.url).toBe("/api/council/uriel/memory/x");
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

  it("gives the backend's inventory the same policy this server offers", async () => {
    // The backend keeps its own copy of this table, because this file is baked
    // into the image at a path the build does not import from. This is the test
    // that keeps the copy honest — the settings page's checkboxes, the
    // write-time validation and which tools may sit beside the web are all
    // built on it, and every one of them is wrong if it drifts.
    const { TOOL_INVENTORY } = await import("../src/council-store.js");

    const res = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string; _meta?: { verksted?: Record<string, unknown> } }[] };
    };
    const served = res.result.tools
      .map((t) => ({
        name: t.name,
        unattended: t._meta?.verksted?.unattended === true,
        chairOnly: t._meta?.verksted?.chairOnly === true,
        private: t._meta?.verksted?.private === true,
        outside: t._meta?.verksted?.outside === true,
        effect: t._meta?.verksted?.effect,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect([...TOOL_INVENTORY].sort((a, b) => a.name.localeCompare(b.name))).toEqual(served);
  });

  it("offers an advisor nothing that is the chair's alone, whatever its file says", async () => {
    // Enforced here as well as at the moment a member is saved: a member is a
    // JSON file on the volume somebody can edit by hand, and a tool that
    // reaches a shell must not depend on a settings page having refused it.
    const names = await list({ VK_MEMBER: "uriel", VK_TOOLS: "status,start_session,merge_pr" });

    expect(names).toEqual(["status"]);
  });

  it("names three tools that cannot be undone, and no more", async () => {
    // The point of writing the effect down: this set is what BACKLOG tracks,
    // and a tool added without a card joins it rather than passing unnoticed.
    const { TOOL_INVENTORY } = await import("../src/council-store.js");

    expect(TOOL_INVENTORY.filter((t) => t.effect === "irreversible").map((t) => t.name)).toEqual([
      "mail_rule_delete",
      "mail_label_delete",
      "calendar_delete",
    ]);
  });

  it("keeps the web away from everything private", async () => {
    // The seeded web advisor held `recall` while this list named only the mail
    // and the documents, so it could search every conversation the chair ever
    // had — mail and documents it had quoted included.
    const { PRIVATE_TOOLS } = await import("../src/council-store.js");

    for (const name of ["recall", "feed", "brief_material", "loops", "recent_prompts"]) {
      expect(PRIVATE_TOOLS.has(name), name).toBe(true);
    }
    expect(PRIVATE_TOOLS.has("status")).toBe(false);
  });
});

/**
 * A-01 and A-03: the chair reads the mail, the documents and the calendar, and
 * it drives a browser that can open any URL. Holding both at once is a
 * zero-click exfiltration path, and writing memory from what it read is a
 * standing instruction for every future session in every repo.
 */
describe("a turn that reads something of the person's", () => {
  const TURN = { VK_TURN: "turn-1" };
  const call = (id: number, name: string, args: object = {}) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  it("pays for the read by closing the browser, before the answer", async () => {
    seen = [];

    await rpcTurn([call(1, "mail_read", { uid: 4 })], TURN);

    // First, not merely somewhere: between reading the mail and the browser
    // going there must be no moment at all.
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/api/assistant/turn/private");
    expect(JSON.parse(seen[0].body)).toEqual({ turn: "turn-1" });
    expect(seen[1].url).toContain("/api/mail/");
  });

  it("does not answer at all if the browser could not be closed", async () => {
    // Fails closed. A read this server cannot pay for is a read it does not do.
    failNext.add("POST /api/assistant/turn/private");
    seen = [];

    const [res] = (await rpcTurn([call(1, "docs_read", { path: "x.pdf" })], TURN)) as {
      result?: { isError?: boolean; content: { text: string }[] };
    }[];

    expect(res.result?.isError).toBe(true);
    expect(res.result?.content[0].text).toContain("could not close the browser");
    expect(seen.some((r) => r.url.startsWith("/api/docs"))).toBe(false);
  });

  it("proposes what it would have remembered, once it has read outside text", async () => {
    seen = [];

    const [, res] = (await rpcTurn(
      [
        call(1, "mail_read", { uid: 4 }),
        call(2, "remember", { slug: "invoices", text: "Send invoices on the 1st." }),
      ],
      TURN,
    )) as { result?: { content: { text: string }[] } }[];

    const wrote = seen.filter((r) => r.url.startsWith("/api/memory"));
    expect(wrote.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /api/memory/proposed"]);
    expect(res.result?.content[0].text).toContain("proposed");
    expect(res.result?.content[0].text).toContain("read text written elsewhere");
  });

  it("notes about the person go the same way", async () => {
    seen = [];

    await rpcTurn(
      [call(1, "pr_detail", { project: "demo", number: 3 }), call(2, "person_note", { text: "x" })],
      TURN,
    );

    expect(seen.some((r) => r.url === "/api/profile/lines")).toBe(false);
    expect(seen.some((r) => r.url === "/api/memory/proposed")).toBe(true);
  });

  it("still remembers outright on a turn that has read nothing written elsewhere", async () => {
    // The ordinary case, and the one that must not become a chore: the person
    // said it in the chat, and the chair writes it down.
    seen = [];

    await rpcTurn(
      [call(1, "status"), call(2, "remember", { slug: "invoices", text: "On the 1st." })],
      TURN,
    );

    expect(seen.some((r) => r.method === "PUT" && r.url === "/api/memory/invoices")).toBe(true);
    expect(seen.some((r) => r.url === "/api/memory/proposed")).toBe(false);
  });

  it("leaves an advisor's own notebook alone", async () => {
    // A member's memory reaches nothing but its own next turn, so reading a
    // document does not make writing it an instruction to anybody.
    seen = [];

    await rpcTurn(
      [
        call(1, "docs_read", { path: "x.pdf" }),
        call(2, "remember", { slug: "rates", text: "They bill monthly." }),
      ],
      { ...TURN, VK_MEMBER: "uriel", VK_TOOLS: "docs_read,remember" },
    );

    expect(seen.some((r) => r.url === "/api/council/uriel/memory/rates")).toBe(true);
    expect(seen.some((r) => r.url === "/api/memory/proposed")).toBe(false);
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

  it("proposes a session rather than starting one", async () => {
    // The chair reads the documents and the mail, and a session is an agent
    // with a shell on the pod. The tap is what stands between the two, so the
    // tool files a card and starts nothing.
    seen = [];

    await callTool("start_session", { project: "demo", agent: "claude", prompt: "look around" });

    expect(seen[0].url).toBe("/api/proposals");
    expect(JSON.parse(seen[0].body)).toMatchObject({
      action: { kind: "start_session", project: "demo", agent: "claude", prompt: "look around" },
    });
  });

  /**
   * A-02. start_session is a card because a session is an agent with a shell on
   * the pod. A session schedule is the same shell on a timer, and run-now is
   * the same shell with no timer at all — and all three reached it directly.
   */
  it("proposes a session schedule rather than creating one", async () => {
    seen = [];

    await callTool("create_schedule", {
      name: "nightly tidy",
      project: "demo",
      cron: "0 3 * * *",
      prompt: "tidy the branches",
    });

    expect(seen[0].url).toBe("/api/proposals");
    expect(JSON.parse(seen[0].body).action).toEqual({
      kind: "schedule_put",
      name: "nightly tidy",
      project: "demo",
      cron: "0 3 * * *",
      prompt: "tidy the branches",
    });
  });

  it("proposes a change to one, prompt and pause alike", async () => {
    seen = [];

    await callTool("update_schedule", { id: "sch-1a2b3c4d", prompt: "tidy harder" });

    expect(seen.at(-1)!.url).toBe("/api/proposals");
    expect(JSON.parse(seen.at(-1)!.body).action).toEqual({
      kind: "schedule_put",
      id: "sch-1a2b3c4d",
      prompt: "tidy harder",
    });
  });

  it("proposes running one now, which is a session with no timer in front of it", async () => {
    seen = [];

    await callTool("run_schedule", { id: "sch-1a2b3c4d" });

    expect(seen.at(-1)!.url).toBe("/api/proposals");
    expect(JSON.parse(seen.at(-1)!.body).action).toEqual({
      kind: "run_schedule",
      id: "sch-1a2b3c4d",
    });
  });

  it("creates and runs a schedule of its own directly, which can change nothing", async () => {
    // The chair on a timer: no repo, no session, no way to change anything.
    // Carding these would be asking permission to answer a question.
    seen = [];

    await callTool("create_schedule", {
      name: "morning",
      kind: "assistant",
      cron: "0 7 * * *",
      prompt: "what needs me?",
    });
    await callTool("run_schedule", { id: "sch-assistant" });

    expect(seen[0].url).toBe("/api/schedules");
    expect(JSON.parse(seen[0].body).kind).toBe("assistant");
    expect(seen.at(-1)!.url).toBe("/api/schedules/sch-assistant/run");
  });

  it("proposes a desk session the same way", async () => {
    seen = [];

    await callTool("desk_session", { title: "three offers", ask: "compare them" });

    expect(seen[0].url).toBe("/api/proposals");
    expect(JSON.parse(seen[0].body)).toMatchObject({
      action: { kind: "desk_session", title: "three offers", ask: "compare them" },
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

/**
 * A-10. The schemas were documentation for the model and nothing else: whatever
 * arrived was handed to the tool, and several tools put an argument in a path.
 * The filters above — what an unattended turn may do, what one advisor may do —
 * only mean anything while each tool is confined to its own endpoint.
 */
describe("a backend that does not answer", () => {
  it("fails the tool call rather than holding the turn for ever, and says it may have landed", async () => {
    hang = true;
    try {
      const res = await rpc(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } },
        { VK_CALL_TIMEOUT_MS: "200" },
      );
      const result = res.result as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("did not answer");
      expect(result.content[0].text).toContain("look before trying again");
    } finally {
      hang = false;
    }
  });

  it("does not wait for a run of its own that it started", async () => {
    seen = [];
    const res = await callTool("run_schedule", { id: "sch-assistant" });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ wait: false });
    expect((res.result as { content: { text: string }[] }).content[0].text).toContain("started");
  });
});

describe("arguments, before the tool sees them", () => {
  const errorOf = (res: Record<string, unknown>) =>
    (res.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "";

  it("refuses a run id that would turn a re-run into something else", async () => {
    seen = [];

    // fetch normalises "..", so this used to POST /api/schedules/<id>/run —
    // a tool an unattended turn is not offered, reached through one it is.
    const res = await callTool("ci_rerun", {
      project: "demo",
      id: "../../../schedules/sch-1a2b3c4d/run?x=",
    });

    expect(errorOf(res)).toContain("id must be an integer");
    expect(seen).toEqual([]);
  });

  it("refuses an argument the tool never declared", async () => {
    // Dropped rather than refused would be worse than either: update_schedule
    // forwards everything it was not asked for as a patch, and a model whose
    // argument vanishes is not told that what it asked for did not happen.
    seen = [];

    const res = await callTool("update_schedule", {
      id: "sch-assistant",
      prompt: "tidy harder",
      vars: { GH_TOKEN: "x" },
    });

    expect(errorOf(res)).toContain("no such argument: vars");
    expect(seen).toEqual([]);
  });

  it("refuses a missing required argument and a value outside its enum", async () => {
    seen = [];

    expect(errorOf(await callTool("ci_log", { project: "demo" }))).toContain("id is required");
    expect(
      errorOf(await callTool("ci_rerun", { project: "demo", id: 4, action: "delete" })),
    ).toContain("action must be one of");
    expect(seen).toEqual([]);
  });

  it("checks the arguments before the read that closes the browser", async () => {
    // A call this server will not make must not cost the turn a capability:
    // the chair holds the browser for the rest of the turn either way.
    seen = [];

    const [res] = await rpcTurn(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "mail_read", arguments: { uid: "4; drop" } },
        },
      ],
      { VK_TURN: "turn-args" },
    );

    expect(errorOf(res)).toContain("uid must be an integer");
    expect(seen).toEqual([]);
  });

  it("takes the arguments a tool does declare", async () => {
    seen = [];

    await callTool("ci_rerun", { project: "demo", id: 42, action: "cancel" });

    expect(seen[0].url).toBe("/api/projects/demo/runs/42/cancel");
  });
});

/**
 * A-31. What the thread keeps of a tool call is its name and eighty characters
 * of one argument. That answers "it moved some mail" and nothing else: not
 * which mail, not where to, and nothing a person could put back.
 */
describe("the tool log", () => {
  const log = (name: string, args: object = {}, env: Record<string, string> = {}) =>
    rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      {
        VK_TURN: "turn-log",
        ...env,
      },
    );

  it("writes a call that changed something, with its arguments in full", async () => {
    seen = [];

    await log("pause_schedules", { paused: true });

    // After the call, not before: the line carries what came back.
    const record = seen.find((r) => r.url === "/api/assistant/turn/tool");
    expect(record).toBeDefined();
    expect(JSON.parse(record!.body)).toMatchObject({
      turn: "turn-log",
      speaker: "chair",
      unattended: false,
      tool: "pause_schedules",
      effect: "reversible",
      args: { paused: true },
      ok: true,
      result: "schedules are paused",
    });
  });

  it("names the advisor whose turn it was, and whether anybody was reading", async () => {
    seen = [];

    await log(
      "propose_memory",
      { slug: "invoices", text: "Kari pays on the 20th." },
      {
        VK_MEMBER: "uriel",
        VK_TOOLS: "propose_memory",
        VK_UNATTENDED: "1",
      },
    );

    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ speaker: "uriel", unattended: true });
  });

  it("writes a call that failed, which is the half worth keeping", async () => {
    seen = [];
    failNext.add("POST /api/proposals");

    await log("end_session", { id: "vk-demo-1", why: "it finished" });

    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ tool: "end_session", ok: false });
  });

  it("writes nothing for a read", async () => {
    // A personal assistant reads the mail and the calendar all day. A record of
    // that is a second copy of the person's life, not an audit trail.
    seen = [];

    await log("status");

    expect(seen.map((r) => r.url)).not.toContain("/api/assistant/turn/tool");
  });

  it("tells the model when a call could not be recorded", async () => {
    // By then the call has happened, so refusing it would be a lie — but a
    // silent hole in the log is worse. The one place a person sees it is the
    // answer the assistant writes.
    seen = [];
    failNext.add("POST /api/assistant/turn/tool");

    const res = (await log("pause_schedules", { paused: true })) as {
      result: { content: { text: string }[] };
    };

    expect(res.result.content[0].text).toContain("not written to the tool log");
  });
});
