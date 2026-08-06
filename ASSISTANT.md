# The assistant

**Status: M1 and M2 are built and work; M3–M4 are proposed.** The chat, the
headless runtime behind it, the thread store, explicit memory, and the tools the
assistant acts through all exist and are verified end to end. What is not built
is the part that learns _without being asked_ — the harvester and its review
queue. Both are in `BACKLOG.md`, in that order, and the order matters.

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

Through the `remember` tool, which is the same validated endpoint the settings
page uses. An earlier version had the assistant write the file directly with the
Write tool; that went when Write did, and it was the right trade — the store is
still plain markdown you can edit in a terminal, only the write path is
validated now, and it gives the review queue somewhere obvious to sit.

The backend never trusts the shape it reads back, because a person editing these
by hand is a supported thing to do. Frontmatter is parsed forgivingly — a
missing field costs that field, not the fact — and `created` falls back to the
file's mtime, because it is the field most likely to be left off and both the
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

## What the assistant may do

Its tools are **Read, Grep, Glob, and the verksted MCP server** — nothing else.
Bash, Edit, Write, the web tools and Task are denied outright, and
`--strict-mcp-config` keeps it to the one server declared here.

That last flag is load-bearing rather than tidy. Without it, the MCP servers
connected to the _Claude account_ join the ones configured here — a Google Drive
connector turned up in a live test and the assistant offered it — and since the
allow list only auto-approves, an unlisted server's tools are still a
classifier's call. Repo read access plus somebody's cloud storage is the same
exfiltration shape the web tools were denied for.

That is a narrower answer than this document originally proposed ("may merge,
but not push to main"), and the reason is a reframe rather than a tightening.
The question is not what permissions it should hold but what kind of thing it
is: its job is to know what is going on and to start work, and none of that
needs a shell. Where something must change, it calls `start_session` and the
work happens in a tmux session with a terminal you can attach to, a status chip
and a report — instead of inside a chat bubble with no trail.

**The assistant delegates; it does not execute.**

Three things follow from that, all of which matter more than the permission
itself:

- Denying is the half that works. An allow list is auto-approval, not
  restriction: a tool left off it still exists and, under
  `--permission-mode auto`, is still a classifier's call. So the tools worth
  regretting are named in `--disallowed-tools`.
- A Bash deny list would not have held. `git push` is also `git -C x push`, a
  script, `sh -c "…"`. A tool allow list is a property you can state; a command
  pattern list is a thing you maintain forever and trust anyway.
- No web tools. Read access to repos containing `.env` files, plus fetch, is how
  a prompt injection becomes exfiltration — and the harvester this is being
  built towards will eventually read text neither of us wrote.

This is not a security boundary, and it should not be described as one. Anyone
on the tunnel can open a terminal session and do anything; the pod is
deliberately wide open. What this limits is the blast radius of the assistant
being _wrong_, which is a likelier failure than someone attacking you. The worst
case becomes a bad memory (visible, deletable) or a spurious session (visible,
killable, already capped by `MAX_LIVE_SESSIONS`) rather than a force-push.

The cost is real: it cannot fix a typo for you without starting a session. That
is the right trade while it is young, and loosening later is a one-line change —
much easier than tightening after habits have formed around it doing the work.

## Personality, and what it costs

The voice lives in `assistant-persona.ts`, apart from the runtime, because it is
the file worth editing when the assistant says something annoying and nothing
there should require understanding how a process is spawned.

It is asked to be brief and dry, to lead with what is wrong, to have opinions
and give them unprompted, and to skip the whole apparatus of assistant-speak:
no opening pleasantry, no announcing what it is about to do, no summarising what
it just did, no closing offer of further help, no emoji, no em dashes. The
failure mode being designed against is not being wrong, it is being long — this
is read one-handed on a phone by someone in the middle of something else.

Every line of it is re-sent with every turn, so the persona is on a budget too:
lines that only described it have been cut, and what is left either changes what
it does or how it sounds.

## Memory is editable by hand

The settings page lists every fact with its type, scope and provenance, and lets
you add, correct or forget any of them. That is not a convenience: a memory you
can only change by arguing with a chatbot is one you will not fix, and
correcting a wrong fact is exactly the moment you least want a conversation.
Editing keeps the slug, since the slug is the filename and renaming would leave
the old fact sitting alongside its correction.

## Images and dictation

An image is uploaded first and sent by name; the server chooses where it lands,
so nothing the client says can point anywhere else. The agent then reads it off
disk with its own Read tool from a directory granted with `--add-dir`, which is
why an attachment needs no new way of getting bytes into a prompt. Paste works
on a desktop, the button works on a phone.

Dictation uses the browser's own recogniser and the button only appears where it
exists. On iOS it does not, and none is needed: the keyboard's mic types into
the field the same way.

## Defining it from the settings page

Name, model, effort and standing orders are editable in the app and persist on
the volume, so the thing you tune most often is not a redeploy. A name matters
more than it sounds: without one it answers "Claude" when asked what it is
called, which is the model's name and not this agent's.

Standing orders go last in the prompt, after everything the code says, so they
win by being the most recent instruction. They are also carried with every turn,
which is why the field is capped at about a screenful.

## Keeping it off the usage meter

The assistant summarises state and hands the real work to sessions, so it runs
lean: `sonnet` at `low` effort, overridable from the settings page and, as a
floor, by `ASSISTANT_MODEL` and `ASSISTANT_EFFORT`.

It ran on `haiku` first and moved back up on evidence. Haiku escalated where
sonnet diagnosed — asked for bash to inspect a broken image rather than reading
the error it had already been given — and leaked the closing pleasantries the
persona bans. The saving was not worth it once the round-trip work had landed:
collapsing three lookups into one `status` call cut a turn from nine round trips
to two, and that win is model-independent. This agent is a handful of short
turns a day; the subscription goes on the sessions doing the engineering.

The bigger lever turned out not to be tokens per call. **Every tool call is
another model invocation carrying the entire conversation with it**, so the cost
of a turn tracks round trips, not verbosity. Answering "what needs me today"
used to take four calls across three separate lookups; a single `status` tool
that returns the projects, the live sessions, what recently finished and the
scheduled runs brought the same question down to one. Measured on the same
prompt against the real CLI: **nine tool calls and 31s, down to two and 8.5s.**

Two smaller ones, both compounding:

- Tool results are not read once and dropped. They stay in the conversation and
  are re-sent with every later turn, so pretty-printed JSON of every field is
  paid for repeatedly. Each tool now answers in the fewest lines that still
  carry the decision.
- A long thread re-sends its whole history every turn. Nothing truncates it
  automatically, because silently dropping the middle of a conversation is worse
  than saying it is getting long, so the chat shows the turn count and offers a
  new thread once it passes fifteen.

What is _not_ solved: resuming a conversation re-sends it, and that is inherent.
Prompt caching absorbs most of it, and beyond that the honest answer is to start
a new thread when the subject changes.

The thing to watch before economising further: the assistant's hardest job is
writing the prompt for a session it starts, and a vague prompt wastes a whole
session, which costs more than every assistant turn in a day. If delegation
starts arriving underspecified, raise the model before the effort.
