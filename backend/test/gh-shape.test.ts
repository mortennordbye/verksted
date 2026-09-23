import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PR_LIST_FIELDS, RUN_LIST_FIELDS } from "../src/routes/github.js";
import { PR, RUN } from "./fixtures/gh.js";

/**
 * The gh fixtures against a real gh (backlog: they were hand-written, and a
 * field gh renamed would keep the suite green and break the app).
 *
 * Only where there is a real repository to ask: CI sets GH_SHAPE_REPO to its
 * own, with its read-only token. Every field a fixture uses has to come back
 * from gh, of the same type, wherever gh has something there to compare.
 */
const REPO = process.env.GH_SHAPE_REPO;

function gh(args: string[]): unknown[] {
  return JSON.parse(
    execFileSync("gh", [...args, "--repo", REPO!], { encoding: "utf8" }),
  ) as unknown[];
}

/** The fields of `fixture` that none of `real` has, with a type, or of another type. */
function missing(fixture: Record<string, unknown>, real: unknown[], at = ""): string[] {
  const rows = real.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (!rows.length) return [];
  const out: string[] = [];
  for (const [key, want] of Object.entries(fixture)) {
    const got = rows.map((r) => r[key]).filter((v) => v !== undefined);
    if (!got.length) {
      out.push(`${at}${key}: not in gh's answer`);
      continue;
    }
    const kind = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
    // null stands for anything: gh says null where there is nothing yet.
    if (kind(want) !== "null" && !got.some((v) => kind(v) === kind(want) || v === null)) {
      out.push(`${at}${key}: ${kind(want)} here, ${kind(got[0])} from gh`);
      continue;
    }
    if (Array.isArray(want) && want[0] && typeof want[0] === "object") {
      out.push(...missing(want[0] as Record<string, unknown>, got.flat(), `${at}${key}[].`));
    } else if (want && typeof want === "object" && !Array.isArray(want)) {
      out.push(...missing(want as Record<string, unknown>, got, `${at}${key}.`));
    }
  }
  return out;
}

describe.skipIf(!REPO)("gh's own answers against the fixtures", () => {
  it("a pull request has every field the fixture uses", () => {
    const real = gh(["pr", "list", "--state", "all", "--limit", "20", "--json", PR_LIST_FIELDS]);
    expect(real.length).toBeGreaterThan(0);
    expect(missing(PR, real)).toEqual([]);
  });

  it("a workflow run has every field the fixture uses", () => {
    const real = gh(["run", "list", "--limit", "5", "--json", RUN_LIST_FIELDS]);
    expect(real.length).toBeGreaterThan(0);
    expect(missing(RUN, real)).toEqual([]);
  });
});
