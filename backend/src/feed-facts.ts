import type { FeedItem, FeedItemFacts } from "../../shared/api.js";
import { env } from "./env.js";
import { ghJson, summarizeChecks } from "./gh.js";
import type { Logger } from "./logger.js";
import * as mail from "./mail.js";
import { getSession, SESSION_ID_RE } from "./sessions-store.js";
import { totalTokens } from "./usage.js";

/**
 * The facts a feed row shows once it is opened.
 *
 * Each of these is a call the pollers deliberately do not make: a `gh` call per
 * pull request, an IMAP fetch per message. Made for one item when a person
 * opens its row, and kept a few minutes, so opening and closing a row is one
 * call and a list of a dozen pull requests costs nothing until one is looked at.
 *
 * A source that cannot be read leaves its facts null: the row already has the
 * poller's facts, and a missing extra is not an error worth a status.
 */
const EMPTY: FeedItemFacts = {
  checks: null,
  diff: null,
  firstLine: null,
  durationMs: null,
  tokens: null,
};

/** A pull request a github item's link points at; issues and the rest have no checks. */
function pullRequest(link: string | null): { repo: string; number: string } | null {
  // The link is built from GitHub's own url, and owner and repo are spelled as
  // GitHub allows them, so neither can pass for a flag or a path.
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\/pull\/(\d{1,7})(?:$|[/?#])/.exec(
      link ?? "",
    );
  return m?.[1] && m[2] ? { repo: m[1], number: m[2] } : null;
}

async function githubFacts(item: FeedItem): Promise<Partial<FeedItemFacts>> {
  const pr = pullRequest(item.link);
  if (!pr) return {};
  const got = await ghJson<{
    statusCheckRollup: { status?: string; conclusion?: string }[] | null;
    additions: number;
    deletions: number;
    changedFiles: number;
  }>(
    env.REPOS_DIR,
    [
      "pr",
      "view",
      pr.number,
      `--repo=${pr.repo}`,
      "--json",
      "statusCheckRollup,additions,deletions,changedFiles",
    ],
    { timeout: 15_000 },
  );
  return {
    checks: summarizeChecks(got.statusCheckRollup),
    diff: { additions: got.additions, deletions: got.deletions, files: got.changedFiles },
  };
}

async function mailFacts(item: FeedItem): Promise<Partial<FeedItemFacts>> {
  const m = /^mail:(\d{1,10})$/.exec(item.id);
  if (!m) return {};
  return { firstLine: await mail.firstLine(Number(m[1])) };
}

/** The session a bench or schedule item is about: its own id, or the one its link opens. */
function sessionOf(item: FeedItem): string | null {
  const id = item.id.startsWith("bench:wait:")
    ? item.id.slice("bench:wait:".length)
    : (/^\/s\/([^/?#]+)$/.exec(item.link ?? "")?.[1] ?? "");
  return SESSION_ID_RE.test(id) ? id : null;
}

async function sessionFacts(item: FeedItem): Promise<Partial<FeedItemFacts>> {
  const id = sessionOf(item);
  const s = id ? await getSession(id) : null;
  if (!s) return {};
  const ended = s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.createdAt) : NaN;
  return {
    durationMs: Number.isFinite(ended) && ended >= 0 ? ended : null,
    tokens: s.usage ? totalTokens(s.usage) : null,
  };
}

const BY_SOURCE: Partial<
  Record<FeedItem["source"], (i: FeedItem) => Promise<Partial<FeedItemFacts>>>
> = {
  github: githubFacts,
  mail: mailFacts,
  bench: sessionFacts,
  schedule: sessionFacts,
};

/** How long an item's facts are kept, and how many items' are. */
const KEEP_MS = 5 * 60_000;
const MAX_KEPT = 200;

/**
 * What was fetched, by item id. A fetch that failed is not kept, so a gh
 * hiccup is not what the row shows for the next five minutes; one in flight
 * is shared, so two taps on the same row are one call.
 */
const kept = new Map<string, { at: number; facts: Promise<FeedItemFacts> }>();

/** Forget every fetched fact. For tests. */
export function resetFeedFacts(): void {
  kept.clear();
}

export function factsFor(item: FeedItem, log: Pick<Logger, "warn">): Promise<FeedItemFacts> {
  const now = Date.now();
  const hit = kept.get(item.id);
  if (hit && now - hit.at < KEEP_MS) return hit.facts;
  kept.delete(item.id);
  // Oldest first, by insertion: what was fetched longest ago goes to make room.
  for (const [id, v] of kept) {
    if (kept.size < MAX_KEPT && now - v.at < KEEP_MS) break;
    kept.delete(id);
  }
  const read = BY_SOURCE[item.source];
  const facts = (read ? read(item) : Promise.resolve({})).then(
    (got) => ({ ...EMPTY, ...got }),
    (err: unknown) => {
      log.warn(err, `facts for ${item.id} unavailable`);
      kept.delete(item.id);
      return EMPTY;
    },
  );
  kept.set(item.id, { at: now, facts });
  return facts;
}
