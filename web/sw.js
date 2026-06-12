/*
 * PocketCode — Service Worker
 * --------------------------------------------------------------------------
 * Runs in the background (even when the page is closed) so your phone can
 * receive push notifications — e.g. "✋ Approve Bash?" — and bring you back to
 * the app when you tap them. Web Push payloads are encrypted to this browser,
 * so the push provider can't read them.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "PocketCode", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "PocketCode";
  const options = {
    body: data.body || "",
    tag: data.tag || "pocketcode",
    icon: "/icon.svg",
    badge: "/icon.svg",
    // Keep approval prompts on screen until the user acts on them.
    requireInteraction: /approve/i.test(data.body || ""),
    data,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })()
  );
});
