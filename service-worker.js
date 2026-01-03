const CACHE = "contador-cajas-pro-v1";

const ASSETS = [
  "./",
  "./scanner.html",
  "./app.js",
  "./manifest.json",
  "./service-worker.js",
  "./libs/html5-qrcode.min.js",
  "./libs/xlsx.full.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS).catch(()=>cache.addAll(["./","./scanner.html","./app.js","./manifest.json","./service-worker.js"])))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k !== CACHE ? caches.delete(k) : null))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(()=>{});
        return resp;
      }).catch(() => caches.match("./scanner.html"));
    })
  );
});
