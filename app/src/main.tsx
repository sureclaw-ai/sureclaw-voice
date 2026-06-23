import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { callState } from "./callState";
import "./styles.css";

// The gateway substitutes the __APP_*__ tokens in index.html at serve time.
// When the page is opened from the raw Vite dev server that substitution hasn't
// run, so the literal placeholders leak into the tab title and the home-screen
// name metas. Swap any still-unsubstituted token for a friendly default — a
// no-op in production, where the tokens are already real by the time JS runs.
function normalizeUnsubstitutedTokens() {
  const PLACEHOLDER = /^__.*__$/;
  // Mirror the gateway's own unconfigured defaults (see index.ts): the product
  // title and home-screen label fall back to "SureClaw Voice", while the
  // assistant name (Call button) falls back to "OpenClaw".
  const FALLBACK: Record<string, string> = {
    __APP_FULL_NAME__: "SureClaw Voice",
    __APP_SHORT_NAME__: "SureClaw Voice",
    __APP_NAME__: "OpenClaw",
  };
  if (PLACEHOLDER.test(document.title)) {
    document.title = FALLBACK[document.title] ?? "SureClaw Voice";
  }
  for (const meta of document.querySelectorAll("meta[content]")) {
    const content = meta.getAttribute("content")?.trim() ?? "";
    if (PLACEHOLDER.test(content)) {
      meta.setAttribute("content", FALLBACK[content] ?? "SureClaw Voice");
    }
  }
}

normalizeUnsubstitutedTokens();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the service worker. When a new version activates (via skipWaiting),
// reload to pick it up — but defer the reload if a call is in progress so we
// don't drop an active WebRTC session mid-call. App.tsx flushes the pending
// reload via setCallActive(false) when the call ends.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    if (callState.active) callState.pendingReload = true;
    else {
      reloading = true;
      window.location.reload();
    }
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
