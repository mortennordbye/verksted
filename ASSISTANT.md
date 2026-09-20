# The assistant

What Gabriel is, what it may do, and why each limit is where it is.

This describes the code as it stands. It is not a plan: the two planning
documents this replaces — the original milestones and the second shape that
superseded them — are gone, because a status block saying "built and merged" is
history pretending to be a specification. SPEC.md describes the workbench and
points here for the assistant's own detail.

## What it is

One agent that belongs to no project, reads the bench and the person's own
things, and hands the actual work to sessions.

It is a Claude Code process, spawned per turn, headless. There is no daemon: a
turn is `claude -p` with a thread to resume, an MCP server of this app's own,
and a system prompt built from the person's profile and the last few days'
journal. Everything it can do it does through that MCP server, whose every
endpoint is one the app already validates — so the assistant has no privileges
the app does not, and no way to run a command.

The front door is **Today** (`/`): what is new, what needs you, what happened
overnight. The chat (`/ai`) is how you follow up on it, the inbox (`/runs`) is
where everything that wants a decision queues, and the bench (`/bench`) is the
repos and sessions. The council is not a room you go to; it is a mechanism
behind the one conversation.

## What it may do

Its built-in tools are **Read, Grep, Glob, WebFetch and WebSearch**. Bash,
Edit, Write, NotebookEdit and Task are denied outright — not merely left off an
allow list, which under `--permission-mode auto` is auto-approval rather than
restriction. `--strict-mcp-config` keeps it to the servers declared for the
turn, so the MCP servers connected to the Claude account do not join them.

Everything else is the verksted MCP server (`runtime/verksted-mcp.mjs`), plus
two that are the chair's alone: a headless Chromium it can navigate, click and
type in, and headroom's own server for the household finances.

**The chair holds every tool there is.** The council is not where a capability
is kept away from it. That was tried and it was wrong: routing a lookup through
an advisor cost a model call and a turn spent saying "I will ask Sophia", and
left the chair unable to answer the follow-up, never having seen the page.

### The policy table

What each tool is lives in one table beside the tool definitions, and carries
five properties:

| property     | what it means                                            |
| ------------ | -------------------------------------------------------- |
| `unattended` | may run on a turn nobody is reading. Absent means no.    |
| `chairOnly`  | never offered to an advisor, whatever its file asks for. |
| `private`    | reads something of the person's.                         |
| `outside`    | returns text somebody outside this bench wrote.          |
| `effect`     | `read`, `reversible`, `card`, or `irreversible`.         |

The backend keeps a copy, because the server file is baked into the image at a
path the build does not import from, and a test drives the real server's
`tools/list` and compares every field of it. A decision made in one and not the
other fails rather than drifting.

This replaced four separate lists and a good deal of prose. Reversibility used
to be explained in tool descriptions and in the persona, where it was advice; a
model that did not take the advice met nothing at all.

### The card

`effect: "card"` means the tool files a proposal and changes nothing. The card
shows the whole thing — the mail body, the prompt an agent would be given, the
event — and the person's tap is what reaches the app's own route. Starting a
session, ending one, merging a pull request, sending a mail, putting something
on the calendar, setting up or running a session schedule: all cards.

Starting a session is a card for a specific reason. The chair reads mail and
documents, which are text written by strangers, and a session is the one thing
it can do that a poisoned document could usefully ask for: an agent with a
shell on the pod, holding gh, kubectl and git. A schedule that starts a session
is that same agent on a timer, holding whatever prompt was written into it, and
running one now is that same agent with no timer at all — so those are cards
too.

Three tools are none of read, reversible or card: `mail_rule_delete`,
`mail_label_delete` and `calendar_delete`. They are the chair's alone, so the
person said it in the chat, but that is weaker than a card. They are marked
`irreversible` in the table and a test pins the set at exactly three, so a
fourth cannot join quietly. BACKLOG has what to do about them.

## The rule that makes reading their mail safe

The chair reads the mail, the documents, the calendar and the inbox. It also
reads the web and drives a browser. Both at once is a complete exfiltration
path with no click in it: a mail body that talks it into fetching
`https://somewhere/?q=<what it just read>` is the whole attack, and nothing on
this bench would show it had happened.

So a turn holds one half or the other:

- Reading anything **private** closes the browser and bars it for the rest of
  that turn. The MCP server pays for the read before it serves it and fails
  closed if it cannot, so there is no moment between the mail arriving and the
  browser going.
- A turn that has already **reached the web** — `WebFetch`, `WebSearch`, or the
  browser — is refused the read instead. Those are on the CLI's command line,
  fixed when the turn was spawned, so unlike the browser they cannot be taken
  back; the rule has to run the other way round for them. The backend notices
  as the stream reports each tool, which is before the next tool call rather
  than after the sentence around it.

Per turn, because that is the unit a prompt injection acts within. The next
turn holds everything again, and a person opening the browser pane themselves
carries no turn at all and is unaffected.

The same reasoning covers memory. `remember` writes the bench's memory, which
every session in every repo is handed as its own instructions, and
`person_note` writes a line into every system prompt the chair gets. On a turn
that has read text written elsewhere, both become proposals in the review queue
instead — one poisoned mail must not become a standing order for every future
agent. An advisor's own notebook is unaffected: it reaches nothing but that
advisor's next turn.

What this does **not** cover: the chair's Chromium runs on the pod, so it can
open the pod's own API on loopback and any cluster-internal address. That is
not reachable from where the backend sits — Chromium's resolver rules only
cover names, and the addresses that matter are literals — and waits on running
agents and that browser as their own unix user. BACKLOG has it.

## The council

Advisors are **experience**: a subject somebody has thought about longer than
the chair has. They are convened for judgement — what the money can stand,
whether a change is safe to merge, whether the cluster actually took a deploy —
or to disagree with each other in front of you. A question the chair could have
answered by looking is one it looks at itself.

A member is a JSON file on the volume, editable from the settings page: a name,
a remit, a persona, a model, an effort, a face, a colour, a voice, and the
tools it holds. Five are seeded on an empty bench and never rewritten after —
a member edited or deleted by hand stays edited or deleted: the cluster, the
code, the mail and the documents, the money, and the web.

Convening is a line of prose in the chair's reply (`convene: michael, ariel`),
not a tool call, because a tool call would be a second round trip to say what
the chair is already writing. The advisors then run in parallel, each with its
own MCP config, its own tool list and its own memory; the chair closes the
meeting when there is more than one of them to synthesise.

Two rules hold whatever a member's file says:

- **No advisor holds a chair-only tool.** Enforced by the server as well as by
  the settings page, because the file is on a volume somebody can edit.
- **No advisor holds anything private beside the web.** A page it fetches is
  how the private thing would leave. The pairing is dropped when the member is
  read rather than refused, because that rule tightens over time and a member
  saved before a tool was marked private should be narrowed, not made to
  vanish.

Driving a browser stays the chair's alone. The advisors read the web only to
answer the question put to them — asked for input, not given a second way to
act on it.

## Memory

A small store of durable facts in plain text, one file each, injected into
every agent session through the same mechanism that carries the sandbox note.
It makes no model smarter: it makes the agents better-informed, and the
day-to-day value is that you stop repeating yourself. A bad answer means a
missing or wrong fact, and it is fixable by editing a file.

Facts arrive two ways, and the difference is the whole design:

- **Written directly**, when the person said it in this conversation.
- **Proposed**, when the assistant worked it out from something else — the
  nightly harvest of what was typed into sessions that ended that day, or a
  turn that had read text written elsewhere. A proposal waits in the inbox and
  reaches no session until it is kept.

That gate is not optional. Memory is read by every future agent as its own
instructions, so a fact nobody approved is an instruction nobody approved.

## The turn nobody asked for

A schedule can run the assistant instead of starting a session. It then has no
project, starts nothing and changes nothing: it reads the bench, answers in a
line or two, and pushes the phone through `notify` only when the answer should
interrupt. That is what a morning briefing is, and it is the only path by which
this app speaks first.

Three decisions hold it up:

- **A fresh conversation every run.** Sharing the chat would mutate a thread
  the person is reading and re-send it every morning; one thread per schedule
  would grow without bound, since every turn carries the whole history. A
  briefing is a standing question with no yesterday in it.
- **Beside the chat, not in front of it.** Its own guard, so a schedule firing
  while you are typing neither refuses you nor is refused. Two of these wait
  for each other rather than one failing: they are minutes apart by design, and
  a 07:00 briefing that met triage mid-flight used to be reported as a broken
  run and pushed to the phone at high priority.
- **Read and notify, nothing else.** The MCP server offers only the tools
  marked `unattended`, so a tool that changes something is absent from
  `tools/list` rather than merely unapproved. The web goes too: fetching a page
  is how an injection becomes exfiltration, and the only thing standing between
  the two on an attended turn is that somebody is reading the reply.

A turn with a job of its own — the journal, the catalogue, the learning pass,
triage — gets **no tools at all**: no built-ins, no allow list, and an MCP
config with no servers in it. These are described as reading and writing
nothing, and that is now the command line rather than a claim. Triage is handed
raw mail subject lines to sort, which is exactly why.

A broken run cannot push hourly: a ceiling counts unattended turns per day
across every schedule — in the bench's own day, not UTC, and a turn that
produced nothing is not charged — and a schedule whose previous run is still
open is skipped rather than queued. Above 95% of the week's plan window the
clock stops spending it altogether: a tick records why it declined and starts
nothing. Pressing "run now" is somebody asking, and is subject to neither.

## The chat itself

A turn streams. Entries are appended and announced as they complete rather than
after the process exits, because the model writes its first sentence while the
tools it asked for are still running — waiting for the exit was the slowest
part of a turn by a distance. The socket carries deltas, and the thread only
when something was appended to it.

Attachments are delivered as a line telling the agent where to look, not as
bytes on a wire it has no way to receive. Pictures a tool returned are written
beside the uploads and served by the same route, so no base64 ever lands in the
thread file.

Threads are one JSONL per conversation on the volume, mirroring what Claude
keeps under `$HOME` — so `claude --resume <id>` opens exactly what the chat
shows. Unattended threads go in a subdirectory, which is how `recall` avoids
searching several hundred a year of the machine talking to itself.

## Voice

Replies can be read aloud and questions can be spoken. Both run on the pod: a
small neural model for the speech, whisper for the transcription. Nothing said
to this bench leaves it to be turned into text or into sound.

## What it costs

The floor is a small model on low effort, and it is deliberate: this agent
summarises state and hands work off, and the model doing the actual engineering
is the one in the session it starts. The settings page overrides both.

A meeting costs a call per advisor plus the chair's close, which is why
convening is for judgement and not for fetching. Tool results stay in the
conversation and are re-sent with every later turn, so each tool answers in the
fewest lines that still carry the decision — `status` is one call where three
lookups would be three round trips.
