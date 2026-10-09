'use strict';

const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const LIMITS = Object.freeze({ image: 32 * 1024 * 1024, video: 512 * 1024 * 1024, audio: 2 * 1024 * 1024 * 1024 });
class ByteLimit extends Transform {
  constructor(maxBytes) {
    super();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('A finite media byte limit is required');
    this.maxBytes = maxBytes; this.bytes = 0;
  }
  _transform(chunk, encoding, callback) {
    this.bytes += Buffer.byteLength(chunk);
    callback(this.bytes > this.maxBytes ? Object.assign(new Error('El archivo generado supera el tamaño permitido.'), { code: 'MEDIA_TOO_LARGE', publicMessage: 'El archivo generado supera el tamaño permitido.' }) : null, chunk);
  }
}
function nodeBody(body) { return body?.getReader ? Readable.fromWeb(body) : body; }
async function downloadToFile(response, destination, { maxBytes, signal } = {}) {
  if (!response?.ok || !response.body) { await response?.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('No se pudo descargar el archivo generado.'), { code: 'E_PROVIDER' }); }
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    const body = nodeBody(response.body); body?.destroy?.(); await response.body.cancel?.().catch(() => {});
    throw Object.assign(new Error('El archivo generado supera el tamaño permitido.'), { code: 'MEDIA_TOO_LARGE' });
  }
  const limit = new ByteLimit(maxBytes);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await pipeline(nodeBody(response.body), limit, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
    return { sizeBytes: limit.bytes, contentType: response.headers?.get?.('content-type') };
  } catch (error) { await fsp.unlink(destination).catch(() => {}); throw error; }
}
async function downloadAndStore(url, { key, localPath, kind = 'video', signal, storage, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(kind === 'video' ? 120000 : 30000);
  const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const temporary = storage.enabled() ? path.join(os.tmpdir(), `sira-media-${randomUUID()}`) : `${localPath}.${randomUUID()}.partial`;
  try {
    const response = await fetchImpl(url, { signal: lifetime });
    const meta = await downloadToFile(response, temporary, { maxBytes: LIMITS[kind], signal: lifetime });
    if (storage.enabled()) {
      await storage.persistLocalFileStream({ localPath: temporary, key, contentType: meta.contentType || (kind === 'video' ? 'video/mp4' : 'image/png'), signal: lifetime });
    } else {
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      await fsp.rename(temporary, localPath);
    }
    return meta;
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}
async function readLimitedResponse(response, { maxBytes = LIMITS.image, signal } = {}) {
  if (!response?.ok || !response.body) throw Object.assign(new Error('No se pudo descargar la imagen.'), { code: 'E_PROVIDER' });
  const chunks = [], limit = new ByteLimit(maxBytes);
  const sink = new (require('node:stream').Writable)({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
  await pipeline(nodeBody(response.body), limit, sink, { signal });
  return Buffer.concat(chunks, limit.bytes);
}
module.exports = { ByteLimit, LIMITS, downloadToFile, downloadAndStore, readLimitedResponse };
