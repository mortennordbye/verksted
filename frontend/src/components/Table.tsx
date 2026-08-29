import Markdown from "react-markdown";
import type { AssistantEntry, AssistantThread, CouncilMember } from "../../../shared/api";
import { agoLabel } from "../api";
import { MD } from "./chat/markdown";
import Portrait, { MEMBER_CARD, MEMBER_TEXT } from "./Face";

/**
 * The council as a table rather than a chat.
 *
 * A chat is a scroll of everything ever said, and a meeting in one is a row of
 * bubbles that happen to be near each other. What the council actually does is
 * take one question at a time: the chair hands it to whoever it belongs to,
 * they answer, the chair decides. So the screen shows one question — the seats
 * at the top say who is here and who was asked, the answers sit under the
 * question in each advisor's colour, and the decision is the one thing drawn
 * in the bench's green. Everything asked before is a strip you can put back on
 * the table, not a history you scroll past to reach the composer.
 */

/** The marks that open a meeting: the chair handing the question on. */
const MEETING = new Set(["convene", "discuss", "everyone"]);

/** One question and everything said in answer to it. */
export interface Exchange {
  asked: AssistantEntry;
  replies: AssistantEntry[];
}

/** The thread cut at each thing typed. Entries before the first are dropped. */
export function exchangesOf(entries: AssistantEntry[]): Exchange[] {
  const out: Exchange[] = [];
  for (const entry of entries) {
    if (entry.role === "user") out.push({ asked: entry, replies: [] });
    else out[out.length - 1]?.replies.push(entry);
  }
  return out;
}

/**
 * Who a question went to, read back from what was recorded.
 *
 * The meeting mark names advisors by display name, and a direct question names
 * one by id at the front of the text; `@all` is everybody. Nobody named means
 * the chair kept it.
 */
function askedOf(x: Exchange, advisors: CouncilMember[]): Set<string> {
  const direct = /^@([a-z][a-z0-9-]*)/.exec(x.asked.text.trim())?.[1];
  if (direct === "all") return new Set(advisors.map((m) => m.id));
  if (direct) return new Set(advisors.filter((m) => m.id === direct).map((m) => m.id));
  const mark = x.replies.flatMap((r) => r.tools).find((t) => MEETING.has(t.name));
  if (!mark) return new Set();
  const names = mark.detail.replace(/\s*\(\+\d+ not asked\)$/, "").split(", ");
  return new Set(advisors.filter((m) => names.includes(m.name)).map((m) => m.id));
}

function Said({ text }: { text: string }) {
  return (
    <div className="text-[15px] leading-[1.55]">
      <Markdown components={MD}>{text}</Markdown>
    </div>
  );
}

function ToolChip({ name, detail }: { name: string; detail: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-full bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-muted">
      <span className="flex-none text-run">✓</span>
      <span className="truncate">
        {name}
        {detail && <span className="text-faint"> · {detail}</span>}
      </span>
    </span>
  );
}

/**
 * What one of them said, in their colour.
 *
 * A card rather than a bubble: it has a head with the face and the name, and
 * the ground is tinted with the speaker's hue so a table of three answers
 * reads as three people before a word of it is read.
 */
function Answer({
  who,
  label,
  entry,
  live,
  children,
}: {
  who: CouncilMember;
  /** Beside the name: what this card is, when it is more than an answer. */
  label?: string;
  entry?: AssistantEntry;
  /** Text still being written, drawn with a cursor. */
  live?: string;
  children?: React.ReactNode;
}) {
  const speaking = live !== undefined || (!entry && !children);
  return (
    <div
      className={`animate-rise flex flex-col gap-2.5 rounded-2xl p-4 ring-1 ${
        entry?.failed ? "bg-fail/[.07] ring-fail/30" : MEMBER_CARD[who.colour]
      }`}
    >
      <div className="flex items-center gap-2.5">
        <Portrait
          face={who.face}
          colour={who.colour}
          size={30}
          tone
          mood={speaking ? "speaking" : "idle"}
          title={who.remit}
        />
        <span className={`text-[13.5px] font-bold ${MEMBER_TEXT[who.colour]}`}>{who.name}</span>
        {label && (
          <span className="font-mono text-[10.5px] tracking-[.08em] text-faint uppercase">
            {label}
          </span>
        )}
        {entry && (
          <span className="ml-auto font-mono text-[11px] text-faint">{agoLabel(entry.at)}</span>
        )}
      </div>
      {entry && entry.tools.filter((t) => !MEETING.has(t.name)).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entry.tools
            .filter((t) => !MEETING.has(t.name))
            .map((t, i) => (
              <ToolChip key={i} name={t.name} detail={t.detail} />
            ))}
        </div>
      )}
      {entry?.text && <Said text={entry.text} />}
      {live !== undefined && (
        // Plain while it is being written: markdown half-typed re-flows on
        // every token, and the stored entry it becomes is rendered.
        <div className="text-[15px] leading-[1.55] whitespace-pre-wrap">
          {live}
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-blink bg-accent align-[-2px]" />
        </div>
      )}
      {!entry && live === undefined && !children && (
        <div className="font-mono text-[12px] text-faint">answering…</div>
      )}
      {children}
    </div>
  );
}

/**
 * The seats: everybody in the room, and what each is doing about this question.
 *
 * Doubles as the way to address one of them, because pointing at a seat is how
 * you would do it at a real table. The chair's seat is the default and tapping
 * it clears an address rather than setting one.
 */
function Seats({
  members,
  speaking,
  asked,
  meeting,
  addressed,
  onPick,
}: {
  members: CouncilMember[];
  speaking: string[];
  asked: Set<string>;
  /** Whether the question on the table went to anybody but the chair. */
  meeting: boolean;
  addressed: string | null;
  onPick: (id: string) => void;
}) {
  return (
    // One row that scrolls on a phone rather than wrapping into a ragged
    // three: at that width the seats are faces and names, and what each is
    // doing is said by the halo and the dimming alone.
    <div className="-mx-[18px] flex items-center gap-x-2 overflow-x-auto px-[18px] min-[620px]:mx-0 min-[620px]:flex-wrap min-[620px]:gap-x-5 min-[620px]:gap-y-3 min-[620px]:rounded-3xl min-[620px]:bg-surface min-[620px]:px-5 min-[620px]:py-4 min-[620px]:shadow-[0_20px_60px_rgba(0,0,0,.45)]">
      {members.map((m) => {
        const busy = speaking.includes(m.id);
        const picked = addressed === m.id || (m.chair && !addressed);
        const idle = meeting && !m.chair && !asked.has(m.id) && !busy;
        const note = busy
          ? "answering…"
          : idle
            ? "not asked"
            : m.chair
              ? "chair"
              : m.remit.split(":")[0];
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onPick(m.id)}
            title={m.remit}
            aria-pressed={picked}
            className={`tap flex flex-none items-center gap-2 rounded-2xl px-2 py-1 text-left transition-opacity min-[620px]:gap-3 ${
              idle ? "opacity-45" : ""
            } ${picked ? "bg-surface-2" : "hover:bg-surface-2"}`}
          >
            <Portrait
              face={m.face}
              colour={m.colour}
              size={m.chair ? 44 : 36}
              tone
              mood={busy ? "speaking" : "idle"}
            />
            <span className="flex flex-col leading-tight">
              <span className={`text-[13.5px] font-bold ${m.chair ? "text-text" : ""}`}>
                {m.name}
              </span>
              <span
                className={`hidden text-[12px] min-[620px]:block ${busy ? "text-accent" : idle ? "text-faint" : "text-muted"}`}
              >
                {note}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function Table({
  thread,
  members,
  viewing,
  onView,
  addressed,
  onPick,
}: {
  thread: AssistantThread;
  members: CouncilMember[];
  /** Which exchange is on the table; null is the latest. */
  viewing: number | null;
  onView: (index: number | null) => void;
  addressed: string | null;
  onPick: (id: string) => void;
}) {
  const advisors = members.filter((m) => !m.chair);
  const chair = members.find((m) => m.chair);
  const exchanges = exchangesOf(thread.entries);
  const latest = exchanges.length - 1;
  const at = viewing ?? latest;
  const x = exchanges[at] as Exchange | undefined;
  const thinking = thread.status === "thinking" && at === latest;
  const speaking = thinking ? (thread.speaking ?? []) : [];

  const asked = x ? askedOf(x, advisors) : new Set<string>();
  const meeting = asked.size > 0;
  const answers = x?.replies.filter((r) => r.member) ?? [];
  const fromChair = x?.replies.filter((r) => !r.member) ?? [];
  // In a meeting the chair's last word is the decision; alone, it is the answer.
  const decision = meeting ? fromChair.filter((r) => r.text.trim()).at(-1) : undefined;
  const chairSaid = meeting ? [] : fromChair.filter((r) => r.text.trim());
  const chairTools = fromChair.flatMap((r) => r.tools).filter((t) => !MEETING.has(t.name));
  const direct = /^@[a-z][a-z0-9-]*\s*/;

  return (
    <div className="flex flex-col gap-5">
      <Seats
        members={members}
        speaking={speaking}
        asked={asked}
        meeting={meeting}
        addressed={addressed}
        onPick={onPick}
      />

      {!x && (
        <div className="mt-8 text-center">
          <div className="font-mono text-[13px] text-muted">nothing on the table</div>
          <p className="mx-auto mt-2 max-w-[44ch] text-[14px] text-faint">
            Put a question to the room. Gabriel hands it to whoever it belongs to; tap a seat to ask
            one of them alone, or ask everyone.
          </p>
        </div>
      )}

      {x && (
        <div className="flex flex-col gap-4">
          {/* The question, centred: it is what everything below is about. */}
          <div className="flex flex-col items-center gap-2 px-4 pt-3 pb-1 text-center">
            <span className="font-mono text-[11px] tracking-[.08em] text-faint uppercase">
              {at === latest ? "on the table" : "earlier"} · {agoLabel(x.asked.at)}
              {asked.size === 1 && ` · to ${advisors.find((m) => asked.has(m.id))?.name ?? ""}`}
              {asked.size > 1 && asked.size === advisors.length && " · to everyone"}
            </span>
            {x.asked.images?.map((name) => (
              <img
                key={name}
                src={`/api/assistant/uploads/${name}`}
                alt="attached"
                className="max-h-52 rounded-xl"
              />
            ))}
            {x.asked.text && (
              <div className="max-w-[36ch] text-[21px] leading-[1.3] font-bold tracking-[-.015em] text-balance">
                {x.asked.text.replace(direct, "")}
              </div>
            )}
          </div>

          {chairTools.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {chairTools.map((t, i) => (
                <ToolChip key={i} name={t.name} detail={t.detail} />
              ))}
            </div>
          )}

          {/* The answers, one card per advisor, in the order they landed; a
              seat still out gets a card saying so, in its place. */}
          {(answers.length > 0 || speaking.some((id) => id !== chair?.id)) && (
            <div className="grid gap-3 min-[620px]:grid-cols-2">
              {answers.map((r) => {
                const who = advisors.find((m) => m.id === r.member);
                return who ? <Answer key={r.id} who={who} entry={r} /> : null;
              })}
              {speaking
                .filter((id) => id !== chair?.id && !answers.some((r) => r.member === id))
                .map((id) => {
                  const who = advisors.find((m) => m.id === id);
                  return who ? <Answer key={id} who={who} /> : null;
                })}
            </div>
          )}

          {chair &&
            chairSaid.map((r) => (
              <Answer key={r.id} who={chair} entry={r} label={r.failed ? "failed" : undefined} />
            ))}

          {chair && thinking && thread.live !== undefined && thread.live !== "" && (
            <Answer who={chair} live={thread.live} label={meeting ? "deciding" : undefined} />
          )}

          {decision && (
            <div
              className={`animate-rise flex flex-col gap-2 rounded-2xl px-5 py-4 ring-1 ${
                decision.failed ? "bg-fail/[.07] ring-fail/30" : "bg-accent-tint ring-accent/25"
              }`}
            >
              <div className="flex items-center gap-2.5">
                {chair && <Portrait face={chair.face} colour={chair.colour} size={26} tone />}
                <span className="font-mono text-[11px] tracking-[.08em] text-accent uppercase">
                  {chair?.name ?? "chair"} · {decision.failed ? "failed" : "decided"}
                </span>
                <span className="ml-auto font-mono text-[11px] text-faint">
                  {agoLabel(decision.at)}
                </span>
              </div>
              <div className="text-[16.5px] leading-[1.45] font-medium text-white">
                <Markdown components={MD}>{decision.text}</Markdown>
              </div>
            </div>
          )}

          {thinking && !thread.live && !speaking.length && (
            <div className="flex items-center justify-center gap-2 font-mono text-[12px] text-muted">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
              {chair?.name ?? "the chair"} is reading it…
            </div>
          )}
        </div>
      )}

      {/* Everything asked before, as a strip. The one on the table is lit; the
          latest is always reachable, since that is where a new question goes. */}
      {exchanges.length > 1 && (
        <div className="-mx-[18px] flex gap-2 overflow-x-auto px-[18px] pt-1 pb-2">
          {exchanges.map((e, i) => {
            const here = i === at;
            const who = askedOf(e, advisors);
            const label =
              who.size === 0
                ? "chair"
                : who.size === advisors.length && advisors.length > 1
                  ? "everyone"
                  : [...who].map((id) => advisors.find((m) => m.id === id)?.name ?? id).join(", ");
            return (
              <button
                key={e.asked.id}
                type="button"
                onClick={() => onView(i === latest ? null : i)}
                aria-pressed={here}
                className={`flex w-[200px] flex-none flex-col items-start gap-1 rounded-xl px-3 py-2.5 text-left ${
                  here ? "bg-surface-2 ring-1 ring-line-strong" : "bg-surface hover:bg-surface-2"
                }`}
              >
                <span className="font-mono text-[10px] tracking-[.06em] text-faint uppercase">
                  {i === latest ? "latest" : agoLabel(e.asked.at)} · {label}
                </span>
                <span className="line-clamp-2 text-[12.5px] leading-snug text-muted">
                  {e.asked.text.replace(direct, "") || "(image)"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
