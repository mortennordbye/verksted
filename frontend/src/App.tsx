import { useEffect, useState } from "react";
import { Routes, Route } from "react-router";
import CommandPalette from "./components/CommandPalette";
import ConnectionBanner from "./components/ConnectionBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import UpdateBanner from "./components/UpdateBanner";
import Assistant from "./screens/Assistant";
import Hub from "./screens/Hub";
import Inbox from "./screens/Inbox";
import NotFound from "./screens/NotFound";
import Project from "./screens/Project";
import Session from "./screens/Session";
import Settings from "./screens/Settings";

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
        <Routes>
          <Route path="/" element={<Hub />} />
          <Route path="/p/:name" element={<Project />} />
          <Route path="/s/:id" element={<Session />} />
          <Route path="/ai" element={<Assistant />} />
          <Route path="/runs" element={<Inbox />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
      <UpdateBanner />
    </>
  );
}
