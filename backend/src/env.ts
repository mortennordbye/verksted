// Central validated env. Agent credentials (CLAUDE_CODE_OAUTH_TOKEN etc.) are
// deliberately not read here — they pass through to the CLIs inside tmux.

function fail(msg: string): never {
  console.error(`env: ${msg}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`PORT must be a port number, got "${process.env.PORT}"`);
}

const ntfyUrl = process.env.NTFY_URL ?? "";
if (ntfyUrl && !/^https?:\/\//.test(ntfyUrl)) {
  fail(`NTFY_URL must be an http(s) topic URL, got "${ntfyUrl}"`);
}

// The assistant answers from a phone and mostly reads state back: the heavy
// reasoning happens in the sessions it delegates to, not in the chat. Defaulting
// it to a big model burns a subscription's usage on summarising a status blob.
//
// The one thing worth watching before lowering these further: its hardest job is
// writing the prompt for a session it starts, and a vague prompt wastes a whole
// session, which costs far more than every assistant turn in a day. If
// delegation starts arriving underspecified, raise the model before the effort.
const assistantModel = process.env.ASSISTANT_MODEL ?? "haiku";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const assistantEffort = process.env.ASSISTANT_EFFORT ?? "low";
if (!EFFORTS.includes(assistantEffort)) {
  fail(`ASSISTANT_EFFORT must be one of ${EFFORTS.join(", ")}, got "${assistantEffort}"`);
}

const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
if (publicUrl && !/^https?:\/\//.test(publicUrl)) {
  fail(`PUBLIC_URL must be an http(s) URL, got "${publicUrl}"`);
}

// Extra browser origins allowed to make mutating and websocket requests, on top
// of same-origin (see origin.ts). Only needed when the frontend is served from a
// different origin than the API — the single-container deployment is not.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);
for (const o of allowedOrigins) {
  if (!/^https?:\/\/[^/]+$/.test(o)) {
    fail(`ALLOWED_ORIGINS entries must be scheme://host[:port], got "${o}"`);
  }
}

export const env = {
  PORT: port,
  REPOS_DIR: process.env.REPOS_DIR ?? "/data/repos",
  SESSIONS_DIR: process.env.SESSIONS_DIR ?? "/data/sessions",
  // One JSON file per recurring prompt (see schedules-store.ts).
  SCHEDULES_DIR: process.env.SCHEDULES_DIR ?? "/data/schedules",
  // The assistant's threads: one JSONL per conversation (see assistant.ts).
  ASSISTANT_DIR: process.env.ASSISTANT_DIR ?? "/data/assistant",
  // What verksted has learned: one markdown file per fact (see memory-store.ts).
  MEMORY_DIR: process.env.MEMORY_DIR ?? "/data/memory",
  // Model and reasoning effort for the assistant only; sessions are unaffected.
  ASSISTANT_MODEL: assistantModel,
  ASSISTANT_EFFORT: assistantEffort,
  // Absolute path to the built frontend; empty in dev, where Vite serves it.
  STATIC_DIR: process.env.STATIC_DIR ?? "",
  // Agent env vars set via the settings page persist here (on the PVC).
  SETTINGS_FILE: process.env.SETTINGS_FILE ?? "/data/settings.json",
  // SSH keys managed via the settings page; $HOME so ssh/git find them natively.
  SSH_DIR: process.env.SSH_DIR ?? `${process.env.HOME ?? "/data/home"}/.ssh`,
  // Web-push VAPID keypair and device subscriptions (on the PVC, self-managing).
  PUSH_FILE: process.env.PUSH_FILE ?? "/data/push.json",
  // ntfy topic URL for session pushes; empty disables the notifier.
  NTFY_URL: ntfyUrl,
  // Where the app is reachable (over the VPN); used for ntfy click-through links.
  PUBLIC_URL: publicUrl,
  // Cross-origin allowlist; empty means same-origin only.
  ALLOWED_ORIGINS: allowedOrigins,
};
