import type { FastifyInstance, FastifyReply } from "fastify";
import type { LogEveryLiftStatus } from "../../../shared/api.js";
import { takeState } from "../google-auth.js";
import * as lel from "../logeverylift-auth.js";

/**
 * LogEveryLift sign-in: start, callback, status, sign out.
 *
 * The same shape as the Google routes and for the same reasons: start and
 * callback are browser navigations, so they answer with redirects back to the
 * settings page, and the state in the URL and the matching cookie are the
 * callback's CSRF check.
 */
const SETTINGS = "/settings?tab=sources";

function back(reply: FastifyReply, outcome: { ok: true } | { error: string }): FastifyReply {
  const q =
    "ok" in outcome ? "logeverylift=ok" : `logeverylift_error=${encodeURIComponent(outcome.error)}`;
  return reply.redirect(`${SETTINGS}&${q}`);
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${lel.STATE_COOKIE}=${value}; Path=/api/connectors/logeverylift; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export default async function logEveryLiftRoutes(app: FastifyInstance) {
  app.get("/api/connectors/logeverylift", (): Promise<LogEveryLiftStatus> => lel.status());

  app.get("/api/connectors/logeverylift/start", async (req, reply) => {
    try {
      const { url, state } = await lel.begin(req.headers.host);
      reply.header("set-cookie", cookie(state, 600, url.startsWith("https:")));
      return reply.redirect(url);
    } catch (err) {
      req.log.error(err, "logeverylift sign-in could not start");
      return back(reply, { error: "could not reach LogEveryLift; try again" });
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    lel.CALLBACK_PATH,
    {
      schema: {
        // Not additionalProperties: false. The server may add its own, such as iss.
        querystring: {
          type: "object",
          properties: {
            code: { type: "string", maxLength: 4096 },
            state: { type: "string", maxLength: 200 },
            error: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const sent = new RegExp(`(?:^|;\\s*)${lel.STATE_COOKIE}=([^;]+)`).exec(
        req.headers.cookie ?? "",
      )?.[1];
      reply.header("set-cookie", cookie("", 0, true));
      if (!req.query.state || !takeState(req.query.state, sent)) {
        return back(reply, { error: "that sign-in expired or was not started here; try again" });
      }
      if (req.query.error || !req.query.code) {
        return back(reply, {
          error:
            req.query.error === "access_denied"
              ? "sign-in was cancelled"
              : `LogEveryLift said: ${req.query.error ?? "no code"}`,
        });
      }
      try {
        await lel.finish(req.query.state, req.query.code);
        return back(reply, { ok: true });
      } catch (err) {
        if (err instanceof lel.LogEveryLiftAuthError) return back(reply, { error: err.message });
        req.log.error(err, "logeverylift sign-in failed");
        return back(reply, { error: "could not finish signing in; try again" });
      }
    },
  );

  app.post("/api/connectors/logeverylift/disconnect", async (): Promise<LogEveryLiftStatus> => {
    await lel.disconnect();
    return lel.status();
  });
}
