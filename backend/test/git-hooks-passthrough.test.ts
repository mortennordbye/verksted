import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

/**
 * O-32. The shipped hooks directory is every repo's core.hooksPath in the pod,
 * which replaced a project's own pre-commit, pre-push and the rest: they
 * stopped running there with no error. Each of those names is now a link to
 * `passthrough`, which runs the repo's hook of that name, then husky's.
 */
const HOOKS = resolve(import.meta.dirname, "../../runtime/git-hooks");

async function repoWith(name: string, body: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "vk-hooks-"));
  await exec("git", ["init", "-q", repo]);
  const hook = join(repo, ".git", "hooks", name);
  await writeFile(hook, `#!/bin/sh\n${body}\n`);
  await chmod(hook, 0o755);
  return repo;
}

describe("a repo's own hooks under the shipped hooksPath", () => {
  it("still run, with the arguments git gave", async () => {
    const repo = await repoWith("post-checkout", 'echo "$@" > "$(git rev-parse --git-dir)/ran"');
    await exec("sh", [join(HOOKS, "post-checkout"), "a", "b", "1"], { cwd: repo });
    expect(await readFile(join(repo, ".git", "ran"), "utf8")).toBe("a b 1\n");
  });

  it("get what git writes on standard input, which is how pre-push hears the refs", async () => {
    const repo = await repoWith("pre-push", 'cat > "$(git rev-parse --git-dir)/refs-seen"');
    const run = exec("sh", [join(HOOKS, "pre-push"), "origin", "url"], { cwd: repo });
    run.child.stdin?.end("refs/heads/main abc refs/heads/main def\n");
    await run;
    expect(await readFile(join(repo, ".git", "refs-seen"), "utf8")).toContain("refs/heads/main");
  });

  it("stop the commit when they refuse it", async () => {
    const repo = await repoWith("pre-commit", "exit 1");
    await expect(exec("sh", [join(HOOKS, "pre-commit")], { cwd: repo })).rejects.toThrow();
  });

  it("include husky's, which lives in the tree rather than in .git", async () => {
    const repo = await repoWith("pre-commit", "true");
    await exec("mkdir", ["-p", join(repo, ".husky")]);
    const husky = join(repo, ".husky", "pre-commit");
    await writeFile(husky, '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/husky-ran"\n');
    await chmod(husky, 0o755);
    await exec("sh", [join(HOOKS, "pre-commit")], { cwd: repo });
    await expect(readFile(join(repo, "husky-ran"), "utf8")).resolves.toBe("");
  });

  it("do nothing, and succeed, in a repo that has none", async () => {
    const repo = await mkdtemp(join(tmpdir(), "vk-hooks-"));
    await exec("git", ["init", "-q", repo]);
    // pre-push reads the refs off standard input, so the push has to send some.
    const run = exec("sh", [join(HOOKS, "pre-push")], { cwd: repo });
    run.child.stdin?.end("");
    await expect(run).resolves.toBeTruthy();
  });
});
