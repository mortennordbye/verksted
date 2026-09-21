import { useEffect, useState } from "react";
import type { BackupStatus } from "../../../../shared/api";
import { agoLabel, api, usePoll } from "../../api";
import SectionLabel from "../SectionLabel";
import { StatusChip } from "../StatusChip";
import Skeleton from "../Skeleton";
import Button from "../ui/Button";
import Notice from "../ui/Notice";
import { bytes } from "../../format";

/**
 * Where the exports go, what is there, and a way to take one now.
 *
 * The list is whatever `vk backups --json` reports, so this panel and a session
 * terminal are reading the same directory through the same code. A run outlives
 * the request that starts it by minutes, hence the 202 and the faster poll
 * while one is in flight rather than a held-open connection.
 */
export default function Backups() {
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
            <span className="ml-auto text-muted">{bytes(data.freeBytes)} free</span>
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
