import { Routes, Route } from "react-router";
import ConnectionBanner from "./components/ConnectionBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import UpdateBanner from "./components/UpdateBanner";
import Hub from "./screens/Hub";
import Inbox from "./screens/Inbox";
import NotFound from "./screens/NotFound";
import Project from "./screens/Project";
import Session from "./screens/Session";
import Settings from "./screens/Settings";

export default function App() {
  return (
    <>
      {/* Outside the boundary: both banners have to survive a screen crash —
          the connection one especially, since an unreachable pod is a likely
          cause of the crash in the first place. */}
      <ConnectionBanner />
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Hub />} />
          <Route path="/p/:name" element={<Project />} />
          <Route path="/s/:id" element={<Session />} />
          <Route path="/runs" element={<Inbox />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
      <UpdateBanner />
    </>
  );
}
