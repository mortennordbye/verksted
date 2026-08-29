import { exec } from "./exec.js";

// The tmux server inherits its locale from whoever starts it; without UTF-8 it
// mangles multibyte output to "_". Guarantee it even if the image env lacks LANG.
export const UTF8_ENV = { ...process.env, LANG: process.env.LANG ?? "C.UTF-8" };

/** tmux could not be asked what is live — which is not the same as "nothing is". */
export class TmuxUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super("tmux unavailable");
  }
}

// How tmux says "there is no server", which is the ordinary empty case: it
// exits 1 with one of these on stderr. Anything else is a real failure.
const NO_SERVER_RE = /no server running|error connecting to .*no such file or directory/i;

/**
 * Live tmux session names.
 *
 * Throws rather than returning [] when tmux itself is unreachable. The
 * difference matters: callers use this set to decide a session is over, so
 * swallowing a fork failure or a missing binary would stamp every session as
 * finished and fire a "finished" push for each one, on every poll.
 */
export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await exec("tmux", ["ls", "-F", "#{session_name}"], { timeout: 5_000 });
    return stdout.split("\n").filter(Boolean);
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean };
    if (!e.killed && NO_SERVER_RE.test(String(e.stderr ?? ""))) return [];
    throw new TmuxUnavailableError(err);
  }
}

/** KEY=VALUE args for tmux new-session -e (sets env inside the new session). */
export function envArgs(vars: Record<string, string>): string[] {
  return Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

/**
 * The agent command is the session's own shell-command, not something typed
 * into it afterwards.
 *
 * It used to be delivered with `send-keys` right after `new-session`, which
 * races the pane shell's startup: keystrokes sent before the shell is reading
 * are simply dropped, and the session then sits at an empty prompt with no
 * agent in it and no sign of why.
 *
 * The trailing `exec` is what makes the two forms equivalent. Passing a bare
 * command would end the tmux session the moment the agent exits, and that shell
 * is load-bearing: it is how you restart a crashed agent in the same session,
 * and it is what keeps a failed agent command on screen to be read instead of
 * the session vanishing. Replacing the wrapper with the login shell keeps both.
 *
 * The command reaches `sh -c` exactly as before — it is built here, never from
 * client input, and the only user text in it is `"$VK_PROMPT"`, a quoted
 * expansion of a variable set through `-e`.
 */
export async function newSession(
  name: string,
  cwd: string,
  command: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  await exec(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      cwd,
      ...envArgs(extraEnv),
      `${command}; exec "\${SHELL:-/bin/sh}"`,
    ],
    { env: UTF8_ENV },
  );
  // The web UI draws its own bar; tmux's would just eat a row.
  await exec("tmux", ["set-option", "-g", "status", "off"]);
}

/** What a pane runs once the command it was started with has exited. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "fish"]);

/**
 * Whether the session's agent has exited and left the pane at its shell.
 *
 * The one question an unattended run's watcher has: the agent runs headless
 * and exits on its own, but the pane keeps a shell after it (see newSession),
 * so tmux still lists the session and nothing else says the run is over.
 */
export async function paneIdle(name: string): Promise<boolean> {
  const { stdout } = await exec(
    "tmux",
    ["display-message", "-p", "-t", `=${name}:`, "#{pane_current_command}"],
    { env: UTF8_ENV, timeout: 5_000 },
  );
  return SHELLS.has(stdout.trim());
}

/**
 * Scroll a pane's scrollback. tmux's history is the only scrollback there is:
 * `tmux attach` runs in the alternate screen, so the browser terminal keeps
 * none of its own and would turn scroll gestures into arrow keys instead.
 * Positive lines go back in history, negative forward. "-e" leaves copy mode
 * on its own once the view is back at the bottom.
 */
export async function scrollHistory(name: string, lines: number): Promise<void> {
  // Pane target, so the session part needs the trailing ":" — bare "=name" is
  // read as a pane name and never resolves. "=" still pins the exact session.
  const target = `=${name}:`;
  // Bounded: the caller queues keystrokes behind these, so a wedged tmux must
  // not hold the session's input hostage.
  await exec("tmux", ["copy-mode", "-e", "-t", target], { timeout: 3000 });
  await exec(
    "tmux",
    [
      "send-keys",
      "-t",
      target,
      "-X",
      "-N",
      String(Math.abs(lines)),
      lines > 0 ? "scroll-up" : "scroll-down",
    ],
    { timeout: 3000 },
  );
}

/** Return a scrolled pane to the live view; a no-op when it isn't in copy mode. */
export async function exitCopyMode(name: string): Promise<void> {
  try {
    await exec("tmux", ["send-keys", "-t", `=${name}:`, "-X", "cancel"], { timeout: 3000 });
  } catch {
    // "not in a mode" — the pane was already live (tmux's own -e exit).
  }
}

/**
 * Type text into a session's pane, as if it had come over the attach socket.
 *
 * "-l" is literal mode: without it tmux interprets the text as key names, so a
 * prompt containing "Enter" or "C-c" would be read as keystrokes. The caller
 * asks for a trailing Return separately, which is the only key this sends.
 *
 * The argv form means nothing here reaches a shell — but the text does reach
 * the agent's stdin, which is exactly what the terminal websocket already
 * allows, so this adds no capability beyond convenience.
 */
export async function sendText(name: string, text: string, enter: boolean): Promise<void> {
  // Pane target, so the session part needs the trailing ":" — same as
  // scrollHistory. Bare "=name" is read as a pane name and never resolves.
  const target = `=${name}:`;
  await exec("tmux", ["send-keys", "-t", target, "-l", "--", text], { timeout: 5_000 });
  if (enter) {
    await exec("tmux", ["send-keys", "-t", target, "Enter"], { timeout: 5_000 });
  }
}

/**
 * Press one named key, which `sendText` deliberately cannot.
 *
 * That function runs send-keys with "-l" so a message containing the word
 * "Enter" is typed rather than pressed — which is the right default when what
 * you have is a person's prose. This is the other half, for when what you have
 * is a key. The caller's key name never comes out of a request: the route that
 * uses this takes an enum, so the set of things that can be pressed is fixed
 * here and at the schema rather than being whatever arrived.
 */
export async function sendKey(name: string, key: string): Promise<void> {
  await exec("tmux", ["send-keys", "-t", `=${name}:`, key], { timeout: 5_000 });
}

/** The last `lines` rows of a pane, as plain text. */
export async function capturePane(name: string, lines: number): Promise<string> {
  const { stdout } = await exec(
    "tmux",
    // -p to stdout, -J so a wrapped line comes back as one, -S -N for how far
    // back to start.
    ["capture-pane", "-p", "-J", "-t", `=${name}:`, "-S", `-${lines}`],
    { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: UTF8_ENV },
  );
  return stdout;
}

export async function killSession(name: string): Promise<void> {
  // "=" pins tmux to the exact name — never prefix-match e.g. a -shell sibling.
  await exec("tmux", ["kill-session", "-t", `=${name}`]);
}
