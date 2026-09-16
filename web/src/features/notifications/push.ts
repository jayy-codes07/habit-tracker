/**
 * Permission, and this device's push subscription.
 *
 * This replaces the minute-by-minute poll that used to live here. Delivery is
 * now the server's: it decides what is due against APP_TIMEZONE, claims it, and
 * pushes it to the browser's own push service, which wakes public/sw.js even
 * when the app is closed. So there is nothing here that runs on a timer, and
 * nothing that asks "is anything due" — asking was the limitation.
 *
 * What is left is the handshake. The browser grants permission, hands over a
 * subscription (an endpoint at its push service plus two keys), and the server
 * stores it. Unsubscribing is the same in reverse, and both ends are told: the
 * browser, so it stops holding a subscription, and the server, so it stops
 * sending to a dead one.
 */
import { useEffect, useState } from "react";

import { subscribePush, unsubscribePush } from "./api";

/** Both halves are needed: on Android a notification must come from a worker. */
export const notificationsSupported = () =>
  typeof window !== "undefined" &&
  "Notification" in window &&
  "serviceWorker" in navigator &&
  "PushManager" in window;

export type Permission = "default" | "granted" | "denied" | "unsupported";

const currentPermission = (): Permission =>
  notificationsSupported() ? Notification.permission : "unsupported";

/**
 * The browser's permission, as state.
 *
 * `Notification.permission` is not reactive and nothing tells a page when it
 * changes, so it is read on mount, after a request, and on every return to the
 * page — which is where a permission revoked in site settings actually shows up.
 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<Permission>(currentPermission);

  useEffect(() => {
    const sync = () => setPermission(currentPermission());
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const request = async () => {
    if (!notificationsSupported()) return "unsupported" as const;
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  };

  return { permission, request };
}

/**
 * Registered on demand rather than at boot: a worker nobody has asked for is a
 * moving part with nothing to do, and the app installs from its manifest either
 * way. Registering the same URL twice is a no-op, so this is safe to call on
 * every run — and `ready` is what guarantees an *active* worker, which
 * pushManager needs and a fresh registration does not yet have.
 */
async function worker() {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

/**
 * The VAPID public key travels as base64url and `subscribe` wants raw bytes.
 * Padding has to be put back before atob, which refuses an unpadded string.
 */
function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  // The explicit ArrayBuffer parameter is not decoration: lib.dom types
  // BufferSource as a view over a plain ArrayBuffer, and a bare Uint8Array is
  // now generic over SharedArrayBuffer too.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The reverse, to compare a live subscription against the key in use now. */
function toBase64Url(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether this device already holds a subscription for the server's key. */
export async function isSubscribed(publicKey: string | null): Promise<boolean> {
  if (!notificationsSupported() || !publicKey) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  const existing = await registration?.pushManager.getSubscription();
  return Boolean(existing && matchesKey(existing, publicKey));
}

const matchesKey = (subscription: PushSubscription, publicKey: string) => {
  const raw = subscription.options.applicationServerKey;
  return Boolean(raw && toBase64Url(raw as ArrayBuffer) === publicKey);
};

/**
 * Subscribes this device and tells the server where to send.
 *
 * A subscription made against a DIFFERENT VAPID key is torn down first rather
 * than reused. The browser would refuse to re-subscribe over it anyway, and a
 * kept one is worse than an error: every send to it is refused by the push
 * service with a 403 that looks nothing like "your keys changed", and the
 * device goes quiet with a switch that says it is on.
 */
export async function subscribeThisDevice(publicKey: string) {
  const registration = await worker();

  const existing = await registration.pushManager.getSubscription();
  if (existing && !matchesKey(existing, publicKey)) {
    await unsubscribePush(existing.endpoint).catch(() => {});
    await existing.unsubscribe();
  }

  const subscription =
    existing && matchesKey(existing, publicKey)
      ? existing
      : await registration.pushManager.subscribe({
          // Required by every browser: a push that shows nothing is not allowed,
          // which is exactly what this app does anyway.
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        });

  await subscribePush(subscription.toJSON() as { endpoint: string; keys: Record<string, string> });
}

/**
 * Forgets this device, on both sides.
 *
 * The server is told first: if the browser's unsubscribe succeeded and the
 * server's delete did not, the row would live on and this device would keep
 * being sent pushes it can no longer receive — noise in the log for ever.
 */
export async function unsubscribeThisDevice() {
  if (!notificationsSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const existing = await registration?.pushManager.getSubscription();
  if (!existing) return;

  await unsubscribePush(existing.endpoint);
  await existing.unsubscribe();
}
