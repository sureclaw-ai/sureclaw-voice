// CACHE_NAME is rewritten at build time by the `sw-cache-version` Vite plugin,
// which replaces the BUILD_HASH token with a hash of the bundled JS/CSS. This
// means the cache is automatically busted whenever app content changes — no
// manual version bump required.
const CACHE_NAME = "openclaw-voice-966862133bab";
// Relative to the service worker's scope so the app shell caches correctly
// whether it's served from the site root or a mount path (e.g. /voice/).
const APP_SHELL = ["./", "./manifest.webmanifest", "./offline.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  // Only app-shell navigations fall back to the cached shell (or offline page).
  // Data/fetch API calls and WebRTC signalling must surface real network errors
  // rather than being silently masked by a stale HTML fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("./")),
        ),
    );
    return;
  }
  // Other same-origin GETs: stale-while-revalidate, but never cache errors or
  // opaque cross-origin responses.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});