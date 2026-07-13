import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vk-files-"));
  fs.mkdirSync(path.join(root, "demo", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "demo", "a.txt"), "hello");
  fs.writeFileSync(path.join(root, "demo", "sub", "b.txt"), "world");
  fs.writeFileSync(path.join(root, "demo", "bin.dat"), Buffer.from([1, 2, 0, 3]));
  fs.mkdirSync(path.join(root, "other"));
  fs.writeFileSync(path.join(root, "other", "secret.txt"), "s");

  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  process.env.REPOS_DIR = root;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/projects/:name/tree", () => {
  it("returns the tree for a real project", async () => {
    const res = await app.inject({ url: "/api/projects/demo/tree" });
    expect(res.statusCode).toBe(200);
    const names = res.json().map((n: { name: string }) => n.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("sub");
  });

  it("404s an unknown project", async () => {
    const res = await app.inject({ url: "/api/projects/ghost/tree" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects traversal in the project name", async () => {
    const res = await app.inject({ url: "/api/projects/..%2Fother/tree" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /api/projects/:name/file", () => {
  it("reads a file inside the project", async () => {
    const res = await app.inject({ url: "/api/projects/demo/file?path=a.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: "a.txt", content: "hello" });
  });

  it("denies .. traversal", async () => {
    const res = await app.inject({
      url: `/api/projects/demo/file?path=${encodeURIComponent("../other/secret.txt")}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("secret");
  });

  it("denies absolute paths", async () => {
    const res = await app.inject({
      url: `/api/projects/demo/file?path=${encodeURIComponent("/etc/passwd")}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies directories", async () => {
    const res = await app.inject({ url: "/api/projects/demo/file?path=sub" });
    expect(res.statusCode).toBe(403);
  });

  it("rejects binary files", async () => {
    const res = await app.inject({ url: "/api/projects/demo/file?path=bin.dat" });
    expect(res.statusCode).toBe(415);
  });
});
