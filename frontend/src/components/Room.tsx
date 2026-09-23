import { Fragment, memo, useDeferredValue, useMemo, useState } from "react";
import Markdown from "react-markdown";
import type {
  AssistantEntry,
  AssistantThread,
  AssistantToolCall,
  CouncilMember,
} from "../../../shared/api";
import Ago, { DayRule, newDay } from "./Ago";
import { cite, citeUrl } from "./chat/cite";
import CopyButton from "./chat/CopyButton";
import Icon from "./Icon";
import { MD, REMARK } from "./chat/markdown";
import Portrait, { MEMBER_CARD, MEMBER_TEXT } from "./Face";
import Overlay from "./ui/Overlay";

/**
 * The room: one person to talk to, and everything said in it.
 *
 * The chair is named once, in the header the chat screen draws, so what it
 * says reads as the conversation itself: one bubble for a run of replies, the
 * time once at the end. When it brings a specialist in, that answer lands as a
 * card with the specialist's own face, name and colour, since who is speaking
 * is the news there. What it keeps from a chat is the order: it is a
 * conversation, and a conversation reads top to bottom.
 */

/**
 * An image from the uploads directory, which keeps a month of them (A-27): an
 * older one says so instead of drawing a broken-image mark.
 */
function Upload({ name, alt, className }: { name: string; alt: string; className: string }) {
  const [gone, setGone] = useState(false);
  if (gone) return <span className="text-[12px] text-faint italic">{alt} no longer kept</span>;
  return (
    // onError is the image failing to load, not something a person does to it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <img
      src={`/api/assistant/uploads/${name}`}
      alt={alt}
      className={className}
      onError={() => setGone(true)}
    />
  );
}

/**
 * An image you attached, which opens full size over the thread on a tap
 * (C-30). A new tab, the way a screenshot the chair took opens, is a dead end
 * in the installed app: there is no tab bar to come back through.
 */
function Attached({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="show the attached image full size"
        className="block max-w-[82%]"
      >
        <Upload name={name} alt="attached image" className="max-h-52 max-w-full rounded-xl" />
      </button>
      {open && (
        <Overlay
          label="attached image"
          onClose={() => setOpen(false)}
          className="max-h-[92dvh] max-w-[96vw] overflow-auto rounded-xl bg-bg p-1"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="close the image"
            className="block"
          >
            <Upload name={name} alt="attached image" className="max-h-[90dvh] max-w-full" />
          </button>
        </Overlay>
      )}
    </>
  );
}

function ToolChip({ name, detail, running }: { name: string; detail: string; running?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-full bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-muted">
      {running ? (
        <span className="inline-block h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-accent" />
      ) : (
        <span className="flex-none text-run">✓</span>
      )}
      <span className="truncate">
        {name}
        {detail && <span className="text-faint"> · {detail}</span>}
      </span>
    </span>
  );
}

/**
 * What one reply carries: the tools it used, what they showed it, and its words.
 *
 * Memoized, along with the two things that draw it. While the chair is writing,
 * the screen is re-rendered ten times a second, and every reply in the thread
 * was re-parsing its markdown on each of those frames — on a phone, on a
 * conversation that had run all morning. An entry never changes once it is in
 * the thread, so its bubble only has to be drawn once.
 */
const Said = memo(function Said({ entry, times = 1 }: { entry: AssistantEntry; times?: number }) {
  // "handoff" is a mark old threads carry from when the council was a screen
  // of its own; it pointed next door, and there is no next door.
  const tools = entry.tools.filter((t) => t.name !== "handoff");
  return (
    <>
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tools.map((t, i) => (
            <ToolChip key={i} name={t.name} detail={t.detail} />
          ))}
        </div>
      )}
      {/* What a tool showed it, a browser screenshot most of all: the thing it
          is asking you to confirm, so it is shown rather than described. */}
      {entry.images?.length ? (
        <div className="flex flex-wrap gap-2">
          {entry.images.map((name) => (
            <a
              key={name}
              href={`/api/assistant/uploads/${name}`}
              target="_blank"
              rel="noreferrer"
              className="block max-w-full"
            >
              <Upload
                name={name}
                alt="screenshot"
                className="max-h-96 max-w-full rounded-lg ring-1 ring-line"
              />
            </a>
          ))}
        </div>
      ) : null}
      {entry.text && (
        // The count sits beside the words as a badge: after a paragraph it
        // landed on a line of its own, which read as a stray mark.
        <div className="flex items-start gap-2">
          <div
            className={`min-w-0 flex-1 text-[15px] leading-[1.55] ${entry.failed ? "text-fail" : ""}`}
          >
            <Markdown components={MD} remarkPlugins={REMARK} urlTransform={citeUrl}>
              {cite(entry.text)}
            </Markdown>
          </div>
          {times > 1 && (
            <span
              title={`said ${times} times in a row`}
              className="mt-[3px] flex-none rounded-full bg-surface-2 px-1.5 font-mono text-[10.5px] text-faint"
            >
              ×{times}
            </span>
          )}
        </div>
      )}
    </>
  );
});

/**
 * The reply as it is written, drawn the way it will be kept. It used to be
 * plain text until the entry landed and markdown after, so a list or a code
 * block changed height under the reader at the moment they reached the end of
 * it. Deferred, because the text grows ten times a second and a render that
 * falls behind should drop frames, not queue them. The caret is `vk-writing`
 * in theme.css: it has to sit after the last block, not under it.
 */
/** A turn in flight: the tools it has reached for, what it is thinking, what it has written. */
interface LiveTurn {
  text: string;
  thinking: string;
  tools: AssistantToolCall[];
}

/**
 * The turn as it happens. The last tool is the one running until something
 * follows it; the thinking is its tail, since only where it has got to is news.
 */
function Working({ live }: { live: LiveTurn }) {
  const thought = live.thinking.trim();
  // Hidden from a screen reader: it changes ten times a second, and the log
  // around it announces the entry once it is written (C-19).
  return (
    <div aria-hidden="true" className="flex flex-col gap-1.5">
      {live.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {live.tools.map((t, i) => (
            <ToolChip
              key={i}
              name={t.name}
              detail={t.detail}
              running={!live.text && i === live.tools.length - 1}
            />
          ))}
        </div>
      )}
      {thought && !live.text && (
        <div className="text-[13px] leading-[1.45] whitespace-pre-wrap text-faint italic">
          {thought.length > 400 ? `…${thought.slice(-400)}` : thought}
        </div>
      )}
      {live.text && <Writing live={live.text} />}
    </div>
  );
}

function Writing({ live }: { live: string }) {
  const shown = useDeferredValue(live);
  return (
    <div className="vk-writing text-[15px] leading-[1.55]">
      <Markdown components={MD} remarkPlugins={REMARK} urlTransform={citeUrl}>
        {cite(shown)}
      </Markdown>
    </div>
  );
}

/**
 * A run of the chair's replies as one bubble, the way a messaging app merges a
 * burst from one sender: the parts stacked with a hairline between them and the
 * time once, at the end. The same words said twice in a row (a failure the CLI
 * reported on two turns) show once, marked with how many times.
 */
const Bubble = memo(function Bubble({
  entries,
  live,
  onRetry,
}: {
  entries: AssistantEntry[];
  live?: LiveTurn;
  /** Given for the thread's last bubble when it ended badly: ask the same thing again. */
  onRetry?: () => void;
}) {
  const parts: { entry: AssistantEntry; times: number }[] = [];
  for (const entry of entries) {
    const prev = parts.at(-1);
    const bare = !entry.tools.length && !entry.images?.length;
    if (prev && bare && entry.text && entry.text === prev.entry.text) prev.times++;
    else parts.push({ entry, times: 1 });
  }
  const last = entries.at(-1);
  return (
    <div className="animate-rise flex w-fit max-w-[640px] flex-col gap-1 self-start rounded-[18px] rounded-bl-[6px] bg-surface px-3.5 py-2">
      {parts.map(({ entry, times }, i) => (
        <div
          key={entry.id}
          className={`flex flex-col gap-2 ${i > 0 ? "mt-1 border-t border-line pt-1.5" : ""}`}
        >
          <Said entry={entry} times={times} />
        </div>
      ))}
      {live !== undefined && (
        <div className={parts.length ? "mt-1 border-t border-line pt-1.5" : ""}>
          <Working live={live} />
        </div>
      )}
      {last && live === undefined && (
        <div className="-mt-0.5 flex items-center gap-2 self-end">
          {onRetry && last.failed && (
            // A failed turn was only painted red. What went wrong is usually
            // the pod or the CLI, not the question, and typing it out again on
            // a phone is the expensive way to find that out.
            <button
              type="button"
              onClick={onRetry}
              className="tap flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold text-fail ring-1 ring-fail/40 hover:brightness-110"
            >
              <Icon name="reload" size={11} />
              try again
            </button>
          )}
          <CopyButton
            text={parts
              .map((p) => p.entry.text)
              .filter(Boolean)
              .join("\n\n")}
          />
          <Ago at={last.at} className="font-mono text-[10px] leading-none text-faint" />
        </div>
      )}
    </div>
  );
});

/** A specialist's answer: its own face, name and colour, and the time beside them. */
const Card = memo(function Card({ who, entry }: { who: CouncilMember; entry: AssistantEntry }) {
  return (
    <div
      className={`animate-rise flex max-w-[640px] flex-col gap-2.5 rounded-2xl p-4 ring-1 ${
        entry.failed ? "bg-fail/[.07] ring-fail/30" : MEMBER_CARD[who.colour]
      }`}
    >
      <div className="flex items-center gap-2.5">
        <Portrait face={who.face} colour={who.colour} size={28} tone mood="idle" />
        <span className={`text-[13.5px] font-bold ${MEMBER_TEXT[who.colour]}`}>{who.name}</span>
        <span className="ml-auto flex items-center gap-2">
          {entry.text && <CopyButton text={entry.text} />}
          <Ago at={entry.at} className="font-mono text-[11px] text-faint" />
        </span>
      </div>
      <Said entry={entry} />
    </div>
  );
});

/** How close together two of the chair's replies have to be to share a bubble. */
const RUN_MS = 5 * 60_000;

type Block =
  | { kind: "user"; entry: AssistantEntry }
  | { kind: "card"; entry: AssistantEntry }
  | { kind: "run"; entries: AssistantEntry[] };

/**
 * The thread as what the screen draws: your messages, specialists' cards, and
 * the chair's replies gathered into runs. A run ends at anything of yours or a
 * specialist's, or at a pause longer than RUN_MS.
 */
/** The entry a block opens with: its day, and a key that outlives the block growing. */
function firstAt(b: Block): AssistantEntry {
  return b.kind === "run" ? b.entries[0] : b.entry;
}

function blocks(entries: AssistantEntry[]): Block[] {
  const out: Block[] = [];
  for (const entry of entries) {
    if (entry.role === "user") {
      out.push({ kind: "user", entry });
      continue;
    }
    if (entry.member) {
      out.push({ kind: "card", entry });
      continue;
    }
    const prev = out.at(-1);
    const lastAt = prev?.kind === "run" ? prev.entries.at(-1)?.at : undefined;
    if (prev?.kind === "run" && lastAt && Date.parse(entry.at) - Date.parse(lastAt) <= RUN_MS) {
      prev.entries.push(entry);
    } else {
      out.push({ kind: "run", entries: [entry] });
    }
  }
  return out;
}

export default function Room({
  thread,
  members,
  chair,
  onRetry,
}: {
  thread: AssistantThread;
  members: CouncilMember[];
  chair: CouncilMember;
  /** Ask the last thing said again, with what it carried. */
  onRetry?: (text: string, images: string[]) => void;
}) {
  const thinking = thread.status === "thinking";
  // Keyed on the entries array rather than recomputed per frame: while a reply
  // is streaming, the socket sends frames that carry no entries at all, and the
  // hook keeps the array it holds — so this is the same list, and every bubble
  // built from it keeps its props and stays drawn.
  const drawn = useMemo(() => blocks(thread.entries), [thread.entries]);
  // The answer being written joins the chair's last bubble when that is the
  // last thing on screen, and starts one of its own otherwise.
  const writing: LiveTurn | undefined =
    thinking && (thread.live || thread.liveThinking || thread.liveTools?.length)
      ? {
          text: thread.live ?? "",
          thinking: thread.liveThinking ?? "",
          tools: thread.liveTools ?? [],
        }
      : undefined;
  const joinsLast = writing !== undefined && drawn.at(-1)?.kind === "run";

  // The question a failed last turn was answering: the newest thing typed.
  const asked = thread.entries.findLast((e) => e.role === "user");
  const retry = useMemo(
    () => (asked && onRetry ? () => onRetry(asked.text, asked.images ?? []) : undefined),
    [asked, onRetry],
  );

  const draw = (b: Block, i: number) => {
    if (b.kind === "user") {
      const e = b.entry;
      return (
        <div className="animate-rise flex flex-col items-end gap-1.5">
          {e.images?.map((name) => (
            <Attached key={name} name={name} />
          ))}
          {e.text && (
            <div className="max-w-[82%] rounded-[20px] rounded-br-[6px] bg-accent px-[18px] py-3 text-[15.5px] leading-[1.5] font-medium whitespace-pre-wrap text-on-accent">
              {e.text}
            </div>
          )}
        </div>
      );
    }
    if (b.kind === "card") {
      const who = members.find((m) => m.id === b.entry.member) ?? chair;
      return <Card who={who} entry={b.entry} />;
    }
    const isLast = i === drawn.length - 1;
    return (
      <Bubble
        entries={b.entries}
        live={isLast && joinsLast ? writing : undefined}
        onRetry={isLast && !thinking ? retry : undefined}
      />
    );
  };

  // Who else has a turn in flight: the specialists do not stream their words,
  // so their faces are the only sign they are answering (C-26).
  const speaking = (thread.speaking ?? [])
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is CouncilMember => !!m && !m.chair);

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="the conversation"
      className="flex flex-col gap-3"
    >
      {thread.entries.length === 0 && (
        <div className="mt-8 text-center">
          <div className="text-[13.5px] text-muted">nothing said yet</div>
          <p className="mx-auto mt-2 max-w-[42ch] text-[14px] text-faint">
            Ask what needs you, or tell it something to remember. It reads your projects, sessions,
            runs and the cluster, and brings in a specialist when a question is theirs.
          </p>
        </div>
      )}

      {drawn.map((b, i) => {
        const at = firstAt(b);
        const before = i > 0 ? firstAt(drawn[i - 1]) : undefined;
        return (
          <Fragment key={at.id}>
            {newDay(before?.at, at.at) && <DayRule at={at.at} />}
            {draw(b, i)}
          </Fragment>
        );
      })}

      {writing !== undefined && !joinsLast && <Bubble entries={[]} live={writing} />}
      {thinking && speaking.length > 0 && (
        <div aria-hidden="true" className="flex items-center gap-2 text-[12.5px] text-muted">
          <span className="flex -space-x-1.5">
            {speaking.map((m) => (
              <Portrait key={m.id} face={m.face} colour={m.colour} size={22} tone mood="speaking" />
            ))}
          </span>
          {speaking.map((m) => m.name).join(", ")} answering…
        </div>
      )}
      {thinking && writing === undefined && speaking.length === 0 && (
        <div aria-hidden="true" className="flex items-center gap-2 text-[12.5px] text-muted">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          thinking…
        </div>
      )}
    </div>
  );
}
