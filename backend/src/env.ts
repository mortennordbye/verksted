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

export const env = {
  PORT: port,
  REPOS_DIR: process.env.REPOS_DIR ?? "/data/repos",
  SESSIONS_DIR: process.env.SESSIONS_DIR ?? "/data/sessions",
  // Absolute path to the built frontend; empty in dev, where Vite serves it.
  STATIC_DIR: process.env.STATIC_DIR ?? "",
};
