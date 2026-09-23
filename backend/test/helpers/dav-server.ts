import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A CalDAV server small enough to read: one principal, one calendar, the
 * objects in a map. What tsdav asks of a real server, answered the way one
 * answers it, so calendar.ts is tested through the real client and the real
 * HTTP rather than a mocked tsdav.
 *
 * - PROPFIND on anything: the principal and its calendar home, or, at depth 1
 *   on the home, the one calendar.
 * - REPORT on the calendar: every object, the one a UID text-match names, or
 *   for a multiget, the hrefs it lists.
 * - PUT and DELETE on an object's href, with a new etag per write.
 * - `hang`: accept every request and never answer, for the timeout.
 */
export interface DavObject {
  data: string;
  etag: string;
}

export interface DavServer {
  url: string;
  objects: Map<string, DavObject>;
  requests: { method: string; url: string; body: string }[];
  hang: boolean;
  /** The next requests of a method, answered with this status and nothing done. */
  fail: { method: string; status: number; times: number } | null;
  close(): Promise<void>;
}

const PRINCIPAL = "/principal/";
const HOME = "/cal/";
export const CALENDAR = "/cal/home/";

function multistatus(responses: string[]): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">',
    ...responses,
    "</d:multistatus>",
  ].join("\n");
}

function response(href: string, props: string): string {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export async function startDavServer(): Promise<DavServer> {
  let etags = 0;
  const hanging: http.ServerResponse[] = [];
  const state: DavServer = {
    url: "",
    objects: new Map(),
    requests: [],
    hang: false,
    fail: null,
    close: async () => {
      for (const res of hanging) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://dav").pathname;
      const method = req.method ?? "GET";
      state.requests.push({ method, url, body });
      if (state.hang) {
        hanging.push(res);
        return;
      }
      if (state.fail && state.fail.method === method && state.fail.times > 0) {
        state.fail.times--;
        res.writeHead(state.fail.status).end();
        return;
      }
      const xml = (status: number, text: string) => {
        res.writeHead(status, { "content-type": "application/xml; charset=utf-8" });
        res.end(text);
      };

      if (method === "PROPFIND") {
        if (url === HOME && req.headers.depth === "1") {
          return xml(
            207,
            multistatus([
              response(HOME, "<d:resourcetype><d:collection/></d:resourcetype>"),
              response(
                CALENDAR,
                [
                  "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
                  "<d:displayname>Home</d:displayname>",
                  '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
                  `<cs:getctag>${etags}</cs:getctag>`,
                  `<d:sync-token>${etags}</d:sync-token>`,
                ].join(""),
              ),
            ]),
          );
        }
        return xml(
          207,
          multistatus([
            response(
              url,
              [
                `<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`,
                `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>`,
              ].join(""),
            ),
          ]),
        );
      }

      if (method === "REPORT" && url === CALENDAR) {
        const uid = /<c:text-match[^>]*>([^<]+)<\/c:text-match>/.exec(body)?.[1];
        const named = body.includes("calendar-multiget")
          ? new Set([...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1]))
          : null;
        const hits = [...state.objects].filter(
          ([href, o]) => (!uid || o.data.includes(`UID:${uid}\r\n`)) && (!named || named.has(href)),
        );
        return xml(
          207,
          multistatus(
            hits.map(([href, o]) =>
              response(
                href,
                `<d:getetag>${o.etag}</d:getetag><c:calendar-data>${xmlEscape(o.data)}</c:calendar-data>`,
              ),
            ),
          ),
        );
      }

      if (method === "PUT" && url.startsWith(CALENDAR)) {
        const had = state.objects.has(url);
        const etag = `"${++etags}"`;
        state.objects.set(url, { data: body, etag });
        res.writeHead(had ? 204 : 201, { etag });
        return res.end();
      }

      if (method === "DELETE" && state.objects.delete(url)) {
        res.writeHead(204);
        return res.end();
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return state;
}
