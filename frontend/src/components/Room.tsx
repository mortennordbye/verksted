import Markdown from "react-markdown";
import type { AssistantEntry, AssistantThread, CouncilMember } from "../../../shared/api";
import { agoLabel } from "../api";
import { cite, citeUrl } from "./chat/cite";
import { MD } from "./chat/markdown";
import Portrait, { MEMBER_CARD, MEMBER_TEXT } from "./Face";

/**
 * The room: one person to talk to, and everything said in it.
 *
 * A tonal seat at the top and answers as cards in the speaker's colour. There
 * is one seat because there is one thing you talk to; when it brings a
 * specialist in, that answer lands as a card in the specialist's own colour,
 * which is how a consultation shows without being a place you went to. What
 * it keeps from a chat is the order: it is a conversation, and a conversation
 * reads top to bottom.
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

function Reply({
  who,
  entry,
  live,
}: {
  who: CouncilMember;
  entry?: AssistantEntry;
  live?: string;
}) {
  // "handoff" is a mark old threads carry from when the council was a screen
  // of its own; it pointed next door, and there is no next door.
  const tools = entry?.tools.filter((t) => t.name !== "handoff") ?? [];
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
          <Markdown components={MD} urlTransform={citeUrl}>
            {cite(entry.text)}
          </Markdown>
        </div>
      )}
      {live !== undefined && (
        <div className="text-[15px] leading-[1.55] whitespace-pre-wrap">
          {live}
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-blink bg-accent align-[-2px]" />
        </div>
      )}
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
            Ask what needs you, or tell it something to remember. It reads your projects, sessions,
            runs and the cluster, and brings in a specialist when a question is theirs.
          </p>
        </div>
      )}

      {thread.entries.map((e) =>
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
          <Reply key={e.id} who={members.find((m) => m.id === e.member) ?? chair} entry={e} />
        ),
      )}

      {thinking && thread.live && <Reply who={chair} live={thread.live} />}
      {thinking && !thread.live && (
        <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          thinking…
        </div>
      )}
    </div>
  );
}
