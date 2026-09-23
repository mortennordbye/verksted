import fs from "node:fs";
import { env } from "./env.js";
import { configureAgent } from "./agent-user.js";
import { prepareForAgents } from "./agent-setup.js";
import { buildApp } from "./app.js";
import { stopAll as stopTurns } from "./assistant-turn.js";
import { sweepTempFiles } from "./atomic-json.js";
import { killAll } from "./browser.js";
import { setEventLogger } from "./events.js";
import { stop as stopVoice } from "./tts.js";
import { startMaintenance } from "./maintenance.js";
import { startNightly as startNightlyBackup } from "./backups-store.js";
import { announceRestartFailures, startNotifier } from "./notifier.js";
import { startPollers } from "./pollers.js";
import { inject as injectMemory } from "./memory-store.js";
import { ensureSandboxNotes } from "./sandbox-doc.js";
import { seedCouncil } from "./council-store.js";
import { startPlanHistory } from "./plan.js";
import { startFeedWork } from "./assistant-jobs.js";
import { reloadSchedules } from "./scheduler.js";
import { startSweeper } from "./sweeper.js";
import { restoreSessions } from "./session-launch.js";

// First boot on an empty volume, and the check env.ts cannot make at import:
// that every directory the app writes to is there, or can be made, and takes a
// write. A read-only mount or a wrong owner used to surface as the first
// request that touched it failing, minutes in, with an EACCES from wherever.
// The share (DOCS_DIR) and the shipped prompts are read-only by design, and
// the backup target is checked by the backup itself, where it can say so.
for (const [name, dir] of [
  ["REPOS_DIR", env.REPOS_DIR],
  ["SESSIONS_DIR", env.SESSIONS_DIR],
  ["SCHEDULES_DIR", env.SCHEDULES_DIR],
  ["ASSISTANT_DIR", env.ASSISTANT_DIR],
  ["MEMORY_DIR", env.MEMORY_DIR],
  ["COUNCIL_DIR", env.COUNCIL_DIR],
  ["FEED_DIR", env.FEED_DIR],
  ["LOOPS_DIR", env.LOOPS_DIR],
  ["USAGE_DIR", env.USAGE_DIR],
  ["DOCS_INDEX_DIR", env.DOCS_INDEX_DIR],
] as const) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    console.error(
      `env: ${name}=${dir} is not a writable directory (${(e as NodeJS.ErrnoException).code})`,
    );
    process.exit(1);
  }
}

// Who sessions run as (agent-user.ts). A name with no user behind it fails
// the boot here rather than every session launch later.
try {
  configureAgent(env.VK_AGENT_USER, env.VK_TMUX_SOCKET, [
    env.REPOS_DIR,
    env.SESSIONS_DIR,
    env.SSH_DIR,
  ]);
} catch (e) {
  console.error(`env: ${(e as Error).message}`);
  process.exit(1);
}

const app = await buildApp();
setEventLogger(app.log);
// Before anything writes into the repos or a session starts: the volume as
// the agent user needs it. A no-op without one.
await prepareForAgents(app.log);
// Before the sessions start: agents read their global memory file when a
// session begins, so a restored session should already find the note there.
await ensureSandboxNotes(app.log);
// Memory is edited as files on the volume, so what sessions are told is rebuilt
// from the directory at boot rather than trusted to be current.
await injectMemory();
// The council, on an empty volume only: a member removed by hand stays removed.
await seedCouncil();
// Before the sweeper, not after: the sweep is what stamps a tmux-less session
// as done, and it must not beat the restore to them.
const endedByRestart = await restoreSessions(app.log);
await app.listen({ port: env.PORT, host: "0.0.0.0" });
// Not awaited: a push service that is slow to answer must not hold the boot.
void announceRestartFailures(endedByRestart, app.log);
startSweeper(app.log);
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
    stopTurns();
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
