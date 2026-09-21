import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);

/**
 * The hook shipped to /etc/verksted/git-hooks is what actually keeps AI
 * attribution out of the history — CLAUDE.md only asks. It is shell, so nothing
 * else in the suite would notice it breaking, and the failure mode is silent:
 * commits keep succeeding and the trailer comes back.
 */
const HOOK = resolve(import.meta.dirname, "../../runtime/git-hooks/commit-msg");

/** Runs the hook over a message and returns what it left behind. */
async function strip(message: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vk-hook-"));
  const file = join(dir, "COMMIT_EDITMSG");
  await writeFile(file, message);
  await exec("sh", [HOOK, file]);
  return readFile(file, "utf8");
}

describe("commit-msg hook", () => {
  beforeAll(async () => {
    await chmod(HOOK, 0o755);
  });

  it("removes the Claude-Session trailer", async () => {
    const out = await strip(
      "feat: a thing\n\nBody.\n\nClaude-Session: https://claude.ai/code/session_x\n",
    );
    expect(out).toBe("feat: a thing\n\nBody.\n");
  });

  it("removes a Claude co-author, which is what GitHub turns into a contributor", async () => {
    const out = await strip(
      "feat: a thing\n\nBody.\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\n",
    );
    expect(out).toBe("feat: a thing\n\nBody.\n");
    expect(out.toLowerCase()).not.toContain("claude");
  });

  it("removes the other agents' co-author lines too, not only claude's", async () => {
    for (const trailer of [
      "Co-authored-by: Codex <codex@openai.com>",
      "Co-authored-by: Gemini <gemini@google.com>",
      "Co-Authored-By: antigravity-agent <agy@google.com>",
    ]) {
      expect(await strip(`feat: a thing\n\nBody.\n\n${trailer}\n`)).toBe(
        "feat: a thing\n\nBody.\n",
      );
    }
  });

  it("removes a generated-with footer, the robot emoji and all", async () => {
    const out = await strip(
      "feat: a thing\n\nBody.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n",
    );
    expect(out).toBe("feat: a thing\n\nBody.\n");
  });

  it("keeps a body line that is only about something generated", async () => {
    const body = "- generated the fixtures from claude.json";
    expect(await strip(`test: fixtures\n\n${body}\n`)).toContain(body);
  });

  it("keeps a bot's co-author trailer on its own commit", async () => {
    const trailer =
      "Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>";
    const out = await strip(`chore: bump\n\n${trailer}\n`);
    expect(out).toContain(trailer);
  });

  it("keeps the word claude in a body, since the app drives the claude CLI", async () => {
    const body = "Uses claude --resume <id> rather than --continue.";
    const out = await strip(`fix: resume the right conversation\n\n${body}\n`);
    expect(out).toContain(body);
  });

  it("leaves an ordinary message untouched", async () => {
    const message = "docs: explain the thing\n\nA paragraph.\n";
    expect(await strip(message)).toBe(message);
  });

  it("chains to the repo's own commit-msg hook rather than replacing it", async () => {
    // core.hooksPath is set system-wide, so the repo's hook would otherwise stop
    // firing the moment it is cloned into a session — silently, with no error.
    const repo = await mkdtemp(join(tmpdir(), "vk-repo-"));
    await exec("git", ["init", "-q", repo]);
    const chained = join(repo, ".git", "hooks", "commit-msg");
    await writeFile(chained, '#!/bin/sh\necho "own-hook-ran" >> "$1"\n');
    await chmod(chained, 0o755);

    const file = join(repo, "MSG");
    await writeFile(file, "feat: x\n\nClaude-Session: https://claude.ai/code/s\n");
    await exec("sh", [HOOK, file], { cwd: repo });

    const out = await readFile(file, "utf8");
    expect(out).toContain("own-hook-ran");
    expect(out).not.toContain("Claude-Session");
  });

  it("fails the commit when a chained hook rejects it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "vk-repo-"));
    await exec("git", ["init", "-q", repo]);
    const chained = join(repo, ".git", "hooks", "commit-msg");
    await writeFile(chained, "#!/bin/sh\nexit 1\n");
    await chmod(chained, 0o755);

    const file = join(repo, "MSG");
    await writeFile(file, "feat: x\n");
    await expect(exec("sh", [HOOK, file], { cwd: repo })).rejects.toThrow();
  });
});
