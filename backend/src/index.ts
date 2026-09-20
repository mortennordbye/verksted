import fs from "node:fs";
import { env } from "./env.js";
import { buildApp } from "./app.js";
import { sweepTempFiles } from "./atomic-json.js";
import { killAll } from "./browser.js";
import { setEventLogger } from "./events.js";
import { stop as stopVoice } from "./tts.js";
import { startMaintenance } from "./maintenance.js";
import { startNightly as startNightlyBackup } from "./backups-store.js";
import { startNotifier } from "./notifier.js";
import { startPollers } from "./pollers.js";
import { inject as injectMemory } from "./memory-store.js";
import { ensureSandboxNotes } from "./sandbox-doc.js";
import { seedCouncil } from "./council-store.js";
import { startPlanHistory } from "./plan.js";
import { reloadSchedules, startFeedWork } from "./scheduler.js";
import { restoreSessions } from "./sessions-store.js";

// First boot on an empty volume.
for (const dir of [
  env.REPOS_DIR,
  env.SESSIONS_DIR,
  env.SCHEDULES_DIR,
  env.ASSISTANT_DIR,
  env.MEMORY_DIR,
  env.COUNCIL_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = await buildApp();
setEventLogger(app.log);
// Before the sessions start: agents read their global memory file when a
// session begins, so a restored session should already find the note there.
await ensureSandboxNotes(app.log);
// Memory is edited as files on the volume, so what sessions are told is rebuilt
// from the directory at boot rather than trusted to be current.
await injectMemory();
// The council, on an empty volume only: a member removed by hand stays removed.
await seedCouncil();
// Before listening, not after: the first request to list sessions is also what
// stamps a tmux-less session as done, and it must not beat the restore to them.
await restoreSessions(app.log);
await app.listen({ port: env.PORT, host: "0.0.0.0" });
startNotifier(app.log);
startPollers(app.log);
startFeedWork(app.log);
startMaintenance(app.log);
startNightlyBackup(app.log);
// A pod killed mid-write leaves a temp file behind; sessions sweep theirs in
// restoreSessions, and this is the schedules' equivalent.
await sweepTempFiles(env.SCHEDULES_DIR);
await reloadSchedules(app.log);
// How full the plan is, once an hour, kept: the account keeps no history.
startPlanHistory(app.log);

// A rejection nobody handled would otherwise take the process down with Node's
// default, killing every tmux attach and both websockets for something as small
// as one failed git call in an interval body.
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason }, "unhandled rejection");
});

// Chromium children would outlive a dev-watch restart otherwise. Closing the
// app first lets in-flight requests finish and websockets close cleanly, rather
// than every phone seeing a dropped socket on a rolling restart.
let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const done = () => {
    killAll();
    stopVoice();
    process.exit(code);
  };
  void app
    .close()
    .catch((err: unknown) => app.log.error({ err }, "shutdown failed"))
    .finally(done);
  // Kubernetes sends SIGKILL after its grace period regardless; this just
  // makes sure a wedged close does not hold chromium processes open.
  setTimeout(done, 8_000).unref();
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => shutdown(0));
}

/**
 * A synchronous throw nobody caught (R-23).
 *
 * Without a handler Node prints and exits at once, and tmux runs in this
 * container: the pane, the agent and its working state go with the process,
 * and only claude sessions can be restored. One throw from an event handler —
 * `pty.resize` on a terminal that has just closed is the known candidate —
 * cost a night's unattended work.
 *
 * It still exits, because a process that has thrown out of a listener is in a
 * state nothing here can reason about, and k8s restarting it is the recovery.
 * What this adds is the door on the way out: websockets closed rather than
 * dropped, chromium children killed rather than orphaned, and a log line
 * saying what happened. Non-zero, so a crash loop is visible as one.
 */
process.on("uncaughtException", (err) => {
  app.log.error({ err }, "uncaught exception, shutting down");
  shutdown(1);
});
