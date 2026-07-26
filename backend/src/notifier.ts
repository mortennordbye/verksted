import type { Session } from "../../shared/api.js";
import { env } from "./env.js";
import * as push from "./push-store.js";
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

/** What the notification says, on either channel. */
function body(s: Session): string {
  return s.status === "waiting" ? "waiting for input" : "session finished";
}

async function ntfy(s: Session, log: Logger): Promise<void> {
  if (!env.NTFY_URL) return;
  try {
    const res = await fetch(env.NTFY_URL, {
      method: "POST",
      body: body(s),
      headers: {
        "X-Title": `${s.title} · ${s.project}`,
        "X-Tags": s.status === "waiting" ? "hourglass_flowing_sand" : "checkered_flag",
        ...(s.status === "waiting" ? { "X-Priority": "high" } : {}),
        // Tapping the push opens the session that wants attention.
        ...(env.PUBLIC_URL ? { "X-Click": `${env.PUBLIC_URL}/s/${s.id}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn(`ntfy push failed: HTTP ${res.status}`);
  } catch (err) {
    log.warn(err, "ntfy push failed");
  }
}

/** Both channels, independently: neither failing should silence the other. */
async function notify(s: Session, log: Logger): Promise<void> {
  await Promise.all([
    ntfy(s, log),
    // Tapping the notification opens the session that wants attention.
    push.send({ title: `${s.title} · ${s.project}`, body: body(s), url: `/s/${s.id}` }, log),
  ]);
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
      if (prev) for (const s of transitions(prev, sessions)) await notify(s, log);
      prev = new Map(sessions.map((s) => [s.id, s.status]));
    } catch (err) {
      log.warn(err, "notifier poll failed");
    }
  }, 5_000);
}
