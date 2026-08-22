import { useEffect, useState } from "react";
import { Routes, Route } from "react-router";
import CommandPalette from "./components/CommandPalette";
import ConnectionBanner from "./components/ConnectionBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import UpdateBanner from "./components/UpdateBanner";
import Chat from "./screens/Chat";
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
          {/* Two rooms, two threads. The assistant answers alone; the council
              is where several do, and you walk into it deliberately.

              Keyed, because both routes render the same component: without it
              React keeps the instance and only swaps the prop, so the other
              room's thread, its half-typed message and its open socket all walk
              through the door with you. */}
          <Route path="/ai" element={<Chat key="assistant" room="assistant" />} />
          <Route path="/council" element={<Chat key="council" room="council" />} />
          <Route path="/runs" element={<Inbox />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
      <UpdateBanner />
    </>
  );
}
