import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { useNavigate, useSearchParams } from "react-router";
import type {
  AssistantEntry,
  AssistantThread,
  AssistantThreadSummary,
  ChatRoom,
  CouncilMember,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { MD } from "../components/chat/markdown";
import Portrait, { Face, MEMBER_RULE, MEMBER_TEXT } from "../components/Face";
import Raccoon, { type RaccoonMood } from "../components/Raccoon";
import Sheet from "../components/Sheet";
import TopBar from "../components/TopBar";
import { useGrow } from "../useGrow";
import { canListen, canSpeak, unlockAudio, useSpeech } from "../useSpeech";

/**
 * The composer's icons, drawn rather than typed.
 *
 * These were the glyphs "+", "((•))", "●" and "↑". No mono font ships the last
 * three, so each came from whatever fallback the platform picked and they
 * landed at different weights and sizes in a row four buttons wide — the same
 * fault the top bar's two icons had before they were drawn.
 */
function Ico({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * A chat, in one of the two rooms.
 *
 * One screen for both because they are the same conversation with different
 * people in it: what differs is who may answer, which is decided on the server,
 * and three things here — the roster, the round table, and the way over to the
 * other room. Two copies of a chat screen would be two places to fix a scroll
 * bug in.
 *
 * The thread arrives whole over a websocket rather than being polled or
 * diffed: it is a few kilobytes, and a diff protocol would be the only
 * stateful thing in this app. The POST that sends a turn also returns the
 * thread, so a send works even if the socket is down — the socket is what makes
 * a second device watching the same thread stay in step.
 */

/** The marks that open a meeting: the chair handing a question on. */
const MEETING = new Set(["convene", "discuss", "everyone"]);

function ToolChip({ name, detail }: { name: string; detail: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 self-start rounded-full border border-line bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-muted">
      <span className="flex-none text-run">✓</span>
      <span className="truncate">
        {name}
        {detail && <span className="text-faint"> · {detail}</span>}
      </span>
    </span>
  );
}

/**
 * The way over to the council, drawn under the answer it came with.
 *
 * The assistant cannot ask them, so this is the whole handoff: the question is
 * carried across prefilled and not sent, because the meeting is the person's to
 * spend. Under the bubble rather than above it, unlike the other marks, since
 * it is what to do next rather than what was done.
 */
function Handoff({
  ids,
  members,
  question,
}: {
  ids: string[];
  members: Map<string, CouncilMember>;
  question: string;
}) {
  const navigate = useNavigate();
  const named = ids.map((id) => members.get(id)).filter(Boolean) as CouncilMember[];
  if (!named.length) return null;
  const ask = `${named.length === 1 ? `@${named[0].id} ` : ""}${question}`.trim();
  return (
    <button
      type="button"
      onClick={() => navigate(`/council?ask=${encodeURIComponent(ask)}`)}
      className="tap flex max-w-full items-center gap-2 self-start rounded-full border border-accent/40 bg-accent-tint px-3 py-1.5 font-mono text-[11px] text-accent hover:brightness-110"
    >
      {named.map((m) => (
        <Face key={m.id} face={m.face} className="h-[15px] w-[15px] flex-none" />
      ))}
      <span className="truncate">
        ask {named.map((m) => m.name).join(" and ")} in the council →
      </span>
    </button>
  );
}

/**
 * The question an answer was answering: the nearest thing typed above it.
 *
 * Only the handoff uses it, and it wants what was asked rather than what was
 * replied — the point of carrying it over is that the council gets the question
 * itself, not the assistant's account of it.
 */
function lastAskedBefore(entries: AssistantEntry[], index: number): string {
  for (let i = index; i >= 0; i--) {
    if (entries[i].role === "user" && entries[i].text.trim()) return entries[i].text;
  }
  return "";
}

/**
 * A reply, rendered. Inline code, links and the odd list: the persona asks for
 * prose, but a PR number in backticks or a URL it found is still markdown, and
 * shown as source it was asterisks and angle brackets through the answer.
 */
function Said({ text }: { text: string }) {
  return (
    <div className="text-[14px]">
      <Markdown components={MD}>{text}</Markdown>
    </div>
  );
}

/**
 * Who is speaking, beside what they said.
 *
 * An advisor is named above what it said and ruled in its own colour. A name
 * rather than colour alone: four hues is more than anyone reliably tells apart
 * on a phone, and the name is what you would say out loud anyway. The chair
 * gets the same treatment in the council, where it is one voice among several;
 * in the assistant's room it is the only voice and keeps a bare bubble.
 */
function Bubble({
  who,
  failed,
  children,
}: {
  who?: CouncilMember;
  failed?: boolean;
  children: ReactNode;
}) {
  const colour = who?.colour ?? "teal";
  const bubble = (
    <div
      className={`max-w-[88%] rounded-[14px] rounded-bl-[5px] border px-3 py-2 ${
        failed
          ? "border-fail/40 bg-fail/10 text-text"
          : who
            ? `${MEMBER_RULE[colour]} border-l-2 bg-surface`
            : "border-line bg-surface"
      }`}
    >
      {children}
    </div>
  );
  if (!who) return <div className="flex">{bubble}</div>;
  return (
    <div className="flex items-start gap-2">
      <Portrait face={who.face} colour={colour} size={28} title={who.remit} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`font-mono text-[11px] ${MEMBER_TEXT[colour]}`}>{who.name}</span>
        <div className="flex">{bubble}</div>
      </div>
    </div>
  );
}

function Turn({
  entry,
  who,
  members,
  question,
}: {
  entry: AssistantEntry;
  /** Who said it, when that is worth drawing. Absent for a bare bubble. */
  who?: CouncilMember;
  members: Map<string, CouncilMember>;
  /** The question this answered, carried over when the handoff is tapped. */
  question: string;
}) {
  if (entry.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {entry.images?.map((name) => (
          <img
            key={name}
            src={`/api/assistant/uploads/${name}`}
            alt="attached"
            className="max-h-52 max-w-[82%] rounded-[12px] border border-line"
          />
        ))}
        {entry.text && (
          <div className="max-w-[82%] rounded-[14px] rounded-br-[5px] bg-accent px-3 py-2 text-[14px] font-medium whitespace-pre-wrap text-on-accent">
            {entry.text}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {entry.tools
        .filter((t) => t.name !== "handoff" && !MEETING.has(t.name))
        .map((t, i) => (
          <ToolChip key={i} name={t.name} detail={t.detail} />
        ))}
      {entry.text && (
        <Bubble who={who} failed={entry.failed}>
          <Said text={entry.text} />
        </Bubble>
      )}
      {entry.tools
        .filter((t) => t.name === "handoff")
        .map((t, i) => (
          <Handoff key={i} ids={t.detail.split(",")} members={members} question={question} />
        ))}
    </div>
  );
}

/**
 * The thread cut into what is drawn: a turn, or a meeting.
 *
 * A meeting is several entries — the chair handing the question on, an answer
 * from each advisor, and the chair's last word — and the data has that shape
 * already. Flattened into a row of bubbles it read as one voice with labels;
 * this groups them so the screen shows the same thing the transcript does:
 * who was asked, what each said, and what the chair made of it.
 */
type Block =
  | { kind: "turn"; entry: AssistantEntry; index: number }
  | {
      kind: "meeting";
      opener: AssistantEntry;
      answers: AssistantEntry[];
      verdict: AssistantEntry | null;
      index: number;
    };

function blocksOf(entries: AssistantEntry[]): Block[] {
  const out: Block[] = [];
  let open: Extract<Block, { kind: "meeting" }> | null = null;
  entries.forEach((entry, index) => {
    if (open && entry.role === "assistant") {
      if (entry.member) open.answers.push(entry);
      else open.verdict = entry;
      return;
    }
    open = null;
    if (entry.role === "assistant" && entry.tools.some((t) => MEETING.has(t.name))) {
      open = { kind: "meeting", opener: entry, answers: [], verdict: null, index };
      out.push(open);
      return;
    }
    out.push({ kind: "turn", entry, index });
  });
  return out;
}

/** What the chair did with the question, as a sentence. */
function meetingLabel(opener: AssistantEntry): string {
  const mark = opener.tools.find((t) => MEETING.has(t.name));
  if (!mark) return "";
  return mark.name === "discuss"
    ? `round table: ${mark.detail}`
    : mark.name === "everyone"
      ? `everyone: ${mark.detail}`
      : `asks ${mark.detail}`;
}

function Meeting({
  block,
  members,
  chair,
  question,
  tail,
}: {
  block: Extract<Block, { kind: "meeting" }>;
  members: Map<string, CouncilMember>;
  chair?: CouncilMember;
  question: string;
  /** What is still happening in this meeting, drawn inside it. */
  tail?: ReactNode;
}) {
  const asked = block.opener.tools.find((t) => MEETING.has(t.name))?.detail ?? "";
  // The mark names them by display name, so that is how their faces are found.
  const names = asked.replace(/\s*\(\+\d+ not asked\)$/, "").split(", ");
  const faces = [...members.values()].filter((m) => !m.chair && names.includes(m.name));
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-accent/30 bg-accent-tint px-3 py-3">
      <div className="flex items-center gap-2 font-mono text-[11px] text-accent">
        <span className="flex flex-none -space-x-1.5">
          {faces.slice(0, 4).map((m) => (
            <Face
              key={m.id}
              face={m.face}
              className={`h-[18px] w-[18px] ${MEMBER_TEXT[m.colour]}`}
            />
          ))}
        </span>
        <span className="truncate">{meetingLabel(block.opener)}</span>
      </div>
      {block.opener.tools
        .filter((t) => !MEETING.has(t.name))
        .map((t, i) => (
          <ToolChip key={i} name={t.name} detail={t.detail} />
        ))}
      {block.answers.map((e) => (
        <Turn
          key={e.id}
          entry={e}
          who={e.member ? members.get(e.member) : undefined}
          members={members}
          question={question}
        />
      ))}
      {block.verdict && (
        <div className="border-t border-accent/20 pt-3">
          <Turn entry={block.verdict} who={chair} members={members} question={question} />
        </div>
      )}
      {tail}
    </div>
  );
}

/**
 * Who is in the room, and who is answering right now.
 *
 * It earns its place by making the council discoverable: without it the only
 * way to learn that `@michael` is a thing you can type is to be told. The
 * round-table switch sits here too, beside @all, because it only means
 * anything when more than one of them answers: how to ask and whom to ask are
 * one decision, made in the same place.
 */
function Roster({
  members,
  speaking,
  addressed,
  roundTable,
  onPick,
  onRoundTable,
}: {
  members: CouncilMember[];
  speaking: string[];
  addressed: string | null;
  roundTable: boolean;
  onPick: (id: string) => void;
  onRoundTable: () => void;
}) {
  if (members.length < 2) return null;
  const advisors = members.filter((m) => !m.chair);
  const shown = members.find((m) => m.id === (addressed ?? "")) ?? null;
  const asked = addressed === "all";
  const anySpeaking = speaking.length > 1;
  return (
    <div className="px-1 pb-2">
      <div className="flex flex-wrap gap-1.5">
        {members.map((m) => {
          const busy = speaking.includes(m.id);
          const picked = addressed === m.id || (m.chair && !addressed);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onPick(m.id)}
              title={m.remit}
              aria-pressed={picked}
              className={`tap flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                busy
                  ? `${MEMBER_RULE[m.colour]} ${MEMBER_TEXT[m.colour]} animate-pulse-run`
                  : picked
                    ? `${MEMBER_RULE[m.colour]} ${MEMBER_TEXT[m.colour]}`
                    : "border-line text-faint hover:border-line-strong"
              }`}
            >
              {/* Only two states here, and neither of them is invented: a face
                  is talking or it is not. Drawing the ones you have not picked
                  as "thinking" would say something about them that is not
                  true. */}
              <Face
                face={m.face}
                mood={busy ? "speaking" : "idle"}
                className="h-[18px] w-[18px] flex-none"
              />
              <span className="flex flex-col items-start leading-tight">
                <span>
                  {m.chair ? m.name : `@${m.id}`}
                  {busy && " …"}
                </span>
                {/* What they are for, where there is room for it. On a phone
                    the picked one's remit is written out underneath instead. */}
                {!m.chair && (
                  <span className="hidden max-w-[150px] truncate font-sans text-[10.5px] text-faint min-[620px]:block">
                    {m.remit}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        {/* The room itself, which is a thing you can address. Without it the
            only way to learn that a question can go to everybody is to be told,
            and the chair answering one meant for all of them reads as rudeness
            rather than as a routing call. */}
        {advisors.length > 1 && (
          <button
            type="button"
            onClick={() => onPick("all")}
            title="put it to the whole room: everybody answers"
            aria-pressed={asked}
            className={`tap flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              asked || anySpeaking
                ? "border-accent/50 text-accent"
                : "border-line text-faint hover:border-line-strong"
            }`}
          >
            <span className="flex flex-none -space-x-1.5">
              {advisors.slice(0, 3).map((m) => (
                <Face
                  key={m.id}
                  face={m.face}
                  mood={speaking.includes(m.id) ? "speaking" : "idle"}
                  className={`h-[18px] w-[18px] ${MEMBER_TEXT[m.colour]}`}
                />
              ))}
            </span>
            @all
          </button>
        )}
        {advisors.length > 1 && (
          <button
            type="button"
            onClick={onRoundTable}
            title={
              roundTable
                ? "back to one answer each, in parallel"
                : "have them talk it over: each one answers having read the others"
            }
            aria-pressed={roundTable}
            className={`tap flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              roundTable
                ? "border-accent/50 text-accent"
                : "border-line text-faint hover:border-line-strong"
            }`}
          >
            round table
          </button>
        )}
      </div>
      {/* What the one you have picked is for. A remit is one line and it is the
          answer to "why would I ask them", which a name on its own is not. */}
      {asked ? (
        <div className="mt-1.5 text-[12px] text-accent">
          everybody answers, and the chair has the last word
          {roundTable && ", each having read the ones before"}
        </div>
      ) : (
        shown && (
          <div className={`mt-1.5 text-[12px] min-[620px]:hidden ${MEMBER_TEXT[shown.colour]}`}>
            {shown.remit}
          </div>
        )
      )}
    </div>
  );
}

/**
 * Every conversation this room has had, and the way back into one.
 *
 * Fetched when opened rather than polled: the list changes when a thread is
 * started, which is something you did a moment ago on this same screen.
 */
function Threads({
  room,
  current,
  onOpen,
  onClose,
}: {
  room: string;
  current: string | undefined;
  onOpen: (thread: AssistantThread) => void;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<AssistantThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<AssistantThreadSummary[]>(`/api/assistant/threads${room}`)
      .then(setThreads)
      .catch((e: Error) => setError(e.message));
  }, [room]);

  async function open(id: string) {
    try {
      onOpen(
        await api<AssistantThread>(`/api/assistant/threads/${id}/open${room}`, {
          method: "POST",
        }),
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Sheet title="Threads" sub="Pick one up where it was left." onClose={onClose}>
      {error && <div className="mb-2 font-mono text-[12px] text-fail">{error}</div>}
      {threads === null && !error && <div className="text-sm text-muted">reading…</div>}
      {threads?.length === 0 && <div className="text-sm text-muted">nothing said in here yet</div>}
      <div className="flex flex-col gap-1.5">
        {threads?.map((t) => {
          const here = t.conversationId === current;
          return (
            <button
              key={t.conversationId}
              type="button"
              onClick={() => void open(t.conversationId)}
              disabled={here}
              className={`tap flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left hover:border-line-strong disabled:cursor-default ${
                here ? "border-accent/40 bg-accent-tint" : "border-line bg-surface-2"
              }`}
            >
              <span className="w-full truncate text-[13.5px]">{t.title}</span>
              <span className="font-mono text-[11px] text-faint">
                {here ? "open now" : agoLabel(t.at)} · {t.turns} turn{t.turns === 1 ? "" : "s"}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

/** A toolbar toggle: two states, remembered or not, and never the main event. */
function Toggle({
  on,
  title,
  onClick,
  children,
}: {
  on: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`rounded-md px-1.5 py-1 font-medium hover:text-text ${
        on ? "text-accent" : "text-faint"
      }`}
    >
      {children}
    </button>
  );
}

export default function Chat({ room }: { room: ChatRoom }) {
  const council = room === "council";
  // Everything that names a room in a URL, in one place: the query the server
  // reads, and the socket the thread arrives on.
  const q = council ? "?room=council" : "";
  /**
   * A question handed over from the assistant: it starts in the field, unsent.
   *
   * Prefilled rather than asked, because the meeting is the thing that costs
   * and the person is the one who decides to spend it. Taken as the field's
   * initial value rather than pushed in afterwards, so there is no render where
   * the field is empty and no way for it to overwrite something being typed.
   */
  const [params, setParams] = useSearchParams();
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [text, setText] = useState(() => params.get("ask") ?? "");
  const grow = useGrow(text);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Hands-free: replies are read out, and the microphone reopens when the
  // reading stops, so a whole exchange happens without touching the screen.
  const [voiceMode, setVoiceMode] = useState(false);
  // Read replies out without any of the rest of it. Voice mode answers "I want
  // to talk to it"; this answers "I want to hear it", which is the case where
  // you type a question and then look away. Kept apart because the coupling was
  // the complaint: wanting to be read to meant having the microphone open.
  // Remembered per device, like the raccoon — whoever wants it wants it always.
  const [speakReplies, setSpeakReplies] = useState(
    () => localStorage.getItem("vk.assistant.speak") === "1",
  );
  /**
   * Ask the council to talk this one over instead of answering in parallel.
   *
   * Not remembered across reloads, unlike the two above: it is the one switch
   * here that costs real money every time it is on — the advisors answer one
   * after another, each carrying what the others said — so it should not
   * survive a session you have forgotten you started.
   */
  const [roundTable, setRoundTable] = useState(false);
  // Off unless asked for, and remembered per device: it is decoration, and the
  // people who want it want it every time.
  const [showRaccoon, setShowRaccoon] = useState(
    () => localStorage.getItem("vk.assistant.raccoon") === "1",
  );
  /**
   * Entries already read out. A set rather than one id, because a meeting lands
   * several at once and "the last one" would silently drop the rest.
   */
  const spokenRef = useRef<Set<string>>(new Set());
  // The roster changes when somebody edits it in settings, which is rarely, so
  // it is polled slowly rather than pushed. Both rooms need it: the council to
  // show who is in it, and the assistant to draw the face of whoever it hands a
  // question to.
  const { data: roster } = usePoll<CouncilMember[]>("/api/council", 120_000);
  const members = roster ?? [];
  const byId = new Map(members.map((m) => [m.id, m]));
  // The chair is drawn as one voice among several only where there are
  // several: in the assistant's room it is the only one and stays bare.
  const chair = council && members.length > 1 ? members.find((m) => m.chair) : undefined;

  // Dropped from the URL once it is in the field, so a reload does not put a
  // question back that has already been asked or thrown away.
  useEffect(() => {
    if (params.has("ask")) setParams({}, { replace: true });
  }, [params, setParams]);

  // One socket for the life of the screen. It only ever carries whole threads,
  // so a dropped frame costs nothing: the next one is complete.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/assistant/stream${q}`);
    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        setThread(JSON.parse(e.data) as AssistantThread);
      } catch {
        // A frame we cannot read is not worth taking the screen down for.
      }
    };
    // The socket sends the thread on connect, so there is no separate fetch.
    return () => ws.close();
  }, [q]);

  // Follow the conversation as it grows, the way a chat is expected to.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread?.entries.length, thread?.status, thread?.live]);

  const thinking = thread?.status === "thinking";

  /** Upload first, then send names: the server owns where an image lands. */
  async function attach(files: FileList | File[]) {
    const ok = ["png", "jpg", "jpeg", "gif", "webp"];
    for (const file of Array.from(files).slice(0, 4)) {
      const type = (file.type.split("/")[1] ?? "").toLowerCase();
      if (!ok.includes(type)) {
        setError(`${file.name} is not an image I can send`);
        continue;
      }
      try {
        const { name } = await api<{ name: string }>(`/api/assistant/uploads?type=${type}`, {
          method: "POST",
          headers: { "content-type": file.type },
          body: await file.arrayBuffer(),
          timeoutMs: 60_000,
        });
        setPending((p) => [...p, name]);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }

  const speech = useSpeech((said) => void send(said));
  const { listening, speaking, transcribing } = speech;

  /**
   * Read what has not been read yet, in order, each in its speaker's voice.
   *
   * A meeting produces several replies at once, so this is a queue rather than
   * "the last one". Reading them all only became the right answer once each
   * advisor had a voice of its own: in one voice it is four answers that sound
   * like one person changing their mind, which is why it used to read the
   * chair's summary alone.
   *
   * Keyed on entry ids already spoken, so a reconnecting socket redelivering
   * the whole thread cannot read anything twice.
   */
  useEffect(() => {
    if ((!voiceMode && !speakReplies) || thinking) return;
    const pending = (thread?.entries ?? []).filter(
      (e) => e.role === "assistant" && e.text && !spokenRef.current.has(e.id),
    );
    if (!pending.length) return;
    for (const e of pending) spokenRef.current.add(e.id);

    const readFrom = (i: number) => {
      const entry = pending[i];
      if (!entry) {
        // Only hands-free reopens the microphone. Reading a typed exchange
        // aloud must not start listening, or the next thing typed competes
        // with an open mic and the reply gets sent twice.
        if (voiceMode) void speech.listen();
        return;
      }
      const who = entry.member ? byId.get(entry.member) : undefined;
      speech.speak(entry.text, () => readFrom(i + 1), who?.voice || undefined);
    };
    readFrom(0);
  }, [thread, voiceMode, speakReplies, thinking, speech, byId]);

  /**
   * Read replies aloud, without opening the microphone.
   *
   * The short utterance on the way on is not a flourish: iOS will only speak
   * from inside a user gesture until it has spoken once, so a silent switch
   * would be a switch that does nothing until the turn after next. It also
   * tells you the sound is on and which voice you are getting, before you have
   * asked anything.
   */
  function toggleSpeakReplies() {
    const next = !speakReplies;
    setSpeakReplies(next);
    localStorage.setItem("vk.assistant.speak", next ? "1" : "0");
    if (next) {
      // Whatever is already on screen has been read, or was never meant to be.
      for (const e of thread?.entries ?? []) spokenRef.current.add(e.id);
      // This tap is the user gesture iOS wants before any audio may play
      // without one — for the pod's voice as much as the browser's, since a
      // reply arrives long after any tap.
      unlockAudio();
      speech.speak("ok");
    } else if (!voiceMode) {
      speech.cancelSpeech();
    }
  }

  function toggleVoice() {
    if (voiceMode) {
      setVoiceMode(false);
      speech.cancelSpeech();
      speech.stopListening();
      return;
    }
    // Turning it on is the user gesture iOS requires before it will ever speak,
    // so prime it here rather than on the first reply.
    setVoiceMode(true);
    for (const e of thread?.entries ?? []) spokenRef.current.add(e.id);
    void speech.listen();
  }

  async function send(spoken?: string) {
    const value = (spoken ?? text).trim();
    if ((!value && !pending.length) || thinking) return;
    if (!spoken) setText("");
    setError(null);
    try {
      setThread(
        await api<AssistantThread>(`/api/assistant/messages${q}`, {
          method: "POST",
          body: JSON.stringify({
            text: value || "(see image)",
            images: pending,
            roundTable,
          }),
          // A turn does real work; the default 15s would abandon every one of
          // them while the socket kept showing it running.
          timeoutMs: 11 * 60_000,
        }),
      );
      setPending([]);
    } catch (e) {
      setError((e as Error).message);
      if (!spoken) setText(value);
    }
  }

  async function stop() {
    await api(`/api/assistant/stop${q}`, { method: "POST" }).catch(() => {});
  }

  async function newThread() {
    setThread(null);
    await api(`/api/assistant/new${q}`, { method: "POST" }).catch(() => {});
  }

  /** Opening an old thread: what was read is already whatever is read aloud. */
  function openThread(opened: AssistantThread) {
    for (const e of opened.entries) spokenRef.current.add(e.id);
    setThread(opened);
  }

  // Every turn re-sends the whole thread, so a long one gets steadily more
  // expensive to continue. Nothing truncates it automatically — dropping the
  // middle of a conversation silently is worse than saying it is getting long —
  // so this is the nudge to start a fresh one when the subject has changed.
  const turns = thread?.entries.filter((e) => e.role === "user").length ?? 0;
  /**
   * What the thread actually costs, which is not the same as how often you have
   * typed. Every reply is a model call carrying the whole conversation, and a
   * meeting is several: counting questions would put the warning well after the
   * spending it is meant to warn about.
   */
  const calls = thread?.entries.filter((e) => e.role === "assistant").length ?? 0;
  const long = calls >= 15;

  /**
   * The mouth moves when there are words, and only then: while it is writing
   * them, or while they are being read aloud. Thinking is not talking.
   *
   * An earlier version flapped for the whole turn, on the theory that the mouth
   * stopping between the last token and the end of the turn would read as a
   * stutter. It does not — thinking and idle draw the same gentle sway, so
   * there was nothing to smooth over, and flapping before it had said anything
   * just looked like it was chewing.
   */
  const mood: RaccoonMood = listening
    ? "listening"
    : speaking || thread?.live
      ? "speaking"
      : thinking || transcribing
        ? "thinking"
        : "idle";

  const blocks = blocksOf(thread?.entries ?? []);
  const last = blocks[blocks.length - 1];
  // A meeting still running draws its own progress inside its card, so what
  // is happening stays with the question it is happening to.
  const inMeeting = thinking && last?.kind === "meeting";

  /* Who is still out. An advisor's tokens are deliberately not streamed:
     three of them writing at once onto a phone is noise, and the names say
     the same thing for none of the traffic. The sentence being written is the
     chair's, and says so where the chair is one voice among several; it is
     replaced by the stored entry the moment the model finishes it, so it
     never appears twice. */
  const progress = thinking && (
    <>
      {thread?.speaking?.length ? (
        <div className="flex flex-wrap items-center gap-2 px-1 font-mono text-[12px] text-faint">
          {thread.speaking.map((id) => {
            const m = byId.get(id);
            return m ? (
              <Portrait
                key={id}
                face={m.face}
                colour={m.colour}
                mood="speaking"
                size={24}
                title={m.name}
              />
            ) : null;
          })}
          {thread.speaking.map((id) => byId.get(id)?.name ?? id).join(", ")} answering…
        </div>
      ) : null}
      {thread?.live && (
        <Bubble who={chair}>
          {/* Plain while it is being written: markdown half-typed re-flows on
              every token, and the stored entry it becomes is rendered. */}
          <div className="text-[14px] whitespace-pre-wrap">
            {thread.live}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-blink bg-accent align-[-2px]" />
          </div>
        </Bubble>
      )}
      {!thread?.live && (
        <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          thinking…
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar crumb={[{ label: council ? "council" : "assistant" }]} back="/" />

      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] pt-4 pb-3">
        {showRaccoon && (
          <div className="flex flex-none justify-center pt-1 pb-2">
            <Raccoon mood={mood} className="w-[170px]" />
          </div>
        )}

        {/* Always present: the raccoon toggle lives here, and gating the whole
            row on having turns meant it did not exist on a fresh thread. */}
        {/* The count reads left, the controls sit together on the right. The
            two decorations are plain words; the two that change which thread
            you are in are the bordered ones, so the row reads as one pair of
            actions and not four toggles of the same weight. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-faint">
          {turns > 0 && (
            <span>
              {turns} turn{turns === 1 ? "" : "s"}
              {calls > turns && ` · ${calls} replies`}
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <Toggle
              on={showRaccoon}
              title={showRaccoon ? "hide the raccoon" : "show the raccoon"}
              onClick={() => {
                const next = !showRaccoon;
                setShowRaccoon(next);
                localStorage.setItem("vk.assistant.raccoon", next ? "1" : "0");
              }}
            >
              raccoon
            </Toggle>
            {canSpeak() && (
              <Toggle
                on={speakReplies}
                title={
                  speakReplies
                    ? "stop reading replies aloud"
                    : "read every reply aloud, including ones you typed"
                }
                onClick={toggleSpeakReplies}
              >
                read aloud
              </Toggle>
            )}
            <button
              onClick={() => setBrowsing(true)}
              disabled={thinking}
              className="ml-1 rounded-md border border-line px-2 py-1 font-medium text-muted hover:border-line-strong hover:text-text disabled:opacity-40"
            >
              threads
            </button>
            {turns > 0 && (
              <button
                onClick={() => void newThread()}
                disabled={thinking}
                className="rounded-md border border-line px-2 py-1 font-medium text-muted hover:border-line-strong hover:text-text disabled:opacity-40"
              >
                new thread
              </button>
            )}
          </span>
        </div>

        {thread === null && <div className="text-sm text-muted">connecting…</div>}

        {thread?.entries.length === 0 && (
          <div className="mt-6 text-center">
            <div className="font-mono text-[13px] text-muted">nothing said yet</div>
            <p className="mx-auto mt-2 max-w-[42ch] text-[13.5px] text-faint">
              {council
                ? "Put a question to the room. The chair hands it to whoever it belongs to; @all asks every one of them, and an @id asks that one alone."
                : "Ask what needs you, or tell it something to remember. It can read your projects, sessions and runs, and it will say when a question is really the council's."}
            </p>
          </div>
        )}

        {thread &&
          blocks.map((b, i) =>
            b.kind === "meeting" ? (
              <Meeting
                key={b.opener.id}
                block={b}
                members={byId}
                chair={chair}
                question={lastAskedBefore(thread.entries, b.index)}
                tail={inMeeting && i === blocks.length - 1 ? progress : undefined}
              />
            ) : (
              <Turn
                key={b.entry.id}
                entry={b.entry}
                who={b.entry.member ? byId.get(b.entry.member) : chair}
                members={byId}
                question={lastAskedBefore(thread.entries, b.index)}
              />
            ),
          )}

        {!inMeeting && progress}

        {voiceMode && (
          <div className="flex items-center gap-2.5 rounded-[11px] border border-accent/40 bg-accent/[.06] px-3 py-2 font-mono text-[12px]">
            <span
              className={`h-2 w-2 flex-none rounded-full ${
                listening ? "animate-pulse bg-accent" : speaking ? "bg-run" : "bg-idle"
              }`}
            />
            <span className="min-w-0 flex-1 truncate text-muted">
              {listening
                ? "listening…"
                : transcribing
                  ? "transcribing…"
                  : speaking
                    ? "speaking…"
                    : "voice mode on"}
            </span>
            <button onClick={toggleVoice} className="flex-none text-faint hover:text-text">
              end
            </button>
          </div>
        )}

        <div ref={endRef} />
      </main>

      <div className="mx-auto w-full max-w-[760px] flex-none px-[18px] pb-[max(14px,env(safe-area-inset-bottom))]">
        {error && <div className="mb-2 font-mono text-[12px] text-fail">{error}</div>}
        {/* Said where the next turn is typed, with the remedy beside it, rather
            than as a coloured word in the toolbar you have scrolled past. */}
        {long && !thinking && (
          <div className="mb-2 flex items-center gap-3 rounded-lg border border-wait/40 bg-wait/10 px-3 py-2 text-[12.5px] text-wait">
            <span className="min-w-0 flex-1">
              {calls} replies in this thread, and every new one carries all of them. If the subject
              has moved on, start fresh.
            </span>
            <button
              onClick={() => void newThread()}
              className="flex-none rounded-md border border-wait/50 px-2 py-1 font-medium hover:brightness-110"
            >
              new thread
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map((name) => (
              <div key={name} className="relative">
                <img
                  src={`/api/assistant/uploads/${name}`}
                  alt="attached"
                  className="h-16 w-16 rounded-lg border border-line object-cover"
                />
                <button
                  onClick={() => setPending((p) => p.filter((n) => n !== name))}
                  aria-label="remove attachment"
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full border border-line bg-surface-2 font-mono text-[11px] text-muted hover:text-fail"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void attach(e.target.files);
            e.target.value = "";
          }}
        />
        {council && (
          <Roster
            members={members}
            speaking={thread?.speaking ?? []}
            addressed={/^@([a-z][a-z0-9-]*)/.exec(text.trim())?.[1] ?? null}
            roundTable={roundTable}
            onPick={(id) => {
              // The chair is who you get by default, so tapping it clears the
              // address rather than adding one.
              const stripped = text.replace(/^@[a-z][a-z0-9-]*\s*/, "");
              setText(id === "chair" ? stripped : `@${id} ${stripped}`);
            }}
            onRoundTable={() => setRoundTable((r) => !r)}
          />
        )}
        {/* Field on top, controls on their own row underneath. In one row the
            four buttons crowded the field from both sides and the send button
            drifted with the field's width; here each control has a fixed home
            and the field gets the full width at any size. */}
        <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
          <textarea
            ref={grow}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, shift+enter breaks the line. On a phone the key is
              // a newline either way, which is why the button is always there.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              // A screenshot pasted from the clipboard is the desktop half of
              // the attach button.
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void attach(files);
              }
            }}
            rows={1}
            placeholder={
              listening ? "listening…" : thinking ? "working…" : "Ask, or tell me something…"
            }
            aria-label="message the assistant"
            className="block max-h-32 min-h-[26px] w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={thinking}
              aria-label="attach an image"
              className="tap-sq flex flex-none items-center justify-center rounded-lg border border-line px-2.5 py-2 text-muted hover:border-line-strong hover:text-text disabled:opacity-40"
            >
              <Ico>
                <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </Ico>
            </button>
            <span className="flex-1" />
            {canSpeak() && canListen() && !thinking && (
              <button
                onClick={toggleVoice}
                aria-label={voiceMode ? "end voice mode" : "start voice mode"}
                title="hands free: it reads replies out and listens again"
                className={`tap-sq flex flex-none items-center justify-center rounded-lg border px-2.5 py-2 hover:border-line-strong ${
                  voiceMode ? "border-accent bg-accent-tint text-accent" : "border-line text-muted"
                }`}
              >
                <Ico>
                  <path d="M11 5 6 9H2v6h4l5 4z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                </Ico>
              </button>
            )}
            {canListen() && !thinking && !voiceMode && (
              <button
                onClick={() => (listening ? speech.stopListening() : void speech.listen())}
                aria-label={listening ? "stop dictating" : "dictate"}
                title="dictate into the field"
                className={`tap-sq flex flex-none items-center justify-center rounded-lg border px-2.5 py-2 hover:border-line-strong ${
                  listening
                    ? "animate-pulse border-accent bg-accent-tint text-accent"
                    : "border-line text-muted"
                }`}
              >
                <Ico>
                  <rect x="9" y="2" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </Ico>
              </button>
            )}
            {thinking ? (
              <button
                onClick={() => void stop()}
                className="tap-sq flex flex-none items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[13px] font-semibold text-muted hover:border-line-strong hover:text-text"
              >
                <Ico>
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </Ico>
                Stop
              </button>
            ) : (
              // A filled circle rather than a rounded rectangle: it is the one
              // action in this row that commits something, and at four buttons
              // wide the outlined ones stopped reading as a set with it.
              <button
                onClick={() => void send()}
                disabled={!text.trim() && !pending.length}
                aria-label="send"
                className="tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:bg-surface-2 disabled:text-faint"
              >
                <Ico>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </Ico>
              </button>
            )}
          </div>
        </div>
      </div>

      {browsing && (
        <Threads
          room={q}
          current={thread?.conversationId}
          onOpen={openThread}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
