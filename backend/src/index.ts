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

// Chromium children would outlive a dev-watch restart otherwise.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    killAll();
    process.exit(0);
  });
}
