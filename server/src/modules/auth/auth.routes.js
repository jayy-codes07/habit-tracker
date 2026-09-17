import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import { requireAuth } from "../../middleware/require-auth.js";
import { login, logout, session } from "./auth.controller.js";

/**
 * Built per app instance rather than at module scope so each createApp() starts
 * with a clean limiter; otherwise tests would leak attempt counts into each other.
 *
 * Brute force is the only realistic attack on a one-password app, so this is the
 * highest-value control here. Successful logins are not counted, so a correct
 * password after a few typos still works.
 *
 * A ONE-MINUTE window, not fifteen. Five attempts a minute is still three
 * orders of magnitude short of guessing anything, and the cost of the long
 * window fell entirely on the one person who owns the password and mistyped it:
 * a quarter of an hour locked out of your own habits is a punishment, a minute
 * is a pause.
 */
function loginRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => {
      const retryAfter = Math.max(1, Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000));
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "Too many login attempts",
        retryAfterSeconds: retryAfter,
      });
    },
  });
}

export function createAuthRouter() {
  const router = Router();

  router.post("/login", loginRateLimiter(), login);
  router.post("/logout", logout);
  // Guards itself, because it sits above the router-wide auth boundary.
  router.get("/session", requireAuth, session);

  return router;
}
