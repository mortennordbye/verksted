# The assistant, second shape

**Status: being built, milestone by milestone, on PR #99 and the branches
after it.** Milestone 0 (prove the pipes) waits on a week in the pod and is the
owner's. Milestones 1 (one door), 2 (Today, profile, journal) and 3 (feed, pollers,
triage, loops) are built and verified, as is milestone 4 in two halves: 4a
(mail and calendar read over IMAP and CalDAV, their pollers, the mail
specialist, the web moved to a specialist) and 4b (proposals you tap, intake
from the share sheet, citations as chips), and milestone 5 (the share: text
extraction, search, the catalogue and the loops it opens). 6 onward is not
started. This block is updated as each lands, so the plan and
its state stay in one file.

It supersedes the product shape in ASSISTANT.md (two rooms, the council as a
place you go, the chat as the front door) and keeps its runtime and its safety
reasoning, which are sound. Where this
document and ASSISTANT.md disagree about what the user sees, this one wins once
accepted; where they disagree about how a process is spawned or what a tool may
do, ASSISTANT.md still describes the code.

## What is wrong today

The complaint, in the owner's words: there are two things to ask and no way to
remember which; the raccoon was funny and is not needed; a chat box is not how a
real assistant works; it does not see the mail, the calendar, the finances or the
documents; and everything has to be explained to it every time.

Each of those traces to a decision that was right for cost and wrong for use.

**Two doors.** `/ai` and `/council` are separate conversations so that a meeting
is never re-sent with a quick question. That is a good reason for two threads and
no reason for two screens: it exports a routing decision to the person, who now
has to remember a roster and its remits before asking anything. The chair already
routes (`convene:`), already points (`theirs: michael`), and already holds the
only tools with no undo. The separation the code needs is between agents; the
separation the owner sees is between rooms. Those can be different.

**The front door is a blank text box.** A chat starts empty. Every morning the
first thing on screen is a cursor, and the assistant has nothing to say until
asked. The unattended turn and the inbox exist, so it can speak first, but they
live on `/runs`, behind an icon, as a list of sign-off lines. A real assistant
opens with what is new, what needs you, and what it did while you were away. The
brief is the product; the chat is how you follow up on it.

**It knows the work, not the life.** Its sources are the bench, GitHub, the
cluster and the web, plus headroom for exactly one advisor in the room you have
to remember to walk into. No mail, no calendar, no documents. So "what do I need
to do today" is answered from pull requests alone, which is a fraction of the
question.

**It forgets on purpose.** A fresh conversation per unattended run, a new thread
suggested past fifteen turns, and a memory store designed for facts about repos.
All three are the right cost controls, and together they mean yesterday is gone
unless it was distilled into a fact. What is missing is not more memory but a
standing description of the person (accounts, people, commitments, preferences)
and a short record of what was said recently, so the next thread starts informed
without re-sending the last one.

**It explains itself.** A capability the persona describes is a capability the
model tends to narrate. Nothing in the app tells you what it can do, so the
assistant does, in the reply, repeatedly.

**The raccoon** is decoration, already off by default, with two hand-tuned
constants tied to one picture. The faces on the council carry information (who
answered); the jaw does not.

**It is only as smart as the question.** Everything it knows, it knows at the
moment of a turn, and nothing it learns in one turn changes what it does in the
next unless a fact was written. It does not keep a list of what you owe, does
not notice that a mail and a calendar entry are about the same thing, and does
not get better at telling what matters from what you dismiss. Those are the
things that separate an assistant from a chat window, and none of them is a
model problem; they are all missing stores and missing turns.

## What it becomes

One assistant, one name, one door. It reads everything you would read yourself
in a morning and tells you what matters before you ask. It remembers who you are
and what was said this week. It can start work, draft, schedule and file on its
own, and it can send, book and merge with one tap from you. Everything it does
is visible in one place, everything it reads stays on the pod, and every claim
it makes points at what it read.

Five rules, each of which decides something below:

1. **You never choose who to ask.** Specialists exist for tool separation and are
   invisible except as a chip saying who was consulted.
2. **It speaks first, and it reasons before it speaks.** A brief every
   morning that has already cross-checked the sources; an interruption only
   for what needs you now; silence otherwise.
3. **Every source is read on the pod, over an open protocol, with a credential
   that lives in the settings page.** No Gemini, no vendor assistant, no
   third-party inbox app. IMAP, CalDAV, gh, NFS, headroom's own MCP server.
4. **No agent holds both a private source and an outbound channel.** The one
   that reads the web reads nothing of yours; the ones that read your mail,
   money and documents cannot fetch a URL. The single exception is a send you
   tapped, which is your action carried out, not the agent's.
5. **Read anywhere; write freely where there is an undo; propose and wait for
   a tap where there is none.** A draft, a session, a schedule, a memory, a
   loop: done and said in a line. Sending a mail, putting something in the
   calendar, merging, ending a run: prepared in full, shown as a card, executed
   on the pod when you tap it. Nothing irreversible ever happens without that
   tap, and nothing you would do yourself should need more than it.
6. **Judgment is a model's, not a keyword's.** What is urgent, what belongs
   together, what you are likely to have forgotten: those are decided by a
   model with your profile in front of it. Cost is held by ceilings on how
   often that happens, never by replacing the judgment with a rule.

## The logic

### One conversation, specialists behind it

The assistant (Gabriel, by the settings page's default) is the only thing you
talk to. `/council` goes as a screen; the council stays as a mechanism. What
changes:

- One thread, the assistant's. A consultation happens inside it: the chair's
  `convene:` and `discuss:` lines work as now, the advisors' answers land in the
  same thread as now, and the mark saying who was asked becomes a chip on the
  turn. The second `current` pointer and the `room` query parameter are removed.
  Threads written to the council room before this are opened by recall like any
  other.
- `theirs: michael` goes. The chair no longer points next door because there is
  no next door; it convenes when a question belongs to a specialist, and the
  cost ceilings already in `assistant.ts` (`MAX_CONVENED`, `MAX_EVERYONE`) are
  what stop that being expensive. `@michael` in the composer still works as the
  cheap override and `@all` still asks everybody.
- The roster, remits, models, tools and faces move entirely to the settings
  page, under "specialists". Nothing on the chat screen lists them. A person who
  never opens settings never learns they exist, and loses nothing by that.
- The raccoon component, its toggle and its picture are removed. The drawn faces
  stay, at chip size only, because "asked Ariel" with a small mark is faster to
  read than a name in mono. The mouth animation on the faces goes with it.

The persona loses every line that describes the council to the user and gains
one: never describe your own tools or specialists unless asked what you can do.
A "what can it do" card lives on the settings page instead, generated from the
tool list the MCP server actually offers, so it cannot drift.

Why not simply give the chair every tool and delete the advisors: rule 4. The
advisors are how "mail but no web" and "finance but no web" are enforced today
(`VK_TOOLS`, the headroom deny list, `--strict-mcp-config`), and that separation
gets more important with every private source added, not less. The council is
kept because it is the security model. It is hidden because it is not the user
model.

### The specialists, by source

The seeded roster becomes one specialist per private source, each holding that
source and nothing outbound. Names are the settings page's business; what
matters is the tool set.

| specialist | reads                                               | may also                                                                                | never                                                    |
| ---------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| the chair  | bench, GitHub, calendar, feed, loops, memory, repos | start sessions, schedules, loops, notify, remember, file issues, propose any tap action | Bash, Edit, Write, web, mail bodies, headroom, documents |
| cluster    | `cluster_status`, repos                             | nothing                                                                                 | web, anything private                                    |
| mail       | IMAP                                                | `draft_mail`                                                                            | web, send                                                |
| finance    | headroom (existing deny list)                       | nothing                                                                                 | web                                                      |
| documents  | the NFS share                                       | nothing                                                                                 | web                                                      |
| research   | the web                                             | nothing                                                                                 | any tool that reads yours                                |

The chair reads the calendar directly because a calendar is what the brief is
built around and a consultation per "what is at ten" would be absurd; it is the
one private source whose entries are short, structured, and yours to write
rather than somebody else's text arriving in your inbox. Mail bodies are the
opposite: text written by strangers, which is exactly the shape a prompt
injection takes, so they are read only by an agent with no way to act on
anything but a Drafts folder. The chair sees the feed's one-line summary of a
mail, and asks the mail specialist when it needs the body.

The research specialist replaces the chair's own web tools. Today the chair has
WebFetch alongside repo read access and ASSISTANT.md already calls that the
combination worth refusing; with the calendar and the feed added to the chair,
it stops being defensible. Looking something up becomes a consultation, which
costs one extra call and closes the channel.

### What makes it smart

A chatbot answers what it is asked. The difference being built here is
everything that happens without a question, and five things carry it.

**Triage by a model, in batches.** A poller files items; it does not judge
them. Judgment is a triage turn: whenever the feed has new items and at least
ten minutes have passed since the last one, the chair reads the batch with the
profile, the open loops and today's calendar, and decides for each item whether
it is attention, new or quiet, whether it belongs to an existing loop, and what
the one-line summary should say. One call for the whole batch, on the cheap
model, with no consultation. That is what turns "mail from barnehagen" into
"barnehagen needs the form back by Friday; you have not replied", and what a
keyword rule cannot do. The two rules that survive are the ones that must not
wait ten minutes: a session waiting on you, and a red check on `main`.

**Open loops.** The thing a good assistant does that a chatbot does not is keep
the list you would otherwise keep in your head. `LOOPS_DIR` holds one file per
commitment: what, who it involves, where it came from (a feed item, a
conversation turn, a document), a due date if one is known, and its state. The
triage turn opens loops from what it reads ("reply to X", "pay Y by the 15th",
"renewal on the 3rd") and closes them when a later item shows they are done (a
reply in Sent, a matching transaction in headroom, a merged PR). The chair opens
one when you say "remind me" or "I need to", and the journal opens one for
anything left unresolved in a conversation. Today shows them under "open", the
brief leads with the ones due, and a loop nobody has touched in a week is
raised once and then left alone. This is the memory of obligations, and it is
separate from the memory of facts because a fact stays true and a loop is meant
to end.

**Cross-checking.** A brief that lists is a feed reader. The brief is allowed to
think: it reads the material, then consults specialists where a loop or an item
points at another source. An invoice in the mail is checked against headroom
before it is called unpaid; a renewal in the calendar is matched to the policy
on the share and last year's premium; a review request is read against the PR's
diff size before it is called a five-minute job. The budget is six calls per
brief rather than one, and the persona says which checks are worth a call and
which are not. What comes out is a paragraph with a recommendation, not a list
with a count.

**People.** The profile carries a card per person who matters: relation, mail
addresses, what is usually about, what is pending with them. Triage uses the
cards to weight senders; the chair uses them to answer "what is going on with
Kari" from mail, calendar and loops in one turn without being told who Kari is.
Cards are written by you on the settings page and amended by the harvest, under
the same review gate as any other proposed memory.

**Learning from what you do with it.** Done, snoozed and ignored are signals.
The nightly journal turn also reads the day's feed states and proposes triage
rules in plain language ("newsletters from X are never attention", "anything
from the kindergarten is") into the review queue; kept ones go into the
profile's triage section, which the triage turn reads. Over a month the feed
stops flagging what you dismiss, and it is visible why, because the rule is a
sentence on a page rather than a weight.

**Desk sessions.** The assistant already puts agents on code by starting a
session in a repo. Life admin needs the same move: compare three insurance
offers, fill in a form from a scanned letter, draft a complaint with the
relevant clauses quoted. A desk session is an ordinary session started in a
workspace that is not a repo (`DESK_DIR`, on the volume, one directory per
task) with the full Claude Code toolset, the share mounted read-only beside it,
and no git remote to push to. It is visible on the bench, has a terminal you
can take over, signs off like a scheduled run, and leaves its output as files
in its directory, which the feed links to. The chair starts one when a task is
more than a lookup and says so in a line. The session model has to admit a
projectless session for this, which is the same change the backlog's "open the
assistant's conversation in a terminal" entry needs.

**Models, tiered by what the turn is for.** Triage and the journal run on the
cheap model at low effort, because they are classification over a few
kilobytes. The brief and every turn you type run on the strongest model the
subscription allows, at medium effort, because those are the turns where a
bad answer costs you something and a good one is the reason this exists. The
settings page keeps its model and effort fields, but they become per role:
chair, triage, specialists. The current default of `sonnet` at `low` for
everything was chosen to stay off the usage meter, and it is the wrong default
for an assistant meant to be smart.

### Proposals: the tap

The first draft of this document said the assistant never sends a mail and
never writes to the calendar. Walk through a real task under that rule and it
ends the same way every time: the assistant does nine tenths and hands you the
last step, which is the step you wanted rid of. So the rule is replaced by a
mechanism.

A proposal is a feed item of kind `proposal`, written by the chair through a
`propose` tool, carrying an action and everything needed to execute it: `send`
(a draft id in the Drafts folder), `calendar_put` (a full event), `merge_pr`,
`end_session`, `delete_schedule`. The card shows the whole thing, not a summary:
the mail as it will go, the event as it will appear. Two buttons, do and drop.
Do executes on the pod through the same specialist tools, with the proposal id
as the audit trail; drop leaves the draft where it is. A proposal that nobody
taps expires after three days and says so in the feed, which is also a loop the
journal can pick up.

That replaces the "confirm in the thread" the persona asks for today with
something that works from a push and from Today, and it is the difference
between an assistant that prepares and one that finishes. The no-undo list is
unchanged; what changed is that it is now a list of things you can tap.

Three consequences. Sending becomes an IMAP `APPEND` to Sent plus an SMTP
submission, so the mail specialist gains the one outbound channel this document
otherwise refuses it; it may only ever send a draft it wrote and a proposal
referenced, never an address it was handed in the same turn, and the card is
what the person reads. Calendar writes stop being deferred. And the brief can
end with a proposal instead of a question: "renewal notice is due; here is the
cancellation mail, tap to send" is what a morning should look like.

### Intake: getting things to it

Typing is the only way in today. Four more, in order of how often they are
needed:

- **A photo.** The composer already takes images and the chair reads them. A
  photograph of a letter is read, summarised into the feed as a `paper` item,
  and opens a loop if it asks for anything. That is how paper mail joins the
  same list as the electronic kind. The extracted text is kept beside the image
  so the loop still reads without the picture.
- **The share sheet.** A `POST /api/intake` that takes a URL, text or a file,
  reachable over the tunnel; on iOS an installed Shortcut ("Send to Gabriel")
  is the share-sheet entry, since a web app cannot register as a target there.
  Android gets the Web Share Target in the manifest. Whatever arrives is a feed
  item with a `from you` mark, and the next triage turn reads it like anything
  else.
- **A forwarded mail.** Forwarding to your own address with a fixed subject tag
  is picked up by the mail poller and treated as "look at this". No new
  credential and it works from any mail client.
- **Voice, hands-free.** Exists. The change is that "remind me", "add", and
  "find" spoken while walking should land as loops, proposals and answers
  without a screen being looked at, which is a prompt matter and is in the
  persona.

### Provenance: every claim points at something

A brief that says "unpaid" is only worth reading if it can show the invoice and
the account it checked. Every feed item, loop, document and thread already has
an id; the chair is asked to cite by id in a fixed bracket form (`[feed:…]`,
`[doc:…]`, `[loop:…]`, `[mail:…]`, `[pr:…]`), and the screen turns each into a
chip that opens the thing. The brief, a triage summary and an answer in the
thread all carry them. Two effects: a wrong claim is checkable in one tap, and
the model, asked to cite, is measurably less inclined to assert what it did
not read. Uncited claims in a brief are allowed but rendered plainer, so the
eye lands on the ones with a source.

### Sources and pollers

A source is two things: read-only tools the specialist calls when asked, and a
poller the backend runs on a timer that never calls a model. The poller turns
what changed into feed items and the triage turn judges them, so a source costs
nothing while nothing happens and one batched call when something does. It is
the event-trigger backlog entry built properly rather than as a cron that mostly
finds nothing.

Every poller keeps a last-seen cursor on the volume so an event becomes one item
once, survives a restart, and is never re-announced. A poller that fails records
one feed item saying so and backs off; it does not push.

**GitHub.** Already read by `gh.ts` for PRs and CI. The maintainer's queue is a
repo's own issues labelled `queued`, so delegating code work does not always
need a session: a `file_issue` tool lets the chair put "bump the base image
and fix what breaks" on the queue as `tier:auto`, and the nightly build and
gate do the rest. Cheaper than a session, and the result arrives in the feed
as a pull request. Add `gh api notifications`
(review requested, mentioned, assigned, CI failed on a branch you own) every five
minutes. A red check on `main` is attention immediately, by rule; everything
else waits for triage.

**Mail.** IMAP over TLS with an app password, read-only by construction: the
tools are `mail_recent`, `mail_search`, `mail_read` and `draft_mail`, and the
last writes a message to the Drafts folder with no `To:` filled in unless the
draft is a reply. Nothing sends. The poller checks every five minutes (IMAP IDLE
where the server supports it) and files each new message as a feed item with
sender, subject and the first two lines. The triage turn decides what it is:
an item from a person on a card, a loop to open, a newsletter to fold into one
daily line. The mail specialist reads a body only when triage or the chair
needs it, so the text a stranger wrote reaches a model that cannot act on it.

Sent is read as well as Inbox, for two reasons. A reply you wrote closes the
loop that the incoming mail opened, which is most of how loops close on their
own. And your own mail is the corpus for writing like you: the harvest reads a
sample of Sent (your words, the same rule as the transcript harvest) and
proposes style notes for the profile (greeting, sign-off, length, Norwegian or
English per correspondent), so a draft reads as yours rather than as a model's.

Provider is a decision (see the end): IMAP covers Google Workspace (with an app
password), Fastmail, iCloud and any self-hosted server, and is the reason the
backend needs no OAuth flow, no Google project and no Gemini. Sending, for
proposals, is SMTP submission with the same credential.

**Calendar.** CalDAV, read-only. `calendar_today`, `calendar_upcoming` (seven
days) and `calendar_search`. Polled every fifteen minutes; the only feed items
it produces are "starts in thirty minutes" for events with a location or a video
link, and "added since last brief" for new events. Same providers as mail, same
credential shape. Writing events is deferred: it has an undo, so it is allowed
in principle, but a wrong event is a missed meeting and nothing here yet makes
that mistake visible in time.

**Finance.** Headroom, unchanged: the stdio MCP server that repo ships, the
existing write and raw-data deny list, one specialist. New is a daily poller
that asks headroom's own aggregates for two things and files them as feed items
only when they cross a line: a budget category over its month, and an account
balance below the floor set in the profile. The specialist answers questions,
and it is also what the brief consults when a loop says a bill is due and the
question is whether it was paid.

**Documents.** The NFS share, mounted read-only into the pod at `/data/docs` by
the Homelab manifests (a second PV; the pod's data PVC is itself NFS, so the
class exists). Three tools: `docs_list`, `docs_search`, `docs_read`. Search is
grep over extracted text: a nightly sweep walks the share and writes one
text sidecar per document under `/data/docs-index/<path>.txt`, keyed by path
and mtime, using `pdftotext`, `pandoc` for docx and odt, and the file itself for
anything already text. No embeddings, no vector store, for the reason
ASSISTANT.md gives about memory: a few hundred megabytes of text on a volume the
pod owns is something grep answers in well under a second, and a database is the
thing this app is built not to have. If the share turns out to hold tens of
thousands of files, the honest next step is a ripgrep index, still no database.

Search is the half a person asks for. The half that makes documents useful
without being asked is the **catalogue**: a nightly pass reads documents the
catalogue has not seen, a bounded number a night on the cheap model, and writes
one line per document to `/data/docs-index/catalogue.md`: what it is (contract,
invoice, policy, tax, medical, house, car, letter), who it is with, and every
date in it that means something (expiry, renewal, notice period, due). Renewals
and notice periods become loops with their dates. That is how "your car
insurance renews on the 3rd and the notice period is 14 days" reaches the brief
a fortnight early from a PDF nobody opened since last year. The catalogue is a
markdown file you can read and correct, and the specialist reads it before it
greps, so "the contract with the builder" resolves to a path without a search.

Every path is checked with the same realpath discipline `paths.ts` applies to
repos, against `/data/docs`, and the mount is read-only at the volume so nothing
in the pod can write there even by accident. Scans are read through the same
image path the composer uses (the model reads the page), a few a night, so OCR
is not a separate engine to install; a share that is mostly scans is a cost
question to answer with the count.

**Anything else the cluster runs** joins the same way headroom did: an MCP
server the pod can reach, a specialist holding it, a deny list for its writes,
and optionally a poller. Transit through the `ruter-cli` repo already on the
bench ("leave by" for a calendar entry with an address) and a home-automation
server are the likely next two, and neither needs a new mechanism.

**The bench and the cluster** are already sources. Sessions waiting, scheduled
runs signing off `attention` or `failed`, harvest proposals, the maintainer's
queued issues and pod restarts become feed items like everything else, which is
what lets the inbox screen be replaced rather than kept beside a second list.

### The feed

One store, `FEED_DIR`, one JSON file per item, the shape every poller writes:

```
id        <source>:<source's own id>     dedup key
source    github | mail | calendar | finance | docs | bench | schedule | memory | paper | intake | proposal
at        when it happened
title     one line
detail    two lines at most, plain text
urgency   attention | new | quiet
state     new | seen | done | snoozed(until)
link      a path inside this app, or a URL the screen opens outside it
loop      the open loop this belongs to, if triage attached it to one
```

Quiet items exist so the brief can say "eleven newsletters" without eleven rows.
State is the person's: done and snoozed are set from the screen, seen is set by
the screen when the row is on it. The assistant reads state and never sets it,
except that a feed item it acted on (started a session, drafted a reply) gets a
`did` line appended, so the row shows what happened to it. Urgency and the
summary are triage's to set and to revise; an item arrives as `new` with the
poller's raw title and is rewritten by the next triage turn.

Retention is the rule the backlog asks for about the assistant's directory,
applied here from the start: done items go after thirty days, snoozed ones when
they resurface, and nothing else is deleted.

### The brief

An assistant schedule, as today, at 07:00 with the chair, `skipWhenIdle` off,
and a prompt that reads: the feed since the last brief, today's calendar, the
bench's state, and the last three days of the journal. It writes ten lines at
most in a fixed order: what needs you, today, what happened, what it did. Then
the usual sign-off, so an `ok:` morning pushes nothing and an `attention:` one
pushes its first line.

Everything it reads was gathered by pollers and triage and is handed to it in
one tool result (`brief_material`, a new verksted tool that concatenates the
four, with the open loops), so the first call is cheap. It may then consult,
under a budget of six calls, for the cross-checks described above; the persona
tells it that a check is worth a call when it changes the recommendation and
not when it decorates it. A briefing that asks the mail specialist to read
twenty bodies is the shape the budget exists to stop.

An evening brief is the same schedule at 18:00 with a shorter prompt, off by
default. A push for an attention item between briefs is the triage turn's one-line
summary, so it costs nothing beyond the triage that already ran: "barnehagen:
form back by Friday" is the push body and tapping it opens the item.

### Memory that stops the re-explaining

Three layers, only one of which exists.

**Facts** (exists): the reviewed store, injected everywhere. Unchanged.
The open loops above are a fourth store beside these, and the difference is
that a loop ends.

**Profile** (new): one file, `MEMORY_DIR/profile.md`, edited on the settings page
and by the `remember` tool with `scope: profile`. It holds what a new assistant
would be told on its first day: name and address, the people who matter (name,
relation, mail address, which makes the mail rules work), the accounts and
repos, the recurring commitments (rent, the car, the cluster's renewal dates),
the standing preferences (language, what counts as urgent, when not to be
pushed), the people cards, and the triage section that learning writes to. It
is always injected into the chair, in full, ahead of the facts, and into each
specialist in the part that specialist needs. A budget of 8 KB, shown on the
page like the facts' budget.

**Journal** (new): at the end of each day that had a conversation, the
maintenance sweep asks the chair for a ten-line summary of the day's thread
(decisions, what was asked for, what is still open) and writes it to
`ASSISTANT_DIR/journal/YYYY-MM-DD.md`. The last three days are injected into
every new thread and every brief. That is how "as we said yesterday" works
without re-sending yesterday, and it is what makes the fifteen-turn new-thread
suggestion painless: the summary is written at that moment too, and the new
thread opens knowing it. One model call a day, on `sonnet` at `low`, over a few
kilobytes.

Recall over old threads stays as the last layer for anything older.

### The stores, in one place

Each is a directory of plain files on the volume, editable by hand, none of
them a database. That is more directories than the app has today, and the
reason is that each holds a different kind of thing with a different lifetime.

| store     | holds                                | lifetime                       | written by                        |
| --------- | ------------------------------------ | ------------------------------ | --------------------------------- |
| feed      | things that happened                 | done after 30 days             | pollers, triage, intake           |
| loops     | things you owe or are owed           | until closed                   | triage, the chair, the journal    |
| profile   | who you are, your people, your rules | until you change it            | you, the harvest via review       |
| facts     | what the bench has learned           | until forgotten                | the chair, the harvest via review |
| journal   | what was said, per day               | kept; only three days injected | the journal turn                  |
| catalogue | what is on the share                 | until the file changes         | the catalogue pass                |
| threads   | conversations                        | kept; recall searches them     | every turn                        |

### What it may do

Read: everything above. Write, without asking: start a session in a repo or at
the desk, create or change a schedule, file an issue on the maintainer's queue,
open or close a loop, remember a fact or a profile line, have the mail
specialist draft a mail, notify, mark a feed item with what it did. Propose,
and do on your tap: send a mail, put or move a calendar event, merge a pull
request, end a running session, delete a schedule. Never: touch headroom's
writes, write to the share, run a command, edit a file, send anything a
proposal did not show you first.

That is ASSISTANT.md's "delegates; does not execute" kept for the shell and the
files, and replaced with "prepares; you execute" for the rest.

### What it costs

Pollers: zero model calls. Triage: one cheap call per batch, at most six an
hour, so a busy day is twenty or thirty small calls and a quiet one is none.
Brief: one to seven calls on the strong model. Journal and learning: one cheap
call on a day with a conversation. Questions: two calls each, plus N + 2 for
one that convenes, under the existing ceilings. Desk sessions cost what a
session costs, which is why the chair says when it starts one.

`MAX_UNATTENDED_PER_DAY` rises to sixty and counts triage, the brief, the
journal and any convening; it is a backstop against a loop, not a budget to
live inside. The subscription's own windows are already sampled hourly and
shown on the settings page, and the brief is told to say so when the week's
allowance is more than half gone.

### The first day

An assistant that learns only from use takes months to be worth having. The
first day is a bootstrap, and it is mostly reading things you already wrote.

1. **Ten questions**, asked once in the thread, answered as you like: name and
   address, language, who matters, what you never want to be woken for, what
   always counts as urgent, the accounts, the recurring things. Each answer is
   written to the profile as it is given.
2. **Sent mail, ninety days.** The harvest reads it (your words only) and
   proposes people cards, style notes and recurring correspondents to the
   review queue in one batch. You keep or drop them on the Feed in five
   minutes.
3. **The calendar, a year back.** Recurring events and the people on them go
   the same way.
4. **The catalogue starts**, a bounded number of documents a night, newest
   first, so the loops with the nearest dates appear first.
5. **The first brief** the next morning, which is the test: it should already
   know who wrote, what is due, and what is on the share about it.

## The interaction

### Phone

The home screen is **Today**, not the hub and not a chat.

```
┌──────────────────────────────┐
│ Gabriel            ⌕  ⚙      │
├──────────────────────────────┤
│ Thursday 30 August           │
│                              │
│ Needs you                    │
│ ● review requested  vk #97   │
│ ● mail  Skatteetaten: frist  │
│                              │
│ Today                        │
│ 10:00  Standup     (link)    │
│ 14:30  Tannlege              │
│                              │
│ Open                         │
│ · form to barnehagen  Fri    │
│ · car insurance  renews 3/9  │
│                              │
│ Proposed                     │
│ ┌──────────────────────────┐ │
│ │ Reply to barnehagen      │ │
│ │ "Hei, vedlagt er …"      │ │
│ │        [send]   [drop]   │ │
│ └──────────────────────────┘ │
│                              │
│ This morning                 │
│ The insurance renewal is the │
│ one to act on: last year's   │
│ premium went up 18% and the  │
│ policy on the share says     │
│ notice is 14 days. I can put │
│ a desk session on comparing  │
│ offers. Main is green on all │
│ five repos; three renovate   │
│ PRs merged overnight.        │
│                              │
│ Running                      │
│ ▶ headroom  #139  25 min     │
│                              │
├──────────────────────────────┤
│ ask Gabriel…            🎙 ➤ │
├──────────────────────────────┤
│  Today   Feed   Bench   Chat │
└──────────────────────────────┘
```

Four tabs. **Today** is above; "Open" is the loops with a date or a week of
silence, each tappable to see where it came from and to close it. **Feed** is
the inbox rebuilt: every item, newest first, filter chips by source, swipe right
for done, swipe left to snooze until tomorrow, tap to open the link or expand
the detail; an item attached to a loop shows the loop's name. Long-press (or
the row's menu on PC) offers the four things you say to an assistant about a
piece of mail: reply, remind me, not important, why is this here. The third is
the learning signal; the fourth opens the triage turn that decided it. **Bench** is the hub as it
is today, unchanged, with projects and sessions. **Chat** is the thread.

The composer is docked on Today and on Chat. Asking from Today posts to the same
thread and shows the reply in a sheet over Today, with "open thread" in its
corner; the point is that following up on the brief does not mean leaving it.
The mic is the existing recorder; the reply is read aloud when read-aloud is on,
in the pod's voice.

A push opens the item, not the app's root: a review request opens the PR panel,
a waiting session opens its terminal, a mail item opens the feed row expanded
with "draft a reply" and "open in mail" (a `mailto:` or the provider's URL from
the profile).

Nothing on Today says what the assistant can do. The first time Today is opened
with an empty profile it shows one card: "Tell me about yourself", which opens
the profile editor, and a second: the sources not yet connected, each a link to
its settings section. Both disappear when done.

### PC

Three columns, the middle one wide.

```
┌────────────┬────────────────────────────────┬──────────────────┐
│ Today      │ Thursday 30 August             │ Today            │
│ Feed   3   │                                │ 10:00 Standup    │
│ Bench      │ Needs you                      │ 14:30 Tannlege   │
│ Chat       │ ● review requested   vk #97    │                  │
│            │ ● mail  Skatteetaten: frist    │ Running          │
│ ──────     │                                │ ▶ headroom #139  │
│ github  ●  │ This morning                   │                  │
│ mail    ●  │ Main is green on all five      │ Feed             │
│ calendar●  │ repos. Three renovate PRs …    │ · renovate #212  │
│ finance ●  │                                │ · newsletter x11 │
│ docs    ●  │ ┌────────────────────────────┐ │ · harvest: 1     │
│ cluster ●  │ │ you  what is the frist about│ │                  │
│            │ │ G    Restskatt, due 15 Sep. │ │                  │
│ ──────     │ │      Drafted a calendar note│ │                  │
│ settings   │ │      to the profile. [mail] │ │                  │
│            │ └────────────────────────────┘ │                  │
│            │ ask Gabriel…            🎙  ➤   │                  │
└────────────┴────────────────────────────────┴──────────────────┘
```

Left: navigation and a source list with a health dot per poller (green, grey
when not configured, red when its last run failed; clicking one opens its
settings). Centre: Today with the thread continuing underneath the brief, so the
morning reads as one page from brief to conversation. Right: the calendar, what
is running, and the feed's newest items, each a click away. Bench and the
session screen keep their current layout; this shape is for the assistant's
screens only.

### Voice

Unchanged in mechanism. Two additions: the brief can be read aloud from a button
on Today (Kokoro on the pod, the same path as read-aloud), and the profile's
language line decides whether the assistant writes in Norwegian or English. The
pod's voice has no Norwegian (see BACKLOG); a Norwegian brief is read by the
browser's own voice until that is decided.

### What goes

- The `/council` screen and the door to it on the hub.
- The room switch, the `room` query parameter, the second `current` pointer.
- The raccoon: `Raccoon.tsx`, its toggle in `Chat.tsx`, `public/raccoon.jpg`,
  the unreferenced `rac1.png` in the repo root, and the `MOUTH`/`CHIN`
  constants.
- The `theirs:` line.
- The inbox screen at `/runs`, replaced by Feed. Its four sections become
  feed sources: a waiting session is a bench item that opens the terminal, a
  proposed memory is a memory item with keep and drop on the row, a queued
  maintainer issue is a github item, a scheduled run is a schedule item carrying
  its sign-off and cost line. The badge on the tab counts attention items.
- Every persona line that tells the user about the council.

## Security and privacy

The boundary is unchanged: WireGuard, no public ingress, no in-app auth, single
user. What is new is that the pod now reads mail, money and documents, so the
blast radius of the assistant being wrong, or being talked into something by a
page or a mail, is the thing to bound.

- **Credentials** for mail, calendar and the share are agent vars on the settings
  page (`IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`, `CALDAV_URL`, `CALDAV_USER`,
  `CALDAV_PASSWORD`), the way `HEADROOM_PASSWORD` is today: typed on the phone,
  stored on the volume, never in the Homelab repo, reaching only the process
  that needs them. A source whose vars are unset is not offered, not polled, and
  shows grey.
- **Rule 4 in code, not prose.** `council-store.ts` refuses to save a member
  holding both a web tool and any of `mail_*`, `docs_*`, `mcp__headroom`. The
  chair's tool list is a constant, as the headroom advisor's is today, so a form
  cannot grant it a private source.
- **Read-only by construction** wherever the protocol allows: the share mounted
  `ro`, IMAP tools that only ever `FETCH` and `APPEND` to Drafts, CalDAV `GET`
  and `REPORT` only, headroom's deny list as it is.
- **Text from strangers is a report, not an instruction.** The persona line that
  covers PR bodies covers mail bodies, documents and specialist answers. This is
  a mitigation and stays described as one; the defence is that the agents which
  read that text cannot fetch, run or send.
- **The feed is a path inside this app or an external URL, never both in one
  field**, and the push vets its tap target as `notify` does now.
- **Logs** carry item ids, never bodies. Nothing about mail or money is written
  to the backend log at any level.

**What leaves the pod.** Everything a turn reads is sent to the model, so
"stays on the pod" is true of the stores and not of a turn's context. The
design minimises that rather than pretending otherwise: triage sees senders,
subjects and first lines, never bodies; a body is read only when a turn needs
it and only by the specialist; the catalogue pass reads each document once;
the brief reads summaries and consults for detail. The subscription's data
terms apply to what is sent, and the person deciding to connect a source is
deciding that. The settings page says this in a sentence beside each
credential field, because it is the one thing about this design a person
should not find out later.

## Milestones

Each stops at something that works on its own. Order chosen so the felt problems
go first and the mounts and credentials, which need decisions, come when there
is a screen ready to show them.

0. **Prove the pipes.** Everything below speaks through the scheduler and the
   push channels, and the backlog says an unattended turn has never fired from
   a cron tick in the pod, `notify` has never reached a device from one, and
   ntfy is untested. A week of the existing morning briefing on a real cron,
   pushing a real phone, before anything is built on it.
   Verify: seven consecutive mornings in the inbox, one push per attention
   morning, none for `ok`.
1. **One door.** Merge the rooms, hide the council in settings, remove the
   raccoon and `theirs:`, add the persona line about not explaining itself and
   the "what it can do" card. Nothing new runs; the app gets simpler.
   Verify: every council test passes against the single thread; `/council`
   is gone; a convening turn shows a chip.
2. **Today, profile, journal.** The Today screen on phone and PC over the
   sources that exist (bench, GitHub, schedules), the profile file and editor,
   the nightly journal and its injection.
   Verify: a new thread answers a question about yesterday's decision without
   recall; the brief mentions the profile's people by name.
3. **Feed, pollers, triage, loops.** The feed store, the GitHub notifications
   poller, the bench and schedule items, the Feed screen replacing `/runs`,
   the batched triage turn, the loops store and the "Open" list, pushes from
   triage summaries, `brief_material`, the brief's consultation budget, model
   tiering per role.
   Verify: a review request appears within five minutes, is summarised by
   triage, pushes once, and never again after a restart; "remind me to renew
   the domain on the 3rd" is on Today the next morning and in the brief the
   day it is due.
4. **Mail, calendar, proposals, intake.** IMAP and CalDAV tools, their
   pollers, the mail specialist, drafts, the calendar on Today, the proposal
   card with send and calendar_put behind it, citations as chips, the photo
   and share-sheet intake, the first-day bootstrap.
   Verify: a mail from a profile person is attention within five minutes with
   a summary that cites it; a proposed reply shows the full mail and sends
   only on the tap; a photographed letter opens a loop with the right date.
5. **Documents.** The `ro` mount in Homelab, the nightly extraction, the three
   tools, the documents specialist, the catalogue pass and the loops it opens.
   Verify: "find my car's insurance policy" returns the file and a quote from
   it; a path outside the share is refused; a renewal date in a PDF is on
   Today before the notice period starts.
6. **Finance into the door.** The daily headroom poller and its two rules; the
   finance specialist consulted from the one thread and from the brief.
   Verify: an over-budget category appears once in the feed and in the next
   brief; a loop for a bill closes itself when the transaction lands.
7. **Desk sessions and learning.** The projectless session, `DESK_DIR`, the
   chair starting one; the nightly learning pass over feed states into the
   review queue.
   Verify: "compare these three offers" produces a file at the desk and a
   feed item linking to it; a dismissed newsletter is proposed as a rule the
   next morning and stops being flagged once kept.
8. **Polish.** Brief read aloud, the language line, the evening brief, the
   PC right column.

Milestone 1 also updates SPEC.md's product shape and marks the superseded
sections of ASSISTANT.md.

## Decisions needed

These change what gets built, and are the owner's to make.

- **Mail provider and protocol.** IMAP with an app password is the assumption
  and covers Google Workspace, Fastmail and iCloud. If the account is Google and
  app passwords are disabled by policy, the alternative is the Gmail API with an
  OAuth client, which is a Google Cloud project and a consent screen, and is not
  the assumption.
- **Calendar provider.** CalDAV is the assumption; Google exposes it, so does
  iCloud. If the calendar is Outlook, it does not, and that needs Graph.
- **The share.** Host, export path, protocol (NFS is assumed since the PVC is
  NFS), roughly how many files and what kinds, and whether scans need OCR.
- **The tap.** Sending mail and writing the calendar happen only through a
  proposal card you tap. Say if that is too much friction for some class of
  action (a reply to a person on a card, an event you dictated yourself), in
  which case that class becomes a plain write with an undo window instead.
- **Intake on iOS.** A Shortcut is the share-sheet entry; say if you would
  rather have a forwarding address only.
- **Language.** The profile line decides; say which is the default and whether
  the brief should be Norwegian even while the pod's voice is not.
- **The raccoon.** Removed here. Say if the small chip faces should go too.
- **Finance rules.** Which two or three lines are worth an interruption: a
  category over budget, a balance under a floor, a transaction above an amount.
- **How much of the subscription this may use.** Model tiering puts the brief
  and your own turns on the strongest model; say if the sessions doing the
  engineering should keep priority, in which case the chair drops to `sonnet`
  at `medium` and triage stays on `haiku`.
