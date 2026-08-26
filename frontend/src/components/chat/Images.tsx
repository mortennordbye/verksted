import type { ChatImage } from "../../../../shared/api";

/**
 * What the session looked at, or what it took a picture of.
 *
 * Two sources, one row. A file in the repo is served by the route the file
 * viewer already uses; everything else — a browser screenshot most of all —
 * only exists inside the transcript and comes from the chat's own. Either way
 * these are `<img src>`, so the bytes travel on the browser's own cache path
 * and never through the poll.
 */
export default function Images({
  images,
  sessionId,
  project,
  bytes,
}: {
  images: ChatImage[];
  sessionId: string;
  project: string;
  bytes: number;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((img, i) => {
        const src = img.path
          ? `/api/projects/${encodeURIComponent(project)}/raw?path=${encodeURIComponent(img.path)}`
          : `/api/sessions/${encodeURIComponent(sessionId)}/chat/image?ref=${encodeURIComponent(img.id)}&bytes=${bytes}`;
        return (
          <a
            key={`${img.id}-${i}`}
            href={src}
            target="_blank"
            rel="noreferrer"
            className="block max-w-full"
          >
            <img
              src={src}
              // The path when there is one, so a screen reader says which file
              // this was rather than "image".
              alt={img.path ?? "a picture the session took"}
              loading="lazy"
              className="max-h-64 max-w-full rounded-md border border-line object-contain"
            />
          </a>
        );
      })}
    </div>
  );
}
