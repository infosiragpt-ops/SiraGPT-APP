'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../object-storage');
const uploadRoot = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.resolve(__dirname, '../../../uploads');

// Only job-owned staged copies, never the user's original composer File.
// Ambiguous dispatches retain input/checkpoints for manual reconciliation.
async function cleanupMediaInputs(job) {
  const input = job.payload?.executionInput;
  for (const ref of [input?.sourceRef, input?.sourcePath].filter(Boolean)) await storage.remove(ref);
  for (const item of job.checkpoint?.imageResults || []) await storage.remove(item.ref);
  if (/^[a-z0-9_-]+$/i.test(job.id)) {
    const dir = path.join(uploadRoot, 'private', 'media-results', job.id);
    for (let i = 0; i < (job.checkpoint?.imageResults?.length || 0); i++) await fs.unlink(path.join(dir, `${i}.bin`)).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  }
}
module.exports = { cleanupMediaInputs };
