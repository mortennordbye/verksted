import type { FastifyInstance } from "fastify";
import type { Settings } from "../../../shared/api.js";
import { env } from "../env.js";
import * as settings from "../settings-store.js";

async function currentSettings(): Promise<Settings> {
  const stored = await settings.readVars();
  const keys = [...new Set([...settings.KNOWN_AGENT_KEYS, ...Object.keys(stored)])].sort();
  return {
    server: {
      PORT: String(env.PORT),
      REPOS_DIR: env.REPOS_DIR,
      SESSIONS_DIR: env.SESSIONS_DIR,
      SETTINGS_FILE: env.SETTINGS_FILE,
    },
    vars: keys.map((key) => ({
      key,
      source:
        stored[key] !== undefined ? "settings" : process.env[key] ? "env" : "unset",
    })),
  };
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async (): Promise<Settings> => currentSettings());

  // Set (string) or clear (null) settings-page vars. Values are write-only:
  // they are stored and injected into new tmux sessions, never returned.
  app.put<{ Body: { vars: Record<string, string | null> } }>(
    "/api/settings",
    {
      schema: {
        body: {
          type: "object",
          required: ["vars"],
          additionalProperties: false,
          properties: {
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
}
