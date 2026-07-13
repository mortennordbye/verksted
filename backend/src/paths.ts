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
