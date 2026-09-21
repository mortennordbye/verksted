import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AssistantThread,
  AssistantThreadSummary,
  CalendarEvent,
  CouncilMember,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import BrowserPane from "../components/BrowserPane";
import { Link } from "react-router";
import Portrait, { MEMBER_TEXT } from "../components/Face";
import Icon, { type IconName } from "../components/Icon";
import Room from "../components/Room";
import Sheet from "../components/Sheet";
import Tabs from "../components/Tabs";
import TopBar from "../components/TopBar";
import { readStored, writeStored } from "../storage";
import { useConfirm } from "../useConfirm";
import Skeleton, { SkeletonList } from "../components/Skeleton";
import { useAssistantStream } from "../useAssistantStream";
import { useGrow } from "../useGrow";
import { canListen, canSpeak, useSpeech } from "../useSpeech";
import { useVisualViewport } from "../useVisualViewport";

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
 * The conversation, and the only room there is.
 *
 * One thread, whoever answers in it: the assistant alone, or a specialist it
 * brings in, whose answer lands as a card in their own colour. The council
 * was a second screen with a thread of its own; that made the person route
 * every question before asking it, so it is gone, and what it was for happens
 * here without being asked for. Addressing one of them by name is still
 * possible — typing `@id` first, or "ask" in the specialists panel, writes the
 * `@id` the server reads — but it is a shortcut past a decision that is made
 * for you, not one you have to make.
 *
 * The thread arrives whole over a websocket rather than being polled or
 * diffed: it is a few kilobytes, and a diff protocol would be the only
 * stateful thing in this app. The POST that sends a turn also returns the
 * thread, so a send works even if the socket is down — the socket is what makes
 * a second device watching the same thread stay in step.
 */

/** The chair before the roster has arrived, so the room has a seat to draw. */
const NO_CHAIR: CouncilMember = {
  id: "chair",
  name: "Assistant",
  remit: "",
  persona: "",
  model: "",
  effort: "low",
  tools: [],
  web: false,
  colour: "amber",
  face: "raccoon",
  voice: "",
  chair: true,
  enabled: true,
};

/**
 * Every conversation this room has had: switch to one, start one, delete one,
 * or clear out the old ones.
 *
 * Fetched when opened and again after each change rather than polled: the
 * list only changes by something done on this sheet. Deleting asks first,
 * since a thread cannot be brought back; deleting the open one starts a fresh
 * thread in its place, which the socket brings to the screen.
 */
function Threads({
  current,
  onOpen,
  onNew,
  onClose,
}: {
  current: string | undefined;
  onOpen: (thread: AssistantThread) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<AssistantThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [confirm, dialog] = useConfirm();
  useEffect(() => {
    api<AssistantThreadSummary[]>("/api/assistant/threads")
      .then(setThreads)
      .catch((e: Error) => setError(e.message));
  }, [version]);

  const others = (threads ?? []).filter((t) => t.conversationId !== current);

  async function open(id: string) {
    try {
      onOpen(
        await api<AssistantThread>(`/api/assistant/threads/${id}/open`, {
          method: "POST",
        }),
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(t: AssistantThreadSummary) {
    const here = t.conversationId === current;
    const ok = await confirm({
      title: "Delete this thread?",
      body: `"${t.title}" and everything said in it.${
        here ? " It is the one open now, so a new thread starts." : ""
      } This cannot be undone.`,
      action: "delete",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api(`/api/assistant/threads/${t.conversationId}`, { method: "DELETE" });
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function clearOld() {
    const n = others.length;
    const ok = await confirm({
      title: `Delete ${n} old thread${n === 1 ? "" : "s"}?`,
      body: "Every thread except the one open now, and everything said in them. This cannot be undone.",
      action: `delete ${n}`,
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api("/api/assistant/threads/clear", { method: "POST", body: JSON.stringify({}) });
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Sheet
        title="Threads"
        sub="Switch, start fresh, or clear out the old ones."
        onClose={onClose}
      >
        <button
          type="button"
          onClick={() => {
            onNew();
            onClose();
          }}
          className="tap mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2 text-[13.5px] font-semibold text-on-accent hover:brightness-110"
        >
          <Icon name="compose" size={15} />
          new thread
        </button>
        {error && <div className="mb-2 text-[12.5px] text-fail">{error}</div>}
        {threads === null && !error && (
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="block h-[52px] rounded-xl bg-surface-2/60" />
            ))}
          </div>
        )}
        {threads?.length === 0 && (
          <div className="text-sm text-muted">nothing said in here yet</div>
        )}
        <div className="flex flex-col gap-1.5">
          {threads?.map((t) => {
            const here = t.conversationId === current;
            return (
              <div
                key={t.conversationId}
                className={`flex items-center rounded-xl ${
                  here
                    ? "bg-accent-tint ring-1 ring-accent/30"
                    : "bg-surface-2/60 hover:bg-surface-2"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void open(t.conversationId)}
                  disabled={here}
                  title={here ? "the thread open now" : "open this thread"}
                  className="tap flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left disabled:cursor-default"
                >
                  <span className="w-full truncate text-[13.5px]">{t.title}</span>
                  <span className="font-mono text-[11px] text-faint">
                    {here ? "open now" : agoLabel(t.at)} · {t.turns} turn
                    {t.turns === 1 ? "" : "s"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void remove(t)}
                  title="delete this thread"
                  aria-label={`delete the thread "${t.title}"`}
                  className="tap-sq mr-1 flex h-9 w-9 flex-none items-center justify-center rounded-lg text-faint hover:bg-fail/10 hover:text-fail"
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            );
          })}
        </div>
        {others.length > 0 && (
          <button
            type="button"
            onClick={() => void clearOld()}
            className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-line px-3 py-2 text-[13px] text-muted hover:border-fail/50 hover:text-fail"
          >
            <Icon name="trash" size={14} />
            clear old threads ({others.length})
          </button>
        )}
      </Sheet>
      {dialog}
    </>
  );
}

/**
 * One of the header's controls, as an icon with its words in the tooltip.
 *
 * Icons alone because the row also carries who you are talking to, and five
 * worded buttons beside a name did not share a line. `on` is only for the
 * ones that stay on (reading aloud, an open panel), which light up; the rest
 * are actions and carry no pressed state at all.
 */
function ToolButton({
  icon,
  title,
  onClick,
  on,
  disabled,
}: {
  icon: IconName;
  title: string;
  onClick: () => void;
  on?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={on}
      className={`tap-sq flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
        on ? "bg-accent-tint text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

const dockBtn =
  "tap-hit flex-none rounded-lg bg-surface px-2.5 py-1 font-medium text-muted hover:bg-surface-2 hover:text-text";

/**
 * A panel beside the conversation rather than over it: the chair's browser, or
 * the calendar it writes to.
 *
 * Both are for watching what it does while reading what it says, so on a
 * desktop the panel takes the right half and the thread moves into the left.
 * A phone has no second half to give, so there it is the whole screen.
 * Fullscreen on a desktop is for when the panel is what is being read.
 *
 * No Escape to close: the browser relays keys into the remote page, and an
 * Escape meant for a dialog over there would take the whole panel away here.
 */
function Dock({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [full, setFull] = useState(false);
  return (
    <aside
      aria-label={title}
      className={`fixed inset-0 z-50 flex flex-col bg-bg ${
        full ? "" : "desk:left-1/2 desk:z-30 desk:border-l desk:border-line"
      }`}
    >
      <div className="flex flex-none items-center gap-2 border-b border-line px-3 pt-[max(8px,env(safe-area-inset-top))] pb-2 text-[12px]">
        <span className="flex-none font-semibold">{title}</span>
        <span className="min-w-0 flex-1 truncate text-faint">{sub}</span>
        <button
          onClick={() => setFull((f) => !f)}
          className={`${dockBtn} hidden items-center gap-1.5 desk:flex`}
        >
          <Icon name={full ? "shrink" : "expand"} size={14} />
          {full ? "exit fullscreen" : "fullscreen"}
        </button>
        <button onClick={onClose} className={`${dockBtn} flex items-center gap-1.5`}>
          <Icon name="close" size={14} />
          close
        </button>
      </div>
      {children}
    </aside>
  );
}

function BrowserView() {
  const ref = useRef<HTMLDivElement | null>(null);
  // The document is what scrolls on this screen, so a wheel over the remote
  // page scrolled the thread behind it as well. The canvas still gets the
  // event; only the page's own default is cancelled. Native and non-passive,
  // since React's wheel listener is passive and cannot cancel anything.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hold = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", hold, { passive: false });
    return () => el.removeEventListener("wheel", hold);
  }, []);
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      <BrowserPane wsPath="/api/assistant/browser" />
    </div>
  );
}

/** Local midnight of a date: the grid's days are the bench's days. */
function midnight(d: Date, plusDays = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays);
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The calendar as a month, so what the chair just added, moved or removed can
 * be seen landing. Read again whenever the thread grows, since that is the
 * moment it may have changed.
 */
function Month({ refresh }: { refresh: number }) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [picked, setPicked] = useState(() => midnight(new Date()).getTime());
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Monday first, always six rows: every month fits, and the grid keeps its
  // height from one month to the next.
  const first = midnight(month, -((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => midnight(first, i));
  const from = first.toISOString();
  const to = midnight(first, 42).toISOString();

  useEffect(() => {
    let live = true;
    api<CalendarEvent[]>(
      `/api/calendar/range?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`,
    )
      .then((e) => {
        if (!live) return;
        setEvents(e);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, refresh]);

  /** Everything that touches a day, so an all-day or overnight event shows on each. */
  const on = (day: Date) => {
    const start = day.getTime();
    const end = midnight(day, 1).getTime();
    return (events ?? []).filter((e) => Date.parse(e.start) < end && Date.parse(e.end) > start);
  };
  const today = midnight(new Date()).getTime();
  const pickedDay = new Date(picked);
  const pickedEvents = on(pickedDay);
  const go = (months: number) =>
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + months, 1));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      <div className="mb-2.5 flex items-center gap-1.5">
        <span className="text-[15px] font-semibold capitalize">
          {month.toLocaleDateString([], { month: "long", year: "numeric" })}
        </span>
        <span className="flex-1" />
        <button onClick={() => go(-1)} aria-label="previous month" className={dockBtn}>
          ‹
        </button>
        <button
          onClick={() => {
            const now = new Date();
            setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
            setPicked(midnight(now).getTime());
          }}
          className={dockBtn}
        >
          today
        </button>
        <button onClick={() => go(1)} aria-label="next month" className={dockBtn}>
          ›
        </button>
      </div>
      {error && <div className="mb-2 text-[12.5px] text-fail">{error}</div>}

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl bg-line ring-1 ring-line">
        {days.slice(0, 7).map((d) => (
          <div
            key={`h${d.getDay()}`}
            className="bg-surface py-1 text-center font-mono text-[10.5px] text-faint"
          >
            {d.toLocaleDateString([], { weekday: "short" })}
          </div>
        ))}
        {days.map((d) => {
          const list = on(d);
          const key = d.getTime();
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPicked(key)}
              aria-pressed={key === picked}
              className={`flex min-h-[4.75rem] min-w-0 flex-col items-stretch gap-0.5 p-1 text-left hover:bg-surface-2 ${
                key === picked ? "bg-surface-2 ring-2 ring-accent ring-inset" : "bg-surface"
              } ${d.getMonth() === month.getMonth() ? "" : "opacity-45"}`}
            >
              <span
                className={`self-start rounded-full px-1.5 font-mono text-[11px] ${
                  key === today ? "bg-accent text-on-accent" : "text-muted"
                }`}
              >
                {d.getDate()}
              </span>
              {list.slice(0, 3).map((e) => (
                <span
                  key={`${e.uid}-${e.start}`}
                  className="truncate rounded bg-accent-tint px-1 text-[10.5px] leading-[1.45]"
                >
                  {!e.allDay && <span className="text-muted">{clock(e.start)} </span>}
                  {e.summary}
                </span>
              ))}
              {list.length > 3 && (
                <span className="px-1 text-[10px] text-faint">+{list.length - 3} more</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        <div className="font-mono text-[11px] text-faint capitalize">
          {pickedDay.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
        </div>
        {events === null && !error && (
          <SkeletonList
            count={2}
            gap="gap-1.5"
            className="h-[42px] rounded-lg border border-line bg-surface"
          />
        )}
        {events !== null && pickedEvents.length === 0 && (
          <div className="text-[13px] text-faint">nothing on the calendar</div>
        )}
        {pickedEvents.map((e) => (
          <div
            key={`${e.uid}-${e.start}`}
            className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px]"
          >
            <div className="flex items-center gap-3">
              <span className="w-[5.5rem] flex-none font-mono text-[12px] text-muted">
                {e.allDay ? "all day" : `${clock(e.start)}–${clock(e.end)}`}
              </span>
              <span className="min-w-0 flex-1 truncate">{e.summary}</span>
              {e.url && (
                <a
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-none text-[11.5px] text-accent hover:underline"
                >
                  open ↗
                </a>
              )}
            </div>
            {e.location && (
              <span className="truncate pl-[6.25rem] text-[12px] text-faint">{e.location}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Who sits on the bench beside the chair, as people rather than a settings
 * form: what each is for, and a way to ask one directly.
 *
 * Read-only here. The chair still decides who answers; "ask" only writes the
 * `@id` the server reads, the same as typing the name. Editing stays on the
 * settings page, one link away.
 */
function People({ members, onAsk }: { members: CouncilMember[]; onAsk: (id: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      {members.length === 0 && (
        <SkeletonList count={3} className="h-[64px] rounded-xl border border-line bg-surface" />
      )}
      {members.map((m) => (
        <div
          key={m.id}
          className={`flex items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 ${
            m.enabled ? "" : "opacity-55"
          }`}
        >
          <Portrait face={m.face} colour={m.colour} size={36} tone mood="idle" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className={`text-[14px] font-semibold ${MEMBER_TEXT[m.colour]}`}>{m.name}</span>
              <span className="font-mono text-[11px] text-faint">
                {m.chair ? "chair" : `@${m.id}`}
              </span>
              {!m.enabled && <span className="text-[11.5px] text-faint">off</span>}
            </div>
            <span className="text-[13px] leading-snug text-muted">{m.remit}</span>
            <span className="font-mono text-[11px] text-faint">
              {m.model} · {m.effort}
            </span>
          </div>
          {!m.chair && m.enabled && (
            <button
              onClick={() => onAsk(m.id)}
              title={`ask ${m.name} directly`}
              className="tap-hit flex flex-none items-center gap-1.5 self-center rounded-lg bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-muted hover:text-text"
            >
              <Icon name="chat" size={13} />
              ask
            </button>
          )}
        </div>
      ))}
      <Link
        to="/settings#council"
        className="mt-1 flex items-center gap-1.5 px-1 text-[12.5px] text-faint hover:text-text"
      >
        <Icon name="users" size={13} />
        edit specialists in settings
      </Link>
    </div>
  );
}

export default function Chat() {
  // Socket, reconnect and the fetch that stands in while there is none.
  const { thread, setThread, streaming } = useAssistantStream();
  const [text, setText] = useState("");
  const grow = useGrow(text);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  /**
   * What was sent while a turn was running, oldest first. The server takes one
   * turn at a time and answers a second with a 409, so the rest wait here and
   * go out one by one as each turn ends. Stop is the way to reach them sooner:
   * a turn going the wrong way is stopped, and the correction is already queued.
   */
  const [queued, setQueued] = useState<{ text: string; images: string[] }[]>([]);
  // A POST is out but the socket may not have said "thinking" yet. Without
  // this, the queue would fire its next message into that gap and get the 409.
  const posting = useRef(false);
  const [browsing, setBrowsing] = useState(false);
  // Gabriel's own browser (chair-only, see assistant.ts's mcpConfig). Not
  // remembered across reloads, the way the session screen's toggle isn't
  // either: a hidden pane still streaming frames is the thing that switch
  // exists to avoid.
  // The calendar shares its half of the screen, one panel at a time.
  const [panel, setPanel] = useState<"browser" | "calendar" | "people" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Hands-free: replies are read out, and the microphone reopens when the
  // reading stops, so a whole exchange happens without touching the screen.
  const [voiceMode, setVoiceMode] = useState(false);
  // Read replies out without any of the rest of it. Voice mode answers "I want
  // to talk to it"; this answers "I want to hear it", which is the case where
  // you type a question and then look away. Kept apart because the coupling was
  // the complaint: wanting to be read to meant having the microphone open.
  // Remembered per device: whoever wants it wants it always.
  const [speakReplies, setSpeakReplies] = useState(() => readStored("vk.assistant.speak") === "1");
  /**
   * Entries already read out. A set rather than one id, because a meeting lands
   * several at once and "the last one" would silently drop the rest.
   */
  const spokenRef = useRef<Set<string>>(new Set());
  /**
   * Which thread the set above has been filled in for.
   *
   * Everything already in a conversation when it comes on screen counts as
   * read. Without this, "read replies aloud" — which is remembered per device,
   * so it is on before the screen mounts — met the socket's first frame with an
   * empty set and started reading the whole history out, from the top, every
   * single visit. The toggles already mark what is there when they are turned
   * on; this is the same thing for the case where nothing was toggled.
   */
  const primedRef = useRef<string | null>(null);
  /** Whether the end of the conversation is on screen; see the scroll effect. */
  const [atLatest, setAtLatest] = useState(true);
  // The roster changes when somebody edits it in settings, which is rarely, so
  // it is polled slowly rather than pushed: the header shows the chair, and a
  // specialist's card is drawn in its own colour when one answers.
  const { data: roster } = usePoll<CouncilMember[]>("/api/council", 120_000);
  const members = roster ?? [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const chair = members.find((m) => m.chair) ?? NO_CHAIR;

  // Sets `data-kbd`, which hides the tab bar and drops the composer onto the
  // keys: left where they were, the two floated above a band of nothing.
  useVisualViewport();

  // This is the one door whose field is always on screen, and iOS leaves the
  // fixed tab bar resting at the offset it had while the keyboard was up
  // instead of the real one once it closes. The visual viewport returning to
  // full height means the keyboard just went away; nudging scroll by nothing
  // forces Safari to re-lay the fixed elements against the viewport it now has.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (innerHeight - vv.height < 40) window.scrollTo(0, window.scrollY);
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  /**
   * Follow the conversation as it grows, the way a conversation is expected
   * to: an answer landing under the question is worth scrolling to.
   *
   * Unless the reader has gone up to read something. This used to scroll on
   * every tick of the reply being written — ten times a second — so going back
   * to check what was asked three answers ago was not possible at all while
   * the chair was talking: the screen snapped to the bottom mid-sentence.
   */
  useEffect(() => {
    if (!atLatest) return;
    scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  }, [thread?.entries.length, thread?.status, thread?.live, atLatest]);

  // Whether the bottom is on screen. The margin is generous on purpose: the
  // composer and the tab bar sit over the last few lines.
  useEffect(() => {
    const onScroll = () => {
      setAtLatest(innerHeight + scrollY >= document.documentElement.scrollHeight - 120);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);

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

  /**
   * A message that is only an address and no question.
   *
   * `@uriel` with nothing after it is a name typed and a question not yet, so
   * sending one is a slip rather than a thing anyone means. The backend
   * reads it as unaddressed and hands the chair a message with no question in
   * it, which cost two model calls to be told it was empty. A bare `@` is the
   * same slip one character earlier.
   */
  const addressOnly = (value: string) => /^@[a-z0-9-]*$/i.test(value);

  async function send(spoken?: string) {
    const value = (spoken ?? text).trim();
    if (!value && !pending.length) return;
    // Typed, not tapped: the two words every other agent surface answers to,
    // which went to the chair as a question about nothing and came back saying
    // the turn had produced nothing. Not mid-turn, like the new thread button.
    if (!spoken && (value === "/clear" || value === "/new")) {
      if (thinking) return;
      setText("");
      await newThread();
      return;
    }
    if (!pending.length && addressOnly(value)) return;
    const images = pending;
    if (!spoken) setText("");
    setPending([]);
    if (thinking || posting.current) {
      setQueued((q) => [...q, { text: value, images }]);
      return;
    }
    await post(value, images, !spoken);
  }

  /** One turn to the server. A failure puts what was sent back to be sent again. */
  async function post(value: string, images: string[], restore: boolean) {
    setError(null);
    posting.current = true;
    try {
      setThread(
        await api<AssistantThread>("/api/assistant/messages", {
          method: "POST",
          body: JSON.stringify({
            text: value || "(see image)",
            images,
          }),
          // A turn does real work; the default 15s would abandon every one of
          // them while the socket kept showing it running.
          timeoutMs: 11 * 60_000,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      // Only into an empty field: a queued message failing must not overwrite
      // whatever is being typed by then.
      if (restore) setText((t) => (t.trim() ? t : value));
      setPending((p) => [...images, ...p]);
    } finally {
      posting.current = false;
    }
  }

  // The queue drains one message per idle moment. The next arrives with the
  // thread that ends this turn, whether from the POST or from the socket.
  useEffect(() => {
    if (!thread || thinking || posting.current || !queued.length) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    void post(next.text, next.images, true);
  }, [thread, thinking, queued]);

  // Below send, which it calls: the lint's compiler check will not have a
  // callback reach a function declared further down.
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
    if (!thread) return;
    // First sight of this conversation: everything in it was said before anyone
    // was listening. Also covers switching threads and starting a new one.
    if (primedRef.current !== thread.conversationId) {
      primedRef.current = thread.conversationId;
      spokenRef.current = new Set(thread.entries.map((e) => e.id));
      return;
    }
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
    writeStored("vk.assistant.speak", next ? "1" : "0");
    if (next) {
      // Whatever is already on screen has been read, or was never meant to be.
      for (const e of thread?.entries ?? []) spokenRef.current.add(e.id);
      // Said out loud here rather than left for the first reply: this tap is
      // the user gesture iOS wants before any audio may play without one, and
      // speak takes it — for the pod's voice as much as the browser's.
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

  async function stop() {
    await api("/api/assistant/stop", { method: "POST" }).catch(() => {});
  }

  async function newThread() {
    setThread(null);
    await api("/api/assistant/new", { method: "POST" }).catch(() => {});
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

  /** The header's second line: what it is doing, or how far the thread has come. */
  const lastEntry = thread?.entries.at(-1);
  const status =
    thread === null
      ? "connecting…"
      : // Said rather than hidden: while the stream is down what is on screen
        // may be a turn that has long since ended, and the only honest thing to
        // show is that nobody is listening for the end of it.
        !streaming
        ? "reconnecting…"
        : thinking
          ? thread.live
            ? "writing…"
            : "reading…"
          : lastEntry
            ? `${turns} turn${turns === 1 ? "" : "s"}${calls > turns ? ` · ${calls} replies` : ""} · last spoke ${agoLabel(lastEntry.at)}`
            : "here";

  return (
    // The document scrolls, as it does on the other three doors. This screen
    // used to be a full-height box scrolling its own middle, and iOS treats a
    // page that cannot scroll differently: its fixed tab bar was left standing
    // above a toolbar that had already gone, and a drag at either end of the
    // thread bounced the whole page out from under that bar.
    //
    // With a panel open on a desktop, the whole screen gives up its right half
    // to it, top bar included, so the two read as one split view.
    <div
      className={`flex min-h-full flex-col pb-[calc(55px+env(safe-area-inset-bottom))] min-[800px]:pb-0 kbd:pb-0 ${
        panel ? "desk:pr-[50%]" : ""
      }`}
    >
      {/* Stuck under the top bar rather than scrolling away with the thread:
          threads and new thread are what you reach for when the subject has
          moved on, which is exactly when the thread is long enough to have
          carried them off the screen. Stuck together with the bar, in one
          wrapper, so the row does not have to know how tall the bar is.
          transform-gpu for the same iOS lag #136 fixed on the bar itself. */}
      <div className="sticky top-0 z-20 transform-gpu">
        <TopBar crumb={[{ label: "assistant" }]} />
        {/* One row: who you are talking to and whether it is doing anything,
            then the controls. It replaces a row of worded buttons and a seat
            card the size of a reply, which between them took a sixth of a
            laptop screen before anything had been said. */}
        <div className="border-b border-line-strong bg-bg/90 backdrop-blur-md">
          <div className="mx-auto flex max-w-[800px] items-center gap-2.5 px-[18px] py-2">
            <Portrait
              face={chair.face}
              colour={chair.colour}
              size={30}
              tone
              mood={thinking ? "speaking" : "idle"}
            />
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span title={chair.remit} className="truncate text-[14px] font-semibold">
                {chair.name}
              </span>
              <span className={`truncate text-[11.5px] ${thinking ? "text-accent" : "text-faint"}`}>
                {status}
              </span>
            </div>
            <div className="flex flex-none items-center gap-0.5">
              {canSpeak() && (
                <ToolButton
                  icon="volume"
                  on={speakReplies}
                  title={
                    speakReplies
                      ? "stop reading replies aloud"
                      : "read every reply aloud, including ones you typed"
                  }
                  onClick={toggleSpeakReplies}
                />
              )}
              {(["browser", "calendar"] as const).map((p) => (
                <ToolButton
                  key={p}
                  icon={p === "browser" ? "globe" : "calendar"}
                  on={panel === p}
                  title={
                    panel === p
                      ? `close the ${p}`
                      : p === "browser"
                        ? `${chair.name}'s own browser`
                        : "the calendar, as a month"
                  }
                  onClick={() => setPanel((v) => (v === p ? null : p))}
                />
              ))}
              <ToolButton
                icon="users"
                on={panel === "people"}
                title={panel === "people" ? "close the specialists" : "who is on the bench"}
                onClick={() => setPanel((v) => (v === "people" ? null : "people"))}
              />
              {/* What changes the thread you are in, set apart from what only
                  changes how you see it. */}
              <span aria-hidden className="mx-1 h-5 w-px bg-line-strong" />
              <ToolButton
                icon="threads"
                title="threads: pick one up where it was left"
                onClick={() => setBrowsing(true)}
                disabled={thinking}
              />
              {turns > 0 && (
                <ToolButton
                  icon="compose"
                  title="start a new thread"
                  onClick={() => void newThread()}
                  disabled={thinking}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <main className="mx-auto flex w-full max-w-[800px] flex-1 flex-col gap-4 px-[18px] pt-5 pb-4">
        {thread === null && (
          <div className="flex flex-col gap-3">
            <Skeleton className="block h-10 w-2/5 self-end rounded-2xl bg-surface-2" />
            <Skeleton className="block h-24 w-4/5 rounded-2xl bg-surface-2" />
          </div>
        )}

        {thread && <Room thread={thread} members={members} chair={chair} />}

        {voiceMode && (
          <div className="flex items-center gap-2.5 rounded-xl bg-accent-tint px-3 py-2 text-[12.5px] ring-1 ring-accent/30">
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
      </main>

      {/* Stuck just clear of the bottom bar on a phone (55px is that bar's
          height), and back to its own inset where there is none. Painted with
          the page ground so the thread passing behind does not show around
          its corners. No rule above it: the field is a lifted card already,
          and a line across the page on top of that read as a second border.
          With the keyboard up the bar is hidden, so it sits on the keys. */}
      <div className="sticky bottom-[calc(55px+env(safe-area-inset-bottom))] z-10 mx-auto w-full max-w-[800px] flex-none bg-bg px-[18px] pt-2 pb-3 min-[800px]:bottom-0 min-[800px]:pb-[max(14px,env(safe-area-inset-bottom))] kbd:bottom-0 kbd:pb-2">
        {/* Gone up to read something while it keeps talking: the way back,
            rather than being dragged there by the next token. In the sticky
            card so it clears the tab bar on a phone without a second set of
            insets to keep right. */}
        {!atLatest && thread && thread.entries.length > 0 && (
          <div className="mb-2 flex justify-center">
            <button
              onClick={() => scrollTo({ top: document.documentElement.scrollHeight })}
              className="tap rounded-full border border-line bg-surface px-3 py-1 text-[11.5px] text-muted shadow-sm hover:border-accent hover:text-accent"
            >
              latest ↓
            </button>
          </div>
        )}
        {error && <div className="mb-2 text-[12.5px] text-fail">{error}</div>}
        {/* Said where the next turn is typed, with the remedy beside it. */}
        {long && !thinking && (
          <div className="mb-2 flex items-center gap-3 rounded-xl bg-wait/10 px-3 py-2 text-[12.5px] text-wait ring-1 ring-wait/30">
            <span className="min-w-0 flex-1">
              {calls} replies in this thread, and every new one carries all of them. If the subject
              has moved on, start fresh.
            </span>
            <button
              onClick={() => void newThread()}
              className="flex flex-none items-center gap-1.5 rounded-lg bg-wait/15 px-2.5 py-1 font-semibold hover:brightness-110"
            >
              <Icon name="compose" size={14} />
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
                  className="h-16 w-16 rounded-lg object-cover"
                />
                <button
                  onClick={() => setPending((p) => p.filter((n) => n !== name))}
                  aria-label="remove attachment"
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-surface-2 font-mono text-[11px] text-muted ring-1 ring-line hover:text-fail"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {queued.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5">
            {queued.map((q, i) => (
              <div
                key={`${i}-${q.text}`}
                className="flex items-center gap-2.5 rounded-xl bg-surface px-3 py-2 text-[13px]"
              >
                <span className="flex-none text-[11.5px] text-faint">queued</span>
                <span className="min-w-0 flex-1 truncate">
                  {q.text || "(image)"}
                  {q.images.length > 0 &&
                    ` · ${q.images.length} image${q.images.length === 1 ? "" : "s"}`}
                </span>
                <button
                  onClick={() => setQueued((qs) => qs.filter((_, j) => j !== i))}
                  aria-label="remove from queue"
                  className="flex-none font-mono text-faint hover:text-fail"
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

        {/* Tonal and lifted off the page: it is the one thing here you act on.
            Field on top, controls underneath; the audience sits in the same
            row as the send button, since who hears it and sending it are one
            decision. */}
        <div className="rounded-3xl bg-surface-2 px-4 pt-3.5 pb-3 shadow-[0_20px_60px_rgba(0,0,0,.55)]">
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
              listening
                ? "listening…"
                : thinking
                  ? "working… anything sent now waits its turn"
                  : "Ask, or tell me something…"
            }
            aria-label="message the assistant"
            // outline-none! because theme.css draws a focus ring on every
            // textarea, unlayered, and inside this card it was a second border.
            className="block max-h-32 min-h-[26px] w-full resize-none bg-transparent px-1 text-[16px] outline-none! placeholder:text-faint"
          />
          {/* Attach on the left, voice and send on the right. The audience
              chips that sat between them are gone: the chair decides who
              answers, and `@name` or `@all` typed first still asks directly. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => fileRef.current?.click()}
              aria-label="attach an image"
              className="tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-xl text-muted hover:bg-line-strong/40 hover:text-text disabled:opacity-40"
            >
              <Ico>
                <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </Ico>
            </button>

            <span className="order-3 flex-1" />
            {canSpeak() && canListen() && !thinking && (
              <button
                onClick={toggleVoice}
                aria-label={voiceMode ? "end voice mode" : "start voice mode"}
                title="hands free: it reads replies out and listens again"
                className={`tap-sq order-4 flex h-9 w-9 flex-none items-center justify-center rounded-xl hover:bg-line-strong/40 ${
                  voiceMode ? "bg-accent-tint text-accent" : "text-muted"
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
                className={`tap-sq order-4 flex h-9 w-9 flex-none items-center justify-center rounded-xl hover:bg-line-strong/40 ${
                  listening ? "animate-pulse bg-accent-tint text-accent" : "text-muted"
                }`}
              >
                <Ico>
                  <rect x="9" y="2" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </Ico>
              </button>
            )}
            {thinking && (
              <button
                onClick={() => void stop()}
                className="tap-sq order-4 flex h-9 flex-none items-center gap-1.5 rounded-xl bg-surface px-3 text-[13px] font-semibold text-muted hover:text-text"
              >
                <Ico>
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </Ico>
                Stop
              </button>
            )}
            {/* Beside Stop mid-turn once there is something to queue, so a
                phone, where Enter is a newline, can queue too. */}
            {(!thinking || text.trim() || pending.length > 0) && (
              // A filled circle: it is the one action in this row that commits
              // something.
              <button
                onClick={() => void send()}
                disabled={(!text.trim() || addressOnly(text.trim())) && !pending.length}
                aria-label={thinking ? "queue for after this turn" : "send"}
                className="tap-sq order-4 flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:bg-surface disabled:text-faint"
              >
                <Ico>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </Ico>
              </button>
            )}
          </div>
        </div>
      </div>

      <Tabs />

      {browsing && (
        <Threads
          current={thread?.conversationId}
          onOpen={openThread}
          onNew={() => void newThread()}
          onClose={() => setBrowsing(false)}
        />
      )}

      {panel === "browser" && (
        <Dock
          title={`${chair.name}'s browser`}
          sub="live: what it opens and clicks shows up here"
          onClose={() => setPanel(null)}
        >
          <BrowserView />
        </Dock>
      )}
      {panel === "calendar" && (
        <Dock
          title="Calendar"
          sub="what it adds, moves or removes lands here"
          onClose={() => setPanel(null)}
        >
          <Month refresh={thread?.entries.length ?? 0} />
        </Dock>
      )}
      {panel === "people" && (
        <Dock
          title="Specialists"
          sub={`who ${chair.name} brings in; ask one directly`}
          onClose={() => setPanel(null)}
        >
          <People
            members={members}
            onAsk={(id) => {
              setText((t) => `@${id} ${t.replace(/^@[a-z][a-z0-9-]*\s*/i, "")}`);
              // On a phone the panel is the whole screen, and the field the
              // name just went into is under it.
              if (!matchMedia("(min-width: 800px) and (min-height: 540px)").matches) {
                setPanel(null);
              }
            }}
          />
        </Dock>
      )}
    </div>
  );
}
