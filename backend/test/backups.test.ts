import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * The backup routes against the real `vk`, not a fake one.
 *
 * The script is the whole implementation here — the store only shells out to it
 * — so faking it would leave nothing under test. The repo's copy goes on PATH
 * ahead of the one baked into the image, which is also what keeps this honest
 * when the script changes: a broken `--json` or a broken `--keep` fails here
 * rather than on the settings page.
 */
let app: FastifyInstance;
let backupDir: string;
let dataDir: string;

/** A miniature /data: one repo with a commit, one secret-shaped file. */
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-bk-data-"));
  fs.writeFileSync(path.join(dir, "settings.json"), '{"vars":{}}');
  const repo = path.join(dir, "repos", "demo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  fs.writeFileSync(path.join(repo, "a.txt"), "hello");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "pipe" });
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "-q"],
    { stdio: "pipe" },
  );
  return dir;
}

const silent = { info: () => {}, warn: () => {} };

/**
 * These tests shell out to tar and wait for it. `settle` is willing to wait two
 * minutes, but vitest's own per-test default is five seconds, so on a runner
 * slower than a laptop the test was killed long before the backup it is waiting
 * for could finish — and the three that follow then fell over on the archive it
 * never wrote. Every test that calls `settle` carries this instead.
 */
const SETTLES = 130_000;

async function settle(timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const body = (await app.inject({ method: "GET", url: "/api/backups" })).json();
    if (!body.running) return;
    if (Date.now() > until) throw new Error("backup never finished");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * The same, for a backup nothing asked for directly.
 *
 * `startNightly` decides whether to catch up after an async read of the
 * archive directory, and does not wait for the answer — so a poll that lands
 * before that decision sees nothing running and `settle` returns at once. The
 * assertion then ran against a backup that started moments later, and the next
 * test found it: two archives where it expected none. Rare on a laptop, which
 * is why it reached CI to fail there.
 *
 * A window that passes with nothing started is the answer for the test that
 * expects nothing to start, so this waits rather than throwing.
 */
async function settleBoot(startsWithin = 5_000): Promise<void> {
  const until = Date.now() + startsWithin;
  while (Date.now() < until) {
    if ((await app.inject({ method: "GET", url: "/api/backups" })).json().running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await settle();
}

beforeAll(async () => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-bk-out-"));
  dataDir = fixture();

  // The script under test, not the copy the image was built with.
  const runtime = fileURLToPath(new URL("../../runtime", import.meta.url));
  process.env.PATH = `${runtime}:${process.env.PATH ?? ""}`;
  process.env.VK_DATA_DIR = dataDir;

  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  process.env.VK_BACKUP_DIR = backupDir;
  process.env.VK_BACKUP_KEEP = "2";
  process.env.FEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-feed-"));
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/backups", () => {
  it("reports an empty directory without inventing one", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backups" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dir).toBe(backupDir);
    expect(body.archives).toEqual([]);
    expect(body.keep).toBe(2);
    expect(body.running).toBe(false);
  });

  it("says whether archives are landing on the volume they protect", async () => {
    // The whole reason for the NFS mount: /data/... is the failure this flags.
    const body = (await app.inject({ method: "GET", url: "/api/backups" })).json();
    expect(body.offVolume).toBe(true);
  });

  // lastError and lastFinishedAt are this process's memory, so a redeployed pod
  // reported nothing wrong however long it had been since anything was written.
  it("calls an empty directory stale, whatever this process remembers", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/backups" })).json();
    expect(body.stale).toBe(true);
  });
});

describe("POST /api/backups", () => {
  it(
    "takes a backup the listing can then describe",
    async () => {
      // 202, not 200: the run outlives the request. Whether it is still going by
      // the time the response is built is not something to assert on — a small
      // fixture can finish first, and a real volume never will.
      const res = await app.inject({ method: "POST", url: "/api/backups" });
      expect(res.statusCode).toBe(202);
      await settle();

      const body = (await app.inject({ method: "GET", url: "/api/backups" })).json();
      expect(body.lastError).toBeNull();
      expect(body.archives).toHaveLength(1);
      const [archive] = body.archives;
      expect(archive.name).toMatch(/^verksted-\d{8}-\d{6}\.tar\.gz$/);
      expect(archive.bytes).toBeGreaterThan(0);
      // Read out of the manifest inside the archive, not guessed from the name.
      expect(archive.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(archive.repos).toBe(1);

      // The checksum is written beside it, and it verifies.
      expect(fs.existsSync(path.join(backupDir, `${archive.name}.sha256`))).toBe(true);
      execFileSync("sha256sum", ["-c", "--status", `${archive.name}.sha256`], {
        cwd: backupDir,
        stdio: "pipe",
      });
    },
    SETTLES,
  );

  /**
   * The archive holds every token, OAuth login and private key on the volume,
   * and it lands on a NAS share the household can read. What is pinned here is
   * that the passphrase actually changes that, and that a restore reads it back
   * — an archive nobody can open is worse than one anybody can read, so the
   * round trip is the test, not the encryption.
   */
  it(
    "encrypts under a passphrase, and reads one back with it",
    async () => {
      process.env.VK_BACKUP_PASSPHRASE = "correct horse battery staple";
      try {
        expect((await app.inject({ method: "POST", url: "/api/backups" })).statusCode).toBe(202);
        await settle();
        const body = (await app.inject({ method: "GET", url: "/api/backups" })).json();
        const enc = body.archives.find((a: { encrypted: boolean }) => a.encrypted);
        expect(enc.name).toMatch(/\.tar\.gz\.enc$/);
        // The manifest was read back through the decryption path, so the
        // listing knowing what is inside is itself the round trip.
        expect(enc.repos).toBe(1);

        // The secret is not in the bytes: a plain archive hands it to zcat.
        const raw = fs.readFileSync(path.join(backupDir, enc.name));
        expect(raw.subarray(0, 8).toString()).toBe("Salted__");
        expect(raw.includes(Buffer.from("settings.json"))).toBe(false);

        const target = fs.mkdtempSync(path.join(os.tmpdir(), "vk-bk-restore-"));
        execFileSync("vk", ["restore", path.join(backupDir, enc.name), "--target", target], {
          stdio: "pipe",
        });
        expect(fs.existsSync(path.join(target, "settings.json"))).toBe(true);
        fs.rmSync(target, { recursive: true, force: true });
      } finally {
        delete process.env.VK_BACKUP_PASSPHRASE;
      }
    },
    SETTLES,
  );

  it("refuses to open an encrypted archive without the passphrase", async () => {
    const enc = (await app.inject({ method: "GET", url: "/api/backups" }))
      .json()
      .archives.find((a: { encrypted: boolean }) => a.encrypted);
    // Filed as a fine archive this bench cannot open, not as junk to delete.
    expect(enc.createdAt).toBeNull();
    expect(() =>
      execFileSync("vk", ["restore", path.join(backupDir, enc.name), "--target", "/tmp/nope"], {
        stdio: "pipe",
      }),
    ).toThrow();
    expect(fs.existsSync("/tmp/nope")).toBe(false);
  });

  it("carries the repo's git history, which is where uncommitted work lives", async () => {
    const [archive] = (await app.inject({ method: "GET", url: "/api/backups" })).json().archives;
    const members = execFileSync("tar", ["-tzf", path.join(backupDir, archive.name)], {
      encoding: "utf8",
      maxBuffer: 8 << 20,
    });
    expect(members).toContain("./repos/demo/.git/HEAD");
    expect(members).toContain("./settings.json");
    expect(members).toContain(".verksted-backup/MANIFEST.json");
  });

  it(
    "refuses a second run while one is in flight",
    async () => {
      // Started through the store rather than a first POST: start() flips the
      // flag synchronously, so the 409 is deterministic instead of a race
      // against however long tarring the fixture happens to take.
      const store = await import("../src/backups-store.js");
      expect(store.start(0, silent)).toBe(true);

      const res = await app.inject({ method: "POST", url: "/api/backups" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/already running/);
      await settle();
    },
    SETTLES,
  );

  it(
    "keeps VK_BACKUP_KEEP archives and prunes their checksums with them",
    async () => {
      // Two runs already happened; a third must push the oldest out at keep=2.
      await app.inject({ method: "POST", url: "/api/backups" });
      await settle();

      const body = (await app.inject({ method: "GET", url: "/api/backups" })).json();
      expect(body.archives).toHaveLength(2);
      const sums = fs.readdirSync(backupDir).filter((f) => f.endsWith(".sha256"));
      expect(sums).toHaveLength(2);
    },
    SETTLES,
  );
});

/**
 * R-02 and R-03 from the audit: the nightly run was a 24h interval from boot,
 * so a pod redeployed several times a day never reached it — there was no
 * archive at all for the two busiest days of the month — and a failure was one
 * line in a log nobody reads.
 */
describe("the nightly run", () => {
  it(
    "takes one on boot when the newest archive is older than a day",
    async () => {
      for (const f of fs.readdirSync(backupDir)) fs.rmSync(path.join(backupDir, f));
      const store = await import("../src/backups-store.js");

      const job = store.startNightly(silent);
      await settleBoot();

      expect(fs.readdirSync(backupDir).filter((f) => f.endsWith(".tar.gz"))).toHaveLength(1);
      expect((await store.status()).stale).toBe(false);
      job?.stop();
    },
    SETTLES,
  );

  it(
    "does not take another one when there is a fresh archive",
    async () => {
      const store = await import("../src/backups-store.js");
      const before = fs.readdirSync(backupDir).length;

      const job = store.startNightly(silent);
      await settleBoot();

      expect(fs.readdirSync(backupDir)).toHaveLength(before);
      job?.stop();
    },
    SETTLES,
  );

  it(
    "puts a failure where it will be seen, not only in the log",
    async () => {
      const store = await import("../src/backups-store.js");
      const feed = await import("../src/feed-store.js");
      // A `vk` that fails, ahead of the real one on PATH. exec resolves the
      // name per call, so this is enough to fail exactly one run.
      const broken = fs.mkdtempSync(path.join(os.tmpdir(), "vk-broken-"));
      fs.writeFileSync(path.join(broken, "vk"), "#!/bin/sh\necho 'no space left' >&2\nexit 1\n", {
        mode: 0o755,
      });
      const path0 = process.env.PATH;
      process.env.PATH = `${broken}:${path0}`;

      try {
        expect(store.start(0, silent)).toBe(true);
        await settle();
      } finally {
        process.env.PATH = path0;
      }

      expect((await store.status()).lastError).toMatch(/Command failed/);
      const item = await feed.get("bench:backup");
      expect(item?.title).toBe("backup failed");
      expect(item?.urgency).toBe("attention");
    },
    SETTLES,
  );
});
