'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../object-storage');
const { LIMITS } = require('./transfer');
const uploadRoot = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.resolve(__dirname, '../../../uploads');

async function stageImageResults(jobId, images, signal) {
  const dir = path.join(uploadRoot, 'private', 'media-results', jobId);
  await fs.mkdir(dir, { recursive: true });
  const result = [];
  for (let i = 0; i < images.length; i++) {
    signal.throwIfAborted();
    const item = images[i];
    const b64 = typeof item === 'string' ? item : item.b64;
    if (!b64 || b64.length > Math.ceil(LIMITS.image / 3) * 4) throw Object.assign(new Error('La imagen supera el tamaño permitido.'), { code: 'MEDIA_TOO_LARGE' });
    const localPath = path.join(dir, `${i}.bin`);
    await fs.writeFile(localPath, Buffer.from(b64, 'base64'), { signal });
    const ref = storage.enabled()
      ? (await storage.persistLocalFileStream({ localPath, key: `uploads/private/media-results/${jobId}/${i}.bin`, contentType: 'application/octet-stream', signal })).ref
      : localPath;
    const { b64: _b64, ...metadata } = typeof item === 'string' ? {} : item;
    result.push({ ...metadata, ref });
  }
  return result;
}
async function restoreImageResults(items, signal) {
  const result = [];
  for (const item of items) {
    signal.throwIfAborted();
    const temp = await storage.toLocalTemp(item.ref);
    try {
      if ((await fs.stat(temp.path)).size > LIMITS.image) throw Object.assign(new Error('La imagen supera el tamaño permitido.'), { code: 'MEDIA_TOO_LARGE' });
      result.push({ ...item, b64: (await fs.readFile(temp.path, { signal })).toString('base64') });
    } finally { await temp.cleanup(); }
  }
  return result;
}
module.exports = { stageImageResults, restoreImageResults };
