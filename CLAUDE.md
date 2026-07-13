# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working approach

These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### Goal-driven execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### Track unfinished work in BACKLOG.md

If you leave anything unfinished, partially implemented, or explicitly defer it, add an entry to `BACKLOG.md` in the repo root before reporting the task done. Don't bury deferrals in chat — they vanish next session.

Each entry needs four things: **what** the work is, **why** it was deferred, **what would unblock it**, and **where** the relevant code lives (file paths). Read existing entries for the format.

Don't put work-in-progress on `BACKLOG.md` — WIP belongs on a branch. The backlog is for *known gaps the team has agreed to leave for later*. If you finish an item, delete it.

What counts as "unfinished":
- Tier 1 / Tier 2 splits where you only shipped Tier 1.
- Out-of-scope items you noticed but didn't fix.
- Features behind a feature flag that still need ramping or cleanup.
- Tests skipped, mocks left in, debug logging not yet stripped.
- TODO comments you wrote (write the entry instead — TODOs rot in code).

What does NOT belong:
- Forward-looking ideas the user didn't agree to defer ("we could also..."). Either do them or drop them.
- Codebase-wide debts that pre-existed your work and the user didn't ask you to track.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Development

Env vars: copy `.env.example` to `.env` (server config has working defaults; agent
credentials only needed to actually run agents).

```bash
make setup   # first time: build dev images + npm install (inside the container)
make dev     # backend :8080 (tsx watch) + frontend :5173 (vite HMR)
make test    # vitest (single test: docker compose run --rm backend npx vitest run test/<file>)
make lint    # tsc --noEmit across workspaces
make build   # production image (tag: verksted)
make run     # run the production image on :8080 (needs .env)
```

All node tooling runs inside containers; never run npm on the host — node-pty is a
native module compiled for Linux, and host node_modules would shadow it.

**Build with containers in mind.** Develop, test, and ship inside containers so the app runs the same on a laptop, in CI, and in production — no "works on my machine" drift. Provide a `Dockerfile` (and a `compose` file when the app needs a database or other services), and keep the toolchain out of the host where practical.

**Make the dev process easy.** Wrap the common workflows — setup, run, test, lint, build — behind short scripts or `make` targets so a newcomer (or an AI) runs one obvious command instead of memorizing flags. A documented one-liner beats a paragraph of setup steps.

## Before reporting a task complete

```bash
make lint && make test
```

<!-- Optional: pre-commit / pre-push hooks (how to install them, what they run, so the
AI doesn't bypass them by accident), and any smoke / end-to-end protocol for critical
flows. State skip rules: doc-only, test-only, dependency bump, formatting changes.
For any change touching the network, auth, or data surface, also run the Security
baseline pre-ship checklist below before declaring the task done. -->

## Security baseline

Applies to any project with a network, auth, or data surface — APIs, web apps, services. Skip it for a pure CLI, library, or offline tool, but say so when you skip. This is a floor that heads off the incidents that hit vibe-coded apps most often. It is not a substitute for a real threat model or a security review.

**Two defaults that flip the common failure modes:**
- **Deny by default.** Every endpoint, query, and storage rule starts closed and opens only for a reason you can state. An endpoint with no auth decision is a bug, not a public route.
- **Every input crossing a trust boundary is hostile** until validated — request bodies, query params, headers, path segments, uploaded files, third-party responses, anything a user can influence.

**Authentication and authorization**
- Every endpoint makes an explicit auth decision. "Public" is a choice you write down, not one you forget into.
- Authorize the object, not just the route: confirm the caller may act on *this specific* record. An ID from the client is a request, never proof of ownership — this broken-access-control / IDOR class is the most common serious bug.
- Read identity (user, role, tenant) from the verified session or token on the server. Never accept it as a request parameter.
- Enforce on the server. Hiding a button or a route in the client is not access control.

**Don't hand-roll the dangerous parts**
- Use the framework's auth, sessions, password hashing, and crypto. No custom JWT verification, no homemade login, no roll-your-own crypto.
- Reach the database through parameterized queries or the ORM. Never assemble SQL, shell commands, or HTML by concatenating user input.

**Secrets**
- Never in source, client bundles, logs, or error messages. Server-side only, validated at startup, loaded the way `### Environment variables` describes.
- A secret that ever landed in a commit is compromised — rotate it. Deleting the line does not help; git remembers.

**Abuse and cost**
- Rate-limit and size-cap anything unauthenticated or expensive: login, signup, password reset, search, uploads, and any call to a paid or model API. A runaway bill is a security incident too.

**Input and output**
- Validate and parse at the boundary with a schema, and allowlist the fields you accept — never bind a request body straight onto a database model (mass assignment).
- Don't reflect raw user input into HTML, SQL, shell, file paths, or outbound URLs (XSS, injection, path traversal, SSRF).
- Generic errors to the client, full detail to server logs only. Keep secrets and personal data out of logs.

**Data exposure**
- Storage and row-level rules default to deny (RLS on, buckets private). Return only the fields the caller needs — no password hashes, internal flags, or other users' rows.
- Restrict CORS to known origins; never `*` together with credentials.

**Before shipping anything with a network or data surface, confirm:** authenticated, authorized for the specific object, input validated, secrets out of code, rate limit on public or expensive paths, errors and logs leak nothing.

## Architecture

Single container, three parts (see SPEC.md for the full picture):
- Backend: Node 22 + TypeScript + Fastify. REST under `/api`, a websocket bridging
  xterm.js to `tmux attach` via node-pty, static serving of the built frontend.
- Frontend: Vite + React + TypeScript + Tailwind v4 + @xterm/xterm. Three screens:
  hub, project, session. mock.html in the repo root is the design reference.
- Runtime: tmux + agent CLIs (claude, agy, codex) + gh/git. One tmux session per
  agent session; everything stateful lives under `/data` (the PVC).

No database: repos are directories under `REPOS_DIR`, `tmux ls` is the session
liveness truth, session metadata is one JSON file per session in `SESSIONS_DIR`.

### Data flow rules

- Wire types live in `shared/api.ts` and are imported (type-only) by both packages —
  never redefine them per package.
- Client input is validated at the route boundary; anything touching disk goes
  through `backend/src/paths.ts` (`resolveInsideRepos`), never raw `path.join`.
- External commands (tmux, git, gh) run via `execFile` with argument arrays — never
  a shell string, never interpolated client input.

### Safety rules for AI-assisted changes

- There is deliberately no in-app auth in v1: WireGuard is the auth boundary and the
  app must never be exposed publicly. Do not add auth layers; do add strict input
  validation everywhere.
- File endpoints must stay scoped inside `REPOS_DIR` via `resolveInsideRepos`
  (realpath check — defeats `..` and symlinks). New disk-touching code reuses it.
- Agent commands come from the hardcoded agent map — client input never reaches a
  command line.
- Never set `ANTHROPIC_API_KEY` anywhere in this project; it silently overrides
  Claude Max subscription auth and bills per token.
- Closing a terminal websocket must detach (`pty.kill()` on the attach client), never
  kill the tmux session — session persistence is the core feature.

### Environment variables

**Use `.env` files for configuration and secrets.** Read config from the environment, loaded from a local `.env` file that is **gitignored and never committed**. Commit a `.env.example` listing every variable with safe placeholder values so a newcomer knows what to set. Validate the required vars at startup (a central validated module) and fail fast with a clear message when one is missing.

Server config is read only through `backend/src/env.ts` (validated, fail-fast).
Agent credentials are not read by the backend at all — they pass through the
process env into tmux for the CLIs. To add a var: extend `env.ts` + `.env.example`.

### Directory layout

```
shared/api.ts         # wire types shared by backend and frontend (types only)
backend/src/
├── index.ts          # bootstrap: env, fastify, routes, static serving
├── env.ts            # validated env, fail fast
├── paths.ts          # path-scoping helper — the security surface
├── tmux.ts           # execFile wrappers around tmux
├── sessions-store.ts # session metadata JSON + tmux liveness
├── routes/           # projects, sessions, files
└── ws/attach.ts      # node-pty <-> tmux attach websocket bridge
backend/test/         # vitest; the path-traversal suite is the one that matters
frontend/src/
├── screens/          # Hub, Project, Session
├── components/       # Terminal, FileTree, TopBar, StatusChip
├── api.ts            # fetch helpers + usePoll
└── theme.css         # mock.html palette as Tailwind v4 @theme
```

### Key patterns

- Session id == tmux session name (`vk-<project>-<seq>`); the id is the join key
  between metadata JSON, tmux, and the websocket route.
- Frontend data fetching is plain `fetch` + the `usePoll` hook in `frontend/src/api.ts`
  — no query library. Status badges move to websocket push in milestone 4.
- UI styling comes from the mock's palette in `theme.css` (`bg-surface`, `text-muted`,
  `border-line`, agent colors `claude`/`antigravity`/`codex`); mono font for anything
  terminal-ish, sans for prose.

### Code quality

- **Reuse before adding** — check shared utilities and components before writing new ones.
- **Prefer established frameworks over reinventing** — reach for a well-maintained, widely-used library or framework before hand-rolling auth, routing, state, validation, dates, HTTP, and the like. The same goes for the UI: build on a proven component library or design system (e.g. shadcn/ui, Radix, MUI, Chakra) instead of hand-rolling buttons, modals, dropdowns, and form controls — you get accessibility, keyboard handling, and a consistent look for free. Mature libraries are battle-tested and keep the app feeling consistent; bespoke versions drift and rot. Only build your own when no good option fits, and say why.
- **Use current, supported versions** — pick libraries that are actively maintained and pull a recent, supported release. Avoid end-of-life or abandoned dependencies; an unmaintained library is a security and upgrade liability.
- **No dead code** — if a button has no handler, implement or remove it.
- **No premature abstractions** — only extract a helper when it's used in 2+ places.
