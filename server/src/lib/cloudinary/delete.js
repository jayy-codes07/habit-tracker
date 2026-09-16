/**
 * Taking an image back out of the media store.
 *
 * This throws rather than reporting, and that is the point: the caller clears
 * the database row only after this resolves, so the app can never claim to have
 * deleted something that is still sitting in the account.
 */
import { assertConfigured, cloudinary } from "./config.js";
import { AppError } from "../errors.js";

export async function destroyImage(publicId) {
  assertConfigured();

  let result;
  try {
    result = await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
      invalidate: true, // purge the CDN copy too, or the URL keeps answering
    });
  } catch (error) {
    console.error("[cloudinary] destroy failed:", publicId, error?.message ?? error);
    throw new AppError(502, "That screenshot could not be deleted. Try again.");
  }

  // "not found" is the outcome that was asked for — the asset is gone — so it
  // is a success. Anything else ("rate limited", "not allowed") is a refusal
  // dressed as a 200, and must not become a cleared row.
  if (result.result !== "ok" && result.result !== "not found") {
    console.error("[cloudinary] destroy refused:", publicId, result.result);
    throw new AppError(502, "That screenshot could not be deleted. Try again.");
  }
}
