import sharp from "sharp";
import { UnprocessableEntityError } from "../lib/errors.js";
import type { DetectedFileType } from "./fileSignature.js";

/**
 * Longest side, in pixels.
 */
const THUMBNAIL_MAX_DIMENSION_PX = 320;

/**
 * Largest image we decode (width x height). sharp's default (~268 MP) lets an
 * upload of a few hundred KB decode to gigabytes of memory. 40 MP covers any
 * phone photo or scan of an ID or utility bill.
 */
const MAX_INPUT_PIXELS = 40_000_000;

export interface GeneratedThumbnail {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Generates a review-UI-sized thumbnail from an already-validated upload
 * buffer. Only `jpeg`/`png` documents get one — a `pdf` (commercial
 * registration, bank letter) has no image to thumbnail, and this returns
 * `null` rather than attempting a PDF-to-image conversion. Always
 * re-encodes to JPEG regardless of the source format, so the admin
 * console's `<img>` tag never needs to branch on thumbnail mime type the
 * way the original-file endpoint does.
 */
export async function generateKycThumbnail(
  buffer: Buffer,
  detectedType: DetectedFileType,
): Promise<GeneratedThumbnail | null> {
  if (detectedType !== "jpeg" && detectedType !== "png") {
    return null;
  }
  // The 8 MiB upload cap does not bound the decoded size: a tiny PNG can
  // declare a huge canvas. limitInputPixels makes sharp refuse it from the header.
  let resized: Buffer;
  try {
    resized = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(THUMBNAIL_MAX_DIMENSION_PX, THUMBNAIL_MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch {
    // Over the pixel limit, truncated or corrupt: the client sent a bad image.
    throw new UnprocessableEntityError(
      "invalid_image",
      `image could not be read or is larger than ${MAX_INPUT_PIXELS} pixels`,
    );
  }
  return { buffer: resized, mimeType: "image/jpeg" };
}
