import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Secrets that travel in a command line.
 *
 * A session's environment reaches tmux as `-e KEY=VALUE` arguments, so what
 * execFile rejects with — "Command failed: " and the whole argv, then the same
 * string again on `err.cmd` — has GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN written
 * out in it. Fastify answered a failed launch with that message and pino logged
 * it, so one `tmux: command not found` published every credential on the pod.
 *
 * The argv itself is the wider fix (a session runs as the same uid as the
 * backend today, so /proc/<pid>/cmdline is readable to it either way); this is
 * the part that leaves the pod.
 */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|_KEY|APIKEY)[A-Za-z0-9_]*)=\S+/g;

/**
 * The other place a credential travels: a remote written as
 * `https://user:token@host/…`. git names the remote in most of what it says
 * when a fetch or push fails, and the first line of that is shown to the client.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_ASSIGNMENT, "$1=***").replace(URL_USERINFO, "$1***@");
}

/**
 * promisify(execFile), which nine modules each declared for themselves.
 *
 * Always the argv form, never a shell string: every caller here passes client
 * input somewhere in the arguments, and that is the property the whole command
 * surface depends on. The signature says so rather than leaving the shell form
 * available.
 */
/**
 * How long a command gets when its caller did not say.
 *
 * None was the default, and several of these run inside a queue: session
 * creation is serialised, so one `tmux new-session` that never came back held
 * every later create behind it, the scheduler's included, until the pod was
 * restarted. A minute is far past anything here that is working. A caller with
 * a reason to wait longer passes its own `timeout`, and 0 still means none.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export async function exec(
  file: string,
  args: readonly string[],
  opts?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  try {
    // No caller asks for a buffer, and the option is not in this signature.
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
    return (await run(file, args as string[], { ...opts, timeout })) as {
      stdout: string;
      stderr: string;
    };
  } catch (err) {
    // In place, so callers keep reading stderr, code and killed off the same
    // error they always did.
    const e = err as { message?: unknown; cmd?: unknown };
    if (typeof e.message === "string") e.message = redactSecrets(e.message);
    if (typeof e.cmd === "string") e.cmd = redactSecrets(e.cmd);
    throw err;
  }
}
