import fs from "node:fs/promises";
import path from "node:path";

/**
 * A pointer to /etc/verksted/SANDBOX.md in each agent's *global* memory file,
 * so every session in every repo starts knowing that the docker daemon is a
 * sibling — rather than rediscovering it from an empty bind mount.
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

/** Replace the sandbox block, or append one, leaving the rest of the file alone. */
export function mergeBlock(existing: string): string {
  return mergeMarked(existing, START, END, BLOCK);
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
