import { useState } from "react";
import type { SearchHit } from "../../../shared/api";
import { api } from "../api";
import { fileIcon } from "../fileicons";

export default function SearchPanel({
  project,
  onOpenFile,
}: {
  project: string;
  onOpenFile: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setError(null);
    try {
      setHits(await api<SearchHit[]>(`/api/projects/${project}/search?q=${encodeURIComponent(query)}`));
    } catch (e) {
      setError((e as Error).message);
      setHits(null);
    } finally {
      setBusy(false);
    }
  }

  const byFile = new Map<string, SearchHit[]>();
  for (const h of hits ?? []) {
    const list = byFile.get(h.path);
    if (list) list.push(h);
    else byFile.set(h.path, [h]);
  }

  return (
    <nav className="max-h-[calc(100dvh-240px)] overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]">
      <div className="px-2.5 pb-2.5 text-[11px] tracking-widest text-faint uppercase">search</div>
      <div className="px-2.5 pb-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="search (enter)"
          className="w-full rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] outline-none placeholder:text-faint focus:border-accent"
        />
      </div>
      {error && <div className="px-2.5 text-[11px] text-wait">{error}</div>}
      {busy && <div className="px-2.5 text-faint">searching…</div>}
      {hits !== null && !busy && hits.length === 0 && (
        <div className="px-2.5 text-faint">no results</div>
      )}
      {[...byFile.entries()].map(([path, fileHits]) => {
        const name = path.split("/").at(-1)!;
        return (
          <div key={path} className="mb-1">
            <button
              onClick={() => onOpenFile(path)}
              className="flex w-full items-center gap-[7px] whitespace-nowrap rounded-md px-2.5 py-1 text-left text-text hover:bg-surface-2"
            >
              <img src={fileIcon(name)} alt="" className="h-4 w-4 flex-none" />
              <span className="min-w-0 truncate">{path}</span>
              <span className="ml-auto pl-2 text-[11px] text-faint">{fileHits.length}</span>
            </button>
            <ul>
              {fileHits.map((h, i) => (
                <li key={`${h.line}-${i}`}>
                  <button
                    onClick={() => onOpenFile(path)}
                    className="flex w-full items-baseline gap-2 rounded-md px-2.5 py-0.5 text-left text-muted hover:bg-surface-2 hover:text-text"
                  >
                    <span className="w-7 flex-none text-right text-[11px] text-faint">{h.line}</span>
                    <span className="min-w-0 truncate text-[12px]">{h.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
