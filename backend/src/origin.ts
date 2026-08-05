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

  let host: string;
  try {
    // Throws on the literal "null" Origin that sandboxed iframes and some
    // file:// pages send, which is what we want.
    host = new URL(origin).host;
  } catch {
    return false;
  }
  // Same-origin: compare host:port, so the check works over http and https
  // alike without the backend having to know which one is in front of it.
  if (host !== "" && host === req.headers.host) return true;

  return env.ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""));
}

/** Requests that can change state, and so need the Origin check. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWebsocketUpgrade(req: FastifyRequest): boolean {
  return String(req.headers.upgrade ?? "").toLowerCase() === "websocket";
}

export function needsOriginCheck(req: FastifyRequest): boolean {
  return MUTATING.has(req.method) || isWebsocketUpgrade(req);
}
