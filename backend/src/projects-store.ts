import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../../shared/api.js";
import { env } from "./env.js";
import { branchOf, git, worktreeParent } from "./git.js";
import * as store from "./sessions-store.js";

/**
 * Every repo under REPOS_DIR, with what the hub shows about it.
 *
 * Three git calls per repo, so it is the most expensive answer this backend
 * gives — which is why the event stream computes it once for every connected
 * client instead of each of them asking on a timer (see events.ts).
 */
export async function listProjects(): Promise<Project[]> {
  const entries = await fs.readdir(env.REPOS_DIR, { withFileTypes: true });
  const sessions = await store.listSessions();
  const projects: Project[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(env.REPOS_DIR, e.name);
    try {
      await fs.access(path.join(dir, ".git"));
    } catch {
      continue;
    }
    let dirty = false;
    try {
      dirty = (await git(dir, ["status", "--porcelain"])) !== "";
    } catch {
      // leave dirty=false; branch shows "?" below on the same kind of breakage
    }
    const own = sessions.filter((s) => s.project === e.name);
    const liveSessions = own.filter((s) => s.status !== "done");
    projects.push({
      name: e.name,
      branch: await branchOf(dir),
      dirty,
      running: own.filter((s) => s.status === "running").length,
      waiting: own.filter((s) => s.status === "waiting").length,
      done: own.filter((s) => s.status === "done").length,
      agents: [...new Set(liveSessions.map((s) => s.agent))],
      lastSessionAt: own[0]?.createdAt ?? null,
      worktreeOf: await worktreeParent(dir),
    });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
