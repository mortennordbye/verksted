import { useState } from "react";
import type { ReplaceResult, SearchHit } from "../../../shared/api";
import { api } from "../api";
import { fileIcon } from "../fileicons";

function Toggle({
  glyph,
  title,
  on,
  onClick,
}: {
  glyph: string;
  title: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded px-1 text-[11px] ${
        on ? "bg-surface text-accent outline outline-accent/50" : "text-faint hover:text-text"
      }`}
    >
      {glyph}
    </button>
  );
}

export default function SearchPanel({
  project,
  onOpenFile,
}: {
  project: string;
  onOpenFile: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [replace, setReplace] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function flagParams(flags: { case: boolean; word: boolean; regex: boolean }) {
    const p = new URLSearchParams();
    if (flags.case) p.set("case", "true");
    if (flags.word) p.set("word", "true");
    if (flags.regex) p.set("regex", "true");
    return p;
  }

  async function run(flags = { case: caseSensitive, word: wholeWord, regex: useRegex }) {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const p = flagParams(flags);
      p.set("q", query);
      setHits(await api<SearchHit[]>(`/api/projects/${project}/search?${p}`));
    } catch (e) {
      setError((e as Error).message);
      setHits(null);
    } finally {
      setBusy(false);
    }
  }

  /** Toggles re-run the current search so results always match the flags. */
  function toggle(set: (v: boolean) => void, key: "case" | "word" | "regex", value: boolean) {
    set(value);
    if (hits !== null) {
      run({ case: caseSensitive, word: wholeWord, regex: useRegex, [key]: value });
    }
  }

  async function replaceAll() {
    const query = q.trim();
    if (!query || busy) return;
    if (!confirm(`Replace all matches of "${query}" with "${replace}" across the repo?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ReplaceResult>(`/api/projects/${project}/replace`, {
        method: "POST",
        body: JSON.stringify({
          q: query,
          replace,
          case: caseSensitive,
          word: wholeWord,
          regex: useRegex,
        }),
      });
      setNote(
        `replaced ${res.replacements} occurrence${res.replacements === 1 ? "" : "s"} in ${res.files} file${res.files === 1 ? "" : "s"}`,
      );
      setHits(null);
    } catch (e) {
      setError((e as Error).message);
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

  const inputCls =
    "flex items-center gap-1 rounded-[7px] border border-line bg-surface-2 px-2 py-1.5 focus-within:border-accent";

  return (
    <nav className="max-h-[calc(100dvh-240px)] overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]">
      <div className="px-2.5 pb-2.5 text-[11px] tracking-widest text-faint uppercase">search</div>
      <div className="flex gap-1 px-2.5 pb-2">
        <button
          onClick={() => setShowReplace((s) => !s)}
          title="toggle replace"
          className="flex-none self-stretch rounded px-0.5 text-faint hover:text-text"
        >
          {showReplace ? "▾" : "▸"}
        </button>
        <div className="min-w-0 flex-1">
          <div className={inputCls}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder="search (enter)"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
            />
            <Toggle
              glyph="Aa"
              title="match case"
              on={caseSensitive}
              onClick={() => toggle(setCaseSensitive, "case", !caseSensitive)}
            />
            <Toggle
              glyph="ab"
              title="match whole word"
              on={wholeWord}
              onClick={() => toggle(setWholeWord, "word", !wholeWord)}
            />
            <Toggle
              glyph=".*"
              title="use regular expression"
              on={useRegex}
              onClick={() => toggle(setUseRegex, "regex", !useRegex)}
            />
          </div>
          {showReplace && (
            <div className={`mt-1 ${inputCls}`}>
              <input
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && replaceAll()}
                placeholder="replace"
                className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
              />
              <button
                onClick={replaceAll}
                disabled={busy || !q.trim()}
                title="replace all"
                className="rounded px-1 text-[11px] text-faint hover:text-text disabled:opacity-50"
              >
                ⇄ all
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <div className="px-2.5 text-[11px] text-wait">{error}</div>}
      {note && <div className="px-2.5 text-[11px] text-run">{note}</div>}
      {busy && <div className="px-2.5 text-faint">working…</div>}
      {hits !== null && !busy && (
        <div className="px-2.5 pb-1 text-[11px] text-faint">
          {hits.length === 0
            ? "no results"
            : `${hits.length >= 300 ? "300+" : hits.length} result${hits.length === 1 ? "" : "s"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"}`}
        </div>
      )}
      {[...byFile.entries()].map(([path, fileHits]) => {
        const name = path.split("/").at(-1)!;
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        return (
          <div key={path} className="mb-1">
            <button
              onClick={() => onOpenFile(path)}
              className="flex w-full items-center gap-[7px] whitespace-nowrap rounded-md px-2.5 py-1 text-left text-text hover:bg-surface-2"
            >
              <img src={fileIcon(name)} alt="" className="h-4 w-4 flex-none" />
              <span>{name}</span>
              {dir && <span className="min-w-0 truncate text-[11px] text-faint">{dir}</span>}
              <span className="ml-auto rounded-full bg-surface-2 px-1.5 py-px text-[10px] text-muted">
                {fileHits.length}
              </span>
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
