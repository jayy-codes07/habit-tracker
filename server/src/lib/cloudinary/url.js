/**
 * Where an asset is displayed from.
 *
 * Nothing stores a URL: a public_id plus a transformation is the whole address,
 * so a stored one could only go stale. Both of these are derived on every read
 * and travel on the problem row.
 *
 * The displayed image is a transformation rather than a second file we generate
 * and keep — the resize happens at the CDN, is cached there, and costs this
 * server nothing.
 */
import { cloudinary } from "./config.js";

/**
 * f_auto hands a phone WebP or AVIF and everything else the original format;
 * q_auto picks a quality per image; c_limit only ever shrinks, so a screenshot
 * narrower than 1600 is served untouched rather than upscaled into mush.
 */
const DISPLAY = { fetch_format: "auto", quality: "auto", crop: "limit", width: 1600 };

export const displayUrl = (publicId) => cloudinary.url(publicId, { secure: true, ...DISPLAY });

/** Untransformed, for the "opens full size" link. The browser does the zooming. */
export const originalUrl = (publicId) => cloudinary.url(publicId, { secure: true });

/** The origin every derived URL is served from, for the CSP img-src allowlist. */
export const CLOUDINARY_ORIGIN = "https://res.cloudinary.com";
