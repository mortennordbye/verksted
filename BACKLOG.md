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
  and antigravity may have an equivalent; neither flag is verified.
- **Why deferred:** Can't verify the flags without running those CLIs
  authenticated in the pod.
- **Unblocked by:** Testing the resume flag of each CLI in a pod terminal, then
  adding it to `RESUME_COMMANDS`.
- **Where:** `backend/src/sessions-store.ts` (`RESUME_COMMANDS`),
  `frontend/src/screens/Project.tsx` (picker label)

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

- **What:** Real WireGuard state in the top bar (the chip is static), and
  per-agent auth status + MCP server count in the hub footer. PWA, status
  hooks, ntfy pushes, and the pod-facts footer (disk/mem/browsers/docker) have
  shipped.
- **Why deferred:** Needs the pod deployed (wg state and auth are cluster
  facts).
- **Unblocked by:** Milestone-1 deployment.
- **Where:** `frontend/src/components/TopBar.tsx` (wg chip),
  `backend/src/routes/facts.ts` (extend)

## Verify claude status hooks and ntfy pushes end to end

- **What:** Claude sessions launch with `--settings <hooks file>` whose hooks
  write the per-session state file; the backend derives the "waiting" badge and
  posts to NTFY_URL on transitions. Wiring is verified (state file → waiting
  badge → project counts, `--settings` accepted by the CLI), but nothing has
  confirmed claude actually fires the hooks in a real authenticated session, or
  that ntfy receives the pushes.
- **Why deferred:** Needs an authenticated claude session (past the trust
  prompt) and a real ntfy topic.
- **Unblocked by:** One authenticated session in dev or the pod: check the
  `.state` file flips waiting/running across a turn, and set NTFY_URL to a
  test topic and watch for the push.
- **Where:** `backend/src/claude-hooks.ts`, `backend/src/notifier.ts`,
  `backend/src/sessions-store.ts`

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
