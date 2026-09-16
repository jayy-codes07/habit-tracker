/**
 * The Cloudinary SDK, configured once from the boot-time config snapshot.
 *
 * Every call this app makes is signed and server-side: the api_secret lives
 * here and nowhere else, and the browser never talks to Cloudinary except to
 * GET an image URL. There is no unsigned upload preset, because there is no
 * reason for one — the upload already passes through an authenticated Express
 * route that checks the bytes, and an unsigned preset would be a second way in
 * that skips both.
 *
 * Unconfigured is a legitimate state: db:migrate, db:seed and every part of the
 * app that is not a screenshot must still run without credentials. So this
 * module never throws at import; the two calls that need the service ask
 * assertConfigured() first.
 */
import { v2 as cloudinary } from "cloudinary";

import { config } from "../../config/index.js";
import { AppError } from "../errors.js";

const { cloudName, apiKey, apiSecret } = config.cloudinary;

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
  secure: true, // https URLs, always; an http image on an https page is blocked
});

export const configured = Boolean(cloudName && apiKey && apiSecret);

export function assertConfigured() {
  if (!configured) {
    throw new AppError(503, "Screenshot storage is not configured on this server.");
  }
}

export { cloudinary };
