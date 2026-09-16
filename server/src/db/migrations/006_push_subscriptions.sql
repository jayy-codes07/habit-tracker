-- 006_push_subscriptions.sql — where a push actually goes.
--
-- 005 could only deliver a reminder while the app was open, because the page
-- was the thing asking. This is the other half: a browser's push subscription,
-- so the server can send to it with nothing of ours running on the device.
--
-- A subscription is three strings the browser hands over — an endpoint URL at
-- its own push service, and two keys the payload is encrypted with. That is
-- everything, and none of it is ours to interpret: the server signs with VAPID,
-- encrypts to `p256dh`/`auth`, and POSTs to `endpoint`.
--
-- One row per device, keyed by the endpoint, which is what the browser gives
-- back on every re-subscribe. A phone that reinstalls or rotates gets a new
-- endpoint and therefore a new row; the dead one is removed when the push
-- service answers 404 or 410, not on a guess.
--
-- These are secrets in the sense that anyone holding them can send this device
-- a notification, so they live here and nowhere else — never in an export,
-- never in a payload, never in the browser beyond the browser's own copy.
CREATE TABLE push_subscriptions (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    endpoint   text        NOT NULL,
    -- The subscription's public key and auth secret, base64url as the browser
    -- produced them. Stored verbatim: web-push is the only thing that reads
    -- them, and re-encoding a key is a way to corrupt one.
    p256dh     text        NOT NULL,
    auth       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- The browser's own identifier for this subscription, so re-subscribing the
    -- same device updates its keys rather than accumulating a row per visit.
    CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint),

    CONSTRAINT push_subscriptions_endpoint_absolute
        CHECK (endpoint LIKE 'https://%'),

    CONSTRAINT push_subscriptions_keys_present
        CHECK (length(p256dh) > 0 AND length(auth) > 0)
);

COMMENT ON TABLE push_subscriptions IS
    'One row per subscribed device. Deleted when its push service reports the subscription gone (404/410).';
