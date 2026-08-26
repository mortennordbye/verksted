import { useEffect, useState } from "react";
import type {
  BackupStatus,
  PushStatus,
  PushTestResult,
  Settings as SettingsInfo,
  SettingVar,
  SshKey,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { copyText } from "../clipboard";
import { useConfirm } from "../useConfirm";
import TopBar from "../components/TopBar";
import AssistantPanel from "../components/AssistantPanel";
import CouncilPanel from "../components/CouncilPanel";
import MemoryPanel from "../components/MemoryPanel";
import SchedulesPanel from "../components/SchedulesPanel";
import { StatusChip } from "../components/StatusChip";

function sourceChip(source: SettingVar["source"]) {
  if (source === "env") return <StatusChip kind="run" label="env" />;
  if (source === "settings") return <StatusChip kind="wait" label="settings" />;
  return <StatusChip kind="idle" label="unset" />;
}

export default function Settings() {
  const { data, refresh } = usePoll<SettingsInfo>("/api/settings", 30_000);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(vars: Record<string, string | null>) {
    setError(null);
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ vars }) });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveDraft(key: string) {
    const value = drafts[key]?.trim();
    if (!value) return;
    await save({ [key]: value });
    setDrafts((d) => ({ ...d, [key]: "" }));
  }

  async function addVar() {
    const key = newKey.trim();
    if (!key) return;
    await save({ [key]: drafts[key]?.trim() || null });
    setNewKey("");
  }

  return (
    <>
      <TopBar back="/" crumb={[{ label: "settings" }]} />
      <main className="mx-auto max-w-[760px] px-[18px] pt-[22px] pb-[60px]">
        <h1 className="mb-1 text-[21px] font-semibold tracking-tight">Settings</h1>
        <div className="mb-6 text-sm text-muted">
          What the pod runs on your behalf, how it reaches you, and what the agents are given.
        </div>
        <SchedulesPanel />
        <Notifications />
        <AssistantPanel />
        <CouncilPanel />
        <MemoryPanel />
        <div className="mt-10 mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          Environment
        </div>
        <div className="mb-6 text-sm text-muted">
          Variables reach the agent CLIs inside new tmux sessions. Values are write-only: the page
          shows where a variable is defined, never what it contains.
        </div>

        {error && <div className="mb-3 font-mono text-[12px] text-wait">{error}</div>}

        <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          Server · from the deployment (read-only)
        </div>
        <div className="mb-7 overflow-hidden rounded-xl border border-line">
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

        <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          Agent environment
        </div>
        <div className="flex flex-col gap-2">
          {(data?.vars ?? []).map((v) => (
            <div
              key={v.key}
              className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5"
            >
              <span className="font-mono text-[12.5px]">{v.key}</span>
              {sourceChip(v.source)}
              <input
                value={drafts[v.key] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [v.key]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && saveDraft(v.key)}
                placeholder={v.source === "unset" ? "enter value…" : "enter new value to replace…"}
                className="min-w-[160px] flex-1 rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
              />
              {drafts[v.key]?.trim() && (
                <button
                  onClick={() => saveDraft(v.key)}
                  className="tap rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110"
                >
                  save
                </button>
              )}
              {v.source === "settings" && (
                <button
                  onClick={() => save({ [v.key]: null })}
                  title="remove the stored value"
                  className="tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait"
                >
                  clear
                </button>
              )}
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && addVar()}
              placeholder="NEW_VARIABLE"
              className="w-[200px] rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
            />
            <input
              value={drafts[newKey.trim()] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [newKey.trim()]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && addVar()}
              placeholder="value"
              className="min-w-[160px] flex-1 rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
            />
            <button
              onClick={addVar}
              disabled={!newKey.trim() || !drafts[newKey.trim()]?.trim()}
              className="tap rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
            >
              add
            </button>
          </div>
        </div>

        <div className="mt-5 text-[13px] text-muted">
          Settings-page values persist on the data volume and take precedence over deployment env
          vars. Changes apply to sessions started afterwards.
        </div>
        <SshKeys />
        <Backups />
        <AppReset />
      </main>
    </>
  );
}

/** VAPID keys travel as base64url; PushManager wants the raw bytes. */
function vapidKey(b64: string): Uint8Array<ArrayBuffer> {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
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
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
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
      <div className="mt-10 mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
        Notifications
      </div>
      <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
        <span className="font-mono text-[12.5px]">this device</span>
        {state === "on" && <StatusChip kind="run" label="subscribed" />}
        {state === "off" && <StatusChip kind="idle" label="off" />}
        {state === "denied" && <StatusChip kind="wait" label="blocked" />}
        {state === "unavailable" && <StatusChip kind="idle" label="unavailable" />}
        {state === "on" && (
          <>
            <button
              onClick={test}
              disabled={busy}
              className="tap ml-auto rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-accent hover:text-accent disabled:opacity-50"
            >
              send test
            </button>
            <button
              onClick={disable}
              disabled={busy}
              className="tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait disabled:opacity-50"
            >
              turn off
            </button>
          </>
        )}
        {state === "off" && (
          <button
            onClick={enable}
            disabled={busy}
            className="tap ml-auto rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "enabling…" : "enable"}
          </button>
        )}
      </div>
      {note && <div className="mt-2.5 font-mono text-[12px] text-muted">{note}</div>}
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
      <div className="mt-10 mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
        Backups
      </div>
      <div className="mb-3 text-sm text-muted">
        One archive of the whole volume — settings, credentials, sessions, memory and every repo
        including its <code className="font-mono text-[12px]">.git</code>. Caches and build output
        are left out.
      </div>

      {note && <div className="mb-3 font-mono text-[12px] text-wait">{note}</div>}
      {data?.lastError && !running && (
        <div className="mb-3 font-mono text-[12px] text-fail">
          last run failed: {data.lastError}
        </div>
      )}

      <div className="mb-3 overflow-hidden rounded-xl border border-line">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-[15px] py-2.5 font-mono text-[12.5px]">
          <span className="min-w-0 break-all text-text">{data?.dir ?? "…"}</span>
          {data && !data.offVolume && <StatusChip kind="wait" label="on the data volume" />}
          {data && data.totalBytes > 0 && (
            <span className="ml-auto text-muted">{gib(data.freeBytes)} free</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-surface px-[15px] py-2.5 font-mono text-[12.5px]">
          <span className="text-muted">nightly</span>
          <span className="text-text">
            {data ? (data.keep > 0 ? `on, keeping ${data.keep}` : "off") : "…"}
          </span>
          <span className="ml-auto text-muted">
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
                {a.createdAt === null ? (
                  <StatusChip kind="wait" label="not a vk archive" />
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
        <span className="font-mono text-[12.5px]">back up now</span>
        <button
          onClick={backUpNow}
          disabled={running}
          className="tap ml-auto rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
        >
          {running ? "backing up…" : "back up"}
        </button>
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
      <div className="mt-10 mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
        App
      </div>
      <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
        <span className="font-mono text-[12.5px]">hard reset</span>
        <button
          onClick={hardReset}
          disabled={busy}
          className="tap ml-auto rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait disabled:opacity-50"
        >
          {busy ? "resetting…" : "clear cache and reload"}
        </button>
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
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  return (
    <button
      onClick={async () => {
        setState((await copyText(text)) ? "ok" : "fail");
        setTimeout(() => setState("idle"), 1500);
      }}
      title="copy public key"
      className={`tap rounded-[7px] border px-2.5 py-1.5 font-mono text-[12px] ${
        state === "fail"
          ? "border-fail/50 text-fail"
          : state === "ok"
            ? "border-run/50 text-run"
            : "border-line text-muted hover:border-faint hover:text-text"
      }`}
    >
      {state === "ok" ? "copied" : state === "fail" ? "select it" : "copy"}
    </button>
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
      <div className="mt-10 mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
        SSH keys · ~/.ssh on the data volume
      </div>
      {error && <div className="mb-3 font-mono text-[12px] text-wait">{error}</div>}
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
                <button
                  onClick={() => setShown(shown === k.name ? null : k.name)}
                  className="tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-faint hover:text-text"
                >
                  {shown === k.name ? "hide" : "public key"}
                </button>
                <button
                  onClick={() => remove(k)}
                  disabled={busy}
                  className="tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait disabled:opacity-50"
                >
                  delete
                </button>
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
        {keys?.length === 0 && (
          <div className="font-mono text-[12.5px] text-faint">no keys installed</div>
        )}

        <div className="flex flex-col gap-2 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="key name"
              className="w-[200px] rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
            />
            <button
              onClick={generate}
              disabled={busy || !name.trim()}
              title="generate an ed25519 keypair in the pod — the private key never leaves it"
              aria-label="generate an ed25519 keypair in the pod — the private key never leaves it"
              className="tap rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
            >
              generate in pod
            </button>
            <span className="text-[12px] text-faint">or paste a private key:</span>
          </div>
          <textarea
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            rows={3}
            spellCheck={false}
            className="w-full resize-y rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] outline-none placeholder:text-faint focus:border-accent"
          />
          {material.trim() && (
            <button
              onClick={add}
              disabled={busy || !name.trim()}
              className="tap self-start rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
            >
              add key
            </button>
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
