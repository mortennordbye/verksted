import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DocEntry, DocHit } from "../../../shared/api.js";
import * as docs from "../docs.js";
import { PathDeniedError } from "../paths.js";

/**
 * The documents, read. 503 with a sentence when no share is mounted; 404 for
 * a path that is not inside it, indistinguishable from one that does not
 * exist, which is the one thing the scoping is there to hide.
 */
const PATH = {
  type: "object",
  additionalProperties: false,
  properties: { path: { type: "string", maxLength: 1000 } },
};

/**
 * What a browser may render in place, and as what.
 *
 * An allowlist, and deliberately without text/html or image/svg+xml: this app
 * has no auth and the share is full of files nobody here wrote, so a document
 * served inline runs on the app's own origin with the whole API in reach.
 * Anything not named here is handed over as an opaque download instead, which
 * is the same answer for a .docx as for something unrecognised — the text of
 * one is what /api/docs/read is for.
 */
const INLINE: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  // Everything textual as plain text, never as the type it claims to be: a
  // .json or a .csv rendered as itself is harmless, one sniffed as markup is
  // not, and the viewer wants the characters either way.
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".ics": "text/plain; charset=utf-8",
  ".eml": "text/plain; charset=utf-8",
};

/** `bytes=<from>-<to>`, the only form a media element sends. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (!m[1] && !m[2])) return null;
  // A suffix range ("bytes=-500") is the last N bytes; anything else runs to
  // the end of the file unless it names its own.
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] ? (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1) : size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}

/** The filename in a Content-Disposition, both spellings, neither breakable. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export default async function docsRoutes(app: FastifyInstance) {
  const guard = async <T>(
    fn: () => Promise<T>,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Promise<unknown> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof docs.DocsUnavailable) return reply.code(503).send({ error: err.message });
      if (err instanceof PathDeniedError || (err as { code?: string }).code === "ENOENT") {
        return reply.code(404).send({ error: "not found" });
      }
      app.log.warn(err, "documents failed");
      return reply.code(502).send({ error: "the documents could not be read" });
    }
  };

  app.get<{ Querystring: { path?: string } }>(
    "/api/docs",
    { schema: { querystring: PATH } },
    (req, reply) => guard<DocEntry[]>(() => docs.list(req.query.path ?? ""), reply),
  );

  app.get<{ Querystring: { path: string } }>(
    "/api/docs/read",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 1000 } },
        },
      },
    },
    (req, reply) =>
      guard(async () => {
        const doc = await docs.read(req.query.path);
        return doc ?? reply.code(404).send({ error: "not found" });
      }, reply),
  );

  app.get<{ Querystring: { q: string } }>(
    "/api/docs/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          additionalProperties: false,
          properties: { q: { type: "string", minLength: 2, maxLength: 200 } },
        },
      },
    },
    (req, reply) => guard<DocHit[]>(() => docs.search(req.query.q), reply),
  );

  /**
   * A document's own bytes, so the share can be looked at rather than only
   * searched: a PDF as a PDF, a photo as a photo, a video the phone can seek.
   *
   * Ranges are answered because that is what a media element asks for, and
   * Safari will not play a video at all without them.
   */
  app.get<{ Querystring: { path: string } }>(
    "/api/docs/raw",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 1000 } },
        },
      },
    },
    (req, reply) =>
      guard(async () => {
        const real = await docs.realPathOf(req.query.path);
        const stat = await fs.stat(real);
        if (!stat.isFile()) return reply.code(404).send({ error: "not found" });
        const name = path.basename(real);
        const type = INLINE[path.extname(real).toLowerCase()];
        reply
          .header("content-type", type ?? "application/octet-stream")
          .header("content-disposition", disposition(type ? "inline" : "attachment", name))
          // Without this Chrome sniffs an octet-stream body and may decide it
          // is HTML, which is the one thing the allowlist above is avoiding.
          .header("x-content-type-options", "nosniff")
          .header("accept-ranges", "bytes");
        const range = parseRange(req.headers.range, stat.size);
        if (!range) {
          return reply
            .header("content-length", String(stat.size))
            .send(createReadStream(real)) as unknown as FastifyReply;
        }
        return reply
          .code(206)
          .header("content-range", `bytes ${range.start}-${range.end}/${stat.size}`)
          .header("content-length", String(range.end - range.start + 1))
          .send(
            createReadStream(real, { start: range.start, end: range.end }),
          ) as unknown as FastifyReply;
      }, reply),
  );

  app.get("/api/docs/catalogue", (_req, reply) =>
    guard(async () => ({ text: await docs.catalogueText() }), reply),
  );
}
