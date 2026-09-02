import type { FastifyInstance } from "fastify";
import type { Settings } from "../../../shared/api.js";
import { env } from "../env.js";
import { purgeBlocked } from "../pollers.js";
import * as settings from "../settings-store.js";

/** A GitHub login: what the owner half of owner/repo may look like. */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

async function currentSettings(): Promise<Settings> {
  const stored = await settings.readVars();
  const keys = [...new Set([...settings.KNOWN_AGENT_KEYS, ...Object.keys(stored)])].sort();
  return {
    server: {
      PORT: String(env.PORT),
      REPOS_DIR: env.REPOS_DIR,
      SESSIONS_DIR: env.SESSIONS_DIR,
      SCHEDULES_DIR: env.SCHEDULES_DIR,
      SETTINGS_FILE: env.SETTINGS_FILE,
    },
    vars: keys.map((key) => {
      const value = stored[key] ?? process.env[key];
      return {
        key,
        source: stored[key] !== undefined ? "settings" : process.env[key] ? "env" : "unset",
        // A fingerprint rather than the value: enough to tell a token you just
        // pasted from the one it replaced, and to see that a save landed,
        // without a live credential rendered on a screen.
        fingerprint: value ? settings.fingerprint(value) : null,
      } as const;
    }),
    schedulesPaused: await settings.schedulesPaused(),
    blockedOwners: await settings.readBlockedOwners(),
  };
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async (): Promise<Settings> => currentSettings());

  // Set (string) or clear (null) settings-page vars. Values are write-only:
  // they are stored and injected into new tmux sessions, never returned.
  app.put<{
    Body: {
      vars?: Record<string, string | null>;
      schedulesPaused?: boolean;
      blockedOwners?: string[];
    };
  }>(
    "/api/settings",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            schedulesPaused: { type: "boolean" },
            blockedOwners: {
              type: "array",
              maxItems: 50,
              items: { type: "string", maxLength: 39 },
            },
            vars: {
              type: "object",
              maxProperties: 50,
              // Key shape is enforced in the handler: fastify's ajv strips
              // (rather than rejects) additional properties.
              additionalProperties: { type: ["string", "null"], maxLength: 4096 },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (req.body.schedulesPaused !== undefined) {
        await settings.setSchedulesPaused(req.body.schedulesPaused);
      }
      if (req.body.blockedOwners !== undefined) {
        const owners = req.body.blockedOwners.map((o) => o.trim()).filter(Boolean);
        for (const owner of owners) {
          if (!OWNER_RE.test(owner)) {
            return reply.code(400).send({ error: `not a GitHub owner: ${owner}` });
          }
        }
        await settings.writeBlockedOwners(owners);
        // What the owner left behind goes with the decision, not on the next
        // restart: the row on the screen is the name that should not be there.
        await purgeBlocked();
      }
      if (!req.body.vars) return currentSettings();
      for (const key of Object.keys(req.body.vars)) {
        if (!settings.VAR_KEY_RE.test(key)) {
          return reply.code(400).send({ error: `invalid variable name: ${key}` });
        }
        if (settings.BLOCKED_KEYS.has(key)) {
          return reply
            .code(400)
            .send({ error: `${key} is not allowed (it overrides subscription auth)` });
        }
      }
      const stored = await settings.readVars();
      for (const [key, value] of Object.entries(req.body.vars)) {
        if (value === null || value === "") delete stored[key];
        else stored[key] = value;
      }
      if (Object.keys(stored).length > 50) {
        return reply.code(400).send({ error: "too many variables" });
      }
      await settings.writeVars(stored);
      return currentSettings();
    },
  );

  /**
   * The whole value of one stored variable, for the copy button.
   *
   * A POST rather than a GET so it goes through the same-origin check every
   * other write does (see origin.ts) — ordinary GETs are exempt, and this is a
   * read of a credential rather than of the bench.
   *
   * Only variables stored on the settings page. One set in the deployment is
   * answered 404: it is not this page's to hand back, and reading arbitrary
   * names out of the server's own environment is a different power than the one
   * this button needs.
   */
  app.post<{ Params: { key: string } }>("/api/settings/vars/:key/reveal", async (req, reply) => {
    const { key } = req.params;
    if (!settings.VAR_KEY_RE.test(key) || settings.BLOCKED_KEYS.has(key)) {
      return reply.code(404).send({ error: "not found" });
    }
    const value = (await settings.readVars())[key];
    if (value === undefined) return reply.code(404).send({ error: "not found" });
    return { key, value };
  });
}
