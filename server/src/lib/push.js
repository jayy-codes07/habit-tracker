/**
 * Web Push, and the whole of this app's dealings with the push protocol.
 *
 * `web-push` is the one dependency here and it earns it: a push payload is
 * ECDH over P-256, HKDF, and AES-128-GCM in a framing with its own RFC, and
 * hand-rolling that is how a personal app ends up with an encryption bug it
 * cannot see. It is a library, not a service — there is no account, no SDK in
 * the browser and no third party in the path except the browser's own push
 * service, which is whatever Chrome, Firefox or Safari chose.
 *
 * VAPID is what identifies this server to that push service: the public key
 * goes to the browser and into the subscription, the private key signs every
 * send, and a send signed with the wrong pair is refused. Only the public half
 * is ever allowed into a payload — see `config.vapid`.
 *
 * Nothing about *what* to send lives here. Eligibility, quiet hours and
 * duplicate suppression are all in modules/reminders, unchanged.
 */
import webpush from "web-push";

import { config } from "../config/index.js";

/**
 * Whether this deployment can push at all.
 *
 * Checked rather than asserted at boot for the reason Cloudinary's config is:
 * db:migrate, db:seed and every screen in the app work without these keys, and
 * a server that refuses to start because nobody has generated a VAPID pair yet
 * is a worse failure than one that simply does not notify.
 */
export const pushConfigured = () =>
  Boolean(config.vapid.publicKey && config.vapid.privateKey && config.vapid.subject);

let ready = false;

/** Applied once, lazily: setting them at import would run before config is read. */
function configure() {
  if (ready) return;
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  ready = true;
}

/**
 * A subscription the push service says is gone: 404 (never existed) or 410
 * (unsubscribed, or the browser rotated it). Both mean the row is dead and
 * should be deleted — and nothing else does. A 429, a 500 or a timeout is the
 * push service having a bad minute, and deleting a live device's subscription
 * because of one would silently stop every future reminder to it.
 */
export const isGone = (error) => error?.statusCode === 404 || error?.statusCode === 410;

/**
 * Sends one notification to one subscription.
 *
 * The payload is the reminder as the service worker will render it — title,
 * body, tag and href, and nothing else. No history, no ids beyond the tag, and
 * nothing the server would not be willing to see on a lock screen.
 *
 * TTL is one hour on purpose: a reminder is about a moment, and a push service
 * that could not reach the device for an hour should drop it rather than
 * deliver this morning's reminder tonight. That is also requirement 8 held at
 * the protocol level — there is no backlog to arrive, because the backlog
 * expires.
 */
export function sendPush(subscription, payload) {
  configure();
  return webpush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    JSON.stringify(payload),
    { TTL: 3600 },
  );
}
