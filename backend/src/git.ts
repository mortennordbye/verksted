import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { BranchSync } from "../../shared/api.js";

const exec = promisify(execFile);

/**
 * Raw stdout, untrimmed. Porcelain -z output can legitimately begin with a
 * space — " M path" is "modified in the worktree" — and trimming it would shift
 * every field of the first entry by one character.
 */
export async function gitRaw(
  repoDir: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoDir, ...args], {
    env: opts.env,
    // Without these, execFile's 1 MB default silently truncates and kills the
    // call, and every caller reads that as "clean" or "no files" — a wrong UI
    // rather than an error. A big status or diff really does exceed 1 MB.
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeout ?? 15_000,
  });
  return stdout;
}

export async function git(
  repoDir: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  return (await gitRaw(repoDir, args, opts)).trim();
}

export interface PorcelainEntry {
  /** Index status. */
  x: string;
  /** Worktree status. */
  y: string;
  path: string;
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * -z is not optional here. Without it git C-quotes any path that is not plain
 * printable ASCII, so "æ.txt" arrives as "\303\246.txt" — and every consumer
 * (the modified marker in the tree, stage, discard) then acts on a path that
 * does not exist, silently missing the file. -z emits the raw bytes and
 * NUL-terminates them instead, which also removes the ambiguity of splitting a
 * rename on " -> " when a filename contains that sequence.
 *
 * A rename or copy entry is followed by a second field holding the source
 * path. Callers want the destination, so the source field is skipped.
 */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const parts = stdout.split("\0");
  const out: PorcelainEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    // "XY " plus at least one character of path.
    if (!entry || entry.length < 4) continue;
    const x = entry[0]!;
    out.push({ x, y: entry[1]!, path: entry.slice(3) });
    if (x === "R" || x === "C") i++;
  }
  return out;
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
