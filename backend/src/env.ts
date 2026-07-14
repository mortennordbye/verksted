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

const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
if (publicUrl && !/^https?:\/\//.test(publicUrl)) {
  fail(`PUBLIC_URL must be an http(s) URL, got "${publicUrl}"`);
}

export const env = {
  PORT: port,
  REPOS_DIR: process.env.REPOS_DIR ?? "/data/repos",
  SESSIONS_DIR: process.env.SESSIONS_DIR ?? "/data/sessions",
  // Absolute path to the built frontend; empty in dev, where Vite serves it.
  STATIC_DIR: process.env.STATIC_DIR ?? "",
  // Agent env vars set via the settings page persist here (on the PVC).
  SETTINGS_FILE: process.env.SETTINGS_FILE ?? "/data/settings.json",
  // SSH keys managed via the settings page; $HOME so ssh/git find them natively.
  SSH_DIR: process.env.SSH_DIR ?? `${process.env.HOME ?? "/data/home"}/.ssh`,
  // ntfy topic URL for session pushes; empty disables the notifier.
  NTFY_URL: ntfyUrl,
  // Where the app is reachable (over the VPN); used for ntfy click-through links.
  PUBLIC_URL: publicUrl,
};
