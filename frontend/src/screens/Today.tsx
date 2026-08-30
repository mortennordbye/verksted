import { useState } from "react";
import Markdown from "react-markdown";
import { Link } from "react-router";
import type {
  AssistantConfig,
  AssistantThread,
  Memory,
  Profile,
  ScheduleRun,
  Session,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { MD } from "../components/chat/markdown";
import Sheet from "../components/Sheet";
import { AgentMark, StatusChip } from "../components/StatusChip";
import Tabs from "../components/Tabs";
import TopBar from "../components/TopBar";
import { useGrow } from "../useGrow";

/**
 * The home screen: what the assistant would tell you if you asked, before you
 * ask.
 *
 * A chat starts empty, and every morning the first thing on it was a cursor.
 * This is the page instead: what needs you, the morning's brief, what is
 * running, with the composer under it so following up on the brief does not
 * mean leaving it. The bench and the thread are a tab away.
 *
 * Everything here is read from lists the app already keeps; nothing is
 * computed for this screen. The brief is the newest reply of an assistant
 * schedule, which is what a briefing is.
 */
function Label({ children }: { children: string }) {
  return (
    <div className="mb-2 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
      {children}
    </div>
  );
}

const OUTCOME: Record<string, "run" | "wait" | "fail" | "idle"> = {
  ok: "run",
  attention: "wait",
  failed: "fail",
  blocked: "idle",
  running: "run",
  done: "idle",
};

/** The date as a person says it, in the browser's own language. */
function dateLine(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** A row that needs you, and where it goes. */
function Need({ to, chip, text }: { to: string; chip: "wait" | "fail"; text: string }) {
  return (
    <Link
      to={to}
      className="tap flex items-center gap-2.5 rounded-lg border border-wait/30 bg-wait/8 px-3 py-2 hover:border-wait/60"
    >
      <StatusChip kind={chip} label={chip === "wait" ? "needs you" : "failed"} />
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{text}</span>
      <span className="flex-none text-[13px] text-faint">→</span>
    </Link>
  );
}

/**
 * Ask from here, and read the answer here.
 *
 * Posts to the same thread the chat screen shows, so nothing said on Today is
 * lost; the reply opens in a sheet with the way to the thread in its corner.
 * No voice, no images, no stop: those are the chat's, and this is the short
 * question you ask on the way out of the door.
 */
function Composer({ name }: { name: string }) {
  const [text, setText] = useState("");
  const grow = useGrow(text);
  const [asked, setAsked] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = asked !== null && reply === null && error === null;

  async function send() {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    setAsked(value);
    setReply(null);
    setError(null);
    try {
      const thread = await api<AssistantThread>("/api/assistant/messages", {
        method: "POST",
        body: JSON.stringify({ text: value }),
        // A turn does real work; the default would abandon every one of them.
        timeoutMs: 11 * 60_000,
      });
      const last = [...thread.entries].reverse().find((e) => e.role === "assistant" && e.text);
      setReply(last?.text ?? "(no reply)");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={grow}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={`ask ${name}…`}
            aria-label={`ask ${name}`}
            className="block max-h-32 min-h-[26px] w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <button
            onClick={() => void send()}
            disabled={!text.trim() || busy}
            aria-label="send"
            className="tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:bg-surface-2 disabled:text-faint"
          >
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
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
      {asked !== null && (
        <Sheet
          title={name}
          sub={asked}
          onClose={() => {
            if (!busy) setAsked(null);
          }}
        >
          {busy && (
            <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
              working…
            </div>
          )}
          {error && <div className="font-mono text-[12px] text-fail">{error}</div>}
          {reply && (
            <div className="text-[14px]">
              <Markdown components={MD}>{reply}</Markdown>
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Link to="/ai" className="font-mono text-[12px] text-accent hover:underline">
              open the thread →
            </Link>
          </div>
        </Sheet>
      )}
    </>
  );
}

export default function Today() {
  const { data: sessions } = usePoll<Session[]>("/api/sessions", 8_000);
  const { data: runs } = usePoll<ScheduleRun[]>("/api/runs", 30_000);
  const { data: proposed } = usePoll<{ proposals: Memory[] }>("/api/memory/proposed", 120_000);
  const { data: config } = usePoll<AssistantConfig>("/api/assistant/config", 300_000);
  const { data: profile } = usePoll<Profile>("/api/profile", 300_000);
  const name = config?.name?.trim() || "the assistant";

  const waiting = (sessions ?? []).filter((s) => s.status === "waiting");
  const running = (sessions ?? []).filter((s) => s.status === "running");
  const flagged = (runs ?? []).filter((r) => r.outcome === "attention" || r.outcome === "failed");
  const proposals = proposed?.proposals.length ?? 0;
  // The brief is the newest thing an assistant schedule said. A run that
  // started a session is not one: its report is a repo's, not the morning's.
  const brief = (runs ?? []).find((r) => r.kind === "assistant" && r.report);
  const loaded = sessions !== null && runs !== null;
  const needs = waiting.length + flagged.length + (proposals ? 1 : 0);

  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-[18px] pt-[22px] pb-[calc(96px+env(safe-area-inset-bottom))] min-[800px]:pb-[60px]">
        <div className="grid gap-8 min-[1000px]:grid-cols-[minmax(0,1fr)_300px]">
          <section className="flex min-w-0 flex-col gap-7">
            <div>
              <h1 className="text-[22px] font-bold tracking-[-.03em]">{dateLine()}</h1>
              <div className="mt-1 text-sm text-muted">
                {!loaded
                  ? "…"
                  : needs
                    ? `${needs} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you`
                    : "Nothing needs you."}
              </div>
            </div>

            {loaded && needs > 0 && (
              <div>
                <Label>Needs you</Label>
                <div className="flex flex-col gap-1.5">
                  {waiting.map((s) => (
                    <Need
                      key={s.id}
                      to={`/s/${s.id}`}
                      chip="wait"
                      text={`${s.project}: ${s.title}`}
                    />
                  ))}
                  {flagged.map((r) => (
                    <Need
                      key={`${r.scheduleId}-${r.at}`}
                      to={r.sessionId ? `/s/${r.sessionId}` : "/runs"}
                      chip={r.outcome === "failed" ? "fail" : "wait"}
                      text={`${r.schedule}: ${r.report ?? r.error ?? ""}`}
                    />
                  ))}
                  {proposals > 0 && (
                    <Need
                      to="/runs"
                      chip="wait"
                      text={`${proposals} proposed memor${proposals === 1 ? "y" : "ies"} to keep or drop`}
                    />
                  )}
                </div>
              </div>
            )}

            <div>
              <Label>{brief ? `From ${name}` : "Brief"}</Label>
              {brief ? (
                <div className="rounded-xl border border-accent/30 bg-accent-tint px-4 py-3">
                  <div className="mb-2 flex items-center gap-2 font-mono text-[11px] text-faint">
                    <StatusChip kind={OUTCOME[brief.outcome] ?? "idle"} label={brief.outcome} />
                    <span className="truncate">{brief.schedule}</span>
                    <span className="ml-auto flex-none">{agoLabel(brief.at)}</span>
                  </div>
                  <div className="text-[14px]">
                    <Markdown components={MD}>{brief.report ?? ""}</Markdown>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-line bg-surface px-4 py-3 text-[13.5px] text-muted">
                  No brief yet. A morning briefing is an assistant schedule with a standing
                  question;{" "}
                  <Link to="/settings" className="text-accent hover:underline">
                    set one up
                  </Link>{" "}
                  and it lands here.
                </div>
              )}
            </div>

            {profile !== null && profile !== undefined && !profile.text.trim() && (
              <Link
                to="/settings#profile"
                className="tap flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 hover:border-accent-pastel"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">
                    Tell {name} about yourself
                  </span>
                  <span className="block text-[12.5px] text-faint">
                    Who matters, what recurs, what counts as urgent. Read at the start of every
                    conversation.
                  </span>
                </span>
                <span className="flex-none text-[13px] text-faint">→</span>
              </Link>
            )}

            <div className="min-[1000px]:hidden">
              <Running sessions={running} />
            </div>

            <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] min-[800px]:bottom-4">
              <Composer name={name} />
            </div>
          </section>

          <aside className="hidden min-[1000px]:flex min-[1000px]:flex-col min-[1000px]:gap-7">
            <Running sessions={running} />
            <div>
              <Label>Recent runs</Label>
              {runs?.length ? (
                <div className="flex flex-col gap-1.5">
                  {runs.slice(0, 6).map((r) => (
                    <Link
                      key={`${r.scheduleId}-${r.at}`}
                      to={r.sessionId ? `/s/${r.sessionId}` : "/runs"}
                      className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 hover:border-line-strong"
                    >
                      <StatusChip kind={OUTCOME[r.outcome] ?? "idle"} label={r.outcome} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.schedule}</span>
                      <span className="flex-none font-mono text-[11px] text-faint">
                        {agoLabel(r.at)}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-[13px] text-faint">nothing has run yet</div>
              )}
            </div>
          </aside>
        </div>
      </main>
      <Tabs />
    </div>
  );
}

function Running({ sessions }: { sessions: Session[] }) {
  return (
    <div>
      <Label>Running</Label>
      {sessions.length ? (
        <div className="flex flex-col gap-1.5">
          {sessions.map((s) => (
            <Link
              key={s.id}
              to={`/s/${s.id}`}
              className="tap flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 hover:border-accent-pastel"
            >
              <AgentMark agent={s.agent} />
              <span className="max-w-[7.5rem] flex-none truncate text-[11px] font-semibold tracking-[.06em] text-faint uppercase">
                {s.project}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{s.title}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-[13px] text-faint">nothing running</div>
      )}
    </div>
  );
}
