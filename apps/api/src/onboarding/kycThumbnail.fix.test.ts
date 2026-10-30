/**
 * H5 (docs/bugs/hunt-2.md): a small upload that decodes to a huge image
 * (decompression bomb), or bytes that only look like an image, must be a
 * 422 — never a 500, and never a multi-GB decode.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { AppError } from "../lib/errors.js";
import { detectFileType } from "./fileSignature.js";
import { generateKycThumbnail } from "./kycThumbnail.js";

const is422 = (err: unknown) => err instanceof AppError && err.statusCode === 422 && err.code === "invalid_image";

test("H5: a PNG over the pixel limit (small file, 48 MP) is rejected 422 before it is decoded", async () => {
  const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  assert.ok(bomb.length < 1024 * 1024, `fixture must be small on disk, got ${bomb.length} bytes`);
  assert.equal(detectFileType(bomb), "png");
  await assert.rejects(generateKycThumbnail(bomb, "png"), is422);
});

test("H5: bytes with a JPEG signature that sharp cannot decode are rejected 422, not 500", async () => {
  const fake = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  await assert.rejects(generateKycThumbnail(fake, "jpeg"), is422);
});

test("H5: a normal photo under the limit still gets a thumbnail", async () => {
  const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
  const thumb = await generateKycThumbnail(photo, "jpeg");
  assert.ok(thumb);
});
