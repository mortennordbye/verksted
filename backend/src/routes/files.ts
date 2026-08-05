import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  FileDiff,
  GitBranches,
  GitFileStatus,
  GitStatus,
  ReplaceResult,
  SearchFlags,
  SearchHit,
  TreeNode,
  UploadedFile,
} from "../../../shared/api.js";
import { branchOf, git, gitError, gitRaw, parsePorcelainZ } from "../git.js";
import { repoRelPath, resolveInsideRepos } from "../paths.js";
import { execEnv } from "../settings-store.js";
import { ReplaceTimeout, runReplace } from "../replace.js";

const exec = promisify(execFile);

// Literal pathspecs: client-supplied paths can never be pathspec magic/globs.
const GIT_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_DEPTH = 12;
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * A file's version, for lost-update detection on save.
 *
 * Content hash rather than mtime and size: those collide whenever two writes
 * land in the same millisecond at the same length, which is exactly what an
 * automated writer does — and a missed collision here means silently
 * overwriting the agent's work. Hashing also treats "changed and changed back"
 * as unchanged, which is the answer the user would want anyway.
 */
function contentEtag(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

/** The etag of what is on disk now, or null when there is no file there. */
async function etagOnDisk(abs: string): Promise<string | null> {
  const buf = await fs.readFile(abs).catch(() => null);
  return buf ? contentEtag(buf) : null;
}

async function modifiedPaths(repoDir: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const out = await gitRaw(repoDir, ["status", "--porcelain=v1", "-z", "-uall"]);
    for (const { path } of parsePorcelainZ(out)) set.add(path);
  } catch {
    // not a git repo / git broke: no markers
  }
  return set;
}

/**
 * Branch names under a ref prefix ("refs/heads" -> "main", "refs/remotes" ->
 * "origin/main"). Full refnames, shortened here: git shortens
 * refs/remotes/origin/HEAD to "origin" from 2.41 and "origin/HEAD" before it,
 * and that symref is not a branch either way.
 */
async function refNames(repoDir: string, prefix: string): Promise<string[]> {
  try {
    const out = await git(repoDir, ["for-each-ref", "--format=%(refname)", "--sort=refname", prefix]);
    return out
      .split("\n")
      .filter((r) => r && !r.endsWith("/HEAD"))
      .map((r) => r.slice(prefix.length + 1));
  } catch {
    return [];
  }
}

/** "origin/main" for the current branch, or null when it tracks nothing. */
async function upstreamOf(repoDir: string): Promise<string | null> {
  try {
    return await git(repoDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return null;
  }
}

// Phone uploads land here: hidden, and kept out of git so screenshots never
// show up as untracked noise (or get committed by an agent).
const UPLOAD_DIR = ".verksted/uploads";

/**
 * Ignore UPLOAD_DIR via .git/info/exclude — repo-local and untracked, so the
 * project's own .gitignore is never touched. --git-common-dir resolves the real
 * git dir, which in a linked worktree is not the local ".git" (a file there).
 */
async function excludeUploads(repoDir: string): Promise<void> {
  try {
    const { stdout } = await exec("git", ["-C", repoDir, "rev-parse", "--git-common-dir"]);
    const file = path.resolve(repoDir, stdout.trim(), "info", "exclude");
    const cur = await fs.readFile(file, "utf8").catch(() => "");
    if (cur.split("\n").includes(".verksted/")) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${!cur || cur.endsWith("\n") ? "" : "\n"}.verksted/\n`);
  } catch {
    // not a git repo: nothing to exclude
  }
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
      // The agent shares this working tree, so the file can vanish between the
      // resolve and the stat. That is a 404, not a 500.
      const stat = await fs.lstat(abs).catch(() => null);
      if (!stat) return reply.code(404).send({ error: "not found" });
      if (!stat.isFile()) return reply.code(403).send({ error: "denied" });
      if (stat.size > MAX_FILE_BYTES) return reply.code(413).send({ error: "file too large" });
      const buf = await fs.readFile(abs).catch(() => null);
      if (!buf) return reply.code(404).send({ error: "not found" });
      if (buf.subarray(0, 8192).includes(0)) {
        return reply.code(415).send({ error: "binary file" });
      }
      return { path: req.query.path, content: buf.toString("utf8"), etag: contentEtag(buf) };
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
      const stat = await fs.lstat(abs).catch(() => null);
      if (!stat) return reply.code(404).send({ error: "not found" });
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
      const abs = path.join(dir, path.basename(rel));

      // Optional precondition: a client that read the file and sends back its
      // etag gets a 412 instead of silently overwriting whatever the agent
      // wrote in between. "*" means "must already exist"; no header at all
      // keeps the old blind-write behaviour for callers that never read first.
      const expected = req.headers["if-match"];
      if (expected !== undefined) {
        const actual = await etagOnDisk(abs);
        if (expected === "*" ? actual === null : actual !== expected) {
          return reply
            .code(412)
            .send({ error: "the file changed on disk since you opened it", etag: actual });
        }
      }

      await fs.writeFile(abs, body);
      return { path: rel, bytes: body.length, etag: contentEtag(body) };
    },
  );

  // Upload from a phone (a screenshot or photo, where there is no clipboard to
  // paste from) and get back a repo-relative path to hand to the agent. Unlike
  // PUT /file it creates its directory, never overwrites, and hides the result
  // from git. The filename is decoration only — the stamped prefix owns
  // uniqueness, and basename + allowlist mean nothing but a name reaches disk.
  app.post<{ Params: { name: string }; Querystring: { filename: string } }>(
    "/api/projects/:name/upload",
    {
      bodyLimit: MAX_RAW_BYTES,
      schema: {
        querystring: {
          type: "object",
          required: ["filename"],
          additionalProperties: false,
          properties: { filename: { type: "string", minLength: 1, maxLength: 255 } },
        },
      },
    },
    async (req, reply): Promise<UploadedFile | void> => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(415).send({ error: "raw body required" });
      }
      const safe = path
        .basename(req.query.filename)
        .replace(/[^\w.-]/g, "_")
        .replace(/^\.+/, "")
        .slice(-100);
      // Date, time, millis: readable, and two quick taps cannot collide.
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .replace(/\.(\d+)Z$/, "$1");
      const rel = `${UPLOAD_DIR}/${stamp}-${safe}`;
      await fs.mkdir(path.join(repoDir, UPLOAD_DIR), { recursive: true });
      await excludeUploads(repoDir);
      await fs.writeFile(path.join(repoDir, rel), body);
      return { path: rel };
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
        const out = await gitRaw(repoDir, ["status", "--porcelain=v1", "-z", "-uall"]);
        for (const { x, y, path: p } of parsePorcelainZ(out)) {
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
        // execEnv so GIT_AUTHOR_*/GIT_COMMITTER_* from the settings page apply.
        await exec("git", ["-C", repoDir, "commit", "-m", message], {
          env: { ...process.env, ...(await execEnv()) },
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

  app.get<{ Params: { name: string } }>(
    "/api/projects/:name/git/branches",
    async (req, reply): Promise<GitBranches | void> => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      return {
        current: await branchOf(repoDir),
        local: await refNames(repoDir, "refs/heads"),
        remote: await refNames(repoDir, "refs/remotes"),
        upstream: await upstreamOf(repoDir),
      };
    },
  );

  app.post<{ Params: { name: string }; Body: { branch: string } }>(
    "/api/projects/:name/git/checkout",
    {
      schema: {
        body: {
          type: "object",
          required: ["branch"],
          additionalProperties: false,
          properties: { branch: { type: "string", minLength: 1, maxLength: 200 } },
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
      try {
        // A name that only exists on one remote gets a local tracking branch
        // here, which is why this is switch and not checkout of a ref.
        await git(repoDir, ["switch", branch], { timeout: 60_000 });
      } catch (err) {
        req.log.error(err, "git switch failed");
        return reply.code(409).send({ error: gitError(err) });
      }
      return { branch: await branchOf(repoDir) };
    },
  );

  app.post<{ Params: { name: string } }>(
    "/api/projects/:name/git/pull",
    async (req, reply) => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!(await upstreamOf(repoDir))) {
        return reply.code(409).send({ error: "branch has no upstream" });
      }
      try {
        // ff-only: a diverged branch is a decision for the user, not a merge
        // commit made behind their back. The reset route is the way out.
        await git(repoDir, ["pull", "--ff-only"], {
          env: { ...process.env, ...(await execEnv()) },
          timeout: 120_000,
        });
      } catch (err) {
        req.log.error(err, "git pull failed");
        return reply.code(409).send({ error: gitError(err) });
      }
      return { branch: await branchOf(repoDir) };
    },
  );

  // Destructive: drops local commits and tracked-file changes on the current
  // branch to match its upstream. Untracked files are left alone.
  app.post<{ Params: { name: string } }>(
    "/api/projects/:name/git/reset",
    async (req, reply) => {
      let repoDir: string;
      try {
        repoDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      const upstream = await upstreamOf(repoDir);
      if (!upstream) return reply.code(409).send({ error: "branch has no upstream" });
      try {
        await git(repoDir, ["fetch", upstream.slice(0, upstream.indexOf("/"))], {
          env: { ...process.env, ...(await execEnv()) },
          timeout: 120_000,
        });
        await git(repoDir, ["reset", "--hard", upstream]);
      } catch (err) {
        req.log.error(err, "git reset failed");
        return reply.code(409).send({ error: gitError(err) });
      }
      return { branch: await branchOf(repoDir) };
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
      const paths: string[] = [];
      for (const rel of matched.slice(0, 500)) {
        try {
          paths.push(resolveInsideRepos(req.params.name, rel));
        } catch {
          // Gone, or now out of bounds — rg listed it a moment ago.
        }
      }
      // Off-thread: the pattern is client input and can backtrack forever.
      try {
        return await runReplace({
          paths,
          source: re.source,
          flags: re.flags,
          replacement,
          literal: !req.body.regex,
        });
      } catch (err) {
        if (err instanceof ReplaceTimeout) {
          return reply.code(400).send({ error: "pattern too slow — narrow it and try again" });
        }
        req.log.error(err, "replace failed");
        return reply.code(500).send({ error: "replace failed" });
      }
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
        const out = await gitRaw(repoDir, ["status", "--porcelain=v1", "-z", "-uall", "--", ...paths], {
          env: GIT_ENV,
        });
        const untracked: string[] = [];
        const tracked: string[] = [];
        for (const { x, path: p } of parsePorcelainZ(out)) {
          (x === "?" ? untracked : tracked).push(p);
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
