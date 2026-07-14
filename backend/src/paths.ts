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
