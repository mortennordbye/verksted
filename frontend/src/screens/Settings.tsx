import { useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type { Settings as SettingsInfo, SettingVar } from "../../../shared/api";
import { api, usePoll } from "../api";
import { copyText } from "../clipboard";
import { useConfirm } from "../useConfirm";
import TopBar from "../components/TopBar";
import PageHeader from "../components/PageHeader";
import Icon from "../components/Icon";
import SectionLabel from "../components/SectionLabel";
import SegTabs from "../components/ui/SegTabs";
import AssistantPanel from "../components/AssistantPanel";
import ProfilePanel from "../components/ProfilePanel";
import CouncilPanel from "../components/CouncilPanel";
import MemoryPanel from "../components/MemoryPanel";
import SchedulesPanel from "../components/SchedulesPanel";
import { StatusChip } from "../components/StatusChip";
import { SkeletonList } from "../components/Skeleton";
import Button from "../components/ui/Button";
import { Input } from "../components/ui/Field";
import Notice from "../components/ui/Notice";
import { toast } from "../components/ui/Toast";
import GoogleCalendar from "../components/settings/GoogleCalendar";
import Notifications from "../components/settings/Notifications";
import Backups from "../components/settings/Backups";
import AppReset from "../components/settings/AppReset";
import Appearance from "../components/settings/Appearance";
import SshKeys from "../components/settings/SshKeys";
import BlockedOwners from "../components/settings/BlockedOwners";
import GmailRules from "../components/settings/GmailRules";
import ToolLog from "../components/settings/ToolLog";

function sourceChip(source: SettingVar["source"]) {
  if (source === "env") return <StatusChip kind="run" label="env" />;
  if (source === "settings") return <StatusChip kind="wait" label="settings" />;
  return <StatusChip kind="idle" label="unset" />;
}

/**
 * The screen's sections, as five groups rather than one column.
 *
 * Everything the pod does on your behalf ends up here, and it had grown to a
 * page you scroll past four panels to reach the fifth — on a phone, where the
 * thing you came for is usually one field. Grouped by what you are changing,
 * with the group in the query so a tab survives a reload and can be linked to.
 *
 * `hash` keeps the deep links that already exist working: Today points at
 * /settings#profile, and that has to land on the profile editor rather than on
 * whichever group happens to be first.
 */
const GROUPS = [
  { key: "assistant", label: "Assistant", icon: "chat", hash: ["profile", "council", "memory"] },
  { key: "runs", label: "Runs", icon: "history", hash: ["schedules", "notifications"] },
  { key: "sources", label: "Sources", icon: "sources", hash: [] },
  { key: "agents", label: "Agents", icon: "key", hash: ["env", "ssh"] },
  { key: "bench", label: "Bench", icon: "disk", hash: ["backups"] },
] as const;

type GroupKey = (typeof GROUPS)[number]["key"];

export default function Settings() {
  const { data, refresh } = usePoll<SettingsInfo>("/api/settings", 30_000);
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  // The hash wins on arrival, since it is what an old link carries; after that
  // the query is the truth, because tapping a tab writes it.
  const fromHash = GROUPS.find((g) => (g.hash as readonly string[]).includes(hash.slice(1)))?.key;
  const tab = (params.get("tab") ?? fromHash ?? "assistant") as GroupKey;
  const show = (key: GroupKey) => tab === key;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  /**
   * F-30. One tap, and the value was gone: the pod keeps it nowhere else, so
   * putting it back meant finding it again wherever it came from — a token
   * page, a password manager, a colleague.
   */
  async function clear(name: string) {
    const ok = await confirm({
      title: `Remove ${name}?`,
      body: "The pod keeps no other copy. Sessions started from now on go without it, and the ones already running keep what they started with.",
      action: "remove it",
      danger: true,
    });
    if (ok) await save({ [name]: null });
  }

  /** Whether it was stored. A failed save must not take the field with it. */
  async function save(vars: Record<string, string | null>): Promise<boolean> {
    setError(null);
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ vars }) });
      refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function saveDraft(key: string) {
    const value = drafts[key]?.trim();
    if (!value) return;
    // Cleared on success only. These fields are pasted API keys and tokens,
    // which is the worst thing in the app to have to go and find twice: a save
    // that timed out used to empty the box and leave an error above it.
    if (await save({ [key]: value })) setDrafts((d) => ({ ...d, [key]: "" }));
  }

  async function addVar() {
    const key = newKey.trim();
    if (!key) return;
    if (await save({ [key]: drafts[key]?.trim() || null })) setNewKey("");
  }

  return (
    <>
      <TopBar back="/" crumb={[{ label: "settings" }]} />
      <main className="mx-auto max-w-[760px] px-[18px] pt-[22px] pb-[60px]">
        <PageHeader
          icon="settings"
          label="Settings"
          title="Your bench"
          sub="What the pod runs on your behalf, how it reaches you, and what the agents are given."
        />
        {/* Scrolls sideways rather than wrapping: five labels do not fit a
            phone, and a strip that wraps to two lines pushes the content down
            by exactly the height it was meant to save. */}
        <nav aria-label="settings sections" className="mb-7">
          <SegTabs
            label="settings section"
            value={tab}
            onChange={(next) => setParams({ tab: next }, { replace: true })}
            items={GROUPS.map((g) => ({
              value: g.key,
              content: (
                <>
                  <Icon name={g.icon} size={14} />
                  {g.label}
                </>
              ),
            }))}
            className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          />
        </nav>

        {show("runs") && <SchedulesPanel />}
        {show("runs") && <Notifications />}
        {show("assistant") && <AssistantPanel />}
        {show("assistant") && <ProfilePanel />}
        {show("assistant") && <CouncilPanel />}
        {show("assistant") && <MemoryPanel />}
        {show("assistant") && <ToolLog />}
        {show("sources") && <GoogleCalendar />}
        {show("sources") && <BlockedOwners owners={data?.blockedOwners ?? []} refresh={refresh} />}
        {show("sources") && <GmailRules />}
        {show("agents") && (
          <>
            <SectionLabel icon="key" className="mt-10">
              Environment
            </SectionLabel>
            <div className="mb-6 text-sm text-muted">
              Variables reach the agent CLIs inside new tmux sessions. Each shows where it is
              defined and enough of its value to recognise it; copy hands you the whole thing
              without putting it on the screen.
            </div>

            {error && (
              <Notice kind="fail" className="mb-3">
                {error}
              </Notice>
            )}

            <SectionLabel icon="chip" sub>
              Server · from the deployment (read-only)
            </SectionLabel>
            <div className="mb-7 overflow-hidden rounded-xl border border-line">
              {!data && (
                <SkeletonList
                  count={3}
                  gap="gap-0"
                  className="h-[42px] border-b border-line bg-surface last:border-b-0"
                />
              )}
              {Object.entries(data?.server ?? {}).map(([key, value]) => (
                <div
                  key={key}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-[15px] py-2.5 font-mono text-[12.5px] last:border-b-0"
                >
                  <span className="break-all text-text">{key}</span>
                  <span className="ml-auto break-all text-muted">{value}</span>
                </div>
              ))}
            </div>

            <SectionLabel icon="key" sub>
              Agent environment
            </SectionLabel>
            <div className="flex flex-col gap-2">
              {!data && (
                <SkeletonList
                  count={3}
                  className="h-[54px] rounded-[11px] border border-line bg-surface"
                />
              )}
              {(data?.vars ?? []).map((v) => (
                <div
                  key={v.key}
                  className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5"
                >
                  <span className="font-mono text-[12.5px]">{v.key}</span>
                  {sourceChip(v.source)}
                  {v.fingerprint && (
                    <span className="font-mono text-[11.5px] text-faint">{v.fingerprint}</span>
                  )}
                  {v.copyable && <CopyVar keyName={v.key} />}
                  <Input
                    label={`new value for ${v.key}`}
                    mono
                    value={drafts[v.key] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [v.key]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && saveDraft(v.key)}
                    placeholder={
                      v.source === "unset" ? "enter value…" : "enter new value to replace…"
                    }
                    className="min-w-[160px] flex-1"
                  />
                  {drafts[v.key]?.trim() && (
                    <Button onClick={() => saveDraft(v.key)} variant="primary">
                      save
                    </Button>
                  )}
                  {v.source === "settings" && (
                    <Button
                      onClick={() => void clear(v.key)}
                      title="remove the stored value"
                      variant="ghost-danger"
                    >
                      clear
                    </Button>
                  )}
                </div>
              ))}

              <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
                <Input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && addVar()}
                  placeholder="NEW_VARIABLE"

                  label="new variable name"
                  mono
                  className="w-[200px]"
                />
                <Input
                  value={drafts[newKey.trim()] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [newKey.trim()]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && addVar()}
                  placeholder="value"

                  label="value for the new variable"
                  mono
                  className="min-w-[160px] flex-1"
                />
                <Button
                  onClick={addVar}
                  disabled={!newKey.trim() || !drafts[newKey.trim()]?.trim()}
                  variant="primary"
                >
                  add
                </Button>
              </div>
            </div>

            <div className="mt-5 text-[13px] text-muted">
              Settings-page values persist on the data volume and take precedence over deployment
              env vars. Changes apply to sessions started afterwards.
            </div>
            <SshKeys />
          </>
        )}
        {show("bench") && (
          <>
            <Backups />
            <Appearance />
            <AppReset />
          </>
        )}
      </main>
      {confirmDialog}
    </>
  );
}

/**
 * The whole value of one variable, to the clipboard and nowhere else.
 *
 * Fetched only when tapped, and never rendered: the point of showing a
 * fingerprint on the row is that a live credential is not sitting on a screen
 * to be photographed or shoulder-read, and printing it here on the way to the
 * clipboard would give that back.
 */
function CopyVar({ keyName }: { keyName: string }) {
  return (
    <Button
      onClick={async () => {
        try {
          const { value } = await api<{ value: string }>(
            `/api/settings/vars/${encodeURIComponent(keyName)}/reveal`,
            { method: "POST" },
          );
          toast((await copyText(value)) ? `${keyName} copied` : "could not copy");
        } catch (e) {
          toast((e as Error).message);
        }
      }}
      title="copy the value to the clipboard"
    >
      copy
    </Button>
  );
}
