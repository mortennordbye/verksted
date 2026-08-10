# verksted

A self-hosted workbench for driving coding agents (Claude Code, Antigravity,
Codex) from a phone. One container: agent sessions live in tmux and survive
restarts, a web terminal attaches to them, and the file tree, git panel, pull
requests and CI runs sit alongside.

It is built for one person on a private network. WireGuard is the auth
boundary — there is deliberately no in-app login, and the app must never be
exposed publicly.

## Getting started

Copy `.env.example` to `.env`. The server defaults work as they are; agent
credentials are only needed to actually run an agent.

```bash
make setup   # build dev images and install deps (inside the container)
make dev     # backend :8080, frontend :5173 with hot reload
make test    # vitest, backend and frontend
make e2e     # build the frontend, then smoke it in a real chromium
make lint    # tsc --noEmit across workspaces, then eslint
make build   # production image (tag: verksted)
make run     # run that image on :8080 (needs .env)
```

All tooling runs in containers. Do not run npm on the host: node-pty is a
native module built for Linux, and host `node_modules` would shadow it.

`make help` lists the targets.

## How it is put together

- **Backend** — Node 22, TypeScript, Fastify. REST under `/api`, a websocket
  bridging xterm.js to `tmux attach` through node-pty, and static serving of
  the built frontend.
- **Frontend** — Vite, React, Tailwind v4, @xterm/xterm. Hub, project, session,
  inbox and settings screens.
- **Runtime** — tmux, the agent CLIs, `gh` and `git`. One tmux session per
  agent session; everything stateful lives under `/data`.

There is no database. Repos are directories under `REPOS_DIR`, `tmux ls` is the
truth about which sessions are alive, and session metadata is one JSON file per
session.

`SPEC.md` has the full picture, `CLAUDE.md` the working rules for changes, and
`BACKLOG.md` what is knowingly left undone.

## Licence

MIT — see `LICENSE`.
