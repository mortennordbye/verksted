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
- No chat UI. The terminal is the interface to the agents.

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
   marked in the tree.

Top bar shows the WireGuard state; a footer on the hub shows pod facts (PVC
usage, per-agent auth status, MCP server count).

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
  - Static serving of the built frontend.
- Frontend: Vite + React + TypeScript + Tailwind, @xterm/xterm + fit addon,
  vite-plugin-pwa for the manifest/service worker.

No database. Repos are directories, `tmux ls` is the session list, session
metadata is a JSON file per session, and status comes from agent hooks
touching state files (not from parsing terminal output).

Session status and notifications share one mechanism: Claude Code
Notification/Stop hooks (and best-effort equivalents for gemini/codex) write
state files that drive the UI badges over websocket, and post to ntfy so the
phone gets pushed when a session waits on permission or finishes.

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
