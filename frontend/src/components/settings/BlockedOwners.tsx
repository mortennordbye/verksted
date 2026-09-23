import { useState } from "react";
import { api } from "../../api";
import { useConfirm } from "../../useConfirm";
import Icon from "../Icon";
import SectionLabel from "../SectionLabel";
import Button from "../ui/Button";
import { Input } from "../ui/Field";
import Notice from "../ui/Notice";

/**
 * GitHub owners this bench does not read: an employer's, a customer's.
 *
 * The inbox is one account's notifications, and that account is at work as
 * well as at home. An owner listed here never becomes an item, so its
 * repository names and branch titles never reach the volume or a model turn;
 * saving the list also deletes what it filed before.
 */
export default function BlockedOwners({
  owners,
  refresh,
}: {
  owners: string[];
  refresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  async function save(next: string[]): Promise<boolean> {
    setError(null);
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ blockedOwners: next }) });
      refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function add() {
    const owner = draft.trim();
    if (!owner) return;
    // Saving deletes what the owner already filed. The row's × lets the next
    // poll file it again if GitHub still lists it, but as new: what was done
    // or snoozed, and how it was sorted, went with the delete.
    const ok = await confirm({
      title: `Stop reading ${owner}?`,
      body: `Everything in the inbox from ${owner} is deleted now, with whatever you had marked done or snoozed, and nothing from it is filed again until you remove it here.`,
      action: "stop reading it",
      danger: true,
    });
    if (!ok) return;
    if (await save([...owners, owner])) setDraft("");
  }

  return (
    <>
      <SectionLabel icon="hide" className="mt-10">
        Not mine to read
      </SectionLabel>
      <div className="mb-3 text-sm text-muted">
        GitHub owners the inbox skips entirely. Nothing from them is filed, triaged, pushed or
        shown, and saving removes what was filed before.
      </div>
      {error && (
        <Notice kind="fail" className="mb-3">
          {error}
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {owners.map((owner) => (
          <span
            key={owner}
            className="flex items-center gap-2 rounded-[11px] border border-line bg-surface px-[13px] py-2 font-mono text-[12.5px]"
          >
            {owner}
            <button
              onClick={() => save(owners.filter((o) => o !== owner))}
              title="read this owner again"
              aria-label={`read ${owner} again`}
              className="tap-sq flex items-center justify-center text-muted hover:text-fail"
            >
              <Icon name="close" size={13} />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2.5 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="owner-or-org"

          label="GitHub owner to skip"
          mono
          className="min-w-[160px] flex-1"
        />
        <Button onClick={add} disabled={!draft.trim()} variant="primary">
          add
        </Button>
      </div>
      {confirmDialog}
    </>
  );
}
