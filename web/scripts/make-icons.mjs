/**
 * Renders the app icon to PNG, at the sizes an installed app needs.
 *
 *   npm run icons
 *
 * The design is public/icon.svg redrawn as pixels: the product's own "done"
 * mark, the same rounded square and check the habit rows use. It exists as code
 * rather than as four opaque binaries so the brand colour is changed in one
 * place and the assets regenerated, instead of being unreproducible for ever.
 *
 * PNG is not a choice. iOS ignores SVG for apple-touch-icon, and that is exactly
 * the phone this app is built for. Rather than add an image dependency for a
 * job that runs about once a year, the encoder below is the ~40 lines of
 * node:zlib that writing a PNG actually takes.
 *
 * Shapes are drawn as signed distance fields, which is the cheapest way to get
 * the round caps and joins the mark has — and one subtraction gives a clean
 * antialiased edge with no supersampling.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// index.css --c-chart-2 and --c-canvas. Keep these in step with the stylesheet.
const MARK = [0x5f, 0xbf, 0xa8];
const INK = [0x15, 0x15, 0x1b];

// --- the drawing ------------------------------------------------------------

/** Distance from p to the segment a-b, negative inside the stroke's half width. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from p to a rounded rectangle centred on the unit square. */
function roundedBoxDistance(px, py, half, radius) {
  const qx = Math.abs(px - 0.5) - (half - radius);
  const qy = Math.abs(py - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * The check, in the same unit coordinates as icon.svg's 32-unit viewBox, scaled
 * about the centre so the maskable variant can pull it inside the safe zone.
 */
const CHECK = [9 / 32, 16.8 / 32, 13.6 / 32, 21.4 / 32, 23 / 32, 11 / 32];
const STROKE = 2 / 32; // half of the SVG's stroke-width 4

/** Coverage from a distance, antialiased across one pixel. */
const cover = (distance, pixel) => Math.max(0, Math.min(1, 0.5 - distance / pixel));

const mix = (under, over, alpha) => Math.round(under + (over - under) * alpha);

/**
 * `radius` is the corner rounding as a fraction of the icon; 0 is full bleed,
 * which is what iOS and Android maskable want because they apply their own mask.
 * `scale` shrinks the mark about the centre for the maskable safe zone.
 */
function render(size, { radius, scale }) {
  const pixel = 1 / size;
  const rgba = Buffer.alloc(size * size * 4);
  const at = (index) => (index + 0.5) / size;

  const [ax, ay, bx, by, cx, cy] = CHECK.map((value) => 0.5 + (value - 0.5) * scale);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = at(x);
      const py = at(y);

      const background = cover(roundedBoxDistance(px, py, 0.5, radius), pixel);
      const check = cover(
        Math.min(segmentDistance(px, py, ax, ay, bx, by), segmentDistance(px, py, bx, by, cx, cy)) -
          STROKE * scale,
        pixel,
      );

      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        rgba[offset + channel] = mix(MARK[channel], INK[channel], check);
      }
      rgba[offset + 3] = Math.round(background * 255);
    }
  }

  return rgba;
}

// --- the encoder ------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10-12: deflate, adaptive filtering, no interlace — all zero.

  // One filter byte per scanline. Filter 0 (none): the images are tiny and the
  // point here is a correct file, not a small one.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- what gets written ------------------------------------------------------

const ICONS = [
  // Rounded like the favicon: these are shown as-is.
  { file: "icon-192.png", size: 192, radius: 0.25, scale: 1 },
  { file: "icon-512.png", size: 512, radius: 0.25, scale: 1 },
  // Full bleed, mark pulled into the central safe zone: Android crops this to
  // whatever shape the launcher uses, and anything near a corner is lost. The
  // safe zone is a circle of radius 0.4; 0.9 puts the mark's furthest corner at
  // 0.32, which is inside it with room to spare and still fills the icon.
  { file: "icon-maskable-512.png", size: 512, radius: 0, scale: 0.9 },
  // iOS applies its own rounding and dislikes transparency, so full bleed too.
  { file: "apple-touch-icon.png", size: 180, radius: 0, scale: 1 },
];

mkdirSync(OUT, { recursive: true });

for (const { file, size, radius, scale } of ICONS) {
  const buffer = png(size, render(size, { radius, scale }));
  writeFileSync(join(OUT, file), buffer);
  console.log(
    `${file.padEnd(24)} ${String(size).padStart(3)}px  ${String(buffer.length).padStart(6)} bytes  ` +
      `sha256:${createHash("sha256").update(buffer).digest("hex").slice(0, 12)}`,
  );
}
