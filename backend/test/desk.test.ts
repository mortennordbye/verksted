import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * The desk: a repository under the repos root with no remote, one directory
 * per task, started like any session. A fake tmux stands in for the agent;
 * git is real, since the desk is made with it.
 */
let fake: FakeBin;
let app: FastifyInstance;
let reposDir: string;

beforeAll(async () => {
  fake = FakeBin.install(["tmux"]);
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-desk-repos-"));
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-desk-sess-"));
  process.env.SETTINGS_FILE = path.join(reposDir, "settings.json");
  process.env.DOCS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-desk-docs-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  fake.reply("tmux", "ls", { stdout: "" });
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

describe("a desk session", () => {
  it("opens the desk once, gives the task a directory, and starts there", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/desk/sessions",
      payload: { title: "Compare car insurance", ask: "Three offers are in the mail; table them." },
    });
    expect(res.statusCode).toBe(201);
    const session = res.json();
    expect(session.id).toBe("vk-desk-1");
    expect(session.project).toBe("desk");
    expect(session.title).toBe("Compare car insurance");
    expect(session.task).toMatch(/^\d{4}-\d{2}-\d{2}-compare-car-insurance$/);

    // The desk is a repo with no remote, and the task is inside it.
    const desk = path.join(reposDir, "desk");
    expect(fs.existsSync(path.join(desk, ".git"))).toBe(true);
    const task = fs.readFileSync(path.join(desk, session.task, "TASK.md"), "utf8");
    expect(task).toContain("# Compare car insurance");
    expect(task).toContain("Three offers are in the mail; table them.");

    // The agent starts in the task directory, with the ask and the share in
    // its prompt, in auto permission mode like anything the assistant starts.
    const argv = fake.subcommand("tmux", "new-session")[0];
    expect(argv[argv.indexOf("-c") + 1]).toBe(fs.realpathSync(path.join(desk, session.task)));
    const prompt = Object.fromEntries(
      argv.flatMap((a, i) => (a === "-e" ? [argv[i + 1].split(/=(.*)/s)] : [])),
    ).VK_PROMPT as string;
    expect(prompt).toContain("Task: Compare car insurance");
    expect(prompt).toContain(`documents are at ${process.env.DOCS_DIR}`);
    expect(prompt).toContain("no remote and nothing to push");
  });

  it("gives a second task of the same name a directory of its own", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/desk/sessions",
      payload: { title: "Compare car insurance", ask: "Again, with the fourth offer." },
    });
    expect(res.json().task).toMatch(/-compare-car-insurance-2$/);
    expect(res.json().id).toBe("vk-desk-2");
  });
});
