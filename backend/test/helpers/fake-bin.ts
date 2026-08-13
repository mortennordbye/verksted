import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fake external binaries on PATH, so the code that shells out to tmux, gh and
 * git can be asserted without any of them really running.
 *
 * Everything in this app that touches the outside world goes through
 * `exec` (promisify(execFile)) with an argv array. execFile resolves a bare
 * command name against PATH, so putting a directory of executables in front of
 * it is enough to intercept every one of those calls — no module mocking, and
 * the argv asserted here is the argv the real binary would have received.
 *
 * Each fake records its argv and answers from a table of canned replies keyed
 * by argv prefix. That covers the decisions worth testing (which sessions get
 * restored, what command each is given, how a gh failure is surfaced) without
 * pretending to reimplement tmux.
 *
 * Paths are baked into the generated scripts rather than passed through the
 * environment: callers of `exec` pass their own `env`, so an env-carried
 * channel would vanish on exactly the calls that matter.
 */
export interface FakeCall {
  bin: string;
  argv: string[];
}

export interface Reply {
  /** Matches when the call's argv, joined by spaces, starts with this. */
  prefix: string;
  stdout?: string;
  stderr?: string;
  /** Exit code; a non-zero one makes `exec` reject, as the real binary would. */
  code?: number;
}

const HELPER = `
const fs = require("node:fs");
const [bin, logPath, repliesPath, ...argv] = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify({ bin, argv }) + "\\n");
let replies = {};
try {
  replies = JSON.parse(fs.readFileSync(repliesPath, "utf8"));
} catch {
  // No table configured yet: every call simply succeeds silently.
}
const joined = argv.join(" ");
// Longest prefix wins, so a specific reply can be added over a general one
// without depending on the order they were registered in.
const match = (replies[bin] || [])
  .filter((r) => joined.startsWith(r.prefix))
  .sort((a, b) => b.prefix.length - a.prefix.length)[0];
// Synchronous, and looping over partial writes: process.stdout.write to a pipe
// is asynchronous, so a process.exit() right after it silently truncates
// anything larger than the pipe buffer — which is exactly the size of output
// the truncation paths under test need.
function writeAll(fd, text) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}
if (match) {
  if (match.stdout) writeAll(1, match.stdout);
  if (match.stderr) writeAll(2, match.stderr);
  process.exit(match.code || 0);
}
process.exit(0);
`;

export class FakeBin {
  readonly dir: string;
  private readonly logPath: string;
  private readonly repliesPath: string;
  private readonly replies: Record<string, Reply[]> = {};
  private readonly realPath: string;

  private constructor(dir: string, bins: string[]) {
    this.dir = dir;
    this.logPath = path.join(dir, "calls.jsonl");
    this.repliesPath = path.join(dir, "replies.json");
    this.realPath = process.env.PATH ?? "";
    const helperPath = path.join(dir, "helper.cjs");

    fs.writeFileSync(helperPath, HELPER);
    fs.writeFileSync(this.logPath, "");
    fs.writeFileSync(this.repliesPath, "{}");
    for (const bin of bins) {
      const script = `#!/bin/sh\nexec node ${JSON.stringify(helperPath)} ${bin} ${JSON.stringify(
        this.logPath,
      )} ${JSON.stringify(this.repliesPath)} "$@"\n`;
      const p = path.join(dir, bin);
      fs.writeFileSync(p, script);
      fs.chmodSync(p, 0o755);
    }
  }

  /**
   * Put fakes for `bins` at the front of PATH. Must run before the modules
   * under test are imported: tmux.ts snapshots process.env into UTF8_ENV at
   * import time, and that snapshot is what its own calls are spawned with.
   */
  static install(bins: string[]): FakeBin {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-fakebin-"));
    const fake = new FakeBin(dir, bins);
    process.env.PATH = `${dir}${path.delimiter}${fake.realPath}`;
    return fake;
  }

  /**
   * Register a canned reply for calls whose argv starts with `prefix`.
   * Re-registering the same prefix replaces it, so a test can change what a
   * command answers without the old entry still being in the table.
   */
  reply(bin: string, prefix: string, res: Omit<Reply, "prefix"> = {}): void {
    const list = (this.replies[bin] ??= []);
    const at = list.findIndex((r) => r.prefix === prefix);
    const entry = { prefix, ...res };
    if (at === -1) list.push(entry);
    else list[at] = entry;
    fs.writeFileSync(this.repliesPath, JSON.stringify(this.replies));
  }

  /** Every call made since the last reset, in order. */
  calls(): FakeCall[] {
    return fs
      .readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FakeCall);
  }

  /** The argv of every call to one binary, in order. */
  argvFor(bin: string): string[][] {
    return this.calls()
      .filter((c) => c.bin === bin)
      .map((c) => c.argv);
  }

  /** The argv of calls to one binary whose first argument is `sub`. */
  subcommand(bin: string, sub: string): string[][] {
    return this.argvFor(bin).filter((argv) => argv[0] === sub);
  }

  /** Forget recorded calls; registered replies stay. */
  reset(): void {
    fs.writeFileSync(this.logPath, "");
  }

  /** Restore PATH and remove the scripts. */
  uninstall(): void {
    process.env.PATH = this.realPath;
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * One live session as `tmux ls` prints it for the format the store asks for:
 * name, last activity, pane pid. A fake reply keyed on "ls" answers both of the
 * store's formats, and the name-only form is read as a session with no
 * activity — which the sweep would take as a session tmux could not describe.
 *
 * The pane pid is 1, which always exists and always has children, so a session
 * built from this reads as one whose agent is still running.
 */
export const tmuxLsRows = (...names: string[]): string =>
  names.map((n) => `${n}\t${Math.floor(Date.now() / 1000)}\t1`).join("\n") + "\n";
