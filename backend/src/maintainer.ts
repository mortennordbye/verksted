import fs from "node:fs/promises";
import path from "node:path";
import type { MaintainerStage } from "../../shared/api.js";
import { env } from "./env.js";

/**
 * The maintainer: what a scheduled stage is told before it starts.
 *
 * A stage's prompt is shipped in the image (runtime/maintainer/<stage>.md) and
 * is the same for every repo; what differs per repo is written in the repo
 * itself, under `## Maintainer` in its CLAUDE.md — the command that verifies
 * it, what may merge on its own, what must never be touched unasked. Keeping
 * the contract in the repo is what makes the next repo configuration rather
 * than code, and it is read at launch so an edit reaches the next run.
 */

/**
 * How much of a contract travels. It rides in the same env var as the prompt,
 * and a section that has grown into a manual would push the prompt out.
 */
const CONTRACT_CAP = 6_000;

/**
 * The `## Maintainer` section of the repo's CLAUDE.md, up to the next `## `
 * heading. Null when there is none, which the prompt then says out loud so the
 * run declines the work rather than guessing at the rules.
 */
export async function readContract(repoDir: string): Promise<string | null> {
  let lines: string[];
  try {
    lines = (await fs.readFile(path.join(repoDir, "CLAUDE.md"), "utf8")).split("\n");
  } catch {
    return null;
  }
  const start = lines.findIndex((l) => /^## Maintainer\s*$/.test(l));
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text ? text.slice(0, CONTRACT_CAP) : null;
}

export interface RepoFacts {
  project: string;
  /** The directory the run works in. */
  dir: string;
  contract: string | null;
}

/**
 * The prompt a stage run starts with: the stage's own, then what it needs to
 * know about this repo, then whatever the schedule's owner added. The report
 * contract is appended by the scheduler, as for every scheduled run.
 */
export async function stagePrompt(
  stage: MaintainerStage,
  facts: RepoFacts,
  notes: string,
): Promise<string> {
  const template = await fs.readFile(path.join(env.MAINTAINER_DIR, `${stage}.md`), "utf8");
  const parts = [
    template.trim(),
    "## This repo",
    `Project: ${facts.project}\nWorking tree: ${facts.dir}`,
    facts.contract
      ? `### Maintainer contract, from the repo's CLAUDE.md\n\n${facts.contract}`
      : "This repo has no `## Maintainer` section in its CLAUDE.md, so nothing here says " +
        "how to verify it or what may be touched. Do not guess: report " +
        '"failed: no maintainer contract in CLAUDE.md" and stop.',
  ];
  if (notes.trim()) parts.push("## Notes from the owner", notes.trim());
  return parts.join("\n\n");
}
