import { Worker } from "node:worker_threads";
import type { ReplaceResult } from "../../shared/api.js";

/** The pattern was still running when the budget ran out. */
export class ReplaceTimeout extends Error {
  constructor() {
    super("replace timed out");
  }
}

/**
 * The repo-wide replace builds a RegExp from client input and runs it over whole
 * files. On the main thread a catastrophically backtracking pattern ("(a+)+$"
 * against a long line of a's) pins the single backend thread for as long as it
 * takes — every terminal websocket, poll and health check with it. rg found the
 * matching files linearly, but the rewrite is a JS regex, so it cannot be handed
 * back to rg to evaluate; running it in a worker is what makes it interruptible.
 *
 * The worker source is inline rather than a sibling module because dev runs
 * TypeScript through tsx's ESM loader, which a spawned worker does not inherit.
 */
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { paths, source, flags, replacement, literal } = workerData;
const re = new RegExp(source, flags);
let files = 0;
let replacements = 0;
for (const abs of paths) {
  let before;
  try {
    before = fs.readFileSync(abs, "utf8");
  } catch {
    continue; // deleted under us by the agent
  }
  let n = 0;
  let after;
  if (literal) {
    // Function replacement keeps "$&" etc. literal in the replacement text.
    after = before.replace(re, () => { n++; return replacement; });
  } else {
    // String replacement so "$1" backreferences work.
    n = (before.match(re) ?? []).length;
    after = before.replace(re, replacement);
  }
  if (n > 0) {
    fs.writeFileSync(abs, after);
    files++;
    replacements += n;
  }
}
parentPort.postMessage({ files, replacements });
`;

export function runReplace(
  data: {
    paths: string[];
    source: string;
    flags: string;
    replacement: string;
    literal: boolean;
  },
  timeoutMs = 10_000,
): Promise<ReplaceResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, { eval: true, workerData: data });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ReplaceTimeout()));
      void worker.terminate();
    }, timeoutMs);

    worker.on("message", (result: ReplaceResult) => finish(() => resolve(result)));
    worker.on("error", (err: Error) => finish(() => reject(err)));
    worker.on("exit", (code) =>
      finish(() => reject(new Error(`replace worker exited with ${code}`))),
    );
  });
}
