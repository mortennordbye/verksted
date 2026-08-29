import Markdown from "react-markdown";
import { useNavigate } from "react-router";
import type { AssistantEntry, AssistantThread, CouncilMember } from "../../../shared/api";
import { agoLabel } from "../api";
import { MD } from "./chat/markdown";
import Portrait, { Face, MEMBER_CARD, MEMBER_TEXT } from "./Face";

/**
 * The assistant's room: one person to talk to, and everything it said.
 *
 * The same visual language as the council's table — a tonal seat at the top,
 * answers as cards in the speaker's colour — without the table, because there
 * is nobody else at it. What it keeps from a chat is the order: it is a
 * conversation, and a conversation reads top to bottom.
 */

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
 * The way over to the council, drawn under the answer it came with.
 *
 * The assistant cannot ask them, so this is the whole handoff: the question is
 * carried across prefilled and not sent, because the meeting is the person's to
 * spend.
 */
function Handoff({
  ids,
  members,
  question,
}: {
  ids: string[];
  members: CouncilMember[];
  question: string;
}) {
  const navigate = useNavigate();
  const named = ids
    .map((id) => members.find((m) => m.id === id))
    .filter(Boolean) as CouncilMember[];
  if (!named.length) return null;
  const ask = `${named.length === 1 ? `@${named[0].id} ` : ""}${question}`.trim();
  return (
    <button
      type="button"
      onClick={() => navigate(`/council?ask=${encodeURIComponent(ask)}`)}
      className="tap flex max-w-full items-center gap-2 self-start rounded-full bg-accent-tint px-3 py-1.5 font-mono text-[11px] text-accent ring-1 ring-accent/30 hover:brightness-110"
    >
      {named.map((m) => (
        <Face
          key={m.id}
          face={m.face}
          className={`h-[15px] w-[15px] flex-none ${MEMBER_TEXT[m.colour]}`}
        />
      ))}
      <span className="truncate">
        ask {named.map((m) => m.name).join(" and ")} in the council →
      </span>
    </button>
  );
}

/** The question an answer was answering: the nearest thing typed above it. */
function lastAskedBefore(entries: AssistantEntry[], index: number): string {
  for (let i = index; i >= 0; i--) {
    if (entries[i].role === "user" && entries[i].text.trim()) return entries[i].text;
  }
  return "";
}

function Reply({
  who,
  entry,
  live,
  members,
  question,
}: {
  who: CouncilMember;
  entry?: AssistantEntry;
  live?: string;
  members: CouncilMember[];
  question: string;
}) {
  const tools = entry?.tools.filter((t) => t.name !== "handoff") ?? [];
  const handoff = entry?.tools.find((t) => t.name === "handoff");
  return (
    <div
      className={`animate-rise flex max-w-[640px] flex-col gap-2.5 rounded-2xl p-4 ring-1 ${
        entry?.failed ? "bg-fail/[.07] ring-fail/30" : MEMBER_CARD[who.colour]
      }`}
    >
      <div className="flex items-center gap-2.5">
        <Portrait
          face={who.face}
          colour={who.colour}
          size={28}
          tone
          mood={live !== undefined ? "speaking" : "idle"}
        />
        <span className={`text-[13.5px] font-bold ${MEMBER_TEXT[who.colour]}`}>{who.name}</span>
        <span className="ml-auto font-mono text-[11px] text-faint">
          {entry ? agoLabel(entry.at) : <span className="text-accent">writing…</span>}
        </span>
      </div>
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tools.map((t, i) => (
            <ToolChip key={i} name={t.name} detail={t.detail} />
          ))}
        </div>
      )}
      {entry?.text && (
        <div className="text-[15px] leading-[1.55]">
          <Markdown components={MD}>{entry.text}</Markdown>
        </div>
      )}
      {live !== undefined && (
        <div className="text-[15px] leading-[1.55] whitespace-pre-wrap">
          {live}
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-blink bg-accent align-[-2px]" />
        </div>
      )}
      {handoff && <Handoff ids={handoff.detail.split(",")} members={members} question={question} />}
    </div>
  );
}

export default function Room({
  thread,
  members,
  chair,
}: {
  thread: AssistantThread;
  members: CouncilMember[];
  chair: CouncilMember;
}) {
  const thinking = thread.status === "thinking";
  const last = thread.entries.at(-1);
  const status = thinking
    ? thread.live
      ? "writing…"
      : "reading…"
    : last
      ? `last spoke ${agoLabel(last.at)}`
      : "here";

  return (
    <div className="flex flex-col gap-5">
      {/* The seat: who this is, and whether it is doing anything. */}
      <div className="flex items-center gap-4 rounded-3xl bg-surface px-5 py-4 shadow-[0_20px_60px_rgba(0,0,0,.45)]">
        <Portrait
          face={chair.face}
          colour={chair.colour}
          size={52}
          tone
          mood={thinking ? "speaking" : "idle"}
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[16px] font-bold">{chair.name}</span>
          <span className={`text-[12.5px] ${thinking ? "text-accent" : "text-muted"}`}>
            {status}
          </span>
        </div>
        <span className="ml-auto hidden max-w-[32ch] text-right text-[12px] leading-snug text-faint min-[620px]:block">
          {chair.remit}
        </span>
      </div>

      {thread.entries.length === 0 && (
        <div className="mt-8 text-center">
          <div className="font-mono text-[13px] text-muted">nothing said yet</div>
          <p className="mx-auto mt-2 max-w-[42ch] text-[14px] text-faint">
            Ask what needs you, or tell it something to remember. It can read your projects,
            sessions and runs, and it will say when a question is really the council's.
          </p>
        </div>
      )}

      {thread.entries.map((e, i) =>
        e.role === "user" ? (
          <div key={e.id} className="animate-rise flex flex-col items-end gap-1.5">
            {e.images?.map((name) => (
              <img
                key={name}
                src={`/api/assistant/uploads/${name}`}
                alt="attached"
                className="max-h-52 max-w-[82%] rounded-xl"
              />
            ))}
            {e.text && (
              <div className="max-w-[82%] rounded-[20px] rounded-br-[6px] bg-accent px-[18px] py-3 text-[15.5px] leading-[1.5] font-medium whitespace-pre-wrap text-on-accent">
                {e.text}
              </div>
            )}
          </div>
        ) : (
          <Reply
            key={e.id}
            who={members.find((m) => m.id === e.member) ?? chair}
            entry={e}
            members={members}
            question={lastAskedBefore(thread.entries, i)}
          />
        ),
      )}

      {thinking && thread.live && (
        <Reply who={chair} live={thread.live} members={members} question="" />
      )}
      {thinking && !thread.live && (
        <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          thinking…
        </div>
      )}
    </div>
  );
}
