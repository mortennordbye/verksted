import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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

/**
 * S-04 in the audit: the rules above were anchored at the start of the line or
 * just after ; & | (, so a newline, a word in front of the command, an
 * absolute path or one of git's own global flags walked past all of them.
 * Each case here is one of the ways around the guard the audit listed.
 */
describe("vk-guard, the one-line ways around it", () => {
  const build = { VK_STAGE: "build", VK_PROJECT: "demo" };

  it("reads a command that does not start the line", async () => {
    for (const cmd of [
      "echo hi\ngit reset --hard origin/main",
      "npm test\ngit push --force origin main",
      "if true; then git reset --hard; fi",
      "{ git push -f origin main; }",
      "echo `git push -f origin main`",
      "echo $(git reset --hard)",
      "for f in a b; do git push -f; done",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("sees through the words that can stand in front of a command", async () => {
    for (const cmd of [
      "env git push --force origin main",
      "command git reset --hard",
      "/usr/bin/git push -f origin main",
      "sh -c 'git reset --hard'",
      'bash -c "git push --force origin main"',
      "GIT_TERMINAL_PROMPT=0 git push -f origin main",
      "echo main | xargs git push -f origin",
      "exec git push --force origin main",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("joins a line that continues on the next one", async () => {
    expect((await bash("git \\\n  push --force origin maint/42", build)).allowed).toBe(false);
  });

  it("refuses an interpreter that reads its program from the pipe", async () => {
    for (const cmd of ["echo git push -f origin main | sh", "cat payload.py | python3"]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
    // A script in the worktree is still the run's to run, and asking a
    // version is not running anything.
    expect((await bash("sh scripts/check.sh", build)).allowed).toBe(true);
    expect((await bash("node --version && npm --version", build)).allowed).toBe(true);
  });

  it("sees git's own global flags", async () => {
    for (const cmd of [
      "git -C . push --force origin maint/42",
      "git -c a=b push origin main",
      "git --git-dir=/data/repos/other/.git push -f",
      "git -C /data/repos/other reset --hard",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("will not push a ref it cannot read", async () => {
    expect((await bash("b=main; git push origin HEAD:$b", build)).allowed).toBe(false);
  });

  it("reads --method= the same way as -X", async () => {
    for (const cmd of [
      "gh api --method=DELETE repos/o/r/issues/1/labels/queued",
      "gh api --method=PUT repos/o/r/pulls/9/merge",
      "gh api --method PATCH repos/o/r/issues/1",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
    expect((await bash("gh api repos/o/r/pulls/9/files", build)).allowed).toBe(true);
  });

  it("checks a quoted path, a ~ path, and one built from a variable", async () => {
    for (const cmd of [
      `cp src/a.ts "${elsewhere}/a.ts"`,
      "echo x > ~/.bashrc",
      "echo x > $HOME/.profile",
      "cp src/a.ts /tmp/a.ts",
      "echo x > /etc/hosts",
      "curl -o /data/settings.json https://example.com/x",
      "tar -C /data -xf payload.tar",
      "mkdir -p /data/repos/other/x",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
    // The shapes ordinary work takes, which the same check must let through.
    for (const cmd of [
      "npm test > out.log 2>&1",
      "git diff > /dev/null",
      "mkdir -p src/gen && touch src/gen/a.ts",
    ]) {
      expect(await bash(cmd, build), cmd).toEqual({ allowed: true, reason: "" });
    }
  });

  it("refuses interpreter code written on the command line", async () => {
    for (const cmd of [
      `python3 -c 'open("/data/settings.json","w").write("x")'`,
      `node -e 'require("fs").writeFileSync("/data/x","y")'`,
      `perl -e 'unlink "/data/push.json"'`,
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("keeps the run off the pod's own API", async () => {
    // The largest hole in the guard was never in the guard: the backend on
    // loopback takes a request with no Origin, and a session it starts there
    // carries no guard at all.
    for (const cmd of [
      "curl -X POST http://127.0.0.1:8080/api/projects/demo/sessions -d '{}'",
      "curl http://localhost:8080/api/settings/reveal",
      "wget -q -O - http://[::1]:8080/api/sessions",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
    expect((await bash("curl -sS https://api.github.com/rate_limit", build)).allowed).toBe(true);
  });

  it("stops the commands that run what the guard cannot read", async () => {
    for (const cmd of [
      "find . -name x -exec rm -rf /data/settings.json {} ;",
      "find /data -delete",
      // -c can point git at a hooks path, which is a script of the run's own.
      "git -c core.hooksPath=/tmp/h commit -m x",
      "gh api -X POST repos/o/r/merges -f base=main",
      "gh api graphql -f query=mutation",
      "dd if=/dev/zero of=/data/settings.json",
      "ln -s /data/settings.json ./link",
      "p() { git push -f origin main; }",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });

  it("knows the API by its path, not only by the loopback address", async () => {
    expect(
      (
        await bash(
          "curl -sS -X POST http://verksted.local.bigd.no/api/projects/demo/sessions",
          build,
        )
      ).allowed,
    ).toBe(false);
  });

  it("resolves the gate's own checkouts before it trusts the name", async () => {
    const gate = { VK_STAGE: "gate", VK_PROJECT: "demo" };
    expect(
      (await guard("Write", { file_path: "/data/repos/demo--gate-9/../../settings.json" }, gate))
        .allowed,
    ).toBe(false);
    expect(
      (await bash("git worktree add /data/repos/demo--gate-9/../../evil origin/x", gate)).allowed,
    ).toBe(false);
  });
});

describe("vk-guard, for the builder", () => {
  const build = { VK_STAGE: "build", VK_PROJECT: "demo" };

  it("lets it commit, push its branch and open the pull request", async () => {
    for (const cmd of [
      "git add -A && git commit -m 'fix: the thing'",
      "git push -u origin maint/42",
      'gh pr create --title "fix: the thing" --label tier:auto --body "Closes #42"',
      "gh issue edit 42 --remove-label in-progress --add-label done",
      "gh issue comment 42 --body 'which of the two?'",
    ]) {
      expect(await bash(cmd, build), cmd).toEqual({ allowed: true, reason: "" });
    }
  });

  it("keeps it off the gate's job and off rewriting history", async () => {
    for (const cmd of [
      "gh pr merge 9 --squash --auto",
      "gh pr review 9 --approve",
      "gh pr close 9",
      "gh issue create --title x --body y",
      "git rebase main",
      "git commit --amend --no-edit",
    ]) {
      expect((await bash(cmd, build)).allowed, cmd).toBe(false);
    }
  });
});

describe("vk-guard, for the gate", () => {
  const gate = { VK_STAGE: "gate", VK_PROJECT: "demo" };
  let bin: string;

  /** A fake gh on PATH that answers `pr view` with the branch and labels given. */
  function ghSaying(headRefName: string, labels: string[]): Record<string, string> {
    const view = [headRefName, ...labels].join(" ");
    return { ...gate, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_VIEW: view };
  }

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), "vk-gh-"));
    await writeFile(join(bin, "gh"), '#!/bin/sh\nprintf "%s" "$FAKE_GH_VIEW"\n');
    await chmod(join(bin, "gh"), 0o755);
  });

  it("checks out and removes only its own checkouts beside the repo", async () => {
    expect(
      (await bash("git worktree add /data/repos/demo--gate-9 origin/maint/9", gate)).allowed,
    ).toBe(true);
    expect((await bash("git worktree remove --force /data/repos/demo--gate-9", gate)).allowed).toBe(
      true,
    );
    expect((await bash("git worktree add /data/repos/other--gate-9 origin/x", gate)).allowed).toBe(
      false,
    );
    expect((await bash("git worktree add /data/repos/demo-copy origin/x", gate)).allowed).toBe(
      false,
    );
    // The builder's worktrees are the scheduler's to make, but a gate cleaning
    // one up is still inside the fence.
    expect((await bash("rm -rf /data/repos/demo--gate-9/node_modules", gate)).allowed).toBe(true);
    expect(
      (await guard("Write", { file_path: "/data/repos/demo--gate-9/tmp.txt" }, gate)).allowed,
    ).toBe(true);
    expect((await guard("Write", { file_path: join(worktree, "a.ts") }, gate)).allowed).toBe(false);
  });

  it("pushes nothing and opens nothing", async () => {
    for (const cmd of ["git push origin maint/9", "gh pr create --title x", "git commit -am x"]) {
      expect((await bash(cmd, gate)).allowed, cmd).toBe(false);
    }
    for (const cmd of [
      "gh pr list --state open --json number",
      "gh pr diff 9",
      "gh pr review 9 --approve --body 'does what #42 asked'",
      "gh pr edit 9 --remove-label tier:auto --add-label tier:review",
      "gh issue edit 42 --remove-label done --add-label blocked",
    ]) {
      expect((await bash(cmd, gate)).allowed, cmd).toBe(true);
    }
  });

  it("merges only a tier:auto pull request on a maint/ branch, and only with --squash --auto", async () => {
    const auto = ghSaying("maint/42", ["tier:auto"]);
    expect((await bash("gh pr merge 9 --squash --auto", auto)).allowed).toBe(true);
    expect((await bash("gh pr merge 9 --auto --squash --delete-branch", auto)).allowed).toBe(true);
    expect((await bash("gh pr merge 9 --squash", auto)).allowed).toBe(false);
    expect((await bash("gh pr merge 9 --merge --auto", auto)).allowed).toBe(false);
    expect((await bash("gh pr merge --squash --auto", auto)).allowed).toBe(false);

    const review = ghSaying("maint/42", ["tier:review"]);
    const verdict = await bash("gh pr merge 9 --squash --auto", review);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/owner's to merge/);

    const foreign = ghSaying("dependabot/npm_and_yarn/x", ["tier:auto"]);
    expect((await bash("gh pr merge 9 --squash --auto", foreign)).allowed).toBe(false);
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
