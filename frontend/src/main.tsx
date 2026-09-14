import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import "./theme.css";

// A tab left open across a deploy asks for screen chunks the new build no
// longer has. Reload onto the new build, once: the stamp stops a loop when the
// chunk is missing for some other reason, and the error boundary takes it then.
const RELOADED_KEY = "vk.chunk-reload";
addEventListener("vite:preloadError", (event) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED_KEY)) < 10_000) return;
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
