// Wire types shared between backend and frontend. Types only — no runtime code.

export type AgentName = "claude" | "antigravity" | "codex";

export interface Project {
  name: string;
  branch: string;
  dirty: boolean;
  running: number;
  waiting: number;
  done: number;
  agents: AgentName[];
  lastSessionAt: string | null;
  /** Name of the main repo this project is a linked git worktree of, if any. */
  worktreeOf: string | null;
}

export interface Session {
  id: string;
  project: string;
  agent: AgentName;
  title: string;
  createdAt: string;
  endedAt: string | null;
  status: "running" | "waiting" | "done";
  /**
   * The one-line verdict the agent wrote about its own work, or null when it
   * wrote none. Scheduled runs have always been asked for this; every session
   * is now, so a card can say what the agent concluded rather than only
   * whether its tmux session is still alive.
   */
  report: string | null;
  /** That verdict as one word, falling back to where the session got to. */
  outcome: "ok" | "attention" | "failed" | "running" | "done";
  /**
   * What it left in the repo. Null while it runs — this is measured once, when
   * the session is first seen finished — and null for a session that started
   * somewhere that is not a git repo.
   */
  work: SessionWork | null;
  /**
   * What it cost in tokens, measured with `work`. Null while it runs, and for
   * a session that left no transcript.
   */
  usage: SessionUsage | null;
  /**
   * Seconds since the session's pane last printed anything; null once it has
   * ended, and null while tmux cannot be asked. What it answers is the question
   * a status alone cannot: whether a running session is working or finished
   * hours ago and left its pane at a shell.
   */
  idleSeconds: number | null;
  /** How far a person has got reading what it did. */
  review: ReviewSummary;
  /**
   * The maintainer stage this session is running, when a schedule started it
   * that way: permissions that deny rather than ask, and a scheduler that ends
   * it when its agent exits or after a wall-clock cap. Null for every session
   * a person started or an ordinary schedule did.
   */
  unattended: MaintainerStage | null;
}

/** Where the reader landed on a run, once they have read it. */
export type ReviewVerdict = "approved" | "needs-work";

/** A run's review as a row can show it: a count and a verdict, no paths. */
export interface ReviewSummary {
  /** Files marked read. Against `work.files` for the "3 of 9" a row shows. */
  reviewed: number;
  /** Null until someone says; a run can be fully read and still undecided. */
  verdict: ReviewVerdict | null;
}

/** The same review with the paths in it, for the screen doing the reviewing. */
export interface SessionReview extends ReviewSummary {
  /** Repo-relative paths marked read, as the changes list spells them. */
  files: string[];
}

/**
 * The repo's movement while a session held it, so a run's one-line verdict can
 * be checked against what it actually did.
 *
 * "While it held it" rather than "what it did": these are measured from the
 * commit HEAD was on when the session started, so a second session committing
 * in the same repo over the same window is counted here too. On a bench where
 * the scheduler refuses to overlap a schedule with itself that is rare, and the
 * alternative — attributing commits to a session — is not something git records.
 */
export interface SessionWork {
  /** Commits added to HEAD since the session started. */
  commits: number;
  /** Files those commits touched. */
  files: number;
  /** Files left with uncommitted changes. */
  dirty: number;
  /** Commits the upstream branch has not got; null when there is no upstream. */
  unpushed: number | null;
  /** The branch it ended on. */
  branch: string;
}

/**
 * What a session cost in tokens, read from its transcript when it is first
 * seen finished. Not a bill — every session runs on the subscription — but
 * the share of that subscription's allowance the session took.
 */
export interface SessionUsage {
  /** Uncached prompt tokens. */
  input: number;
  output: number;
  /** Prompt tokens served from the cache; most of a long session. */
  cacheRead: number;
  /** Prompt tokens written to the cache. */
  cacheWrite: number;
  /** API messages, which is what the model was called. */
  turns: number;
  /**
   * What the same tokens would have cost at API list prices, per model. A
   * notional figure: every session runs on the subscription and none of this
   * is billed. Absent on a session measured before prices were kept.
   */
  costUsd?: number;
}

/** Tokens over a trailing window, as the hub shows them. */
export interface UsageWindow {
  label: string;
  /** Trailing days; 0 is all time. */
  days: number;
  tokens: SessionUsage;
  /** Finished sessions the window covers. */
  sessions: number;
  /** Of the window's total, what the maintainer's stage runs spent. */
  unattended: number;
  /** The window's notional API cost, see SessionUsage.costUsd. */
  costUsd: number;
}

/** One day's tokens, for the bar row. */
export interface UsageDay {
  /** YYYY-MM-DD in the pod's timezone. */
  date: string;
  total: number;
  unattended: number;
  costUsd: number;
}

/** One month's tokens, for the all-time bar row. */
export interface UsageMonth {
  /** YYYY-MM in the pod's timezone. */
  month: string;
  total: number;
  unattended: number;
  costUsd: number;
}

/** How full the plan's windows were at one moment; the pod samples hourly. */
export interface PlanSample {
  at: string;
  /** Percent of the five-hour window used. */
  session: number;
  /** Percent of the week used. */
  week: number;
}

/** One of the plan's rate-limit windows, as the account reports it. */
export interface PlanLimit {
  /** Percent of the window already used. */
  percent: number;
  /** When the window rolls over; null when the account gave none. */
  resetsAt: string | null;
}

/**
 * How much of the subscription's allowance is left, read from the account
 * rather than inferred from tokens — the same figures Claude Code's own
 * `/usage` screen shows, and reading them costs no usage at all. Best effort:
 * the endpoint is not a documented one, so this is null whenever it does not
 * answer, and nothing else depends on it.
 */
export interface PlanUsage {
  /** The rolling five-hour window. */
  session: PlanLimit;
  /** The rolling seven-day window, all models together. */
  week: PlanLimit;
  /** Per-model seven-day windows, when the plan has them. */
  models: { model: string; percent: number }[];
  fetchedAt: string;
  /**
   * The last week of hourly samples, oldest first. The account keeps no
   * history of its own, so this starts the day the pod started sampling —
   * and it covers everything on the account, not only what ran here.
   */
  history: PlanSample[];
}

export interface UsageSummary {
  windows: UsageWindow[];
  /** The last thirty days by project, largest first, the tail folded into one. */
  projects: { project: string; total: number; sessions: number; costUsd: number }[];
  /** The last thirty days, oldest first, every day present even when zero. */
  days: UsageDay[];
  /** Every month since the first measured session, oldest first. */
  months: UsageMonth[];
  /** How the last thirty days' finished sessions signed off, or ended. */
  outcomes: { ok: number; attention: number; failed: number; done: number };
  plan: PlanUsage | null;
}

/** One commit made while a session held the repo. */
export interface SessionCommit {
  /** Abbreviated sha, as git prints it. */
  sha: string;
  subject: string;
}

/** One file the range touched. A binary file reports 0/0 and says so. */
export interface SessionChangedFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

/**
 * The change behind a run's counts: what its commits actually did.
 *
 * The range is the session's own — from the commit HEAD was on when it started
 * to where HEAD was when it was first seen finished, so it stays put once the
 * repo moves on. A live session is measured against HEAD, which does move.
 *
 * Only committed work: anything the agent left uncommitted is in the project's
 * git panel instead, which is where the working tree already lives.
 */
export interface SessionChanges {
  /** Null when the session did not start in a git repo — nothing to measure. */
  from: string | null;
  /** "HEAD" while the session is still running. */
  to: string | null;
  commits: SessionCommit[];
  files: SessionChangedFile[];
  /** Either list hit its cap; there is more than is shown. */
  truncated: boolean;
  /** What has been read of it, and what was concluded. */
  review: SessionReview;
}

/**
 * The whole range as one patch, for reading a run in one scroll rather than a
 * file at a time.
 *
 * One request for the lot: a night's work is a handful of files, and the reader
 * scrolling it should not wait for a round trip per file. The size cap is the
 * reason it can be that blunt — past it the terminal is the right place.
 */
export interface SessionPatch {
  /** Unified diff of the whole range ("" when it committed nothing). */
  diff: string;
  /** Cut at the size cap; what is here is whole files, never half of one. */
  truncated: boolean;
}

/** One file's diff over a session's range. */
export interface SessionFileDiff {
  path: string;
  /** Unified diff text ("" when the range did not touch this file). */
  diff: string;
  /** Cut at the size cap — the rest is only readable in a terminal. */
  truncated: boolean;
}

/** The last lines a session printed, for answering it without a terminal. */
export interface SessionCapture {
  id: string;
  text: string;
  /** False when the session has ended; text is then empty. */
  live: boolean;
}

/** One thing the agent did, shown as a chip rather than its output. */
export interface ChatToolCall {
  /**
   * The transcript's own tool_use id. The chip is an address, not a summary:
   * everything worth reading about the call — the whole command, what came
   * back, the diff it made — is fetched against this when somebody taps it,
   * and so never rides the poll.
   */
  id: string;
  name: string;
  /** The one argument worth reading: a command, a path, a pattern. */
  detail: string;
  /** Its result came back an error. */
  failed?: boolean;
}

/**
 * Something that happened to the session that is not a turn, drawn as a thin
 * centred rail.
 *
 * Everything here is one line by construction: a rail that needs a paragraph is
 * a turn, and a rail nobody reads is noise.
 */
export type ChatEventKind =
  | "command" /** a slash command the person ran */
  | "mode" /** the permission mode changed */
  | "pr" /** a pull request this session opened */
  | "queued" /** a prompt typed while it was busy */
  | "interrupted" /** esc */
  | "error" /** an API error recorded against a turn */
  | "duration" /** how long a turn took */
  | "hook"; /** a stop hook that had something to say */

/** One turn of a session, read back out of the agent's own transcript. */
export interface ChatMessage {
  /**
   * The transcript's uuid for the entry, stable across polls. The entries the
   * CLI writes without one — a mode switch, a pull request link — borrow the
   * uuid of the entry they follow and add their position after it, which is
   * stable for the same reason.
   */
  id: string;
  /** "event" is not a turn: a mode switch, a slash command, an interruption. */
  role: "user" | "assistant" | "event";
  text: string;
  /** What it did on the way to saying this. Empty for user and event rows. */
  tools: ChatToolCall[];
  at: string;
  /** role "event": which rail to draw. */
  event?: ChatEventKind;
  /** role "event", kind "pr": where it points. */
  href?: string;
  /** role "assistant": a question put to the person, in full. */
  ask?: ChatAsk;
  /** role "assistant": a plan put up for approval. */
  plan?: ChatPlan;
  /** Images this turn's calls read or produced. */
  images?: ChatImage[];
}

/**
 * An image the session read or produced. Its bytes are never in this object.
 *
 * Two ways to reach them, and the difference is worth the field. A file in the
 * repo is already served by the route the file viewer uses, scoped the way
 * every other file read is scoped — so `path` is set and nothing has to be
 * decoded out of the transcript. Anything else, a browser screenshot most of
 * all, exists only inside the transcript and comes from the chat's own route.
 */
export interface ChatImage {
  /** The tool_use id whose result carries it. */
  id: string;
  /** Repo-relative when it is a file in this project; null otherwise. */
  path: string | null;
  mediaType: string;
}

/** One option of a question the agent put to the person. */
export interface ChatQuestionOption {
  label: string;
  description: string;
  /** A sketch of what choosing this would mean. Often absent. */
  preview?: string;
}

export interface ChatQuestion {
  /** The two or three words the CLI puts on the card's chip. */
  header: string;
  question: string;
  multiSelect: boolean;
  options: ChatQuestionOption[];
  /** The labels chosen, once it was answered. Empty while it is still asking. */
  chosen: string[];
}

/**
 * A question the agent put to the person, as a card rather than a chip.
 *
 * The whole thing — every option, every description — is written to the
 * transcript, so this is the one part of the CLI's own interface that can be
 * rebuilt exactly rather than scraped, and it reads the same on a session that
 * ended weeks ago as it did on the day.
 */
export interface ChatAsk {
  /** The tool_use id: what an answer would be sent against. */
  id: string;
  questions: ChatQuestion[];
  /** False while it is still waiting for somebody. */
  answered: boolean;
}

/**
 * A plan put up for approval.
 *
 * The markdown is thousands of words and does not travel with the poll: the
 * card carries what it is called and how long it is, and asks for the rest when
 * somebody opens it.
 */
export interface ChatPlan {
  id: string;
  /** Its first heading, or its first line when it has no heading. */
  title: string;
  chars: number;
  /** Null while it is still up; true approved, false sent back for more work. */
  approved: boolean | null;
}

/**
 * One tool call opened up: fetched when somebody taps a chip, never polled.
 *
 * This is the other half of the bargain the chip makes. The poll stays flat
 * whatever the session did — a chip for a test run that printed a megabyte
 * costs the same as one for `ls` — and the megabyte only moves when a person
 * asks to read it.
 */
export type ChatDetail =
  | {
      kind: "tool";
      name: string;
      /** The arguments: the one that matters verbatim, else the whole input. */
      input: string;
      /** What came back, capped. Empty for a call still in flight. */
      output: string;
      /**
       * An edit as unified-diff lines, ready for `diffLineClass`. Empty for
       * every other tool — a diff is the one output worth drawing rather than
       * printing.
       */
      patch: string[];
      failed: boolean;
      /** Either half hit the cap; the rest is only readable in a terminal. */
      truncated: boolean;
    }
  | { kind: "plan"; markdown: string }
  | {
      kind: "agent";
      /** "Explore", "Plan", "general-purpose"… */
      agentType: string;
      description: string;
      /** The subagent's own conversation, read exactly as this one is. */
      messages: ChatMessage[];
      /** Its transcript was longer than the window opened on it. */
      truncated: boolean;
    }
  /** The reference is not in the window the caller asked about. */
  | { kind: "none" };

/**
 * A numbered menu the CLI is drawing right now, scraped off the pane.
 *
 * The only part of this view that does not come from the transcript, because a
 * permission dialog is drawn and never written down. See backend/src/tui-prompt.ts
 * for why that is worth one exception and how the bet is hedged.
 */
export interface TuiPrompt {
  question: string;
  /**
   * Several answers, ticked one at a time and then submitted together.
   *
   * The difference is not cosmetic: on a single-select the number *is* the
   * answer and submits on its own, and on a multi-select it toggles a box and
   * the dialog stays open. Sending the same keystroke to the wrong one either
   * answers a question nobody finished or ticks a box nobody wanted.
   */
  multiSelect: boolean;
  options: {
    number: number;
    label: string;
    /** The cursor is on this one. */
    selected: boolean;
    /** Multi-select only: its box is ticked. */
    checked?: boolean;
  }[];
}

/** What a session is blocked on, if anything, as its terminal shows it. */
export interface SessionPrompt {
  /** Null when nothing parses — which includes "it simply finished its turn". */
  prompt: TuiPrompt | null;
  /**
   * The permission mode the pane's status line shows, or null when it shows
   * none. Live, unlike `SessionChat.permissionMode`, which is per-turn.
   */
  mode: string | null;
  /**
   * True while a turn is actually running. `Session.status` cannot say this:
   * it is "running" both for an agent thinking and an agent sat idle at an
   * empty prompt.
   */
  busy: boolean;
  /** What it says it is doing, when that parses. Decoration. */
  doing: string | null;
}

/** One item of the agent's own checklist, as the CLI shows on ctrl+t. */
export interface ChatTodo {
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * A session as a conversation instead of a terminal.
 *
 * Read from the transcript the agent already writes, so this costs a file read
 * and nothing else — no second model, no replay, no tokens.
 */
export interface SessionChat {
  /** Null when there is no transcript: another agent, or it has not started one. */
  conversationId: string | null;
  messages: ChatMessage[];
  /** Tool calls made since the last thing it said — work in flight. */
  pending: ChatToolCall[];
  /** The window did not reach the start of the conversation. */
  truncated: boolean;
  /**
   * The checklist as the window last saw it.
   *
   * State rather than a delta, so it is re-sent every poll — a handful of
   * subjects is a couple of hundred bytes, and a delta protocol for a list that
   * is replaced wholesale is not worth the bug.
   */
  todos: ChatTodo[];
  /** The permission mode it is in; "" when it never said. */
  permissionMode: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  modified?: boolean;
  children?: TreeNode[];
}

/**
 * The file tree, plus whether the walk ran out of budget. Without the flag a
 * huge repo came back quietly missing files, which reads as "the file is not
 * there" rather than "the tree stopped early".
 */
export interface Tree {
  nodes: TreeNode[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  /**
   * Version of the file as read. Send it back as `If-Match` on PUT and the save
   * is rejected with 412 if anything wrote to the file meanwhile — the agent
   * shares this working tree, so that is a normal thing to happen rather than
   * an edge case.
   */
  etag: string;
}

export interface FileDiff {
  path: string;
  /** Unified diff text ("" when there is no change to show). */
  diff: string;
}

/** Where a phone upload landed, repo-relative — the path to hand to the agent. */
export interface UploadedFile {
  path: string;
}

export interface ListeningPort {
  port: number;
  /** Process or container name, best effort. */
  process: string;
  /** URL reachable from the session browser. */
  url: string;
}

export interface PodFacts {
  /** Bytes on the data volume. */
  diskTotal: number;
  diskFree: number;
  /** Bytes of memory, cgroup-aware. total is 0 when no limit is set. */
  memUsed: number;
  memTotal: number;
  /** Live per-session headless browsers. */
  browsers: number;
  /** `docker system df` rows as strings, null when no daemon is reachable. */
  docker: { type: string; size: string; reclaimable: string }[] | null;
}

/**
 * The cluster this pod runs in, as kubectl prints it.
 *
 * Text rather than parsed rows on purpose: every section here is a `kubectl get`
 * table, and for the CRDs those columns are the ones Argo CD and Kargo chose to
 * show. Parsing them into fields would mean pinning jsonpaths into someone
 * else's API that a chart upgrade is free to move, to produce something no more
 * readable than the table. The only processing done is dropping the healthy pods.
 */
export interface ClusterSnapshot {
  /** False on a bench with no cluster credential — a laptop, CI. */
  reachable: boolean;
  sections: { title: string; text: string }[];
}

export interface GitFileStatus {
  path: string;
  /** One-letter code, VS Code style: M, U (untracked), A, D, R, … */
  status: string;
  /** True when the change is in the index (a partially staged file appears twice). */
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  files: GitFileStatus[];
}

export interface GitBranches {
  current: string;
  /** Local branch names. */
  local: string[];
  /** Remote-tracking branches, e.g. "origin/main". */
  remote: string[];
  /** Upstream of the current branch ("origin/main"), null when it has none. */
  upstream: string | null;
  /** Commits on the branch its upstream lacks; 0 without an upstream. */
  ahead: number;
  /** Commits on the upstream the branch lacks; 0 without an upstream. */
  behind: number;
}

/** Outcome of putting a repo on an up-to-date default branch for a new session. */
export interface BranchSync {
  /** The branch the session actually starts on. */
  branch: string;
  status: "synced" | "skipped" | "failed";
  /** Why it was skipped or how it failed; absent when synced. */
  detail?: string;
}

export interface CreatedSession extends Session {
  sync: BranchSync;
}

/** A pull request as the project screen lists it. */
export interface PullRequest {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  /** "" until a review is submitted, else APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED. */
  reviewDecision: string;
  /** Every check on the head commit, rolled into one word. */
  checks: "passing" | "failing" | "pending" | "none";
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** An issue comment or a review, flattened into one stream. */
export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  /** Review verdict (APPROVED, CHANGES_REQUESTED, …); "" for a plain comment. */
  state: string;
}

export interface PullRequestDetail extends PullRequest {
  body: string;
  /** Comments and reviews merged, oldest first. */
  comments: PrComment[];
  files: { path: string; additions: number; deletions: number }[];
}

/** Unified diff of a pull request; truncated when it was cut to fit. */
export interface PrDiff {
  diff: string;
  truncated: boolean;
}

/** Outcome of a squash merge. detail carries anything that went wrong afterwards. */
export interface MergeResult {
  merged: true;
  /** The branch the repo is on now — gh switches to the base branch on success. */
  branch: string;
  detail?: string;
}

export interface WorkflowRun {
  id: number;
  title: string;
  workflow: string;
  status: "queued" | "in_progress" | "completed";
  /** "" while the run is unfinished, else success / failure / cancelled / skipped. */
  conclusion: string;
  event: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string;
  steps: { name: string; status: string; conclusion: string }[];
}

export interface WorkflowRunDetail extends WorkflowRun {
  jobs: WorkflowJob[];
}

/** Failed-job logs, sanitized; truncated when older output was dropped. */
export interface RunLog {
  log: string;
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchFlags {
  /** Case-sensitive match (default: insensitive). */
  case?: boolean;
  /** Whole-word match. */
  word?: boolean;
  /** Treat the query as a regex (default: literal). */
  regex?: boolean;
}

export interface ReplaceResult {
  files: number;
  replacements: number;
}

/**
 * What a schedule does when it fires.
 *
 * "session" starts a claude session in a project and submits the prompt.
 * "assistant" runs one unattended assistant turn instead: no repo, no terminal,
 * no writes — it reads the bench and answers, and reaches the phone through its
 * notify tool when the answer needs somebody.
 */
export type ScheduleKind = "session" | "assistant";

/**
 * A shipped maintainer stage a schedule can run instead of a prompt of its own.
 * "scout" reads a repo and files the work it finds as issues; "build" takes the
 * oldest queued issue into a worktree and opens a pull request for it; "gate"
 * checks the open pull requests out fresh, reviews them, and merges the ones
 * the repo's contract lets merge on their own.
 */
export type MaintainerStage = "scout" | "build" | "gate";

/** An issue on the maintainer's queue, as the inbox lists it. */
export interface MaintainerIssue {
  project: string;
  number: number;
  title: string;
  state: "queued" | "in-progress" | "blocked";
  tier: "auto" | "review" | null;
  url: string;
  updatedAt: string;
}

/**
 * A recurring prompt: on its cron the pod starts a claude session in the
 * project and submits the prompt, unattended (auto permission mode).
 */
/**
 * What a cron pattern would do, before anybody saves it.
 *
 * Answered by the pod rather than worked out in the browser: a pattern is read
 * in the pod's own timezone (env.TZ), so a phone in another one would preview
 * times the schedule will not fire at.
 */
export interface CronPreview {
  /** False when croner cannot build a job from the pattern. */
  valid: boolean;
  /** The next few fire times as ISO instants, newest last. Empty when invalid. */
  next: string[];
}

export interface Schedule {
  id: string;
  /** Human label; also the title of the sessions it starts. */
  name: string;
  kind: ScheduleKind;
  /** The repo it runs in. Empty for an assistant schedule, which has none. */
  project: string;
  /** Five-field cron, read in the pod's timezone. */
  cron: string;
  /**
   * Random delay added to each fire, in minutes (0 = fire on the dot). Spreads
   * schedules that share a cron so they don't all start at once.
   */
  jitterMinutes: number;
  prompt: string;
  /**
   * Session schedules only: run one of the shipped maintainer stages, in the
   * strict sense of unattended — permissions that deny rather than ask, a
   * report or a kill, never a session left waiting for someone. `prompt` is
   * then optional notes appended to the stage's own prompt. Null is an
   * ordinary schedule in auto mode.
   */
  stage: MaintainerStage | null;
  /**
   * Assistant schedules only: don't run at all on a day when no session ended.
   * A pass over what happened has nothing to read when nothing happened, and a
   * turn that discovers that still costs a model call.
   */
  skipWhenIdle: boolean;
  /**
   * Assistant schedules only: which council member answers this one. Empty is
   * the chair, which is what every schedule written before the council existed
   * gets. One advisor, one model call — a schedule never holds a meeting.
   */
  member: string;
  /**
   * Assistant schedules only: let the chair convene the council on this one.
   * Off by default, and deliberately opt-in per schedule — turning it on turns
   * a one-call briefing into up to five, and a morning briefing whose usual
   * answer is "nothing needs you" should not quietly become the expensive kind.
   */
  convenes: boolean;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  /**
   * When the timer last fired, whether or not the firing started anything, and
   * null until it first does. Distinct from lastRunAt, which is when a run was
   * last *recorded*: a tick dropped for the pause switch or an idle day records
   * nothing and still fired. The gap between this and the cron is how a boot
   * tells a tick the pod was down for from one it deliberately skipped.
   */
  lastFiredAt: string | null;
  /** Session the last run started; null for an assistant run, which starts none. */
  lastSessionId: string | null;
  /** Why the last run started nothing; null when it did. */
  lastError: string | null;
  /**
   * The verdict the last run wrote for itself ("ok: …"); null when it wrote
   * none. For an assistant schedule this is what the turn replied.
   */
  lastReport: string | null;
  /** Next fire time, computed on read; null when disabled. */
  nextRunAt: string | null;
}

/**
 * One firing of a schedule, as the inbox lists it. `outcome` is the whole run
 * rolled into one word: what the run said about itself when it said anything,
 * otherwise where it got to.
 */
export interface ScheduleRun {
  scheduleId: string;
  /** The schedule's name at the time of reading. */
  schedule: string;
  kind: ScheduleKind;
  /** The maintainer stage the schedule runs; null for a prompt of its own. */
  stage: MaintainerStage | null;
  /** Empty for an assistant run, which belongs to no repo. */
  project: string;
  at: string;
  /** Null for an assistant run, which starts no session. */
  sessionId: string | null;
  /** Why it started nothing; null when it started a session. */
  error: string | null;
  /**
   * The verdict the run wrote for itself; null when it wrote none. For an
   * assistant run this is the reply itself.
   */
  report: string | null;
  outcome: "ok" | "attention" | "failed" | "blocked" | "running" | "done";
  /**
   * What the run left in the repo, once its session has finished — the evidence
   * behind the sign-off. Null for an assistant run, which touches nothing, and
   * for a run still going.
   */
  work: SessionWork | null;
  /** What the run's session cost in tokens; null as for `work`. */
  usage: SessionUsage | null;
}

export interface SettingVar {
  key: string;
  /** Where the variable is defined. */
  source: "env" | "settings" | "unset";
  /**
   * Enough of the value to recognise it, never enough to use it: the first and
   * last four characters and the length. Null when nothing is set. The whole
   * value is never rendered — it is fetched by the copy button and goes
   * straight to the clipboard (see /api/settings/vars/:key/reveal).
   */
  fingerprint: string | null;
}

export interface Settings {
  /** Server config from the deployment (read-only, non-secret). */
  server: Record<string, string>;
  vars: SettingVar[];
  /** Kill switch: no schedule fires on its cron while this is on. */
  schedulesPaused: boolean;
  /** GitHub owners the feed never files anything from (see pollers.ts). */
  blockedOwners: string[];
}

/** What a browser needs to subscribe to session pushes, and who is subscribed. */
export interface PushStatus {
  /** VAPID public key; the private half never leaves the pod. */
  publicKey: string;
  devices: number;
}

/**
 * Outcome of the settings page's "send test". The push service's own rejection
 * comes back verbatim: it is the only way to tell "delivered" from "refused"
 * (a bad VAPID subject fails every push with the same opaque 403), and the app
 * has no public surface to leak it to.
 */
export interface PushTestResult {
  devices: number;
  sent: number;
  failed: number;
  error?: string;
  /** Set when the same message went out recently and this one was dropped. */
  suppressed?: boolean;
}

/** An installed SSH key. Private halves are write-only and never leave the pod. */
export interface SshKey {
  name: string;
  publicKey: string;
  fingerprint: string;
}

export type WsClientMsg =
  | { t: "in"; data: string }
  | { t: "resize"; cols: number; rows: number }
  /** Scroll the pane's history: positive lines go back, negative go forward. */
  | { t: "scroll"; lines: number };

/** Browser pane websocket, client -> server. Mouse/key fields mirror CDP Input.dispatch*. */
export type BrowserClientMsg =
  | { t: "nav"; url: string }
  | { t: "back" }
  | { t: "forward" }
  | { t: "reload" }
  | {
      t: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "left" | "middle" | "right" | "none";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      t: "key";
      type: "keyDown" | "keyUp";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers?: number;
    }
  | { t: "resize"; width: number; height: number };

/** Browser pane websocket, server -> client. */
export type BrowserServerMsg =
  | { t: "init"; url: string; cdpUrl: string }
  | { t: "frame"; data: string; w: number; h: number }
  | { t: "url"; url: string }
  | { t: "error"; message: string };

/**
 * One tool call the assistant made inside a turn. Kept as a summary rather than
 * the full input: the chat draws these as chips, and a tool's arguments can be
 * a whole file.
 */
export interface AssistantToolCall {
  name: string;
  /** Short human-readable argument, e.g. the path read or the command run. */
  detail: string;
}

/** One turn in a thread. */
export interface AssistantEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Tool calls the assistant made before saying this. Empty for user turns. */
  tools: AssistantToolCall[];
  at: string;
  /** Set when the turn ended badly; the text then carries what went wrong. */
  failed?: boolean;
  /** Upload names attached to a user turn, served from /api/assistant/uploads. */
  images?: string[];
  /**
   * Which council member said this. Absent means the chair, so every thread
   * written before the council existed reads back unchanged.
   */
  member?: string;
}

export interface AssistantThread {
  /**
   * The claude conversation id, which verksted mints rather than parses: it is
   * passed in with --session-id, so `claude --resume <id>` in a terminal lands
   * on this same thread.
   */
  conversationId: string;
  /** "thinking" while a turn is in flight; nothing can be sent until it is not. */
  status: "idle" | "thinking";
  entries: AssistantEntry[];
  /**
   * The reply being written right now, if one is. Never stored — it becomes an
   * entry the moment the model finishes the sentence — so it only ever arrives
   * over the socket, never from a plain GET.
   */
  live?: string;
  /**
   * Members with a turn in flight right now, by id. Only the chair streams its
   * tokens through `live`: three members writing at once onto a phone is noise,
   * and their answers are two or three sentences, so a chip that says who is
   * speaking carries the same information for none of the traffic.
   */
  speaking?: string[];
}

/**
 * One past conversation, as the thread list shows it.
 *
 * Enough to pick it out and nothing more: the entries come over the socket once
 * it is opened, the way the current thread's always have.
 */
export interface AssistantThreadSummary {
  conversationId: string;
  /** The first thing typed into it, cut to a line. */
  title: string;
  /** When the last entry landed. */
  at: string;
  /** How many things were typed into it. */
  turns: number;
}

/**
 * One member of the council.
 *
 * Data rather than code: a member is a JSON file on the volume, so adding one
 * is a form on the settings page rather than a redeploy. What is deliberately
 * *not* here is anything that could hand a member a shell — the denied built-in
 * tools and --strict-mcp-config are fixed in assistant.ts and are not fields.
 */
export interface CouncilMember {
  /** Slug; names the file, so it is validated the way a memory slug is. */
  id: string;
  /** What it answers to, and calls itself. */
  name: string;
  /** One line: what this one is for. Shown in the UI and given to the chair. */
  remit: string;
  /** Free text: how this one thinks. Carried with every turn, so it is capped. */
  persona: string;
  model: string;
  effort: AssistantEffort;
  /** Verksted MCP tools this member may use; validated against the inventory. */
  tools: string[];
  /** Whether it may read the web (WebFetch/WebSearch). */
  web: boolean;
  colour: CouncilColour;
  /**
   * Which portrait is drawn for this one. A closed set, because each face is a
   * drawing in the frontend rather than a file: a name with no drawing behind
   * it would render as nothing at all.
   */
  face: CouncilFace;
  /**
   * Which of the pod's voices reads this one aloud. Empty means the device's
   * default, which is what every advisor sounded like before: one narrator
   * reading everybody, which is exactly what makes a meeting unlistenable.
   */
  voice: string;
  /** The one who takes every turn and decides who else is convened. */
  chair: boolean;
  enabled: boolean;
}

/**
 * Which hue attributes a member in the thread. A closed set, because the
 * palette's other colours already mean things: the state trio (run/wait/fail)
 * and the three agent brands are not free to reuse.
 */
export type CouncilColour = "amber" | "violet" | "teal" | "rose" | "sky" | "lime";

/**
 * The portraits an advisor may wear.
 *
 * Animals rather than people: at the 26px the roster draws them, human faces
 * differ only by hair and read as one face repeated, while a silhouette with
 * ears is recognisable at a glance and from the corner of your eye. The chair
 * is the raccoon, which is the one this bench already had.
 */
export type CouncilFace = "owl" | "fox" | "bear" | "cat" | "robot" | "raccoon";

/** One turn from an older conversation, found by searching them. */
export interface AssistantSearchHit {
  conversationId: string;
  at: string;
  role: "user" | "assistant";
  /** The matching turn, trimmed to the part around the match. */
  text: string;
}

/**
 * The voices the pod itself can speak in, and which one it defaults to.
 *
 * Empty when this pod has no voice model, which is the signal to fall back to
 * whatever the browser has. Unlike the browser's list this is the same on every
 * device, because the speaking happens in one place.
 */
export interface AssistantVoices {
  voices: string[];
  current: string;
}

/**
 * One thing the assistant can do, as its own tool server describes it. The
 * settings page lists these so the assistant does not have to describe itself
 * in a reply.
 */
export interface AssistantTool {
  name: string;
  description: string;
}

export type MemoryType = "preference" | "project" | "reference";
/** "global", or the name of the project the fact belongs to. */
export type MemoryScope = string;

/** One thing verksted has learned about how you work. */
export interface Memory {
  slug: string;
  text: string;
  type: MemoryType;
  scope: MemoryScope;
  /** Where it came from, which is the answer to "why does it think that?". */
  source: string | null;
  createdAt: string | null;
}

/**
 * One thing that happened, as the feed shows it.
 *
 * Written by a poller, judged by triage, acted on by the person. The id is the
 * source's own, so an event becomes one item once and survives a restart; the
 * `version` is what the poller saw last, so a thread that moved on reads as
 * new again rather than as the item you already dismissed.
 */
export type FeedSource =
  | "github"
  | "mail"
  | "calendar"
  | "finance"
  | "docs"
  | "bench"
  | "schedule"
  | "memory"
  | "paper"
  | "intake"
  | "proposal";
export type FeedUrgency = "attention" | "new" | "quiet";
export type FeedState = "new" | "seen" | "done" | "snoozed";

/**
 * What a proposal would do when tapped. Prepared in full by the assistant,
 * shown whole on the card, executed on the pod on the tap and never before.
 */
export type ProposalAction =
  | { kind: "send"; to: string; subject: string; body: string; inReplyTo?: string }
  | {
      kind: "calendar_put";
      summary: string;
      start: string;
      end: string;
      location?: string;
      description?: string;
    }
  | { kind: "merge_pr"; project: string; number: number }
  | { kind: "end_session"; id: string }
  | { kind: "delete_schedule"; id: string };

export interface FeedItem {
  /** `<source>:<the source's own id>`. */
  id: string;
  source: FeedSource;
  /** When it happened, or was first seen. */
  at: string;
  title: string;
  /** Two lines at most: the poller's, until triage rewrites it. */
  detail: string;
  urgency: FeedUrgency;
  state: FeedState;
  /** For a snoozed item: when it comes back. */
  until: string | null;
  /** An app path, or an https URL the screen opens outside the app. */
  link: string | null;
  /** The open loop this belongs to, if triage attached it to one. */
  loop: string | null;
  /** What the assistant did about it, when it did something. */
  did: string | null;
  /** Whether triage has judged it yet. */
  triaged: boolean;
  /** What the poller saw last; a change resets the item to new. */
  version: string;
  /** Whether an attention push went out for it. */
  pushed: boolean;
  /** A proposal's action; only on `source: "proposal"` items. */
  action?: ProposalAction;
}

/**
 * One commitment: what you owe or are owed, kept until it ends.
 *
 * Separate from the memory of facts because a fact stays true and a loop is
 * meant to close.
 */
export interface Loop {
  slug: string;
  what: string;
  who: string | null;
  /** Where it came from: a feed item id, a thread, or "you". */
  from: string | null;
  /** YYYY-MM-DD, when one is known. */
  due: string | null;
  state: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
}

/** One message's envelope, as the feed and the mail tools show it. */
export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  address: string;
  at: string;
  unread: boolean;
}

export interface MailMessage extends MailSummary {
  to: string;
  /** Plain text, HTML reduced, cut at a size a model should read. */
  text: string;
  attachments: string[];
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  /** ISO; for an all-day event, local midnight. */
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  /** A video link, from URL or found in the description. */
  url: string | null;
  description: string | null;
  calendar: string;
}

/** Which of the credentialed sources are set up on this bench. */
export interface SourceStatus {
  mail: boolean;
  calendar: boolean;
  docs: boolean;
}

/** One entry in a directory of the share. */
export interface DocEntry {
  path: string;
  name: string;
  dir: boolean;
  size: number;
  modified: string;
  kind: "dir" | "plain" | "pdf" | "pandoc" | "image" | "other";
}

/** One document that matched a search, with the line that did. */
export interface DocHit {
  path: string;
  excerpt: string;
}

/** The profile page: one markdown file, and how much of its budget it uses. */
export interface Profile {
  text: string;
  used: number;
  budget: number;
}

export interface MemoryList {
  memories: Memory[];
  /** Bytes carried into every session, against the budget. */
  used: number;
  budget: number;
  /** Memories the budget pushed out of the injected block. */
  dropped: number;
}

export type AssistantEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** The assistant's identity and settings, editable on the settings page. */
export interface AssistantConfig {
  /** What it calls itself. Empty means it has no name of its own. */
  name: string;
  model: string;
  effort: AssistantEffort;
  /** Free text appended to its instructions: house style, standing orders. */
  instructions: string;
}

/** One archive in the backup directory, as `vk backups --json` reports it. */
export interface BackupArchive {
  name: string;
  path: string;
  /** Human-readable size, as du prints it. */
  size: string;
  bytes: number;
  /** Seconds since the epoch. */
  mtime: number;
  /**
   * Written under VK_BACKUP_PASSPHRASE. An encrypted archive on a pod without
   * the passphrase reads back with no createdAt or repos — the file is fine,
   * this bench just cannot open it, which is a different thing from junk in
   * the directory.
   */
  encrypted: boolean;
  /** Null for a .tar.gz that is not one of ours, or one this pod cannot open. */
  createdAt: string | null;
  repos: number | null;
  /** Repos that had uncommitted tracked changes when it was taken. */
  dirty: number | null;
}

/** The backup panel: where archives go, what is there, and what is happening. */
export interface BackupStatus {
  dir: string;
  /** False when archives land on the same volume they are protecting. */
  offVolume: boolean;
  freeBytes: number;
  totalBytes: number;
  /** Archives the nightly run keeps; 0 means nothing is scheduled. */
  keep: number;
  archives: BackupArchive[];
  running: boolean;
  /** Result of the last run this process started, if any. */
  lastError: string | null;
  lastFinishedAt: string | null;
}
