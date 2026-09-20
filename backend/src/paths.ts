import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class PathDeniedError extends Error {
  constructor() {
    super("denied");
  }
}

/**
 * Resolve a client-supplied project name (and optional repo-relative path) to a
 * real absolute path, guaranteed to live inside the project directory under the
 * repos root. Everything the backend reads from disk on behalf of a client goes
 * through here. Throws PathDeniedError on any escape attempt, bad name, or
 * nonexistent path — deliberately indistinguishable to the caller.
 *
 * `.git` is out of bounds too: the tree hides it, but without this the file
 * endpoints would still read `.git/config` (remote URLs, tokens) and write
 * `.git/hooks/pre-commit`, which the commit route then executes.
 */
export function resolveInsideRepos(
  projectName: string,
  relPath = "",
  reposDir = env.REPOS_DIR,
): string {
  if (!PROJECT_NAME_RE.test(projectName)) throw new PathDeniedError();
  let projDir: string;
  let real: string;
  try {
    const root = fs.realpathSync(reposDir);
    projDir = fs.realpathSync(path.resolve(root, projectName));
    if (projDir !== path.resolve(root, projectName)) throw new PathDeniedError();
    real = fs.realpathSync(path.resolve(projDir, relPath));
  } catch {
    throw new PathDeniedError();
  }
  if (real !== projDir && !real.startsWith(projDir + path.sep)) {
    throw new PathDeniedError();
  }
  // Checked on the realpath, so a symlink pointing into .git is caught too. In a
  // linked worktree `.git` is a file rather than a directory; both are denied.
  const rel = path.relative(projDir, real);
  if (rel !== "" && rel.split(path.sep).includes(".git")) {
    throw new PathDeniedError();
  }
  return real;
}

/**
 * Where a leaf the client names lives: its directory resolved the usual way,
 * the last component joined on without being resolved.
 *
 * What writes and deletes want, rather than resolveInsideRepos. The file need
 * not exist yet, and where one does, a symlink standing in its place must be
 * the thing acted on and not whatever it points at: a cloned repo shipping
 * `notes -> /data/settings.json` otherwise turns a write inside the project
 * into a write the scoping above has already approved. Refusing the symlink
 * outright is the caller's job (O_NOFOLLOW, or lstat before the write) —
 * this only keeps the path lexical so there is something to refuse.
 */
export function leafInsideRepos(
  projectName: string,
  relPath: string,
  reposDir = env.REPOS_DIR,
): string {
  const rel = repoRelPath(relPath);
  const base = path.basename(rel);
  // "." and ".." name the directory, not a leaf in it; ".git" is out of bounds
  // whole, the way it is for every component resolveInsideRepos walks (in a
  // linked worktree it is a file, and writing it repoints the checkout).
  if (base === "." || base === ".." || base === ".git") throw new PathDeniedError();
  return path.join(resolveInsideRepos(projectName, path.dirname(rel), reposDir), base);
}

/**
 * The same discipline for a root that is not the repos: a path from a client
 * or a model resolves to a real path inside `root`, or is denied. No `.git`
 * rule, since the roots this serves hold documents rather than checkouts.
 */
export function resolveInside(root: string, relPath = ""): string {
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.resolve(realRoot, relPath));
  } catch {
    throw new PathDeniedError();
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new PathDeniedError();
  return real;
}

/**
 * Validate a client-supplied repo-relative path for use as a git pathspec.
 * Unlike resolveInsideRepos it must accept paths that no longer exist on disk
 * (staged deletions), so the check is lexical: relative and no ".." escape.
 * Callers must run git with GIT_LITERAL_PATHSPECS=1 so pathspec magic (":/…")
 * cannot reinterpret the value.
 */
export function repoRelPath(relPath: string): string {
  if (!relPath || relPath.includes("\0") || path.isAbsolute(relPath)) {
    throw new PathDeniedError();
  }
  const norm = path.normalize(relPath);
  if (norm === ".." || norm.startsWith(".." + path.sep)) throw new PathDeniedError();
  return norm;
}

/**
 * Resolve a project (and optional path) or answer 404, which every route did
 * with its own four-line try/catch — seventeen copies in files.ts alone.
 *
 * Returns null when it replied, so the caller's next line is `if (!dir) return;`.
 * A missing project and a denied path are deliberately the same answer: the
 * difference tells a caller whether a name exists, which is the one thing the
 * scoping is there to hide.
 */
export function repoDirOr404(
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  projectName: string,
  relPath = "",
): string | null {
  try {
    return resolveInsideRepos(projectName, relPath);
  } catch {
    reply.code(404).send({ error: "not found" });
    return null;
  }
}
