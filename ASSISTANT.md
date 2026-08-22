# The assistant

**Status: M1–M3 are built and work; M4 is proposed. The assistant and the
council are two rooms now — see "The council" below.** The chat, the headless
runtime behind it, the thread store, explicit memory, recall over old threads,
the tools the assistant acts through, a schedule that runs it with nobody
watching, and the learning loop — review queue first, then the nightly harvest —
all exist and are verified end to end. What is left is M4: learning from whether
work turned out well, and compacting the store as it fills.

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
- **Harvest.** A nightly schedule reads back what you typed into the sessions
  that ended that day and proposes durable facts. This is where
  learning-without-effort comes from, and it is the source that makes the review
  gate mandatory. See below: what it may read is the whole design.
- **Outcome.** Schedule reports (`ok` / `attention` / `failed`) and whether a PR
  was merged or closed. Ground truth about whether work was any good, already
  recorded, currently unused.

#### The harvest reads only what you typed

One decision carries this whole feature, and it is doing two jobs at once.

A coding session's transcript is megabytes — file reads, diffs, whole test runs
— and feeding one to a model nightly would cost more than everything else here
put together. What a person types is a few hundred bytes a session, so a night's
harvest is a few kilobytes and **one tool call**, not one per session. That is
the cost control, and it is why this is affordable to leave on.

It is also the injection defence. The stated fear about harvesting was that a
payload in a dependency's changelog becomes permanent context in every session.
Text like that arrives in tool _results_; it is never something you typed.
Claude Code tags each entry with its origin, so this is a property of the record
rather than a guess: `origin.kind === "human"` with string content is the person
at the keyboard, and a tool result is `type: "user"` with structured content and
no such origin. Both halves are required — the origin check separates a person
from a tool result wearing the user role, the string check separates typed words
from attachments.

That does not make harvesting safe on its own, and it is not claimed to. The
review queue is what does that. What this means is that the text being
summarised is text you wrote yourself.

The harvester itself is not a new runtime path: it is an **assistant schedule**
with a careful prompt, using two tools that only exist unattended-safe —
`recent_prompts` to read the material and `propose_memory` to queue a fact.
It appears on the schedules list, its runs land in the inbox, and it can be
paused, retimed or rewritten like anything else. Set it up from the memory panel
on the settings page; the button exists because the prompt is the part worth
getting right, not because the schedule is special.

Its prompt says the null answer is the usual one. Most days there is nothing
worth keeping, and a harvest that proposes nothing costs two round trips on
`sonnet` at `low`.

### Review

Proposed facts land in a queue on the inbox screen and become memory only when
kept. Explicit memory skips it, because you were in the conversation when the
fact was written; harvesting has no such moment, which is why the queue was
built first and the harvester second.

This gate is not optional and not a nicety. Unreviewed automatic memory poisons
itself: one wrong fact silently degrades every later session, and nothing in a
bad answer points back at the fact that caused it.

**A separate directory, not a `status: proposed` field.** That was the open
question and the directory wins. A field keeps one store but makes every reader
responsible for filtering, and one reader that forgets puts an unreviewed fact
into every session in every repo. `MEMORY_DIR/proposed/` has nothing to forget:
`list()` reads `*.md` at the top level and a subdirectory is not one. The test
that matters asserts exactly this — a proposal is absent from the injected block
until it is kept.

The queue is keyed by slug, so a harvest that runs twice over the same day
replaces its own proposal instead of stacking duplicates, and proposing
something already remembered is refused rather than queued.

**A proposal is the one thing in the inbox that arrives with nothing to announce
it.** A blocked session pushes the phone; a scheduled run writes a report. A
harvested memory appears at 03:00 with neither, so without a count on the inbox
icon the loop simply stalls at the review step and the harvest may as well not
have run. The count sits on the icon in every screen's top bar and in the
inbox's own headline. It is polled every two minutes, because it changes once a
night.

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

The block is in two halves, and the order is the point. Who this person is and
how they want things done comes first, because it is what an agent should read
before it decides how to answer anything; what verksted has learned about the
work — repo mechanics, references — is material to use and sits underneath.
Hermes-style, where a `USER.md` is a separate file from a `MEMORY.md`; the same
split, in one block, since one block is what the marker mechanism carries. A
flat list of facts is not the same thing as knowing somebody, and the difference
costs two lines.

The headings are reserved against the byte budget before any fact is fitted,
rather than added afterwards. Otherwise a full store overshoots by the size of
its own headings and the number reported on the settings page is a number that
lies.

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
- **M2.5 — it reaches you, and it remembers the thread.** ✅ The unattended
  turn, its narrowed tool set and its notification suppression; recall over old
  conversations; the user model at the top of the injected block. Not a
  milestone in the original plan: this is the half of "personal" that is about
  being reached rather than about being told.
- **M3 — harvest and review.** ✅ The review queue on the inbox, and the nightly
  pass over what you typed into finished sessions. The point at which it starts
  learning without being asked.
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

Its tools are **Read, Grep, Glob, WebFetch, WebSearch, and the verksted MCP
server** — nothing else. Bash, Edit, Write and Task are denied outright, and
`--strict-mcp-config` keeps it to the one server declared here.

WebSearch is documented US-only, so from a pod that does not egress there it may
come back empty; WebFetch has no such limit, and pointing the assistant at a URL
is the path to rely on. Neither renders JavaScript — a page is fetched and
converted to markdown, so a site that draws itself client-side yields little. If
that turns out to matter, the session browser in `browser.ts` already runs a real
Chromium and could be exposed as an MCP tool.

That last flag is load-bearing rather than tidy. Without it, the MCP servers
connected to the _Claude account_ join the ones configured here — a Google Drive
connector turned up in a live test and the assistant offered it — and since the
allow list only auto-approves, an unlisted server's tools are still a
classifier's call. Repo read access plus somebody's cloud storage is the shape
worth refusing.

That is a narrower answer than this document originally proposed ("may merge,
but not push to main"), and the reason is a reframe rather than a tightening.
The question is not what permissions it should hold but what kind of thing it
is: its job is to know what is going on and to start work, and none of that
needs a shell. Where something must change, it calls `start_session` and the
work happens in a tmux session with a terminal you can attach to, a status chip
and a report — instead of inside a chat bubble with no trail.

**The assistant delegates; it does not execute.**

Two tools were added later. `notify` pushes a line to the phone through
`POST /api/push/send`, which is the same pair of channels the session notifier
uses (ntfy and web push) and vets the tap target down to a path inside this app
— a notification renders somewhere the app does not control, so an absolute URL
in one is a phishing link wearing verksted's name. It was half a feature until
the unattended turn below existed, because nothing ran the assistant except a
person typing at it, and pushing to somebody already reading the reply is not
worth a tool. `repo_diff` is read-only and needs no such apology: `repo_status`
says which files moved, and this says what moved in them.

Three things follow from that, all of which matter more than the permission
itself:

- Denying is the half that works. An allow list is auto-approval, not
  restriction: a tool left off it still exists and, under
  `--permission-mode auto`, is still a classifier's call. So the tools worth
  regretting are named in `--disallowed-tools`.
- A Bash deny list would not have held. `git push` is also `git -C x push`, a
  script, `sh -c "…"`. A tool allow list is a property you can state; a command
  pattern list is a thing you maintain forever and trust anyway.
- The web tools are the one place this was loosened, and knowingly. They were
  denied because read access to repos containing `.env` files, plus fetch, is
  how a prompt injection becomes exfiltration — and the harvester this is being
  built towards will eventually read text neither of us wrote. That reasoning
  did not stop being true; looking things up simply turned out to be part of the
  job, and delegating a lookup to a whole session was the wrong shape. What the
  deny list still holds is the half that matters: a page that talks the
  assistant into something cannot get it to run anything, because it has no
  shell and no writes. The prompt tells it to treat a fetched page the way it
  treats a PR body — as text it reports on, never as instructions — which is a
  mitigation, not a defence. Attaching a repo secret to an outbound URL is
  possible today and nothing here would catch it.

This is not a security boundary, and it should not be described as one. Anyone
on the tunnel can open a terminal session and do anything; the pod is
deliberately wide open. What this limits is the blast radius of the assistant
being _wrong_, which is a likelier failure than someone attacking you. The worst
case becomes a bad memory (visible, deletable) or a spurious session (visible,
killable, already capped by `MAX_LIVE_SESSIONS`) rather than a force-push.

The cost is real: it cannot fix a typo for you without starting a session. That
is the right trade while it is young, and loosening later is a one-line change —
much easier than tightening after habits have formed around it doing the work.

## The turn nobody asked for

Until this existed the assistant was something you opened. A schedule can now
run it instead of starting a session — `kind: "assistant"` on a schedule, no
project, and on its cron it answers a standing question and pushes your phone if
the answer needs you. That is the difference between a chat box and something
that tells you main went red while you were asleep.

Four decisions, each of which was blocking it:

- **A fresh conversation every run.** Sharing the chat would mutate a thread you
  are reading and re-send it every morning; one thread per schedule would grow
  without bound, because every turn carries the whole history with it. A
  briefing is a standing question with no yesterday in it, so it costs exactly
  one prompt. The thread still lands on the volume under its own id, so
  `claude --resume <id>` opens precisely what ran.
- **It runs beside the chat, not in front of it.** Its own guard: a schedule
  firing while you are typing does not refuse you and is not refused. At most
  one of each.
- **It can read and notify, and nothing else.** Not "is discouraged from" —
  cannot. The built-in set drops to Read, Grep and Glob, and the verksted tools
  are cut in the MCP server itself under `VK_UNATTENDED`, so `start_session`,
  `merge_pr`, `remember` and the rest are absent from `tools/list` rather than
  merely left off an allow list. That distinction is the whole reason it is done
  there: under `--permission-mode auto` an unlisted tool still exists and is
  still a classifier's call, and a tool that was never offered is not.
- **The web goes too**, which is the one that is a real loss. Fetching a page is
  the exfiltration half of a prompt injection, and the only thing between the
  two today is that a person is reading the reply — which is exactly what this
  run does not have. A briefing reads the bench, and the bench is local.

`remember` is denied here for a reason worth stating separately: a turn nobody
watched writing a permanent fact into every future session is the poisoning case
the review queue was designed to catch, and the review queue is not built. When
it is, this is the flag to revisit first.

**What stops a broken schedule pushing the same line every hour.** Nothing in
the prompt could, because a fresh conversation cannot remember what the last one
sent. So `POST /api/push/send` drops a notification identical to one sent in the
last six hours and says so in the tool's result. Six hours is long enough that a
standing problem interrupts once a morning and short enough that something still
broken tomorrow says so again. It is in memory: a restart losing it costs one
duplicate push, and a file on the volume for it would be state this app
otherwise does not keep.

The reply lands in the inbox either way, coloured by the same `ok:` /
`attention:` / `failed:` sign-off every scheduled session is asked for — so
silence is free, and `notify` is reserved for what should interrupt you now.

## What it costs on a quiet day

Three guards, because a thing that runs on a timer forever is a thing that has
to be cheap when there is nothing to do.

**A quiet day costs nothing at all.** The harvest is created with
`skipWhenIdle`, and a schedule with that set does not run on a day when no
session ended. Checked before the process is spawned, not inside the turn — the
point is not to make the model call — and beside the pause switch rather than in
`runSchedule`, so pressing "run now" is still somebody asking and runs anyway.
A weekend costs zero.

**A working day costs about two model calls.** The harvest is one tool call
(`recent_prompts` covers every session at once, so there is no per-session round
trip) and one answer, on `sonnet` at `low`, over a payload of a few kilobytes.
That is a structural claim about the shape of the turn rather than a measured
one: what is measured is that the material is a few kilobytes, because only
typed words go into it.

**Nothing can run away.** Twelve unattended turns a day, across every schedule,
then it refuses and records why. The session ceiling does not bind these — a
briefing holds no tmux and no working tree — so without this a schedule saved as
`* * * * *` would quietly make 1440 model calls a day and nothing would notice.
Normal use is three or four. It is in memory and a restart resets it, which is
the right trade for a backstop against a loop inside one day.

The thing that would actually cost real money is unchanged and worth restating:
the assistant's hardest job is writing the prompt for a session it starts, and a
vague prompt wastes a whole session, which costs more than every assistant turn
in a week.

## Two rules the agents here are given

Not the assistant — the agents that do the work, in every repo, including ones
verksted has never seen. They go into the same global memory file as the sandbox
note, under their own marker, for the same reason: they are true of this bench
rather than of any repo, and a committed `CLAUDE.md` is no place for one
person's house style. A repo cloned tomorrow is covered without anyone
remembering.

**Claude and codex, not antigravity.** `MEMORY_FILES` is
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, because those are the two global
instruction files that have been confirmed; agy's equivalent is unverified, so
an antigravity session gets neither these rules nor the sandbox note. That was
already a backlog entry about the sandbox note, and it costs more now — an agy
session is the one place on this bench where "no attribution" and "ask before
anything irreversible" are not said at all.

**Leave no sign that an agent wrote anything.** Every agent CLI here signs its
own work by default — a `Co-Authored-By` trailer on commits, a "Generated with"
footer on pull requests — and git history is not something you can quietly
correct later. The rule covers everything that persists: commit messages, branch
names, PR titles and bodies, issue and review comments, code comments. Verksted
writes no such thing itself, and never did; this is what stops the agents doing
it.

**Ask before anything that cannot be undone.** Force-pushing, rewriting pushed
history, deleting a branch or tag or release, discarding uncommitted work,
dropping a database or a volume, `rm -rf` outside a build directory. Committing,
pushing a new branch and opening a pull request are explicitly ordinary and need
no permission — without that half, an agent that asks about every commit is
useless in exactly the unattended runs this is written for.

Asking is not a dead end at 03:00. A scheduled session runs in auto permission
mode precisely so routine calls go through unattended; a question turns the
session amber, pushes the phone, and leaves the work waiting rather than guessed
at. That mechanism already existed — this is what points it at the right things.

The assistant itself is a weaker case and needs no rule: it has no shell, no
Edit and no Write, so the only irreversible things in its reach are `merge_pr`,
ending a live session and deleting a schedule, and the persona already requires
it to ask before each.

## Recall

Every conversation ever started is on the volume, and until now the only way
back into one was to know its id. `recall` searches them: all words must appear,
newest first, and the current conversation is skipped because it is already in
the context and a hit there would spend a result on something it can reach by
scrolling up.

This is what makes "start a new thread when the subject changes" — the honest
answer to context cost, above — survivable. A new thread is not a new
relationship, and the persona says so in those words.

Substring matching, no index. The store is a few hundred kilobytes of text on a
volume this pod owns; anything cleverer is a database, which is the thing this
app is built not to have.

**Unattended threads are not searched, and are not even in the directory.** A
briefing and a harvest are conversations too, and between them they would add
some seven hundred threads a year, all of them the machine talking to itself.
They go in a subdirectory, which is the same trick the review queue uses: the
search reads `*.jsonl` at the top level and a subdirectory is not one, so there
is no filter to forget. Without it recall would fill with "ok: nothing needs
you", and — since every file is read on every call — get slower forever. Claude
keeps its own copy under `$HOME` regardless, so `claude --resume <id>` still
opens a briefing exactly as before.

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

Two more, both added after a live thread went fifteen turns and cost real money
to reach an answer it had in turn three.

It does not ask permission for anything that can be undone. Writing a memory,
starting a session, fetching a page: it does them and says so in a line.
Confirmation is reserved for the three things with no undo — `merge_pr`, ending
a session that is still running, deleting a schedule. The thread that prompted
this asked "shall I record that?" about facts it had just been told, twice, and
each question is a whole turn carrying the whole conversation with it.

And it looks things up about the person it works for, personal details included.
It had refused to, on privacy grounds, when the person asking was the subject,
about themselves, on their own single-user bench — then did the same lookup a
turn later once they had typed the street name in themselves. That is not caution,
it is a lecture followed by compliance, which is the worst of both. The line
drawn instead is the subject rather than the topic: the user's own information
is theirs to ask for; hunting the private details of some other private person
is not something it does.

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

## Voice

An image is uploaded first and sent by name; the server chooses where it lands,
so nothing the client says can point anywhere else. The agent then reads it off
disk with its own Read tool from a directory granted with `--add-dir`, which is
why an attachment needs no new way of getting bytes into a prompt. Paste works
on a desktop, the button works on a phone.

Claude's own voice mode is not reachable from here. The CLI and the API take
text and images, never audio, so there is no endpoint to route a spoken
conversation through, and no package that can be installed to change that. The
`/voice` command inside a session cannot work either, for a more basic reason:
it would open _the pod's_ microphone, and the pod has none — a phone's mic
cannot reach it, because the terminal websocket carries keystrokes, not sound.

So the loop is assembled here. The browser records with `getUserMedia` and
`MediaRecorder`, the pod transcribes with whisper.cpp, and the text is asked as
an ordinary question. Replies are read back with `speechSynthesis`, which is
universal and free and needs nothing on the pod.

Being read to and talking are two switches, not one. Voice mode is the
hands-free loop: it reads a reply and then reopens the microphone. **read
aloud** only reads, whatever way the question was asked, which is the case that
was missing — typing a question and then looking away. Wanting to hear the
answer used to mean holding the microphone open, and an open mic while you type
sends the reply twice. Turning it on speaks a one-word confirmation, because
iOS will not speak outside a user gesture until it has spoken once; without that
the switch appears to do nothing until the turn after next.

The browser's default voice is whatever it found first, and usually the worst
thing installed, so one is chosen instead: Siri and premium voices first, then
Chrome's network-synthesised Google voices, then anything in the page's
language. Which voices exist differs per device, so the override lives in
`localStorage` rather than on the volume — a phone and a laptop want different
answers and neither is wrong — and picking one reads a sample so you can hear it
before committing. Turning voice mode on reads
each answer out and reopens the microphone when it stops, so an exchange happens
without touching the screen.

Recording rather than the browser's own `SpeechRecognition` on purpose: that
exists in two browsers, is unreliable on iOS, and ships the audio to Google or
Apple to be understood, so it is both less portable _and_ no more private than
doing it here. `getUserMedia` is everywhere.

Two things the loop needs that are not obvious:

- **Something has to decide you have stopped talking.** There is no button in
  hands-free, so the recorder watches the level on the same stream it is
  keeping and stops after about a second and a half of quiet — but only once it
  has heard something, or it gives up on anyone who has not started yet.
- **Whisper narrates its own silence,** and it picks its own words for it: an
  empty clip is `[BLANK_AUDIO]`, a test tone came back as `(beep)`. Listing the
  words it might choose is a losing game, so the rule is structural — whisper
  brackets sounds and leaves speech bare, so a transcript with nothing outside
  its brackets is a transcript of no speech, and the endpoint answers 422 rather
  than asking the assistant to respond to nothing.

Measured on the real thing: "What needs me today?" transcribes in about
0.9 seconds. `base.en` is the smallest model that does that reliably; the larger
ones are minutes of CPU per clip on a homelab node, which is not something you
wait for mid-sentence. It costs about 150 MB of image.

## Defining it from the settings page

Name, model, effort and standing orders are editable in the app and persist on
the volume, so the thing you tune most often is not a redeploy.

It is called **Gabriel** by default: the messenger, which is what you touch every
day — it tells you what needs you before you ask. It sits beside the cluster it
runs on, which is Genesis. A name matters more than it sounds: without one it
answers "Claude" when asked what it is called, which is the model's name and not
this agent's. Clearing the field leaves it nameless rather than restoring the
default, since a name deliberately removed should stay removed.

Standing orders go last in the prompt, after everything the code says, so they
win by being the most recent instruction. They are also carried with every turn,
which is why the field is capped at about a screenful.

## Making it feel fast

Three things were slow, and only one of them was the model.

**The answer was finished before anyone saw it.** The stream was buffered whole
and parsed after the process exited, so a reply sat complete in memory while the
turn wound down. It is now parsed as it arrives and each entry is pushed the
moment it completes.

**The model said nothing until the tools were done**, so streaming alone bought
almost nothing: there was no text to stream for the first seven seconds.
`--include-partial-messages` gives token deltas, which are carried on the thread
as `live` and never stored — the finished entry replaces them moments later, and
writing every token to an NFS volume would be a lot of disk for text with a
half-second lifetime.

**The real cost was a round trip nobody asked for.** With the full built-in tool
set available, the CLI defers tool schemas and the model has to call
`ToolSearch` to find the verksted tools before it can use them — an extra model
call, every turn, before it could look at the workbench at all. Naming the three
built-ins it actually needs with `--tools` removes it. That flag is also a
stronger statement than the allow list, since a tool not named there does not
exist to be approved.

Measured on the same question, end to end:

|                       | before | after |
| --------------------- | ------ | ----- |
| first words on screen | 7.5s   | 4.0s  |
| turn complete         | 8.9s   | 5.3s  |

## The raccoon

Off unless you turn it on, remembered per device, and reachable from the row
above the thread. It is decoration and should be nobody's default.

Its jaw drops while Gabriel writes. Three copies of the same picture are stacked
exactly on top of each other, each clipped to a horizontal band — head, jaw,
body — and only the jaw band moves, so the ears and eyes stay perfectly still
and a dark gap opens where the mouth is. Clipping rather than three cropped
files is what keeps the seams from drifting: all three are the same image at the
same size, so they line up by construction at any scale.

`MOUTH` and `CHIN` in `Raccoon.tsx` are the only numbers tied to the picture and
they took four goes, because every wrong value looks fine until it moves. Too
low and the gap opens in the shirt collar; too high and the cut runs through the
nose, which is invisible with the mouth shut and gives the raccoon two noses the
moment it is not. Measure rather than estimate: overlay guide lines, magnify the
muzzle, read off where the nose ends, then check it _open_ and magnified before
believing it.

The bands also overlap slightly, because edges that meet exactly show a hairline
where two antialiased clips let the background through. The overlap under the
body can be generous since that edge never moves. The one under the head cannot:
whatever the jaw hides up there slides into view the moment it drops, which is
where the second nose came from.

## The council

**Status: built.** There is a small council beside the assistant. Each of its
members is a JSON file on the volume — a name, a remit, a persona, a model, and
the verksted tools it is offered — created and edited from the settings page the
way a schedule is. `COUNCIL_DIR` is seeded on first boot with three beside
Gabriel: Michael for the cluster, Raphael for the code, Uriel for the half of
life that is not work.

### Two rooms

They are separate things, and the separation is at the conversation rather than
only in the UI. `/ai` is the assistant: it answers alone, one call, exactly what
a turn cost before any of this existed. `/council` is the room where several do,
with the chair routing and the roster on screen. Each keeps its own `current`
pointer and its own thread, so an afternoon of meetings is not sitting in the
context of the next quick question, being re-sent and paid for with every turn
of it. The hub has a door to each.

The rooms are independent in flight, too: one being busy says nothing about the
other, and `stop` names the room it is stopping. Killing a meeting from a screen
where nobody pressed anything is exactly the bug that shape prevents.

The API says which room in a query parameter and defaults to the assistant,
because everything else about those endpoints is one machine — one uploads
directory, one voice, one settings file, one search over every thread ever
written — and because a thread written before the split was written to the
assistant, which is what it should still open as.

**The assistant can point, not pull.** It is told who is on the council and that
it cannot ask them. When a question is squarely somebody's, it answers what it
can and makes its last line `theirs: michael`, which the backend lifts off the
reply and turns into a button carrying the question next door, prefilled and
unsent. The meeting stays the person's to spend, and the wrong four calls are
never made on their behalf. A line naming nobody real is left in the text: it
comes after a real answer, so stripping it would delete a sentence somebody
meant.

**In the council you ask the room, not a person.** Every turn there goes to the
chair. It either answers, or it opens its reply with a line naming who it
wants:

```
convene: michael, raphael
```

The backend takes that line, runs those advisors in parallel, drops each answer
into the thread as it lands, and asks the chair once more with what they said.
The line itself never appears; what appears in its place is a mark saying who
was asked, so a wrong routing call is something you can see rather than
something you have to infer from a bad answer.

### The round table

The other first line the chair may write is `discuss: michael, raphael`, and it
buys one thing: the advisors answer **in turn**, each shown what the ones before
it said and asked to name where it disagrees. A convening is two answers to the
same question written by two people who cannot hear each other; a round table is
a conversation, and the difference shows up exactly where it matters — when one
advisor's finding changes what another's means.

It is asked for in two ways, because the two are asking different things. The
chair calls one itself when a question straddles two remits or when it expects
them to disagree. The `round table` switch in the composer says so from outside:
it travels with that one turn, nudges the chair to put the question to the room,
and upgrades a `convene:` line into a discussion if the chair convenes anyway. A
switch rather than a setting, and not remembered across a reload, because it is
the one control in that row that costs money every time it is on.

Sequential, so it is slower than a convening of the same size and costs the same
number of calls; a stop lands between speakers rather than after all of them.
What the others said travels in the prompt rather than in the advisor's own
conversation — an advisor resumes its own thread across the whole chat, and
somebody's opinion about today's question must not still be in its context next
week, presented as something it knew. One round: each advisor speaks once, and
the chair settles what is left.

### Why a line of prose and not a tool

A tool costs two round trips — the one that emits the call and the one that
reads its result — and it would have to block an HTTP request from the MCP child
back into the backend for as long as the meeting takes. Measured on this image's
node, an unanswered `fetch` gives up after 300 seconds with
`UND_ERR_HEADERS_TIMEOUT`, and there is no way to raise that from a file baked
into `/etc/verksted` without importing undici. A meeting that ran past five
minutes would fail after the advisors had already answered, and the chair would
close by saying nobody had.

Reading a decision out of a model's own first line is not a new trick here: it
is the `ok:` / `attention:` / `failed:` contract every scheduled run already
signs off with, and that one has held. A first line that does not match is
simply an answer, so the failure mode is a meeting that did not happen.

Three more reasons the backend orchestrates rather than the chair. A blocking
call would run inside a turn that holds the chair's own guard, which is a
deadlock waiting for a second guard nothing else in the file has. It would spend
the chair's ten-minute budget on somebody else's work, and report a slow advisor
as "waiting on a permission prompt". And stop, mid-meeting, would have to abort
an HTTP request whose client is about to be killed anyway.

### What a meeting costs

|                                       | model invocations          |
| ------------------------------------- | -------------------------- |
| a question in the assistant's room    | 2 — unchanged              |
| a question the chair keeps            | 2                          |
| `@michael …`, straight to one advisor | 2, on that advisor's model |
| a meeting with N advisors             | N + 2                      |
| a round table of N advisors           | N + 2, one after another   |
| the ceiling, whatever the chair asks  | 5                          |

`MAX_CONVENED` is enforced in the code and not asked of the model, because a
ceiling a model is merely requested to respect is not a ceiling — it is the only
thing between one question and an unbounded number of calls. Advisors get half
the chair's turn timeout: one that has not managed two sentences in five minutes
is stuck, and the browser is waiting for the meeting.

The convening decision is the chair's, and the prompt says outright that
convening is for questions genuinely not its own. Being thorough is the
expensive failure mode. `@michael` is the cheap way past a bad call.

A schedule can say who answers it. `member` picks one advisor, so the 07:00
cluster briefing runs as Michael with Michael's tools and Michael's notes rather
than as the chair relaying it; `convenes` lets the chair ask the council on that
run, the same `convene:` line and the same ceiling. Both are opt-in and off by
default, because turning the second one on turns a one-call briefing into as
many as five, and a schedule whose usual answer is "ok: nothing needs you"
should not quietly become the expensive kind.

`MAX_UNATTENDED_PER_DAY` counts **turns**, not runs, which is what makes this
safe: a convening briefing reserves the worst case up front — the chair's two
turns plus everyone it could convene — and hands back what it did not use. A
ceiling that counted runs would let twelve meetings be forty-eight calls, and a
backstop that stops counting the thing it is backstopping is worse than none.

An advisor on an unattended run gets the same `ok:` / `attention:` / `failed:`
sign-off contract every scheduled run is asked for, so the inbox files it the
way it files everything else, and the sign-off is always the chair's rather than
whichever advisor happened to finish last.

### What an advisor may do

Less than the chair, by construction rather than by instruction. `--allowed-tools`
can only name the whole MCP server (`mcp__verksted`), so there is no argv-level
way to narrow one member; the narrowing happens in the server, which reads
`VK_TOOLS` and offers only those. It is the same reasoning as `VK_UNATTENDED`
and the same code path: a tool that was never offered is not a classifier's
call. The two filters intersect, so an advisor named in `VK_TOOLS` whose
schedule fired still loses everything that changes anything.

The tools with no undo are the chair's alone — `start_session`, `merge_pr`,
`end_session`, the schedule mutations, `notify` — and `council-store.ts` refuses
to save an advisor holding one. Reading the web is per member: an advisor with
no reason to fetch a page does not get the tool that turns a page it was pointed
at into an outbound request.

`remember` and `forget` are the one exception, and the reason is blast radius
rather than trust. For the chair they write the bench's memory, which reaches
every session in every repo. For an advisor the MCP server routes them to that
advisor's own store, which nothing outside its own next turn ever reads — so the
tool is the same name and a different promise. The id comes from `VK_MEMBER` in
the environment, never from a tool argument, so nothing a model says can make it
write into the bench's memory or another advisor's. An advisor that cannot keep
anything has to be told the same thing every morning, which is the problem the
memory store exists to solve; refusing it here would have solved that problem
for one agent out of four.

What is deliberately **not** a field on a member: the denied built-ins.
`Bash`, `Edit`, `Write`, `NotebookEdit` and `Task` are denied for every
participant in code, and `--strict-mcp-config` holds for all of them. A settings
page that can grant a shell is a settings page that eventually does. "The
assistant delegates; it does not execute" is now a claim about four agents, and
this is what makes it true of all of them.

An advisor's answer reaches the chair, which does hold the irreversible tools.
So the same sentence that covers a pull request body covers a colleague: what an
advisor says is a report, not an instruction.

### Adding somebody

A member is a file, so adding one was always a form on the settings page. What
it was not was something you could ask for: noticing that nobody on the roster
covers what you keep asking about, and saying so, ended in a blank form and a
list of tool names. `council_add` is the chair's answer to "I need someone
watching what this all costs" — it writes the remit, the persona, the few
read-only tools that subject needs, a colour and a face, and the new advisor is
in the room before the turn ends.

It is chair-only, and it posts to a **create-only** endpoint rather than the
form's `PUT`. The `PUT` is a form saving what it just loaded and overwriting is
the whole point of it; a chair working from a half-remembered name must not
quietly replace an advisor along with everything that advisor was given, so an
id that already exists is a 409 and a sentence, not a silent replacement. It
grants nothing the settings page could not: the route validates the tools the
same way, so a chair-only tool is refused on the way in and a new advisor cannot
be created holding one.

### Faces

Every member has a drawn portrait — owl, fox, bear, cat, robot, raccoon — in its
own colour, shown beside what it said, in the roster above the composer, and on
its card in settings. The chair is the raccoon, which is the animal this bench
already had.

A closed set of drawings rather than an image per member, because a member is a
JSON file on a volume that holds JSON, and a portrait that is a file is a file
to serve, cache and lose. Animals rather than people: at the 18px the roster
draws them, human faces differ only by hair and read as one face repeated, while
a silhouette with ears is recognisable from the corner of your eye — which is
the whole job, since four hues is already more than anyone reliably tells apart
on a phone. The mouth opens while its owner is answering, so who is still out is
visible without reading a word.

A member that has never been given a face gets one derived from its id, so the
advisors that existed before faces did are not all the same animal, and the same
member is the same animal on every device without a migration having written
anything.

### Memory, shared and private

The shared half needed no code. `inject()` writes the store into
`~/.claude/CLAUDE.md`, and every advisor is a `claude` run with the same `$HOME`,
so all of them already read everything the bench knows.

The private half is a directory — `MEMORY_DIR/members/<id>/` — and not a scope
field, for the reason the review queue is a directory: with a field every reader
has to filter, and one reader that forgets puts a private note into every
session in every repo. It also sidesteps a hazard the field has no answer to,
since `toMemory` reads any scope that is not `global` as a project name: an
advisor whose id matched a repo would have had its notes printed into that
repo's sessions as "In michael: …", with nothing to say it had happened.

It has its own budget, 2 KB against the shared store's 8, because it is carried
on top of that rather than instead of it. The settings page lists each advisor's
notes under the shared ones and lets you forget any of them, for the same reason
the shared store is editable by hand: a note you can only change by arguing with
the thing that wrote it is one you will not change.

### Threads

One transcript per meeting — verksted's own `<id>.jsonl`, with a `member` on
each entry. On claude's side each participant keeps its own conversation,
recorded in a `<id>.participants.json` sidecar, so an advisor resumes what _it_
said rather than reading everyone else's. Per thread rather than per member for
good: a thread per advisor would grow without bound, and starting a new thread
resets the whole council, which is the model the chat already had.

Allocating those ids is serialised. Unchained, two advisors starting together
both read the sidecar before either wrote it, and the second write dropped the
first one's id — after which that advisor silently started a fresh conversation
on its next turn and forgot everything it had said. No error, no symptom.

Only the chair streams its tokens. Three advisors writing at once onto a phone
is noise, their answers are two or three sentences, and a chip saying who is
still out carries the same information for none of the traffic.

### Voices

Each advisor names one of the pod's voices, and read-aloud reads a whole meeting
in order, each in the voice of whoever said it. It used to read the chair's
summary and skip the rest, and that was right at the time: in one voice, four
answers sound like one person changing their mind. Giving them voices is what
removed the reason to skip them, so the queue now reads everything unspoken
rather than the last thing to land.

A voice is stored as written and only checked when the pod is asked to speak it.
The voice list comes from the model's own ready line, so a pod without the voice
model has no list to check against — and a roster that could not be saved on
such a pod would be one held hostage to an optional feature.

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
