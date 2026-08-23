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

async function settle(timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const body = (await app.inject({ method: "GET", url: "/api/backups" })).json();
    if (!body.running) return;
    if (Date.now() > until) throw new Error("backup never finished");
    await new Promise((r) => setTimeout(r, 200));
  }
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
});

describe("POST /api/backups", () => {
  it("takes a backup the listing can then describe", async () => {
    const res = await app.inject({ method: "POST", url: "/api/backups" });
    expect(res.statusCode).toBe(202);
    expect(res.json().running).toBe(true);
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

  it("refuses a second run while one is in flight", async () => {
    const first = await app.inject({ method: "POST", url: "/api/backups" });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: "POST", url: "/api/backups" });
    expect(second.statusCode).toBe(409);
    await settle();
  });

  it("keeps VK_BACKUP_KEEP archives and prunes their checksums with them", async () => {
    // Two runs already happened; a third must push the oldest out at keep=2.
    await app.inject({ method: "POST", url: "/api/backups" });
    await settle();

    const body = (await app.inject({ method: "GET", url: "/api/backups" })).json();
    expect(body.archives).toHaveLength(2);
    const sums = fs.readdirSync(backupDir).filter((f) => f.endsWith(".sha256"));
    expect(sums).toHaveLength(2);
  });
});
