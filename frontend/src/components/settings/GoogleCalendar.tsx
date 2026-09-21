import { useState } from "react";
import { useSearchParams } from "react-router";
import type { GoogleCalendarStatus } from "../../../../shared/api";
import { api, usePoll } from "../../api";
import { copyText } from "../../clipboard";
import { useConfirm } from "../../useConfirm";
import SectionLabel from "../SectionLabel";
import { StatusChip } from "../StatusChip";
import Skeleton from "../Skeleton";
import Button, { buttonClass } from "../ui/Button";
import { Input } from "../ui/Field";
import Notice from "../ui/Notice";
import { toast } from "../ui/Toast";

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
export default function GoogleCalendar() {
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

      {data?.account && data.error && (
        <Notice kind="fail" className="mb-3">
          Google no longer accepts the stored sign-in ({data.error}). The calendar and the Gmail
          rules are off until you sign in again.
        </Notice>
      )}
      {data?.account ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
          {data.error ? (
            <StatusChip kind="fail" label="sign-in refused" />
          ) : (
            <StatusChip kind="run" label="connected" />
          )}
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
