import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Everything `env.ts` defaults to a path under `/data`, pointed at one
 * throwaway tree.
 *
 * Both suites already redirect the directories they seed. The rest they simply
 * did not think about, and inside the dev container that was invisible: /data
 * is the volume, it exists, and the process is root, so the first thing to ask
 * for `/data/assistant` created it and the test passed. On a CI runner the same
 * line is `EACCES: permission denied, mkdir '/data'` — which is the honest
 * answer, and the reason the suite says where every directory is rather than
 * inheriting one.
 *
 * Returns the root so a caller can remove it afterwards.
 */
export function useTempDataDirs(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Created, not just named: a directory that is missing is not the same thing
  // as one that is empty. The documents share answers 503 when nothing is
  // mounted, and the browser logs that as a failed request — which is what the
  // suite's last assertion is there to catch.
  const dir = (name: string) => {
    const p = path.join(root, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  process.env.ASSISTANT_DIR = dir("assistant");
  process.env.MEMORY_DIR = dir("memory");
  process.env.COUNCIL_DIR = dir("council");
  process.env.LOOPS_DIR = dir("loops");
  process.env.DOCS_DIR = dir("docs");
  process.env.DOCS_INDEX_DIR = dir("docs-index");
  process.env.USAGE_DIR = dir("usage");
  process.env.SSH_DIR = dir("ssh");
  process.env.VK_BACKUP_DIR = dir("backups");
  process.env.SETTINGS_FILE = path.join(root, "settings.json");
  process.env.PUSH_FILE = path.join(root, "push.json");

  return root;
}
