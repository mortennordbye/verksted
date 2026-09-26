# Backlog

Known gaps agreed to leave for later. Format per entry: what / why deferred /
what unblocks it / where the code lives.

## The phone screen may still end short with the keyboard up

- **What:** The session shell is `dvh` with the keyboard down and `--vvh` with it
  up. The `dvh` half is what closed the black band under the pane box. The
  `--vvh` half is unchanged, so if the band's cause turns out to be
  `visualViewport.height` under-reporting by the top safe-area inset — rather
  than a browser toolbar, which `dvh` accounts for by itself — then the same
  band comes back above the on-screen keyboard, where it costs the line you are
  typing into.
- **Why deferred:** Which of the two it is cannot be read off a desktop:
  headless Chromium reports `visualViewport.height === innerHeight`, so
  `100dvh` and `--vvh` are the same number there and the difference is invisible
  to the suite. Guessing the correction would be fixing a number nobody has
  measured.
- **Unblocked by:** One readout on the phone, on a session screen, comparing a
  `100dvh` probe against `visualViewport.height`, `innerHeight` and
  `navigator.standalone`. If `dvh` is the larger, the keyboard-up path needs the
  same inset added back; if they match, there is nothing here.
- **Where:** `frontend/src/screens/Session.tsx` (`useVisualViewport`, the root
  shell's `kbd:h-[var(--vvh,100dvh)]`, and the full-screen pane branch)

## Verify Antigravity headless auth in the pod

- **What:** `ANTIGRAVITY_API_KEY` is documented in `.env.example` but reports on
  agy's headless auth are mixed (some say API key works, some say interactive
  login only). The binary installs and runs (`agy --version` verified in the
  image); auth is untested.
- **Why deferred:** Needs a real key to test with. The pod is deployed; the key
  is the missing half.
- **Unblocked by:** Setting the key on the settings page, starting an
  antigravity session, and confirming it authenticates. Fallback: run `agy` once
  interactively in a pod terminal (remote login flow prints a URL); the token
  persists in `$HOME` on the PVC.
- **Where:** `.env.example`, `Dockerfile` (runtime stage)

## A scheduled tick can be lost while the pod is up

- **What:** Two nights running, one jittered schedule's tick never fired while
  the pod was up the whole time: the recovery sweep's 03:00 UTC tick on
  2026-09-22 (pod `7cf8c79856-kq9hs`, up 19:06 to 06:19) and the tidy-up's
  03:30 on 2026-09-23 (pod `749cc7f4d9-8szf6`, up 20:04 to 05:49). Nothing in
  Loki names either schedule until the next boot's `catchUp` wrote the tick off
  as "missed while the pod was down", which is wrong on the second half: the
  pod was there. No stamp either, so `fire` was never reached or hung in
  `stampFired` before its write landed. Every other tick those nights, the
  other jittered one included, fired on time, and every daily schedule has a
  run for every night from 2026-09-04 to 2026-09-21. The first night it
  happened is the first night on an image with #231, which added `handle.sync()`
  and a directory sync to every atomic write on the NFS volume; that is a
  suspect, not a finding. croner 10.0.1's own loop was read and looks sound
  (it polls every 30 s and fires on any check past the target).
- **What the restart half showed:** the old entry here asked whether
  `lastFiredAt` survives a pod replacement. It does: both boots computed the
  missed tick from the stamp the previous pod wrote. A catch-up inside the
  hour has still not been seen live, only the "too late" branch.
- **Why deferred:** The cause is not known, and a fix before it is would be a
  guess. The process that lost each tick is gone, and nothing it logged tells a
  timer that never fired from a stamp that never finished.
- **Unblocked by:** The next lost tick, read in Loki. `fire` now logs
  "firing" before the stamp and "stamped" after it, and croner's `protect`
  logs a tick it skipped because the last one is still running. No "firing"
  is the timer; "firing" without "stamped" is the write hanging, and
  `writeAtomic`'s syncs on NFS are the first place to look; a "still running"
  skip means an earlier firing hung and took this one with it. A pod restart
  inside the hour after a cron is still the way to see a real catch-up.
- **Where:** `backend/src/scheduler.ts` (`fire`, `catchUp`, `missedTick`),
  `backend/src/schedules-store.ts` (`stampFired`, `edits`),
  `backend/src/atomic-json.ts` (`writeAtomic`, `syncDir`)

## The pod's voice is English-first, and never speaks Norwegian

- **What:** Kokoro ships 54 voices, and the settings page lists all of them, but
  the assistant answers in English and the model has no Norwegian at all — the
  nearest neighbours are Spanish, French, Italian, Portuguese, Hindi, Japanese
  and Chinese. Picking one of those reads English text in that language's
  phonetics, which is a novelty rather than a feature.
- **Why deferred:** The assistant writes in English, so an English voice is the
  matching one. Norwegian would mean a second model (Piper has nb voices) and a
  language decision per reply, which is a bigger change than a voice picker.
- **Unblocked by:** Wanting to be spoken to in Norwegian. The engine is already
  behind one function (`synthesize`), so a second model is a branch there rather
  than a new subsystem.
- **Where:** `backend/src/tts.ts`, `runtime/vk-say.py`, `frontend/src/useSpeech.ts`
  (`sortVoices`, which is what puts English first today)

## What a session's work counts is the repo's movement, not the session's

- **What:** `workSince` measures from the commit HEAD was on when the session
  started to where it is when the session is first seen finished. A second
  session committing in the same repo over the same window is counted in the
  first one's row.
- **Why deferred:** Git records who authored a commit, not which agent session
  produced it, so attribution would mean tagging commits as they are made — a
  hook installed into the user's repos, which is the same decision the house
  rules entry below is waiting on. On a bench where the scheduler refuses to
  overlap a schedule with itself, the overlap is rare enough to state rather
  than engineer around.
- **Unblocked by:** Two sessions in one repo producing a row that misleads in
  practice. The half-fix is in: both ends of the range are now recorded
  (`Meta.startCommit`, `Meta.endCommit`) and the changes tab shows what is in
  it, so a row that looks wrong can be checked commit by commit. What is still
  missing is attribution itself.
- **Where:** `backend/src/git.ts` (`workSince`),
  `backend/src/sessions-store.ts` (`captureWork`), `shared/api.ts`
  (`SessionWork`, where the caveat is written down)

## Terminal dictation is unverified on a real iPhone

- **What:** The mic key in the session toolbar uses the browser's own speech
  recognition (`webkitSpeechRecognition`) and types the transcript into the
  pane. Written against the documented API; never exercised on the device it
  exists for. Unknown: whether iOS Safari prompts for the microphone in an
  installed PWA the way it does in a tab, and whether one tap reliably captures
  a whole spoken prompt or cuts off at the first pause.
- **Why deferred:** Needs the app served over https on the phone, same wall as
  the web-push verification above.
- **Unblocked by:** Opening a session on the iPhone and dictating a sentence.
  If utterances cut off too early, the fix is `continuous`/`interimResults`
  with a stop button rather than one-shot capture.
- **Where:** `frontend/src/components/Terminal.tsx` (`toggleDictation`,
  `speechCtor`)

## Verify claude status hooks and the notification channels end to end

- **What:** Claude sessions launch with `--settings <hooks file>` whose hooks
  write the per-session state file; the backend derives the "waiting" badge and
  notifies on transitions. Wiring is verified (state file → waiting badge →
  project counts, `--settings` accepted by the CLI), and real sessions in the pod
  do write `.state` files that flip waiting/running — so the hooks fire. Web
  push is confirmed end to end (Apple accepted and an iPhone showed it, once the
  VAPID subject stopped being a `localhost` mailto); ntfy is still untested.
  Still unconfirmed: that a _question_ to the user counts as waiting. A session blocked on `AskUserQuestion` read `running`,
  because every tool call's `PreToolUse` hook writes `running` and it is unclear
  whether such a prompt also fires `Notification`. If it doesn't, a question
  never pushes and the hook set needs another event (or a fallback).
- **Why deferred:** Needs an authenticated claude session (past the trust
  prompt), a real ntfy topic, and — for web push — an iPhone with the app
  installed to the Home Screen. Web push additionally requires the app to be
  served over https: on a plain-http origin the browser registers no service
  worker at all, so the settings page will report "unavailable" no matter what
  the backend does.
- **Unblocked by:** Set NTFY_URL to a test topic for that channel; for the rest,
  confirm on the phone that a real waiting/finished transition arrives (not just
  "send test") and that its tap opens the session.
  The subscribe/unsubscribe/key surface has automated coverage
  (`backend/test/push.test.ts`); actual delivery through Apple's push service
  does not.
- **Where:** `backend/src/claude-hooks.ts`, `backend/src/notifier.ts`,
  `backend/src/push-store.ts`, `backend/src/sessions-store.ts`,
  `frontend/src/sw.ts`, `frontend/src/screens/Settings.tsx` (`Notifications`)

## codex and agy support has never run against a signed-in CLI

- **What:** codex and agy sessions now resume (`codex resume --last`,
  `agy --continue`), come back after a restart on their recorded conversation
  (`codex resume <id>`, `agy --conversation <id>`), get the session browser
  (codex through `-c mcp_servers.browser.command`, agy through
  `~/.gemini/config/mcp_config.json`), and agy gets the sandbox note and house
  rules in `~/.gemini/GEMINI.md`. codex also gets the waiting/running state and
  its conversation id from `~/.codex/hooks.json`, written in claude's hook
  shape. All of it was read from each CLI's `--help` and binary on the pod
  (codex-cli 0.155.1, agy 1.2.8) and none of it has run: neither is signed in.
  agy has no status hooks yet; its hooks.json format could not be read from
  the binary.
- **Why deferred:** Nothing can be checked until one of them is signed in.
- **Unblocked by:** Signing codex or agy in on the settings page, starting a
  session, and checking that it starts, turns amber when it asks, writes its
  `.conv` file, reaches the session browser, and comes back after a restart.
  Then agy's hooks, in whatever shape it turns out to read.
- **Where:** `backend/src/claude-hooks.ts` (the codex and agy half),
  `backend/src/session-launch.ts` (`launchAgent`, `restoreSessions`),
  `backend/src/sessions-store.ts` (`RESUME_COMMANDS`, `RESTORE_COMMANDS`),
  `backend/src/sandbox-doc.ts` (`MEMORY_FILES`).

## The antigravity CLI is the one thing in the image with no version to pin

- **What:** claude, codex and the playwright MCP server are pinned in
  `runtime/cli/package.json` and bumped by dependabot. `agy` is not: its
  installer takes no version argument, serves whatever is current, and the
  binary it drops self-updates in the background while a session runs. So
  neither "which version is in the image" nor "which version is running" is a
  question this repo can answer, and a bad release reaches the pod the moment
  it is published.
- **Why deferred:** There is nothing upstream to pin to — no versioned
  installer path, no release artifact with a checksum, and no documented flag
  to hold a version. Working around it means hosting a copy of the binary,
  which is a worse problem than the one it solves.
- **Unblocked by:** Antigravity publishing versioned downloads, or a flag that
  turns the self-updater off — then the same treatment as uv (a versioned
  installer URL and a version assertion after it).
- **Where:** `Dockerfile` (the `agy` block at the end of the `base` stage)

## "Ask before anything irreversible" is an instruction, not enforcement

- **What:** Of the two house rules, "leave no sign an agent wrote this" is now
  enforced: the image installs a commit-msg hook as the system-wide
  `core.hooksPath` that strips agent trailers and footers, and CI rejects what
  gets past. "Ask before anything irreversible" still reaches an
  interactive agent only as an instruction in its global memory file. Unattended
  runs are the exception: `vk-guard` denies rather than asks.
- **Why deferred:** An interactive agent is being watched, and the CLIs' own
  permission prompts are the check on it. Enforcing more would mean a guard on
  interactive sessions too, which asks rather than denies, and which the CLIs'
  own settings already partly do.
- **Unblocked by:** An irreversible action an interactive agent took without
  asking. Then the same PreToolUse hook as unattended runs, in ask mode.
- **Where:** `backend/src/sandbox-doc.ts` (`HOUSE_RULES`), `runtime/vk-guard`,
  `runtime/git-hooks/`

## Nobody has yet judged what the harvest and the learning pass propose

- **What:** The shape guard is in: `transcript-check.ts` reads the newest real
  transcript every day, the way both the chat view and the harvest read it, and
  files an inbox item if either finds nothing (checked against the pod's
  largest transcripts on 2026-09-23: turns, chips, images, a question and a plan
  card, and five kinds of rail all came out). What is left is the judgement: on
  2026-09-23 the queue held 24 proposals, most of them sorting rules from the
  learning pass, and none had been kept or dropped.
- **Why deferred:** Whether a proposal is worth keeping is the person's call,
  and it is the only way to learn whether the harvest's output is useful.
- **Unblocked by:** Going through the queue once (Settings, Memory, or the
  inbox). Keep what is right and drop the rest: a dropped proposal is now
  remembered and not proposed again for 90 days, and the learning pass is shown
  both what is waiting and what was turned down.
- **Where:** `backend/src/memory-store.ts` (`propose`, `dropProposal`),
  `backend/src/assistant-jobs.ts` (`runLearning`, `sortingRules`).

## The assistant's MCP server is hand-rolled JSON-RPC

- **What:** `runtime/verksted-mcp.mjs` implements the three MCP methods it needs
  (initialize, tools/list, tools/call) directly, rather than using
  `@modelcontextprotocol/sdk`. It works against the real CLI, but it is a
  protocol implementation this repo now maintains, and it handles no MCP feature
  beyond tools — no resources, prompts, or notifications.
- **Why deferred:** The SDK would have to resolve from `node_modules` at a path
  that differs between the tsx dev process and the built image, where the server
  is a standalone file baked in next to `vk`. Hand-rolling three methods was the
  smaller problem, but it is a deliberate exception to this repo's
  prefer-a-library rule and should not quietly become the norm.
- **Unblocked by:** Wanting anything beyond tools, or the protocol changing
  under it — either is the point to reach for the SDK and solve the path problem
  properly (a thin wrapper inside the build output, spawned with the same
  runtime the backend is using).
- **Where:** `runtime/verksted-mcp.mjs`, `backend/src/assistant.ts` (`MCP_CONFIG`)

## An unattended turn's notify has never reached a phone

- **What:** The cron half is answered. On 2026-09-14 the pod's schedules had all
  stamped `lastFiredAt` on their cron minute to the millisecond, and the run
  list holds a briefing, a harvest and the session runs every night with nobody
  pressing anything. What is still unexercised is **notify** actually reaching
  the phone from an unattended turn, since an `ok` briefing is meant to stay
  silent and does. Suppression of a repeated push is likewise untested against
  a real device, and is in-memory, so a pod restarting between two firings will
  push a duplicate.
- **Why deferred:** Needs something genuinely worth interrupting for so that
  `notify` is reached on its own judgement.
- **Unblocked by:** A schedule whose prompt says to notify unconditionally, run
  twice inside six hours — the first should arrive on the phone, the second
  should report itself suppressed.
- **Where:** `backend/src/routes/push.ts` (`REPEAT_WINDOW_MS`),
  `backend/src/scheduler.ts` (`briefing`)

## eslint-plugin-jsx-a11y is unmaintained and pinned to ESLint 10 by an override

- **What:** The toolchain runs ESLint 10, but `eslint-plugin-jsx-a11y` declares
  a peer range that stops at ESLint 9 and has not published since October 2024.
  An `overrides` entry in the root `package.json` forces the peer to resolve so
  the install succeeds. The plugin was probed under ESLint 10 and its rules do
  fire correctly (errors and warnings both), so this is a stale declaration
  rather than a real incompatibility — but it is still an unblessed override on
  an abandoned package.
- **Why deferred:** The alternatives are worse today: staying on ESLint 9 holds
  the whole lint toolchain back, and swapping the plugin out is a rules-and-
  config change nobody asked for as part of a dependency bump.
- **Unblocked by:** jsx-a11y publishing a release with an ESLint 10 peer range —
  then delete the `overrides` block. If it stays abandoned through the ESLint 11
  cycle, replace it instead; the config only leans on `flatConfigs.recommended`
  plus six rule overrides, so the surface to port is small.
- **Where:** `package.json` (`overrides`), `eslint.config.js` (the
  `jsx-a11y` block)

## Node major bumps are a manual LTS decision

- **What:** `.github/dependabot.yml` ignores major updates to the `node` image,
  so nothing will propose Node 26 even after it becomes LTS. The image runs
  `node:24-trixie-slim`; 24 is Active LTS until 2026-10-20 and supported to
  2028-04-30.
- **Why deferred:** Dependabot has no notion of which Node releases are LTS. It
  proposed `node:25-slim` three months after 25 went end of life (#26) and
  `node:26-trixie-slim` while 26 was still Current (#46). Ignoring the major is
  what stops a green CI run from walking the pod onto an unsupported runtime.
  The floating `24-trixie-slim` tag still picks up every 24.x security release
  on each build, so this costs nothing between majors.
- **Unblocked by:** 2026-10-28, when Node 26 enters LTS. Move the Dockerfile's
  three `FROM` lines to `node:26-trixie-slim`, check `@types/node` moves to 26
  to match, and confirm node-pty has prebuilds or still compiles for the new
  ABI. Do the same again when 28 enters LTS in October 2028, before 24 goes end
  of life in April 2028.
- **Where:** `.github/dependabot.yml` (the docker `ignore` block), `Dockerfile`
  (the `whisper`, `base` and `build` stages), `backend/package.json`
  (`@types/node`), `.github/workflows/ci.yml` (`node-version`)

## TypeScript is installed twice, on purpose

- **What:** `npm ls typescript` reports two copies: 7.0.2 under
  `backend/node_modules` and `frontend/node_modules`, which is what `tsc` runs
  for the build and the `lint` scripts, and 6.0.3 at the root, which is what
  typescript-eslint's type-aware rules run on. It looks like a resolution bug
  and is not one.
- **Why deferred:** typescript-eslint does not support the native compiler yet,
  and says so at runtime rather than in types alone — forcing a single
  TypeScript 7 with an `overrides` entry makes every lint run die with
  "typescript-eslint does not support TS 7.0". Running TS 6 alongside is
  Microsoft's documented path for exactly this, not a workaround.
- **Unblocked by:** typescript-eslint shipping TS >=7.1 support, tracked
  upstream in typescript-eslint#10940. When it lands, drop the duplicate by
  letting the root resolve to 7.x and confirm `npm ls typescript` reports one
  copy.
- **Where:** `backend/package.json` and `frontend/package.json` (the
  `typescript` devDependency), `package.json` (`overrides`, where a
  `typescript` entry would go and currently must not), `eslint.config.js`
  (`recommendedTypeChecked`, the rules that need the TS 6 API)

## The installed iOS app's status bar in light mode is unchecked

- **What:** `index.html` asks iOS for `black-translucent`, which draws the
  status bar's clock and battery in white over the page. In light mode the page
  under it is the light top bar, so they are likely white on near-white.
- **Why deferred:** It only shows in the home-screen app on an iPhone, which the
  e2e chromium cannot be, and the alternative (`default`) stops the page
  drawing under the status bar, which moves every safe-area inset the layout
  was tuned against. That wants a device, not a guess.
- **Unblocked by:** Opening the installed app in light mode on a phone. If the
  status bar is unreadable, try `default` and re-check the top bar, the
  full-screen terminal and the new-build banner; iOS reads the meta only at
  launch, so a mode change applies from the next start.
- **Where:** `frontend/index.html` (`apple-mobile-web-app-status-bar-style`),
  `frontend/src/theme.css` (the `html` rule's safe-area comment).

## The chair's convening has never been watched against a real model

- **What:** A meeting is triggered by the chair opening its reply with
  `convene: <id>[, <id>]`, which the backend parses and strips. Every test drives
  a fake `claude` that says exactly that, so what is proven is the plumbing —
  who gets spawned, what they are given, what lands in the transcript — and not
  the thing the feature actually rests on: whether a real model reliably emits
  that line when it should, and does not emit it when it should not.
- **Why deferred:** It needs a live authenticated CLI and a person reading the
  answers over a few days. The failure modes are both cheap and visible — a
  meeting that did not happen is an ordinary answer, and one that happened when
  it should not have is a mark in the thread saying who was asked — so this is
  something to watch rather than something to block on.
- **Unblocked by:** A week of real use. Watch for two shapes: convening on
  questions the chair could have answered from `status` (expensive, and the
  persona line about it is the weakest kind of mitigation), and prose before the
  convene line, which makes it not the first line and so convenes nobody. If
  the second shape shows up, the fix is to make `convene`/`discuss` a tool on
  the verksted MCP server rather than a line grammar: a tool call is what a
  model reliably does, the stream parser already lands tool calls on the entry
  (`assistant-stream.ts`, `toolDetail`), and `speak()` would hold the entry on
  the tool rather than on `isConveneLine`. Not done ahead of the evidence: it
  changes every meeting test and the unattended chair too, and trades one
  unwatched behaviour for another (whether the model writes prose after the
  tool result).
- **Where:** `backend/src/assistant-persona.ts` (`councilBlock`),
  `backend/src/assistant.ts` (`CONVENE_RE`, `runChair`)

## Still outside the maintainer

- **What:** Three things the plan named and left out on purpose. cargo and go
  are not in the image, so ruter-cli's tests cannot run on the pod and it
  cannot join. The maintainer has no GitHub identity of its own: its reviews
  are the owner's, so GitHub does not count a gate approval and the ruleset
  cannot require one. And the contract's no-go paths are prose the prompts
  obey rather than paths the guard denies.
- **Why deferred:** Each is a decision rather than a gap: a toolchain in the
  image, a second account, and a parser for the contract in a shell script.
- **Unblocked by:** Wanting ruter-cli on the queue (add rustup to the
  Dockerfile's base stage); wanting a required review on the ruleset (a machine
  user with its own token in the pod's settings); the contract format settling
  (then `vk-guard` reads its no-go list and denies edits there mechanically).
- **Where:** `Dockerfile`, `backend/src/settings-store.ts` (`KNOWN_AGENT_KEYS`),
  `runtime/vk-guard`, `backend/src/maintainer.ts` (`readContract`)

## A sent mail cannot be put back, and a removed label only onto 500 messages

- **What:** A tapped card is a line of the tool log (`card:<kind>`), and a
  removed calendar event, mail moved to the trash or spam, a removed Gmail
  filter and a removed label are put back from that row. A sent mail cannot be
  unsent. A label is put back only on the first 500 messages that carried it
  (one page of Gmail's listing); the undo says so when there were more.
- **Why deferred:** Nothing takes a sent mail back. Keeping more than one page
  of ids per card was not needed for the labels this account has.
- **Unblocked by:** Deleting a label that carried more than 500 messages. Then
  page through `labelled` and store the ids beside the log rather than in it.
- **Where:** `backend/src/gmail.ts` (`labelled`, `restoreLabel`),
  `backend/src/routes/proposals.ts` (`snapshot`), `backend/src/undo.ts`.

## Where the backups go offsite is not written down

- **What:** O-03 in the audit. The restore itself has been rehearsed (RUNBOOK.md,
  2026-09-23). What is left is that the backup target is a share on the same NAS
  as the PVC, so one NAS failure takes both, and whether that NAS copies
  anywhere else is not recorded here.
- **Why deferred:** It is the NAS's configuration, not this repo's.
- **Unblocked by:** Looking at the NAS's own backup tasks (Hyper Backup or a
  cloud sync) and writing one sentence in RUNBOOK.md on where the copy goes, or
  setting one up.
- **Where:** `RUNBOOK.md` ("Restore from a backup"), Homelab's NAS configuration.

## The pod's backups are written unencrypted

- **What:** O-04 in the audit. `VK_BACKUP_PASSPHRASE` encrypts every archive,
  and the Deployment does not set it, so the archives on the shared NAS share
  hold every token, private key and OAuth login in cleartext.
- **Why deferred:** The fix is in the Homelab repo, which is public, so the
  passphrase belongs in a Secret the Deployment references, not in the
  manifest; and whoever sets it has to keep a copy somewhere other than the
  volume, or the archives become unreadable exactly when they are needed.
- **Unblocked by:** A Secret with the passphrase, `VK_BACKUP_PASSPHRASE` from it
  in `k8s/talos/apps/verksted/deployment.yaml`, and the passphrase in a password
  manager. Existing cleartext archives age out after `VK_BACKUP_KEEP` nights.
- **Where:** Homelab `k8s/talos/apps/verksted/deployment.yaml`; this repo
  `runtime/vk`, `.env.example`.

## Privilege separation on the pod

- **What:** Root cause 1 in the audit, and O-08. The code is in: with
  `VK_AGENT_USER=vk-agent` sessions, their agents, git, gh and every chromium
  run as uid 1001, the backend refuses that uid's requests but for a
  session's own few routes (`agent-gate.ts`), and the first boot hands the
  repos and HOME to it and closes the backend's stores. It is off until the
  pod sets the variable, and the pod still runs as root with no
  `securityContext`, no NetworkPolicy, and a dind sidecar that is node-root
  equivalent whatever the users are.
- **What it closes once on:** a session, an unattended run and the
  assistant's chromium reaching the API over loopback or a pod address (the
  far half of S-04(b), and A-01's second half); credentials on the tmux
  command line (S-03) become values the only other user on the pod already
  holds. What stays open until the egress NetworkPolicy exists is the ingress
  hostname: a request through it arrives from outside the pod and looks like
  the browser's.
- **Why deferred:** Tried on 2026-09-22 (Homelab #1112, off again in #1115).
  The first boot's `chown -R` finished (5.5 minutes, which needed the
  startupProbe from #1114), but git and gh as uid 1001 were then refused
  everywhere: `/data/repos` is `drwxrwxrwx 1001:1001` and
  `runuser -u vk-agent -- ls /data/repos` still says Permission denied. The PVC
  is Synology NFS (`syno-nfs-csi`), and the share decides access for non-root
  uids by its own permissions; root is not squashed, which is the only reason
  the backend works. Turned off, the boot now takes the repos and HOME back
  (`takeBack` in agent-setup.ts): left owned by 1001, git refused every one of
  them as root. The `securityContext` (no privilege escalation, RuntimeDefault
  seccomp) is on.
- **Unblocked by:** The NAS share `k8s-volumes` granting uid 1001: its NFS rule
  or its shared folder permissions. Check it from the pod with
  `runuser -u vk-agent -- ls /data/repos` before setting `VK_AGENT_USER` again,
  then the session, terminal, session browser and `vk feedback` checks, then
  an egress NetworkPolicy.
- **Where:** `backend/src/agent-user.ts`, `agent-gate.ts`, `agent-setup.ts`,
  `Dockerfile`; Homelab `k8s/talos/apps/verksted/deployment.yaml`.

## The audit's partials that need a design, not a fix

- **What:** What Part 10 of `FABLE-AUDIT-2026-09-19.md` still lists as partial
  once the pod-only items are set aside. A-27: thread search and the thread
  list parse every thread file (the cache holds four, on purpose). A-28:
  `assistant.ts` is still about 1900 lines, and holding a convene reply then
  closing the meeting is written twice (`runChair`, `unattendedTurn`), with
  real differences between the two. A-31: speech to text is English only, no
  injection regression suite against a real model, no server-side thread
  compaction. P7-5: no metrics endpoint (event-loop lag, exec and timer
  failures, queue depths). P7-3: no one `JsonDirStore`, and records carry no
  version. R-35: the `start*` functions return no stop handle.
- **Why deferred:** Each is a choice rather than a gap: a thread index, a
  split of the assistant module, a second speech model, a metrics surface, a
  store abstraction. None of them is causing a problem
  today.
- **Unblocked by:** Deciding to want one. A-27 when thread search gets slow
  in practice; P7-5 when something needs watching that the logs do not show;
  A-28 before the next change to how meetings close.
- **Where:** `backend/src/assistant.ts`, `transcribe.ts`, `atomic-json.ts`,
  `maintenance.ts`, `pollers.ts`, `app.ts`.
