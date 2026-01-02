const CACHE = "cajasqr-v1";
const BASE = "/contador-cajas/";

const ASSETS = [
  BASE + "scanner.html",
  BASE + "app.js",
  BASE + "manifest.json",
  BASE + "service-worker.js",
  BASE + "libs/html5-qrcode.min.js",
  BASE + "libs/xlsx.full.min.js",
  BASE + "icons/icon-192.png",
  BASE + "icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
