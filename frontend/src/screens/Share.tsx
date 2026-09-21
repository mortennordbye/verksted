import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import TopBar from "../components/TopBar";
import PageHeader from "../components/PageHeader";
import Button from "../components/ui/Button";
import Notice from "../components/ui/Notice";

/**
 * Where the share sheet lands.
 *
 * The manifest's share target points here with title, text and url in the
 * query, and this shows what arrived and sends it on a tap.
 *
 * The tap is the point (S-02). Posting on mount made this a GET that performs
 * a POST: any page the person had open could navigate a tab here, or frame it,
 * and up to twenty thousand characters would land in the inbox attributed to
 * them, where the next triage turn reads it. Framing is refused now
 * (frame-ancestors, S-06) and the API's own origin check means nothing else
 * can post to the intake — but a plain navigation still costs nothing, and the
 * screen showing what it is about to send is what makes the item true.
 */
export default function Share() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const title = params.get("title") ?? "";
  const text = params.get("text") ?? "";
  const url = params.get("url") ?? "";
  const body = {
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(url ? { url } : {}),
  };
  const empty = Object.keys(body).length === 0;

  const send = () => {
    setSending(true);
    setFailed(null);
    api("/api/intake", { method: "POST", body: JSON.stringify(body) })
      .then(() => navigate("/runs", { replace: true }))
      .catch((e: Error) => {
        setFailed(e.message);
        setSending(false);
      });
  };

  return (
    <>
      <TopBar back="/" crumb={[{ label: "share" }]} />
      <main className="mx-auto max-w-[600px] px-[18px] pt-[22px]">
        <PageHeader
          icon="inbox"
          label="Share"
          title={empty ? "Nothing was shared" : "Send this to the inbox?"}
          sub={
            empty
              ? "The share sheet passed no title, text or link."
              : "It lands as an item from you, and the next triage turn reads it."
          }
        />
        {!empty && (
          <>
            <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
              {title && <div className="text-[14px] font-semibold">{title}</div>}
              {text && (
                <div className="mt-1 max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] text-muted">
                  {text}
                </div>
              )}
              {url && (
                <div className="mt-2 break-all font-mono text-[12.5px] text-accent">{url}</div>
              )}
            </div>
            <Button
              onClick={send}
              disabled={sending}
              variant="primary"
              size="lg"
              className="mt-4 w-full"
            >
              {sending ? "sending…" : "send to inbox"}
            </Button>
          </>
        )}
        {failed && (
          <Notice kind="fail" className="mt-3">
            {failed}
          </Notice>
        )}
        <Link to="/" className="mt-4 inline-block text-sm text-accent hover:underline">
          back to today
        </Link>
      </main>
    </>
  );
}
