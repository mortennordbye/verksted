import type { Session } from "../../shared/api.js";
import { env } from "./env.js";
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

async function push(s: Session, log: Logger): Promise<void> {
  try {
    const res = await fetch(env.NTFY_URL, {
      method: "POST",
      body: s.status === "waiting" ? "waiting for input" : "session finished",
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

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Poll session statuses and push transitions to the ntfy topic. Polling (not
 * hooks) because "finished" means the tmux session died, which no hook can
 * report, and no client is polling the API when the phone is in a pocket.
 */
export function startNotifier(log: Logger): void {
  if (!env.NTFY_URL) return;
  let prev: Map<string, Status> | null = null;
  setInterval(async () => {
    try {
      const sessions = await store.listSessions();
      if (prev) for (const s of transitions(prev, sessions)) await push(s, log);
      prev = new Map(sessions.map((s) => [s.id, s.status]));
    } catch (err) {
      log.warn(err, "notifier poll failed");
    }
  }, 5_000);
}
