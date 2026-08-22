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

## Backing it up

Everything verksted knows is a file under `/data`, and none of it is in git or
in a Kubernetes Secret — the agent tokens, the OAuth logins, the assistant
threads, the memory, the schedules and the repo working trees all live on the
volume alone. `vk` exports the lot to one archive and puts it back.

```bash
vk backup              # -> /data/backups/verksted-<date>.tar.gz (+ .sha256)
vk backups             # what is in there already
vk restore ARCHIVE     # put one back
```

The archive carries `/data` whole, including each repo's `.git`, so uncommitted
and unpushed work comes back with it. What it leaves out is the rebuildable
stuff: `~/.cache`, `~/.npm`, `~/.cargo`, `~/.rustup`, `~/.local`, and
`node_modules`, `.venv`, `target`, `dist` and friends inside the repos. That is
the difference between a 23G volume and a 900M file, and about a minute to
write it. A `MANIFEST.json` rides
along at the front recording when, from which host and image, and every repo's
remote, branch, commit and whether it was dirty.

Backups are manual. Nothing runs on a timer, so take one before anything you
would not want to redo.

**The archive is not encrypted.** It holds every token, private key and OAuth
login on the volume in cleartext, and `/data/backups` is a real folder on the
NAS behind the PVC — treat the file the way you would treat a password
database. It is also on the same disk as the thing it protects, which makes it
an undo button, not a backup. Move it somewhere else:

```bash
kubectl cp verksted/<pod>:data/backups/<file> ./<file>
```

Restoring is the same in reverse — `kubectl cp` it back, then `vk restore`.
Extract merges rather than replaces: it restores what was in the archive and
leaves anything else where it stands. Restoring over the live `/data` needs
`--force` and a restart afterwards, because the backend reads `settings.json`
at startup. For a migration, point a fresh pod at an empty volume, copy the
archive in, and run `vk restore`.

## Licence

MIT — see `LICENSE`.
