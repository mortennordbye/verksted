import type { Session } from "../../shared/api.js";
import { env } from "./env.js";
import * as push from "./push-store.js";
import type { SendResult } from "./push-store.js";
import * as store from "./sessions-store.js";

type Status = Session["status"];

/** Status changes worth a push: a live session starts waiting, or ends. */
export function transitions(prev: Map<string, Status>, sessions: Session[]): Session[] {
  return sessions.filter((s) => {
    const was = prev.get(s.id);
    if (was === undefined || was === s.status) return false;
    return s.status === "waiting" || s.status === "done";
  });
}

/**
 * Whether a transition is worth waking someone for, given the verdict the run
 * left behind (see sessions-store readReport). A session that stopped to ask
 * something always is — that is what "waiting" means. A finished one is only
 * worth it if it did not report itself clean: the whole point of an unattended
 * schedule is that a quiet night stays quiet. No report is the old behaviour,
 * so a hand-started session still announces that it finished.
 */
export function shouldNotify(s: Session, report: string | null): boolean {
  if (s.status !== "done") return true;
  return !report || !/^ok\b/i.test(report);
}

/** What the notification says: the run's own words when it left any. */
function body(s: Session, report: string | null): string {
  return report ?? (s.status === "waiting" ? "waiting for input" : "session finished");
}

interface Announcement {
  title: string;
  body: string;
  /** Where tapping it lands, as an app path. */
  url: string;
  tag?: string;
  priority?: string;
}

async function ntfy(msg: Announcement, log: Logger): Promise<void> {
  if (!env.NTFY_URL) return;
  try {
    const res = await fetch(env.NTFY_URL, {
      method: "POST",
      body: msg.body,
      headers: {
        "X-Title": msg.title,
        ...(msg.tag ? { "X-Tags": msg.tag } : {}),
        ...(msg.priority ? { "X-Priority": msg.priority } : {}),
        // Tapping the push opens the thing that wants attention.
        ...(env.PUBLIC_URL ? { "X-Click": `${env.PUBLIC_URL}${msg.url}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn(`ntfy push failed: HTTP ${res.status}`);
  } catch (err) {
    log.warn(err, "ntfy push failed");
  }
}

/**
 * One message to every channel. Both are attempted independently: neither
 * failing should silence the other, and ntfy is configured on some benches and
 * not others.
 */
export async function announce(msg: Announcement, log: Logger): Promise<SendResult> {
  const [, result] = await Promise.all([
    ntfy(msg, log),
    push.send({ title: msg.title, body: msg.body, url: msg.url }, log),
  ]);
  return result;
}

async function notify(s: Session, report: string | null, log: Logger): Promise<void> {
  await announce(
    {
      title: `${s.title} · ${s.project}`,
      body: body(s, report),
      url: `/s/${s.id}`,
      tag: s.status === "waiting" ? "hourglass_flowing_sand" : "checkered_flag",
      ...(s.status === "waiting" ? { priority: "high" } : {}),
    },
    log,
  );
}

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Poll session statuses and push transitions to the ntfy topic and every
 * subscribed device. Polling (not hooks) because "finished" means the tmux
 * session died, which no hook can report, and no client is polling the API when
 * the phone is in a pocket.
 */
export function startNotifier(log: Logger): void {
  let prev: Map<string, Status> | null = null;
  setInterval(async () => {
    try {
      // Nothing subscribed and no ntfy topic: stay idle, and re-seed rather
      // than fire a backlog of transitions at whoever subscribes later.
      if (!env.NTFY_URL && (await push.deviceCount()) === 0) {
        prev = null;
        return;
      }
      const sessions = await store.listSessions();
      if (prev) {
        for (const s of transitions(prev, sessions)) {
          // Session carries its own report now, for every state — a waiting
          // session that wrote one can say what it is waiting about rather
          // than pushing the word "waiting".
          const report = s.report;
          if (shouldNotify(s, report)) await notify(s, report, log);
        }
      }
      prev = new Map(sessions.map((s) => [s.id, s.status]));
    } catch (err) {
      log.warn(err, "notifier poll failed");
    }
  }, 5_000);
}
