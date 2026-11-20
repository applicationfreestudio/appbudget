// App Budget — service worker : réseau d'abord, copie locale si hors connexion. L'API n'est jamais mise en cache.
const CACHE = "appbudget-v3";
const CORE = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/recap/")) return;
  e.respondWith(
    fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((ca) => ca.put(e.request, c)); } return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("index.html")))
  );
});

// Notifications (demandes d'accès, dépenses saisies par d'autres personnes)
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (_) { m = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || "App Budget", {
    body: m.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: m.tag || "appbudget", renotify: true, data: { url: m.url || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const rc = url.includes("/recap/");
    for (const c of cs) if (new URL(c.url).origin === self.location.origin && (rc ? c.url.startsWith(url) : !c.url.includes("/recap/"))) { if (!rc) c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
