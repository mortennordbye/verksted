import { Routes, Route } from "react-router";
import Hub from "./screens/Hub";
import Project from "./screens/Project";
import Session from "./screens/Session";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Hub />} />
      <Route path="/p/:name" element={<Project />} />
      <Route path="/s/:id" element={<Session />} />
    </Routes>
  );
}
