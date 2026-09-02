import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * The documents: a share, its text, the catalogue, and the one property that
 * matters most, that nothing outside the share can be reached through it.
 *
 * Plain files stand in for the share; pdftotext is not on the test image, and
 * a PDF is asserted to be skipped rather than to fail. The catalogue turn is
 * driven against a fake claude like the other unattended turns.
 */
let fake: FakeBin;
let app: FastifyInstance;
let share: string;
let index: string;
let docs: typeof import("../src/docs.js");
let loops: typeof import("../src/loops-store.js");
let paths: typeof import("../src/paths.js");
let scheduler: typeof import("../src/scheduler.js");

const log = { info: () => {}, warn: () => {} };

function run(text: string): string {
  return (
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n") + "\n"
  );
}

beforeAll(async () => {
  fake = FakeBin.install(["claude"]);
  share = fs.mkdtempSync(path.join(os.tmpdir(), "vk-docs-"));
  index = fs.mkdtempSync(path.join(os.tmpdir(), "vk-docs-index-"));
  process.env.DOCS_DIR = share;
  process.env.DOCS_INDEX_DIR = index;
  process.env.LOOPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-loops-"));
  process.env.FEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-feed-"));
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-asst-"));
  process.env.COUNCIL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-council-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.SETTINGS_FILE = path.join(index, "settings.json");
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  docs = await import("../src/docs.js");
  loops = await import("../src/loops-store.js");
  paths = await import("../src/paths.js");
  scheduler = await import("../src/scheduler.js");

  fs.mkdirSync(path.join(share, "bil"), { recursive: true });
  fs.writeFileSync(
    path.join(share, "bil", "forsikring-2025.txt"),
    "Forsikringsbevis\nBil: EL12345\nPolisen fornyes 2026-09-03. Oppsigelsesfrist 14 dager.\nPremie: 8 400 kr\n",
  );
  fs.writeFileSync(path.join(share, "notes.md"), "# Hytta\n\nKari vil male stua i mai.\n");
  fs.writeFileSync(path.join(share, "scan.pdf"), "%PDF-1.4 not really");
  fs.writeFileSync(path.join(share, "photo.jpg"), "not a picture");
  fs.writeFileSync(path.join(os.tmpdir(), "vk-outside-secret.txt"), "the secret");
  fs.symlinkSync(path.join(os.tmpdir(), "vk-outside-secret.txt"), path.join(share, "link.txt"));
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

beforeEach(() => {
  fake.reset();
});

describe("the share", () => {
  it("is listed with what each thing is, and nothing hidden", async () => {
    const root = await docs.list();
    expect(root.map((e) => [e.path, e.kind])).toEqual([
      ["bil", "dir"],
      ["link.txt", "plain"],
      ["notes.md", "plain"],
      ["photo.jpg", "image"],
      ["scan.pdf", "pdf"],
    ]);
    expect((await docs.list("bil")).map((e) => e.path)).toEqual(["bil/forsikring-2025.txt"]);
  });

  it("reaches nothing outside it, by dots or by symlink", async () => {
    expect(() => paths.resolveInside(share, "../vk-outside-secret.txt")).toThrow(/denied/);
    expect(() => paths.resolveInside(share, "link.txt")).toThrow(/denied/);
    expect(
      (await app.inject({ url: "/api/docs/read?path=../vk-outside-secret.txt" })).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/api/docs/read?path=link.txt" })).statusCode).toBe(404);
  });

  it("serves a document's own bytes, with a range when one is asked for", async () => {
    const whole = await app.inject({ url: "/api/docs/raw?path=notes.md" });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(whole.headers["content-disposition"]).toContain("inline");
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.body).toBe("# Hytta\n\nKari vil male stua i mai.\n");

    // What a <video> asks for, and what Safari refuses to play without.
    const part = await app.inject({
      url: "/api/docs/raw?path=notes.md",
      headers: { range: "bytes=2-6" },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 2-6/${whole.body.length}`);
    expect(part.body).toBe("Hytta");
  });

  it("hands over what it will not render, and reaches nothing outside the share", async () => {
    // Markup from the share must never run on this app's own origin: it has
    // no auth, so a document served inline would have the whole API.
    fs.writeFileSync(path.join(share, "page.html"), "<script>alert(1)</script>");
    const html = await app.inject({ url: "/api/docs/raw?path=page.html" });
    expect(html.headers["content-type"]).toBe("application/octet-stream");
    expect(html.headers["content-disposition"]).toContain("attachment");
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    fs.rmSync(path.join(share, "page.html"));

    expect(
      (await app.inject({ url: "/api/docs/raw?path=../vk-outside-secret.txt" })).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/api/docs/raw?path=link.txt" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/docs/raw?path=bil" })).statusCode).toBe(404);
  });

  it("extracts what it can, skips what it cannot, and searches the result", async () => {
    const { extracted, skipped } = await docs.sweep();
    expect(extracted).toBe(2);
    // The PDF: no pdftotext on the test image, so it is skipped, not failed.
    expect(skipped).toBe(1);
    expect(fs.existsSync(path.join(index, "text", "bil", "forsikring-2025.txt.txt"))).toBe(true);
    // Nothing changed: a second sweep costs stats and no extraction.
    expect((await docs.sweep()).extracted).toBe(0);

    const hits = await docs.search("fornyes oppsigelsesfrist");
    expect(hits).toEqual([
      {
        path: "bil/forsikring-2025.txt",
        excerpt: "Polisen fornyes 2026-09-03. Oppsigelsesfrist 14 dager.",
      },
    ]);
    expect(await docs.search("nothing like this")).toEqual([]);

    const read = (await app.inject({ url: "/api/docs/read?path=bil/forsikring-2025.txt" })).json();
    expect(read.text).toContain("Premie: 8 400 kr");
  });
});

describe("the catalogue", () => {
  it("describes a few documents a night, files the lines, and opens loops for dates ahead", async () => {
    const now = Date.parse("2026-08-30T02:30:00.000Z");
    fake.reply("claude", "-p", {
      stdout: run(
        [
          "bil/forsikring-2025.txt\tCar insurance policy for EL12345, with If; premium 8 400 kr\t2026-09-03 renewal; 2026-08-20 notice period starts; 2020-01-01 long ago",
          "notes.md\tNotes about the cabin: Kari wants the living room painted in May\t-",
        ].join("\n"),
      ),
    });

    expect(await scheduler.runCatalogue(log, now)).toBe(2);

    const argv = fake.argvFor("claude")[0];
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("bil/forsikring-2025.txt\nForsikringsbevis Bil: EL12345");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("cataloguing documents");

    const md = fs.readFileSync(path.join(index, "catalogue.md"), "utf8");
    expect(md).toContain(
      "- bil/forsikring-2025.txt: Car insurance policy for EL12345, with If; premium 8 400 kr (2026-09-03 renewal;",
    );
    const open = await loops.list();
    expect(open.map((l) => [l.what, l.due, l.from])).toEqual([
      ["renewal: bil/forsikring-2025.txt", "2026-09-03", "doc:bil/forsikring-2025.txt"],
    ]);
    // The catalogue line answers a search before any body is opened.
    expect((await docs.search("insurance EL12345"))[0].path).toBe("bil/forsikring-2025.txt");
    // Nothing left to catalogue: the next night costs nothing.
    expect(await scheduler.runCatalogue(log, now)).toBe(0);
    expect(fake.argvFor("claude")).toHaveLength(1);
  });
});

describe("without a share", () => {
  it("says so rather than failing", async () => {
    const was = process.env.DOCS_DIR;
    const { env } = await import("../src/env.js");
    env.DOCS_DIR = path.join(os.tmpdir(), "vk-no-such-share");
    try {
      expect((await app.inject({ url: "/api/sources" })).json().docs).toBe(false);
      const res = await app.inject({ url: "/api/docs" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/nothing is mounted/);
      expect(await scheduler.runCatalogue(log)).toBe(0);
    } finally {
      env.DOCS_DIR = was!;
    }
  });
});
