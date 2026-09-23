import { useState } from "react";
import type { FeedItem, GmailRule } from "../../../../shared/api";
import { api, usePoll } from "../../api";
import ProposalCard from "../ProposalCard";
import SectionLabel from "../SectionLabel";
import { SkeletonList } from "../Skeleton";
import Button from "../ui/Button";
import Notice from "../ui/Notice";

/** What a rule matches and does, in one line. */
function describeRule(r: GmailRule): string {
  const when = [
    r.from && `from ${r.from}`,
    r.subject && `subject "${r.subject}"`,
    r.query && `matching ${r.query}`,
  ]
    .filter(Boolean)
    .join(", ");
  const then = [
    r.label && `label ${r.label}`,
    r.archive && "skip the inbox",
    r.markRead && "mark read",
  ]
    .filter(Boolean)
    .join(", ");
  return `${when || "everything"} → ${then || "nothing"}`;
}

/**
 * The Gmail filters, where they can be seen without asking (backlog: they were
 * chat-only).
 *
 * Removing one files the same card the assistant would, shown here to be
 * tapped, rather than a route of its own: a button that deleted outright would
 * be something any process on the pod could press as well (S-05), and the card
 * is already the one way a filter goes.
 */
export default function GmailRules() {
  const { data, error, refresh } = usePoll<GmailRule[]>("/api/mail/rules", 120_000);
  const [card, setCard] = useState<{ rule: string; item: FeedItem } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function propose(rule: GmailRule) {
    setFailed(null);
    try {
      const item = await api<FeedItem>("/api/proposals", {
        method: "POST",
        body: JSON.stringify({ action: { kind: "mail_rule_delete", id: rule.id }, quiet: true }),
      });
      setCard({ rule: rule.id, item });
    } catch (e) {
      setFailed((e as Error).message);
    }
  }

  return (
    <>
      <SectionLabel icon="rows" className="mt-10">
        Gmail filters
      </SectionLabel>
      <div className="mb-3 text-sm text-muted">
        What Gmail does to mail as it arrives. The assistant sets these up when asked; remove one
        here with a tap on the card it files.
      </div>
      {failed && (
        <Notice kind="fail" className="mb-3">
          {failed}
        </Notice>
      )}
      {/* Most often "Gmail is not signed in", which the section above is for. */}
      {error && !data && <div className="text-[13px] text-faint">{error}</div>}
      {!data && !error ? (
        <SkeletonList count={2} className="h-10 rounded-lg bg-surface" />
      ) : data?.length === 0 ? (
        <div className="text-[13px] text-faint">No filters.</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {data?.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-surface px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[13px] break-words">{describeRule(r)}</span>
                {card?.rule !== r.id && (
                  <Button size="xs" variant="ghost-danger" onClick={() => void propose(r)}>
                    remove
                  </Button>
                )}
              </div>
              {card?.rule === r.id && (
                <div className="mt-2">
                  <ProposalCard
                    item={card.item}
                    onChange={() => {
                      setCard(null);
                      refresh();
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
