import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { BranchSync } from "../../shared/api.js";

const exec = promisify(execFile);

export async function git(
  repoDir: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoDir, ...args], opts);
  return stdout.trim();
}

export async function branchOf(repoDir: string): Promise<string> {
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

/** First useful line of a failed git command's stderr, for showing to the user. */
export function gitError(err: unknown): string {
  const line = String((err as { stderr?: string }).stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("hint:"));
  return (line ?? "git failed").slice(0, 200);
}

/**
 * Main-repo name if `dir` is a linked git worktree under REPOS_DIR, else null.
 * A worktree's .git is a file: "gitdir: <main>/.git/worktrees/<id>".
 */
export async function worktreeParent(dir: string): Promise<string | null> {
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

/** The repo's default branch: origin's HEAD, else main/master, else null. */
export async function defaultBranch(repoDir: string): Promise<string | null> {
  try {
    return (await git(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(
      /^origin\//,
      "",
    );
  } catch {
    // no origin, or a repo whose origin/HEAD was never set
  }
  for (const name of ["main", "master"]) {
    try {
      await git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      return name;
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * Put the repo on its default branch and fast-forward it, so a new session
 * starts from an up-to-date main. Never destroys work: a linked worktree, a
 * dirty tree, or a pull that cannot fast-forward leaves the repo untouched and
 * reports why.
 */
export async function syncDefaultBranch(
  repoDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<BranchSync> {
  const skip = async (detail: string): Promise<BranchSync> => ({
    branch: await branchOf(repoDir),
    status: "skipped",
    detail,
  });
  try {
    const parent = await worktreeParent(repoDir);
    if (parent) return await skip(`linked worktree of ${parent}`);
    const target = await defaultBranch(repoDir);
    if (!target) return await skip("no main branch");
    if ((await git(repoDir, ["status", "--porcelain"])) !== "") {
      return await skip("uncommitted changes");
    }
    if ((await branchOf(repoDir)) !== target) await git(repoDir, ["switch", target]);
    // A repo with no remote (git init) is as up to date as it gets.
    if ((await git(repoDir, ["remote"])) !== "") {
      await git(repoDir, ["pull", "--ff-only"], {
        env: { ...process.env, ...extraEnv },
        timeout: 120_000,
      });
    }
    return { branch: target, status: "synced" };
  } catch (err) {
    return { branch: await branchOf(repoDir), status: "failed", detail: gitError(err) };
  }
}
