import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";

export interface MultipartPluginOptions {
  config: Pick<Config, "kycMaxFileSizeBytes">;
}

/**
 * Every multipart route takes exactly one file (routes/kyc.ts).
 *
 * `files` is 2, not 1, on purpose. At the limit, busboy destroys the file
 * stream the handler is still reading, so with `files: 1` a second file
 * makes the first file's read fail with "Premature close" (a 500). With 2,
 * the handler sees the second file part and answers 400 before it reads
 * any of it; a third file is cut by the plugin. So the server never buffers
 * more than one file.
 */
const MAX_FILE_PARTS = 2;

/** Registers @fastify/multipart size-limited to `config.kycMaxFileSizeBytes`
 *  — oversized uploads are rejected by the plugin before any handler runs,
 *  never buffered in full. */
export const multipartPlugin = fp<MultipartPluginOptions>(async (app: FastifyInstance, opts): Promise<void> => {
  await app.register(multipart, {
    limits: { fileSize: opts.config.kycMaxFileSizeBytes, files: MAX_FILE_PARTS },
  });
});
