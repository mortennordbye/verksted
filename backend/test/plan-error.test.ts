import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A plan that cannot be read ends at null whatever went wrong, and the hub
 * answers a null plan by hiding the meters. So a token the account has stopped
 * accepting, an endpoint that has changed shape under an undocumented read,
 * and a pod with no token at all were one silence — and on 2026-09-20 the pod
 * had been in it long enough that the week-window guard in front of the
 * unattended runs had nothing to read and had quietly stopped guarding.
 *
 * The three want opposite things done about them, so the reason has to travel.
 */
let home: string;

const OK_BODY = {
  five_hour: { utilization: 12, resets_at: "2026-09-20T20:00:00.000Z" },
  seven_day: { utilization: 40, resets_at: "2026-09-24T00:00:00.000Z" },
  limits: [],
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "vk-home-"));
  process.env.HOME = home;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SETTINGS_FILE = path.join(home, "settings.json");
  process.env.STATIC_DIR = "";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-test-token";
});

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

/**
 * planUsage memoizes for a minute and the reason is module state, so each case
 * takes its own copy of the module rather than the last case's answers.
 */
const read = async (): Promise<typeof import("../src/plan.js")> => {
  vi.resetModules();
  return await import("../src/plan.js");
};

describe("why the plan could not be read", () => {
  it("names a refused token as one, rather than as an absence", async () => {
    const mod = await read();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    expect(await mod.planUsage()).toBeNull();
    expect(mod.planError()).toMatch(/expired or been revoked/);
    expect(mod.planError()).toContain("401");
  });

  it("tells a shape it cannot read apart from a credential it cannot use", async () => {
    const mod = await read();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ five_hour: { pct: 12 }, seven_day: { pct: 40 } })),
    );
    expect(await mod.planUsage()).toBeNull();
    expect(mod.planError()).toMatch(/shape this cannot read/);
  });

  it("says so when the account cannot be reached at all", async () => {
    const mod = await read();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
      }),
    );
    expect(await mod.planUsage()).toBeNull();
    expect(mod.planError()).toContain("ENOTFOUND");
  });

  it("carries no reason once the plan reads", async () => {
    const mod = await read();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(OK_BODY)),
    );
    expect(await mod.planUsage()).toMatchObject({ week: { percent: 40 } });
    expect(mod.planError()).toBeNull();
  });

  it("never puts the token or the body in the reason", async () => {
    const mod = await read();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-body-contents", { status: 403 })),
    );
    await mod.planUsage();
    expect(mod.planError()).not.toContain("sk-test-token");
    expect(mod.planError()).not.toContain("secret-body-contents");
  });
});
