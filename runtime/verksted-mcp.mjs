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

// Every timestamp crossing the API is UTC ISO, and the person reading the answer
// lives in one place. TZ is set on the image, so this renders in the bench's own
// zone: without it the assistant reports "05:00" for a schedule whose cron says
// 07:00, and both numbers are right, which is the worst kind of wrong. sv-SE for
// the format alone — it is the locale that spells a date "2026-08-10 07:00".
const local = (iso) =>
  iso ? new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : "-";

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
            `${local(r.at)}  ${r.scheduleName ?? r.scheduleId}  ${r.outcome}` +
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
    name: "repo_status",
    description:
      "Which files are changed in one repo, and whether each change is staged or untracked. Read-only. Use this to answer 'why is X dirty' rather than starting a session to run git for you.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" } },
      required: ["project"],
    },
    run: async (a) => {
      // The file tree's own endpoint. A partially staged file appears twice,
      // once per side, which is a distinction worth keeping in the answer.
      const { branch, files } = await call(
        "GET",
        `/api/projects/${encodeURIComponent(a.project)}/git`,
      );
      return [
        `${a.project}  on ${branch}`,
        "",
        rows(files, (f) => `${f.status}  ${f.path}${f.staged ? "  (staged)" : ""}`),
      ].join("\n");
    },
  },
  {
    name: "start_session",
    description:
      "Start an agent session in a project, optionally with a first prompt. This is how you do work that changes anything: you cannot edit files or run commands yourself, so delegate it to a session the user can watch, then say which session you started. The prompt has to stand on its own — the session cannot see this conversation.",
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
        // Nobody is attached to a session the assistant started, so the same
        // reasoning as a scheduled run applies: routine calls are approved and
        // the rest still stops, surfacing as a waiting session that pushes.
        // Without this the session stalls on its first tool call in silence.
        autoPermissions: true,
      }).then((s) => `started ${s.id} (${s.agent}) in ${s.project}`),
  },
  {
    name: "end_session",
    description:
      "End a session and leave it in history. Use it to tidy up after work you delegated, once you have checked it finished. Ask first if the session is still running: ending one kills the agent mid-task and whatever it had not written down is gone.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    // No purge: the metadata file is what the inbox and the run history read.
    run: (a) =>
      call("DELETE", `/api/sessions/${encodeURIComponent(a.id)}`).then(
        (s) => `ended ${s.id}${s.report ? ` — it reported "${s.report}"` : ""}`,
      ),
  },
  {
    name: "list_prs",
    description:
      "Open pull requests in a repo, with their checks and review state. This is how you answer 'anything to merge' — dependabot bumps that are green and patch-level are the case worth raising unprompted.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        state: { type: "string", enum: ["open", "all"] },
        limit: { type: "integer" },
      },
      required: ["project"],
    },
    run: async (a) => {
      const q = new URLSearchParams({
        state: a.state ?? "open",
        limit: String(a.limit ?? 20),
      });
      const prs = await call("GET", `/api/projects/${encodeURIComponent(a.project)}/prs?${q}`);
      return rows(
        prs,
        (p) =>
          `#${p.number}  ${p.title}  [${p.headRefName}]  checks:${p.checks}` +
          `${p.reviewDecision ? `  ${p.reviewDecision.toLowerCase()}` : ""}` +
          `${p.isDraft ? "  draft" : ""}  +${p.additions}-${p.deletions}  by ${p.author}`,
      );
    },
  },
  {
    name: "pr_detail",
    description:
      "One pull request in full: its description, comments and changed files, and optionally the diff. Read this before recommending a merge — a patch-level bump is judged by looking at it.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        number: { type: "integer" },
        diff: { type: "boolean", description: "also fetch the patch itself" },
      },
      required: ["project", "number"],
    },
    run: async (a) => {
      const base = `/api/projects/${encodeURIComponent(a.project)}/prs/${a.number}`;
      const p = await call("GET", base);
      const out = [
        `#${p.number}  ${p.title}  [${p.headRefName} -> ${p.baseRefName}]  checks:${p.checks}`,
        `by ${p.author}, updated ${local(p.updatedAt)}  ${p.url}`,
        "",
        p.body?.trim() ? p.body.trim().slice(0, 2_000) : "(no description)",
        "",
        "FILES",
        rows(p.files, (f) => `${f.path}  +${f.additions}-${f.deletions}`),
      ];
      if (p.comments?.length) {
        out.push(
          "",
          "COMMENTS",
          rows(p.comments, (c) => `${c.author}: ${c.body.slice(0, 300)}`),
        );
      }
      if (a.diff) {
        const d = await call("GET", `${base}/diff`);
        out.push("", "DIFF", d.diff, ...(d.truncated ? ["(truncated)"] : []));
      }
      return out.join("\n");
    },
  },
  {
    name: "merge_pr",
    description:
      "Squash-merge a pull request and delete its branch. This one is public and hard to undo, and it starts a deploy. Never call it without saying first which PR, what its checks say and that you are about to merge it, and getting an answer. Refuses a PR that is not open or not mergeable.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, number: { type: "integer" } },
      required: ["project", "number"],
    },
    run: (a) =>
      call("POST", `/api/projects/${encodeURIComponent(a.project)}/prs/${a.number}/merge`).then(
        (r) => `merged #${a.number}, now on ${r.branch}${r.detail ? ` (${r.detail})` : ""}`,
      ),
  },
  {
    name: "ci_runs",
    description:
      "Workflow runs for a repo, newest first — or one run's jobs when you pass an id. 'Did it build' is answerable from here without opening anything.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        id: { type: "integer", description: "one run, with its jobs" },
        limit: { type: "integer" },
      },
      required: ["project"],
    },
    run: async (a) => {
      const base = `/api/projects/${encodeURIComponent(a.project)}/runs`;
      if (a.id === undefined) {
        const runs = await call("GET", `${base}?limit=${a.limit ?? 20}`);
        return rows(
          runs,
          (r) =>
            `${r.id}  ${r.conclusion || r.status}  ${r.workflow}  [${r.branch}]  ` +
            `${r.title.slice(0, 60)}  ${local(r.createdAt)}`,
        );
      }
      const r = await call("GET", `${base}/${a.id}`);
      return [
        `${r.id}  ${r.conclusion || r.status}  ${r.workflow}  [${r.branch}]  ${r.url}`,
        "",
        "JOBS",
        rows(r.jobs, (j) => {
          const bad = (j.steps ?? []).filter((s) => s.conclusion === "failure");
          return (
            `${j.name}: ${j.conclusion || j.status}` +
            (bad.length ? `  failed at ${bad.map((s) => s.name).join(", ")}` : "")
          );
        }),
      ].join("\n");
    },
  },
  {
    name: "ci_log",
    description:
      "The log of a run's failing jobs — the failing steps only, not the whole build. Use it to say why something went red rather than that it did.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, id: { type: "integer" } },
      required: ["project", "id"],
    },
    run: (a) =>
      call("GET", `/api/projects/${encodeURIComponent(a.project)}/runs/${a.id}/log`).then((r) =>
        r.log ? `${r.log}${r.truncated ? "\n(truncated)" : ""}` : "no failing job logs on that run",
      ),
  },
  {
    name: "ci_rerun",
    description:
      "Re-run a workflow run, or cancel one in flight. Cheap and reversible — a re-run undoes a cancel — but it spends CI minutes, so do not loop on a test that keeps failing for the same reason.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        id: { type: "integer" },
        action: { type: "string", enum: ["rerun", "rerun-failed", "cancel"] },
      },
      required: ["project", "id"],
    },
    run: (a) => {
      const base = `/api/projects/${encodeURIComponent(a.project)}/runs/${a.id}`;
      const action = a.action ?? "rerun";
      if (action === "cancel") {
        return call("POST", `${base}/cancel`).then(() => `cancelled run ${a.id}`);
      }
      return call("POST", `${base}/rerun`, action === "rerun-failed" ? { failed: true } : {}).then(
        () => `re-running ${action === "rerun-failed" ? "the failed jobs of " : ""}run ${a.id}`,
      );
    },
  },
  {
    name: "list_schedules",
    description: "The recurring prompts: what runs, when it next fires, and how the last run went.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const schedules = await call("GET", "/api/schedules");
      return rows(
        schedules,
        (s) =>
          `${s.id}  ${s.name}  [${s.project}]  "${s.cron}"${s.enabled ? "" : "  (disabled)"}` +
          `  next ${local(s.nextRunAt)}` +
          `${s.lastError ? `  last error: ${s.lastError}` : ""}`,
      );
    },
  },
  {
    name: "create_schedule",
    description:
      "Create a recurring prompt: on its cron a session starts in the project and is given the prompt, unattended. Cron is five fields read in the bench's own timezone, so '0 7 * * 1-5' is 07:00 on weekdays where the user is. The prompt has to stand alone, and should say what to do when there is nothing to do. Say what you are about to create and ask first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        project: { type: "string" },
        cron: { type: "string", description: "five-field cron, in the bench's timezone" },
        prompt: { type: "string" },
        enabled: { type: "boolean" },
        jitterMinutes: {
          type: "integer",
          description: "spread the start over up to this many minutes",
        },
      },
      required: ["name", "project", "cron", "prompt"],
    },
    run: (a) =>
      call("POST", "/api/schedules", {
        name: a.name,
        project: a.project,
        cron: a.cron,
        prompt: a.prompt,
        ...(a.enabled === undefined ? {} : { enabled: a.enabled }),
        ...(a.jitterMinutes === undefined ? {} : { jitterMinutes: a.jitterMinutes }),
      }).then(
        (s) =>
          `created ${s.id} "${s.name}", next run ${s.enabled === false ? "never (disabled)" : local(s.nextRunAt)}`,
      ),
  },
  {
    name: "update_schedule",
    description:
      "Change a schedule's cron, prompt, name, jitter, or turn it on and off. Only the fields you pass change. The project it runs in is fixed at creation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        cron: { type: "string" },
        prompt: { type: "string" },
        enabled: { type: "boolean" },
        jitterMinutes: { type: "integer" },
      },
      required: ["id"],
    },
    run: (a) => {
      const { id, ...patch } = a;
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
      return call("PATCH", `/api/schedules/${encodeURIComponent(id)}`, patch).then(
        (s) =>
          `updated ${s.id} "${s.name}", next run ${s.enabled ? local(s.nextRunAt) : "never (disabled)"}`,
      );
    },
  },
  {
    name: "run_schedule",
    description:
      "Run a schedule now, without waiting for its cron. Refuses when its previous run is still open, and says so.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: (a) =>
      call("POST", `/api/schedules/${encodeURIComponent(a.id)}/run`).then(
        (s) => `started ${s.id} (${s.agent}) in ${s.project}`,
      ),
  },
  {
    name: "delete_schedule",
    description:
      "Remove a schedule for good. Its run history goes with it. Ask before using this — disabling with update_schedule is the reversible version.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: (a) =>
      call("DELETE", `/api/schedules/${encodeURIComponent(a.id)}`).then(
        () => `deleted schedule ${a.id}`,
      ),
  },
  {
    name: "pause_schedules",
    description:
      "The kill switch: while it is on, no schedule fires on its cron. Call with no argument to report the current state. 'Run now' ignores it, so a paused bench can still be asked for something explicitly.",
    inputSchema: {
      type: "object",
      properties: { paused: { type: "boolean" } },
    },
    // Scoped to the one flag on purpose. The same endpoint carries the agent
    // env vars, and nothing here should be able to reach those.
    run: async (a) => {
      const s =
        a.paused === undefined
          ? await call("GET", "/api/settings")
          : await call("PUT", "/api/settings", { schedulesPaused: a.paused });
      return s.schedulesPaused ? "schedules are paused" : "schedules are running";
    },
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
