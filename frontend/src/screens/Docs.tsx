import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { useSearchParams } from "react-router";
import type { DocEntry, DocHit } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { MD } from "../components/chat/markdown";
import TopBar from "../components/TopBar";
import { parseCsv } from "../csv";
import { marks, rehypeMark } from "../find";
import { useOverlayDismiss } from "../useDismissOnBack";

/**
 * The share, looked at rather than searched.
 *
 * The documents were reachable only as extracted text, which answers "what
 * does the insurance say" and not "show me the scan". This is the pod as a
 * window onto the NAS: the same read-only mount the tools use, listed a folder
 * at a time, with the bytes of one document rendered in place.
 *
 * Nothing here writes. The share is mounted read-only at the volume, every
 * path is resolved inside it by realpath, and there is deliberately no upload,
 * rename or delete — this screen is a pair of eyes, not a file manager.
 */

/** How a file is shown, decided by its extension, as /api/docs/raw decides. */
const VIDEO = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);
const AUDIO = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus"]);
const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "tif", "tiff"]);
/** Read as characters: the plain ones, plus what an extractor turns into text. */
const TEXT = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "log",
  "eml",
  "ics",
  "docx",
  "odt",
  "rtf",
  "epub",
  "html",
  "htm",
]);

type View = "image" | "video" | "audio" | "pdf" | "text" | "download";

export function viewOf(name: string): View {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (IMAGE.has(ext)) return "image";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (TEXT.has(ext)) return "text";
  return "download";
}

const rawUrl = (path: string) => `/api/docs/raw?path=${encodeURIComponent(path)}`;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export default function Docs() {
  // The folder is in the URL, so back goes up rather than off the screen, and
  // a document you were looking at is a link somebody can be sent.
  const [params, setParams] = useSearchParams();
  const dir = params.get("path") ?? "";
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const { data: entries, error } = usePoll<DocEntry[]>(
    `/api/docs?path=${encodeURIComponent(dir)}`,
    60_000,
  );
  const { data: hits } = usePoll<DocHit[]>(
    query.trim().length >= 2 ? `/api/docs/search?q=${encodeURIComponent(query.trim())}` : null,
    60_000,
  );

  const parts = dir ? dir.split("/") : [];
  const go = (path: string) => setParams(path ? { path } : {}, { replace: false });

  return (
    <>
      <TopBar back="/" crumb={[{ label: "documents" }]} />
      <main className="mx-auto max-w-[860px] px-[18px] pt-[22px] pb-[60px]">
        <h1 className="mb-1 text-[21px] font-semibold tracking-tight">Documents</h1>
        <div className="mb-5 text-sm text-muted">
          The share on the NAS, mounted read-only. Nothing here can change it.
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search the text of every document…"
          className="mb-5 w-full rounded-[9px] border border-line bg-surface-2 px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
        />

        {error && (
          <div className="mb-4 font-mono text-[12px] text-wait">
            {/* 503 is the honest case: no share is mounted at DOCS_DIR. */}
            {error}
          </div>
        )}

        {query.trim().length >= 2 ? (
          <div className="flex flex-col gap-1.5">
            {hits?.length === 0 && <div className="text-[13px] text-faint">nothing matched</div>}
            {(hits ?? []).map((h) => (
              <button
                key={h.path}
                onClick={() => setOpen(h.path)}
                className="tap rounded-[11px] border border-line bg-surface px-[15px] py-2.5 text-left hover:border-line-strong"
              >
                <div className="truncate font-mono text-[12.5px]">{h.path}</div>
                <div className="mt-0.5 truncate text-[12px] text-muted">{h.excerpt}</div>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="mb-2.5 flex flex-wrap items-center gap-1 font-mono text-[12px] text-muted">
              <button onClick={() => go("")} className="tap hover:text-text">
                share
              </button>
              {parts.map((part, i) => (
                <span key={part + i} className="flex items-center gap-1">
                  <span className="text-faint">/</span>
                  <button
                    onClick={() => go(parts.slice(0, i + 1).join("/"))}
                    className="tap hover:text-text"
                  >
                    {part}
                  </button>
                </span>
              ))}
            </div>
            <div className="overflow-hidden rounded-xl border border-line">
              {entries?.length === 0 && (
                <div className="bg-surface px-[15px] py-3 text-[13px] text-faint">empty</div>
              )}
              {(entries ?? []).map((e) => (
                <button
                  key={e.path}
                  onClick={() => (e.dir ? go(e.path) : setOpen(e.path))}
                  className="tap flex w-full items-center gap-3 border-b border-line bg-surface px-[15px] py-2.5 text-left last:border-b-0 hover:bg-surface-2"
                >
                  <span className="flex-none text-[13px]">{e.dir ? "📁" : "📄"}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                    {e.name}
                    {e.dir && "/"}
                  </span>
                  {!e.dir && (
                    <span className="flex-none text-[11px] text-faint">{size(e.size)}</span>
                  )}
                  <span className="flex-none text-[11px] text-faint">{agoLabel(e.modified)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </main>
      {open && (
        // What the share was searched for goes into the viewer with the path:
        // a hit is opened to read one line, not to start at the top.
        <Viewer
          path={open}
          initialFind={query.trim().length >= 2 ? query.trim() : ""}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** How the extracted text is set: as a document, a grid, or as characters. */
type Flavour = "markdown" | "csv" | "code" | "prose";

const MARKDOWN = new Set(["md", "markdown"]);
/** Written for a machine, so kept in the machine's font. */
const CODE = new Set(["json", "log", "ics"]);

export function flavourOf(name: string): Flavour {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (MARKDOWN.has(ext)) return "markdown";
  if (ext === "csv") return "csv";
  if (CODE.has(ext)) return "code";
  return "prose";
}

/** A delimited export as the grid it was, matches marked in the cells. */
function CsvTable({ text, find }: { text: string; find: string }) {
  const { rows, truncated } = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) return <div className="p-4 text-[13px] text-faint">nothing in it</div>;
  const [head, ...body] = rows;
  return (
    <div className="overflow-x-auto p-4">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th
                key={i}
                className="sticky top-0 border-b border-line bg-surface px-2 py-1.5 text-left font-semibold whitespace-nowrap"
              >
                {marks(cell, find)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i} className="even:bg-surface-2/50">
              {/* Indexed by the header, not by the row: a short row would
                  otherwise shift every cell after it one column left. */}
              {head.map((_, c) => (
                <td
                  key={c}
                  className="border-b border-line/60 px-2 py-1 align-top whitespace-nowrap text-muted"
                >
                  {marks(row[c] ?? "", find)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="mt-2 font-mono text-[11px] text-faint">
          first {body.length} rows — the rest is in the file
        </div>
      )}
    </div>
  );
}

/**
 * One document, as itself where the browser can draw it.
 *
 * A PDF, a photo and a video come straight off the share through /api/docs/raw.
 * Everything textual is the extracted text instead of the file — that is what
 * turns a .docx into something readable on a phone, and it is the same text the
 * search matched. Anything else is a download, since the alternative is
 * rendering a stranger's file on this app's own origin.
 *
 * That text used to be one wall of muted monospace whatever it was: a README
 * showed its hashes and asterisks, a bank export its commas, and a scanned
 * contract came out in the app's least readable style at its greatest length.
 * So the extension decides the setting — a document, a grid, or characters —
 * and the find box marks the words in all three.
 */
function Viewer({
  path,
  initialFind,
  onClose,
}: {
  path: string;
  /** What the share was searched for, when the viewer opened on a hit. */
  initialFind: string;
  onClose: () => void;
}) {
  const name = path.split("/").at(-1) ?? path;
  const view = viewOf(name);
  const flavour = flavourOf(name);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [find, setFind] = useState(initialFind);
  const [hits, setHits] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  /** Which match the next jump goes to. */
  const next = useRef(0);
  useOverlayDismiss(true, onClose);

  useEffect(() => {
    if (view !== "text") return;
    let live = true;
    api<{ path: string; text: string }>(`/api/docs/read?path=${encodeURIComponent(path)}`)
      .then((d) => live && setText(d.text))
      .catch((e: Error) => live && setFailed(e.message));
    return () => {
      live = false;
    };
  }, [path, view]);

  /** Count what was actually drawn: markdown syntax is not on the screen. */
  useEffect(() => {
    setHits(body.current?.querySelectorAll("mark").length ?? 0);
    next.current = 0;
  }, [text, find]);

  const jump = useCallback(() => {
    const found = body.current?.querySelectorAll("mark");
    if (!found?.length) return;
    const el = found[next.current % found.length];
    next.current = (next.current + 1) % found.length;
    for (const m of found) m.classList.remove("ring-1", "ring-wait");
    el.classList.add("ring-1", "ring-wait");
    el.scrollIntoView({ block: "center" });
  }, []);

  // Arriving from a search hit, on the match rather than at the top: the
  // document can be forty pages, and the reason for opening it is one line.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !hits || !initialFind) return;
    landed.current = true;
    jump();
  }, [hits, initialFind, jump]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={path}
        className="flex h-[85vh] w-full max-w-[900px] flex-col overflow-hidden rounded-xl border border-line bg-surface"
      >
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 font-mono text-[12px] text-muted">
          <span className="min-w-0 truncate">{path}</span>
          {/* A new tab is the way out of an iframe that will not scroll and of
              a type this app hands over rather than renders. */}
          <a
            href={rawUrl(path)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex-none px-2 text-faint hover:text-text"
          >
            open
          </a>
          <button onClick={onClose} className="flex-none px-2 text-faint hover:text-text">
            ✕
          </button>
        </div>
        {view === "text" && (
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
            <input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && jump()}
              placeholder="find in this document"
              aria-label="find in this document"
              className="min-w-0 flex-1 rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
            />
            {find.trim() !== "" && (
              <>
                <span className="flex-none font-mono text-[11px] text-faint">
                  {hits === 0 ? "no matches" : `${hits} match${hits === 1 ? "" : "es"}`}
                </span>
                <button
                  onClick={jump}
                  disabled={hits === 0}
                  className="tap flex-none rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[11px] text-muted hover:border-faint hover:text-text disabled:opacity-40"
                >
                  next ↓
                </button>
              </>
            )}
          </div>
        )}
        <div ref={body} className="min-h-0 flex-1 overflow-auto bg-bg">
          {view === "image" && (
            <img src={rawUrl(path)} alt={path} className="mx-auto block max-h-full" />
          )}
          {/* No <track>: these are whatever is on the share, and there is no
              caption file to point at. An empty one would be a lie to the
              screen reader rather than a kindness. */}
          {view === "video" && (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- see above
            <video src={rawUrl(path)} controls playsInline className="mx-auto block max-h-full" />
          )}
          {view === "audio" && (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- see above
            <audio src={rawUrl(path)} controls className="w-full p-4" />
          )}
          {view === "pdf" && (
            <iframe src={rawUrl(path)} title={path} className="h-full w-full border-0" />
          )}
          {view === "text" && failed && (
            <div className="p-4 font-mono text-[12.5px] text-wait">{failed}</div>
          )}
          {view === "text" && !failed && text === null && (
            <div className="p-4 font-mono text-[12.5px] text-faint">…</div>
          )}
          {view === "text" && !failed && text !== null && flavour === "markdown" && (
            <div className="mx-auto max-w-[72ch] p-4 text-[14px] leading-[1.7]">
              <Markdown
                components={MD}
                rehypePlugins={find.trim() ? [rehypeMark(find.trim())] : []}
              >
                {text}
              </Markdown>
            </div>
          )}
          {view === "text" && !failed && text !== null && flavour === "csv" && (
            <CsvTable text={text} find={find.trim()} />
          )}
          {view === "text" && !failed && text !== null && flavour === "code" && (
            <pre className="p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted">
              {marks(text, find.trim())}
            </pre>
          )}
          {/* Extracted prose: a measure it can be read at, in the reading
              font, at the size the rest of the app sets prose in. */}
          {view === "text" && !failed && text !== null && flavour === "prose" && (
            <div className="mx-auto max-w-[72ch] p-4 text-[14px] leading-[1.7] whitespace-pre-wrap text-text">
              {marks(text, find.trim())}
            </div>
          )}
          {view === "download" && (
            <div className="p-4 text-[13px] text-muted">
              This bench does not draw this kind of file.{" "}
              <a href={rawUrl(path)} className="text-accent hover:underline">
                Download it
              </a>{" "}
              to open it where it belongs.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
