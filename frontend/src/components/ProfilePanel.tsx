import { useState } from "react";
import type { Profile } from "../../../shared/api";
import { api, usePoll } from "../api";

/**
 * The profile: who the assistant works for, in your own words.
 *
 * A textarea over one markdown file, because the shape of a life does not fit
 * a form. It is carried in full at the top of every conversation, which is why
 * the byte count is on the page: what is written here is paid for on every
 * turn, and the budget is a number rather than an intention.
 */
const HINT = [
  "Who you are and where you live. The people who matter, how they relate to you,",
  "and their email addresses. Your accounts and repos. What recurs: rent, the car,",
  "renewals, the cluster's own dates. What always counts as urgent, and when not to",
  "be interrupted. The language you want to be written to in.",
].join(" ");

export default function ProfilePanel() {
  const { data } = usePoll<Profile>("/api/profile", 60_000);
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server's text until the first keystroke, then the draft: a poll
  // landing mid-sentence must not overwrite what is being typed. A line the
  // assistant adds while this is open lands on the next visit rather than
  // under the cursor.
  const shown = draft ?? data?.text ?? "";

  async function save() {
    if (draft === null) return;
    setError(null);
    try {
      const next = await api<Profile>("/api/profile", {
        method: "PUT",
        body: JSON.stringify({ text: draft }),
      });
      setDraft(next.text);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const used = new TextEncoder().encode(shown).length;
  const budget = data?.budget ?? 8192;

  return (
    <section id="profile" className="mt-8 scroll-mt-20">
      <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
        Profile
      </div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">Who it works for</h2>
      <div className="mb-3 text-sm text-muted">
        What a new assistant would be told on its first day. Read in full at the start of every
        conversation, so it never has to be told twice; the assistant adds a line here when you tell
        it something about yourself.
      </div>
      <div className="flex flex-col gap-2 rounded-[11px] border border-line bg-surface px-[15px] py-3">
        <textarea
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          rows={10}
          aria-label="profile"
          placeholder={HINT}
          className="w-full resize-y rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={draft === null || used > budget}
            className="tap rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            save
          </button>
          {saved && <span className="font-mono text-[11px] text-run">saved</span>}
          {error && <span className="font-mono text-[11px] text-fail">{error}</span>}
          <span
            className={`ml-auto font-mono text-[11px] ${used > budget ? "text-fail" : "text-faint"}`}
          >
            {used} of {budget} bytes, carried on every turn
          </span>
        </div>
      </div>
    </section>
  );
}
