import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Project } from "../../../shared/api.js";
import { env } from "../env.js";
import { PROJECT_NAME_RE } from "../paths.js";
import * as store from "../sessions-store.js";

const exec = promisify(execFile);

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const REPO_SHORTHAND_RE = /^[\w.-]+\/[\w.-]+$/;

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoDir, ...args]);
  return stdout.trim();
}

async function branchOf(repoDir: string): Promise<string> {
  try {
    // symbolic-ref also works on a fresh repo with no commits.
    return await git(repoDir, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    try {
      return await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      return "?";
    }
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
      const runningSessions = own.filter((s) => s.status === "running");
      projects.push({
        name: e.name,
        branch: await branchOf(dir),
        dirty,
        running: runningSessions.length,
        done: own.filter((s) => s.status === "done").length,
        agents: [...new Set(runningSessions.map((s) => s.agent))],
        lastSessionAt: own[0]?.createdAt ?? null,
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
}
