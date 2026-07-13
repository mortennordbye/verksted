import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { GitFileStatus, GitStatus, SearchHit, TreeNode } from "../../../shared/api.js";
import { branchOf } from "../git.js";
import { resolveInsideRepos } from "../paths.js";

const exec = promisify(execFile);

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_DEPTH = 12;
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;

async function modifiedPaths(repoDir: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const { stdout } = await exec("git", ["-C", repoDir, "status", "--porcelain=v1", "-uall"]);
    for (const line of stdout.split("\n").filter(Boolean)) {
      let p = line.slice(3);
      const arrow = p.indexOf(" -> ");
      if (arrow !== -1) p = p.slice(arrow + 4);
      set.add(p.replace(/^"(.*)"$/, "$1"));
    }
  } catch {
    // not a git repo / git broke: no markers
  }
  return set;
}

async function walk(
  absDir: string,
  relDir: string,
  depth: number,
  budget: { left: number },
  modified: Set<string>,
): Promise<TreeNode[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory()
      ? a.name.localeCompare(b.name)
      : a.isDirectory()
        ? -1
        : 1,
  );
  const nodes: TreeNode[] = [];
  for (const e of entries) {
    if (budget.left <= 0) break;
    if (e.isSymbolicLink()) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      budget.left--;
      nodes.push({
        name: e.name,
        path: rel,
        type: "dir",
        children:
          depth < MAX_DEPTH ? await walk(path.join(absDir, e.name), rel, depth + 1, budget, modified) : [],
      });
    } else if (e.isFile()) {
      budget.left--;
      nodes.push({ name: e.name, path: rel, type: "file", modified: modified.has(rel) });
    }
  }
  return nodes;
}

export default async function fileRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>(
    "/api/projects/:name/tree",
    async (req, reply) => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      const modified = await modifiedPaths(repoDir);
      return walk(repoDir, "", 0, { left: MAX_ENTRIES }, modified);
    },
  );

  app.get<{ Params: { name: string }; Querystring: { path: string } }>(
    "/api/projects/:name/file",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 1000 } },
        },
      },
    },
    async (req, reply) => {
      let abs: string;
      try {
        abs = resolveInsideRepos(req.params.name, req.query.path);
      } catch {
        return reply.code(403).send({ error: "denied" });
      }
      const stat = await fs.lstat(abs);
      if (!stat.isFile()) return reply.code(403).send({ error: "denied" });
      if (stat.size > MAX_FILE_BYTES) return reply.code(413).send({ error: "file too large" });
      const buf = await fs.readFile(abs);
      if (buf.subarray(0, 8192).includes(0)) {
        return reply.code(415).send({ error: "binary file" });
      }
      return { path: req.query.path, content: buf.toString("utf8") };
    },
  );

  app.get<{ Params: { name: string } }>(
    "/api/projects/:name/git",
    async (req, reply): Promise<GitStatus | void> => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      let files: GitFileStatus[] = [];
      try {
        const { stdout } = await exec("git", ["-C", repoDir, "status", "--porcelain=v1", "-uall"]);
        files = stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [x, y] = [line[0]!, line[1]!];
            let p = line.slice(3);
            const arrow = p.indexOf(" -> ");
            if (arrow !== -1) p = p.slice(arrow + 4);
            p = p.replace(/^"(.*)"$/, "$1");
            return { path: p, status: x === "?" ? "U" : y !== " " ? y : x };
          });
      } catch {
        // broken git: report branch "?" and no files rather than failing
      }
      return { branch: await branchOf(repoDir), files };
    },
  );

  app.get<{ Params: { name: string }; Querystring: { q: string } }>(
    "/api/projects/:name/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          additionalProperties: false,
          properties: { q: { type: "string", minLength: 1, maxLength: 200 } },
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
      try {
        // Literal search; rg skips .git, binaries and .gitignore'd files itself.
        const { stdout } = await exec(
          "rg",
          ["--line-number", "--no-heading", "--smart-case", "--fixed-strings",
           "--max-count", "20", "--max-columns", "250", "--max-filesize", "1M",
           // explicit path: without it rg would read from our stdin pipe
           "--", req.query.q, "."],
          { cwd: repoDir, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
        );
        const hits: SearchHit[] = [];
        for (const line of stdout.split("\n")) {
          if (hits.length >= 300) break;
          const m = /^(.+?):(\d+):(.*)$/.exec(line);
          if (m) {
            hits.push({
              path: m[1]!.replace(/^\.\//, ""),
              line: Number(m[2]),
              text: m[3]!.trim().slice(0, 200),
            });
          }
        }
        return hits;
      } catch (err) {
        if ((err as { code?: number }).code === 1) return []; // rg: no matches
        req.log.error(err, "search failed");
        return reply.code(500).send({ error: "search failed" });
      }
    },
  );
}
