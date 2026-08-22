# The verksted sandbox

You are working inside a verksted session: one container holding tmux, the agent
CLIs, git, gh, kubectl, node, python — and a docker _client_. Read this before
running `docker`, `docker compose`, or a project's `make` targets. The
environment differs from a laptop in two ways that fail silently rather than
loudly, and carries one credential worth knowing you have.

Run `vk doctor` to see the live topology of the session you are actually in.

## 1. The docker daemon is a sibling, not local

`DOCKER_HOST` points at a separate docker daemon: the `dind` service in local
development, a sidecar container in the pod. It has its own filesystem.

**Bind mounts are resolved by the daemon, in the daemon's filesystem.** The
daemon has the data volume mounted at the same path this container sees it, so:

- Paths under `/data` — every repo (`/data/repos/<project>`) and `$HOME`
  (`/data/home`) — bind-mount correctly.
- Paths outside `/data` — `/tmp`, `/app`, scratch directories — do not. Docker
  creates an empty directory and mounts that, without an error. The symptom is a
  container that starts fine and then cannot find your source: "no such file",
  `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`, an empty `/app`.

So keep anything you intend to bind-mount inside the repo you are working in.
Do not stage files in `/tmp` and mount them from there.

`docker build` is unaffected: the build context is streamed to the daemon over
the API socket, so builds and `COPY` work from anywhere.

## 2. Published ports land on the daemon, not here

A container started with `-p 3000:3000` publishes into the _daemon's_ network
namespace.

- In the pod the sidecar shares the pod network, so the port is on
  `127.0.0.1:3000` — reachable from here and from the session's browser pane.
- In local development the daemon is a separate compose service, so the port is
  on `dind:3000`, not `localhost:3000`.

`vk doctor` prints the right host for the session you are in. Reach for it when
a project's README says "open http://localhost:PORT".

## 3. kubectl is already pointed at the cluster you are running in

There is no kubeconfig to write and no context to select: in the pod, kubectl
reads the projected ServiceAccount token and talks to the cluster hosting this
session. On a bench outside a cluster there is no token, and every command fails
to find a server — which is the honest answer, not a setup step you missed.

The account is bound to cluster-wide **read**, plus `create` on Kargo
Promotions. So `get`, `describe`, `logs`, `top` and `events` work anywhere,
including the `argoproj.io` and `kargo.akuity.io` custom resources — an ArgoCD
Application's sync state and a Kargo Stage's Freight are ordinary objects here.
Secrets are not readable: the builtin `view` role leaves them out, and that is
deliberate.

Two things follow. `apply`, `edit`, `delete` and `scale` will be refused, and
should be: ArgoCD owns cluster state and reconciles it from git, so a change
belongs in a manifest and a pull request. And the credential is the pod's, not
yours — every session shares it, so treat what you read as you would anything
else on a shared machine.

## Other things worth knowing

- **File watching.** Repos live on a network volume in the pod. Bind-mounted hot
  reload works, but inotify events may not cross it. If a watcher never fires,
  switch it to polling: `CHOKIDAR_USEPOLLING=1`, Vite `server.watch.usePolling`,
  `tsx watch --poll`.
- **Compose project names.** Every session shares one daemon. Two sessions in
  two worktrees of the same repo derive the same compose project name and will
  stop each other's containers. Export a distinct `COMPOSE_PROJECT_NAME` first —
  `$VK_SESSION_ID` is unique per session.
- **Installs persist, scratch does not.** `$HOME` and the repos are on the data
  volume, so packages you install and CLIs you log into survive a pod restart.
  Anything written outside `/data` is gone with the container.
- **`vk backup` exports the volume.** One `tar.gz` of all of `/data` —
  settings, credentials, sessions, memory, and every repo including its `.git`
  — into `/data/backups`, with `vk restore` to put it back. Take one before
  anything you would not want to redo; nothing runs it on a schedule. The
  archive is unencrypted and holds every token on the box, so do not copy it
  anywhere you would not keep a password file.
- **Never set `ANTHROPIC_API_KEY`.** It silently overrides Claude Max
  subscription auth and bills per token.
- **Commit messages are filtered.** A system-wide `commit-msg` hook strips AI
  attribution — `Claude-Session:`, a `Co-authored-by:` naming Claude — from
  every commit in every repo here. Do not add them back; the history and the
  GitHub contributors list are meant to name the human author alone. The hook
  chains to a repo's own `commit-msg` and to `.husky/commit-msg`, so a project's
  linting still runs and can still reject a message.
