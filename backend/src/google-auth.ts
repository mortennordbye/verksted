import { randomBytes, timingSafeEqual } from "node:crypto";
import type { GoogleCalendarStatus } from "../../shared/api.js";
import { env } from "./env.js";
import { readVars, writeVars } from "./settings-store.js";

/**
 * Signing in to Google, for the calendar.
 *
 * Google's CalDAV takes OAuth and nothing else: a password in CALDAV_* is
 * answered with a 401. This is the authorization-code flow with offline
 * access. The person signs in once on Google's own page, the pod keeps the
 * refresh token beside the other source credentials, and tsdav trades it for
 * an access token each time it connects.
 *
 * Nothing here verifies a token. Every one arrives straight from Google's
 * token endpoint over TLS, in answer to a request this server made, so there
 * is no signature whose checking could be got wrong.
 */
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
export const GOOGLE_CALDAV_URL = "https://apidata.googleusercontent.com/caldav/v2/";

export const CALLBACK_PATH = "/api/calendar/google/callback";
export const STATE_COOKIE = "vk_google_state";

export class GoogleAuthError extends Error {}

/**
 * Where Google sends the browser back. It has to match one registered by hand
 * on the OAuth client, so the settings page shows this exact string.
 *
 * PUBLIC_URL when the deployment sets it. Otherwise the Host the page was
 * loaded from: a forged one only changes where Google is asked to redirect,
 * and Google refuses any address that is not registered. Behind the gateway
 * TLS ends before the pod, so anything but localhost is taken to be https.
 */
export function redirectUri(host: string | undefined): string {
  if (env.PUBLIC_URL) return `${env.PUBLIC_URL}${CALLBACK_PATH}`;
  const h = host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? host : "localhost";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(h);
  return `${local ? "http" : "https"}://${h}${CALLBACK_PATH}`;
}

export function authUrl(clientId: string, redirect: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: ["openid", "email", CALENDAR_SCOPE].join(" "),
    // offline for a refresh token; consent so Google sends one again on a
    // second sign-in, which it otherwise leaves out.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

const STATE_TTL = 10 * 60_000;
const pending = new Map<string, number>();

/**
 * A state for one sign-in. It goes to Google in the URL and to the browser as
 * a cookie, and the callback needs both to agree: that is what stops a link
 * carrying somebody else's code from signing this bench into their calendar.
 */
export function newState(now = Date.now()): string {
  for (const [state, at] of pending) if (now - at > STATE_TTL) pending.delete(state);
  const state = randomBytes(24).toString("base64url");
  pending.set(state, now);
  return state;
}

/** Single use: a state is gone once checked, whether it passed or not. */
export function takeState(state: string, cookie: string | undefined, now = Date.now()): boolean {
  const at = pending.get(state);
  pending.delete(state);
  if (at === undefined || now - at > STATE_TTL || !cookie) return false;
  const a = Buffer.from(state);
  const b = Buffer.from(cookie);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function clientId(): Promise<string | null> {
  const vars = await readVars();
  return vars.GOOGLE_CLIENT_ID && vars.GOOGLE_CLIENT_SECRET ? vars.GOOGLE_CLIENT_ID : null;
}

export async function status(host: string | undefined): Promise<GoogleCalendarStatus> {
  const vars = await readVars();
  return {
    clientSet: !!(vars.GOOGLE_CLIENT_ID && vars.GOOGLE_CLIENT_SECRET),
    account: vars.GOOGLE_REFRESH_TOKEN ? (vars.GOOGLE_CALENDAR_USER ?? null) : null,
    redirectUri: redirectUri(host),
  };
}

/** Trade the code for tokens, learn whose they are, and keep them. Returns the address. */
export async function connect(code: string, redirect: string): Promise<string> {
  const vars = await readVars();
  if (!vars.GOOGLE_CLIENT_ID || !vars.GOOGLE_CLIENT_SECRET) {
    throw new GoogleAuthError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: vars.GOOGLE_CLIENT_ID,
      client_secret: vars.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokens = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !tokens.access_token) {
    throw new GoogleAuthError(
      `Google refused the sign-in: ${tokens.error_description ?? tokens.error ?? res.status}`,
    );
  }
  if (!tokens.scope?.split(" ").includes(CALENDAR_SCOPE)) {
    throw new GoogleAuthError("calendar access was not granted; tick it on Google's page");
  }
  if (!tokens.refresh_token) {
    throw new GoogleAuthError("Google sent no refresh token; sign in again");
  }

  const who = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const info = (await who.json().catch(() => ({}))) as { email?: string };
  if (!who.ok || !info.email)
    throw new GoogleAuthError("Google did not say which account signed in");

  // Read again right before writing: the exchange took a round trip, and a
  // var saved on the settings page meanwhile must not be written over.
  await writeVars({
    ...(await readVars()),
    GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
    GOOGLE_CALENDAR_USER: info.email,
  });
  return info.email;
}

/**
 * Sign out: the token is revoked at Google where that answers, and forgotten
 * here either way. The client stays, so signing in again is one tap.
 */
export async function disconnect(): Promise<void> {
  const vars = await readVars();
  const token = vars.GOOGLE_REFRESH_TOKEN;
  delete vars.GOOGLE_REFRESH_TOKEN;
  delete vars.GOOGLE_CALENDAR_USER;
  await writeVars(vars);
  if (token) {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}
