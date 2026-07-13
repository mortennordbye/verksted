import fs from "node:fs";
import { env } from "./env.js";
import { buildApp } from "./app.js";

// First boot on an empty volume.
for (const dir of [env.REPOS_DIR, env.SESSIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });
