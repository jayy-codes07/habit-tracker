import { query, pool } from "./src/db/index.js";
import { cloudinary } from "./src/lib/cloudinary/config.js";
import * as svc from "./src/modules/leetcode/leetcode.service.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const gone = async (id) =>
  cloudinary.api
    .resource(id)
    .then(() => false)
    .catch((e) => e.error?.http_code === 404);

const p = await svc.createProblem({ title: "TMP cloudinary check", difficulty: "easy" });
const first = await svc.setScreenshot(p.id, PNG, "image/png");
const second = await svc.setScreenshot(p.id, PNG, "image/png");
console.log("replace: new id differs:", first.screenshot_public_id !== second.screenshot_public_id);
console.log("replace: old asset destroyed:", await gone(first.screenshot_public_id));
console.log("display url:", second.screenshot_url);

await svc.clearScreenshot(p.id);
console.log("delete: asset destroyed:", await gone(second.screenshot_public_id));
console.log("delete: row cleared:", (await svc.loadProblem(p.id)).screenshot_url === null);

await query("DELETE FROM leetcode_problems WHERE id = $1", [p.id]);
await pool.end();
