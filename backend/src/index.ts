import fs from "node:fs";
import { env } from "./env.js";
import { buildApp } from "./app.js";
import { killAll } from "./browser.js";
import { startMaintenance } from "./maintenance.js";
import { startNotifier } from "./notifier.js";

// First boot on an empty volume.
for (const dir of [env.REPOS_DIR, env.SESSIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });
startNotifier(app.log);
startMaintenance(app.log);

// Chromium children would outlive a dev-watch restart otherwise.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    killAll();
    process.exit(0);
  });
}
