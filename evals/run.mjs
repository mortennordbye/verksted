#!/usr/bin/env node
// Asks the assistant every case in assistant.json, in a thread of its own, and says
// which used the tools a good answer needs. Talks to a running bench over HTTP, so
// it costs real turns: run it on purpose (`make eval`), not in CI.
//
//   VK_URL=https://verksted.local.bigd.no node evals/run.mjs [id...]
import { readFileSync } from "node:fs";

const base = process.env.VK_URL || "http://127.0.0.1:8080";
const only = process.argv.slice(2);
/** @typedef {{ id: string; ask: string; uses: string[]; never?: string[] }} Case */
/** @type {{ cases: Case[] }} */
const { cases } = JSON.parse(readFileSync(new URL("./assistant.json", import.meta.url), "utf8"));

/**
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<import("../shared/api.js").AssistantThread>}
 */
async function call(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    // The content type only with a body: Fastify refuses an empty JSON one.
    headers: { origin: base, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return /** @type {Promise<import("../shared/api.js").AssistantThread>} */ (res.json());
}

await call("/api/assistant/new");
let passed = 0;
const run = cases.filter((c) => !only.length || only.includes(c.id));
for (const c of run) {
  const started = Date.now();
  const thread = await call("/api/assistant/messages", { text: c.ask, wait: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const asked = thread.entries.map((e) => e.role).lastIndexOf("user");
  const said = thread.entries.slice(asked + 1);
  const tools = said.flatMap((e) => e.tools.map((t) => t.name));
  const failed = said.some((e) => e.failed);
  const missing = c.uses.filter((pattern) => !tools.some((t) => new RegExp(pattern).test(t)));
  const forbidden = (c.never ?? []).filter((pattern) =>
    tools.some((t) => new RegExp(pattern).test(t)),
  );
  const ok = !failed && !missing.length && !forbidden.length;
  if (ok) passed++;
  const why = [
    failed && "a reply failed",
    missing.length && `did not use ${missing.join(", ")}`,
    forbidden.length && `used ${forbidden.join(", ")}`,
  ].filter(Boolean);
  console.log(
    `${ok ? "pass" : "FAIL"}  ${c.id.padEnd(18)} ${seconds.padStart(6)}s  ${why.join("; ")}`,
  );
}
console.log(`\n${passed}/${run.length} passed`);
process.exitCode = passed === run.length ? 0 : 1;
