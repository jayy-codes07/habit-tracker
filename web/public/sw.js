/*
 * The whole service worker. Two listeners, no cache, no router, no build step.
 *
 * It exists to receive Web Push. The server decides what is due and when — the
 * same eligibility rules, quiet hours and duplicate suppression as before — and
 * pushes a small payload here; this file puts it on screen and handles the tap.
 * That is what lets a reminder arrive with the app completely closed: the
 * browser starts this worker for the push, and nothing of ours has to be
 * running.
 *
 * It deliberately does NOT cache anything. The app already installs from its
 * manifest, and a caching worker is the single most reliable way to serve
 * yesterday's JavaScript to someone who cannot work out why their edit did not
 * save. Offline is not a feature this app claims.
 *
 * The payload is the whole of what it knows: title, body, tag and href. There
 * is no fetching, no state and no decision-making in here — a worker that had
 * to ask the server what a push meant would be a worker that shows nothing when
 * the network is slow.
 */

// Take over as soon as it installs, rather than waiting for every tab to close.
// A notification permission granted in this tab should work in this tab.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/**
 * A push has arrived. The browser has already woken this worker for it and is
 * waiting for a notification: `userVisibleOnly` was part of the subscription,
 * so a push that shows nothing is a promise broken to the user agent, and
 * repeated it costs the site its permission. Hence the fallback text rather
 * than an early return — if a payload ever fails to parse, something still
 * shows.
 *
 * `tag` is the key of the thing being reminded about, so a re-delivery replaces
 * the notification instead of stacking beside it.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    // Not JSON. Nothing in this app sends that, but showing something is still
    // better than breaking the userVisibleOnly contract.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Reminder", {
      body: payload.body ?? "",
      tag: payload.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { href: payload.href ?? "/" },
    }),
  );
});

/**
 * Tapping a reminder opens the screen it is about — the day for a habit, the
 * task list, the workspace — reusing a window that is already open rather than
 * piling up new ones. focus() then navigate() rather than openWindow() when a
 * client exists: on a phone the installed app is usually already running, and
 * the alternative is a second copy of it.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const href = event.notification.data?.href ?? "/";
  const url = new URL(href, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        // navigate() is not implemented everywhere and rejects on a client the
        // worker does not control; a focused window on the wrong screen is
        // still the app, so the failure is not worth reporting.
        if ("navigate" in client) await client.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    }),
  );
});
