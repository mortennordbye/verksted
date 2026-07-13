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

## Milestone 4 (per SPEC.md, not started)

- **What:** Status hooks ("waiting" badge via Claude Code Notification/Stop
  hooks), ntfy pushes, PWA manifest/service worker, real WireGuard state in the
  top bar, hub footer pod facts (PVC usage, per-agent auth, MCP count).
- **Why deferred:** Out of scope for this pass by agreement (milestones 1-3).
- **Unblocked by:** Milestones 1-3 deployed and used; hook mechanism design.
- **Where:** `backend/src/sessions-store.ts` (status derivation),
  `frontend/src/components/TopBar.tsx` (wg chip), `frontend/src/screens/Hub.tsx`
  (footer)
