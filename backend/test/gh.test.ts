import { describe, expect, it } from "vitest";
import { formatRunLog, ghError, ghMessage, summarizeChecks } from "../src/gh.js";

// One real step's worth of `gh run view --log-failed`, captured from a failing
// CI run: tab-separated job and step columns, a BOM on the first line of a
// step's chunk, an ISO timestamp per line, ANSI colour, and the ##[group] /
// ##[error] markers GitHub injects. GitHub's log API stores colour in caret
// notation, two literal characters rather than an escape byte, so both forms
// appear here — but only the caret form is what this endpoint receives.
const CARET = "^[";
const RAW_LOG = [
  "test\tRun npm test\t﻿2026-07-26T10:03:08.1900611Z ##[group]Run npm test",
  `test\tRun npm test\t2026-07-26T10:03:08.1900905Z ${CARET}[36;1mnpm test${CARET}[0m`,
  "test\tRun npm test\t2026-07-26T10:03:08.1900906Z [31ma real escape byte[0m",
  "test\tRun npm test\t2026-07-26T10:03:08.1945071Z ##[endgroup]",
  "test\tRun npm test\t2026-07-26T10:03:13.8672445Z npm error command failed",
  "test\tRun npm test\t2026-07-26T10:03:13.8802387Z ##[error]Process completed with exit code 1.",
  "image\tBuild\t2026-07-26T10:03:14.0000000Z skipped",
  "",
].join("\n");

describe("formatRunLog", () => {
  const { log, truncated } = formatRunLog(RAW_LOG);

  it("drops the repeated job/step columns and the timestamps", () => {
    expect(log).not.toContain("\t");
    expect(log).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });

  it("strips ANSI colour in both caret and escape-byte form, and the BOM", () => {
    expect(log).not.toContain(CARET);
    expect(log).not.toContain("");
    expect(log).not.toContain("﻿");
    expect(log).toContain("npm test");
    expect(log).toContain("a real escape byte");
  });

  it("writes one header per job/step change", () => {
    expect(log.match(/── .* ──/g)).toEqual(["── test › Run npm test ──", "── image › Build ──"]);
  });

  it("keeps ##[error] and drops the group markers", () => {
    expect(log).toContain("##[error]Process completed with exit code 1.");
    expect(log).not.toContain("##[group]");
    expect(log).not.toContain("##[endgroup]");
  });

  it("does not flag a log that fits", () => {
    expect(truncated).toBe(false);
  });

  it("keeps the tail when it has to cut, because that is where a failure ends up", () => {
    const cut = formatRunLog(RAW_LOG, 40);
    expect(cut.truncated).toBe(true);
    expect(cut.log).toBe(log.slice(-40));
    expect(cut.log).not.toContain("npm error command failed");
  });
});

describe("summarizeChecks", () => {
  it("reports none when there are no checks", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks(null)).toBe("none");
    expect(summarizeChecks(undefined)).toBe("none");
  });

  it("reports pending while any check is unfinished", () => {
    expect(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: "" },
      ]),
    ).toBe("pending");
  });

  it("reports failing when any completed check failed", () => {
    expect(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failing");
  });

  it("counts a skipped check as passing", () => {
    expect(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toBe("passing");
  });
});

describe("ghError", () => {
  const at = (stderr: string) => ghError({ stderr });

  it("points at the settings page when there is no token", () => {
    expect(at("To get started with GitHub CLI, please run:  gh auth login").status).toBe(409);
    expect(at("gh auth login").message).toMatch(/GH_TOKEN in settings/);
  });

  it("maps a missing remote to a fixable conflict, not a server error", () => {
    expect(at("no git remotes found").status).toBe(409);
  });

  it("maps a rate limit to 429", () => {
    expect(at("API rate limit exceeded").status).toBe(429);
  });

  it("maps oversized output to 413", () => {
    expect(ghError({ code: "ENOBUFS" }).status).toBe(413);
  });

  it("treats a run's own state refusing an action as fixable, keeping gh's wording", () => {
    const cancel = at("Cannot cancel a workflow run that is completed");
    expect(cancel.status).toBe(409);
    expect(cancel.message).toBe("Cannot cancel a workflow run that is completed");
    expect(at("run 1 cannot be rerun; This workflow is already running").status).toBe(409);
  });

  it("falls back to 502 with gh's own first line", () => {
    const err = at("GraphQL: Pull Request has merge conflicts (mergePullRequest)");
    expect(err.status).toBe(502);
    expect(err.message).toBe("GraphQL: Pull Request has merge conflicts (mergePullRequest)");
  });
});

describe("ghMessage", () => {
  it("takes the first non-empty line, capped", () => {
    expect(ghMessage("\n\n  boom  \nrest")).toBe("boom");
    expect(ghMessage("x".repeat(500)).length).toBe(200);
    expect(ghMessage("")).toBe("gh failed");
  });

  it("keeps the continuation when the first line ends in a colon", () => {
    // How gh reports an existing PR — the url is the useful half.
    expect(
      ghMessage(
        'a pull request for branch "x" into branch "y" already exists:\nhttps://gh/pull/16',
      ),
    ).toBe('a pull request for branch "x" into branch "y" already exists: https://gh/pull/16');
  });
});
