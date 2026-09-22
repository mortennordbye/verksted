# Backlog

Known gaps agreed to leave for later. Format per entry: what / why deferred /
what unblocks it / where the code lives.

## Messages waiting for the chair are lost when the pod restarts

- **What:** A message sent while a turn runs now waits on the server rather
  than in the browser tab. It waits in memory, so a pod restart mid-turn
  drops it.
- **Why deferred:** A restart mid-turn already ends the turn itself. The tab
  queue lost messages on every reload, which is the case that was hurting.
- **Unblocked by:** Losing one this way. Then write the queue beside the thread
  file and read it back at start.
- **Where:** `backend/src/assistant.ts` (`chat.queued`, `ask`, `drain`).

## A member seeded before a tool existed never gains it

- **What:** Uriel on the pod holds `status, recall, list_memories, remember,
forget, propose_memory` and none of the mail, calendar or document tools it
  was written for. It was seeded when the council first shipped, and seeding
  leaves an existing member exactly as it found it, so every tool added to
  `SEEDS` since has reached a new bench and no old one. The mail tools this
  branch adds land the same way: on the pod, the advisor that reads the mail
  still cannot, until its tool list is set by hand on the settings page.
- **Why deferred:** The rule that seeding never overwrites is the right one. A
  member is a file a person edits from a phone, and a release that quietly put
  tools back on one somebody had deliberately narrowed would be worse than this
  is. Telling the two cases apart means recording what a member was seeded with,
  which is a store change for a problem that has bitten once.
- **Unblocked by:** Wanting a second advisor to gain a capability without
  someone opening settings. Then keep the seeded tool list beside the member and
  add only tools that are new to `SEEDS` since, leaving anything removed by hand
  removed.
- **Where:** `backend/src/council-store.ts` (`SEEDS`, `seedCouncil`, the
  `.seeded` file), and the tools list on the settings page.

## A blocked owner's maintainer queue is not blocked

- **What:** The owner list on the settings page keeps GitHub notifications from
  an employer's or a customer's org out of the feed. The other half of the
  github source is the maintainer's queue, and its items are filed under the
  local checkout's directory name (`demo #3: tidy the readme`) with no owner in
  them, so the same check cannot be made. A customer repo cloned onto the pod
  and given a maintainer schedule would still have its issue titles filed and
  triaged.
- **Why deferred:** It takes deliberately setting a nightly maintainer on a work
  repo to reach, which is not a thing that happens by accident the way an inbox
  notification does, and the fix means teaching `projects-store` what a
  checkout's GitHub owner is — a git remote read on a path that currently
  touches no network.
- **Unblocked by:** Wanting a work repo on the bench at all. Then resolve each
  project's owner from its `origin` remote once, cache it, and run the same
  `blockedOwner` check in `pollQueue` (and, at that point, refuse the clone).
- **Where:** `backend/src/pollers.ts` (`queueItems`, `pollQueue`,
  `blockedOwner`), `backend/src/projects-store.ts`

## The phone screen may still end short with the keyboard up

- **What:** The session shell is `dvh` with the keyboard down and `--vvh` with it
  up. The `dvh` half is what closed the black band under the pane box. The
  `--vvh` half is unchanged, so if the band's cause turns out to be
  `visualViewport.height` under-reporting by the top safe-area inset — rather
  than a browser toolbar, which `dvh` accounts for by itself — then the same
  band comes back above the on-screen keyboard, where it costs the line you are
  typing into.
- **Why deferred:** Which of the two it is cannot be read off a desktop:
  headless Chromium reports `visualViewport.height === innerHeight`, so
  `100dvh` and `--vvh` are the same number there and the difference is invisible
  to the suite. Guessing the correction would be fixing a number nobody has
  measured.
- **Unblocked by:** One readout on the phone, on a session screen, comparing a
  `100dvh` probe against `visualViewport.height`, `innerHeight` and
  `navigator.standalone`. If `dvh` is the larger, the keyboard-up path needs the
  same inset added back; if they match, there is nothing here.
- **Where:** `frontend/src/screens/Session.tsx` (`useVisualViewport`, the root
  shell's `kbd:h-[var(--vvh,100dvh)]`, and the full-screen pane branch)

## Ariel's headroom server runs out of a working tree

- **What:** The server is `tsx mcp/server.ts` under `/data/repos/headroom`, so
  what that advisor can do is decided by whatever is checked out there. A branch
  without `mcp/`, a half-finished edit or a reinstall changes it, and the failure
  mode is silent: the tools simply do not list, and the advisor answers as though
  headroom was never configured — which is indistinguishable from the vars being
  unset.
- **Why deferred:** The alternative is pinning a copy into this image or running
  headroom's HTTP transport beside it, and both cost more than the failure does
  while one person uses one checkout.
- **Unblocked by:** Wanting to work on a headroom branch and keep Ariel honest at
  the same time; then either pin the server or surface "headroom configured but
  not answering" as something visible rather than absent.
- **Where:** `backend/src/assistant.ts` (`HEADROOM_SERVER`, `mcpConfig`)

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
- **Why deferred:** Needs a real key to test with. The pod is deployed; the key
  is the missing half.
- **Unblocked by:** Setting the key on the settings page, starting an
  antigravity session, and confirming it authenticates. Fallback: run `agy` once
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
  block is also how an agent learns `vk feedback` exists, so agy is the one
  agent that will never file a note about the bench either. The
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
- **Why deferred:** It waited on the pod being deployed, since auth is a
  cluster fact. The pod has been deployed for months; nobody has come back to
  it.
- **Unblocked by:** Nothing now. Read each CLI's own auth status (and the MCP
  config) the way the facts route reads the rest, and draw it in the footer.
- **Where:** `backend/src/routes/facts.ts` (extend)

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

## A big review still cannot be paged past its caps

- **What:** Reviewing a run is now a screen: the whole range as one patch
  (`GET /api/sessions/:id/changes/patch`), per-file read marks and a verdict
  kept on the session (`PATCH /api/sessions/:id/review`), both surfaced on the
  changes tab and the inbox row. What is still fixed is the size: the file and
  commit lists cut at 500 and 100, and the patch itself at 1 MB, cut at a file
  boundary. All three say so and none can be paged past — a range bigger than
  that is only fully readable in the terminal.
- **Why deferred:** Paging a diff is its own design (by file? by hunk? what does
  "read" mean for a page?), and no real range has come close to the caps yet.
  Guessing at the interaction before one does is how the wrong one gets built.
- **Unblocked by:** A real overnight run that hits a cap. The numbers to move
  are named constants, so raising them is the cheap first answer if that run
  turns out to be an outlier rather than the new normal.
- **Where:** `backend/src/git.ts` (`MAX_COMMITS`, `MAX_FILES`,
  `MAX_PATCH_BYTES`), `frontend/src/components/ReviewOverlay.tsx`

## The pod's voice is English-first, and never speaks Norwegian

- **What:** Kokoro ships 54 voices, and the settings page lists all of them, but
  the assistant answers in English and the model has no Norwegian at all — the
  nearest neighbours are Spanish, French, Italian, Portuguese, Hindi, Japanese
  and Chinese. Picking one of those reads English text in that language's
  phonetics, which is a novelty rather than a feature.
- **Why deferred:** The assistant writes in English, so an English voice is the
  matching one. Norwegian would mean a second model (Piper has nb voices) and a
  language decision per reply, which is a bigger change than a voice picker.
- **Unblocked by:** Wanting to be spoken to in Norwegian. The engine is already
  behind one function (`synthesize`), so a second model is a branch there rather
  than a new subsystem.
- **Where:** `backend/src/tts.ts`, `runtime/vk-say.py`, `frontend/src/useSpeech.ts`
  (`sortVoices`, which is what puts English first today)

## Synthesis is not cached, so a reply read twice is made twice

- **What:** Every request synthesises from scratch. The response carries a
  five-minute private cache-control, so a browser re-reading the same reply may
  reuse it, but nothing on the pod remembers anything — and the sample the
  settings page plays is remade on every tap.
- **Why deferred:** A reply is usually read once, and the cache that would help
  is keyed on text plus voice, which is a store with an eviction policy for a
  saving of about a second.
- **Unblocked by:** Noticing the same sentences being made repeatedly — the
  briefing is the likely one, since it says similar things every morning.
- **Where:** `backend/src/tts.ts` (`synthesize`)

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
  practice. The half-fix is in: both ends of the range are now recorded
  (`Meta.startCommit`, `Meta.endCommit`) and the changes tab shows what is in
  it, so a row that looks wrong can be checked commit by commit. What is still
  missing is attribution itself.
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

## An ordinary scheduled run still has no sign-off of its own

- **What:** Adherence to `REPORT_CONTRACT` was the open question here, and a
  week of real runs answered it: poor. Six headroom stage runs went silent in a
  week — scout twice, build once, gate on three consecutive nights — while the
  same gate schedule wrote a clean verdict on the nights either side. Stage runs
  now handle it: the pane asks for the line (`runtime/vk-signoff`) and, failing
  that, records that it asked. An ordinary scheduled session gets neither, so a
  schedule with a prompt of its own still depends on the model remembering.
- **Why deferred:** The fallback this entry used to propose — move
  `DEFAULT_REPORT` onto ordinary schedules, "a one-line change" — is wrong for
  them. An ordinary scheduled session is a TUI that does not exit, and its Stop
  hook writes `waiting`, which is what turns the session amber for a person to
  pick up. A Stop hook that also wrote a default report would file every
  stop-to-ask as a failure, and `endSignedOffRuns` ends any scheduled session
  that has a report — so it would kill the session at the moment the agent
  stopped to ask a question, which is the case the amber chip exists for.
  vk-signoff does not transfer either: it runs after the agent process exits,
  and a TUI's does not.
- **Unblocked by:** A signal that separates "finished and forgot" from "stopped
  to ask" from inside a live TUI. The session's own conversation has it — a turn
  that ended without a question is not the same shape as one that asked — and
  `transcripts.ts` already reads entries by conversation id. Until then the slot
  is no longer held (`roomForSession` takes it back after a day), so the cost is
  a missing verdict rather than a missing night.
- **Where:** `backend/src/sessions-store.ts` (`REPORT_CONTRACT`, `launchAgent`),
  `backend/src/claude-hooks.ts` (`DEFAULT_REPORT`), `runtime/vk-signoff`,
  `backend/src/scheduler.ts` (`endSignedOffRuns`, `roomForSession`)

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

## The antigravity CLI is the one thing in the image with no version to pin

- **What:** claude, codex and the playwright MCP server are pinned in
  `runtime/cli/package.json` and bumped by dependabot. `agy` is not: its
  installer takes no version argument, serves whatever is current, and the
  binary it drops self-updates in the background while a session runs. So
  neither "which version is in the image" nor "which version is running" is a
  question this repo can answer, and a bad release reaches the pod the moment
  it is published.
- **Why deferred:** There is nothing upstream to pin to — no versioned
  installer path, no release artifact with a checksum, and no documented flag
  to hold a version. Working around it means hosting a copy of the binary,
  which is a worse problem than the one it solves.
- **Unblocked by:** Antigravity publishing versioned downloads, or a flag that
  turns the self-updater off — then the same treatment as uv (a versioned
  installer URL and a version assertion after it).
- **Where:** `Dockerfile` (the `agy` block at the end of the `base` stage)

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

## The runtime is type-checked, but its responses are still untyped

- **What:** `npm run lint:runtime` now type-checks `runtime/**/*.mjs` as
  JavaScript, which closed the A-30 finding's first half. What it checks is
  what the file itself says: `call()` returns `any`, so every field read off a
  backend response is still unchecked, and the 16 casts in
  `routes/assistant.ts` and `routes/memory.ts` — the other half of A-30 — are
  untouched. `noImplicitAny` is off in `tsconfig.runtime.json` for the same
  reason.
- **Why deferred:** Typing the responses means JSDoc `import("../shared/api.js")`
  on `call()` and a type per route it touches, which is a pass over all 1,645
  lines and a decision about how much of `shared/api.ts` the MCP server should
  depend on. The check being there at all is what stops the next blind
  destructure; the rest is cleanup with a known shape.
- **Unblocked by:** Deciding whether the MCP server takes the official SDK (the
  entry above), which brings its own types and would make this moot, or stays
  hand-rolled and gets JSDoc types of its own.
- **Where:** `runtime/verksted-mcp.mjs` (`call`, `reason`), `tsconfig.runtime.json`,
  `backend/src/routes/assistant.ts`, `backend/src/routes/memory.ts`, `shared/api.ts`

## The image is scanned but carries no SBOM or provenance

- **What:** CI now fails a push when trivy finds a fixable CRITICAL in the
  image, and files everything HIGH and above under code scanning. What it does
  not produce is a bill of materials or a signed statement of how the image was
  built, so "which image had that package" can only be answered by re-scanning
  whatever is still in the registry.
- **Why deferred:** Scanning answers the question that was actually being asked
  (is there a known hole in what is running). An SBOM is for answering it
  backwards, after an advisory lands, and it is only worth its keep with
  retention to go with it — which GHCR has none of here (O-17).
- **Unblocked by:** An advisory that has to be traced to a specific deployed
  tag, or deciding the GHCR retention question. `docker/build-push-action`
  takes `sbom: true` and `provenance: mode=max`, so the change itself is two
  lines.
- **Where:** `.github/workflows/ci.yml` (the `image` job)

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

## "Ask before anything irreversible" is an instruction, not enforcement

- **What:** Of the two house rules, "leave no sign an agent wrote this" is now
  enforced: the image installs a commit-msg hook as the system-wide
  `core.hooksPath` that strips agent trailers and footers, and CI rejects what
  gets past. "Ask before anything irreversible" still reaches an
  interactive agent only as an instruction in its global memory file. Unattended
  runs are the exception: `vk-guard` denies rather than asks.
- **Why deferred:** An interactive agent is being watched, and the CLIs' own
  permission prompts are the check on it. Enforcing more would mean a guard on
  interactive sessions too, which asks rather than denies, and which the CLIs'
  own settings already partly do.
- **Unblocked by:** An irreversible action an interactive agent took without
  asking. Then the same PreToolUse hook as unattended runs, in ask mode.
- **Where:** `backend/src/sandbox-doc.ts` (`HOUSE_RULES`), `runtime/vk-guard`,
  `runtime/git-hooks/`

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

## An unattended turn's notify has never reached a phone

- **What:** The cron half is answered. On 2026-09-14 the pod's schedules had all
  stamped `lastFiredAt` on their cron minute to the millisecond, and the run
  list holds a briefing, a harvest and the session runs every night with nobody
  pressing anything. What is still unexercised is **notify** actually reaching
  the phone from an unattended turn, since an `ok` briefing is meant to stay
  silent and does. Suppression of a repeated push is likewise untested against
  a real device, and is in-memory, so a pod restarting between two firings will
  push a duplicate.
- **Why deferred:** Needs something genuinely worth interrupting for so that
  `notify` is reached on its own judgement.
- **Unblocked by:** A schedule whose prompt says to notify unconditionally, run
  twice inside six hours — the first should arrive on the phone, the second
  should report itself suppressed.
- **Where:** `backend/src/routes/push.ts` (`REPEAT_WINDOW_MS`),
  `backend/src/scheduler.ts` (`briefing`)

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

- **What:** `eslint-plugin-react-hooks` 7 folds in the React Compiler rules.
  `react-hooks/refs` no longer fires: its five latest-ref sites now assign in a
  `useLayoutEffect`. `react-hooks/set-state-in-effect` still does, on 7 sites,
  and stays at `warn` so CI is not blocked, matching how the jsx-a11y findings
  above it are handled.
- **Why deferred:** Every remaining site is an effect that seeds or resets state
  when something outside React changes, and each is commented as such. Unlike
  the refs sites these have no mechanical fix: each effect has to be restructured
  (derive during render, or move the set into the event that causes it), which
  is a behavioural refactor of hooks that currently work.
- **Unblocked by:** Wanting the React Compiler to be able to optimise these
  components, which is when the rule stops being advisory. Then take them one
  at a time, each with the screen it drives open in a browser.
- **Where:** `frontend/src/api.ts`, `frontend/src/components/AssistantPanel.tsx`,
  `frontend/src/components/ChangesPanel.tsx`, `frontend/src/components/ChatPane.tsx`
  (two), `frontend/src/components/CommandPalette.tsx`,
  `frontend/src/components/Terminal.tsx`

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

## The palette's light half is not ported

- **What:** `theme.css` carries only the dark column of nordbye.it's palette.
  The site is a light-and-dark system; here `color-scheme` is still pinned to
  `dark` and every token holds a single value.
- **Why deferred:** Light mode is not a token swap. It is every screen at once,
  plus the xterm.js theme, plus the native controls the `color-scheme` line was
  added to fix, plus a mode toggle and where its choice is stored. The hub
  rework did not need it and shipping half of it would have left screens
  rendering one mode's text on the other's ground.
- **Unblocked by:** Deciding whether the terminal screen stays dark in light
  mode (it should), then converting the tokens to `light-dark()` pairs and
  walking every screen in both modes the way the blog's phase 7 audit did.
- **Where:** `frontend/src/theme.css` (`@theme`, the `color-scheme: dark` rule),
  `frontend/src/components/Terminal.tsx` (xterm palette). The source is
  nordbye.it's own light column: `--bg` `#f9fbf9`, `--surface` `#f0f5f1`,
  `--fg` `#1a201b`, `--accent` `#378144`, `--accent-ink` `#fff`

## The chair's convening has never been watched against a real model

- **What:** A meeting is triggered by the chair opening its reply with
  `convene: <id>[, <id>]`, which the backend parses and strips. Every test drives
  a fake `claude` that says exactly that, so what is proven is the plumbing —
  who gets spawned, what they are given, what lands in the transcript — and not
  the thing the feature actually rests on: whether a real model reliably emits
  that line when it should, and does not emit it when it should not.
- **Why deferred:** It needs a live authenticated CLI and a person reading the
  answers over a few days. The failure modes are both cheap and visible — a
  meeting that did not happen is an ordinary answer, and one that happened when
  it should not have is a mark in the thread saying who was asked — so this is
  something to watch rather than something to block on.
- **Unblocked by:** A week of real use. Watch for two shapes: convening on
  questions the chair could have answered from `status` (expensive, and the
  persona line about it is the weakest kind of mitigation), and prose before the
  convene line, which makes it not the first line and so convenes nobody. If
  the second shape shows up, the fix is to make `convene`/`discuss` a tool on
  the verksted MCP server rather than a line grammar: a tool call is what a
  model reliably does, the stream parser already lands tool calls on the entry
  (`assistant-stream.ts`, `toolDetail`), and `speak()` would hold the entry on
  the tool rather than on `isConveneLine`. Not done ahead of the evidence: it
  changes every meeting test and the unattended chair too, and trades one
  unwatched behaviour for another (whether the model writes prose after the
  tool result).
- **Where:** `backend/src/assistant-persona.ts` (`councilBlock`),
  `backend/src/assistant.ts` (`CONVENE_RE`, `runChair`)

## The chat view is polled, not pushed

- **What:** `ChatPane` runs its own 3s timer against `GET /api/sessions/:id/chat`
  with a `since` cursor, and a second 3s timer against `/prompt` while something
  is being asked. The `/api/events` SSE stream carries neither.
- **Why deferred:** The stream broadcasts two global topics whose payload every
  client wants identically — that is what makes one server-side watcher cheaper
  than N clients polling. A session's chat is per-session and per-client, since
  `since` differs for each, so it does not fit the topic model without giving
  the stream per-client state. And `frontend/src/events.ts` is explicit that the
  push is an optimisation and the poll is the contract, so this would be push
  _plus_ poll rather than instead of it. What it would buy is latency, not
  bytes: the poll is already a delta and an idle one is a few hundred bytes.
- **Unblocked by:** Wanting sub-second turn latency in the chat view. Then: a
  per-conversation topic fed by one `fs.watch` on the transcript, with the timer
  kept as the backstop — `fs.watch` on the NFS-backed `/data` volume is not
  reliable enough to be the only signal.
- **Where:** `backend/src/events.ts` (`SOURCES`), `frontend/src/events.ts`
  (`TOPICS`), `frontend/src/components/ChatPane.tsx`

## Nothing in CI reads a real transcript, and the chat view now leans on six shapes

- **What:** Every fixture in `backend/test/chat.test.ts` is hand-written. The
  chat view reads six load-bearing shapes out of the transcript now — human
  turns, tool calls and their results, `task_reminder` attachments, `pr-link`
  and `permission-mode` entries, `AskUserQuestion` and `ExitPlanMode` payloads,
  and the `subagents/` directory — where before it read two. A CLI release that
  renames or moves any of them shows up as a silently emptier view, with every
  test still green.
- **Why deferred:** Same reason as the entry above about `transcripts.ts`, which
  this widens rather than replaces: a check that reads a real transcript needs
  one to exist, which is true in the pod and not in CI.
- **Unblocked by:** A check that runs in the pod against one real file from
  `$HOME/.claude/projects/` and asserts that a turn, a chip, a rail, an image
  reference and a question all come out of it. The parser is pure, so this is a
  script and an assertion rather than a harness.
- **Where:** `backend/src/chat.ts` (`parseTranscript`, `findDetail`),
  `backend/test/chat.test.ts`

## A subagent's conversation is read at a fixed window with no way to page back

- **What:** Opening an Agent chip reads the last 64 kB of that subagent's
  transcript, and says so when that did not reach the start. There is no "load
  earlier" for it the way there is for the conversation itself.
- **Why deferred:** A subagent is opened to find out what one delegated job
  concluded, and the conclusion is the last thing it wrote — which the tail
  always contains. A second window control on a nested view is more UI than the
  question deserves until somebody actually wants to scroll one.
- **Unblocked by:** Wanting to read a long subagent run rather than its result.
  `readDetail` already takes a window for the parent; this would be the same
  parameter threaded one level down.
- **Where:** `backend/src/chat.ts` (`SUBAGENT_WINDOW`, `readSubagent`),
  `frontend/src/components/chat/ToolChip.tsx`

## Still outside the maintainer

- **What:** Three things the plan named and left out on purpose. cargo and go
  are not in the image, so ruter-cli's tests cannot run on the pod and it
  cannot join. The maintainer has no GitHub identity of its own: its reviews
  are the owner's, so GitHub does not count a gate approval and the ruleset
  cannot require one. And the contract's no-go paths are prose the prompts
  obey rather than paths the guard denies.
- **Why deferred:** Each is a decision rather than a gap: a toolchain in the
  image, a second account, and a parser for the contract in a shell script.
- **Unblocked by:** Wanting ruter-cli on the queue (add rustup to the
  Dockerfile's base stage); wanting a required review on the ruleset (a machine
  user with its own token in the pod's settings); the contract format settling
  (then `vk-guard` reads its no-go list and denies edits there mechanically).
- **Where:** `Dockerfile`, `backend/src/settings-store.ts` (`KNOWN_AGENT_KEYS`),
  `runtime/vk-guard`, `backend/src/maintainer.ts` (`readContract`)

## The facts a feed row can show stop at what a poller already had

- **What:** `FeedItem` now carries `from` and `facts`, and the mail and github
  pollers fill them from what they were already holding — a sender and address,
  a repository, a notification's kind and reason. `design/mock-inbox.html` promises
  more than that: a pull request's check status and diff size, a mail's first
  body line, a run's duration and token cost. None of those are filled, so a
  row drawn from the mock will have two facts where the mock shows four.
- **Why deferred:** Each of the missing ones costs a network call the poller
  does not currently make. Checks and diff size are a `gh` call per pull
  request, on a list that is routinely a dozen long; a body line is an IMAP
  FETCH per message rather than the envelope-only SEARCH the poller does now.
  Both turn a cheap five-minute poll into a chatty one, and the github half
  spends rate limit that the notification poll shares.
- **Unblocked by:** Deciding the poll may cost more, or fetching lazily — the
  facts for one item when a row is opened rather than for every item on every
  poll. The lazy shape is probably right and is a route plus a cache, not a
  poller change.
- **Where:** `backend/src/pollers.ts` (`mailItems`, `notificationItems`,
  `queueItems`), `backend/src/mail.ts` (`recent`, `read`, `BODY_BYTES`),
  `backend/src/gh.ts`, and `FeedItem.facts` in `shared/api.ts`. The mock is
  `design/mock-inbox.html`.

## Gmail rules have no settings-page view

- **What:** `mail_labels`, `mail_rules`, `mail_rule_create` and
  `mail_rule_delete` (`backend/src/gmail.ts`) are chat-only: seeing what
  filters exist or removing one means asking the assistant, there is no list
  on the settings page the way sources, schedules and blocked owners get one.
- **Why deferred:** The ask was the tools themselves — teaching verksted to
  set up Gmail filters at all — not a management screen for them, and a filter
  wrong enough to need fixing without asking is the rare case, not the common
  one.
- **Unblocked by:** Wanting to see or clear rules without a chat turn. Then a
  `GET /api/mail/rules` list (already there) plus a table and a delete button
  under the Mail tab, the same shape as the blocked-owners list. The delete
  route was removed when removing a filter became a card (A-08): a button
  needs it back, and with it a way for the backend to tell the person's tap
  from anything else on the pod asking, which is the per-boot secret S-05
  describes.
- **Where:** `frontend/src/screens/Settings.tsx`, `backend/src/gmail.ts`,
  `backend/src/routes/sources.ts` (`/api/mail/rules`).

## The event stream still sends the whole session history

- **What:** `/api/events` publishes `listSessions()` in full, and nothing prunes
  session metadata — 145 sessions on the pod today, 144 of them finished months
  of runs ago. It is no longer sent every three seconds (R-06 is fixed: an
  unchanged session now serialises identically, so the change test holds), but
  every real change to any one session still pushes the whole list to every open
  client.
- **Why deferred:** The churn was the bug worth chasing; the payload only costs
  something when something actually happened, which is a handful of times a
  minute at worst. Scoping the stream to live-plus-recent means deciding what
  the hub's "all sessions" list reads instead, which is a screen change, not a
  stream change.
- **Unblocked by:** Retention. Archiving metadata for sessions that ended more
  than ninety days ago into a monthly JSONL relieves this, the meta scan behind
  every `listSessions` (R-07) and the sidecar files that accumulate with them
  (R-08) in one change. R-01 no longer waits on it.
- **Where:** `backend/src/events.ts` (`SOURCES.sessions`),
  `backend/src/sessions-store.ts` (`readAll`, `listSessions`),
  `backend/src/maintenance.ts` (where a retention sweep belongs).

## A member's tools are narrowed on read with nothing to say so

- **What:** A member that reads the web has anything private taken off its tool
  list when the file is read (`readMember` in `backend/src/council-store.ts`),
  and nothing on the settings page says it happened. On the pod, Ariel and
  Sophia both have the web on, so both are down to `list_memories, remember,
forget` — their own notebooks — and `recall` is gone from each. The checkbox
  is still ticked in the file and the panel still draws the member as holding
  it. Somebody wondering why an advisor cannot recall anything has no way to
  find out but reading this repo.
- **Why deferred:** The dropping itself is right, and the alternative is worse:
  refusing the file outright makes the advisor vanish from the roster instead of
  being narrowed, which is what happened the first time. Saying so is a field on
  the wire and a row on a screen, which is a different piece of work from the
  rule.
- **Unblocked by:** Wanting to see it. `GET /api/council` would carry the names
  it dropped alongside the ones it kept, and the panel would draw them struck
  through with "not beside the web" — the same shape the blocked-owner list
  already uses. The settings page refuses the pairing on save, so this is only
  about files written before a tool was marked private, or edited by hand.
- **Where:** `backend/src/council-store.ts` (`readMember`, `PRIVATE_TOOLS`),
  `backend/src/routes/council.ts` (`GET /api/council`, `/api/council/tools`),
  `frontend/src/components/CouncilPanel.tsx`, `shared/api.ts`
  (`CouncilMember`).

## Whether the money advisor should read the web at all

- **What:** Ariel's remit is the money, read from headroom, and her headroom
  server is granted separately from her verksted tools. Her seed keeps the web
  off; the member on the pod has it on, which costs her every private tool
  including `recall` (see the entry above) and buys her a page she has no remit
  to fetch. Sophia is the one whose whole remit is the web. The same question
  applies to the seed: `status` is not private and Ariel's seed holds it, but
  the member on the pod does not, so the two have drifted.
- **Why deferred:** It is a decision about what that advisor is for, not a bug,
  and it is one tap on the settings page either way. Changing the seed would not
  touch the member already on the volume — seeding never rewrites one.
- **Unblocked by:** Deciding. Turning her web off gives her back the bench state
  and her recall; leaving it on keeps her able to look up a rate or a price.
- **Where:** `backend/src/council-store.ts` (`SEEDS`), and the member file at
  `$COUNCIL_DIR/ariel.json` on the pod, which the settings page edits.

## Nothing the assistant changed can be put back from the log

- **What:** Every call the assistant makes that changes something is appended to
  `/data/assistant/tool-log/<day>.jsonl` with its arguments in full (A-31), and
  the settings page's Assistant tab reads it back a day at a time. The audit
  also asks for an undo: replaying a move or a relabel backwards, putting a
  deleted event back from `calendar-trash/`, restoring a label or rule from a
  snapshot. The records an undo would be replayed from are written
  (`mail-log/<day>.jsonl` with the uids the messages have where they landed,
  `calendar-trash/`), and all three directories are pruned after 90 days.
- **Why deferred:** An undo needs a per-tool inverse and a decision on what may
  be undone how long after, which is a feature of its own rather than a reader.
  The chair was deliberately not given the log as a tool: that would let a turn
  read what earlier turns did.
- **Unblocked by:** Deciding which tools get an undo, starting with `mail_move`
  (the mail log already holds what a move back needs), and where the button
  sits: on the log's row is the obvious place.
- **Where:** `backend/src/tool-log.ts`, `backend/src/mail-log.ts`, `keep` in
  `backend/src/calendar.ts`, `frontend/src/components/settings/ToolLog.tsx`.

## Only Gmail reads are retried

- **What:** A Gmail read that meets a 429 or a 5xx is asked again twice, and an
  HTML error body no longer surfaces as a parse error (A-21). The calendar and
  IMAP have no retry at all.
- **Why deferred:** tsdav and imapflow each own their requests, so a retry
  there is a wrapper per call site rather than one loop, and writes must stay
  out of it.
- **Unblocked by:** A calendar or mail tool failing in use on a transient
  error. `test/helpers/dav-server.ts` is the server a calendar retry would be
  tested against.
- **Where:** `call` in `backend/src/gmail.ts`, `connect` and `davFetch` in
  `backend/src/calendar.ts`, `withInbox` in `backend/src/mail.ts`.

## Every mail and calendar call still opens its own connection

- **What:** The cost of what is fetched is down (A-23, A-24, A-25): the Gmail
  token is kept for its lifetime, an event is asked for by uid, and a message
  is read by its text part. The cost of getting there is not. Each IMAP verb
  is a fresh login, and each calendar call is tsdav's discovery (three
  PROPFINDs) plus, on Google, a token trade of tsdav's own that the Gmail
  cache cannot serve.
- **Why deferred:** A kept connection needs an owner: idle timeouts, a server
  that hangs up, a password changed on the settings page while it is open.
  That is a small pool with its own tests, not a change to the callers, and the
  tools are used a handful of times an hour.
- **Unblocked by:** The assistant's mail or calendar tools feeling slow in use,
  or a provider rate-limiting logins. For the calendar the cheap half is
  keeping the discovered account and calendar list for a few minutes.
- **Where:** `withClient` in `backend/src/mail.ts`, `connect` in
  `backend/src/calendar.ts`.

## The per-session routes still ask tmux on every call

- **What:** The last piece of the audit's root cause 4. The sweep, the
  measuring, the usage backfill and the feed's filing all run in background
  jobs now (`sweeper.ts`, the daily housekeeping), sessions ended more than
  `RETAIN_DAYS` ago are archived, and no GET writes. What is left is that
  liveness is not cached: a request about one session still runs `tmux ls`
  for itself, and a screen that makes several such requests runs it several
  times.
- **Why deferred:** It costs a process spawn per request and nothing has been
  measured to be slow because of it; a cache means deciding how stale "is it
  alive" may be.
- **Unblocked by:** A measurement that shows it matters, then the sweeper's own
  `tmux ls` answer kept for one tick and read by the routes.
- **Where:** `backend/src/tmux.ts`, `backend/src/sessions-store.ts`,
  `backend/src/sweeper.ts`, `backend/src/routes/sessions.ts`.

## The restore has never been rehearsed

- **What:** O-03 in the audit. `vk backup` runs nightly and every run reads its
  own manifest back, but no archive has ever been restored somewhere and looked
  at. The backup target is a share on the same NAS as the PVC, and where that
  NAS copies offsite, if anywhere, is not written down here.
- **Why deferred:** It needs the pod and the NAS, not code. RUNBOOK.md now has
  the steps.
- **Unblocked by:** One `vk restore <archive> --target /tmp/restore-drill` from a
  pod session, a look at what came back, and a line here (or in RUNBOOK.md)
  with the date, the archive and what was checked. And a sentence on where the
  NAS copy goes offsite.
- **Where:** `RUNBOOK.md`, `runtime/vk` (`restore`), Homelab's NAS and backup
  configuration.

## The pod's backups are written unencrypted

- **What:** O-04 in the audit. `VK_BACKUP_PASSPHRASE` encrypts every archive,
  and the Deployment does not set it, so the archives on the shared NAS share
  hold every token, private key and OAuth login in cleartext.
- **Why deferred:** The fix is in the Homelab repo, which is public, so the
  passphrase belongs in a Secret the Deployment references, not in the
  manifest; and whoever sets it has to keep a copy somewhere other than the
  volume, or the archives become unreadable exactly when they are needed.
- **Unblocked by:** A Secret with the passphrase, `VK_BACKUP_PASSPHRASE` from it
  in `k8s/talos/apps/verksted/deployment.yaml`, and the passphrase in a password
  manager. Existing cleartext archives age out after `VK_BACKUP_KEEP` nights.
- **Where:** Homelab `k8s/talos/apps/verksted/deployment.yaml`; this repo
  `runtime/vk`, `.env.example`.

## Privilege separation on the pod

- **What:** Root cause 1 in the audit, and O-08. The code is in: with
  `VK_AGENT_USER=vk-agent` sessions, their agents, git, gh and every chromium
  run as uid 1001, the backend refuses that uid's requests but for a
  session's own few routes (`agent-gate.ts`), and the first boot hands the
  repos and HOME to it and closes the backend's stores. It is off until the
  pod sets the variable, and the pod still runs as root with no
  `securityContext`, no NetworkPolicy, and a dind sidecar that is node-root
  equivalent whatever the users are.
- **What it closes once on:** a session, an unattended run and the
  assistant's chromium reaching the API over loopback or a pod address (the
  far half of S-04(b), and A-01's second half); credentials on the tmux
  command line (S-03) become values the only other user on the pod already
  holds. What stays open until the egress NetworkPolicy exists is the ingress
  hostname: a request through it arrives from outside the pod and looks like
  the browser's.
- **Why deferred:** Turning it on changes ownership across the volume (a
  one-time `chown -R` of the repos and HOME) and belongs in the Homelab repo,
  where a rollback plan and a backup first are part of the change.
- **Unblocked by:** `VK_AGENT_USER=vk-agent` in the Deployment after a fresh
  backup, a check on the pod that a session, the terminal, the session browser
  and `vk feedback` still work, then a NetworkPolicy and `securityContext`.
- **Where:** `backend/src/agent-user.ts`, `agent-gate.ts`, `agent-setup.ts`,
  `Dockerfile`; Homelab `k8s/talos/apps/verksted/deployment.yaml`.

## main's ruleset lets an admin push past it

- **What:** O-18 in the audit. The ruleset on `main` requires four checks but
  allows admin bypass and does not require a pull request, while the
  dependabot auto-merge workflow's safety comment leans on it as the gate.
- **Why deferred:** Requiring a PR for admins as well changes how the owner
  works on this repo, which is theirs to decide rather than a fix to make.
- **Unblocked by:** The owner's call on removing the bypass and requiring a PR.
  Then `gh api -X PUT repos/mortennordbye/verksted/rulesets/20606001` with the
  pull_request rule added and `bypass_actors` emptied.
- **Where:** GitHub repository settings; `.github/workflows/dependabot-auto-merge.yml`.

## Whether the e2e flake is gone is not yet known

- **What:** "reads the whole run in one scroll" in `e2e/smoke.test.ts` failed
  about one CI run in four, either with `review all` never appearing or with
  `page.goto` aborted a few milliseconds in. The cause the old entry guessed at
  was reproduced: a closing overlay drops its history entry with a
  `history.back()` that lands a task or two later, and whatever is opened or
  navigated in between is undone by it. The test before now ends with the
  viewer closed and waits on the `popstate` itself and on the overlay entries
  being gone, and a failure of the `review all` click reports the URL and the
  open dialogs. `settled()` had also been waiting for nothing: a string
  predicate is compiled in the page, the app's CSP refuses that, and its
  `catch` swallowed the refusal.
- **Why deferred:** Five local runs in a row pass, but the failure was never
  frequent locally, so only CI over a week says whether it is fixed.
- **Unblocked by:** A week of CI on main without that test failing. Then delete
  this entry and `e2e-review-all-flake` from the notes.
- **Where:** `e2e/smoke.test.ts` ("asks before a tap beside the file viewer
  throws away an edit" and the test after it),
  `frontend/src/useDismissOnBack.ts` (`ownBack`, `overlaysSettled`).

## The pod's readiness probe still asks `health`

- **What:** `GET /api/ready` answers 503 when tmux cannot be reached or the
  sessions directory cannot be written to. Nothing asks it yet: the image's
  `HEALTHCHECK` and the Deployment's probes both use `/api/health`, which
  answers whenever the process does.
- **Why deferred:** The Deployment lives in the Homelab repo. The `HEALTHCHECK`
  was left on `health` on purpose: it restarts the container, which ends every
  tmux session, and a volume that has gone read-only is not fixed by that.
- **Unblocked by:** A `readinessProbe` on `/api/ready` in the Homelab manifest,
  with `livenessProbe` left on `/api/health`.
- **Where:** `backend/src/app.ts` (`/api/ready`), `Dockerfile` (`HEALTHCHECK`),
  `RUNBOOK.md`.
