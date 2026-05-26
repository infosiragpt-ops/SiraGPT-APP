'use strict';

/**
 * R2 Artifact Bridge — integrates Cloudflare R2 into the existing file/artifact
 * pipeline without modifying the upload routes directly.
 *
 * When R2 is configured, artifacts >= 1MB are uploaded to R2 and a presigned
 * URL is generated for download. Smaller files stay on local disk.
 *
 * Usage in any route:
 *   const r2Bridge = req.app.locals.orchestration?.r2Bridge;
 *   if (r2Bridge?.enabled && size > threshold) {
 *     const { key, url } = await r2Bridge.upload({ buffer, fileName, userId, mimeType });
 *   }
 */

const R2_MIN_SIZE_BYTES = Number.parseInt(process.env.SIRAGPT_R2_MIN_SIZE_BYTES || '1048576', 10); // 1MB default
const R2_ENABLED = process.env.SIRAGPT_R2_ENABLED !== 'false' && process.env.SIRAGPT_R2_ENABLED !== '0';

function createR2ArtifactBridge(r2Storage) {
  if (!r2Storage || !r2Storage.enabled || !R2_ENABLED) {
    return { enabled: false };
  }

  return {
    enabled: true,
    minSizeBytes: R2_MIN_SIZE_BYTES,

    shouldOffload(size) {
      return size >= R2_MIN_SIZE_BYTES;
    },

    async upload({ buffer, fileName, userId, mimeType, metadata = {} }) {
      const key = r2Storage.constructor?.safeKey
        ? require('./r2-storage').safeKey({ userId, fileName, prefix: 'artifacts' })
        : `artifacts/${String(userId).slice(0, 36)}/${Date.now()}-${fileName}`;

      await r2Storage.put({
        key,
        body: buffer,
        contentType: mimeType || 'application/octet-stream',
        metadata: { ...metadata, uploadedAt: String(Date.now()) },
      });

      const url = await r2Storage.signedGetUrl(key);
      return { key, url, bucket: 'r2', storage: 'r2' };
    },

    async getSignedUrl(key, ttl) {
      return r2Storage.signedGetUrl(key, ttl);
    },

    async delete(key) {
      return r2Storage.delete(key);
    },

    async signedUploadUrl({ fileName, userId, contentType }) {
      const key = `artifacts/${String(userId).slice(0, 36)}/${Date.now()}-${fileName}`;
      return {
        key,
        url: await r2Storage.signedPutUrl({ key, contentType }),
      };
    },
  };
}

module.exports = { createR2ArtifactBridge };
