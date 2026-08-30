import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import TopBar from "../components/TopBar";

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
        {error ? (
          <div className="text-sm">
            <div className="font-mono text-[12px] text-fail">{error}</div>
            <Link to="/" className="mt-3 inline-block text-accent hover:underline">
              back to today
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
            taking it in…
          </div>
        )}
      </main>
    </>
  );
}
