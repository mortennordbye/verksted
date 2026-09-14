import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gmail's labels and filters, short of a live account.
 *
 * Same property as mail-move.test.ts: what a model gives a rule never reaches
 * the API unchecked, and a label is created once, not once per rule that
 * names it. The fake below answers the token endpoint and the three Gmail
 * endpoints gmail.ts calls.
 */
const requests: { method: string; url: string; body?: Record<string, unknown> }[] = [];

let userLabels: { id: string; name: string; type: string }[] = [];
let filters: {
  id: string;
  criteria?: Record<string, string>;
  action?: Record<string, string[]>;
}[] = [];

function fakeFetch(url: string, init: { method?: string; body?: string } = {}) {
  const method = init.method ?? "GET";

  if (url.includes("oauth2.googleapis.com/token")) {
    requests.push({ method, url });
    return Promise.resolve(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }));
  }

  const body = init.body ? JSON.parse(init.body) : undefined;
  requests.push({ method, url, body });
  if (url.endsWith("/labels") && method === "GET") {
    return Promise.resolve(new Response(JSON.stringify({ labels: userLabels }), { status: 200 }));
  }
  if (url.endsWith("/labels") && method === "POST") {
    const label = { id: `L${userLabels.length + 1}`, name: body.name as string, type: "user" };
    userLabels = [...userLabels, label];
    return Promise.resolve(new Response(JSON.stringify(label), { status: 200 }));
  }
  if (url.endsWith("/settings/filters") && method === "GET") {
    return Promise.resolve(new Response(JSON.stringify({ filter: filters }), { status: 200 }));
  }
  if (url.endsWith("/settings/filters") && method === "POST") {
    const created = { id: `F${filters.length + 1}`, criteria: body.criteria, action: body.action };
    filters = [...filters, created];
    return Promise.resolve(new Response(JSON.stringify(created), { status: 200 }));
  }
  if (/\/settings\/filters\/F\d+$/.test(url) && method === "DELETE") {
    filters = filters.filter((f) => !url.endsWith(f.id));
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  return Promise.resolve(
    new Response(JSON.stringify({ error: { message: "unexpected request" } }), { status: 500 }),
  );
}

let gmail: typeof import("../src/gmail.js");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-gmail-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  fs.writeFileSync(
    process.env.SETTINGS_FILE,
    JSON.stringify({
      vars: {
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REFRESH_TOKEN: "refresh",
      },
    }),
  );
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-gmail-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-gmail-s-"));
  gmail = await import("../src/gmail.js");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  requests.length = 0;
  userLabels = [{ id: "L1", name: "Existing", type: "user" }];
  filters = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

describe("labels and rules", () => {
  it("lists only the account's own labels, not Gmail's built-in ones", async () => {
    userLabels = [...userLabels, { id: "SPAM", name: "SPAM", type: "system" }];
    expect(await gmail.labels()).toEqual([{ id: "L1", name: "Existing" }]);
  });

  it("refuses a rule with nothing to match, or nothing to do", async () => {
    await expect(gmail.createRule({ label: "x" })).rejects.toBeInstanceOf(gmail.RuleRefused);
    await expect(gmail.createRule({ from: "a@b.com" })).rejects.toBeInstanceOf(gmail.RuleRefused);
  });

  it("reuses a label that already exists, and creates one that does not", async () => {
    const rule = await gmail.createRule({
      from: "boss@work.com",
      label: "Existing",
      archive: true,
    });
    expect(rule).toMatchObject({
      from: "boss@work.com",
      label: "Existing",
      archive: true,
      markRead: false,
    });
    expect(requests.filter((r) => r.url.endsWith("/labels") && r.method === "POST")).toHaveLength(
      0,
    );

    const rule2 = await gmail.createRule({
      subject: "newsletter",
      label: "Newsletters",
      markRead: true,
    });
    expect(rule2.label).toBe("Newsletters");
    expect(requests.filter((r) => r.url.endsWith("/labels") && r.method === "POST")).toHaveLength(
      1,
    );
  });

  it("lists filters back with the label name, not its id", async () => {
    await gmail.createRule({ query: "has:attachment larger:5M", archive: true, markRead: true });
    const [rule] = await gmail.rules();
    expect(rule).toMatchObject({
      query: "has:attachment larger:5M",
      archive: true,
      markRead: true,
    });
  });

  it("deletes a rule by id", async () => {
    const rule = await gmail.createRule({ query: "list:newsletter", archive: true });
    await gmail.deleteRule(rule.id);
    expect(requests.some((r) => r.method === "DELETE" && r.url.endsWith(`/${rule.id}`))).toBe(true);
  });
});
