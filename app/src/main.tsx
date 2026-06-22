import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  });
}

// Ask the browser to exempt our storage (settings + app-shell cache) from
// eviction under disk pressure. On a home-screen PWA this is typically granted
// silently; on a plain browser tab it may be denied, which is fine — we just
// fall back to best-effort storage.
if (navigator.storage?.persist) {
  navigator.storage
    .persisted()
    .then((already) => (already ? true : navigator.storage.persist()))
    .catch(() => undefined);
}
