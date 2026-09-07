import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { api } from "../api";
import { parseCsv } from "../csv";
import { marks, rehypeMark } from "../find";
import { useOverlayDismiss } from "../useDismissOnBack";
import { MD, REMARK } from "./chat/markdown";

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
export default function DocViewer({
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
            className="tap ml-auto flex flex-none items-center px-2 text-faint hover:text-text"
          >
            open
          </a>
          {/* 18px glyphs, and one of them the way out of a full-screen overlay
              on a phone. `tap-sq` is what the rest of the app gives an icon
              with no label of its own. */}
          <button
            onClick={onClose}
            aria-label="close"
            className="tap-sq flex flex-none items-center justify-center px-2 text-faint hover:text-text"
          >
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
                remarkPlugins={REMARK}
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
