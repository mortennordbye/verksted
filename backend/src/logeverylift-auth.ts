import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { LogEveryLiftStatus } from "../../shared/api.js";
import { env } from "./env.js";
import { newState } from "./google-auth.js";
import { keyedQueue } from "./serial.js";
import { patchVars, readVars } from "./settings-store.js";

/**
 * Signing in to LogEveryLift, so the assistant can read training.
 *
 * Its MCP server takes OAuth and nothing else, and a headless turn has no browser
 * to sign in with. So the person signs in once from the settings page, the pod
 * keeps the refresh token beside the other source credentials, and each turn is
 * handed a current access token through its environment. The MCP config names the
 * variable, not the value, and no session ever sees the refresh token.
 *
 * The flow and its discovery are the MCP SDK's rather than written here.
 */
export const MCP_URL = "https://logeverylift.com/api/mcp";
export const CALLBACK_PATH = "/api/connectors/logeverylift/callback";
export const STATE_COOKIE = "vk_logeverylift_state";

/** offline_access is what gets a refresh token at all. */
const SCOPE = "openid offline_access";
const RESOURCE = new URL(MCP_URL);
const CLIENT_VAR = "LOGEVERYLIFT_CLIENT";
const TOKENS_VAR = "LOGEVERYLIFT_TOKENS";

/**
 * How much life a token has to have left to be handed to a turn. Longer than a
 * warm process waits for its question, so the token it started with is still good
 * when it is asked, and it is not ended early for holding an old one.
 */
const REFRESH_MARGIN_MS = 20 * 60_000;

/** A turn waits on this, so a service that hangs must not hold it up for long. */
const NETWORK_MS = 8_000;
const fetchFn: typeof fetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(NETWORK_MS) });

interface Tokens {
  access: string;
  refresh?: string;
  expiresAt: number;
}

export class LogEveryLiftAuthError extends Error {}

function redirectUri(host: string | undefined): string {
  if (env.PUBLIC_URL) return `${env.PUBLIC_URL}${CALLBACK_PATH}`;
  const h = host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? host : "localhost";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(h);
  return `${local ? "http" : "https"}://${h}${CALLBACK_PATH}`;
}

function parsed<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function metadata(): Promise<{ server: URL; meta: AuthorizationServerMetadata }> {
  const resource = await discoverOAuthProtectedResourceMetadata(MCP_URL, undefined, fetchFn);
  const server = new URL(resource.authorization_servers?.[0] ?? RESOURCE.origin);
  const meta = await discoverAuthorizationServerMetadata(server, { fetchFn });
  if (!meta) throw new LogEveryLiftAuthError("LogEveryLift does not offer a sign-in here");
  return { server, meta };
}

/** Registered once per redirect address, and kept: it is not a secret worth redoing. */
async function client(
  server: URL,
  meta: AuthorizationServerMetadata,
  redirect: string,
): Promise<OAuthClientInformationFull> {
  const kept = parsed<OAuthClientInformationFull>((await readVars())[CLIENT_VAR]);
  if (kept?.redirect_uris.map(String).includes(redirect)) return kept;
  const made = await registerClient(server, {
    metadata: meta,
    clientMetadata: {
      client_name: "verksted",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    fetchFn,
  });
  await patchVars({ [CLIENT_VAR]: JSON.stringify(made) });
  return made;
}

/** Sign-ins under way: the PKCE verifier stays here, and only the state travels. */
const started = new Map<string, { verifier: string; redirect: string }>();

/** Where to send the browser, and the state its cookie has to carry back. */
export async function begin(host: string | undefined): Promise<{ url: string; state: string }> {
  const redirect = redirectUri(host);
  const { server, meta } = await metadata();
  const state = newState();
  const { authorizationUrl, codeVerifier } = await startAuthorization(server, {
    metadata: meta,
    clientInformation: await client(server, meta, redirect),
    redirectUrl: redirect,
    scope: SCOPE,
    state,
    resource: RESOURCE,
  });
  started.set(state, { verifier: codeVerifier, redirect });
  return { url: authorizationUrl.toString(), state };
}

function keep(answer: { access_token: string; refresh_token?: string; expires_in?: number }) {
  const tokens: Tokens = {
    access: answer.access_token,
    ...(answer.refresh_token ? { refresh: answer.refresh_token } : {}),
    expiresAt: Date.now() + (answer.expires_in ?? 3600) * 1000,
  };
  return tokens;
}

/** Trade the code the browser came back with. The caller has checked the state. */
export async function finish(state: string, code: string): Promise<void> {
  const pending = started.get(state);
  started.delete(state);
  if (!pending) throw new LogEveryLiftAuthError("that sign-in was not started here; try again");
  const { server, meta } = await metadata();
  const answer = await exchangeAuthorization(server, {
    metadata: meta,
    clientInformation: await client(server, meta, pending.redirect),
    authorizationCode: code,
    codeVerifier: pending.verifier,
    redirectUri: pending.redirect,
    resource: RESOURCE,
    fetchFn,
  });
  refused = null;
  await patchVars({ [TOKENS_VAR]: JSON.stringify(keep(answer)) });
}

/** Why the service last said no to the stored sign-in, in its words. */
let refused: string | null = null;

const serial = keyedQueue();

/**
 * A token good for the next while, or null when there is none to be had.
 *
 * One refresh at a time: a refresh token can only be spent once, and a meeting
 * asks for this from several places at the moment it starts. A network fault
 * says nothing about the sign-in, so it is not recorded as refused, and a token
 * that still has time on it is handed over anyway.
 */
export function accessToken(): Promise<string | null> {
  return serial("token", async () => {
    const vars = await readVars();
    const tokens = parsed<Tokens>(vars[TOKENS_VAR]);
    if (!tokens) return null;
    const now = Date.now();
    if (tokens.expiresAt - now > REFRESH_MARGIN_MS) return tokens.access;
    const stillGood = tokens.expiresAt > now ? tokens.access : null;
    const kept = parsed<OAuthClientInformationFull>(vars[CLIENT_VAR]);
    if (!tokens.refresh || !kept) return stillGood;
    let meta;
    try {
      meta = await metadata();
    } catch {
      return stillGood;
    }
    try {
      const answer = await refreshAuthorization(meta.server, {
        metadata: meta.meta,
        clientInformation: kept,
        refreshToken: tokens.refresh,
        resource: RESOURCE,
        fetchFn,
      });
      const next = keep(answer);
      // A server may keep the refresh token rather than rotate it.
      next.refresh ??= tokens.refresh;
      refused = null;
      await patchVars({ [TOKENS_VAR]: JSON.stringify(next) });
      return next.access;
    } catch (err) {
      // Only the service saying no counts. A timeout or a 500 has learned nothing
      // about the sign-in, and "refused" would have someone sign in again to fix
      // a tunnel.
      if (
        err instanceof InvalidGrantError ||
        err instanceof InvalidClientError ||
        err instanceof UnauthorizedClientError
      ) {
        refused = err.message;
      }
      return stillGood;
    }
  });
}

export async function status(): Promise<LogEveryLiftStatus> {
  const connected = !!parsed<Tokens>((await readVars())[TOKENS_VAR]);
  return { connected, error: connected ? refused : null };
}

/** Forget the sign-in here. The grant itself is the person's to remove in the app. */
export async function disconnect(): Promise<void> {
  refused = null;
  await patchVars({ [TOKENS_VAR]: null });
}
