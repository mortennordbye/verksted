import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { DocEntry, DocHit } from "../../../shared/api";
import { agoLabel, usePoll } from "../api";
import DocViewer from "../components/DocViewer";
import TopBar from "../components/TopBar";
import { useUrlOverlay } from "../useUrlOverlay";
import PageHeader from "../components/PageHeader";
import { SkeletonList } from "../components/Skeleton";
import { Input } from "../components/ui/Field";
import Icon from "../components/Icon";

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
  // a folder is a link somebody can be sent. So is the open document.
  const [params, setParams] = useSearchParams();
  const dir = params.get("path") ?? "";
  const [query, setQuery] = useState("");
  /**
   * What is actually searched, a beat after the typing stops.
   *
   * The query was the poll's path, so every keystroke was a request — and each
   * one is a full-text search of the whole share on the pod, for a prefix
   * nobody meant to search for.
   */
  const [search, setSearch] = useState("");
  useEffect(() => {
    const trimmed = query.trim();
    const timer = setTimeout(() => setSearch(trimmed), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const viewer = useUrlOverlay(["doc"]);
  const open = viewer.values.doc;
  const setOpen = (path: string) => viewer.show({ doc: path });

  const { data: entries, error } = usePoll<DocEntry[]>(
    `/api/docs?path=${encodeURIComponent(dir)}`,
    60_000,
  );
  const { data: hits } = usePoll<DocHit[]>(
    search.length >= 2 ? `/api/docs/search?q=${encodeURIComponent(search)}` : null,
    60_000,
  );

  const parts = dir ? dir.split("/") : [];
  const go = (path: string) => setParams(path ? { path } : {}, { replace: false });

  return (
    <>
      <TopBar back="/" crumb={[{ label: "documents" }]} />
      <main className="mx-auto max-w-[860px] px-[18px] pt-[22px] pb-[60px]">
        <PageHeader
          icon="document"
          label="Documents"
          title="The share"
          sub="The share on the NAS, mounted read-only. Nothing here can change it."
        />

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search the text of every document…"

          label="search the documents"
          size="lg"
          className="mb-5 w-full"
        />

        {error && (
          <div className="mb-4 text-[12.5px] text-wait">
            {/* 503 is the honest case: no share is mounted at DOCS_DIR. */}
            {error}
          </div>
        )}

        {search.length >= 2 ? (
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
              {entries === null && !error && (
                <SkeletonList
                  count={4}
                  gap="gap-0"
                  className="h-[42px] border-b border-line bg-surface last:border-b-0"
                />
              )}
              {entries?.length === 0 && (
                <div className="bg-surface px-[15px] py-3 text-[13px] text-faint">empty</div>
              )}
              {(entries ?? []).map((e) => (
                <button
                  key={e.path}
                  onClick={() => (e.dir ? go(e.path) : setOpen(e.path))}
                  className="tap flex w-full items-center gap-3 border-b border-line bg-surface px-[15px] py-2.5 text-left last:border-b-0 hover:bg-surface-2"
                >
                  <Icon name={e.dir ? "folder" : "document"} size={14} className="text-faint" />
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
        <DocViewer
          path={open}
          initialFind={query.trim().length >= 2 ? query.trim() : ""}
          onClose={viewer.hide}
        />
      )}
    </>
  );
}
