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
// Tried at haiku first, and moved back up on the evidence: it escalated where
// sonnet diagnosed (asking for bash to inspect a broken image rather than
// reading the error), and it leaked the closing pleasantries the persona bans.
// The saving was not worth it either, once collapsing three lookups into one
// status call had already cut a turn from nine round trips to two — that win is
// model-independent, and this agent is a handful of short turns a day. The
// subscription goes on the sessions doing the engineering, not on the chat.
//
// These are the floor, not the ceiling: the settings page overrides both.
const assistantModel = process.env.ASSISTANT_MODEL ?? "sonnet";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const assistantEffort = process.env.ASSISTANT_EFFORT ?? "low";
if (!EFFORTS.includes(assistantEffort)) {
  fail(`ASSISTANT_EFFORT must be one of ${EFFORTS.join(", ")}, got "${assistantEffort}"`);
}

// A cron pattern is wall-clock time, so the pod's timezone is part of what a
// schedule means: "0 7 * * *" is 07:00 where the person reading it lives, not
// 07:00 UTC. The image sets TZ so a deployment that configures nothing is still
// right, and croner is handed this explicitly rather than left to read ambient
// process state — the two disagreeing is exactly the bug that is hard to see.
const timezone = process.env.TZ || "Europe/Oslo";
try {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
} catch {
  fail(`TZ must be an IANA timezone name, got "${timezone}"`);
}

// 0 disables the nightly run, leaving backups entirely manual.
const backupKeep = Number(process.env.VK_BACKUP_KEEP ?? "7");
if (!Number.isInteger(backupKeep) || backupKeep < 0) {
  fail(`VK_BACKUP_KEEP must be a whole number of archives, got "${process.env.VK_BACKUP_KEEP}"`);
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
  // The council: one JSON file per member (see council-store.ts).
  COUNCIL_DIR: process.env.COUNCIL_DIR ?? "/data/council",
  // The maintainer's stage prompts, shipped in the image (see maintainer.ts).
  MAINTAINER_DIR: process.env.MAINTAINER_DIR ?? "/etc/verksted/maintainer",
  // The plan's windows, sampled hourly (see plan.ts): one JSONL, on the PVC.
  USAGE_DIR: process.env.USAGE_DIR ?? "/data/usage",
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
  // Where `vk backup` writes its archives. In the pod this is an NFS mount off
  // the NAS, deliberately not the PVC: an export stored on the volume it exists
  // to replace is an undo button, not a backup. The default is the fallback for
  // a laptop or `make run`, where there is nowhere else to put it.
  VK_BACKUP_DIR: process.env.VK_BACKUP_DIR ?? "/data/backups",
  // How many timestamped archives the nightly run keeps (see maintenance.ts).
  VK_BACKUP_KEEP: backupKeep,
  // ntfy topic URL for session pushes; empty disables the notifier.
  NTFY_URL: ntfyUrl,
  // Where the app is reachable (over the VPN); used for ntfy click-through links.
  PUBLIC_URL: publicUrl,
  // Cross-origin allowlist; empty means same-origin only.
  ALLOWED_ORIGINS: allowedOrigins,
  // IANA zone every cron pattern is read in (see above).
  TZ: timezone,
  // The assistant's voice: a neural model on the pod (see tts.ts). Baked into
  // the image at these paths; overridable so a dev box can point at a copy
  // rather than carry 200 MB it does not use. Missing files are not an error —
  // the app answers "no voice here" and the browser reads replies instead.
  KOKORO_PYTHON: process.env.KOKORO_PYTHON ?? "/opt/kokoro/venv/bin/python",
  KOKORO_SCRIPT: process.env.KOKORO_SCRIPT ?? "/etc/verksted/vk-say.py",
  KOKORO_MODEL: process.env.KOKORO_MODEL ?? "/usr/local/share/kokoro/kokoro.onnx",
  KOKORO_VOICES: process.env.KOKORO_VOICES ?? "/usr/local/share/kokoro/voices.bin",
  // Which of the model's voices the assistant speaks in by default.
  KOKORO_VOICE: process.env.KOKORO_VOICE ?? "af_heart",
};
