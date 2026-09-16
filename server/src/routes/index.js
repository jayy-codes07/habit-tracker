import { Router } from "express";

import { notFoundHandler } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import { createAuthRouter } from "../modules/auth/auth.routes.js";
import { createExportRouter } from "../modules/export/export.routes.js";
import { createHabitsRouter } from "../modules/habits/habits.routes.js";
import { createHealthRouter } from "../modules/health/health.routes.js";
import { createJournalRouter } from "../modules/journal/journal.routes.js";
import { createLeetcodeRouter } from "../modules/leetcode/leetcode.routes.js";
import { createOverviewRouter } from "../modules/overview/overview.routes.js";
import { createSearchRouter } from "../modules/search/search.routes.js";
import { createTasksRouter } from "../modules/tasks/tasks.routes.js";

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

  router.use("/habits", createHabitsRouter());
  router.use("/tasks", createTasksRouter());
  router.use("/journal", createJournalRouter());
  router.use("/leetcode", createLeetcodeRouter());
  router.use("/search", createSearchRouter());

  // Whole-screen reads and the backup, each declaring its own path.
  router.use(createOverviewRouter());
  router.use(createExportRouter());

  router.use(notFoundHandler);

  return router;
}
