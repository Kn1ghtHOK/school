const CACHE_NAME = "schoolapp-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/css/app.css",
  "/js/app.js",
  "/js/api.js",
  "/js/push.js",
  "/js/syllabus-parser.js",
  "/js/date-parse.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // always network for API calls

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "School app", body: "You have an update." };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    /* keep default */
  }

  // Snooze buttons on the notification itself — a progressive enhancement.
  // Notification action buttons aren't supported on every browser (Safari
  // notably doesn't render them as of this writing), so this is a bonus,
  // not the primary way to snooze — that's always available inside the
  // app, on the assignment itself, regardless of browser.
  const actions = payload.data?.snoozable
    ? [
        { action: "snooze-1h", title: "1 hour" },
        { action: "snooze-tomorrow", title: "Tomorrow" },
      ]
    : [];

  event.waitUntil(
    self.registration.showNotification(payload.title || "School app", {
      body: payload.body || "",
      tag: payload.tag || "schoolapp",
      data: payload.data || {},
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      actions,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const assignmentId = data.assignmentId;
  const targetUrl = assignmentId ? `/#assignment/${assignmentId}` : "/#today";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // A tapped "Snooze" action button, with an app window already open:
      // hand off to that page, since only it (not the service worker) has
      // the auth token needed to call the API.
      if (event.action && event.action.startsWith("snooze-") && clientList.length > 0) {
        clientList[0].postMessage({ type: "snooze", action: event.action, assignmentId, termId: data.termId });
        return "focus" in clientList[0] ? clientList[0].focus() : undefined;
      }
      // Otherwise (a plain tap, or a snooze action with no window open yet):
      // just open/focus the app to the assignment — snoozing from inside
      // the sheet is always one tap away from there.
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
