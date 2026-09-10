import { Router } from "express";

import { notFoundHandler } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import { createAuthRouter } from "../modules/auth/auth.routes.js";
import { createHealthRouter } from "../modules/health/health.routes.js";

/**
 * Owns the API's mount order, which is security-relevant:
 * public routes, then the auth boundary, then everything that needs a session.
 */
export function createApiRouter() {
  const router = Router();

  // Public: a platform health check cannot hold a session.
  router.use(createHealthRouter());

  // Public: login and logout.
  router.use(createAuthRouter());

  // --- Authentication boundary. Nothing below is reachable without a cookie. ---
  router.use(requireAuth);

  // Feature routers land here in Step 4:
  //   router.use("/habits", createHabitsRouter());

  router.use(notFoundHandler);

  return router;
}
