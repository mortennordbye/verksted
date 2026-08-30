import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The roster, as files on the volume.
 *
 * What is pinned here is the half that is not CRUD: a member is a JSON file a
 * person can edit from their phone, so the rules about what it may contain are
 * the whole security surface of the council. Everything else about a member is
 * taste.
 */
let dir: string;
let store: typeof import("../src/council-store.js");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-council-"));
  process.env.COUNCIL_DIR = dir;
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  store = await import("../src/council-store.js");
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
});

const member = (over: Record<string, unknown> = {}) => ({
  id: "michael",
  name: "Michael",
  remit: "the cluster",
  tools: ["status", "cluster_status"],
  ...over,
});

describe("what a member file may say", () => {
  it("refuses a tool that does not exist", async () => {
    // The inventory is checked here rather than left to the child process,
    // because a typo should be a message on the settings page.
    await expect(store.saveMember(member({ tools: ["clusterstatus"] }))).rejects.toThrow(
      /no such tool/,
    );
  });

  it("refuses a tool that is the chair's alone", async () => {
    // The line that keeps "the assistant delegates, it does not execute" true
    // of the whole council: an advisor cannot be given a way to change anything
    // outside its own head.
    for (const tool of ["start_session", "merge_pr", "end_session", "notify", "run_schedule"]) {
      await expect(store.saveMember(member({ tools: [tool] }))).rejects.toThrow(/chair's alone/);
    }
  });

  it("lets an advisor keep its own notes", async () => {
    // remember and forget are the exception, and it is blast radius rather than
    // trust: the server routes a member's to its own store, which nothing
    // outside that member's next turn ever reads.
    const saved = await store.saveMember(member({ tools: ["remember", "forget"] }));

    expect(saved.tools).toEqual(["remember", "forget"]);
  });

  it("refuses an id that could name a file outside the directory", async () => {
    for (const id of ["../escape", "Michael", "a/b", ""]) {
      await expect(store.saveMember(member({ id }))).rejects.toThrow(/bad member id/);
    }
  });

  it("refuses to keep the chair here", async () => {
    await expect(store.saveMember(member({ id: store.CHAIR_ID }))).rejects.toThrow(/not kept here/);
    await expect(store.deleteMember(store.CHAIR_ID)).rejects.toThrow(/cannot be removed/);
  });

  it("needs a name and a remit", async () => {
    await expect(store.saveMember(member({ name: "  " }))).rejects.toThrow(/needs a name/);
    await expect(store.saveMember(member({ remit: "" }))).rejects.toThrow(/needs a remit/);
  });

  it("keeps a voice the pod cannot speak, so a lost model is not a lost roster", async () => {
    // The name is checked at the route, where a request can be refused. Here it
    // is also the read path, and a member whose voice went away with the model
    // has to keep reading as a member.
    const saved = await store.saveMember(member({ voice: "nobody_at_all" }));

    expect(saved.voice).toBe("nobody_at_all");
    expect((await store.listMembers()).map((m) => m.voice)).toEqual(["nobody_at_all"]);
  });

  it("caps the persona, because it is carried with every turn", async () => {
    const saved = await store.saveMember(member({ persona: "x".repeat(9_000) }));

    expect(saved.persona.length).toBe(store.MAX_PERSONA);
  });
});

describe("the roster", () => {
  it("puts the chair first, and it is not a file", async () => {
    await store.saveMember(member());
    const roster = await store.listCouncil();

    expect(roster[0].chair).toBe(true);
    expect(roster[0].id).toBe(store.CHAIR_ID);
    expect(fs.existsSync(path.join(dir, `${store.CHAIR_ID}.json`))).toBe(false);
    expect(roster.slice(1).map((m) => m.id)).toEqual(["michael"]);
  });

  it("gives the chair every tool and an advisor only its own", async () => {
    await store.saveMember(member());
    const [chair, advisor] = await store.listCouncil();

    // Every tool but the ones that are a member's alone: the chair never
    // reads a stranger's mail.
    expect(chair.tools).toEqual(
      store.TOOL_INVENTORY.filter((t) => !t.memberOnly).map((t) => t.name),
    );
    expect(advisor.tools).toEqual(["status", "cluster_status"]);
  });

  it("reads a hand-edited file that broke the rules as a missing member", async () => {
    // The file is editable by hand, so a bad one is a normal Tuesday. Losing
    // one advisor is the right cost; taking the roster down is not.
    fs.writeFileSync(path.join(dir, "broken.json"), JSON.stringify({ name: "X", tools: ["nope"] }));
    fs.writeFileSync(path.join(dir, "torn.json"), "{ not json");

    expect(await store.listMembers()).toEqual([]);
  });

  it("seeds an empty directory once, and never again", async () => {
    await store.seedCouncil();
    const first = (await store.listMembers()).map((m) => m.id);
    expect(first).toEqual(store.SEEDS.map((s) => s.id).sort());

    // A member removed by hand stays removed: a seed that kept coming back
    // would be a member you cannot get rid of.
    await store.deleteMember("uriel");
    await store.seedCouncil();

    expect((await store.listMembers()).map((m) => m.id)).not.toContain("uriel");
  });

  it("adds a seed that arrived later, once, and lets it be removed for good", async () => {
    // The council directory of a bench seeded before Sophia existed: the
    // original three and no marker.
    for (const f of fs.readdirSync(process.env.COUNCIL_DIR!)) {
      fs.rmSync(path.join(process.env.COUNCIL_DIR!, f));
    }
    for (const seed of store.SEEDS.filter((s) => ["michael", "raphael", "uriel"].includes(s.id))) {
      await store.saveMember(seed);
    }
    await store.seedCouncil();
    expect((await store.listMembers()).map((m) => m.id)).toContain("sophia");

    await store.deleteMember("sophia");
    await store.seedCouncil();
    expect((await store.listMembers()).map((m) => m.id)).not.toContain("sophia");
  });

  it("refuses the web beside anything private, whoever asks", async () => {
    // A page an advisor fetches is how a prompt injection would carry the
    // private thing out, so the two never sit in one process.
    expect(() =>
      store.validate({ id: "leak", name: "Leak", remit: "x", tools: ["mail_read"], web: true }),
    ).toThrow(/cannot sit beside the web/);
    expect(
      store.validate({ id: "post", name: "Post", remit: "x", tools: ["mail_read"], web: false })
        .tools,
    ).toEqual(["mail_read"]);
  });

  it("never hands the chair the mail", async () => {
    const chair = await store.chair();
    expect(chair.web).toBe(false);
    for (const t of chair.tools) expect(t).not.toMatch(/^mail_/);
    expect(chair.tools).toContain("calendar_today");
  });

  it("seeds nobody who can change anything outside their own head", async () => {
    await store.seedCouncil();
    const chairOnly = new Set(store.TOOL_INVENTORY.filter((t) => t.chairOnly).map((t) => t.name));

    for (const m of await store.listMembers()) {
      expect(m.tools.filter((t) => chairOnly.has(t))).toEqual([]);
    }
  });
});
