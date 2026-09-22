import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Root cause 1: sessions, agents and chromium under a user of their own.
 *
 * Everything here runs a real process as uid 1001, which the test container
 * (root) can do without that user existing, and asks the kernel what it could
 * reach: the API over loopback, git's own uid, the files the boot hands over.
 *
 * Only as root, which the dev container is and a CI runner is not: CI runs
 * this file again under sudo (see ci.yml).
 */
const run = promisify(execFile);
const UID = 1001;
const asRoot = describe.runIf(process.getuid?.() === 0);

let tmp: string;
let agentHome: string;
let app: FastifyInstance;
let port: number;
let agentUser: typeof import("../src/agent-user.js");
let exec: typeof import("../src/exec.js").exec;

const dir = (name: string) => path.join(tmp, name);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vk-agent-"));
  fs.chmodSync(tmp, 0o755);
  for (const d of [
    "repos",
    "sessions",
    "schedules",
    "assistant",
    "memory",
    "council",
    "feed",
    "loops",
    "usage",
    "docs-index",
    "backups",
    "home",
  ]) {
    fs.mkdirSync(dir(d));
  }
  agentHome = dir("home");
  process.env.REPOS_DIR = dir("repos");
  process.env.SESSIONS_DIR = dir("sessions");
  process.env.SCHEDULES_DIR = dir("schedules");
  process.env.ASSISTANT_DIR = dir("assistant");
  process.env.MEMORY_DIR = dir("memory");
  process.env.COUNCIL_DIR = dir("council");
  process.env.FEED_DIR = dir("feed");
  process.env.LOOPS_DIR = dir("loops");
  process.env.USAGE_DIR = dir("usage");
  process.env.DOCS_INDEX_DIR = dir("docs-index");
  process.env.VK_BACKUP_DIR = dir("backups");
  process.env.SETTINGS_FILE = dir("settings.json");
  process.env.PUSH_FILE = dir("push.json");
  process.env.VK_TMUX_SOCKET = dir("run/tmux");
  process.env.STATIC_DIR = "";
  agentUser = await import("../src/agent-user.js");
  ({ exec } = await import("../src/exec.js"));
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  agentUser.setAgent(null);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => agentUser.setAgent(null));

const agent = () => ({ name: "vk-agent", uid: UID, gid: UID, home: agentHome });

/** A status code, fetched by a node process running as `uid`. */
async function statusAs(uid: number, method: string, url: string): Promise<number> {
  const script = `fetch("http://127.0.0.1:${port}${url}", { method: "${method}" }).then((r) => console.log(r.status))`;
  const { stdout } = await run(process.execPath, ["-e", script], { uid, gid: uid, cwd: "/" });
  return Number(stdout.trim());
}

describe("finding the agent user", () => {
  it("reads it out of passwd, and fails the boot on a name with no user", () => {
    const passwd = "root:x:0:0:root:/root:/bin/bash\nvk-agent:x:1001:1001::/data/home:/bin/bash\n";
    expect(agentUser.lookupUser("vk-agent", passwd)).toEqual({
      name: "vk-agent",
      uid: 1001,
      gid: 1001,
      home: "/data/home",
    });
    expect(() => agentUser.lookupUser("nobody-here", passwd)).toThrow(/no such user/);
  });
});

asRoot("the API, asked by the agent user", () => {
  it("refuses everything but a session's own few routes", async () => {
    agentUser.setAgent(agent(), "", [tmp]);
    expect(await statusAs(UID, "GET", "/api/sessions")).toBe(403);
    expect(await statusAs(UID, "GET", "/")).toBe(403);
    expect(await statusAs(UID, "POST", "/api/proposals/x/do")).toBe(403);
    expect(await statusAs(UID, "GET", "/api/settings/vars/GH_TOKEN/reveal")).toBe(403);
    // `vk feedback` and a liveness check still work from a pane.
    expect(await statusAs(UID, "GET", "/api/health")).toBe(200);
  });

  it("serves the backend's own processes, which run as root", async () => {
    agentUser.setAgent(agent(), "", [tmp]);
    expect(await statusAs(0, "GET", "/api/sessions")).toBe(200);
  });

  it("changes nothing without an agent user", async () => {
    expect(await statusAs(UID, "GET", "/api/sessions")).toBe(200);
  });

  it("finds the owner of the connecting socket in /proc/net/tcp", async () => {
    const { socketOwner } = await import("../src/agent-gate.js");
    const tables = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1",
      "   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000     0        0 2",
      "   2: 0100007F:D431 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 3",
    ].join("\n");
    // The client end, not the listening socket or the accepted one.
    expect(socketOwner(tables, 0xd431, 8080)).toBe(1001);
    expect(socketOwner(tables, 0xd432, 8080)).toBeNull();
  });
});

asRoot("what the backend runs for a session", () => {
  it("runs git as the agent user, with the agent's HOME", async () => {
    fs.chownSync(agentHome, UID, UID);
    agentUser.setAgent(agent(), "", [tmp]);
    const { stdout } = await exec("git", ["-c", "alias.who=!id -u; echo $HOME", "who"], {
      cwd: "/",
    });
    expect(stdout.trim().split("\n")).toEqual([String(UID), agentHome]);
  });

  it("hands a file it wrote to the agent user, without following a link", async () => {
    agentUser.setAgent(agent(), "", [tmp]);
    const file = dir("repos/written.txt");
    fs.writeFileSync(file, "x");
    const target = dir("root-only.txt");
    fs.writeFileSync(target, "y");
    const link = dir("repos/link");
    fs.symlinkSync(target, link);

    await agentUser.giveToAgent(file, link);

    expect(fs.statSync(file).uid).toBe(UID);
    expect(fs.lstatSync(link).uid).toBe(UID);
    expect(fs.statSync(target).uid).toBe(0);
  });

  it("refuses to hand over anything outside the directories it is for", async () => {
    agentUser.setAgent(agent(), "", [dir("repos")]);
    const secret = dir("settings.json");
    fs.writeFileSync(secret, "{}");

    await expect(agentUser.giveToAgent(dir("repos/../settings.json"))).rejects.toThrow(/outside/);
    await expect(agentUser.giveDirToAgent(tmp, dir("feed"))).rejects.toThrow(/outside/);
    expect(fs.statSync(secret).uid).toBe(0);
    expect(fs.statSync(dir("feed")).uid).toBe(0);
  });

  it("leaves the agents' global memory files theirs after writing into them", async () => {
    agentUser.setAgent(agent(), "", [tmp]);
    const home = dir("memhome");
    fs.mkdirSync(home);
    const { ensureSandboxNotes, MEMORY_FILES } = await import("../src/sandbox-doc.js");
    const memory = await import("../src/memory-store.js");

    // The note makes the files and their directories; a saved memory replaces
    // them by rename.
    await ensureSandboxNotes({ warn: () => {} }, home);
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      await memory.save({ slug: "a-fact", text: "The sky is blue." });
    } finally {
      process.env.HOME = was;
    }
    expect(fs.readFileSync(path.join(home, MEMORY_FILES[0]), "utf8")).toContain("The sky is blue.");

    for (const rel of MEMORY_FILES) {
      const file = path.join(home, rel);
      expect(fs.statSync(file).uid).toBe(UID);
      expect(fs.statSync(path.dirname(file)).uid).toBe(UID);
    }
  });
});

asRoot("a session under the agent user", () => {
  it("runs in the agent user's own tmux server, which the backend still drives", async () => {
    const socketDir = dir("tmux-test");
    fs.mkdirSync(socketDir, { mode: 0o700 });
    fs.chownSync(socketDir, UID, UID);
    fs.chownSync(agentHome, UID, UID);
    agentUser.setAgent(agent(), path.join(socketDir, "tmux"), [tmp]);
    const tmux = await import("../src/tmux.js");
    try {
      await tmux.newSession("vk-agenttest-1", agentHome, "sleep 60");

      const [live] = await tmux.listSessionsDetail();
      expect(live?.name).toBe("vk-agenttest-1");
      // The pane's shell, and so the agent under it, is the agent user's.
      const status = fs.readFileSync(`/proc/${live?.panePid}/status`, "utf8");
      expect(status).toMatch(new RegExp(`^Uid:\\s+${UID}\\b`, "m"));
      // And root reaches it by the socket: typing into the pane works.
      await tmux.sendText("vk-agenttest-1", "echo hi", false);
    } finally {
      await tmux.killSession("vk-agenttest-1").catch(() => {});
    }
  });
});

asRoot("the boot that turns it on", () => {
  it("hands over the repos and HOME, moves the assistant's transcripts and closes the rest", async () => {
    agentUser.setAgent(agent(), dir("run/tmux"), [tmp]);
    fs.mkdirSync(dir("repos/demo/src"), { recursive: true });
    fs.writeFileSync(dir("repos/demo/src/a.ts"), "a");
    const slug = dir("repos").replace(/\//g, "-");
    const old = path.join(agentHome, ".claude", "projects", slug);
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "thread.jsonl"), "{}\n");
    fs.writeFileSync(dir("settings.json"), "{}");
    const { prepareForAgents } = await import("../src/agent-setup.js");
    const log = { info: () => {}, warn: () => {} };

    await prepareForAgents(log);

    expect(fs.statSync(dir("repos/demo/src/a.ts")).uid).toBe(UID);
    expect(fs.statSync(agentHome).uid).toBe(UID);
    expect(fs.existsSync(path.join(old, "thread.jsonl"))).toBe(false);
    const moved = path.join(dir("assistant/home/.claude/projects"), slug, "thread.jsonl");
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.statSync(dir("assistant")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(dir("feed")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(dir("sessions")).mode & 0o777).toBe(0o711);
    expect(fs.statSync(dir("settings.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir("run")).uid).toBe(UID);
    expect(fs.existsSync(dir("sessions/.agent-owned"))).toBe(true);

    // What the agent user can no longer read, asked of the kernel.
    const cat = (file: string) =>
      run("cat", [file], { uid: UID, gid: UID }).then(
        () => "read",
        () => "refused",
      );
    expect(await cat(dir("settings.json"))).toBe("refused");
    expect(await cat(moved)).toBe("refused");
    expect(await cat(dir("repos/demo/src/a.ts"))).toBe("read");

    // A second boot touches only the tops, and a file root left inside stays.
    fs.writeFileSync(dir("repos/demo/root.txt"), "r");
    await prepareForAgents(log);
    expect(fs.statSync(dir("repos/demo/root.txt")).uid).toBe(0);
  });
  it("gives it all back on the boot that turns it off, so git works as root again", async () => {
    // Runs after the handover above, on the volume it left: the repos and HOME
    // are the agent user's, the transcripts are in the assistant's own HOME.
    await run("git", ["init", "-q", dir("repos/owned")]);
    await run("chown", ["-R", `${UID}:${UID}`, dir("repos/owned")]);
    const slug = dir("repos").replace(/\//g, "-");
    // One written while the pod already ran the other way: kept, not clobbered.
    const back = path.join(agentHome, ".claude", "projects", slug);
    fs.mkdirSync(back, { recursive: true });
    fs.writeFileSync(path.join(back, "new.jsonl"), "{}\n");
    const home = process.env.HOME;
    process.env.HOME = agentHome;
    agentUser.setAgent(null);
    const { prepareForAgents } = await import("../src/agent-setup.js");
    const log = { info: () => {}, warn: () => {} };
    try {
      await expect(run("git", ["-C", dir("repos/owned"), "status"])).rejects.toThrow(/dubious/);

      await prepareForAgents(log);

      expect(fs.statSync(dir("repos/demo/src/a.ts")).uid).toBe(0);
      expect(fs.statSync(agentHome).uid).toBe(0);
      await run("git", ["-C", dir("repos/owned"), "status"]);
      expect(fs.existsSync(path.join(back, "thread.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(back, "new.jsonl"))).toBe(true);
      expect(fs.existsSync(dir("sessions/.agent-owned"))).toBe(false);
    } finally {
      process.env.HOME = home;
    }
  });
});
