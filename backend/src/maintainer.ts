import fs from "node:fs/promises";
import path from "node:path";
import type { MaintainerIssue, MaintainerStage } from "../../shared/api.js";
import { ttlCache } from "./cache.js";
import { env } from "./env.js";
import { gh, ghJson } from "./gh.js";

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

/**
 * The queue is the repo's issues. A label says where each one is; the scout
 * files them `queued`, the build takes one and moves it on, the owner can do
 * either by hand on GitHub. Deliberately plain words: the repos are public and
 * nothing in them should say what moves the labels.
 */
export const QUEUE_LABELS = {
  queued: "queued",
  inProgress: "in-progress",
  blocked: "blocked",
  done: "done",
} as const;

interface GhIssue {
  number: number;
  title: string;
  body?: string;
  url: string;
  updatedAt: string;
  labels: { name: string }[];
}

const ISSUE_FIELDS = "number,title,body,url,updatedAt,labels";

function tierOf(issue: GhIssue): MaintainerIssue["tier"] {
  const names = issue.labels.map((l) => l.name);
  return names.includes("tier:auto") ? "auto" : names.includes("tier:review") ? "review" : null;
}

export interface QueuedIssue {
  number: number;
  title: string;
  body: string;
  tier: MaintainerIssue["tier"];
}

/** The oldest queued issue, or null when the queue is empty. */
export async function pickIssue(repoDir: string): Promise<QueuedIssue | null> {
  const issues = await ghJson<GhIssue[]>(repoDir, [
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    QUEUE_LABELS.queued,
    "--json",
    ISSUE_FIELDS,
    "--limit",
    "50",
  ]);
  const oldest = issues.sort((a, b) => a.number - b.number)[0];
  if (!oldest) return null;
  return {
    number: oldest.number,
    title: oldest.title,
    body: oldest.body ?? "",
    tier: tierOf(oldest),
  };
}

/** Move an issue from queued to in-progress: the build has it now. */
export async function claimIssue(repoDir: string, number: number): Promise<void> {
  await gh(repoDir, [
    "issue",
    "edit",
    String(number),
    "--remove-label",
    QUEUE_LABELS.queued,
    "--add-label",
    QUEUE_LABELS.inProgress,
  ]);
}

/** Everything on the queue, for the inbox: queued, in progress, blocked. */
async function readQueue(repoDir: string, project: string): Promise<MaintainerIssue[]> {
  const out: MaintainerIssue[] = [];
  for (const state of ["queued", "in-progress", "blocked"] as const) {
    const issues = await ghJson<GhIssue[]>(repoDir, [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      state,
      "--json",
      ISSUE_FIELDS,
      "--limit",
      "50",
    ]);
    for (const i of issues) {
      out.push({
        project,
        number: i.number,
        title: i.title,
        state,
        tier: tierOf(i),
        url: i.url,
        updatedAt: i.updatedAt,
      });
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Cached a minute per repo: the inbox polls, and three gh calls is a lot to repeat. */
const cachedQueue = ttlCache(60_000, (key: string) => {
  const [project, repoDir] = key.split("\0");
  return readQueue(repoDir, project);
});

export function listQueue(repoDir: string, project: string): Promise<MaintainerIssue[]> {
  return cachedQueue(`${project}\0${repoDir}`);
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
  issue?: QueuedIssue,
): Promise<string> {
  const template = await fs.readFile(path.join(env.MAINTAINER_DIR, `${stage}.md`), "utf8");
  const parts = [
    template.trim(),
    "## This repo",
    `Project: ${facts.project}\nWorking tree: ${facts.dir}` +
      (issue ? `\nBranch: maint/${issue.number}` : ""),
    facts.contract
      ? `### Maintainer contract, from the repo's CLAUDE.md\n\n${facts.contract}`
      : "This repo has no `## Maintainer` section in its CLAUDE.md, so nothing here says " +
        "how to verify it or what may be touched. Do not guess: report " +
        '"failed: no maintainer contract in CLAUDE.md" and stop.',
  ];
  if (issue) {
    parts.push(
      "## This issue",
      `#${issue.number}: ${issue.title}\nTier: ${issue.tier ?? "unlabelled — treat as tier:review"}\n\n${issue.body.trim() || "(no body)"}`,
    );
  }
  if (notes.trim()) parts.push("## Notes from the owner", notes.trim());
  return parts.join("\n\n");
}
