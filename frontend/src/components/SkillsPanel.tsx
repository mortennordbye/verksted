import { useState } from "react";
import type { Skill, SkillList } from "../../../shared/api";
import { api, usePoll } from "../api";
import { useConfirm } from "../useConfirm";
import PollError from "./PollError";
import SectionLabel from "./SectionLabel";
import { SkeletonList } from "./Skeleton";
import Button from "./ui/Button";
import Notice from "./ui/Notice";

/**
 * One skill: the line that says when it is used, and its steps behind a tap.
 * A proposal gets keep and drop instead of forget.
 */
function Row({
  skill,
  proposed,
  onDone,
}: {
  skill: Skill;
  proposed: boolean;
  onDone: (action: "keep" | "drop" | "forget") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
      <div className="flex items-start gap-2.5">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left text-[13.5px] break-words"
        >
          <span className="font-mono text-[12px] text-muted">{skill.slug}</span>
          <span className="block">{skill.description}</span>
        </button>
        {proposed ? (
          <>
            <Button onClick={() => void onDone("keep")} variant="primary" className="flex-none">
              keep
            </Button>
            <Button onClick={() => void onDone("drop")} className="flex-none">
              drop
            </Button>
          </>
        ) : (
          <Button onClick={() => void onDone("forget")} className="flex-none">
            forget
          </Button>
        )}
      </div>
      {open && (
        <pre className="mt-2 font-mono text-[12px] whitespace-pre-wrap text-muted">
          {skill.body}
        </pre>
      )}
      {skill.source && (
        <div className="mt-1.5 font-mono text-[11px] text-faint">{skill.source}</div>
      )}
    </div>
  );
}

/**
 * The procedures the assistant wrote for itself. Listed so the person can read
 * what it will do the next time, and remove a skill that is wrong.
 */
export default function SkillsPanel() {
  const { data, error: listError, refresh } = usePoll<SkillList>("/api/skills", 60_000);
  const [confirm, dialog] = useConfirm();
  const [error, setError] = useState<string | null>(null);

  async function act(skill: Skill, action: "keep" | "drop" | "forget") {
    if (action === "forget") {
      const ok = await confirm({
        title: "Forget this skill?",
        body: `"${skill.description}" This cannot be undone.`,
        action: "forget",
        danger: true,
      });
      if (!ok) return;
    }
    setError(null);
    try {
      if (action === "keep") {
        await api(`/api/skills/proposed/${skill.slug}/keep`, { method: "POST" });
      } else {
        const base = action === "drop" ? "/api/skills/proposed" : "/api/skills";
        await api(`${base}/${skill.slug}`, { method: "DELETE" });
      }
    } catch (e) {
      setError((e as Error).message);
    }
    refresh();
  }

  return (
    <section className="mt-8">
      <SectionLabel icon="rows">Skills</SectionLabel>
      <div className="mb-3 text-sm text-muted">
        Steps the assistant wrote for itself after a task that worked, and follows the next time the
        same kind of task comes. One written after it read a mail, a document or a page waits here
        until you keep it.
      </div>
      <PollError error={listError} what="the skills" retry={refresh} />
      {error && (
        <Notice kind="fail" small className="mb-2">
          {error}
        </Notice>
      )}
      <div className="flex flex-col gap-2">
        {!data && (
          <SkeletonList
            count={2}
            className="h-[58px] rounded-[11px] border border-line bg-surface"
          />
        )}
        {data?.proposals.map((s) => (
          <Row key={`p-${s.slug}`} skill={s} proposed onDone={(a) => act(s, a)} />
        ))}
        {data?.skills.map((s) => (
          <Row key={s.slug} skill={s} proposed={false} onDone={(a) => act(s, a)} />
        ))}
        {data && data.skills.length === 0 && data.proposals.length === 0 && (
          <div className="text-[13.5px] text-faint">
            No skills yet. Ask the assistant to keep how it did something, and it writes one.
          </div>
        )}
      </div>
      {dialog}
    </section>
  );
}
