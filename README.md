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

## Connecting a calendar

The assistant reads the calendar, and adds, moves or removes an event when you
tell it to. Over CalDAV, so any provider that speaks it works, but Google only
lets a client in with OAuth: its CalDAV answers a password with a 401.

**Google (Workspace or personal).** Once, in the Google Cloud console, signed in
as the account whose calendar it is:

1. Create a project and enable the **CalDAV API**.
2. Under **Google Auth Platform**, fill in the app name and support email. Pick
   **Internal** as the audience on a Workspace account: only your organisation
   can sign in, Google does not review the app, and the sign-in does not lapse
   after seven days the way an unreviewed external app's does.
3. Create an OAuth client of type **Web application** whose authorised redirect
   URI is `https://<your host>/api/calendar/google/callback`. Settings, Sources
   shows the exact string the server will send; it has to match character for
   character.
4. In verksted, **Settings → Sources**: paste the client ID and secret, save,
   press **Sign in with Google** and allow calendar access.

The page then says who is signed in. The client, the refresh token and the
address are kept with the other settings on the volume (`GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_USER`) and are
never handed to an agent session. **Disconnect** revokes the token at Google and
forgets it; the client stays, so signing in again is one tap. A Google sign-in
wins over any `CALDAV_*` values.

**Anything else** (iCloud, Fastmail): set `CALDAV_URL`, `CALDAV_USER` and an app
password in `CALDAV_PASSWORD` under Settings, Agents, Environment.

**What the assistant does with it.** `calendar_add`, `calendar_update` and
`calendar_delete` are the chair's alone and are never offered to a scheduled
run. They are for when you asked; an event it thinks of by itself is still a
card to tap. New events go on the primary calendar. A recurring event is
refused rather than guessed at (see `BACKLOG.md`). The chat's **calendar**
button shows the month beside the thread, refreshed as it talks.

**When it does not work.**

- _redirect_uri_mismatch_ on Google's page: the URI on the OAuth client differs
  from the one Settings shows.
- The Google section is missing from Settings after an update: the tab is on a
  cached build. Reload; if it persists, unregister the service worker.
- The calendar panel says it is not set up after signing in: check
  `GET /api/calendar/google`. `account: null` means the sign-in did not finish,
  and the banner on Settings, Sources says why.

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

The archive is everything on the volume, which means every token, OAuth login
and private key on it. Set `VK_BACKUP_PASSPHRASE` and each one is written
encrypted (`.tar.gz.enc`) and needs the same passphrase to read back; leave it
unset and they are written in the clear, as they always were. Keep the
passphrase in a password manager rather than on the volume — the volume is the
thing the archive exists to replace, and an archive nobody can decrypt is worse
than one anybody can read. Every backup reads its own manifest back before it
prunes anything, so a run that produced something unreadable says so instead of
deleting the archive you would have needed.

The archive carries `/data` whole, including each repo's `.git`, so uncommitted
and unpushed work comes back with it. What it leaves out is the rebuildable
stuff: `~/.cache`, `~/.npm`, `~/.cargo`, `~/.rustup`, `~/.local`, and
`node_modules`, `.venv`, `target`, `dist` and friends inside the repos. That is
the difference between a 23G volume and a 900M file, and about a minute to
write it. A `MANIFEST.json` rides
along at the front recording when, from which host and image, and every repo's
remote, branch, commit and whether it was dirty.

Archives land in `VK_BACKUP_DIR`. In the pod that is an NFS mount off the NAS
rather than the PVC — an export stored on the volume it exists to replace is an
undo button, not a backup — and the settings page says so plainly if it is ever
pointed back at `/data`. One runs nightly, keeping the last `VK_BACKUP_KEEP`
(default 7); set it to `0` to turn that off. **Settings → Backups** shows where
they go, what is there and how old, and takes one on demand.

**The archive is not encrypted.** It holds every token, private key and OAuth
login on the volume in cleartext — treat the file the way you would treat a
password database. To pull one off the box:

```bash
kubectl cp verksted/<pod>:mnt/backups/<file> ./<file>
```

Restoring is the same in reverse — `kubectl cp` it back, then `vk restore`.
Extract merges rather than replaces: it restores what was in the archive and
leaves anything else where it stands. Restoring over the live `/data` needs
`--force` and a restart afterwards, because the backend reads `settings.json`
at startup. For a migration, point a fresh pod at an empty volume, copy the
archive in, and run `vk restore`.

## Licence

MIT — see `LICENSE`.
