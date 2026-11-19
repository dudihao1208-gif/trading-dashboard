const CACHE = "obs-shell-v4";
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch("./index.html", { cache: "reload" });
      const html = await res.text();
      const assets = Array.from(html.matchAll(/(?:href|src)="([^"]+\.(?:js|css|png|webmanifest|svg|ico))"/g)).map((m) => m[1]);
      const urls = Array.from(new Set([...PRECACHE, ...assets]));
      await cache.put("./index.html", new Response(html, { headers: res.headers }));
      await Promise.all(urls.filter((u) => u !== "./index.html").map(async (u) => {
        try {
          const r = await fetch(u, { cache: "reload" });
          if (r.ok) await cache.put(u, r);
        } catch { /* skip */ }
      }));
    } catch {
      await cache.addAll(PRECACHE).catch(() => {});
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isNav = req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("/index.html") || /\/trading-dashboard\/?$/.test(url.pathname);

  event.respondWith((async () => {
    if (isNav) {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put("./index.html", res.clone()).catch(() => {});
        return res;
      } catch {
        return (await caches.match("./index.html", { ignoreSearch: true }))
          || (await caches.match("./", { ignoreSearch: true }))
          || Response.error();
      }
    }
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) {
      fetch(req).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {}); }).catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
      return res;
    } catch {
      return (await caches.match("./index.html", { ignoreSearch: true })) || Response.error();
    }
  })());
});
