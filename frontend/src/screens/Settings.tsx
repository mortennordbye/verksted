import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type {
  BackupStatus,
  GoogleCalendarStatus,
  PushStatus,
  PushTestResult,
  Settings as SettingsInfo,
  SettingVar,
  SshKey,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { copyText } from "../clipboard";
import { vapidKey } from "../vapid";
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
import Skeleton, { SkeletonList } from "../components/Skeleton";
import Button, { buttonClass } from "../components/ui/Button";
import { Input, Textarea } from "../components/ui/Field";
import Notice from "../components/ui/Notice";
import { toast } from "../components/ui/Toast";

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
        {show("sources") && <GoogleCalendar />}
        {show("sources") && <BlockedOwners owners={data?.blockedOwners ?? []} refresh={refresh} />}
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
                  {v.source === "settings" && <CopyVar keyName={v.key} />}
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

/**
 * Google Calendar, signed in to rather than typed.
 *
 * Google's CalDAV refuses a password, so the calendar needs an OAuth client
 * that belongs to the person: made once in their own Google Cloud project,
 * pasted here, and then a normal Google sign-in. The redirect is shown exactly
 * as the server will send it, because a mismatch is the one mistake Google's
 * error page explains worst. The sign-in button is a plain link: it leaves
 * the app for Google and comes back to this tab with the outcome in the query.
 */
function GoogleCalendar() {
  const { data, refresh } = usePoll<GoogleCalendarStatus>("/api/calendar/google", 60_000);
  const [params] = useSearchParams();
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const outcome = params.get("google");
  const failed = params.get("google_error");

  async function saveClient() {
    setError(null);
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          vars: { GOOGLE_CLIENT_ID: clientId.trim(), GOOGLE_CLIENT_SECRET: secret.trim() },
        }),
      });
      setClientId("");
      setSecret("");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function disconnect() {
    // Revoked at Google as well as forgotten here, so the way back is the
    // whole sign-in again rather than a tap.
    const ok = await confirm({
      title: "Disconnect Google?",
      body: "The pod forgets its sign-in and revokes it at Google. The calendar and the Gmail rules stop until you sign in again; the client ID and secret stay.",
      action: "disconnect",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api("/api/calendar/google/disconnect", { method: "POST" });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <SectionLabel icon="calendar" className="mt-2">
        Google Calendar
      </SectionLabel>
      <div className="mb-3 text-sm text-muted">
        What the assistant reads and writes when you ask about or change your calendar, and the
        Gmail labels and filters it can set up under Mail. Google only lets either in through a
        sign-in, with an OAuth client of your own.
      </div>

      {outcome === "ok" && data?.account && (
        <div className="mb-3 rounded-[11px] bg-run/10 px-3 py-2 text-[13px] text-run ring-1 ring-run/30">
          Signed in as {data.account}.
        </div>
      )}
      {failed && (
        <div className="mb-3 rounded-[11px] bg-wait/10 px-3 py-2 text-[13px] text-wait ring-1 ring-wait/30">
          Sign-in did not finish: {failed}
        </div>
      )}
      {error && (
        <Notice kind="fail" className="mb-3">
          {error}
        </Notice>
      )}

      {data?.account ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
          <StatusChip kind="run" label="connected" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{data.account}</span>
          <a
            href="/api/calendar/google/start"
            className="tap text-[12.5px] text-muted hover:text-text"
          >
            sign in again
          </a>
          <button
            onClick={() => void disconnect()}
            className="tap text-[12.5px] text-muted hover:text-fail"
          >
            disconnect
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-[11px] border border-dashed border-line px-[15px] py-3 text-[13px]">
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-muted">
            <li>
              In the Google Cloud console, signed in with your Workspace account: create a project,
              enable the <span className="text-text">CalDAV API</span> and the{" "}
              <span className="text-text">Gmail API</span>, and set the OAuth consent screen's user
              type to <span className="text-text">Internal</span>. If Gmail's own admin console
              blocks new apps, trust this one under Security, API controls.
            </li>
            <li>
              Create an OAuth client ID of type <span className="text-text">Web application</span>,
              with this as its authorised redirect URI:
              <span className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-[12px] text-text">
                  {data ? (
                    data.redirectUri
                  ) : (
                    <Skeleton className="inline-block h-3 w-48 max-w-full rounded bg-line align-middle" />
                  )}
                </code>
                <button
                  onClick={async () => {
                    if (data)
                      toast((await copyText(data.redirectUri)) ? "copied" : "could not copy");
                  }}
                  className="tap flex-none text-[12.5px] text-muted hover:text-text"
                >
                  copy
                </button>
              </span>
            </li>
            <li>Paste its client ID and secret below, then sign in.</li>
          </ol>

          {data?.clientSet ? (
            <div className="flex flex-wrap items-center gap-2.5">
              <a href="/api/calendar/google/start" className={buttonClass("primary")}>
                Sign in with Google
              </a>
              <span className="text-[12px] text-faint">
                client saved; change it under Agents, Environment
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5">
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="client ID"

                spellCheck={false}
                autoComplete="off"
                label="Google client ID"
                mono
              />
              <Input
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="client secret"

                type="password"
                autoComplete="off"
                label="Google client secret"
                mono
              />
              <Button
                onClick={saveClient}
                disabled={!clientId.trim() || !secret.trim()}
                variant="primary"
              >
                save
              </Button>
            </div>
          )}
        </div>
      )}
      {confirmDialog}
    </>
  );
}

/**
 * GitHub owners this bench does not read: an employer's, a customer's.
 *
 * The inbox is one account's notifications, and that account is at work as
 * well as at home. An owner listed here never becomes an item, so its
 * repository names and branch titles never reach the volume or a model turn;
 * saving the list also deletes what it filed before.
 */
function BlockedOwners({ owners, refresh }: { owners: string[]; refresh: () => void }) {
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
              className="tap text-muted hover:text-fail"
            >
              ×
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

/**
 * Push notifications for this device — the pod telling a pocketed phone that a
 * session wants input, or has finished.
 *
 * iOS delivers web push only to an app installed on the Home Screen and served
 * over a secure origin, so most of the states below exist to explain why the
 * enable button isn't offered yet.
 */
function Notifications() {
  const [state, setState] = useState<"loading" | "unavailable" | "denied" | "off" | "on">(
    "loading",
  );
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setState("unavailable");
        return;
      }
      // getRegistration (not .ready, which never resolves without a worker):
      // in dev, and in a plain browser tab on iOS, there is none.
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        setState("unavailable");
        return;
      }
      if (Notification.permission === "denied") {
        setState("denied");
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? "on" : "off");
      // Told again, every time this panel is opened. The browser's half of the
      // subscription outlives the pod's: restore the volume from a backup and
      // the endpoint list goes back to whatever it held that night, while every
      // phone still believes it is subscribed and this panel still says "on".
      // Nothing says otherwise until a push that should have arrived does not.
      // Re-registering is idempotent — it is keyed on the endpoint.
      const { endpoint, keys } = sub?.toJSON() ?? {};
      if (endpoint && keys?.p256dh && keys.auth) {
        await api<PushStatus>("/api/push/subscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
        })
          .then((s) => setDevices(s.devices))
          .catch(() => undefined);
        return;
      }
      await api<PushStatus>("/api/push")
        .then((s) => setDevices(s.devices))
        .catch(() => undefined);
    })();
  }, []);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await run();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const enable = () =>
    act(async () => {
      // iOS only grants permission from a user gesture — this click.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        setState("unavailable");
        return;
      }
      const { publicKey } = await api<PushStatus>("/api/push");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey(publicKey),
      });
      const { endpoint, keys } = sub.toJSON();
      if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error("incomplete subscription");
      const res = await api<PushStatus>("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
      });
      setDevices(res.devices);
      setState("on");
    });

  const disable = () =>
    act(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        const res = await api<PushStatus>("/api/push/unsubscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        setDevices(res.devices);
        await sub.unsubscribe();
      }
      setState("off");
    });

  const test = () =>
    act(async () => {
      const res = await api<PushTestResult>("/api/push/test", { method: "POST" });
      setNote(
        res.failed
          ? `the push service refused it: ${res.error ?? "unknown error"}`
          : res.sent
            ? "sent — it should arrive in a moment"
            : "no subscribed devices to send to",
      );
    });

  return (
    <>
      <SectionLabel icon="bell" className="mt-10">
        Notifications
      </SectionLabel>
      <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
        <span className="text-[13px]">this device</span>
        {state === "on" && <StatusChip kind="run" label="subscribed" />}
        {state === "off" && <StatusChip kind="idle" label="off" />}
        {state === "denied" && <StatusChip kind="wait" label="blocked" />}
        {state === "unavailable" && <StatusChip kind="idle" label="unavailable" />}
        {state === "on" && (
          <>
            <Button onClick={test} disabled={busy} className="ml-auto">
              send test
            </Button>
            <Button onClick={disable} disabled={busy} variant="ghost-danger">
              turn off
            </Button>
          </>
        )}
        {state === "off" && (
          <Button onClick={enable} disabled={busy} variant="primary" className="ml-auto">
            {busy ? "enabling…" : "enable"}
          </Button>
        )}
      </div>
      {note && <div className="mt-2.5 text-[12.5px] text-muted">{note}</div>}
      <div className="mt-5 text-[13px] text-muted">
        {state === "unavailable" ? (
          <>
            This browser can't receive push here. On iPhone, add verksted to the Home Screen (Share
            → Add to Home Screen) and open it from there — Safari tabs get no push. The app also has
            to be served over https.
          </>
        ) : state === "denied" ? (
          <>
            Notifications are blocked for this app. Re-allow them in iOS Settings → Notifications →
            verksted (or the browser's site settings), then reload.
          </>
        ) : (
          <>
            The pod pushes when a session starts waiting for input or finishes; tapping the
            notification opens that session. Each device subscribes separately — {devices}{" "}
            subscribed right now.
          </>
        )}
      </div>
    </>
  );
}

/**
 * The way out when the installed PWA is stuck on an old build: drops the
 * service worker and every cache it holds, then reloads from the pod.
 */
/**
 * Where the exports go, what is there, and a way to take one now.
 *
 * The list is whatever `vk backups --json` reports, so this panel and a session
 * terminal are reading the same directory through the same code. A run outlives
 * the request that starts it by minutes, hence the 202 and the faster poll
 * while one is in flight rather than a held-open connection.
 */
function Backups() {
  const { data, refresh } = usePoll<BackupStatus>("/api/backups", 30_000);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const running = busy || data?.running === true;

  useEffect(() => {
    if (!data?.running) return;
    const t = setInterval(refresh, 3_000);
    return () => clearInterval(t);
  }, [data?.running, refresh]);

  async function backUpNow() {
    setBusy(true);
    setNote(null);
    try {
      await api("/api/backups", { method: "POST" });
      refresh();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const latest = data?.archives.filter((a) => a.createdAt).sort((a, b) => b.mtime - a.mtime)[0];

  return (
    <>
      <SectionLabel icon="disk" className="mt-10">
        Backups
      </SectionLabel>
      <div className="mb-3 text-sm text-muted">
        One archive of the whole volume — settings, credentials, sessions, memory and every repo
        including its <code className="font-mono text-[12px]">.git</code>. Caches and build output
        are left out.
      </div>

      {note && (
        <Notice kind="fail" className="mb-3">
          {note}
        </Notice>
      )}
      {data?.lastError && !running && (
        <Notice kind="fail" className="mb-3">
          last run failed: {data.lastError}
        </Notice>
      )}

      <div className="mb-3 overflow-hidden rounded-xl border border-line">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-[15px] py-2.5 font-mono text-[12.5px]">
          <span className="min-w-0 break-all text-text">
            {data ? (
              data.dir
            ) : (
              <Skeleton className="inline-block h-3 w-40 rounded bg-surface-2 align-middle" />
            )}
          </span>
          {data && !data.offVolume && <StatusChip kind="wait" label="on the data volume" />}
          {data && data.totalBytes > 0 && (
            <span className="ml-auto text-muted">{gib(data.freeBytes)} free</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-surface px-[15px] py-2.5 font-mono text-[12.5px]">
          <span className="text-muted">nightly</span>
          <span className="text-text">
            {data ? (
              data.keep > 0 ? (
                `on, keeping ${data.keep}`
              ) : (
                "off"
              )
            ) : (
              <Skeleton className="inline-block h-3 w-24 rounded bg-surface-2 align-middle" />
            )}
          </span>
          {/* The archives are the truth about when one last worked; a failure
              two nights ago is otherwise only a line in the pod's log. */}
          <span className={`ml-auto ${data?.stale && !running ? "text-fail" : "text-muted"}`}>
            {running ? "backing up…" : `last ${agoLabel(latest?.createdAt ?? null)}`}
          </span>
        </div>
      </div>

      {data && data.archives.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {[...data.archives]
            .sort((a, b) => b.mtime - a.mtime)
            .map((a) => (
              <div
                key={a.name}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[11px] border border-line bg-surface px-[15px] py-2.5 font-mono text-[12px]"
              >
                <span className="min-w-0 break-all text-text">{a.name}</span>
                {a.encrypted && <StatusChip kind="run" label="encrypted" />}
                {a.createdAt === null ? (
                  // An encrypted archive this pod cannot open is a fine
                  // archive, not junk in the directory; saying "not a vk
                  // archive" about one would send somebody to delete it.
                  <StatusChip
                    kind="wait"
                    label={a.encrypted ? "no passphrase here" : "not a vk archive"}
                  />
                ) : (
                  <span className="text-muted">
                    {a.repos} repos{a.dirty ? `, ${a.dirty} dirty` : ""}
                  </span>
                )}
                <span className="ml-auto text-muted">{a.size}</span>
                <span className="w-[72px] text-right text-faint">
                  {agoLabel(a.createdAt ?? new Date(a.mtime * 1000).toISOString())}
                </span>
              </div>
            ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
        <span className="text-[13px]">back up now</span>
        <Button onClick={backUpNow} disabled={running} variant="primary" className="ml-auto">
          {running ? "backing up…" : "back up"}
        </Button>
      </div>

      <div className="mt-5 text-[13px] text-muted">
        The archive is not encrypted: it holds every token, private key and OAuth login on the
        volume in cleartext. Keep it where you would keep a password database. Restoring is a
        terminal job — <code className="font-mono text-[12px]">vk restore &lt;archive&gt;</code>,
        which needs the app stopped if it is going back onto the live volume.
      </div>
    </>
  );
}

/** Free space, the only figure here the backend reports in bytes. */
function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(0)}G`;
}

function AppReset() {
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  async function hardReset() {
    if (busy) return;
    const ok = await confirm({
      title: "Hard reset the app?",
      body: "The cached app shell is deleted and the page reloads from the pod. Sessions, repos and settings are untouched.",
      action: "reset the app",
    });
    if (!ok) return;
    setBusy(true);
    for (const reg of (await navigator.serviceWorker?.getRegistrations()) ?? []) {
      await reg.unregister();
    }
    if ("caches" in window) {
      await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    }
    location.reload();
  }

  return (
    <>
      <SectionLabel icon="bench" className="mt-10">
        App
      </SectionLabel>
      <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
        <span className="text-[13px]">hard reset</span>
        <Button onClick={hardReset} disabled={busy} variant="ghost-danger" className="ml-auto">
          {busy ? "resetting…" : "clear cache and reload"}
        </Button>
      </div>
      <div className="mt-5 text-[13px] text-muted">
        New builds normally announce themselves with a reload banner. Use this when the home-screen
        app is serving something stale anyway — it unregisters the service worker, deletes its
        caches and reloads from the pod.
      </div>
      {confirmDialog}
    </>
  );
}

/**
 * Copy with feedback. The old button called navigator.clipboard directly, which
 * is undefined on a plain-HTTP origin — the deployment this app is written for
 * — so it silently did nothing and you found out when the paste came up empty.
 */
function CopyButton({ text }: { text: string }) {
  return (
    <Button
      onClick={async () =>
        toast((await copyText(text)) ? "public key copied" : "could not copy — select it instead")
      }
      title="copy public key"
    >
      copy
    </Button>
  );
}

function SshKeys() {
  const { data: keys, refresh } = usePoll<SshKey[]>("/api/ssh-keys", 30_000);
  const [name, setName] = useState("id_ed25519");
  const [material, setMaterial] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      const key = await api<SshKey>("/api/ssh-keys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), privateKey: material }),
      });
      setMaterial("");
      setShown(key.name);
    });

  const generate = () =>
    run(async () => {
      const key = await api<SshKey>("/api/ssh-keys/generate", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setShown(key.name);
    });

  const [confirm, confirmDialog] = useConfirm();

  const remove = async (key: SshKey) => {
    const ok = await confirm({
      title: `Delete SSH key ${key.name}?`,
      body: "Anything authenticating with it — git pushes, remote hosts — stops working.",
      action: "delete the key",
      danger: true,
    });
    if (ok) void run(() => api(`/api/ssh-keys/${key.name}`, { method: "DELETE" }));
  };

  return (
    <>
      <SectionLabel icon="key" className="mt-10">
        SSH keys · ~/.ssh on the data volume
      </SectionLabel>
      {error && (
        <Notice kind="fail" className="mb-3">
          {error}
        </Notice>
      )}
      <div className="flex flex-col gap-2">
        {(keys ?? []).map((k) => (
          <div
            key={k.name}
            className="rounded-[11px] border border-line bg-surface px-[15px] py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-[12.5px]">{k.name}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-faint">
                {k.fingerprint}
              </span>
              <span className="ml-auto flex gap-2">
                <Button onClick={() => setShown(shown === k.name ? null : k.name)}>
                  {shown === k.name ? "hide" : "public key"}
                </Button>
                <Button onClick={() => remove(k)} disabled={busy} variant="ghost-danger">
                  delete
                </Button>
              </span>
            </div>
            {shown === k.name && (
              <div className="mt-2 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-[7px] border border-line bg-surface-2 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap break-all text-muted">
                  {k.publicKey}
                </pre>
                <CopyButton text={k.publicKey} />
              </div>
            )}
          </div>
        ))}
        {keys === null && (
          <SkeletonList
            count={1}
            className="h-[54px] rounded-[11px] border border-line bg-surface"
          />
        )}
        {keys?.length === 0 && <div className="text-[13px] text-faint">no keys installed</div>}

        <div className="flex flex-col gap-2 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="key name"

              label="ssh key name"
              mono
              className="w-[200px]"
            />
            <Button
              onClick={generate}
              disabled={busy || !name.trim()}
              title="generate an ed25519 keypair in the pod — the private key never leaves it"
              aria-label="generate an ed25519 keypair in the pod — the private key never leaves it"
              variant="primary"
            >
              generate in pod
            </Button>
            <span className="text-[12px] text-faint">or paste a private key:</span>
          </div>
          <Textarea
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"

            rows={3}
            spellCheck={false}
            label="private key"
            mono
            className="w-full"
          />
          {material.trim() && (
            <Button
              onClick={add}
              disabled={busy || !name.trim()}
              variant="primary"
              className="self-start"
            >
              add key
            </Button>
          )}
        </div>
      </div>
      <div className="mt-5 text-[13px] text-muted">
        Keys are write-only: only the public half is ever shown. Sessions pick them up automatically
        (git over ssh, plain ssh). Paste the public key into GitHub → Settings → SSH keys to push
        over ssh.
      </div>
      {confirmDialog}
    </>
  );
}
