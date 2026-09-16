import { existsSync } from "node:fs";
import { join } from "node:path";

import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";

import { config } from "./config/index.js";
import { CLOUDINARY_ORIGIN } from "./lib/cloudinary/url.js";
import { errorHandler } from "./middleware/error-handler.js";
import { assertAuthConfig } from "./modules/auth/auth.service.js";
import { createApiRouter } from "./routes/index.js";

/**
 * Assembles the Express application. Kept separate from server.js so tests can
 * build an app without binding a port.
 */
export function createApp() {
  // Fail at startup, not at the first login attempt.
  assertAuthConfig();

  const app = express();

  // Behind a platform proxy (Render/Fly) so req.protocol and rate limiting see
  // the real client rather than the load balancer.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  /*
   * Helmet's defaults, with one addition: screenshots are served from
   * Cloudinary, so the default `img-src 'self' data:` would block every one of
   * them. Nothing else about the policy moves - no script, style, font or
   * connect source is added, and `data:` stays for the editor's pre-save
   * preview, which cannot be a blob: URL for exactly this reason.
   */
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { "img-src": ["'self'", "data:", CLOUDINARY_ORIGIN] },
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.use("/api", createApiRouter());

  mountSpa(app);

  app.use(errorHandler);

  return app;
}

/**
 * One origin: Express serves the built SPA alongside /api, which is what lets the
 * session cookie stay SameSite=Lax with no CORS. Inert until the frontend exists.
 */
function mountSpa(app) {
  const indexHtml = join(config.webDistPath, "index.html");

  if (!existsSync(indexHtml)) {
    app.get("/", (_req, res) => {
      res
        .type("text/plain")
        .send("Habit Tracker API. No frontend build present yet - try /api/health.");
    });
    return;
  }

  app.use(express.static(config.webDistPath, { index: false, maxAge: "1h" }));
  // Client-side routing: any non-API path returns the shell.
  app.get(/.*/, (_req, res) => res.sendFile(indexHtml));
}
