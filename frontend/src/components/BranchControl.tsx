import { useState } from "react";
import type { GitBranches } from "../../../shared/api";
import { api, usePoll } from "../api";
import { useConfirm } from "../useConfirm";
import Icon from "./Icon";
import Sheet from "./Sheet";
import { SkeletonLines } from "./Skeleton";
import Button from "./ui/Button";
import { Input } from "./ui/Field";
import Notice from "./ui/Notice";

/**
 * The branch label, clickable: switch branch, pull, push, or reset the branch
 * to its upstream. Pull is always fast-forward. The two destructive ways out of
 * a diverged branch, reset and force push, both ask first.
 */
type Op = "pull" | "push" | "force" | "reset" | "checkout";

/** What the banner says while an operation runs. */
const DOING: Record<Op, string> = {
  pull: "Pulling",
  push: "Pushing",
  force: "Force-pushing",
  reset: "Resetting",
  checkout: "Switching",
};

/**
 * A pull or push talks to the remote, and on a slow link or a large repo that
 * takes longer than the app's default request timeout: the button used to say
 * "working…" and then an error that the request timed out, while git carried on.
 */
const GIT_TIMEOUT_MS = 2 * 60_000;

export default function BranchControl({
  project,
  branch,
  className,
  onChanged,
}: {
  project: string;
  branch: string;
  className: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Which operation is running, rather than a bare busy flag: every button said
  // "working…" at once, so nothing said which one had been pressed.
  const [working, setWorking] = useState<Op | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const { data, refresh } = usePoll<GitBranches>(
    open ? `/api/projects/${encodeURIComponent(project)}/git/branches` : null,
    15_000,
  );
  const busy = working !== null;

  /**
   * Run one operation and say how it went, in a line that stays until the next
   * one: a pull that finished used to look exactly like a pull that did nothing.
   */
  async function run(op: Op, fn: () => Promise<unknown>, said: string) {
    if (busy) return;
    setWorking(op);
    setError(null);
    setResult(null);
    try {
      await fn();
      setResult(said);
      refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  const post = (op: string, body?: unknown) =>
    api(`/api/projects/${encodeURIComponent(project)}/git/${op}`, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: GIT_TIMEOUT_MS,
    });

  const switchTo = (to: string) =>
    void run(
      "checkout",
      async () => {
        await post("checkout", { branch: to });
        setOpen(false);
      },
      `Switched to ${to}`,
    );

  const upstream = data?.upstream ?? null;
  const current = data?.current ?? branch;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function pull() {
    // Counted before the pull, from the last fetch: a count of zero may only
    // mean nothing had been fetched yet, so it says "pulled" rather than
    // claiming there was nothing new.
    const behind = data?.behind ?? 0;
    void run(
      "pull",
      () => post("pull"),
      behind
        ? `Pulled ${plural(behind, "commit")} from ${upstream}`
        : `Pulled from ${upstream}; ${current} is up to date`,
    );
  }

  function push() {
    const ahead = data?.ahead ?? 0;
    void run(
      "push",
      () => post("push"),
      upstream
        ? `Pushed ${plural(ahead, "commit")} to ${upstream}`
        : `Published ${current} on origin`,
    );
  }

  async function forcePush() {
    if (
      !(await confirm({
        title: `Force push ${current} to ${upstream}?`,
        body: "Commits on the remote that are not on this branch are overwritten. It refuses if the remote has commits this repo has not fetched.",
        action: "force push",
        danger: true,
      }))
    ) {
      return;
    }
    void run(
      "force",
      () => post("push", { force: true }),
      `Force-pushed ${current} to ${upstream}`,
    );
  }

  async function reset() {
    if (
      !(await confirm({
        title: `Reset ${current} to ${upstream}?`,
        body: "Commits and changes to tracked files that are not on the remote are lost. Untracked files are left alone.",
        action: "reset the branch",
        danger: true,
      }))
    ) {
      return;
    }
    void run("reset", () => post("reset"), `Reset ${current} to ${upstream}`);
  }

  const local = data?.local ?? [];
  // Publishing a branch nobody tracks yet is the one push that is always worth
  // offering; after that the button waits for something to send.
  const canPush = !!data && (!upstream || data.ahead > 0);
  // Remote-only branches switch by their short name: git makes the local
  // tracking branch on the way.
  const remoteOnly = (data?.remote ?? [])
    .map((r) => r.slice(r.indexOf("/") + 1))
    .filter((short) => !local.includes(short));
  const matches = (b: string) => b.toLowerCase().includes(filter.trim().toLowerCase());
  // Force only has something to overwrite with once there is a commit to send.
  const canForce = !!data && !!upstream && data.ahead > 0;
  const target = working === "push" ? (upstream ?? "origin") : upstream;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="switch branch, pull, push"
        className={`inline-flex items-center gap-1.5 ${className}`}
      >
        <Icon name="branch" size={13} />
        {branch}
      </button>
      {open && (
        <Sheet
          title={`Branch in ~/${project}`}
          sub={
            data
              ? `on ${data.current}${upstream ? ` · tracking ${upstream}` : " · no upstream"}`
              : "…"
          }
          onClose={() => !busy && setOpen(false)}
        >
          {/* Where the branch stands against its upstream, as marks rather than a
              clause at the end of the subtitle. */}
          {data && upstream && (
            <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[12px]">
              <span
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${
                  data.behind ? "bg-wait/10 text-wait" : "bg-surface-2 text-faint"
                }`}
              >
                <Icon name="pull" size={12} />
                {data.behind} behind
              </span>
              <span
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${
                  data.ahead ? "bg-accent-tint text-accent" : "bg-surface-2 text-faint"
                }`}
              >
                <Icon name="push" size={12} />
                {data.ahead} ahead
              </span>
            </div>
          )}

          {/* One line for what is happening now, what just happened, or what went
              wrong, in that order of precedence. */}
          {working && (
            <Notice kind="busy" className="mb-3">
              {DOING[working]}
              {working === "pull" && ` from ${target}`}
              {(working === "push" || working === "force" || working === "reset") &&
                ` to ${target}`}
              …
            </Notice>
          )}
          {!working && result && (
            <Notice kind="ok" className="mb-3">
              {result}
            </Notice>
          )}
          {!working && error && (
            <Notice kind="fail" className="mb-3">
              {error}
            </Notice>
          )}

          <div className="mb-3 flex flex-wrap gap-2">
            <Button
              onClick={pull}
              disabled={busy || !upstream}
              title={upstream ? `fast-forward from ${upstream}` : "no upstream to pull from"}
              variant="primary"
              size="lg"
              className="flex-1"
            >
              <Icon name="pull" size={15} />
              {working === "pull" ? "pulling…" : "pull"}
            </Button>
            <Button
              onClick={push}
              disabled={busy || !canPush}
              title={upstream ? `push to ${upstream}` : "publish the branch on origin"}
              variant="primary"
              size="lg"
              className="flex-1"
            >
              <Icon name="push" size={15} />
              {working === "push" ? "pushing…" : upstream ? "push" : "publish"}
            </Button>
            <Button
              onClick={() => void forcePush()}
              disabled={busy || !canForce}
              title={
                canForce
                  ? `overwrite ${upstream} with this branch`
                  : "nothing on this branch to force over the remote"
              }
              variant="ghost-danger"
              size="lg"
              className="flex-none"
            >
              <Icon name="push" size={15} />
              {working === "force" ? "forcing…" : "force push"}
            </Button>
            <Button
              onClick={() => void reset()}
              disabled={busy || !upstream}
              title="discard local commits and changes on this branch"
              aria-label="discard local commits and changes on this branch"
              variant="ghost-danger"
              size="lg"
              className="flex-none"
            >
              <Icon name="reset" size={15} />
              {working === "reset" ? "resetting…" : `reset to ${upstream ?? "upstream"}`}
            </Button>
          </div>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter branches"

            label="filter branches"
            mono
            size="lg"
            className="w-full"
          />
          <div className="mt-2 max-h-[38vh] overflow-auto">
            {!data && <SkeletonLines count={4} className="px-2.5 py-2" />}
            {local.filter(matches).map((b) => (
              <BranchRow
                key={b}
                name={b}
                current={b === data?.current}
                busy={busy}
                onClick={() => switchTo(b)}
              />
            ))}
            {remoteOnly.filter(matches).map((b) => (
              <BranchRow
                key={`remote/${b}`}
                name={b}
                remote
                busy={busy}
                onClick={() => switchTo(b)}
              />
            ))}
            {data && local.length + remoteOnly.length === 0 && (
              <div className="px-1 py-2 text-[13px] text-faint">no branches yet</div>
            )}
          </div>
        </Sheet>
      )}
      {confirmDialog}
    </>
  );
}

function BranchRow({
  name,
  current,
  remote,
  busy,
  onClick,
}: {
  name: string;
  current?: boolean;
  remote?: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || current}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[12.5px] disabled:opacity-100 ${
        current ? "text-text" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      <span className="flex w-4 flex-none justify-center text-accent">
        {current ? (
          <Icon name="check" size={13} />
        ) : (
          <Icon name="branch" size={13} className="text-faint" />
        )}
      </span>
      <span className="min-w-0 truncate">{name}</span>
      {remote && <span className="ml-auto flex-none text-[11px] text-faint">remote</span>}
    </button>
  );
}
