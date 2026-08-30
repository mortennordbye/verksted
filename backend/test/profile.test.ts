import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * The profile: one file, a page over it, and the one line the assistant may
 * add. What is pinned is the budget, that an appended line lands at the
 * bottom as a bullet, and that the whole thing is readable back as written.
 */
let app: FastifyInstance;
let memoryDir: string;

beforeAll(async () => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-profile-"));
  process.env.MEMORY_DIR = memoryDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

describe("the profile", () => {
  it("starts empty, with its budget stated", async () => {
    const res = await app.inject({ url: "/api/profile" });
    expect(res.json()).toEqual({ text: "", used: 0, budget: 8192 });
  });

  it("is written whole and read back as written", async () => {
    const text = "# Morten\n\nLives in Oslo. Kari is his partner.\n";
    const res = await app.inject({ method: "PUT", url: "/api/profile", payload: { text } });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe(text);
    expect(fs.readFileSync(path.join(memoryDir, "profile.md"), "utf8")).toBe(text);
  });

  it("takes a line from the assistant and puts it at the bottom", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/profile/lines",
      payload: { text: "Never push before 08:00.\nExcept for a red build." },
    });
    expect(res.statusCode).toBe(200);
    const { text } = (await app.inject({ url: "/api/profile" })).json();
    expect(text).toBe(
      "# Morten\n\nLives in Oslo. Kari is his partner.\n- Never push before 08:00. Except for a red build.\n",
    );
  });

  it("refuses to grow past its budget, since every byte is re-sent every turn", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { text: "x".repeat(8193) },
    });
    expect(res.statusCode).toBe(400);
    // Multi-byte text is measured in bytes, not characters.
    const wide = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { text: "ø".repeat(5000) },
    });
    expect(wide.statusCode).toBe(400);
    expect(wide.json().error).toMatch(/8192 bytes/);
  });
});
