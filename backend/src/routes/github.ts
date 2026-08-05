import { exec } from "../exec.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  MergeResult,
  PrComment,
  PrDiff,
  PullRequest,
  PullRequestDetail,
  RunLog,
  WorkflowRun,
  WorkflowRunDetail,
} from "../../../shared/api.js";
import { ttlCache } from "../cache.js";
import { branchOf, defaultBranch, git, gitError } from "../git.js";
import { gh, ghJson, formatRunLog, summarizeChecks, GhError } from "../gh.js";
import { resolveInsideRepos } from "../paths.js";
import { execEnv } from "../settings-store.js";

const MAX_DIFF_CHARS = 400_000;

const PR_LIST_FIELDS =
  "number,title,state,isDraft,headRefName,baseRefName,author,createdAt,updatedAt,url," +
  "reviewDecision,statusCheckRollup,additions,deletions,changedFiles";
const RUN_LIST_FIELDS =
  "databaseId,displayTitle,workflowName,status,conclusion,event,headBranch,createdAt,updatedAt,url";

/** gh's own vocabulary for a PR, as returned by `gh pr list --json`. */
interface GhPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  reviewDecision: string;
  statusCheckRollup: { status?: string; conclusion?: string }[] | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

interface GhRun {
  databaseId: number;
  displayTitle: string;
  workflowName: string;
  status: string;
  conclusion: string;
  event: string;
  headBranch: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

const toPr = (p: GhPr): PullRequest => ({
  number: p.number,
  title: p.title,
  state: p.state as PullRequest["state"],
  isDraft: p.isDraft,
  headRefName: p.headRefName,
  baseRefName: p.baseRefName,
  author: p.author?.login ?? "",
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  url: p.url,
  reviewDecision: p.reviewDecision ?? "",
  checks: summarizeChecks(p.statusCheckRollup),
  additions: p.additions,
  deletions: p.deletions,
  changedFiles: p.changedFiles,
});

const toRun = (r: GhRun): WorkflowRun => ({
  id: r.databaseId,
  title: r.displayTitle,
  workflow: r.workflowName,
  status: r.status as WorkflowRun["status"],
  conclusion: r.conclusion ?? "",
  event: r.event,
  branch: r.headBranch,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  url: r.url,
});

const projectParams = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", maxLength: 150 } },
};

const prParams = {
  type: "object",
  required: ["name", "number"],
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 150 },
    number: { type: "string", pattern: "^[0-9]{1,7}$" },
  },
};

const runParams = {
  type: "object",
  required: ["name", "id"],
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 150 },
    id: { type: "string", pattern: "^[0-9]{1,20}$" },
  },
};

const limitQuery = {
  type: "object",
  additionalProperties: false,
  properties: { limit: { type: "integer", minimum: 1, maximum: 30, default: 20 } },
};

/**
 * The two list endpoints the session screen polls on a timer. Each miss is a
 * real GitHub API call, billed against a rate limit the whole token shares, and
 * multiplied by every open tab. 15 s is short enough that a new PR or a check
 * flipping still shows up while you are looking at it.
 *
 * The key carries every argument that changes the answer; repoDir is already
 * resolved and validated by the time it gets here.
 */
const prList = ttlCache(15_000, (key: string) => {
  const [repoDir, state, limit] = key.split("\0");
  return ghJson<GhPr[]>(repoDir!, [
    "pr",
    "list",
    "--state",
    state!,
    "--limit",
    limit!,
    "--json",
    PR_LIST_FIELDS,
  ]);
});

const runList = ttlCache(15_000, (key: string) => {
  const [repoDir, limit] = key.split("\0");
  return ghJson<GhRun[]>(repoDir!, ["run", "list", "--limit", limit!, "--json", RUN_LIST_FIELDS]);
});

export default async function githubRoutes(app: FastifyInstance) {
  /** Send a gh failure with the status it was already mapped to. */
  function ghReply(req: FastifyRequest, reply: FastifyReply, err: unknown) {
    if (err instanceof GhError) {
      if (err.status >= 500) req.log.error(err, "gh failed");
      return reply.code(err.status).send({ error: err.message });
    }
    req.log.error(err, "github route failed");
    return reply.code(500).send({ error: "github request failed" });
  }

  /** Resolve a project dir, or null after replying 404. */
  function repoOf(req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) {
    try {
      return resolveInsideRepos(req.params.name);
    } catch {
      reply.code(404).send({ error: "not found" });
      return null;
    }
  }

  app.get<{ Params: { name: string }; Querystring: { state?: string; limit?: number } }>(
    "/api/projects/:name/prs",
    {
      schema: {
        params: projectParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            state: { type: "string", enum: ["open", "all"], default: "open" },
            limit: { type: "integer", minimum: 1, maximum: 30, default: 20 },
          },
        },
      },
    },
    async (req, reply): Promise<PullRequest[] | void> => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        // Every open session tab polls this on a timer, and each miss is a real
        // GitHub API call against a rate limit shared by the whole token.
        const prs = await prList(
          `${repoDir}\0${req.query.state ?? "open"}\0${req.query.limit ?? 20}`,
        );
        return prs.map(toPr);
      } catch (err) {
        return ghReply(req, reply, err);
      }
    },
  );

  app.get<{ Params: { name: string; number: string } }>(
    "/api/projects/:name/prs/:number",
    { schema: { params: prParams } },
    async (req, reply): Promise<PullRequestDetail | void> => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        const p = await ghJson<
          GhPr & {
            body: string;
            comments: { author: { login: string } | null; body: string; createdAt: string }[];
            reviews: {
              author: { login: string } | null;
              body: string;
              submittedAt: string;
              state: string;
            }[];
            files: { path: string; additions: number; deletions: number }[];
          }
        >(repoDir, [
          "pr",
          "view",
          req.params.number,
          "--json",
          `${PR_LIST_FIELDS},body,comments,reviews,files`,
        ]);
        // Comments and reviews are two GitHub concepts but one conversation.
        // A review with no body is a bare approval — the verdict is the content.
        const comments: PrComment[] = [
          ...p.comments.map((c) => ({
            author: c.author?.login ?? "",
            body: c.body,
            createdAt: c.createdAt,
            state: "",
          })),
          ...p.reviews.map((r) => ({
            author: r.author?.login ?? "",
            body: r.body,
            createdAt: r.submittedAt,
            state: r.state,
          })),
        ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return { ...toPr(p), body: p.body ?? "", comments, files: p.files ?? [] };
      } catch (err) {
        return ghReply(req, reply, err);
      }
    },
  );

  app.get<{ Params: { name: string; number: string } }>(
    "/api/projects/:name/prs/:number/diff",
    { schema: { params: prParams } },
    async (req, reply): Promise<PrDiff | void> => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        const diff = await gh(repoDir, ["pr", "diff", req.params.number], { timeout: 60_000 });
        // Head, not tail: a diff reads top-down, unlike a failure log.
        return diff.length <= MAX_DIFF_CHARS
          ? { diff, truncated: false }
          : { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: true };
      } catch (err) {
        return ghReply(req, reply, err);
      }
    },
  );

  app.post<{
    Params: { name: string };
    Body: { title: string; body?: string; base?: string; draft?: boolean };
  }>(
    "/api/projects/:name/prs",
    {
      schema: {
        params: projectParams,
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 300 },
            body: { type: "string", maxLength: 20_000 },
            base: { type: "string", minLength: 1, maxLength: 200 },
            draft: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;

      const branch = await branchOf(repoDir);
      if (branch === "?") return reply.code(409).send({ error: "not on a branch" });

      let base = req.body.base?.trim();
      if (base) {
        try {
          await exec("git", ["check-ref-format", "--branch", base]);
        } catch {
          return reply.code(400).send({ error: "invalid base branch name" });
        }
      } else {
        base = (await defaultBranch(repoDir)) ?? undefined;
        if (!base) return reply.code(409).send({ error: "no default branch to target" });
      }
      if (branch === base) {
        return reply
          .code(409)
          .send({ error: `already on ${base} — make a branch or worktree first` });
      }
      // A PR that omits the work still sitting in the editor is the classic
      // footgun; the source-control panel is one tab away.
      if ((await git(repoDir, ["status", "--porcelain"])) !== "") {
        return reply.code(409).send({ error: "uncommitted changes — commit them first" });
      }

      try {
        await git(repoDir, ["push", "-u", "origin", "HEAD"], {
          env: { ...process.env, ...(await execEnv()) },
          timeout: 120_000,
        });
      } catch (err) {
        req.log.error(err, "git push failed");
        return reply.code(409).send({ error: gitError(err) });
      }

      try {
        const out = await gh(
          repoDir,
          [
            "pr",
            "create",
            "--title",
            req.body.title,
            "--base",
            base,
            "--head",
            branch,
            "--body",
            req.body.body ?? "",
            ...(req.body.draft ? ["--draft"] : []),
          ],
          { timeout: 60_000 },
        );
        const url = out.trim().split("\n").filter(Boolean).at(-1) ?? "";
        return reply.code(201).send({ number: Number(url.split("/").at(-1)), url });
      } catch (err) {
        // gh's "already exists" message carries the existing PR's url, which is
        // more use than anything a pre-check could have told the user.
        if (err instanceof GhError && /already exists|No commits between/i.test(err.message)) {
          return reply.code(409).send({ error: err.message });
        }
        return ghReply(req, reply, err);
      }
    },
  );

  app.post<{ Params: { name: string; number: string } }>(
    "/api/projects/:name/prs/:number/checkout",
    { schema: { params: prParams } },
    async (req, reply) => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        await gh(repoDir, ["pr", "checkout", req.params.number], { timeout: 120_000 });
      } catch (err) {
        return ghReply(req, reply, err);
      }
      return { branch: await branchOf(repoDir) };
    },
  );

  // Squash and delete the branch: matches how this repo's history is kept.
  // gh does the local side itself — fetches the base, switches to it,
  // fast-forwards it, and deletes the head branch locally and on the remote.
  app.post<{ Params: { name: string; number: string } }>(
    "/api/projects/:name/prs/:number/merge",
    { schema: { params: prParams } },
    async (req, reply): Promise<MergeResult | void> => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      const n = req.params.number;

      let pr: { state: string; headRefName: string; mergeable: string };
      try {
        pr = await ghJson(repoDir, ["pr", "view", n, "--json", "state,headRefName,mergeable"]);
      } catch (err) {
        return ghReply(req, reply, err);
      }
      if (pr.state !== "OPEN") {
        return reply.code(409).send({ error: `PR #${n} is ${pr.state.toLowerCase()}` });
      }
      // UNKNOWN just means GitHub has not finished computing it yet.
      if (pr.mergeable === "CONFLICTING") {
        return reply.code(409).send({ error: "PR has conflicts — resolve them first" });
      }
      // gh has to switch off the head branch to delete it. With a dirty tree it
      // merges on GitHub first and only then fails locally, so refuse up front.
      if (
        (await branchOf(repoDir)) === pr.headRefName &&
        (await git(repoDir, ["status", "--porcelain"])) !== ""
      ) {
        return reply
          .code(409)
          .send({ error: `uncommitted changes on ${pr.headRefName} — commit or discard first` });
      }

      let detail: string | undefined;
      try {
        await gh(repoDir, ["pr", "merge", n, "--squash", "--delete-branch"], { timeout: 60_000 });
      } catch (err) {
        // A merge is not idempotent. If GitHub merged and gh then tripped over
        // local branch cleanup, reporting failure would send the user back to
        // retry something that already landed.
        let merged = false;
        try {
          merged =
            (await ghJson<{ state: string }>(repoDir, ["pr", "view", n, "--json", "state"]))
              .state === "MERGED";
        } catch {
          // leave merged false — report the original failure
        }
        if (!merged) return ghReply(req, reply, err);
        req.log.warn(err, "pr merged but gh reported a failure");
        detail = err instanceof GhError ? err.message : "merged, but local cleanup failed";
      }

      try {
        // gh deletes the remote branch but leaves its tracking ref behind.
        await git(repoDir, ["fetch", "--prune", "origin"], {
          env: { ...process.env, ...(await execEnv()) },
          timeout: 120_000,
        });
      } catch (err) {
        req.log.warn(err, "prune after merge failed");
        detail ??= gitError(err);
      }
      return { merged: true, branch: await branchOf(repoDir), detail };
    },
  );

  app.get<{ Params: { name: string }; Querystring: { limit?: number } }>(
    "/api/projects/:name/runs",
    { schema: { params: projectParams, querystring: limitQuery } },
    async (req, reply): Promise<WorkflowRun[] | void> => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        const runs = await runList(`${repoDir}\0${req.query.limit ?? 20}`);
        return runs.map(toRun);
      } catch (err) {
        return ghReply(req, reply, err);
      }
    },
  );

  app.get<{ Params: { name: string; id: string } }>(
    "/api/projects/:name/runs/:id",
    { schema: { params: runParams } },
    async (req, reply): Promise<WorkflowRunDetail | void> => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        const r = await ghJson<
          GhRun & {
            jobs: {
              name: string;
              status: string;
              conclusion: string;
              steps: { name: string; status: string; conclusion: string }[];
            }[];
          }
        >(repoDir, ["run", "view", req.params.id, "--json", `${RUN_LIST_FIELDS},jobs`]);
        return {
          ...toRun(r),
          jobs: (r.jobs ?? []).map((j) => ({
            name: j.name,
            status: j.status,
            conclusion: j.conclusion ?? "",
            steps: (j.steps ?? []).map((s) => ({
              name: s.name,
              status: s.status,
              conclusion: s.conclusion ?? "",
            })),
          })),
        };
      } catch (err) {
        return ghReply(req, reply, err);
      }
    },
  );

  app.get<{ Params: { name: string; id: string } }>(
    "/api/projects/:name/runs/:id/log",
    { schema: { params: runParams } },
    async (req, reply): Promise<RunLog | void> => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        // --log-failed, not --log: the failing jobs are the reason to open this.
        return formatRunLog(
          await gh(repoDir, ["run", "view", req.params.id, "--log-failed"], { timeout: 60_000 }),
        );
      } catch (err) {
        return ghReply(req, reply, err);
      }
    },
  );

  app.post<{ Params: { name: string; id: string }; Body: { failed?: boolean } }>(
    "/api/projects/:name/runs/:id/rerun",
    {
      schema: {
        params: runParams,
        // Null as well as object: "re-run all" sends no body at all.
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: { failed: { type: "boolean" } },
        },
      },
    },
    async (req, reply) => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        await gh(repoDir, [
          "run",
          "rerun",
          req.params.id,
          ...(req.body?.failed ? ["--failed"] : []),
        ]);
      } catch (err) {
        return ghReply(req, reply, err);
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { name: string; id: string } }>(
    "/api/projects/:name/runs/:id/cancel",
    { schema: { params: runParams } },
    async (req, reply) => {
      const repoDir = repoOf(req, reply);
      if (!repoDir) return;
      try {
        await gh(repoDir, ["run", "cancel", req.params.id]);
      } catch (err) {
        return ghReply(req, reply, err);
      }
      return { ok: true };
    },
  );
}
