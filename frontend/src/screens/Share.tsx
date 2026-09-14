import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import TopBar from "../components/TopBar";
import PageHeader from "../components/PageHeader";

/**
 * Where the share sheet lands.
 *
 * The manifest's share target points here with title, text and url in the
 * query; this posts them to the intake and goes to the inbox, where the item
 * is, so the whole thing is one tap from another app. Kept on screen only as
 * long as the post takes, and says so if it failed rather than leaving a
 * blank page with a question mark in the URL.
 */
export default function Share() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState<string | null>(null);
  const body = {
    ...(params.get("title") ? { title: params.get("title") } : {}),
    ...(params.get("text") ? { text: params.get("text") } : {}),
    ...(params.get("url") ? { url: params.get("url") } : {}),
  };
  const empty = Object.keys(body).length === 0;
  const error = failed ?? (empty ? "nothing was shared" : null);

  useEffect(() => {
    if (empty) return;
    api("/api/intake", { method: "POST", body: JSON.stringify(body) })
      .then(() => navigate("/runs", { replace: true }))
      .catch((e: Error) => setFailed(e.message));
    // The query is the whole input, and it does not change under a mounted
    // screen: the share sheet opens a fresh one each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  return (
    <>
      <TopBar back="/" crumb={[{ label: "share" }]} />
      <main className="mx-auto max-w-[600px] px-[18px] pt-[22px]">
        <PageHeader
          icon="inbox"
          label="Share"
          title={error ? "Could not take it in" : "Taking it in…"}
          sub={
            error ? (
              <span className="text-[12.5px] text-fail">{error}</span>
            ) : (
              "Sending it to the inbox, where it lands as an item."
            )
          }
        />
        {error && (
          <Link to="/" className="inline-block text-sm text-accent hover:underline">
            back to today
          </Link>
        )}
      </main>
    </>
  );
}
