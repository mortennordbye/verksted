import { exec } from "./exec.js";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  BranchSync,
  SessionChangedFile,
  SessionCommit,
  SessionWork,
} from "../../shared/api.js";

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
    const x = entry[0];
    out.push({ x, y: entry[1], path: entry.slice(3) });
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

/** HEAD's commit, or null on anything that is not a repo with a commit in it. */
export async function headCommit(repoDir: string): Promise<string | null> {
  try {
    return await git(repoDir, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

/** Commits on the current branch that its upstream has not; null without one. */
async function unpushed(repoDir: string): Promise<number | null> {
  try {
    return Number(await git(repoDir, ["rev-list", "--count", "@{u}..HEAD"]));
  } catch {
    // No upstream configured: nothing has ever pushed this branch, and there is
    // no count to give — which the UI says in words rather than as a number.
    return null;
  }
}

/**
 * How far the repo moved from `from`, for showing beside a finished session.
 *
 * Null when the measurement cannot be trusted rather than a zeroed one: `from`
 * unreachable means the branch was reset, or the session ended somewhere with
 * no path back to where it began, and "0 commits" would be a claim rather than
 * an answer.
 */
export async function workSince(repoDir: string, from: string): Promise<SessionWork | null> {
  try {
    const range = `${from}..HEAD`;
    const changed = await git(repoDir, ["diff", "--name-only", range]);
    return {
      commits: Number(await git(repoDir, ["rev-list", "--count", range])),
      files: changed ? changed.split("\n").length : 0,
      dirty: parsePorcelainZ(await gitRaw(repoDir, ["status", "--porcelain=v1", "-z"])).length,
      unpushed: await unpushed(repoDir),
      branch: await branchOf(repoDir),
    };
  } catch {
    return null;
  }
}

/** Caps on one range's answer. A rebase or a merge of a long branch is the case
 *  that runs away; past these the phone is the wrong place to read it anyway. */
const MAX_COMMITS = 100;
const MAX_FILES = 500;

/**
 * Parse `git diff --numstat -z`.
 *
 * -z for the same reason parsePorcelainZ needs it: without it any path that is
 * not plain ASCII arrives C-quoted, and every path shown would then be one the
 * per-file diff cannot ask for. Two record shapes come out of it:
 *
 *   "12\t3\tpath\0"                  ordinary, "-\t-\t" when the file is binary
 *   "0\t0\t\0oldpath\0newpath\0"     a rename, whose path field is empty
 */
export function parseNumstatZ(stdout: string): SessionChangedFile[] {
  const parts = stdout.split("\0");
  const out: SessionChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
    if (!m) continue;
    // The rename shape: the two records after it are the old and the new path,
    // and the new one is what the file is called now.
    const path = m[3] || parts[i + 2];
    if (!m[3]) i += 2;
    if (!path) continue;
    out.push({
      path,
      added: m[1] === "-" ? 0 : Number(m[1]),
      removed: m[2] === "-" ? 0 : Number(m[2]),
      binary: m[1] === "-",
    });
  }
  return out;
}

/**
 * What a commit range did: its subjects, and the files it touched.
 *
 * Two git calls and no file reads — the range is resolved against the object
 * store, so a path in the answer is a path in the repo by construction.
 */
export async function changesIn(
  repoDir: string,
  from: string,
  to: string,
): Promise<{ commits: SessionCommit[]; files: SessionChangedFile[]; truncated: boolean }> {
  const range = `${from}..${to}`;
  // %x00 rather than a printable separator: a subject can contain anything.
  const log = await git(repoDir, [
    "log",
    `--max-count=${MAX_COMMITS + 1}`,
    "--format=%h%x00%s",
    range,
  ]);
  const lines = log ? log.split("\n") : [];
  const files = parseNumstatZ(await gitRaw(repoDir, ["diff", "--numstat", "-z", range]));
  return {
    commits: lines.slice(0, MAX_COMMITS).map((l) => {
      const [sha, subject] = l.split("\0");
      return { sha, subject: subject ?? "" };
    }),
    files: files.slice(0, MAX_FILES),
    truncated: lines.length > MAX_COMMITS || files.length > MAX_FILES,
  };
}

/** Cap on the whole-range patch. A megabyte is more than a night of work and
 *  about as much as a phone will scroll; past it the terminal is the place. */
const MAX_PATCH_BYTES = 1024 * 1024;

/**
 * The whole range as one patch, for reading a run end to end.
 *
 * Cut at a file boundary rather than mid-hunk: the reader splits this back into
 * files, and half a `diff --git` header would come out as a file whose name is
 * a fragment. Only a single file bigger than the whole cap falls back to a
 * blunt cut, which is already unreadable by then.
 */
export async function rangeDiff(
  repoDir: string,
  from: string,
  to: string,
): Promise<{ diff: string; truncated: boolean }> {
  // quotePath=false so a non-ASCII path arrives spelled the way the -z file
  // list spells it; the reader matches the two against each other.
  const out = await gitRaw(repoDir, ["-c", "core.quotePath=false", "diff", `${from}..${to}`]);
  if (out.length <= MAX_PATCH_BYTES) return { diff: out, truncated: false };
  const boundary = out.lastIndexOf("\ndiff --git ", MAX_PATCH_BYTES);
  return {
    diff: boundary > 0 ? out.slice(0, boundary + 1) : out.slice(0, MAX_PATCH_BYTES),
    truncated: true,
  };
}

/** One file's diff over a range. The path is a client's, so it is a pathspec
 *  and nothing else — literal, and after the `--` that ends the options. */
export async function fileDiffIn(
  repoDir: string,
  from: string,
  to: string,
  relPath: string,
): Promise<string> {
  return gitRaw(repoDir, ["diff", `${from}..${to}`, "--", relPath], {
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
  });
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
    return m ? path.basename(m[1]) : null;
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
