const CACHE = "contador-cajas-v3";
const BASE = "/contador-cajas/";

const ASSETS = [
  BASE,
  BASE + "index.html",
  BASE + "scanner.html",
  BASE + "app.js",
  BASE + "manifest.json",
  BASE + "service-worker.js",

  // libs
  BASE + "libs/html5-qrcode.min.js",
  BASE + "libs/xlsx.full.min.js",

  // icons (si los tenés)
  BASE + "icons/icon-192.png",
  BASE + "icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k !== CACHE ? caches.delete(k) : null)))
    ).then(() => self.clients.claim())
  );
});

// Estrategia: Cache First (offline seguro)
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Solo GET
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // Guardar en cache lo que vaya pidiendo
        const copy = resp.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
        return resp;
      });
    })
  );
});
