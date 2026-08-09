# Backlog

Known gaps agreed to leave for later. Format per entry: what / why deferred /
what unblocks it / where the code lives.

## Verify CI workflow against a real GitHub repo

- **What:** The ci.yml workflow (test job + GHCR image push) has never run.
- **Why deferred:** The repo has no GitHub remote yet and nothing is committed;
  a workflow can only be verified by pushing.
- **Unblocked by:** Creating the GitHub repo, committing, and pushing main; then
  confirm the test job is green and `ghcr.io/<owner>/verksted:latest` appears.
- **Where:** `.github/workflows/ci.yml`

## gh output fixtures are hand-written, not captured from a real gh

- **What:** The gh-backed routes now have coverage through a fake `gh` on PATH
  (`backend/test/github-gh.test.ts`), so the argv, the wire mapping and the
  error statuses are asserted. What that cannot catch is gh changing its own
  output: the fixtures are written from the current `--json` shape by hand, so a
  field renamed in a future gh release would keep the suite green and break the
  app.
- **Why deferred:** Catching that needs real gh output, which needs a token and
  the network — neither exists in CI.
- **Unblocked by:** A CI job with a scoped token against a throwaway repo that
  captures `gh pr list --json …` and diffs it against the fixtures; or pinning
  the gh version in the image and re-capturing on each bump.
- **Where:** `backend/test/github-gh.test.ts` (the fixtures),
  `backend/src/routes/github.ts` (`PR_LIST_FIELDS`, `RUN_LIST_FIELDS`)

## Verify Antigravity headless auth in the pod

- **What:** `ANTIGRAVITY_API_KEY` is documented in `.env.example` but reports on
  agy's headless auth are mixed (some say API key works, some say interactive
  login only). The binary installs and runs (`agy --version` verified in the
  image); auth is untested.
- **Why deferred:** Needs a real key / a deployed pod to test against.
- **Unblocked by:** Milestone-1 cluster verification: set the key, start an
  antigravity session, confirm it authenticates. Fallback: run `agy` once
  interactively in a pod terminal (remote login flow prints a URL); the token
  persists in `$HOME` on the PVC.
- **Where:** `.env.example`, `Dockerfile` (runtime stage)

## Resume support for codex and antigravity sessions

- **What:** The "resume the previous conversation" toggle only maps to a command
  for claude (`claude --continue`). Codex reportedly has `codex resume --last`
  and antigravity may have an equivalent; neither flag is verified. The same gap
  costs them automatic restore after a pod restart (`restoreSessions`): that
  needs both a resume-by-id flag and a way for the CLI to report the id it is
  on, which claude does through its `SessionStart`/`UserPromptSubmit` hooks.
  Codex and antigravity sessions are still ended by the list sweep on restart.
- **Why deferred:** Can't verify the flags without running those CLIs
  authenticated in the pod.
- **Unblocked by:** Testing the resume flag of each CLI in a pod terminal, then
  adding it to `RESUME_COMMANDS`; for restore, finding each CLI's equivalent of
  a hook that exposes the conversation id and writing it to `$VK_CONV_FILE`.
- **Where:** `backend/src/sessions-store.ts` (`RESUME_COMMANDS`,
  `restoreSessions`), `backend/src/claude-hooks.ts` (the `CONVERSATION` hook to
  copy), `frontend/src/screens/Project.tsx` (picker label)

## Browser pane: follow agent-created browser contexts

- **What:** The pane follows pages in the default Chromium context (covers
  playwright `connectOverCDP` default-context use and the playwright MCP's
  `--cdp-endpoint`). If an agent creates a new context (`browser.newContext()`),
  its pages are not streamed.
- **Why deferred:** Needs browser-level target discovery (CDP
  Target.setDiscoverTargets) instead of per-context page events; the common
  agent flows don't create contexts.
- **Unblocked by:** Hitting the limitation in practice; then switch page
  tracking to target events.
- **Where:** `backend/src/browser.ts` (`launch`, `setCurrent`)

## Session browser for antigravity/codex agents

- **What:** claude gets the session browser automatically (playwright MCP via
  `--mcp-config`, see `claude-hooks.ts`). agy and codex only get the raw env
  contract: connect playwright to `$VK_BROWSER_CDP`; if refused, first
  `curl -X POST http://127.0.0.1:8080/api/sessions/$VK_SESSION_ID/browser/start`.
  Their MCP config mechanisms are unverified.
- **Why deferred:** Same reason as their status hooks — each CLI's config
  mechanism needs verifying in the pod first.
- **Unblocked by:** Confirming agy/codex MCP config formats, then generating
  the equivalent of claude-mcp.json for them.
- **Where:** `backend/src/claude-hooks.ts` (`ensureMcpConfig`, pattern to copy),
  `backend/src/sessions-store.ts` (`createSession`)

## The dind sidecar's data mount has never been checked in the pod

- **What:** Both halves are merged — `docker-compose.yml` mounts the data volume
  into the `dind` service at `/data`, and Homelab #550 does the same for the
  pod's sidecar — but only the dev half has been exercised. Unverified in the
  pod: that the PVC really mounts into the sidecar (ReadWriteOnce, now claimed
  by two containers in one pod), and that a bind mount from a session then
  reaches the same files across NFS rather than a stale or empty view.
- **Why deferred:** Needs the ArgoCD sync and a session in the real pod.
- **Unblocked by:** `vk doctor` in a pod session, in a repo that has files in
  it, reporting the bind-mount probe ok.
- **Where:** Homelab repo `k8s/talos/apps/verksted/deployment.yaml`; this repo
  `runtime/vk`, `docker-compose.yml` (the `dind` service)

## File watching over the NFS PVC is unverified

- **What:** With the sidecar mount above, a session can bind-mount its repo into
  a dev container for hot reload. Whether inotify events cross the NFS volume
  from the writing container to the watching one has never been checked in the
  pod. If they do not, every watch-based dev server in a session needs polling,
  and `SANDBOX.md` should say so as fact rather than as a caveat.
- **Why deferred:** Needs the sidecar mount deployed first; unanswerable from a
  laptop, where the data volume is local and inotify works.
- **Unblocked by:** One session in the pod running a bind-mounted vite or tsx
  watch and editing a file from the terminal.
- **Where:** `runtime/SANDBOX.md` ("File watching")

## agy gets neither the sandbox note nor the house rules

- **What:** `sandbox-doc.ts` writes to claude (`~/.claude/CLAUDE.md`) and codex
  (`~/.codex/AGENTS.md`). antigravity's equivalent — whether it reads a global
  instructions file at all, and under what name — is unverified, so agy sessions
  start without any of it.
- **Why it matters more than it used to:** that file now carries the two house
  rules as well as the sandbox note. An antigravity session is the one place on
  this bench where "leave no sign an agent wrote this" and "ask before anything
  irreversible" are not said at all — and memory-store.ts injects through the
  same list, so a agy session is also told nothing verksted has learned. The
  same three-way gap already exists for agy's status hooks and MCP config, so
  this is one verification pass, not three.
- **Why deferred:** Needs confirming in the pod against a real authenticated
  CLI, and agy's headless auth is itself unverified (see the entry above).
- **Unblocked by:** Confirming what global instructions file agy reads, then
  adding it to `MEMORY_FILES` — both blocks and memory follow automatically.
  Until then, prefer claude or codex for anything that will commit.
- **Where:** `backend/src/sandbox-doc.ts` (`MEMORY_FILES`),
  `backend/src/memory-store.ts` (`inject`, same list)

## Milestone 4 remainder (per SPEC.md)

- **What:** Per-agent auth status + MCP server count in the hub footer. PWA,
  status hooks, ntfy pushes, and the pod-facts footer (disk/mem/browsers/docker)
  have shipped. The WireGuard chip that was also listed here is gone rather than
  finished: the app is unreachable except through the tunnel, so the chip could
  only ever read "connected", and a tunnel that drops is already reported by the
  connection banner.
- **Why deferred:** Needs the pod deployed (auth is a cluster fact).
- **Unblocked by:** Milestone-1 deployment.
- **Where:** `backend/src/routes/facts.ts` (extend)

## A scheduled run has never been watched end to end in the pod

- **What:** The launch decision is now covered
  (`backend/test/scheduler-run.test.ts`): a tick starts a claude session in the
  right repo, the prompt travels as `VK_PROMPT`, the run gets
  `--permission-mode auto`, and a tick is skipped while the previous run is
  open. What a fake tmux cannot answer is what the agent then does: whether the
  prompt arrives _submitted_ rather than sitting in the input box, and whether
  auto mode really carries an unattended run through `gh pr` calls without
  stopping.
- **Why deferred:** Both need a real authenticated claude in a real pane.
- **Unblocked by:** One real scheduled run in the pod: point a schedule at a
  repo, hit "run now", confirm a session appears and the agent is already
  working rather than waiting on an unsent prompt.
- **Where:** `backend/src/scheduler.ts`, `backend/src/sessions-store.ts`
  (`launchAgent`), `backend/test/scheduler-run.test.ts`

## A catch-up has never run after a real pod restart

- **What:** The rule is covered (`backend/test/scheduler-run.test.ts`, the
  `missedTick` and "a tick the pod was down for" blocks): a tick inside the
  window starts a session on the way up, an older one is recorded as missed, a
  schedule that never fired is left alone, and a tick this process was up for is
  not treated as missed. All of it against a fake clock and a fake tmux. What
  that cannot show is a real restart: that `lastFiredAt` survives on the PVC
  across a pod replacement (it is written to the schedule's own JSON, so it
  should), and that the hour-long window is the right one in practice rather
  than in theory.
- **Why deferred:** It needs a deployed pod restarted across a schedule's cron,
  which is the same wall every other unattended-path entry here sits behind.
- **Unblocked by:** Restarting the pod deliberately a few minutes after a
  schedule's cron and reading the inbox — a run should be there, either the
  caught-up one or a "missed while the pod was down" row. If catch-ups turn out
  to be unwanted noise, `CATCH_UP_WITHIN_MS` is the one number to turn down.
- **Where:** `backend/src/scheduler.ts` (`catchUp`, `missedTick`,
  `CATCH_UP_WITHIN_MS`), `backend/src/schedules-store.ts` (`stampFired`)

## A run's evidence is counts, with no way to read the diff behind them

- **What:** An inbox row now says "3 commits · 2 files · 3 unpushed on main"
  under the sign-off. What it cannot do is show the change: there is no
  commit-range diff endpoint, only per-file working-tree diffs
  (`GET /api/projects/:name/diff?path=`) and PR diffs. So the row answers "did
  it do anything" but not "what did it do", and reading that still means opening
  the session's terminal.
- **Why deferred:** A range diff is a new endpoint plus a review screen, and the
  size question a phone makes real — a night's work can be megabytes, so it
  needs paging or per-file selection rather than one blob. The counts are the
  useful part and stand on their own.
- **Unblocked by:** Wanting to review an overnight run from the phone rather
  than judge it by its numbers. `startCommit` is already stored on the session
  metadata, so the range is there; what is missing is the endpoint and the view.
- **Where:** `backend/src/sessions-store.ts` (`Meta.startCommit`,
  `captureWork`), `backend/src/git.ts` (`workSince`),
  `backend/src/routes/files.ts` (the per-file diff route to extend),
  `frontend/src/screens/Inbox.tsx` (`workLabel`)

## What a session's work counts is the repo's movement, not the session's

- **What:** `workSince` measures from the commit HEAD was on when the session
  started to where it is when the session is first seen finished. A second
  session committing in the same repo over the same window is counted in the
  first one's row.
- **Why deferred:** Git records who authored a commit, not which agent session
  produced it, so attribution would mean tagging commits as they are made — a
  hook installed into the user's repos, which is the same decision the house
  rules entry below is waiting on. On a bench where the scheduler refuses to
  overlap a schedule with itself, the overlap is rare enough to state rather
  than engineer around.
- **Unblocked by:** Two sessions in one repo producing a row that misleads in
  practice. The cheap half-fix is to record the end commit as well and show the
  range, so at least the row can be checked.
- **Where:** `backend/src/git.ts` (`workSince`),
  `backend/src/sessions-store.ts` (`captureWork`), `shared/api.ts`
  (`SessionWork`, where the caveat is written down)

## Event triggers: react to the repo, not only to the clock

- **What:** Schedules fire on a cron. "Keep an eye on my repos" really means
  reacting to a change — a PR opened, CI turning red, a review requested —
  which today can only be approximated by a frequent cron that mostly finds
  nothing and burns a session doing it.
- **Why deferred:** It is a new subsystem (a `gh` poller, per-trigger
  last-seen state so one event fires once, and its own failure modes), and
  stacking it on a scheduler that has never yet fired in the pod would mean
  debugging two unproven things at once. One hard constraint is already known:
  the pod is WireGuard-only and cannot receive inbound, so GitHub webhooks are
  out — it has to be polling built on `gh`.
- **Unblocked by:** A week of real scheduled runs, so the launch path and the
  report contract are known-good first.
- **Where:** `backend/src/scheduler.ts` (the run path to reuse),
  `backend/src/gh.ts` and `backend/src/routes/github.ts` (the PR/checks
  queries), `backend/src/schedules-store.ts` (the record shape to extend)

## Nothing checks that a scheduled run actually writes its report

- **What:** The report loop is covered on the reading side — `readReport`
  (first line, cap, path guard), `shouldNotify` (ok stays quiet, attention /
  failed / no report push) and the schedule surfacing `lastReport`. What is
  unverified is the writing side: that an agent handed `REPORT_CONTRACT`
  reliably writes `$VK_REPORT_FILE` before it stops, and picks a sensible one
  of the three words. If it forgets, the run falls back to the old "session
  finished" push — noisier than intended, but nothing breaks.
- **Why deferred:** It is a prompt-adherence question, not a code one; it can
  only be answered by watching real runs.
- **Unblocked by:** A week of real scheduled runs in the pod. If adherence is
  poor, the fallback is a `Stop` hook that writes a default report when the
  agent left none, so silence never masquerades as "ok".
- **Where:** `backend/src/scheduler.ts` (`REPORT_CONTRACT`),
  `backend/src/sessions-store.ts` (`readReport`), `backend/src/notifier.ts`
  (`shouldNotify`)

## Terminal dictation is unverified on a real iPhone

- **What:** The mic key in the session toolbar uses the browser's own speech
  recognition (`webkitSpeechRecognition`) and types the transcript into the
  pane. Written against the documented API; never exercised on the device it
  exists for. Unknown: whether iOS Safari prompts for the microphone in an
  installed PWA the way it does in a tab, and whether one tap reliably captures
  a whole spoken prompt or cuts off at the first pause.
- **Why deferred:** Needs the app served over https on the phone, same wall as
  the web-push verification above.
- **Unblocked by:** Opening a session on the iPhone and dictating a sentence.
  If utterances cut off too early, the fix is `continuous`/`interimResults`
  with a stop button rather than one-shot capture.
- **Where:** `frontend/src/components/Terminal.tsx` (`toggleDictation`,
  `speechCtor`)

## Verify claude status hooks and the notification channels end to end

- **What:** Claude sessions launch with `--settings <hooks file>` whose hooks
  write the per-session state file; the backend derives the "waiting" badge and
  notifies on transitions. Wiring is verified (state file → waiting badge →
  project counts, `--settings` accepted by the CLI), and real sessions in the pod
  do write `.state` files that flip waiting/running — so the hooks fire. Web
  push is confirmed end to end (Apple accepted and an iPhone showed it, once the
  VAPID subject stopped being a `localhost` mailto); ntfy is still untested.
  Still unconfirmed: that a _question_ to the user counts as waiting. A session blocked on `AskUserQuestion` read `running`,
  because every tool call's `PreToolUse` hook writes `running` and it is unclear
  whether such a prompt also fires `Notification`. If it doesn't, a question
  never pushes and the hook set needs another event (or a fallback).
- **Why deferred:** Needs an authenticated claude session (past the trust
  prompt), a real ntfy topic, and — for web push — an iPhone with the app
  installed to the Home Screen. Web push additionally requires the app to be
  served over https: on a plain-http origin the browser registers no service
  worker at all, so the settings page will report "unavailable" no matter what
  the backend does.
- **Unblocked by:** Set NTFY_URL to a test topic for that channel; for the rest,
  confirm on the phone that a real waiting/finished transition arrives (not just
  "send test") and that its tap opens the session.
  The subscribe/unsubscribe/key surface has automated coverage
  (`backend/test/push.test.ts`); actual delivery through Apple's push service
  does not.
- **Where:** `backend/src/claude-hooks.ts`, `backend/src/notifier.ts`,
  `backend/src/push-store.ts`, `backend/src/sessions-store.ts`,
  `frontend/src/sw.ts`, `frontend/src/screens/Settings.tsx` (`Notifications`)

## Status hooks for antigravity and codex sessions

- **What:** The waiting/running state file is only written by Claude Code
  hooks; antigravity and codex sessions never show "waiting". Agreed to ship
  claude-only first since their hook equivalents are unverified.
- **Why deferred:** agy/codex hook mechanisms need verifying in the pod before
  wiring anything.
- **Unblocked by:** Confirming each CLI's hook/notification mechanism, then
  writing the same state file (`VK_STATE_FILE` is already the contract).
- **Where:** `backend/src/sessions-store.ts` (`createSession`),
  `backend/src/claude-hooks.ts` (pattern to copy)

## Upgrade react-router past the RSC-mode CSRF advisory

- **What:** react-router is pinned at `^7.0.0` and resolves to 7.18.1, which is
  inside the range of GHSA-qwww-vcr4-c8h2 ("RSC Mode CSRF Bypass Allows Action
  Execution Before 400 Response"). The other five advisories found alongside it
  were patched in place; this one is left open deliberately.
- **Why deferred:** The advisory is specific to RSC mode. This app is a
  client-side SPA that uses only `Routes`, `Route`, `BrowserRouter`, `Link`,
  `useNavigate`, `useParams` and `useLocation` — no RSC, no server actions, no
  data-router loaders — so the vulnerable code path is never reached. The fixed
  version is >8.2.0, so clearing the advisory means a react-router 8 major bump
  across the whole routing layer, which is a deliberate upgrade rather than a
  security patch.
- **Unblocked by:** Reading the react-router 8 migration notes and doing the
  bump on its own branch. Until then `npm audit` will keep reporting one high
  finding, so any dependency scanning added in CI needs to either allow this
  advisory explicitly or be read with it in mind.
- **Where:** `frontend/package.json` (`react-router`), and the import sites
  listed above (`frontend/src/App.tsx`, `main.tsx`, `components/TopBar.tsx`,
  `screens/Hub.tsx`, `Project.tsx`, `Session.tsx`, `Settings.tsx`, `Inbox.tsx`)

## Pick a window-size policy for two clients on one session

- **What:** Two clients on one session share one geometry. The default
  `window-size latest` means the most recently attached client wins, so opening
  a session on the phone snaps the desktop terminal to phone width until the
  phone detaches, and agent TUIs redraw their boxes at the smaller size.
- **Why deferred:** The grouped-session fix this entry used to propose does not
  work, and that is now checked rather than assumed. `tmux new-session -t <id>
-s <id>-view-1` puts the new session in the same group, and
  `list-windows -a` shows both sessions on the _same window_ (`@0`) at one
  size — a session group shares window objects, so a per-client session buys no
  per-client geometry. Nothing in tmux can: one pane is one screen buffer, and
  every client viewing it sees the same render. `aggressive-resize` does not
  help either, for the reason already recorded — it only separates clients whose
  _current_ windows differ.
- **Unblocked by:** A product call, since the only lever is which client loses.
  `window-size largest` keeps the desktop intact and gives the phone a cropped
  viewport onto a wider window; `smallest` is today's complaint made permanent;
  `latest` is the current behaviour, where whichever device you just picked up
  renders correctly and the other is wrong until it detaches. Given the phone is
  the device this app is mostly used from, `latest` may already be the least-bad
  default — which would make this entry a decision to close rather than code to
  write.
- **Where:** `backend/src/tmux.ts` (`newSession` would set the option),
  `backend/src/ws/attach.ts` (the `attach-session` argv)

## Per-file selection and a dry run for repo-wide replace

- **What:** `POST /api/projects/:name/replace` still rewrites every match in one
  shot. The confirm now states how many matches in how many files and names the
  first five, and the hit list is re-run afterwards so the result can be
  checked — but there is no per-file selection, no server-side dry run, and no
  undo.
- **Why deferred:** A real dry run means a second response shape (per-file
  before/after counts, ideally the replaced lines) and a review UI on top of it,
  which is a feature rather than a safety fix. The immediate risk — an
  unbounded rewrite behind a single unstyled `confirm()` — is addressed, and the
  regex no longer runs on the event loop.
- **Unblocked by:** Deciding whether the review step shows counts per file or
  actual diff lines; the latter needs the endpoint to return content, which has
  size implications on a phone.
- **Where:** `backend/src/routes/files.ts` (the replace route),
  `backend/src/replace.ts`, `frontend/src/components/SearchPanel.tsx`

## Run CI through the containers, not on the runner

- **What:** CI still does `npm ci` on the GitHub runner, so node-pty is compiled
  natively there, while CLAUDE.md says tooling runs in containers. The image is
  now built and smoke-tested before it is pushed, which was the bigger gap.
- **Why deferred:** Moving the test job onto compose means the runner builds the
  dev image on every run; worth measuring against the current job time before
  committing to it.
- **Unblocked by:** Timing `docker compose run --rm backend npm test` on a cold
  runner against the present `npm ci` path.
- **Where:** `.github/workflows/ci.yml` (the `test` job)

## Assistant M1: open the assistant's conversation in a terminal

- **What:** Headless claude records its conversation under `$HOME` exactly as
  the TUI does, so a tmux session running `claude --resume <id>` picks up the
  thread you were chatting to. This is what keeps the chat from being a dead end
  when you want to drive.
- **Why deferred:** The mechanism is verified — a chatted turn lands at
  `/data/home/.claude/projects/-data-repos/<id>.jsonl`, which is exactly where
  the interactive CLI looks for a conversation started in `REPOS_DIR`. What is
  missing is somewhere to put the session: every session id is
  `vk-<project>-<seq>` and the assistant belongs to no project, so this needs
  the session model to admit a projectless session rather than just a new
  endpoint.
- **Unblocked by:** Deciding how a projectless session is named and listed, then
  a route that starts tmux on `claude --resume <conversationId>` in `REPOS_DIR`.
- **Where:** `backend/src/sessions-store.ts` (`SESSION_ID_RE`, `createSession`,
  `launchAgent` already builds `claude --resume <id>` for restores),
  `frontend/src/screens/Assistant.tsx` (where the button goes)

## Nothing prunes the assistant's own directory

- **What:** `maintenance.ts` reaps idle session browsers and docker debris.
  Nothing touches `ASSISTANT_DIR`: every conversation ever held, every
  unattended run's thread, and every image pasted or uploaded into the chat
  stays on the volume for good. Today that is 8 threads and 716 KB, which is
  nothing — but a nightly briefing and a nightly harvest add roughly 700 threads
  a year on their own, and `search` reads every file at the top level on every
  recall.
- **Why deferred:** Deleting somebody's conversation history is a decision, not
  a cleanup: the whole point of recall is that an old thread is still worth
  something. Uploads are the easy half and were not worth a pass on their own.
- **Unblocked by:** Deciding a retention rule worth having — likeliest is
  "unattended threads older than 30 days go, chats stay, uploads older than 30
  days go", since the subdirectory split now makes the two separable. Then a
  daily sweep beside the docker prune.
- **Where:** `backend/src/maintenance.ts`, `backend/src/assistant.ts`
  (`threadPath`, `uploadsDir`)

## The house rules are instructions, not enforcement

- **What:** "Leave no sign an agent wrote this" and "ask before anything
  irreversible" reach every agent through the global memory file, which is the
  strongest instruction channel available and still only an instruction. A model
  that ignores it leaves a `Co-Authored-By` trailer in history, and history is
  the thing you cannot quietly fix later. Nothing checks after the fact.
- **Why deferred:** The mechanical version is a `commit-msg` hook installed into
  every repo verksted touches, which strips agent trailers and footers. That
  writes into the user's own repos and their `.git` directories, which is a
  bigger decision than it looks — a hook is invisible, survives verksted, and
  surprises anyone else who clones the repo.
- **Unblocked by:** Deciding whether verksted may write into `.git/hooks` (or
  set `core.hooksPath` to a directory it owns), then a hook that drops any
  trailer matching Claude/agent/AI and any "Generated with" footer. A cheaper
  first step: have the assistant's `list_prs`/`pr_detail` flag a PR body that
  carries one, so at least it is noticed.
- **Where:** `backend/src/sandbox-doc.ts` (`HOUSE_RULES`),
  `backend/src/sessions-store.ts` (where a hook would be installed)

## The harvest has only read scheduled-run transcripts, and nothing guards the shape

- **What:** Two halves, one now answered. `transcripts.ts` has been run against
  real transcripts in the pod (2026-08-08): seven finished sessions, seven typed
  turns, no model output and no tool results — the `origin.kind === "human"`
  filter holds on real data. But all seven were _scheduled_ sessions, where the
  single human turn is the prompt verksted submitted, so the harvest has still
  never read a conversation a person actually typed into, which is where the
  durable facts are and where the judgement is hard. And nothing in CI reads a
  real transcript, so a future CLI release renaming `origin` would silently
  harvest nothing (safe) or, if the shape moved the other way, start including
  tool results (not safe).
- **Why deferred:** The first half needs interactive sessions to end and a night
  to pass. The second is the same class as the gh fixture entry above.
- **Unblocked by:** Reading the inbox after a day with real interactive work in
  it, and judging whether what it proposed was worth keeping. For the shape
  guard: a check that reads one real transcript from `$HOME/.claude/projects/`
  in the pod and asserts a human turn comes out and no tool result does. Worth
  pinning the claude version in the image and re-checking on each bump.
- **Where:** `backend/src/transcripts.ts` (`promptsIn`),
  `backend/test/transcripts.test.ts`

## A harvest proposing the same rejected fact every night

- **What:** Dropping a proposal leaves no trace, which is what makes the queue
  feel clean. The cost is that nothing remembers the rejection: if the same
  session's prompts are read again — a harvest run twice by hand, or a
  look-back window widened past a day — the same fact is proposed again and has
  to be dropped again. The nightly window makes this unlikely rather than
  impossible.
- **Why deferred:** The fix is a tombstone file per rejected slug, which is
  state that exists only to remember a "no" and has to be pruned itself. Not
  worth it before it is annoying in practice.
- **Unblocked by:** Dropping the same proposal twice and being irritated by it.
- **Where:** `backend/src/memory-store.ts` (`dropProposal`)

## Assistant M4: memory has a budget but no compaction

- **What:** The store is capped at 8 KB of injected text and drops the oldest
  facts past it, reporting how many in the API and on the settings page. What is
  missing is the weekly pass that merges duplicates and drops facts contradicted
  by newer ones, so the cap is currently a cliff rather than a prompt to tidy.
- **Why deferred:** Premature until enough memories exist to need it; the
  reporting was built first so the cliff is at least visible.
- **Unblocked by:** Reaching the budget in real use, then a schedule that reads
  the store and rewrites it.
- **Where:** `backend/src/memory-store.ts` (`BUDGET_BYTES`, `renderBlock`)

## The assistant's MCP server is hand-rolled JSON-RPC

- **What:** `runtime/verksted-mcp.mjs` implements the three MCP methods it needs
  (initialize, tools/list, tools/call) directly, rather than using
  `@modelcontextprotocol/sdk`. It works against the real CLI, but it is a
  protocol implementation this repo now maintains, and it handles no MCP feature
  beyond tools — no resources, prompts, or notifications.
- **Why deferred:** The SDK would have to resolve from `node_modules` at a path
  that differs between the tsx dev process and the built image, where the server
  is a standalone file baked in next to `vk`. Hand-rolling three methods was the
  smaller problem, but it is a deliberate exception to this repo's
  prefer-a-library rule and should not quietly become the norm.
- **Unblocked by:** Wanting anything beyond tools, or the protocol changing
  under it — either is the point to reach for the SDK and solve the path problem
  properly (a thin wrapper inside the build output, spawned with the same
  runtime the backend is using).
- **Where:** `runtime/verksted-mcp.mjs`, `backend/src/assistant.ts` (`MCP_CONFIG`)

## An unattended turn has never fired from a cron tick, or pushed a phone

- **What:** The turn itself is now proven on the real pod. Both assistant
  schedules were run on 2026-08-08 against a real authenticated CLI: the
  briefing answered in 13.6s off `status` alone, the harvest in 7.3s, both
  signed off `ok:` and both landed in the inbox beside the session runs. What
  that did _not_ exercise is the two paths a person cannot trigger by hand —
  a **cron tick** firing them unattended (both were "run now"), and **notify**
  actually reaching the phone, since an `ok` briefing is meant to stay silent
  and correctly did. Suppression of a repeated push is likewise untested against
  a real device, and is in-memory, so a pod restarting between two firings will
  push a duplicate.
- **Why deferred:** Needs a morning to pass, and needs something genuinely
  worth interrupting for so that `notify` is reached on its own judgement.
- **Unblocked by:** Reading the inbox after 07:00 and 03:00 and confirming two
  runs appeared without anyone pressing anything. For the push half, the
  quickest honest test is a schedule whose prompt says to notify unconditionally,
  run twice inside six hours — the second should report itself suppressed.
- **Where:** `backend/src/scheduler.ts` (`briefing`, the cron callback),
  `backend/src/routes/push.ts` (`REPEAT_WINDOW_MS`)

## Old assistant threads can only be searched, never browsed

- **What:** `recall` gives the agent its way back into an old conversation, and
  there is no way for a person to have the same. Every thread is kept as JSONL
  under `ASSISTANT_DIR` and the chat screen shows only the current one, so a
  thread you abandoned is reachable by asking the assistant about it or by
  `claude --resume <id>` in a terminal, and no other way.
- **Why deferred:** The ask was recall for the agent, and that is what shipped.
  A thread list is a screen, and screens are worth building once the store is
  big enough that one is missed.
- **Unblocked by:** Wanting to reread a thread yourself. The endpoint is nearly
  there: `GET /api/assistant/search` already enumerates the files.
- **Where:** `backend/src/assistant.ts` (`search`, `readEntries`),
  `frontend/src/screens/Assistant.tsx`

## The session chat view drops images and pasted attachments

- **What:** The chat view renders a session's typed turns, its replies, and its
  tool calls. What it does not render is anything attached to a turn: an image
  pasted into the pane, or a file dropped on it, arrives in the transcript as an
  `attachment` entry and as content blocks the parser ignores, so the turn shows
  as text alone — or, if it was only an image, does not show at all.
- **Why deferred:** The ask was reading a session back, and the material that
  makes a session hard to read on a phone is prose and tool calls. Attachments
  are rare in a coding session, and serving them needs a route that reads bytes
  out of the transcript's own storage, which is a second security surface —
  every path there has to go through `resolveInsideRepos` or an equivalent.
- **Unblocked by:** Wanting to see a screenshot you pasted without opening the
  terminal. `parseTranscript` already walks every content block, so the work is
  a `type: "image"` branch plus an endpoint to serve the bytes.
- **Where:** `backend/src/chat.ts` (`parseTranscript`),
  `frontend/src/components/ChatPane.tsx` (`Turn`)

## eslint-plugin-jsx-a11y is unmaintained and pinned to ESLint 10 by an override

- **What:** The toolchain runs ESLint 10, but `eslint-plugin-jsx-a11y` declares
  a peer range that stops at ESLint 9 and has not published since October 2024.
  An `overrides` entry in the root `package.json` forces the peer to resolve so
  the install succeeds. The plugin was probed under ESLint 10 and its rules do
  fire correctly (errors and warnings both), so this is a stale declaration
  rather than a real incompatibility — but it is still an unblessed override on
  an abandoned package.
- **Why deferred:** The alternatives are worse today: staying on ESLint 9 holds
  the whole lint toolchain back, and swapping the plugin out is a rules-and-
  config change nobody asked for as part of a dependency bump.
- **Unblocked by:** jsx-a11y publishing a release with an ESLint 10 peer range —
  then delete the `overrides` block. If it stays abandoned through the ESLint 11
  cycle, replace it instead; the config only leans on `flatConfigs.recommended`
  plus six rule overrides, so the surface to port is small.
- **Where:** `package.json` (`overrides`), `eslint.config.js` (the
  `jsx-a11y` block)

## React Compiler lint rules from react-hooks 7 warn instead of erroring

- **What:** `eslint-plugin-react-hooks` 7 folds in the React Compiler rules, and
  two of them fire on the existing frontend: `react-hooks/refs` (5 sites) and
  `react-hooks/set-state-in-effect` (5 sites). Both are set to `warn` so CI is
  not blocked, matching how the jsx-a11y findings above them are already
  handled.
- **Why deferred:** Every site is a deliberate, commented idiom — the latest-ref
  pattern (a ref assigned during render so an effect reads a fresh callback
  without re-subscribing) and effects that seed state on mount. Fixing them is a
  behavioural refactor of hooks that currently work, which is well outside a
  dependency upgrade.
- **Unblocked by:** Wanting the React Compiler to be able to optimise these
  components, which is when the rules stop being advisory. Take the `refs` sites
  first: those have a mechanical fix (assign in an effect) where the
  `set-state-in-effect` ones need the effect restructured.
- **Where:** `frontend/src/useDismissOnBack.ts`, `frontend/src/useSpeech.ts`,
  `frontend/src/components/Terminal.tsx`, `frontend/src/components/ChatPane.tsx`,
  `frontend/src/components/AssistantPanel.tsx`,
  `frontend/src/components/CommandPalette.tsx`, `frontend/src/api.ts`

## Node major bumps are a manual LTS decision

- **What:** `.github/dependabot.yml` ignores major updates to the `node` image,
  so nothing will propose Node 26 even after it becomes LTS. The image runs
  `node:24-trixie-slim`; 24 is Active LTS until 2026-10-20 and supported to
  2028-04-30.
- **Why deferred:** Dependabot has no notion of which Node releases are LTS. It
  proposed `node:25-slim` three months after 25 went end of life (#26) and
  `node:26-trixie-slim` while 26 was still Current (#46). Ignoring the major is
  what stops a green CI run from walking the pod onto an unsupported runtime.
  The floating `24-trixie-slim` tag still picks up every 24.x security release
  on each build, so this costs nothing between majors.
- **Unblocked by:** 2026-10-28, when Node 26 enters LTS. Move the Dockerfile's
  three `FROM` lines to `node:26-trixie-slim`, check `@types/node` moves to 26
  to match, and confirm node-pty has prebuilds or still compiles for the new
  ABI. Do the same again when 28 enters LTS in October 2028, before 24 goes end
  of life in April 2028.
- **Where:** `.github/dependabot.yml` (the docker `ignore` block), `Dockerfile`
  (the `whisper`, `base` and `build` stages), `backend/package.json`
  (`@types/node`), `.github/workflows/ci.yml` (`node-version`)

## TypeScript is installed twice, on purpose

- **What:** `npm ls typescript` reports two copies: 7.0.2 under
  `backend/node_modules` and `frontend/node_modules`, which is what `tsc` runs
  for the build and the `lint` scripts, and 6.0.3 at the root, which is what
  typescript-eslint's type-aware rules run on. It looks like a resolution bug
  and is not one.
- **Why deferred:** typescript-eslint does not support the native compiler yet,
  and says so at runtime rather than in types alone — forcing a single
  TypeScript 7 with an `overrides` entry makes every lint run die with
  "typescript-eslint does not support TS 7.0". Running TS 6 alongside is
  Microsoft's documented path for exactly this, not a workaround.
- **Unblocked by:** typescript-eslint shipping TS >=7.1 support, tracked
  upstream in typescript-eslint#10940. When it lands, drop the duplicate by
  letting the root resolve to 7.x and confirm `npm ls typescript` reports one
  copy.
- **Where:** `backend/package.json` and `frontend/package.json` (the
  `typescript` devDependency), `package.json` (`overrides`, where a
  `typescript` entry would go and currently must not), `eslint.config.js`
  (`recommendedTypeChecked`, the rules that need the TS 6 API)
