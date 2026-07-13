import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await exec("tmux", ["ls", "-F", "#{session_name}"]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    // No tmux server running means no sessions.
    return [];
  }
}

export async function newSession(name: string, cwd: string, command: string): Promise<void> {
  await exec("tmux", ["new-session", "-d", "-s", name, "-c", cwd]);
  // The web UI draws its own bar; tmux's would just eat a row.
  await exec("tmux", ["set-option", "-g", "status", "off"]);
  await exec("tmux", ["send-keys", "-t", name, command, "Enter"]);
}

export async function killSession(name: string): Promise<void> {
  await exec("tmux", ["kill-session", "-t", name]);
}
