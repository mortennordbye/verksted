import fs from "node:fs";
import { env } from "./env.js";
import { buildApp } from "./app.js";
import { killAll } from "./browser.js";
import { startMaintenance } from "./maintenance.js";
import { startNotifier } from "./notifier.js";
import { reloadSchedules } from "./scheduler.js";
import { restoreSessions } from "./sessions-store.js";

// First boot on an empty volume.
for (const dir of [env.REPOS_DIR, env.SESSIONS_DIR, env.SCHEDULES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = await buildApp();
// Before listening, not after: the first request to list sessions is also what
// stamps a tmux-less session as done, and it must not beat the restore to them.
await restoreSessions(app.log);
await app.listen({ port: env.PORT, host: "0.0.0.0" });
startNotifier(app.log);
startMaintenance(app.log);
await reloadSchedules(app.log);

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
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app
      .close()
      .catch((err: unknown) => app.log.error({ err }, "shutdown failed"))
      .finally(() => {
        killAll();
        process.exit(0);
      });
    // Kubernetes sends SIGKILL after its grace period regardless; this just
    // makes sure a wedged close does not hold chromium processes open.
    setTimeout(() => {
      killAll();
      process.exit(0);
    }, 8_000).unref();
  });
}
