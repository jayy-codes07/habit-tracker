import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No build.outDir: Vite's default `dist` resolves to web/dist, which is exactly
// what server/Dockerfile's web-build stage and WEB_DIST_PATH expect.
//
// The dev proxy is what keeps the session cookie working off the container. The
// API sets it from :3000 with no Domain, so it scopes to host `localhost` and
// cookies ignore the port; the proxy then makes everything same-origin to the
// browser, which is what SameSite=Lax needs.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
