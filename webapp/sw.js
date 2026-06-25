/// <reference lib="webworker" />
// Typed handle to the service-worker global scope. `self` is declared as the
// generic WorkerGlobalScope in the WebWorker lib, so we narrow it once here to
// get `skipWaiting`/`clients` and the install/activate/fetch event types.
const sw = self;
// CACHE_NAME is rewritten at build time by the `service-worker` Vite plugin,
// which replaces the BUILD_HASH token with a hash of the bundled JS/CSS. This
// means the cache is automatically busted whenever app content changes — no
// manual version bump required.
const CACHE_NAME = "openclaw-voice-58f20104e624";
// Relative to the service worker's scope so the app shell caches correctly
// whether it's served from the site root or a mount path (e.g. /voice/).
const APP_SHELL = [
	"./",
	"./manifest.webmanifest",
	"./offline.html"
];
sw.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
	sw.skipWaiting();
});
sw.addEventListener("activate", (event) => {
	event.waitUntil(caches.keys().then((keys) => {
		const stale = [];
		for (const key of keys) {
			if (key !== CACHE_NAME) stale.push(caches.delete(key));
		}
		return Promise.all(stale);
	}));
	sw.clients.claim();
});
sw.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	// Only app-shell navigations fall back to the cached shell (or offline page).
	// Data/fetch API calls and WebRTC signalling must surface real network errors
	// rather than being silently masked by a stale HTML fallback.
	if (request.mode === "navigate") {
		event.respondWith(fetch(request).then((response) => {
			if (response.ok && response.type === "basic") {
				const copy = response.clone();
				caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
			}
			return response;
		}).catch(async () => await caches.match(request) ?? await caches.match("./") ?? Response.error()));
		return;
	}
	// Other same-origin GETs: stale-while-revalidate, but never cache errors or
	// opaque cross-origin responses.
	event.respondWith(caches.match(request).then((cached) => {
		const network = fetch(request).then((response) => {
			if (response.ok && response.type === "basic") {
				const copy = response.clone();
				caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
			}
			return response;
		}).catch(() => cached ?? Response.error());
		return cached ?? network;
	}));
});
