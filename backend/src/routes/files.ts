import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  FileDiff,
  GitFileStatus,
  GitStatus,
  ReplaceResult,
  SearchFlags,
  SearchHit,
  TreeNode,
} from "../../../shared/api.js";
import { branchOf } from "../git.js";
import { repoRelPath, resolveInsideRepos } from "../paths.js";
import { agentEnv } from "../settings-store.js";

const exec = promisify(execFile);

// Literal pathspecs: client-supplied paths can never be pathspec magic/globs.
const GIT_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };

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
  // Raw request bodies for the upload endpoint.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
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

  const MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    pdf: "application/pdf",
  };
  const MAX_RAW_BYTES = 20 * 1024 * 1024;

  // Raw bytes of any file: image viewing in the UI and downloads.
  app.get<{ Params: { name: string }; Querystring: { path: string; download?: string } }>(
    "/api/projects/:name/raw",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 1000 },
            download: { type: "string" },
          },
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
      if (stat.size > MAX_RAW_BYTES) return reply.code(413).send({ error: "file too large" });
      const name = path.basename(abs).replace(/[^\w.-]/g, "_");
      return reply
        .header("content-type", MIME[name.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream")
        // Repo content must never script against the app origin (e.g. SVG).
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .header("x-content-type-options", "nosniff")
        .header(
          "content-disposition",
          `${req.query.download ? "attachment" : "inline"}; filename="${name}"`,
        )
        .send(await fs.readFile(abs));
    },
  );

  // Upload one file (raw body) into the repo. Overwrites like an editor save.
  app.put<{ Params: { name: string }; Querystring: { path: string } }>(
    "/api/projects/:name/file",
    {
      bodyLimit: MAX_RAW_BYTES,
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
      let dir: string;
      let rel: string;
      try {
        rel = repoRelPath(req.query.path);
        // The file itself may not exist yet; its directory must, and the
        // realpath check on the directory defeats symlink escapes.
        dir = resolveInsideRepos(req.params.name, path.dirname(rel));
      } catch {
        return reply.code(403).send({ error: "denied" });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "raw body required" });
      await fs.writeFile(path.join(dir, path.basename(rel)), body);
      return { path: rel, bytes: body.length };
    },
  );

  app.get<{ Params: { name: string }; Querystring: { path: string; staged?: boolean } }>(
    "/api/projects/:name/diff",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 1000 },
            staged: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply): Promise<FileDiff | void> => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      let rel: string;
      try {
        rel = repoRelPath(req.query.path);
      } catch {
        return reply.code(403).send({ error: "denied" });
      }
      const opts = { env: GIT_ENV, maxBuffer: 4 * 1024 * 1024 };
      try {
        let { stdout } = await exec(
          "git",
          ["-C", repoDir, "diff", ...(req.query.staged ? ["--cached"] : []), "--", rel],
          opts,
        );
        if (!stdout && !req.query.staged) {
          // Untracked files have no diff against the index; fabricate the
          // new-file diff (--no-index exits 1 when the files differ).
          stdout = await exec("git", ["-C", repoDir, "diff", "--no-index", "--", "/dev/null", rel], opts)
            .then((r) => r.stdout)
            .catch((err: { code?: number; stdout?: string }) =>
              err.code === 1 ? (err.stdout ?? "") : "",
            );
        }
        return { path: rel, diff: stdout.slice(0, 512 * 1024) };
      } catch (err) {
        req.log.error(err, "diff failed");
        return reply.code(500).send({ error: "diff failed" });
      }
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
        for (const line of stdout.split("\n").filter(Boolean)) {
          const [x, y] = [line[0]!, line[1]!];
          let p = line.slice(3);
          const arrow = p.indexOf(" -> ");
          if (arrow !== -1) p = p.slice(arrow + 4);
          p = p.replace(/^"(.*)"$/, "$1");
          if (x === "?") {
            files.push({ path: p, status: "U", staged: false });
            continue;
          }
          if (x !== " ") files.push({ path: p, status: x, staged: true });
          if (y !== " ") files.push({ path: p, status: y, staged: false });
        }
      } catch {
        // broken git: report branch "?" and no files rather than failing
        files = [];
      }
      return { branch: await branchOf(repoDir), files };
    },
  );

  const pathsBody = {
    type: "object",
    required: ["paths"],
    additionalProperties: false,
    properties: {
      paths: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: { type: "string", minLength: 1, maxLength: 1000 },
      },
    },
  };

  app.post<{ Params: { name: string }; Body: { paths: string[] } }>(
    "/api/projects/:name/git/stage",
    { schema: { body: pathsBody } },
    async (req, reply) => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      let paths: string[];
      try {
        paths = req.body.paths.map(repoRelPath);
      } catch {
        return reply.code(403).send({ error: "denied" });
      }
      try {
        await exec("git", ["-C", repoDir, "add", "--", ...paths], { env: GIT_ENV });
      } catch (err) {
        req.log.error(err, "git add failed");
        return reply.code(409).send({ error: "stage failed" });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { name: string }; Body: { paths: string[] } }>(
    "/api/projects/:name/git/unstage",
    { schema: { body: pathsBody } },
    async (req, reply) => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      let paths: string[];
      try {
        paths = req.body.paths.map(repoRelPath);
      } catch {
        return reply.code(403).send({ error: "denied" });
      }
      try {
        await exec("git", ["-C", repoDir, "restore", "--staged", "--", ...paths], { env: GIT_ENV });
      } catch {
        try {
          // restore needs HEAD; on a repo with no commits everything staged is
          // an addition, which rm --cached undoes (-f: file may have been
          // modified since staging; --cached never touches the working tree).
          await exec("git", ["-C", repoDir, "rm", "--cached", "-f", "-q", "-r", "--", ...paths], {
            env: GIT_ENV,
          });
        } catch (err) {
          req.log.error(err, "git unstage failed");
          return reply.code(409).send({ error: "unstage failed" });
        }
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { name: string }; Body: { message: string } }>(
    "/api/projects/:name/git/commit",
    {
      schema: {
        body: {
          type: "object",
          required: ["message"],
          additionalProperties: false,
          properties: { message: { type: "string", minLength: 1, maxLength: 5000 } },
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
      const message = req.body.message.trim();
      if (!message) return reply.code(400).send({ error: "empty commit message" });
      try {
        // Commits the index only (no -a) — exactly what the UI staged.
        // agentEnv so GIT_AUTHOR_*/GIT_COMMITTER_* from the settings page apply.
        await exec("git", ["-C", repoDir, "commit", "-m", message], {
          env: { ...process.env, ...(await agentEnv()) },
        });
      } catch (err) {
        const out = String((err as { stdout?: string }).stdout ?? "");
        const stderr = String((err as { stderr?: string }).stderr ?? "");
        // "nothing to commit" / "no changes added to commit" /
        // "nothing added to commit but untracked files present"
        if (/no(thing| changes)? ?(added )?to commit/.test(out)) {
          return reply.code(409).send({ error: "nothing staged to commit" });
        }
        if (stderr.includes("Please tell me who you are")) {
          return reply
            .code(409)
            .send({ error: "git identity not set — set GIT_AUTHOR_* / GIT_COMMITTER_* vars" });
        }
        req.log.error(err, "git commit failed");
        return reply.code(500).send({ error: "commit failed" });
      }
      return { ok: true };
    },
  );

  // VS Code-style match flags, shared by search and replace. rg skips .git,
  // binaries and .gitignore'd files itself.
  const rgFlags = (f: SearchFlags) => [
    f.case ? "-s" : "-i",
    ...(f.word ? ["-w"] : []),
    ...(f.regex ? [] : ["--fixed-strings"]),
    "--max-filesize",
    "1M",
  ];

  const flagProps = {
    case: { type: "boolean" },
    word: { type: "boolean" },
    regex: { type: "boolean" },
  };

  app.get<{ Params: { name: string }; Querystring: { q: string } & SearchFlags }>(
    "/api/projects/:name/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          additionalProperties: false,
          properties: { q: { type: "string", minLength: 1, maxLength: 200 }, ...flagProps },
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
        const { stdout } = await exec(
          "rg",
          ["--line-number", "--no-heading", ...rgFlags(req.query),
           "--max-count", "20", "--max-columns", "250",
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
        const code = (err as { code?: number }).code;
        if (code === 1) return []; // rg: no matches
        if (code === 2) return reply.code(400).send({ error: "invalid pattern" });
        req.log.error(err, "search failed");
        return reply.code(500).send({ error: "search failed" });
      }
    },
  );

  app.post<{ Params: { name: string }; Body: { q: string; replace: string } & SearchFlags }>(
    "/api/projects/:name/replace",
    {
      schema: {
        body: {
          type: "object",
          required: ["q", "replace"],
          additionalProperties: false,
          properties: {
            q: { type: "string", minLength: 1, maxLength: 200 },
            replace: { type: "string", maxLength: 1000 },
            ...flagProps,
          },
        },
      },
    },
    async (req, reply): Promise<ReplaceResult | void> => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      const { q, replace: replacement } = req.body;
      // The same match as rg, expressed as a JS regex for the rewrite. Rust
      // and JS regex syntax differ at the margins; matching files are found by
      // rg, each occurrence is rewritten by this.
      let re: RegExp;
      try {
        let src = req.body.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (req.body.word) src = `\\b(?:${src})\\b`;
        re = new RegExp(src, req.body.case ? "g" : "gi");
      } catch {
        return reply.code(400).send({ error: "invalid pattern" });
      }
      let matched: string[];
      try {
        const { stdout } = await exec(
          "rg",
          ["--files-with-matches", ...rgFlags(req.body), "--", q, "."],
          { cwd: repoDir, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
        );
        matched = stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 1) return { files: 0, replacements: 0 };
        if (code === 2) return reply.code(400).send({ error: "invalid pattern" });
        req.log.error(err, "replace search failed");
        return reply.code(500).send({ error: "replace failed" });
      }
      let files = 0;
      let replacements = 0;
      for (const rel of matched.slice(0, 500)) {
        const abs = resolveInsideRepos(req.params.name, rel);
        const before = await fs.readFile(abs, "utf8");
        let n = 0;
        let after: string;
        if (req.body.regex) {
          // String replacement so "$1" backreferences work.
          n = (before.match(re) ?? []).length;
          after = before.replace(re, replacement);
        } else {
          // Function replacement keeps "$&" etc. in the replacement literal.
          after = before.replace(re, () => {
            n++;
            return replacement;
          });
        }
        if (n > 0) {
          await fs.writeFile(abs, after);
          files++;
          replacements += n;
        }
      }
      return { files, replacements };
    },
  );

  app.post<{ Params: { name: string }; Body: { paths: string[] } }>(
    "/api/projects/:name/git/discard",
    { schema: { body: pathsBody } },
    async (req, reply) => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      let paths: string[];
      try {
        paths = req.body.paths.map(repoRelPath);
      } catch {
        return reply.code(403).send({ error: "denied" });
      }
      // VS Code semantics: untracked files are deleted, tracked files restored
      // to their index state (working tree only, staged changes untouched).
      try {
        const { stdout } = await exec(
          "git",
          ["-C", repoDir, "status", "--porcelain=v1", "-uall", "--", ...paths],
          { env: GIT_ENV },
        );
        const untracked: string[] = [];
        const tracked: string[] = [];
        for (const line of stdout.split("\n").filter(Boolean)) {
          let p = line.slice(3);
          const arrow = p.indexOf(" -> ");
          if (arrow !== -1) p = p.slice(arrow + 4);
          p = p.replace(/^"(.*)"$/, "$1");
          (line[0] === "?" ? untracked : tracked).push(p);
        }
        for (const p of untracked) {
          await fs.rm(resolveInsideRepos(req.params.name, p), { force: true });
        }
        if (tracked.length > 0) {
          await exec("git", ["-C", repoDir, "restore", "--", ...tracked], { env: GIT_ENV });
        }
      } catch (err) {
        req.log.error(err, "git discard failed");
        return reply.code(409).send({ error: "discard failed" });
      }
      return { ok: true };
    },
  );
}
