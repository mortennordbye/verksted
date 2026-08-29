import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../../shared/api.js";
import { env } from "./env.js";
import { exec } from "./exec.js";
import { branchOf, git, worktreeParent } from "./git.js";
import { PROJECT_NAME_RE, resolveInsideRepos } from "./paths.js";
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

/** Why a worktree could not be made, with the status the route answers with. */
export class WorktreeError extends Error {
  constructor(
    readonly status: 400 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A linked git worktree for a branch, as a sibling project ("<repo>--<branch>").
 * The branch is created from HEAD when it does not exist locally or on a
 * unique remote. Sessions run in it like any project; the maintainer's build
 * stage runs in one so the repo itself stays on its default branch.
 */
export async function addWorktree(
  project: string,
  branch: string,
): Promise<{ name: string; dir: string; branch: string }> {
  const repoDir = resolveInsideRepos(project);
  try {
    await exec("git", ["check-ref-format", "--branch", branch]);
  } catch {
    throw new WorktreeError(400, "invalid branch name");
  }
  const name = `${project}--${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  if (!PROJECT_NAME_RE.test(name) || name.length > 150) {
    throw new WorktreeError(400, "invalid branch name");
  }
  const dir = path.join(env.REPOS_DIR, name);
  try {
    await fs.access(dir);
    throw new WorktreeError(409, "worktree already exists");
  } catch (err) {
    if (err instanceof WorktreeError) throw err;
    // dir is free
  }
  try {
    // Existing branch (local, or unique remote match via git's DWIM).
    await exec("git", ["-C", repoDir, "worktree", "add", dir, branch], { timeout: 60_000 });
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? "");
    if (stderr.includes("already checked out") || stderr.includes("already used by worktree")) {
      throw new WorktreeError(409, "branch is already checked out in another worktree");
    }
    try {
      // New branch from HEAD.
      await exec("git", ["-C", repoDir, "worktree", "add", "-b", branch, dir], {
        timeout: 60_000,
      });
    } catch {
      throw new WorktreeError(502, "could not create worktree (does the repo have a commit?)");
    }
  }
  return { name, dir, branch };
}

/**
 * Unregister and delete a linked worktree. The branch stays: what it holds
 * has been pushed (the caller checks) and the remote is where it lives now.
 */
export async function removeWorktree(name: string): Promise<void> {
  const dir = resolveInsideRepos(name);
  const parent = await worktreeParent(dir);
  if (!parent) throw new WorktreeError(400, "not a worktree");
  const parentDir = resolveInsideRepos(parent);
  await exec("git", ["-C", parentDir, "worktree", "remove", "--force", dir], { timeout: 60_000 });
  await exec("git", ["-C", parentDir, "worktree", "prune"]);
}
