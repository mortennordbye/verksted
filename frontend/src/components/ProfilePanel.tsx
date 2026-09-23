import { useState } from "react";
import type { Profile } from "../../../shared/api";
import { api, usePoll } from "../api";
import SectionLabel from "./SectionLabel";
import Skeleton from "./Skeleton";
import Button from "./ui/Button";
import { Textarea } from "./ui/Field";
import Notice from "./ui/Notice";
import { toast } from "./ui/Toast";

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
  const { data, fresh, refresh } = usePoll<Profile>("/api/profile", 60_000);
  const [draft, setDraft] = useState<string | null>(null);
  /** The server's text the draft started from, sent with the save (C-11). */
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The server's text until the first keystroke, then the draft: a poll
  // landing mid-sentence must not overwrite what is being typed. A line the
  // assistant adds while this is open is not lost either: the save names the
  // text it started from, and the server refuses it if that has changed.
  const shown = draft ?? data?.text ?? "";

  async function save() {
    if (draft === null) return;
    setError(null);
    try {
      await api<Profile>("/api/profile", {
        method: "PUT",
        body: JSON.stringify({ text: draft, ...(base !== null ? { base } : {}) }),
      });
      setDraft(null);
      setBase(null);
      refresh();
      toast("saved");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** After a refused save: the server's text again, and the draft gone. */
  function reload() {
    setDraft(null);
    setBase(null);
    setError(null);
    refresh();
  }

  const used = new TextEncoder().encode(shown).length;
  const budget = data?.budget ?? 8192;

  return (
    <section id="profile" className="mt-8 scroll-mt-20">
      <SectionLabel icon="user">Profile</SectionLabel>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">Who it works for</h2>
      <div className="mb-3 text-sm text-muted">
        What a new assistant would be told on its first day. Read in full at the start of every
        conversation, so it never has to be told twice; the assistant adds a line here when you tell
        it something about yourself.
      </div>
      <div className="flex flex-col gap-2 rounded-[11px] border border-line bg-surface px-[15px] py-3">
        {/* Not an empty textarea while it loads: that showed the hint, which
            reads as "nothing written yet" and invites typing over the real text. */}
        {/* Nor an editable one before a fresh answer: the first paint is last
            visit's text from the cache, and a draft started from it would
            save over whatever has been added since (C-11). */}
        {(data === null || !fresh) && draft === null ? (
          <Skeleton className="block h-[214px] rounded-[7px] border border-line bg-surface-2" />
        ) : (
          <Textarea
            value={shown}
            onChange={(e) => {
              if (draft === null) setBase(data?.text ?? "");
              setDraft(e.target.value);
            }}
            rows={10}

            placeholder={HINT}
            label="profile"
            className="w-full"
          />
        )}
        <div className="flex items-center gap-3">
          <Button
            onClick={() => void save()}
            disabled={draft === null || used > budget}
            variant="primary"
          >
            save
          </Button>
          {error && (
            <Notice kind="fail" small>
              {error}
            </Notice>
          )}
          {error && draft !== null && (
            <Button onClick={reload} variant="ghost">
              discard mine and reload
            </Button>
          )}
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
