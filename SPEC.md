# verksted

Self-hosted agent workbench. A web app for running Claude Code, Gemini CLI, and
Codex sessions across git repositories from any device, hosted as a single
container in a personal Kubernetes cluster, reachable only over WireGuard.

"verksted" is Norwegian for workshop and is the working name.

## Why this exists

I want to run multiple coding-agent sessions in different repos while away from
my laptop, with a good mobile experience, a clear overview of what each session
is doing, and a real terminal where I can install packages and use CLI tools
myself. Nothing off the shelf fit all of that at low overhead.

Build-vs-buy was evaluated 2026-07-13 against: claude.ai/code (no user
terminal, not self-hosted), claudecodeui/CloudCLI (chat-first, no k8s image),
Happy (chat/mirror-first, native apps), Vibe Kanban (board only, company shut
down, community-maintained), code-server (closest fit, kept as fallback), and
Coder (too heavy for one user). Decision: build, because dropping the chat UI
requirement shrinks the project to a terminal workbench, which is small and
nearly maintenance-free since the agent CLIs render their own UI and tmux owns
session persistence.

## Requirements

- Web UI genuinely usable on mobile, installable from Safari as a home-screen
  app (PWA).
- Projects are git repos: cloned from GitHub or local-only, living on one PVC.
- Multiple agent sessions in parallel across repos; sessions survive the
  browser closing, the phone sleeping, and pod restarts of the UI layer.
- Overview of session state: running, waiting for input, finished.
- Per-session agent choice: claude, gemini, or codex, each as its real CLI in
  a real terminal.
- Interactive terminal with full tool access (gh, git, kubectl, package
  installs). Installs persist.
- MCP servers usable by the agents (config-file based, no UI needed).
- File tree visible alongside the terminal in a session.
- Single container, single PVC, single user, in the Talos cluster ("Genesis"),
  reconciled by ArgoCD.
- Access exclusively over WireGuard. Never exposed publicly: the pod holds
  agent credentials and can push code.
- No chat UI in place of the terminal. The terminal is how an agent is driven,
  and nothing is reimplemented on top of it — no message protocol, no shadow
  session state. A session can also be _read_ as a conversation, which is a
  second view of the same tmux session rather than a second way to run one: it
  parses the transcript the agent already writes to disk, so it costs a file
  read and cannot drift from what actually happened. It earns its place on a
  phone, where 40 columns of TUI redraw is a bad way to find out what an agent
  said, and on a finished session, whose terminal is gone but whose transcript
  is not.

  That view aims to show everything the CLI does, which is not the same as
  carrying everything on every poll. What travels is what a phone can hold —
  turns, tool chips, one-line rails for the things that happened to the session
  rather than in it, and the question and plan cards in full, because those are
  the decisions somebody comes back to read. What is large is fetched by id
  when a chip is tapped: a call's output, an edit's diff, a plan's body, a
  subagent's conversation, an image's bytes. So a session that printed a
  megabyte costs the same to read as one that ran `ls`, and only the megabyte
  somebody asked for ever moves.

  One thing in it is not a file read, and it is quarantined for that reason.
  A permission dialog is drawn on the pane and never written down, so knowing a
  session is blocked — and on what — means scraping the terminal. That lives in
  `backend/src/tui-prompt.ts` behind its own endpoint, returns null for anything
  it does not recognise, and null is what the screen showed before it existed.
  Reading stays a file read; only the scrape is allowed to rot.

## Product shape

Three levels:

1. Hub: list of projects (repos on the PVC). Card per project with status
   badges (sessions running / waiting / idle), branch, active agents. Add
   project = clone via gh or init locally.
2. Project: active and recent sessions. New session opens an agent picker
   (claude / gemini / codex) and starts a fresh tmux session in that repo.
3. Session: file tree of the repo plus terminal. Desktop: split pane. Mobile:
   tabs or swipe between full-screen tree and terminal. Tree is browse/view
   only in v1; editing happens through the terminal. Modified files are
   marked in the tree. The main pane switches between the terminal and the
   same session read as a conversation; the chat view is the only one that
   still works after the session has ended. The sidebar carries a fourth tab,
   changes: the commits the session made and the diff behind each file, over
   its own recorded range, so an unattended run can be reviewed from the phone
   rather than judged by its counts. From there the whole range opens as one
   patch, each file tickable as it is read and the run markable approved or
   needs-work. Those marks live on the session rather than in the browser, so a
   review begun on a phone is still half-done at a desk, and the inbox row says
   how far it got — an overnight run that has been dealt with should look
   different from one nobody has opened.

A footer on the hub shows pod facts (PVC usage, per-agent auth status, MCP
server count) and what the bench costs: tokens over the last day, week and
month with the maintainer's share of each, a bar per day for the month, the
month by project, and — read from the account rather than inferred, since the
plan's windows are the account's to keep — how much of the subscription's
five-hour and weekly allowance is already used. The pod samples those two
windows every hour and keeps the samples on the volume, which is the only
history of them there is: the account keeps none, and this one covers
everything on the account, not only what ran here. The top bar deliberately shows no WireGuard state: the app is
only reachable through the tunnel, so a chip there can never say anything but
"connected" to anyone able to read it. A tunnel that drops mid-session shows up
as the connection banner instead.

A clickable single-file HTML mock of all three screens exists (dark theme,
monospace-forward, amber accent, agent colors: claude coral, gemini blue,
codex green). Keep it in the repo as the design reference for the frontend.

## Architecture

One container, three parts:

- Runtime: tmux, claude CLI, gemini CLI, codex CLI, gh, git, node, python,
  and general toolchains. One tmux session per agent session. Repos, agent
  configs (~/.claude etc.), and user-level tool installs all live on the
  single PVC so everything survives restarts.
- Backend: Node 22 + TypeScript + Fastify, one process on one port.
  - REST: list/clone projects, create/kill/list sessions, file tree and
    file-read endpoints scoped to the repos directory.
  - WebSocket: bridges xterm.js in the browser to `tmux attach` via node-pty.
  - Server-sent events: the session and project lists, pushed when they change.
    One watcher on the pod feeds every connected client and runs only while at
    least one is listening, so what the screens used to ask for on a five-second
    timer each — three git processes per repo, per client — is computed once or
    not at all. Clients fall back to polling whenever the stream is not healthy.
  - Static serving of the built frontend.
- Frontend: Vite + React + TypeScript + Tailwind, @xterm/xterm + fit addon,
  vite-plugin-pwa for the manifest/service worker.

No database. Repos are directories, `tmux ls` is the session list, session
metadata is a JSON file per session, and status comes from agent hooks
touching state files (not from parsing terminal output).

Session status and notifications share one mechanism: Claude Code
Notification/Stop hooks (and best-effort equivalents for gemini/codex) write
state files that drive the UI badges over websocket, and feed the notifier so
the phone gets pushed when a session waits on permission or finishes — as a web
push to the installed PWA (per-device, opt-in on the settings page) and to an
ntfy topic when one is configured.

## Auth and credentials

- Claude: Max subscription, no API billing. Generate a token with
  `claude setup-token` (interactive, on a machine with a browser, valid one
  year) and inject it as CLAUDE_CODE_OAUTH_TOKEN. Never set ANTHROPIC_API_KEY
  in the pod; it silently overrides subscription auth and bills per token.
  Verify with /status in a session that auth shows subscription.
- Gemini and Codex: equivalent env-based credentials, injected the same way.
- GitHub: PAT or GitHub App token for gh/git push.
- All secrets flow through External Secrets Operator in the cluster; nothing
  is baked into the image or committed.
- Network auth boundary is the VPN. In-app auth is deliberately absent in v1;
  add an auth layer only if the app ever needs to be reachable outside
  WireGuard.

## Schedules

Recurring prompts, so the workbench keeps an eye on a repo without being
asked. Each schedule is a name, a project, a cron pattern (read in the pod's
timezone), an optional jitter window, and a prompt; they live as one JSON file
each under SCHEDULES_DIR and are managed from the settings page.

When one fires, the backend starts an ordinary claude session in that project
and hands it the prompt, in claude's auto permission mode: the routine tool
calls go through unattended, and the ones that still need a person stop the
session, which is what turns it "waiting" and pushes the phone. Nobody is there
to confirm a `git status` at 07:00; the judgement calls still come to you.
Because it is an ordinary session, everything
built for sessions applies to it: it appears on the hub, the status hooks flip
it to "waiting" when it needs a person, the notifier pushes to the phone, and
tapping the push opens the terminal to take over. A tick is skipped while the
schedule's previous session is still open.

Every run is asked to sign off with one line to $VK_REPORT_FILE — "ok: …",
"attention: …" or "failed: …". That line is the push body, it shows on the
schedule, and a run that reports itself ok pushes nothing at all. Only the
agent can tell whether "two PRs open" is fine or needs someone, which is why
the verdict is the agent's to write rather than something the backend infers.
Sessions started by hand write no report and behave exactly as before.

"ok" is the stated default and the other two have to earn themselves against
it. Asked merely "which of these needs me?", an agent that had finished its
work and left a list to read called that "attention" — so a run that was done
arrived as "needs a look" and woke a phone for something nobody was blocked on.
The contract now says outright that having something to read is not the same as
being stuck, and that a tie goes to "ok": the work is on the hub either way,
and an inbox of false alarms is one nobody reads.

A schedule can run a maintainer stage instead of a prompt of its own. That is
the other kind of unattended: a run nobody will pick up if it stops, so it must
not stop. Claude runs headless (`-p`) in dontAsk mode with a PreToolUse guard
(`runtime/vk-guard`) and a deny list under it — a force push, a push to main,
an `rm` or an edit that resolves outside the working tree, anything the cluster
or a backup could not undo — and a denied call fails in front of the model
rather than waiting for a person. The Stop hook writes `failed: no sign-off`
when the run left no report, the scheduler ends the session when the agent has
exited (the pane keeps its shell, so tmux alone would say it was still going)
or after ninety minutes, and a pod restart fails it in its own words rather than
resuming it. What a stage knows about the repo comes from the repo: the
`## Maintainer` section of its CLAUDE.md, with the command that verifies it, what
may merge on its own and what is never to be touched unasked, read at launch.
The first stage is the scout, which reads a repo and files the work it finds as
labelled issues and changes nothing else; the stages that build and gate that
work follow it.

One such schedule is how the workbench learns: nightly it reads back what you
typed into the sessions that ended that day — only your own words, never model
output or tool results — and proposes facts worth keeping. They wait in the
inbox and reach no session until you keep one. That gate is not optional;
ASSISTANT.md says why at length. A day when no session ended is skipped before
anything is spawned, so a quiet day costs nothing, and twelve unattended turns a
day is a hard ceiling across every schedule.

Two house rules go into the global memory file of claude and codex beside the
sandbox note (agy's equivalent file is still unverified — see BACKLOG), so they
hold in every repo including ones verksted has never seen: leave
no sign that an agent wrote anything — no `Co-Authored-By` trailer, no
"Generated with" footer, no mention of AI in commits, branches, pull requests or
comments — and ask before anything git cannot undo, while treating commits,
new branches and pull requests as ordinary work.

A schedule can run the assistant instead of a session. It then has no project,
starts nothing, and cannot change anything: it reads the bench, answers in a
line or two under the same three-word sign-off, and pushes the phone through
`notify` only when the answer should interrupt you. That is what a morning
briefing is, and it is the only path by which this app speaks first. The details
— why each run gets a fresh conversation, and what stops a broken one pushing
hourly — are in ASSISTANT.md.

Each schedule keeps its last 20 firings, and the inbox screen flattens them
across schedules, newest first — the answer to "anything overnight?" without
opening a terminal. Two guardrails sit in front of an unattended agent: a
pause-all switch (the cron stops; "run now" still works, since that one is
somebody asking), and a refusal to start a run when the pod already has six
sessions alive. Both refusals are recorded as run outcomes rather than
swallowed, so a schedule that never fires says why.

The timers themselves live only in memory and are rebuilt from the stored
records at boot, so a restart spanning a cron would lose that firing with
nothing left to say it should have happened — and in an inbox where an `ok` run
is meant to stay quiet, a scheduler that never fired reads exactly like a night
when all was well. Each schedule therefore records when its timer last fired,
and a boot asks every one of them what it missed: a tick under an hour old, and
under half the schedule's own interval, is run on the way up; an older one is
written off as a firing of its own, so the inbox says the pod was down rather
than saying nothing. A tick the pod was up for is never one of these — the
pause switch, the idle rule and a run still going all drop a tick deliberately,
and re-running those is the stacking the ceilings above exist to prevent.

Voice input belongs to the browser: the pod has no microphone, the phone does.
The session toolbar has a mic key that dictates into the terminal (the browser's
own speech recognition, secure origin required) and leaves the text in the pane
unsent, so it can be read before the agent gets it.

Voice is answered on the pod in both directions: whisper.cpp transcribes what
was recorded, and a small neural model (Kokoro) speaks the replies. Neither
leaves the network, which is the same reason there is no public ingress — and
speaking here is also the only way to sound like a person on the device this is
used from, since iOS never exposes Siri or the enhanced voices to a web page.
The browser's own speechSynthesis remains the fallback for a pod without the
model.

## Deployment

- Image: multi-stage Dockerfile. Build stage compiles the frontend; runtime
  stage is node:22-slim plus tmux, git, gh, the three agent CLIs, and
  toolchains. Built and pushed to GHCR by CI in this repo.
- Kubernetes manifests live in the Homelab repo under k8s/talos/apps/,
  following its conventions: ArgoCD application, Deployment, single PVC,
  ExternalSecrets, and a VPN-only route (Cilium LB IP or internal route
  reserved for the WireGuard subnet). No public HTTPRoute.
- Local development is containerized (make targets wrapping Docker); no
  native node tooling on the laptop. Dev and prod share the same environment.

## Milestones

1. Runtime image + PVC + secrets. Verify claude, gemini, and codex sessions
   in tmux via kubectl exec; confirm Claude Max auth with /status.
2. Backend websocket bridge + bare terminal in the browser over the VPN.
3. Hub and project UI: project list, clone, session lifecycle, file tree.
4. Status badges, ntfy pushes, PWA polish in Safari.

Each milestone is independently useful. If 2 or 3 stalls, code-server on the
same runtime image is the fallback and the runtime layer carries over
unchanged.

## Decision log

- 2026-07-13: build decided after product evaluation (see "Why this exists").
- 2026-07-13: spec v1 fixed: hub > project > session, multi-agent, MCP via
  config files, single container/PVC/user, WireGuard-only, Safari PWA, no
  chat UI, file tree read-only in v1.
- 2026-07-13: stack fixed: Node/TS + Fastify + node-pty, Vite + React +
  Tailwind + xterm.js, no database, single multi-stage image. Go rejected
  (second toolchain), Bun rejected (node-pty risk).
- 2026-07-13: UI mock produced (single HTML file, three screens, dark mono +
  amber). Working name "verksted".
- 2026-07-13: Gemini CLI replaced by its successor Antigravity CLI (`agy`,
  standalone Go binary, install script) as the Google agent. Headless auth via
  ANTIGRAVITY_API_KEY, or interactive `agy` login persisted on the PVC.
