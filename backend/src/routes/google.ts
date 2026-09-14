import type { FastifyInstance, FastifyReply } from "fastify";
import type { GoogleCalendarStatus } from "../../../shared/api.js";
import * as google from "../google-auth.js";

/**
 * Google sign-in for the calendar: start, callback, status, sign out.
 *
 * Start and callback are browser navigations rather than fetches, so they
 * answer with redirects back to the settings page, carrying the outcome in
 * the query, instead of JSON nobody would see. The callback is a GET that
 * writes; the state in the URL and the matching cookie are its CSRF check,
 * since the origin guard only looks at mutating methods.
 */
const SETTINGS = "/settings?tab=sources";

function back(reply: FastifyReply, outcome: { ok: true } | { error: string }): FastifyReply {
  const q = "ok" in outcome ? "google=ok" : `google_error=${encodeURIComponent(outcome.error)}`;
  return reply.redirect(`${SETTINGS}&${q}`);
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${google.STATE_COOKIE}=${value}; Path=/api/calendar/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export default async function googleRoutes(app: FastifyInstance) {
  app.get(
    "/api/calendar/google",
    (req): Promise<GoogleCalendarStatus> => google.status(req.headers.host),
  );

  app.get("/api/calendar/google/start", async (req, reply) => {
    const clientId = await google.clientId();
    if (!clientId) return back(reply, { error: "set the client ID and secret first" });
    const redirect = google.redirectUri(req.headers.host);
    const state = google.newState();
    reply.header("set-cookie", cookie(state, 600, redirect.startsWith("https:")));
    return reply.redirect(google.authUrl(clientId, redirect, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    google.CALLBACK_PATH,
    {
      schema: {
        // Not additionalProperties: false. Google adds scope, authuser, hd and
        // prompt, and refusing those would refuse every real sign-in.
        querystring: {
          type: "object",
          properties: {
            code: { type: "string", maxLength: 2048 },
            state: { type: "string", maxLength: 200 },
            error: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const redirect = google.redirectUri(req.headers.host);
      const sent = new RegExp(`(?:^|;\\s*)${google.STATE_COOKIE}=([^;]+)`).exec(
        req.headers.cookie ?? "",
      )?.[1];
      reply.header("set-cookie", cookie("", 0, redirect.startsWith("https:")));
      if (!req.query.state || !google.takeState(req.query.state, sent)) {
        return back(reply, { error: "that sign-in expired or was not started here; try again" });
      }
      if (req.query.error || !req.query.code) {
        return back(reply, {
          error:
            req.query.error === "access_denied"
              ? "sign-in was cancelled"
              : `Google said: ${req.query.error ?? "no code"}`,
        });
      }
      try {
        await google.connect(req.query.code, redirect);
        return back(reply, { ok: true });
      } catch (err) {
        if (err instanceof google.GoogleAuthError) return back(reply, { error: err.message });
        req.log.error(err, "google sign-in failed");
        return back(reply, { error: "could not reach Google; try again" });
      }
    },
  );

  app.post(
    "/api/calendar/google/disconnect",
    async (req): Promise<GoogleCalendarStatus> => {
      await google.disconnect();
      return google.status(req.headers.host);
    },
  );
}
