import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The guard is what stands in for the permission prompts an unattended run
 * has nobody to answer: in dontAsk mode claude runs what this hook allows and
 * denies the rest. It is shell, so nothing else in the suite would notice it
 * breaking, and its failure modes are the two worst ones — a force push at
 * 03:00, or every command denied and a night of "failed" rows.
 */
const GUARD = resolve(import.meta.dirname, "../../runtime/vk-guard");

let worktree: string;
let elsewhere: string;
let report: string;

type Verdict = { allowed: boolean; reason: string };

/** Run the guard over one tool call and say what it decided. */
async function guard(
  tool: string,
  input: Record<string, string>,
  env: Record<string, string> = {},
): Promise<Verdict> {
  const child = execFile(
    "sh",
    [GUARD],
    {
      env: {
        ...process.env,
        VK_STAGE: "scout",
        VK_WORKTREE: worktree,
        VK_REPORT_FILE: report,
        ...env,
      },
    },
    () => {},
  );
  const done = new Promise<Verdict>((resolveVerdict) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code === 0) {
        // A pass must say so explicitly: in dontAsk mode a hook that stays
        // silent leaves the call to the allow rules, which may not carry it.
        expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("allow");
        resolveVerdict({ allowed: true, reason: "" });
      } else {
        expect(code).toBe(2);
        resolveVerdict({ allowed: false, reason: stderr.trim() });
      }
    });
  });
  child.stdin!.end(JSON.stringify({ tool_name: tool, tool_input: input }));
  return done;
}

const bash = (command: string, env?: Record<string, string>) => guard("Bash", { command }, env);

beforeAll(async () => {
  await chmod(GUARD, 0o755);
  const root = await mkdtemp(join(tmpdir(), "vk-guard-"));
  worktree = join(root, "repos", "demo");
  elsewhere = join(root, "repos", "other");
  report = join(root, "sessions", "vk-demo-1.report");
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await mkdir(join(root, "sessions"), { recursive: true });
  // A way out of the tree that only the filesystem knows about.
  await symlink(elsewhere, join(worktree, "escape"));
});

describe("vk-guard, in every stage", () => {
  const build = { VK_STAGE: "build" };

  it("allows ordinary work and says so", async () => {
    for (const cmd of [
      "git status",
      "npm test",
      "git push -u origin maint/42",
      "gh pr list --json number",
      "gh api repos/o/r/pulls/1/files",
      "rm -rf node_modules",
      "cat /data/sessions/vk-demo-1.report",
    ]) {
      expect(await bash(cmd, build), cmd).toEqual({ allowed: true, reason: "" });
    }
  });

  it("denies a force push however it is spelled", async () => {
    for (const cmd of [
      "git push --force origin maint/42",
      "git push -f",
      "git push origin +maint/42:maint/42",
      "git push --force-with-lease origin maint/42",
      "git fetch && git push -f origin HEAD",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("denies a push that reaches the default branch under any spelling", async () => {
    for (const cmd of [
      "git push origin main",
      "git push origin HEAD:main",
      "git push origin maint/42:main",
      "git push origin refs/heads/master",
      "git push upstream master",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("denies discarding work", async () => {
    for (const cmd of [
      "git reset --hard HEAD~1",
      "git clean -fdx",
      "git checkout -- src/a.ts",
      "git stash drop",
      "git branch -D maint/41",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("denies an rm whose path resolves outside the worktree, symlinks included", async () => {
    expect((await bash(`rm -rf ${elsewhere}`, build)).allowed).toBe(false);
    expect((await bash("rm -rf ../other", build)).allowed).toBe(false);
    expect((await bash("rm -rf escape/x", build)).allowed).toBe(false);
    expect((await bash("rm -rf /data/repos/other", build)).allowed).toBe(false);
    expect((await bash("rm -rf dist src/gen", build)).allowed).toBe(true);
    expect((await bash(`rm -rf ${worktree}/dist`, build)).allowed).toBe(true);
  });

  it("denies writes elsewhere on the volume, and allows the report file", async () => {
    expect((await bash("echo x > /data/settings.json", build)).allowed).toBe(false);
    expect((await bash("cp src/a.ts /data/repos/other/a.ts", build)).allowed).toBe(false);
    expect((await bash("cd /data/repos/other && rm -rf x", build)).allowed).toBe(false);
    expect((await bash(`echo "ok: done" > ${report}`, build)).allowed).toBe(true);
    expect((await bash('echo "ok: done" > "$VK_REPORT_FILE"', build)).allowed).toBe(true);
    // Reads of the rest of the volume are the run's to make.
    expect((await bash("cat /data/repos/other/README.md", build)).allowed).toBe(true);
  });

  it("denies what is not the run's to do at all", async () => {
    for (const cmd of [
      "gh repo delete o/r --yes",
      "gh api -X DELETE repos/o/r/issues/1/labels/queued",
      "gh auth logout",
      "kubectl delete pod x",
      "docker system prune -af",
      "vk restore latest",
      "npm publish",
      "git config --global user.name x",
      "claude -p 'do it again'",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("refuses to write anything that says what wrote it", async () => {
    // The house rule made mechanical for everything the commit-msg hook does
    // not see: issue and PR bodies, comments, reviews.
    for (const cmd of [
      'git commit -m "fix: x" -m "Co-authored-by: Claude <noreply@anthropic.com>"',
      'git commit -m "fix: x" --trailer "Claude-Session: https://claude.ai/code/s"',
      'gh issue create --title "x" --body "Generated with Claude Code"',
      'gh pr create --title "x" --body "🤖 opened by an assistant"',
      'gh pr comment 3 --body "As an AI, I noticed"',
      'gh pr review 3 --approve --body "AI-assisted review"',
      'gh pr edit 3 --body "Anthropic"',
      "gh api repos/o/r/issues -f title=x -f body='written by Copilot'",
    ]) {
      const verdict = await bash(cmd, build);
      expect(verdict.allowed, cmd).toBe(false);
      expect(verdict.reason, cmd).toMatch(/sign of who wrote it/);
    }
  });

  it("wants bodies inline, so it can read them", async () => {
    expect((await bash("gh issue create --title x --body-file /tmp/b.md")).allowed).toBe(false);
    expect((await bash("gh pr create --title x -F body.md", build)).allowed).toBe(false);
    expect((await bash('gh issue create --title x --body "plain words"')).allowed).toBe(true);
    // The word claude on its own is not attribution: this app drives claude.
    expect(
      (await bash('git commit -m "fix: resume the right claude conversation"', build)).allowed,
    ).toBe(true);
  });

  it("checks edits against the worktree the same way", async () => {
    expect((await guard("Edit", { file_path: join(worktree, "src/a.ts") }, build)).allowed).toBe(
      true,
    );
    expect((await guard("Write", { file_path: join(elsewhere, "a.ts") }, build)).allowed).toBe(
      false,
    );
    expect(
      (await guard("Write", { file_path: join(worktree, "escape/a.ts") }, build)).allowed,
    ).toBe(false);
  });

  it("passes tools it has no opinion on", async () => {
    expect((await guard("Read", { file_path: "/etc/hostname" }, build)).allowed).toBe(true);
  });
});

describe("vk-guard, for the scout", () => {
  it("lets it read, run the tests and file issues", async () => {
    for (const cmd of [
      "git log --oneline -30",
      "npm ci && npm test",
      "gh issue list --state open --json number,title",
      'gh issue create --title "x" --body "y" --label queued --label tier:auto',
      "npm outdated",
    ]) {
      expect(await bash(cmd), cmd).toEqual({ allowed: true, reason: "" });
    }
  });

  it("stops it changing anything", async () => {
    for (const cmd of [
      "git commit -am x",
      "git push -u origin scout/x",
      "git checkout -b scout/x",
      "git add -A",
      "gh pr create --title x",
      "gh issue close 3",
      "gh issue edit 3 --add-label queued",
    ]) {
      const verdict = await bash(cmd);
      expect(verdict.allowed, cmd).toBe(false);
      expect(verdict.reason, cmd).toMatch(/scout/);
    }
    expect((await guard("Edit", { file_path: join(worktree, "src/a.ts") })).allowed).toBe(false);
  });
});
