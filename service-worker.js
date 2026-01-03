const CACHE = "cajasqr-v2";
const ASSETS = [
  "./",
  "./scanner.html",
  "./app.js",
  "./manifest.json",
  "./service-worker.js",
  "./libs/html5-qrcode.min.js",
  "./libs/xlsx.full.min.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k !== CACHE ? caches.delete(k) : null))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
