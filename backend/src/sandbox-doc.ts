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
  START,
  "This machine is a verksted session container. The docker daemon is a sibling",
  "container, so bind mounts only resolve for paths under /data, and published",
  "ports do not answer on localhost. Read /etc/verksted/SANDBOX.md before running",
  "docker, docker compose, or a project's make targets, and run `vk doctor` to",
  "check the live topology.",
  END,
].join("\n");

/** Agent CLI -> its global memory file, relative to $HOME. */
const MEMORY_FILES = [".claude/CLAUDE.md", ".codex/AGENTS.md"];

/** Replace the marked block, or append one, leaving the rest of the file alone. */
export function mergeBlock(existing: string): string {
  const from = existing.indexOf(START);
  const to = existing.indexOf(END);
  if (from !== -1 && to > from) {
    return existing.slice(0, from) + BLOCK + existing.slice(to + END.length);
  }
  const body = existing.trimEnd();
  return body ? `${body}\n\n${BLOCK}\n` : `${BLOCK}\n`;
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
