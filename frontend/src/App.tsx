import { Routes, Route } from "react-router";
import Hub from "./screens/Hub";
import Project from "./screens/Project";
import Session from "./screens/Session";
import Settings from "./screens/Settings";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Hub />} />
      <Route path="/p/:name" element={<Project />} />
      <Route path="/s/:id" element={<Session />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  );
}
