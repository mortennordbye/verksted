import { OFFLINE_MESSAGE } from "../api";

/**
 * A GET that failed, said on the screen that asked for it.
 *
 * Of the forty-odd `usePoll` call sites outside the chat, two read `error`. So
 * a pod answering 500 for the project list looked exactly like a bench with no
 * projects on it, and the only way to tell was to open a network tab — on a
 * phone, over a tunnel. An empty list is a fact about the pod; a failed read is
 * a fact about the request, and they should not look the same.
 *
 * Silent when nothing answered at all: the connection banner is already on
 * screen saying so, and one interruption per outage is enough.
 */
export default function PollError({
  error,
  what,
  retry,
}: {
  error: string | null;
  /** What could not be read, as the sentence needs it: "the projects". */
  what: string;
  retry: () => void;
}) {
  if (!error || error === OFFLINE_MESSAGE) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-2.5 rounded-lg border border-fail/40 bg-fail/5 px-3 py-2 text-[12.5px] text-fail"
    >
      <span className="min-w-0 flex-1">
        could not read {what} — {error}
      </span>
      <button
        onClick={retry}
        className="tap flex-none rounded-[7px] border border-fail/50 px-2.5 py-1 hover:bg-fail/10"
      >
        try again
      </button>
    </div>
  );
}
