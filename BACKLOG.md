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

## gh-backed endpoints have no automated coverage

- **What:** Every route in `backend/src/routes/github.ts` (PRs and Actions) is
  verified by hand only. Automated tests cover the pure helpers
  (`summarizeChecks`, `formatRunLog`, `ghError`, `ghMessage`) and the
  schema/404/no-remote paths — not one real `gh` invocation.
- **Why deferred:** CI has no `GH_TOKEN` and no network, and nothing in the
  harness mocks `execFile`. Mocking it would test the mock rather than gh's real
  output, which is the part that drifts across gh releases.
- **Unblocked by:** Either a test-only `PATH` prefix holding a fake `gh` that
  replays captured fixtures, or a CI job with a scoped token against a throwaway
  repo.
- **Where:** `backend/src/gh.ts`, `backend/src/routes/github.ts`,
  `backend/test/gh.test.ts`, `backend/test/github.test.ts`

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

## restoreSessions has no automated coverage

- **What:** `restoreSessions` — re-creating tmux for sessions that survived a
  pod restart — is verified by hand only. The unit test covers `CONV_ID_RE`,
  the injection guard on the id that reaches `tmux send-keys`, and nothing else.
- **Why deferred:** Exercising it means really spawning tmux and really starting
  an agent CLI, which makes the suite stateful against a shared tmux server and
  needs an authenticated agent to be meaningful. Nothing in the harness mocks
  `execFile` (same reason as the gh entry above).
- **Unblocked by:** A test-only `PATH` prefix holding a fake `tmux` that records
  its argv, which would let the whole restore decision — which sessions are
  picked, what command each is given — be asserted without a tmux server.
- **Where:** `backend/src/sessions-store.ts` (`restoreSessions`, `launchAgent`),
  `backend/test/sessions-store.test.ts`

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

## Docker-in-pod: dind sidecar in the Homelab manifests

- **What:** Sessions have the docker CLI + compose and expect a daemon at
  DOCKER_HOST. Dev compose provides it (service `dind`); the k8s pod does not
  yet. Needed: a `docker:28-dind` sidecar (privileged — accepted tradeoff,
  single-user pod behind the VPN), its own PVC for /var/lib/docker, and
  `DOCKER_HOST=tcp://127.0.0.1:2375` on the main container. Pruning is already
  handled backend-side (`maintenance.ts`, daily). Sidecar shares the pod netns,
  so agent-published ports appear on localhost — the session browser pane can
  preview them directly.
- **Why deferred:** Manifests live in the Homelab repo (milestone-1 cluster
  work), not here.
- **Unblocked by:** Milestone-1 deployment pass in the Homelab repo.
- **Where:** Homelab repo `k8s/talos/apps/`; this repo `docker-compose.yml`
  (`dind` service is the reference), `Dockerfile` (CLI install)

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

## Scheduled runs are unverified past the point they launch a session

- **What:** `runSchedule` is covered only where it stops short — an unknown id,
  and the store/route validation around it. The parts that matter in the pod
  are untested: that a fired schedule really starts a claude session, that the
  prompt arrives submitted rather than sitting in the input box, that
  `--permission-mode auto` lets an unattended run get through `gh pr` calls
  without stopping, and that the skip guard fires when the previous run is
  still open. The prompt's shell-safety (it travels as `VK_PROMPT` and is only
  ever a quoted expansion) was verified by hand against a real tmux session,
  not in the suite.
- **Why deferred:** Same wall as the other session tests — exercising it means
  really spawning tmux and really starting an authenticated claude, and nothing
  in the harness mocks `execFile`.
- **Unblocked by:** The test-only fake-`tmux`-on-PATH idea from the
  `restoreSessions` entry would cover the launch decision and the argv. The
  auto-mode and submitted-prompt behaviour needs one real scheduled run in the
  pod: point a schedule at a repo, hit "run now", confirm a session appears and
  the agent is already working.
- **Where:** `backend/src/scheduler.ts`, `backend/src/schedules-store.ts`,
  `backend/src/routes/schedules.ts`, `backend/test/schedules.test.ts`

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
  Still unconfirmed: that a *question* to the user counts as waiting. A session blocked on `AskUserQuestion` read `running`,
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

## Give each terminal client its own tmux window size

- **What:** Every attach client shares one tmux window, so tmux sizes it to the
  smallest attached client. Opening a session on the phone snaps the desktop
  terminal to phone geometry until the phone detaches, and agent TUIs redraw
  their boxes at the smaller width.
- **Why deferred:** The two fixes are not equivalent. `aggressive-resize` only
  helps when clients are looking at *different* windows, which is not the case
  here — every client attaches to the same one, so it changes nothing. The real
  fix is grouped sessions: each client attaches to a throwaway
  `tmux new-session -t <id> -s <id>-view-<n>`, which gets its own window and so
  its own size. That means allocating and reaping per-client view sessions, and
  it touches the invariant in CLAUDE.md that closing a websocket must detach and
  never kill the underlying session — worth doing deliberately rather than
  folding into a robustness pass.
- **Unblocked by:** Deciding how view sessions are named and reaped (including
  after a backend restart leaves orphans), and confirming that killing the base
  session takes its views with it.
- **Where:** `backend/src/ws/attach.ts` (the `attach-session` argv),
  `backend/src/tmux.ts`, `backend/src/sessions-store.ts` (`killQuietly` of the
  `-shell` companion is the pattern to follow for reaping)

## Start the agent command without send-keys

- **What:** `tmux.newSession` creates the session and then delivers the agent
  command with `send-keys`, which can race the pane shell's startup and be
  swallowed.
- **Why deferred:** The obvious fix — passing the command as `new-session`'s
  shell-command argument — changes behaviour: the tmux session then dies when
  the agent exits, instead of dropping back to a shell in the project
  directory. That shell is useful (it is how you restart a crashed agent in the
  same session, and how a failed agent command stays visible instead of the
  session vanishing). Preserving it means wrapping as
  `<command>; exec "${SHELL:-/bin/sh}"`, which is a real change to how every
  session starts and wants testing against all three agent CLIs.
- **Unblocked by:** Deciding whether a session should outlive its agent at all.
  If yes, the wrapped form above; if no, the plain shell-command form is simpler
  and also fixes the "finished" semantics.
- **Where:** `backend/src/tmux.ts` (`newSession`), `backend/src/sessions-store.ts`
  (`launchAgent` builds the command string)

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

## Arrow-key movement and tabpanel pairing for the tab strips

- **What:** The tab strips on the project and session screens use `role="tab"`
  without `aria-controls`, without matching `role="tabpanel"` elements, and
  without arrow-key movement between tabs. `aria-label`s, landmark labelling and
  the focus ring are done; this part is not.
- **Why deferred:** Doing it properly means a roving-tabindex helper and giving
  every panel a stable id, across three separate strips whose panels are
  conditionally mounted (an unselected panel is deliberately unmounted so its
  poll does not run). That interacts with the mounting rule and wants doing in
  one pass rather than piecemeal.
- **Unblocked by:** Deciding whether panels stay unmounted when unselected. If
  they do, `aria-controls` points at an element that is not in the DOM, which is
  worse than omitting it — so the fix may be `role="tablist"` removal rather
  than completion.
- **Where:** `frontend/src/screens/Project.tsx` (tab strip),
  `frontend/src/screens/Session.tsx` (side panel tabs, pane tabs)

## Clear the twenty jsx-a11y warnings

- **What:** ESLint runs with `jsx-a11y` and reports 20 warnings, all from two
  families: elements with click handlers that are not natively interactive
  (modal backdrops, the terminal and browser panes, the resize separators), and
  `tabIndex` on those same non-interactive elements. They are warnings rather
  than errors so CI is not blocked.
- **Why deferred:** Each needs markup restructuring rather than an attribute.
  The backdrops close on click *and* on Escape and Android Back already, so the
  keyboard path exists but the linter cannot see it. The browser pane's canvas
  relays raw pointer events to a remote page, and the separators are `role
  ="separator"` with arrow-key handlers — the rule does not recognise either.
  Real fixes mean choosing different elements, which is a UI change worth doing
  deliberately.
- **Unblocked by:** Going through the twenty one at a time and deciding, per
  case, whether to change the element, add a role the rule accepts, or add a
  scoped disable with a reason. Run `docker compose run --rm backend npx eslint .`
  for the list.
- **Where:** `frontend/src/components/Sheet.tsx`, `CodeOverlay.tsx`,
  `BrowserPane.tsx`, `Terminal.tsx`, `frontend/src/screens/Session.tsx`

## Adopt Prettier across the existing code

- **What:** Prettier is configured (`.prettierrc.json`) and `npm run format` /
  `format:check` exist, but the codebase has not been reformatted and
  `format:check` is not in CI.
- **Why deferred:** Reformatting every file in the same branch as a large
  behavioural change makes the diff unreviewable. The config is in place so the
  reformat is a single mechanical commit whenever it suits.
- **Unblocked by:** `npm run format` on a branch of its own, then adding
  `npm run format:check` to the lint script and CI.
- **Where:** `.prettierrc.json`, `.prettierignore`, `package.json` scripts,
  `.github/workflows/ci.yml`

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
