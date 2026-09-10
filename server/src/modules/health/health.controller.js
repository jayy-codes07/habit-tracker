import { checkConnection } from "../../db/index.js";

/**
 * Liveness and readiness in one. Returns 503 when the database is unreachable so
 * a platform health check fails loudly instead of reporting a half-dead API.
 */
export async function health(_req, res) {
  const base = {
    status: "ok",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  try {
    const version = await checkConnection();
    res.json({
      ...base,
      database: { connected: true, version: version.split(" ").slice(0, 2).join(" ") },
    });
  } catch (error) {
    res.status(503).json({
      ...base,
      status: "degraded",
      database: { connected: false, error: error.message },
    });
  }
}
