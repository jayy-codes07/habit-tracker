import { config } from "../../config/index.js";
import {
  clearSessionCookie,
  issueToken,
  setSessionCookie,
  verifyPassword,
} from "./auth.service.js";

export async function login(req, res, next) {
  try {
    const password = req.body?.password;

    // One generic failure for a missing, malformed or simply wrong password:
    // nothing here tells an attacker which part was wrong. The plaintext is
    // never logged, echoed back, or kept beyond this scope.
    const ok =
      typeof password === "string" && (await verifyPassword(password, config.auth.passwordHash));

    if (!ok) {
      return res.status(401).json({ error: "Invalid password" });
    }

    setSessionCookie(res, issueToken());
    return res.json({ authenticated: true });
  } catch (error) {
    return next(error);
  }
}

/**
 * Safe to call repeatedly, with or without a valid session: clearing an absent
 * cookie is a no-op, and logging out should never fail.
 */
export function logout(_req, res) {
  clearSessionCookie(res);
  res.json({ authenticated: false });
}

/** Lets the SPA discover on boot whether its cookie is still good. */
export function session(req, res) {
  res.json({
    authenticated: true,
    expiresAt: new Date(req.auth.expiresAt * 1000).toISOString(),
  });
}
