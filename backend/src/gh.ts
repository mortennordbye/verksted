import { exec } from "./exec.js";
import { execEnv } from "./settings-store.js";
import type { PullRequest, RunLog } from "../../shared/api.js";

/** A failed gh call, already mapped to what the client should see. */
export class GhError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Run gh inside a project. cwd is the checkout, so gh resolves owner/repo from
 * its remote — client input never names a repository. GH_TOKEN comes from the
 * settings page, the same way the clone route gets it; reading it per call means
 * a token pasted into settings works on the next request with no restart.
 */
export async function gh(
  repoDir: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<string> {
  try {
    const { stdout } = await exec("gh", args, {
      cwd: repoDir,
      env: {
        ...process.env,
        ...(await execEnv()),
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
      },
      timeout: opts.timeout ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    throw ghError(err);
  }
}

export async function ghJson<T>(
  repoDir: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<T> {
  const out = await gh(repoDir, args, opts);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new GhError(502, "unreadable gh output");
  }
}

/** Map a failed gh call to a status and a message that says what to do about it. */
export function ghError(err: unknown): GhError {
  const e = err as { stderr?: string; code?: string | number; killed?: boolean };
  if (e.code === "ENOBUFS") return new GhError(413, "too much output — open it on GitHub");
  if (e.killed) return new GhError(502, "GitHub timed out");
  const stderr = String(e.stderr ?? "");
  if (/gh auth login|GH_TOKEN environment variable/i.test(stderr)) {
    return new GhError(409, "GitHub token not set — add GH_TOKEN in settings");
  }
  if (/HTTP 401|Bad credentials/i.test(stderr)) {
    return new GhError(409, "GitHub token rejected — check GH_TOKEN in settings");
  }
  if (/missing required scopes|HTTP 403/i.test(stderr)) {
    return new GhError(409, "GitHub token is missing a scope — needs repo + workflow");
  }
  if (/rate limit/i.test(stderr)) {
    return new GhError(429, "GitHub rate limit reached — try again in a bit");
  }
  if (/no git remotes found|not a git repository/i.test(stderr)) {
    return new GhError(409, "no GitHub remote in this project");
  }
  if (/could not resolve to a Repository|HTTP 404/i.test(stderr)) {
    return new GhError(409, "repository not found on GitHub — check the remote and the token");
  }
  // GitHub refusing an action because of the run's or PR's own state is the
  // user's to resolve, not a server fault — and gh already says it well.
  if (/cannot cancel|cannot be rerun|already running|already requested/i.test(stderr)) {
    return new GhError(409, ghMessage(stderr));
  }
  return new GhError(502, ghMessage(stderr));
}

/**
 * First useful line of a failed gh command's stderr, for showing to the user.
 * Mirrors gitError(). gh does not echo tokens, and this image authenticates
 * through the credential helper rather than an in-URL token.
 */
export function ghMessage(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "gh failed";
  // A trailing colon means the useful part is on the next line — that is how gh
  // reports an existing PR, and the url is the whole point of the message.
  const msg = lines[0]!.endsWith(":") && lines[1] ? `${lines[0]} ${lines[1]}` : lines[0]!;
  return msg.slice(0, 200);
}

/** Collapse a PR's statusCheckRollup into the one word the list row shows. */
export function summarizeChecks(
  rollup: { status?: string; conclusion?: string }[] | null | undefined,
): PullRequest["checks"] {
  if (!rollup || rollup.length === 0) return "none";
  // A CheckRun reports status/conclusion; a legacy StatusContext has neither.
  if (rollup.some((c) => c.status && c.status !== "COMPLETED")) return "pending";
  const bad = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
  return rollup.some((c) => bad.has(c.conclusion ?? "")) ? "failing" : "passing";
}

// GitHub's log API stores colour in caret notation ("^[[36;1m") rather than as a
// real escape byte, so match both — a real ESC shows up in some tools' output.
const ANSI_RE = /(?:\u001b|\^\[)\[[0-9;?]*[ -\/]*[@-~]/g;
const LOG_LINE_RE = /^([^\t]*)\t([^\t]*)\t\d{4}-\d\d-\d\dT[\d:.]+Z ?(.*)$/;

/**
 * `gh run view --log-failed` output, made readable on a phone. GitHub repeats the
 * job and step name on every line and prefixes an ISO timestamp; each step's chunk
 * also carries a BOM, and tool output carries ANSI colour. The two columns become
 * one header per job/step change — repeating them costs a phone's whole width.
 * Oldest lines are dropped first: a failure explains itself at the end.
 */
export function formatRunLog(raw: string, maxChars = 60_000): RunLog {
  const out: string[] = [];
  let seen = "";
  for (const line of raw.replace(/\uFEFF/g, "").replace(ANSI_RE, "").split("\n")) {
    const m = LOG_LINE_RE.exec(line);
    if (!m) {
      if (line.trim()) out.push(line.trimEnd());
      continue;
    }
    const key = `${m[1]} › ${m[2]}`;
    if (key !== seen) {
      seen = key;
      out.push(`${out.length ? "\n" : ""}── ${key} ──`);
    }
    // ##[error] is the signal; only the group markers are noise.
    out.push(m[3]!.replace(/^##\[(?:end)?group\]/, "").trimEnd());
  }
  const log = out.join("\n");
  return log.length <= maxChars
    ? { log, truncated: false }
    : { log: log.slice(log.length - maxChars), truncated: true };
}
