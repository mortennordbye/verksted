import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoDir, ...args]);
  return stdout.trim();
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
