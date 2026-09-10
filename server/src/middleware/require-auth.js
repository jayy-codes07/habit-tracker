import { SESSION_COOKIE, verifyToken } from "../modules/auth/auth.service.js";

/**
 * The authentication boundary. Everything mounted after this in the API router
 * requires a valid session cookie.
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const payload = verifyToken(token);
    req.auth = { subject: payload.sub, expiresAt: payload.exp };
    return next();
  } catch (error) {
    // Malformed, tampered, wrong-secret and expired all land here. They are
    // client problems, never 500s. The reason is reported without echoing the
    // token itself.
    const expired = error?.name === "TokenExpiredError";
    return res.status(401).json({ error: expired ? "Session expired" : "Invalid session" });
  }
}
