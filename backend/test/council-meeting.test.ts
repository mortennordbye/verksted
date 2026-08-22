import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * A meeting, end to end, against a fake `claude` on PATH.
 *
 * The properties worth pinning are the ones a person would notice going wrong:
 * that a plain question still costs one call and convenes nobody, that the
 * advisors the chair asked for actually answer and are attributed, that one of
 * them failing does not take the meeting with it, and that an advisor is
 * spawned with its own model, its own tools and nobody else's persona.
 *
 * There is one property here that no amount of reading the code would catch:
 * with several writers appending to one transcript, "did this turn say
 * anything" cannot be answered by the file having grown.
 */
let fake: FakeBin;
let assistantDir: string;
let councilDir: string;
let app: FastifyInstance;

/** A stream-json run that says `text`. */
function run(text: string): string {
  return (
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n") + "\n"
  );
}

/** Reply to the call carrying one advisor's persona, whoever else is running. */
function whenAsked(name: string, text: string) {
  fake.reply("claude", "-p", { contains: `Your name is ${name}.`, stdout: run(text) });
}

beforeAll(async () => {
  fake = FakeBin.install(["claude"]);
  assistantDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-council-thread-"));
  councilDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-council-dir-"));
  process.env.ASSISTANT_DIR = assistantDir;
  process.env.COUNCIL_DIR = councilDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.SETTINGS_FILE = path.join(councilDir, "settings.json");
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  const { seedCouncil } = await import("../src/council-store.js");
  await seedCouncil();
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
  for (const d of [assistantDir, councilDir]) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(assistantDir)) {
    fs.rmSync(path.join(assistantDir, f), { recursive: true, force: true });
  }
  fake.reset();
});

const say = (text: string, roundTable = false) =>
  app.inject({
    method: "POST",
    url: "/api/assistant/messages",
    payload: { text, ...(roundTable ? { roundTable: true } : {}) },
  });

interface Entry {
  role: string;
  text: string;
  member?: string;
  tools: { name: string; detail: string }[];
}

const entries = (res: { json: () => { entries: Entry[] } }) => res.json().entries;

/** Every call that carried this advisor's persona. */
const callsFor = (name: string) =>
  fake.argvFor("claude").filter((argv) => argv.join(" ").includes(`Your name is ${name}.`));

describe("a question the chair keeps", () => {
  it("convenes nobody and costs one call", async () => {
    fake.reply("claude", "-p", { stdout: run("Two things need you.") });

    const got = entries(await say("what needs me today?"));

    expect(got.map((e) => [e.role, e.text])).toEqual([
      ["user", "what needs me today?"],
      ["assistant", "Two things need you."],
    ]);
    expect(fake.argvFor("claude")).toHaveLength(1);
  });

  it("keeps a reply that looks like a convene line but names nobody real", async () => {
    // Swallowing it would leave the turn silent, which is worse than an odd
    // answer landing as written.
    fake.reply("claude", "-p", { stdout: run("convene: nobody-at-all") });

    const got = entries(await say("hello"));

    expect(got[1].text).toBe("convene: nobody-at-all");
  });
});

describe("a meeting", () => {
  beforeEach(() => {
    fake.reply("claude", "-p", { stdout: run("convene: michael, raphael") });
    whenAsked("Michael", "The cluster is green.");
    whenAsked("Raphael", "Four bumps, all passing.");
  });

  it("asks the advisors the chair named, and attributes what each said", async () => {
    // The chair's closing turn is the one that is neither Michael nor Raphael,
    // and it is asked with what they said.
    fake.reply("claude", "-p The council answered.", { stdout: run("Merge it.") });

    const got = entries(await say("is the homelab pr safe to merge?"));

    // The question, then the mark saying who was asked, then the summary. The
    // convene line itself is machinery and is kept out of the conversation.
    expect([got[0], got[1], got.at(-1)].map((e) => [e!.member ?? "chair", e!.text])).toEqual([
      ["chair", "is the homelab pr safe to merge?"],
      ["chair", ""],
      ["chair", "Merge it."],
    ]);
    expect(got[1].tools).toEqual([{ name: "convene", detail: "Michael, Raphael" }]);
    // The advisors in between, as a set: they answer in parallel and land as
    // they finish, so asserting an order would be asserting a race.
    expect(
      got
        .filter((e) => e.member)
        .map((e) => [e.member, e.text])
        .sort(),
    ).toEqual([
      ["michael", "The cluster is green."],
      ["raphael", "Four bumps, all passing."],
    ]);
  });

  it("hands the chair what the advisors actually said", async () => {
    fake.reply("claude", "-p The council answered.", { stdout: run("Merge it.") });
    await say("is the homelab pr safe to merge?");

    const closing = fake.argvFor("claude").find((argv) => argv[1].startsWith("The council"));
    expect(closing?.[1]).toContain("Michael: The cluster is green.");
    expect(closing?.[1]).toContain("Raphael: Four bumps, all passing.");
    // It must not go round again; that is what would make a meeting recursive.
    expect(closing?.[1]).toContain("Do not convene");
  });

  it("closes even when an advisor fails", async () => {
    // One process dying must cost that one answer, not the meeting: the others
    // have already been paid for.
    fake.reply("claude", "-p", { contains: "Your name is Michael.", code: 1, stderr: "boom" });
    fake.reply("claude", "-p The council answered.", { stdout: run("Raphael says it is fine.") });

    const got = entries(await say("is the homelab pr safe to merge?"));

    const michael = got.find((e) => e.member === "michael");
    expect(michael?.text).toContain("boom");
    expect(got.at(-1)?.text).toBe("Raphael says it is fine.");
  });

  it("does not let one advisor's answer make another think it spoke", async () => {
    // Several writers share one transcript now, so a turn that produced nothing
    // cannot be detected by the file having grown — the other advisor's answer
    // grew it. Michael says nothing at all; only he should be marked failed.
    fake.reply("claude", "-p", { contains: "Your name is Michael.", stdout: "" });
    fake.reply("claude", "-p The council answered.", { stdout: run("Only Raphael answered.") });

    const got = entries(await say("anything?"));

    expect(got.find((e) => e.member === "michael")?.text).toBeTruthy();
    expect(got.find((e) => e.member === "raphael")?.text).toBe("Four bumps, all passing.");
  });

  it("gives each advisor its own model, tools and persona, and nobody else's", async () => {
    fake.reply("claude", "-p The council answered.", { stdout: run("Merge it.") });
    await say("is the homelab pr safe to merge?");

    const [argv] = callsFor("Michael");
    const prompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(prompt).toContain("the cluster this bench runs in");
    expect(prompt).not.toContain("Raphael");
    // An advisor holds no tool that changes anything, and the MCP server is
    // told so rather than merely not being asked.
    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")) as {
      mcpServers: { verksted: { env: { VK_TOOLS: string } } };
    };
    const offered = config.mcpServers.verksted.env.VK_TOOLS.split(",");
    expect(offered).toContain("cluster_status");
    expect(offered).not.toContain("start_session");
    // And it cannot run a shell, whatever its file says.
    expect(argv[argv.indexOf("--disallowed-tools") + 1]).toContain("Bash");
  });

  it("gives an advisor with no reason to read the web no way to", async () => {
    fake.reply("claude", "-p The council answered.", { stdout: run("Merge it.") });
    await say("is the homelab pr safe to merge?");

    const [argv] = callsFor("Michael");
    expect(argv[argv.indexOf("--disallowed-tools") + 1]).toContain("WebFetch");
    expect(argv[argv.indexOf("--tools") + 1]).not.toContain("WebFetch");
  });

  it("gives each advisor its own conversation, and resumes it next time", async () => {
    fake.reply("claude", "-p The council answered.", { stdout: run("Merge it.") });
    await say("first question");
    const [first] = callsFor("Michael");
    const conversationId = first[first.indexOf("--session-id") + 1];

    fake.reset();
    fake.reply("claude", "-p", { stdout: run("convene: michael") });
    whenAsked("Michael", "Still green.");
    fake.reply("claude", "-p The council answered.", { stdout: run("Fine.") });
    await say("second question");

    const [second] = callsFor("Michael");
    // Its own thread, not the chair's, and picked up rather than restarted.
    expect(second[second.indexOf("--resume") + 1]).toBe(conversationId);
    expect(second).not.toContain("--session-id");
  });

  it("caps how many can be convened, whatever the chair asks for", async () => {
    // A ceiling a model is merely asked to respect is not a ceiling: this is
    // what stands between one question and an unbounded number of calls.
    fake.reply("claude", "-p", { stdout: run("convene: michael, raphael, uriel, michael") });
    whenAsked("Uriel", "Nothing on your calendar.");
    fake.reply("claude", "-p The council answered.", { stdout: run("Fine.") });

    const got = entries(await say("everything?"));

    expect(got.filter((e) => e.member).length).toBeLessThanOrEqual(3);
  });
});

describe("a round table", () => {
  /** The prompt the call carrying this advisor's persona was given. */
  const promptFor = (name: string) => callsFor(name).map((argv) => argv[1]);

  beforeEach(() => {
    whenAsked("Michael", "The cluster is green.");
    whenAsked("Raphael", "Four bumps, all passing.");
    fake.reply("claude", "-p The council talked it over", { stdout: run("Merge it.") });
  });

  it("shows each advisor what the ones before it said", async () => {
    fake.reply("claude", "-p", { stdout: run("discuss: michael, raphael") });

    const got = entries(await say("is the homelab pr safe to merge?"));

    // The first one is asked the plain question; the second is asked it with
    // the first one's answer, which is the whole of what a round table is.
    expect(promptFor("Michael")[0]).toBe("is the homelab pr safe to merge?");
    expect(promptFor("Raphael")[0]).toContain("Michael: The cluster is green.");
    expect(promptFor("Raphael")[0]).toContain("where you disagree");
    // And the chair is told they heard each other, so it can settle a fight.
    const closing = fake.argvFor("claude").find((argv) => argv[1].startsWith("The council talked"));
    expect(closing?.[1]).toContain("Raphael: Four bumps, all passing.");
    expect(got[1].tools).toEqual([{ name: "discuss", detail: "Michael, Raphael" }]);
  });

  it("keeps them in the order the chair named them", async () => {
    // Sequential, so unlike a convening this order is a property rather than a
    // race: the transcript is what somebody reads back afterwards.
    fake.reply("claude", "-p", { stdout: run("discuss: raphael, michael") });

    const got = entries(await say("is the homelab pr safe to merge?"));

    expect(got.filter((e) => e.member).map((e) => e.member)).toEqual(["raphael", "michael"]);
  });

  it("turns a convening into one when the switch is on", async () => {
    fake.reply("claude", "-p", { stdout: run("convene: michael, raphael") });

    const got = entries(await say("is the homelab pr safe to merge?", true));

    expect(got[1].tools).toEqual([{ name: "discuss", detail: "Michael, Raphael" }]);
    expect(promptFor("Raphael")[0]).toContain("Michael: The cluster is green.");
    // The chair is told the switch is on, rather than being made to guess.
    expect(fake.argvFor("claude")[0][1]).toContain("round table switch is on");
  });

  it("is a plain answer when only one advisor is named", async () => {
    // A round table of one is a convening with a longer prompt, and a chip that
    // said "round table: Michael" would be describing something that did not
    // happen.
    fake.reply("claude", "-p", { stdout: run("discuss: michael") });
    fake.reply("claude", "-p The council answered.", { stdout: run("Fine.") });

    const got = entries(await say("what is degraded?"));

    expect(got[1].tools).toEqual([{ name: "convene", detail: "Michael" }]);
    expect(promptFor("Michael")[0]).toBe("what is degraded?");
  });
});

describe("adding somebody", () => {
  const add = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/council", payload: body });

  const roster = async (): Promise<{ id: string; name: string; face: string }[]> =>
    (await app.inject({ url: "/api/council" })).json();

  const ledger = {
    name: "Ledger",
    remit: "what this bench costs to run",
    persona: "You watch the money.",
    tools: ["status"],
    face: "bear",
  };

  // The council directory outlives a test here, unlike the transcript, so
  // whoever was added is taken back off before the next one runs.
  afterEach(async () => {
    for (const m of await roster()) {
      if (!["chair", "michael", "raphael", "uriel"].includes(m.id)) {
        await app.inject({ method: "DELETE", url: `/api/council/${m.id}` });
      }
    }
  });

  it("puts a new advisor on the roster", async () => {
    const res = await add({ ...ledger, id: "ledger" });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "ledger", face: "bear", enabled: true });
    expect((await roster()).map((m) => m.id)).toContain("ledger");
  });

  it("refuses an id somebody already has, rather than replacing them", async () => {
    // The chair working from a half-remembered name must not quietly take an
    // advisor's place, along with everything that advisor was given.
    const res = await add({ ...ledger, id: "michael", name: "Not Michael" });

    expect(res.statusCode).toBe(409);
    expect((await roster()).find((m) => m.id === "michael")?.name).toBe("Michael");
  });

  it("refuses the chair's own tools, whoever is asking", async () => {
    const res = await add({ ...ledger, id: "spender", tools: ["status", "start_session"] });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/chair's alone/);
  });

  it("gives one that chose no face a face of its own", async () => {
    const res = await add({ ...ledger, id: "warden", face: undefined });

    expect(res.statusCode).toBe(201);
    expect(res.json().face).toBeTruthy();
  });
});

describe("one turn at a time", () => {
  it("refuses a second question while a meeting is still going", async () => {
    // The registry cannot answer this on its own: between the chair's turn and
    // the advisors starting, nothing is spawned and everything is in flight.
    fake.reply("claude", "-p", { stdout: run("convene: michael") });
    fake.reply("claude", "-p", {
      contains: "Your name is Michael.",
      stdout: run("Green."),
      delayMs: 250,
    });
    fake.reply("claude", "-p The council answered.", { stdout: run("Fine.") });

    const [a, b] = await Promise.all([say("first"), say("second")]);
    const codes = [a.statusCode, b.statusCode].sort();

    expect(codes).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)?.json().error).toMatch(/still running/);
  });
});

describe("stopping", () => {
  it("kills the advisors and does not pay for the chair's closing turn", async () => {
    // Stop mid-meeting means stop the meeting. The processes that exist are
    // signalled, but the closing turn has not been spawned yet, and that is the
    // part that is still avoidable.
    fake.reply("claude", "-p", { stdout: run("convene: michael, raphael") });
    for (const name of ["Michael", "Raphael"]) {
      fake.reply("claude", "-p", {
        contains: `Your name is ${name}.`,
        stdout: run("too late"),
        delayMs: 3_000,
      });
    }
    fake.reply("claude", "-p The council answered.", { stdout: run("Should never run.") });

    const turn = say("is the homelab pr safe to merge?");
    // Wait for the advisors to actually be out before pressing stop.
    for (let i = 0; i < 200; i++) {
      const thread: { speaking?: string[] } = (await app.inject({ url: "/api/assistant" })).json();
      if (thread.speaking?.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const stopped = await app.inject({ method: "POST", url: "/api/assistant/stop" });
    const got = entries(await turn);

    expect(stopped.json()).toEqual({ stopped: true });
    expect(fake.argvFor("claude").some((argv) => argv[1].startsWith("The council"))).toBe(false);
    expect(got.at(-1)?.text).not.toBe("Should never run.");
    // And nothing is left marked as speaking afterwards.
    expect((await app.inject({ url: "/api/assistant" })).json().speaking).toBeUndefined();
  });
});

describe("addressing one advisor directly", () => {
  it("goes straight to them, with no chair turn at all", async () => {
    whenAsked("Michael", "Everything is green.");

    const got = entries(await say("@michael what is degraded?"));

    expect(got.map((e) => [e.member ?? "chair", e.text])).toEqual([
      ["chair", "@michael what is degraded?"],
      ["michael", "Everything is green."],
    ]);
    expect(fake.argvFor("claude")).toHaveLength(1);
    // The @ is addressing, not part of the question.
    expect(callsFor("Michael")[0][1]).toBe("what is degraded?");
  });

  it("lets the chair start its own conversation afterwards", async () => {
    // The trap: the transcript now has entries, but the chair's claude session
    // was never created, so resuming it would fail the turn outright.
    whenAsked("Michael", "Everything is green.");
    await say("@michael what is degraded?");

    fake.reset();
    fake.reply("claude", "-p", { stdout: run("Nothing else.") });
    await say("anything else?");

    const [argv] = fake.argvFor("claude");
    expect(argv).toContain("--session-id");
    expect(argv).not.toContain("--resume");
  });

  it("treats an unknown or disabled name as ordinary text", async () => {
    fake.reply("claude", "-p", { stdout: run("No such person.") });

    const got = entries(await say("@nobody are you there?"));

    expect(got[1].member).toBeUndefined();
    expect(callsFor("Michael")).toHaveLength(0);
  });
});
