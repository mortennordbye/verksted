import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import CommandPalette from "./components/CommandPalette";
import ConnectionBanner from "./components/ConnectionBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import UpdateBanner from "./components/UpdateBanner";
import Chat from "./screens/Chat";
import Docs from "./screens/Docs";
import Hub from "./screens/Hub";
import Inbox from "./screens/Inbox";
import NotFound from "./screens/NotFound";
import Project from "./screens/Project";
import Session from "./screens/Session";
import Settings from "./screens/Settings";
import Share from "./screens/Share";
import Today from "./screens/Today";

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
          {/* Today is the front door; the bench is where the work is. The
              installed app's start_url stays "/", so this is what opens. */}
          <Route path="/" element={<Today />} />
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
      </ErrorBoundary>
      <UpdateBanner />
    </>
  );
}
