/**
 * Putting an image in the media store.
 *
 * The caller has already decided the bytes are an image it is willing to store
 * — see sniff() in leetcode.service.js, which is the check that matters,
 * because the declared Content-Type is a claim. What is left here is the part
 * that is about Cloudinary: signing, the folder, and what comes back.
 */
import { randomUUID } from "node:crypto";

import { assertConfigured, cloudinary } from "./config.js";
import { AppError, badRequest } from "../errors.js";

/** Everything this app stores lives under one folder, so the account stays legible. */
export const FOLDER = "habit-tracker/leetcode";

/**
 * What Cloudinary is allowed to have decided it stored.
 *
 * The bytes were sniffed before they got here, so a mismatch is not expected —
 * this is the line that holds if Cloudinary ever normalises something into a
 * format the column's CHECK refuses, which would otherwise be a 500 after the
 * upload had already happened.
 */
const ALLOWED_FORMATS = ["png", "jpg", "webp"];

/**
 * @returns {Promise<{public_id: string, format: string, width: number,
 *                    height: number, bytes: number}>}
 */
export async function uploadImage(buffer, mimeType) {
  assertConfigured();

  // A data: URI rather than upload_stream: the route caps a screenshot at 5MB
  // and express.raw has already buffered the whole thing, so there is no stream
  // left to save — only a callback API to wrap.
  const uri = `data:${mimeType};base64,${buffer.toString("base64")}`;

  let result;
  try {
    result = await cloudinary.uploader.upload(uri, {
      folder: FOLDER,
      // A fresh id per upload, never one derived from the problem. Replacing a
      // screenshot therefore changes its URL, which is what makes a replacement
      // appear immediately with no cache-busting parameter and no invalidation
      // request — and the old asset is deleted by the caller once the row
      // points at the new one.
      public_id: randomUUID(),
      resource_type: "image",
      overwrite: false,
    });
  } catch (error) {
    // The upstream message can carry account details; it is logged, not sent.
    console.error("[cloudinary] upload failed:", error?.message ?? error);
    throw new AppError(502, "That screenshot could not be stored. Try again.");
  }

  if (!ALLOWED_FORMATS.includes(result.format)) {
    await cloudinary.uploader.destroy(result.public_id).catch(() => {});
    throw badRequest("A screenshot must be a PNG, JPEG or WebP image");
  }

  const { public_id, format, width, height, bytes } = result;
  return { public_id, format, width, height, bytes };
}
