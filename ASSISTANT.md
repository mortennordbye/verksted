# The assistant

**Status: M1 and M2 are built and work; M3–M4 are proposed.** The chat, the
headless runtime behind it, the thread store, and explicit memory all exist and
are verified end to end. What is not built is the part that learns _without
being asked_ — the harvester and its review queue — and the MCP server that
would narrow what the assistant may do. Both are in `BACKLOG.md`.

The scoping gap matters and is not theoretical: the assistant runs on claude's
default toolset with `--permission-mode auto`, plus write access to the memory
directory.

## What it is

A resident agent session that belongs to no project, can act on verksted itself,
and accumulates what it learns about how you work so the other agents stop
asking twice.

Two halves, useful separately:

- **The assistant** — one long-lived session, reachable in two taps from the hub,
  that can read the inbox, start sessions, open issues and answer questions
  about the state of the pod.
- **Memory** — a small, reviewed, plain-text store of durable facts, injected
  into every agent session through the mechanisms that already carry the sandbox
  note.

## What this is not

It does not make any model smarter. There is no fine-tuning and no training. It
makes agents better-informed and better-aimed, and the day-to-day value is that
you stop repeating yourself. Saying otherwise would set the wrong expectation
about what a bad answer means: it will mean a missing or wrong fact, and it will
be fixable by editing a file.

## Why the pieces are cheap

Most of what this needs is already here:

| Need                             | Already in the repo                                     |
| -------------------------------- | ------------------------------------------------------- |
| A session that survives restarts | `restoreSessions` + the recorded conversation id        |
| Acting on verksted               | the REST API, on localhost inside the pod               |
| Giving an agent tools            | `ensureMcpConfig` — the browser MCP is the pattern      |
| Injecting knowledge globally     | `sandbox-doc.ts` marker blocks in `~/.claude/CLAUDE.md` |
| Injecting knowledge per project  | `.verksted/context.md`                                  |
| Recurring background work        | the scheduler and the `ok:/attention:/failed:` contract |
| A place to review things         | the inbox screen                                        |
| Raw material to learn from       | Claude Code transcripts under `$HOME`, i.e. on the PVC  |

That last one is the load-bearing discovery. Claude Code writes each
conversation to `$HOME/.claude/projects/<path-slug>/<conversation-id>.jsonl`,
`HOME` is `/data/home`, and `sessions-store.ts` already records each session's
conversation id in `<id>.conv`. The join from a finished session to its full
transcript therefore exists today and needs no new plumbing.

## The chat surface

**Decided: a real chat.** `SPEC.md`'s "No chat UI. The terminal is the interface
to the agents" needs narrowing rather than deleting — it stays true and stays
load-bearing for project sessions, where the CLIs render their own UI and tmux
owns persistence, and that is still the reason verksted is small. It stops
being a rule about the assistant.

### Why chat changes the runtime, not just the screen

The cheap route — render `/capture` as message bubbles — does not work. The
claude CLI is a full-screen TUI: alternate screen, ANSI, spinners, constant
repaints. That byte stream has no message boundaries to split on, only frames of
a canvas being redrawn. Anything built on scraping it would look approximately
right for a week and break on the next CLI release.

So the assistant does not run in tmux. It runs headless, as a process the
backend owns:

- `claude -p --output-format stream-json --resume <id>`, or the Agent SDK
- events streamed to the browser over the websocket that already exists
- messages persisted as JSONL on the data volume, one file per conversation

That is what buys an actual chat: turns with real boundaries, streaming tokens,
tool calls drawn as chips instead of terminal noise, and a stop button that
means something.

### The terminal escape hatch survives

Verksted mints the conversation id and passes it in with `--session-id`, so it
owns the thread's identity from the first turn rather than parsing it back out.
Headless claude then records the conversation under `$HOME` in the same place
the TUI reads from — confirmed:
`/data/home/.claude/projects/-data-repos/<id>.jsonl`, keyed by the working
directory the run started in.

So `claude --resume <id>` in a terminal lands on exactly the thread you were
chatting to. The button is not built yet, because the assistant belongs to no
project and every session id is `vk-<project>-<seq>`; that is a session-model
question, not a missing endpoint. See the backlog.

### What it costs

This is the largest piece of M1 and the only part of this plan that adds a
genuinely new runtime path to the backend — a managed agent process, a message
store, and a stream. Everything downstream of it (memory, review, injection) is
unaffected and stays as described below.

## The learning loop

```
capture  ->  review  ->  store  ->  inject  ->  compact
```

### Capture

Three sources, in increasing order of ambition. Build them in this order.

- **Explicit.** "Remember that ..." The assistant writes a fact. Unglamorous,
  exact, and the only source that needs no judgement.
- **Harvest.** A nightly schedule reads the transcripts of sessions that ended
  that day and proposes durable facts. This is where learning-without-effort
  comes from, and it is the source that makes the review gate mandatory.
- **Outcome.** Schedule reports (`ok` / `attention` / `failed`) and whether a PR
  was merged or closed. Ground truth about whether work was any good, already
  recorded, currently unused.

### Review

**Not built yet, and it is the gap that matters most.** Explicit memory needs no
queue, because you were in the conversation when the fact was written — the
assistant is instructed to say what it is about to record and ask first, and
that is the whole review at this milestone. Harvesting has no such moment, so it
must not ship before this does.

The design: proposed facts land in a queue on the inbox screen and become memory
only when kept.

This gate is not optional and not a nicety. Unreviewed automatic memory poisons
itself: one wrong fact silently degrades every later session, and nothing in a
bad answer points back at the fact that caused it. It is also the only real
defence once a harvester starts reading repo content and PR text that you did
not write — a prompt-injection payload in a dependency's changelog is otherwise
one hop from being permanent context in every session.

Cheap to build now. Expensive to retrofit after the first bad memory.

### Store

One fact per file in `MEMORY_DIR`, with frontmatter carrying its type
(preference, project, reference), its scope (global or a project name), and its
provenance.

That is the shape Claude Code's own memory directory uses, and it is worth
copying rather than reinventing: one file per fact makes a bad one deletable
without a migration, and provenance is what makes "why does it think that?"
answerable.

### Inject

Through the marker-block mechanism `sandbox-doc.ts` already implements, into
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. Text outside the markers stays
yours, exactly as it does for the sandbox note, and the block disappears
entirely when the last fact is forgotten.

**Everything goes into the global file, including project-scoped facts**, which
is a deliberate departure from the original plan here. `.verksted/context.md` is
only read for prompted runs, so project facts put there would never reach an
interactive session; and the other candidate — a repo's own `CLAUDE.md` — is a
committed file, which is no place for verksted's guesses about you. Labelling
the scope inline (`In Homelab: …`) costs a few words and reaches everything.

### How a fact gets written

The assistant writes the file itself, with the ordinary Write tool, told where
and in what shape by an appended system prompt and given access with
`--add-dir`. No tool of ours in between: the store is meant to be plain text a
person can edit in a terminal, and a protocol would take that away and buy
nothing.

The backend never trusts the shape. Frontmatter is parsed forgivingly — a
missing field costs that field, not the fact — and `created` falls back to the
file's mtime, because the agent leaves it off as often as not and both the
ordering and the budget's eviction depend on having one.

### Compact

A weekly scheduled run merges duplicates, drops facts contradicted by newer
ones, and holds the whole store under a byte budget.

Deliberately **not** embeddings and a vector store. Keeping memory small enough
to inject wholesale is what keeps a database out of this repo, and it degrades
in a way you can see — a full budget is a prompt to prune, not a silent drop in
retrieval quality. If it ever genuinely outgrows a byte budget, retrieval is a
later problem to solve with evidence.

## Milestones

Each is independently useful; stopping after any of them leaves something that
works.

- **M1 — the assistant.** ✅ except the MCP server and the terminal escape
  hatch. The headless agent runtime, the message store and stream, and the chat
  screen. No learning yet, and already useful as a layer over the other
  agents.
- **M2 — explicit memory.** ✅ The store, remember/forget, and injection. The
  first point at which it stops re-asking things.
- **M3 — harvest and review.** The nightly transcript pass and the inbox queue.
- **M4 — outcomes and compaction.** Learning from what worked, and staying small.

## Risks to decide before M1

- **An agent that starts agents.** `MAX_LIVE_SESSIONS` already caps this for
  schedules; the assistant must go through the same ceiling rather than get its
  own.
- **It inherits full pod access**, including `gh` with push rights. Whether the
  assistant runs more narrowly scoped than a project session is a decision, and
  the honest default is that it should — it acts with less of your attention on
  it than any other session.
- **Context cost.** Every kept fact is carried into every session. Bounded, but
  it is the reason the budget is a number and not a intention.

## Design reference

The four screens are mocked in verksted's own palette, in the same spirit as
`mock.html`: the hub strip, the assistant screen, the inbox review queue and the
memory list.
