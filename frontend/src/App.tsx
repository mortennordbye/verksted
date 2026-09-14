import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import CommandPalette from "./components/CommandPalette";
import ConnectionBanner from "./components/ConnectionBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import HashScroll from "./components/HashScroll";
import Skeleton, { SkeletonList } from "./components/Skeleton";
import UpdateBanner from "./components/UpdateBanner";
import Hub from "./screens/Hub";
import NotFound from "./screens/NotFound";
import Today from "./screens/Today";
import { ackedToday } from "./todayAck";

// The two front doors load with the app; every other screen is its own chunk.
// Session alone brings the terminal and highlight.js, which made up most of a
// single 600 KB (gzipped) bundle that every launch parsed before Today could draw.
const Chat = lazy(() => import("./screens/Chat"));
const Docs = lazy(() => import("./screens/Docs"));
const Inbox = lazy(() => import("./screens/Inbox"));
const Project = lazy(() => import("./screens/Project"));
const Session = lazy(() => import("./screens/Session"));
const Settings = lazy(() => import("./screens/Settings"));
const Share = lazy(() => import("./screens/Share"));

/** A screen whose chunk has not arrived: the shape every page starts with. */
function ScreenFallback() {
  return (
    <main className="mx-auto max-w-[1140px] px-[18px] pt-[22px]">
      <Skeleton className="mb-7 block h-[74px] rounded-xl bg-surface" />
      <SkeletonList count={3} className="h-[86px] rounded-xl border border-line bg-surface" />
    </main>
  );
}

export default function App() {
  const [palette, setPalette] = useState(false);

  // The one global shortcut. Cmd/Ctrl+K is where every editor and chat app puts
  // "jump to", and the app had no keyboard route to anything at all before it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* Outside the boundary: both banners have to survive a screen crash —
          the connection one especially, since an unreachable pod is a likely
          cause of the crash in the first place. */}
      <ConnectionBanner />
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <ErrorBoundary>
        <HashScroll />
        <Suspense fallback={<ScreenFallback />}>
          <Routes>
            {/* Today is the front door once a day; the bench is where the work
              is. The installed app's start_url stays "/", so this is what
              opens: Today until it has been acknowledged, the bench after
              that, and Today again tomorrow. /today is always Today. */}
            <Route path="/" element={ackedToday() ? <Navigate to="/bench" replace /> : <Today />} />
            <Route path="/today" element={<Today />} />
            <Route path="/bench" element={<Hub />} />
            <Route path="/p/:name" element={<Project />} />
            <Route path="/s/:id" element={<Session />} />
            <Route path="/ai" element={<Chat />} />
            {/* The council was a screen of its own once, and a phone that
              installed the app then still has the door on its home screen. */}
            <Route path="/council" element={<Navigate to="/ai" replace />} />
            <Route path="/runs" element={<Inbox />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/share" element={<Share />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <UpdateBanner />
    </>
  );
}
