import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * The scheme half of the origin check, which only applies when the deployment
 * says it is served over https. Its own file because env.ts is read once per
 * module graph, and origin.test.ts runs with no PUBLIC_URL at all.
 */
let app: FastifyInstance;

beforeAll(async () => {
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SETTINGS_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vk-settings-")),
    "settings.json",
  );
  process.env.STATIC_DIR = "";
  process.env.PUBLIC_URL = "https://vk.example";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

const post = (host: string, origin: string) =>
  app.inject({ method: "POST", url: "/api/projects", payload: {}, headers: { host, origin } });

describe("an https deployment's own name", () => {
  it("takes a page served over https", async () => {
    expect((await post("vk.example", "https://vk.example")).statusCode).not.toBe(403);
  });

  it("refuses a page on the same name served over plain http", async () => {
    // Somebody on the network serving the app's name, not the app.
    expect((await post("vk.example", "http://vk.example")).statusCode).toBe(403);
  });

  it("still takes an address reached directly, which is http inside the pod", async () => {
    expect((await post("10.0.0.5:8080", "http://10.0.0.5:8080")).statusCode).not.toBe(403);
  });
});
