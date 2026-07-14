import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Project } from "../../../shared/api.js";
import { env } from "../env.js";
import { branchOf, git } from "../git.js";
import { PROJECT_NAME_RE, resolveInsideRepos } from "../paths.js";
import * as store from "../sessions-store.js";

const exec = promisify(execFile);

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const REPO_SHORTHAND_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Main-repo name if `dir` is a linked git worktree under REPOS_DIR, else null.
 * A worktree's .git is a file: "gitdir: <main>/.git/worktrees/<id>".
 */
async function worktreeParent(dir: string): Promise<string | null> {
  try {
    const st = await fs.lstat(path.join(dir, ".git"));
    if (!st.isFile()) return null;
    const gitfile = await fs.readFile(path.join(dir, ".git"), "utf8");
    const m = /^gitdir: (.+)\/\.git\/worktrees\//.exec(gitfile.trim());
    return m ? path.basename(m[1]!) : null;
  } catch {
    return null;
  }
}

/** Absolute paths of the linked worktrees attached to the repo at `dir`. */
async function linkedWorktrees(dir: string): Promise<string[]> {
  try {
    const out = await git(dir, ["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((p) => p !== dir);
  } catch {
    return [];
  }
}

export default async function projectRoutes(app: FastifyInstance) {
  app.get("/api/projects", async (): Promise<Project[]> => {
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
  });

  app.post<{ Body: { mode: "clone" | "init"; url?: string; name?: string } }>(
    "/api/projects",
    {
      schema: {
        body: {
          type: "object",
          required: ["mode"],
          additionalProperties: false,
          properties: {
            mode: { enum: ["clone", "init"] },
            url: { type: "string", maxLength: 300 },
            name: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const { mode, url, name } = req.body;

      if (mode === "clone") {
        if (!url || !(GITHUB_URL_RE.test(url.replace(/\.git$/, "")) || REPO_SHORTHAND_RE.test(url))) {
          return reply.code(400).send({ error: "invalid repo url" });
        }
        const repoName = url.replace(/\.git$/, "").split("/").at(-1)!;
        if (!PROJECT_NAME_RE.test(repoName)) {
          return reply.code(400).send({ error: "invalid repo name" });
        }
        const dest = path.join(env.REPOS_DIR, repoName);
        try {
          await fs.access(dest);
          return reply.code(409).send({ error: "project already exists" });
        } catch {
          // dest is free
        }
        try {
          await exec("gh", ["repo", "clone", url, dest], { timeout: 120_000 });
        } catch (err) {
          req.log.error(err, "clone failed");
          return reply.code(502).send({ error: "clone failed" });
        }
        return reply.code(201).send({ name: repoName });
      }

      // init
      if (!name || !PROJECT_NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid project name" });
      }
      const dir = path.join(env.REPOS_DIR, name);
      try {
        await fs.access(dir);
        return reply.code(409).send({ error: "project already exists" });
      } catch {
        // dir is free
      }
      await fs.mkdir(dir);
      await exec("git", ["-C", dir, "init", "-b", "main"]);
      return reply.code(201).send({ name });
    },
  );

  // Creates a linked git worktree for a branch as a sibling project
  // ("<repo>--<branch>"). The branch is created from HEAD if it doesn't exist
  // (locally or on a unique remote). Sessions run in it like any project.
  app.post<{ Params: { name: string }; Body: { branch: string } }>(
    "/api/projects/:name/worktrees",
    {
      schema: {
        body: {
          type: "object",
          required: ["branch"],
          additionalProperties: false,
          properties: { branch: { type: "string", minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      const branch = req.body.branch.trim();
      try {
        await exec("git", ["check-ref-format", "--branch", branch]);
      } catch {
        return reply.code(400).send({ error: "invalid branch name" });
      }
      const wtName = `${req.params.name}--${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      if (!PROJECT_NAME_RE.test(wtName) || wtName.length > 150) {
        return reply.code(400).send({ error: "invalid branch name" });
      }
      const dest = path.join(env.REPOS_DIR, wtName);
      try {
        await fs.access(dest);
        return reply.code(409).send({ error: "worktree already exists" });
      } catch {
        // dest is free
      }
      try {
        // Existing branch (local, or unique remote match via git's DWIM).
        await exec("git", ["-C", repoDir, "worktree", "add", dest, branch], { timeout: 60_000 });
      } catch (err) {
        const stderr = String((err as { stderr?: string }).stderr ?? "");
        if (stderr.includes("already checked out") || stderr.includes("already used by worktree")) {
          return reply.code(409).send({ error: "branch is already checked out in another worktree" });
        }
        try {
          // New branch from HEAD.
          await exec("git", ["-C", repoDir, "worktree", "add", "-b", branch, dest], {
            timeout: 60_000,
          });
        } catch (err2) {
          req.log.error(err2, "worktree add failed");
          return reply
            .code(502)
            .send({ error: "could not create worktree (does the repo have a commit?)" });
        }
      }
      return reply.code(201).send({ name: wtName, branch });
    },
  );

  // Deletes the repo directory on the pod and all session metadata for the
  // project (killing any live tmux sessions first). Never touches a remote.
  // Worktrees are unregistered from their main repo; deleting a main repo
  // deletes its linked worktrees too (they cannot outlive its .git).
  app.delete<{ Params: { name: string } }>("/api/projects/:name", async (req, reply) => {
    let dir: string;
    try {
      dir = resolveInsideRepos(req.params.name);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    const parent = await worktreeParent(dir);
    if (!parent) {
      for (const wt of await linkedWorktrees(dir)) {
        // Only touch worktrees that live directly under REPOS_DIR as projects.
        const wtName = path.basename(wt);
        try {
          const real = resolveInsideRepos(wtName);
          if (real !== wt) continue;
          await store.deleteProjectSessions(wtName);
          await fs.rm(real, { recursive: true, force: true });
        } catch {
          // gone already, or not a project dir — leave it alone
        }
      }
    }
    await store.deleteProjectSessions(req.params.name);
    await fs.rm(dir, { recursive: true, force: true });
    if (parent) {
      // Drop the stale worktree registration in the main repo, if it remains.
      try {
        await exec("git", ["-C", resolveInsideRepos(parent), "worktree", "prune"]);
      } catch {
        // main repo gone or broken — nothing to prune
      }
    }
    return { name: req.params.name };
  });
}
