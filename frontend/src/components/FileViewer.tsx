import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { FileContent, FileDiff, SessionFileDiff } from "../../../shared/api";
import { api } from "../api";
import { diffLineClass } from "../diff";
import { fileIcon } from "../fileicons";
import { highlight } from "../highlight";
import { lineRange } from "../lineRange";
import { useConfirm } from "../useConfirm";
import { SkeletonLines } from "./Skeleton";
import Overlay, { OverlayHeader } from "./ui/Overlay";
import Icon from "./Icon";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);

/**
 * What the viewer is asked to show, as the session screen's URL carries it:
 * `?file=<path>`, plus `&diff=work|staged|range` for a diff and `&line=<n>` for
 * a search hit.
 */
export interface FileTarget {
  path: string;
  /** The working tree's diff, the index's, or the session's own commit range. */
  diff?: "work" | "staged" | "range";
  /**
   * The line to open on, 1-based. A search hit used to open its file at the
   * top, and the one line you tapped was somewhere in a few hundred (F-36).
   */
  line?: number;
}

const keyOf = (t: FileTarget | null) => (t ? `${t.diff ?? "file"}:${t.path}` : "");

interface Viewed {
  path: string;
  content: string;
  kind: "text" | "diff" | "image";
  /**
   * The version read off disk, for If-Match on save. Absent on a diff, an
   * image, and on the placeholder shown when the read itself failed — which is
   * also what says whether this file can be edited.
   */
  etag?: string;
}

/** Read what a target names off the pod. A failure is shown in the viewer. */
async function load(project: string, sessionId: string, t: FileTarget): Promise<Viewed> {
  const q = `path=${encodeURIComponent(t.path)}`;
  try {
    if (t.diff === "range") {
      const d = await api<SessionFileDiff>(`/api/sessions/${sessionId}/changes/diff?${q}`);
      const content = d.diff
        ? d.diff + (d.truncated ? "\n— too long, the rest is in the terminal —" : "")
        : "— no changes —";
      return { path: t.path, content, kind: "diff" };
    }
    if (t.diff) {
      const staged = t.diff === "staged" ? "&staged=true" : "";
      const d = await api<FileDiff>(
        `/api/projects/${encodeURIComponent(project)}/diff?${q}${staged}`,
      );
      return { path: t.path, content: d.diff || "— no changes —", kind: "diff" };
    }
    if (IMAGE_EXTS.has(t.path.split(".").at(-1)!.toLowerCase())) {
      return { path: t.path, content: "", kind: "image" };
    }
    const f = await api<FileContent>(`/api/projects/${encodeURIComponent(project)}/file?${q}`);
    return { ...f, kind: "text" };
  } catch (e) {
    return { path: t.path, content: `— ${(e as Error).message} —`, kind: t.diff ? "diff" : "text" };
  }
}

/**
 * The session's file viewer: a file read, highlighted and edited in place, or
 * a diff, over the terminal.
 *
 * Rendered always and shown while `target` names something. What it is showing
 * outlives `target` in one case: Back pressed over an unsaved edit. The URL has
 * already moved by then, so the viewer steps forward onto its own entry again
 * and asks, the way the close button does, before anything typed is lost.
 */
export default function FileViewer({
  project,
  sessionId,
  target,
  onClose,
}: {
  project: string;
  sessionId: string;
  target: FileTarget | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [shown, setShown] = useState<FileTarget | null>(target);
  const [file, setFile] = useState<Viewed | null>(null);
  /**
   * The draft, when the file is open for editing. Null is reading.
   *
   * The backend has been able to take a save since the file viewer was written
   * — GET /file returns an etag and PUT takes it as If-Match, which is the
   * whole of what a shared working tree needs — and nothing ever sent one. So
   * a typo in a config the agent is about to read meant opening a terminal.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const dirty = draft !== null && draft !== file?.content;

  // A new target is a new file: whatever was being edited is not this one. A
  // target gone is the viewer closing, unless there is an edit to ask about.
  if (keyOf(target) !== keyOf(shown) && (target !== null || !dirty)) {
    setShown(target);
    setFile(null);
    setDraft(null);
    setSaveError(null);
  }

  useEffect(() => {
    if (!shown) return;
    let live = true;
    void load(project, sessionId, shown).then((f) => live && setFile(f));
    return () => {
      live = false;
    };
    // The line is not a reason to read the file again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, sessionId, shown?.path, shown?.diff]);

  // One question at a time: a second way out taken while the first is still
  // asking (a click away, then Escape before the confirm is listening) would
  // replace the confirm's promise and leave the first one never answered.
  const closing = useRef(false);
  async function close() {
    if (closing.current) return;
    closing.current = true;
    try {
      await ask();
    } finally {
      closing.current = false;
    }
  }
  async function ask() {
    if (dirty) {
      const ok = await confirm({
        title: "Discard the changes to this file?",
        body: "They have not been saved, and the agent will not see them.",
        action: "discard them",
        danger: true,
      });
      if (!ok) return;
      setDraft(null);
    }
    onClose();
  }

  // Back over an unsaved edit: the entry Back popped is still one step ahead,
  // so go forward onto it, and ask once it is the URL again. Not before: the
  // confirm pushes an entry of its own, and that has to land on top of the
  // file's entry rather than wipe it out of the forward history.
  const asking = useRef(false);
  useEffect(() => {
    if (target === null && shown !== null && dirty && !asking.current) {
      asking.current = true;
      void navigate(1);
    } else if (target !== null && asking.current) {
      asking.current = false;
      void close();
    }
  });

  /**
   * Write the draft back, and refuse to if the file moved under it.
   *
   * The agent is editing the same tree from the other pane, so a blind
   * overwrite is a real way to lose its work — hence the etag, and hence a 412
   * that says to reopen rather than offering to force it.
   */
  async function save() {
    if (!file || draft === null || file.etag === undefined) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api<{ etag: string }>(
        `/api/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(file.path)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "if-match": file.etag },
          body: draft,
        },
      );
      setFile({ ...file, content: draft, etag: saved.etag });
      setDraft(null);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * The open file as highlighted HTML, once highlight.js has been fetched.
   *
   * Null until then, which is the same thing it says for a language nothing
   * knows — so the file is on screen as plain text from the first paint and
   * gains its colours a moment later, instead of waiting for a third of a
   * megabyte of grammars.
   */
  const [done, setDone] = useState<{ of: string; html: string } | null>(null);
  useEffect(() => {
    if (!file || file.kind !== "text") return;
    let live = true;
    void highlight(file.path, file.content).then((html) => {
      if (live && html !== null) setDone({ of: file.content, html });
    });
    return () => {
      live = false;
    };
  }, [file]);
  // What was highlighted is only worth drawing over the text it was made from:
  // the next file opens with the one before it still in state.
  const highlighted = done && done.of === file?.content ? done.html : null;

  /**
   * Open on the line a search hit named: scrolled a third of the way down the
   * viewer, and marked where the browser can mark a range without touching
   * the markup (the CSS highlight API). Run again when the highlighted HTML
   * replaces the plain text, which is a different element drawing the same
   * lines.
   */
  const line = shown?.line;
  const textRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const pre = textRef.current;
    if (!pre || !line) return;
    const range = lineRange(pre, line);
    if (!range) return;
    const box = pre.getBoundingClientRect();
    pre.scrollTop += range.getBoundingClientRect().top - box.top - box.height / 3;
    if (!("highlights" in CSS)) return;
    CSS.highlights.set("vk-line", new Highlight(range));
    return () => void CSS.highlights.delete("vk-line");
  }, [file, highlighted, line]);

  if (!shown) return confirmDialog;
  const path = shown.path;
  const raw = `/api/projects/${encodeURIComponent(project)}/raw?path=${encodeURIComponent(path)}`;

  return (
    <>
      <Overlay
        label={path}
        // Every way out goes through close, which asks before throwing away
        // an unsaved edit. The backdrop used to drop the file outright, so a
        // mistimed tap next to the dialog lost whatever had been typed into it.
        onClose={() => void close()}
        routed
        className="h-[85dvh] w-full max-w-[860px] overflow-hidden rounded-xl"
      >
        <OverlayHeader
          title={
            <>
              <img src={fileIcon(path.split("/").at(-1)!)} alt="" className="h-4 w-4 flex-none" />
              <span className="min-w-0 truncate">{path}</span>
              {shown.diff && <span className="flex-none text-[10px] text-faint">diff</span>}
            </>
          }
          onClose={() => void close()}
        >
          {!shown.diff && (
            <a
              href={`${raw}&download=1`}
              title="download"
              aria-label="download"
              className="tap-sq flex flex-none items-center justify-center px-2 text-faint hover:text-text"
            >
              <Icon name="download" size={15} />
            </a>
          )}
          {/* Only a file actually read off disk can be written back: a diff, an
              image and a failed read all have no etag. */}
          {file?.kind === "text" &&
            file.etag !== undefined &&
            (draft === null ? (
              <button
                onClick={() => setDraft(file.content)}
                className="tap flex flex-none items-center px-2 text-faint hover:text-text"
              >
                edit
              </button>
            ) : (
              <>
                <button
                  onClick={() => void save()}
                  disabled={saving || draft === file.content}
                  className="tap flex flex-none items-center px-2 text-accent hover:brightness-110 disabled:opacity-40"
                >
                  {saving ? "saving…" : "save"}
                </button>
                <button
                  onClick={() => {
                    setDraft(null);
                    setSaveError(null);
                  }}
                  className="tap flex flex-none items-center px-2 text-faint hover:text-text"
                >
                  cancel
                </button>
              </>
            ))}
        </OverlayHeader>
        {saveError && (
          <div className="border-b border-line px-3.5 py-2 text-[12.5px] text-wait">
            {saveError}
          </div>
        )}
        {file === null ? (
          <SkeletonLines count={8} className="p-4" />
        ) : draft !== null ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label={`${path} (editing)`}
            className="flex-1 resize-none bg-term p-4 font-mono scheme-dark text-[12.5px] leading-relaxed text-text outline-none"
          />
        ) : file.kind === "image" ? (
          <div className="flex flex-1 items-center justify-center overflow-auto bg-term p-4 scheme-dark">
            <img src={raw} alt={path} className="max-h-full max-w-full" />
          </div>
        ) : file.kind === "diff" ? (
          <pre className="flex-1 overflow-auto bg-surface p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap scheme-dark">
            {file.content.split("\n").map((l, i) => (
              <div key={i} className={diffLineClass(l)}>
                {l || " "}
              </div>
            ))}
          </pre>
        ) : highlighted !== null ? (
          <pre
            ref={textRef}
            className="flex-1 overflow-auto bg-surface p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap scheme-dark"
          >
            <code
              className="hljs !bg-transparent"
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          </pre>
        ) : (
          <pre
            ref={textRef}
            className="flex-1 overflow-auto bg-surface p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-text scheme-dark"
          >
            {file.content}
          </pre>
        )}
      </Overlay>
      {confirmDialog}
    </>
  );
}
