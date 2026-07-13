import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// The tmux server inherits its locale from whoever starts it; without UTF-8 it
// mangles multibyte output to "_". Guarantee it even if the image env lacks LANG.
export const UTF8_ENV = { ...process.env, LANG: process.env.LANG ?? "C.UTF-8" };

export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await exec("tmux", ["ls", "-F", "#{session_name}"]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    // No tmux server running means no sessions.
    return [];
  }
}

/** KEY=VALUE args for tmux new-session -e (sets env inside the new session). */
export function envArgs(vars: Record<string, string>): string[] {
  return Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

export async function newSession(
  name: string,
  cwd: string,
  command: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  await exec("tmux", ["new-session", "-d", "-s", name, "-c", cwd, ...envArgs(extraEnv)], {
    env: UTF8_ENV,
  });
  // The web UI draws its own bar; tmux's would just eat a row.
  await exec("tmux", ["set-option", "-g", "status", "off"]);
  await exec("tmux", ["send-keys", "-t", name, command, "Enter"]);
}

export async function killSession(name: string): Promise<void> {
  // "=" pins tmux to the exact name — never prefix-match e.g. a -shell sibling.
  await exec("tmux", ["kill-session", "-t", `=${name}`]);
}
