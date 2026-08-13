import fs from "node:fs/promises";
import path from "node:path";

/**
 * A pointer to /etc/verksted/SANDBOX.md in each agent's *global* memory file,
 * so every session in every repo starts knowing that the docker daemon is a
 * sibling — rather than rediscovering it from an empty bind mount.
 *
 * The cluster credential is here for the opposite reason: an empty bind mount at
 * least raises the question, but nothing about a shell suggests that kubectl in
 * it is already talking to the cluster the shell runs in. An agent that is not
 * told has no way to find out, and asks the user for what it could read itself.
 *
 * Global rather than per-project because the constraint belongs to the sandbox,
 * not to any repo: it is equally true in a project verksted has never seen. A
 * pointer rather than the text because the file is the agent's context budget,
 * and the details only matter once it actually reaches for docker.
 *
 * The memory files are the user's, on the data volume, and may hold their own
 * notes. Only the marked block is ours: everything outside it is left exactly
 * as written, and rewriting on every boot means editing SANDBOX.md's summary
 * propagates without anyone cleaning up a stale copy.
 */
const START = "<!-- verksted:sandbox start -->";
const END = "<!-- verksted:sandbox end -->";

const BLOCK = [
  "This machine is a verksted session container. The docker daemon is a sibling",
  "container, so bind mounts only resolve for paths under /data, and published",
  "ports do not answer on localhost. Read /etc/verksted/SANDBOX.md before running",
  "docker, docker compose, or a project's make targets, and run `vk doctor` to",
  "check the live topology.",
  "",
  "The container also runs inside a Kubernetes cluster, and kubectl is already",
  "authenticated against it — no kubeconfig, no context to choose. Cluster-wide",
  "read, including ArgoCD Applications and Kargo resources; no Secrets and no",
  "writes, because ArgoCD reconciles from git and a change belongs in a manifest",
  "and a pull request. So diagnose from the cluster rather than asking for what",
  "it says.",
  "",
  "If verksted itself gets in your way — something the workbench cannot do, not",
  'something about the repo you are in — say so with `vk feedback "..."`. It',
  "reaches the person who owns the bench; nothing else is expected of you.",
].join("\n");

const RULES_START = "<!-- verksted:house start -->";
const RULES_END = "<!-- verksted:house end -->";

/**
 * The two standing rules, told to every agent in every repo.
 *
 * Here rather than in any repo's own CLAUDE.md for the same reason as the
 * sandbox note: they are true of this bench, including in a project verksted
 * has never seen, and a committed file is no place for one person's house
 * style. A repo cloned tomorrow is covered without anyone remembering to add
 * anything to it.
 *
 * **Attribution.** Every agent CLI here adds its own signature by default — a
 * Co-Authored-By trailer on commits, a "Generated with" footer on pull requests
 * — and git history is not something you can quietly correct later. Verksted
 * writes no such thing itself; this is what stops the agents doing it.
 *
 * **Destruction.** These agents run in auto permission mode when a schedule
 * starts them, which is what makes an unattended run possible at all: routine
 * tool calls go through without anyone there. So the line between "routine" and
 * "gone forever" has to be drawn in words, and it is drawn at what git cannot
 * undo. Asking is not a dead end even at 03:00 — the session turns amber, the
 * phone gets pushed, and the work waits rather than being guessed at.
 */
const HOUSE_RULES = [
  "House rules on this bench, from the person who owns it. They hold in every",
  "repo, including ones with no instructions of their own.",
  "",
  "**Leave no sign that an agent wrote anything.** No Co-Authored-By trailer for",
  "Claude or any other agent, no 'Generated with' footer or badge, and no mention",
  "of AI, an agent or an assistant anywhere it would persist: commit messages,",
  "branch names, pull request titles and bodies, issue and review comments, and",
  "code comments. Write as the person whose name is on the commit would write.",
  "",
  "**Ask before anything that cannot be undone.** Force-pushing; rewriting",
  "published history (rebase, amend or reset --hard on a branch already pushed);",
  "deleting a branch, tag, remote or release; discarding uncommitted work (git",
  "checkout --, git restore, git clean, stash drop); dropping a database, a",
  "volume or its data; and rm -rf outside a build directory. Stop and ask, even",
  "when nobody appears to be watching — that is what turns the session amber and",
  "reaches them.",
  "",
  "Committing, pushing a new branch, and opening a pull request are ordinary work",
  "and need no permission.",
].join("\n");

/** Agent CLI -> its global memory file, relative to $HOME. */
export const MEMORY_FILES = [".claude/CLAUDE.md", ".codex/AGENTS.md"];

/**
 * Replace a marked block, or append one, leaving the rest of the file alone.
 *
 * Shared rather than private because memory writes a second block into the same
 * files: two independent owners of two regions of a file the user also edits,
 * which only works if both do the surgery the same way. An empty body removes
 * the block, so a memory that is emptied leaves no stale heading behind.
 */
export function mergeMarked(existing: string, start: string, end: string, block: string): string {
  const body = block.trim() ? `${start}\n${block.trim()}\n${end}` : "";
  const from = existing.indexOf(start);
  const to = existing.indexOf(end);
  if (from !== -1 && to > from) {
    const merged = existing.slice(0, from) + body + existing.slice(to + end.length);
    return body ? merged : merged.replace(/\n{3,}/g, "\n\n").trimStart();
  }
  if (!body) return existing;
  const before = existing.trimEnd();
  return before ? `${before}\n\n${body}\n` : `${body}\n`;
}

/** Replace both verksted-owned blocks, leaving the rest of the file alone. */
export function mergeBlock(existing: string): string {
  return mergeMarked(mergeMarked(existing, START, END, BLOCK), RULES_START, RULES_END, HOUSE_RULES);
}

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Write the pointer into every agent's global memory file. Best-effort: a home
 * directory that is not writable is a reason to run without the note, never a
 * reason to fail the boot and take every session with it.
 */
export async function ensureSandboxNotes(
  log: Logger,
  home = process.env.HOME ?? "/data/home",
): Promise<void> {
  for (const rel of MEMORY_FILES) {
    const file = path.join(home, rel);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const existing = await fs.readFile(file, "utf8").catch(() => "");
      const merged = mergeBlock(existing);
      if (merged !== existing) await fs.writeFile(file, merged);
    } catch (err) {
      log.warn(err, `could not write the sandbox note to ${file}`);
    }
  }
}
