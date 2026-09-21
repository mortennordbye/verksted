import { describe, expect, it } from "vitest";
import { exec, redactSecrets } from "../src/exec.js";
import { ghMessage } from "../src/gh.js";
import { gitError } from "../src/git.js";

describe("exec", () => {
  it("gives up on a command that never comes back, where it used to wait for ever (R-24)", async () => {
    const started = Date.now();
    await expect(exec("sleep", ["30"], { timeout: 200 })).rejects.toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("has a limit of its own when the caller names none", async () => {
    // Not waited out: the default is a minute. What is pinned is that leaving
    // `timeout` undefined does not switch it off, which a spread would.
    const quick = await exec("true", [], { timeout: undefined });
    expect(quick.stdout).toBe("");
  });
});

describe("what a failed git or gh says to the client (S-13)", () => {
  const remote = "fatal: unable to access 'https://x-access-token:ghp_abc123@github.com/o/r.git/'";

  it("does not carry a token written into a remote", () => {
    expect(redactSecrets(remote)).toBe("fatal: unable to access 'https://***@github.com/o/r.git/'");
    expect(gitError({ stderr: `hint: ignored\n${remote}\n` })).not.toContain("ghp_abc123");
    expect(ghMessage(remote)).not.toContain("ghp_abc123");
  });

  it("leaves an ordinary remote and an ssh one alone", () => {
    const plain = "fatal: repository 'https://github.com/o/r.git/' not found";
    expect(redactSecrets(plain)).toBe(plain);
    expect(redactSecrets("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
});
