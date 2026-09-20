import type { FastifyRequest } from "fastify";
import { env } from "./env.js";

/**
 * Cross-origin defence for a deployment that deliberately has no in-app auth
 * (WireGuard is the auth boundary).
 *
 * WebSockets are exempt from CORS entirely, so without this any page a browser
 * loads while on the VPN could open ws://<pod>:8080/api/sessions/<id>/attach and
 * type into a session holding agent credentials and push access — and session
 * ids are guessable (`vk-<project>-<seq>`). Plain mutating requests are the same
 * story through CORS-simple POSTs, which need no preflight and so are never
 * blocked by the browser on the way out.
 *
 * A missing Origin means the caller is not a browser: an agent's curl, a health
 * probe, kubectl port-forward. Browsers always send Origin on websocket upgrades
 * and on cross-origin requests, so there is nothing to defend against there.
 */
export function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;

  let url: URL;
  try {
    // Throws on the literal "null" Origin that sandboxed iframes and some
    // file:// pages send, which is what we want.
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.host === "") return false;
  if (!schemeAllowed(url)) return false;
  // Same-origin: compare host:port, so the check works over http and https
  // alike without the backend having to know which one is in front of it.
  if (url.host === req.headers.host) return true;

  return env.ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""));
}

/**
 * A page served over http on a name this deployment answers for over https is
 * not this app: it is somebody on the same network serving that name. The
 * app itself is http inside the pod, so an address reached directly over the
 * VPN keeps working — only the public name is held to its scheme.
 */
function schemeAllowed(origin: URL): boolean {
  if (!env.PUBLIC_URL.startsWith("https://")) return true;
  if (origin.protocol === "https:") return true;
  return isLiteralAddress(origin.hostname);
}

/** An IPv4 or bracketed IPv6 literal, or localhost. */
function isLiteralAddress(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    // A colon is what makes it IPv6 rather than a name of hex-looking letters.
    /^\[?[0-9a-f]*:[0-9a-f:.]*\]?$/i.test(hostname)
  );
}

/**
 * The names this backend answers to.
 *
 * Without this the check above is satisfied by DNS rebinding: a page on
 * evil.example:8080 whose name re-resolves to the pod makes every later request
 * same-origin, so Host and Origin agree and the whole API opens up — mutations,
 * the attach websocket, and through plain same-origin GETs, which carry no
 * Origin at all, mail, documents, session chat and the credential reveal. An
 * ingress that routes strictly by name stops it; nothing else on the VPN does,
 * and port 8080 is reachable directly over WireGuard and through port-forward.
 *
 * Literal addresses stay allowed. A browser does not rebind onto one — the
 * attacker's page would have to be served from that address already — and they
 * are how the kubelet's probes, `kubectl port-forward`, `make run` and a phone
 * on the LAN reach the app. A name is answered for only if this deployment was
 * told about it, through PUBLIC_URL or ALLOWED_ORIGINS.
 */
const ALLOWED_HOSTNAMES = new Set(
  [env.PUBLIC_URL, ...env.ALLOWED_ORIGINS].filter(Boolean).map((o) => new URL(o).hostname),
);

export function hostAllowed(req: FastifyRequest): boolean {
  const header = req.headers.host;
  if (!header) return false;
  // The port says nothing here: after a rebinding the request arrives on
  // whichever port the attacker's page was loaded from. Only the name matters.
  const hostname = header.replace(/:\d+$/, "").toLowerCase();
  return isLiteralAddress(hostname) || ALLOWED_HOSTNAMES.has(hostname);
}

/** Requests that can change state, and so need the Origin check. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWebsocketUpgrade(req: FastifyRequest): boolean {
  return String(req.headers.upgrade ?? "").toLowerCase() === "websocket";
}

export function needsOriginCheck(req: FastifyRequest): boolean {
  // The event stream is a GET, but it is a long-lived one that keeps pushing
  // what is running and where: a page on the VPN could open it cross-origin
  // with EventSource and read the bench indefinitely. Ordinary GETs are exempt
  // because a cross-origin fetch cannot read the response without CORS headers,
  // which nothing here sends — EventSource is the exception that can.
  return MUTATING.has(req.method) || isWebsocketUpgrade(req) || req.url.startsWith("/api/events");
}
